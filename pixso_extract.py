#!/usr/bin/env python3
"""
pixso_extract.py — достаёт макет Pixso из .har и превращает его в компактное
описание для LLM (ГигаКод / Claude Code), когда Pixso MCP не работает.

Как снять HAR:
  1. Открыть фрейм в браузере (ссылка вида .../app/design/<file>?item-id=185:274028).
  2. DevTools → Network → включить "Preserve log", обновить страницу (Ctrl+R),
     дождаться полной загрузки макета.
  3. ПКМ по списку запросов → "Save all as HAR with content".

Запуск:
  pip install zstandard          # единственная зависимость
  python3 pixso_extract.py file.har                  # фрейм из item-id в ссылке
  python3 pixso_extract.py file.har --node 185:274028
  python3 pixso_extract.py file.har --list           # список страниц и фреймов
  python3 pixso_extract.py file.har --out out_dir

Результат (в out/):
  <node>.md    — дерево слоёв в CSS-подобной нотации: отдать в ГигаКод.
  <node>.json  — то же самое структурированно.
  images/      — картинки из HAR (если браузер их загрузил).
"""
import argparse, base64, collections, json, os, re, struct, sys
from urllib.parse import urlparse, parse_qs

sys.setrecursionlimit(100000)

# ---------------------------------------------------------------- kiwi decoder
class R:
    __slots__ = ("b", "p")
    def __init__(s, b): s.b = b; s.p = 0
    def byte(s): v = s.b[s.p]; s.p += 1; return v
    def vu(s):
        r = sh = 0
        while True:
            c = s.b[s.p]; s.p += 1; r |= (c & 127) << sh; sh += 7
            if not c & 128 or sh >= 35: return r & 0xFFFFFFFF
    def vi(s): v = s.vu(); return (v >> 1) ^ -(v & 1)
    def vu64(s):
        r = sh = 0
        while True:
            c = s.b[s.p]; s.p += 1
            if sh == 56: return r | (c << sh)
            r |= (c & 127) << sh; sh += 7
            if not c & 128: return r
    def vi64(s): v = s.vu64(); return (v >> 1) ^ -(v & 1)
    def flt(s):
        f = s.b[s.p]
        if f == 0: s.p += 1; return 0.0
        bits = int.from_bytes(s.b[s.p:s.p + 4], "little"); s.p += 4
        bits = ((bits << 23) | (bits >> 9)) & 0xFFFFFFFF
        return struct.unpack("<f", struct.pack("<I", bits))[0]
    def str(s):
        e = s.b.index(b"\0", s.p); v = s.b[s.p:e].decode("utf-8", "replace"); s.p = e + 1; return v

NAT = {-1: "bool", -2: "byte", -3: "int", -4: "uint", -5: "float", -6: "string", -7: "int64", -8: "uint64"}

def parse_schema(b):
    r = R(b); n = r.vu(); defs = []
    for _ in range(n):
        name = r.str(); kind = r.byte(); fields = []
        for _ in range(r.vu()):
            fn = r.str(); t = r.vi(); arr = r.byte() != 0; val = r.vu()
            fields.append([fn, t, arr, val])
        defs.append((name, kind, fields))
    # Pixso: первый def — служебный schemaInfo, индексы типов сдвинуты на 1
    off = 1 if defs and defs[0][0] == "schemaInfo" else 0
    S = {}
    for name, kind, fields in defs:
        for f in fields:
            f[1] = NAT.get(f[1]) or defs[f[1] + off][0]
        S[name] = (kind, fields, {f[3]: f for f in fields})
    return S

class Decoder:
    def __init__(s, S): s.S = S
    def val(s, r, t):
        if t == "bool": return r.byte() != 0
        if t == "byte": return r.byte()
        if t == "int": return r.vi()
        if t == "uint": return r.vu()
        if t == "float": return r.flt()
        if t == "string": return r.str()
        if t == "int64": return r.vi64()
        if t == "uint64": return r.vu64()
        return s.decode(r, t)
    def field(s, r, f):
        if f[2]:
            n = r.vu()
            if f[1] == "byte": v = r.b[r.p:r.p + n]; r.p += n; return v
            return [s.val(r, f[1]) for _ in range(n)]
        return s.val(r, f[1])
    def decode(s, r, tn):
        kind, fields, byval = s.S[tn]
        if kind == 0:
            v = r.vu(); f = byval.get(v); return f[0] if f else v
        if kind == 1:
            return {f[0]: s.field(r, f) for f in fields}
        o = {}
        while True:
            k = r.vu()
            if k == 0: return o
            f = byval.get(k)
            if f is None: raise ValueError(f"{tn}: unknown field {k} at {r.p}")
            o[f[0]] = s.field(r, f)

def zstd_decompress(b):
    try:
        import zstandard
        return zstandard.ZstdDecompressor().decompressobj().decompress(b)
    except ImportError:
        import subprocess
        try:
            return subprocess.run(["zstd", "-dc"], input=b, capture_output=True, check=True).stdout
        except FileNotFoundError:
            sys.exit("Нужен zstd: `pip install zstandard` (или утилита zstd в PATH)")

# ---------------------------------------------------------------- HAR loading
def load_har(path):
    h = json.load(open(path, encoding="utf-8"))
    schema = doc = page_url = None; images = {}
    for e in h["log"]["entries"]:
        url = e["request"]["url"]; c = e["response"].get("content", {})
        body = None
        if c.get("text") is not None:
            body = base64.b64decode(c["text"]) if c.get("encoding") == "base64" else c["text"].encode("utf-8", "surrogatepass")
        if "/app/design/" in url and page_url is None: page_url = url
        if urlparse(url).path.endswith("/pixso.binary") and body: schema = body
        m = re.search(r"/image-url/([0-9a-f]{40})", url)
        if m and body and c.get("mimeType", "").startswith("image/"): images[m.group(1)] = (body, c["mimeType"])
        for msg in e.get("_webSocketMessages") or []:
            if msg.get("type") != "receive" or msg.get("opcode") != 2: continue
            d = base64.b64decode(msg["data"])
            if d.startswith(b"pixso-kw") and (doc is None or len(d) > len(doc)): doc = d
    if not schema: sys.exit("В HAR нет /app/pixso.binary (схема). Сохраните HAR «with content» после жёсткой перезагрузки (Ctrl+Shift+R).")
    if not doc: sys.exit("В HAR нет документа (WebSocket /ws/coop). Включите Preserve log и перезагрузите страницу до записи HAR.")
    return schema, doc, page_url, images

def decode_doc(schema, raw):
    S = parse_schema(schema)
    i = raw.find(b"\x28\xb5\x2f\xfd")  # zstd magic
    hdr = raw[:i] if i > 0 else raw[:25]
    body = zstd_decompress(raw[i:]) if i > 0 and b"ZSTD" in hdr else raw[hdr.find(b"NONE") + 4 + 12:]
    return Decoder(S).decode(R(body), "PixsoMsg")

# ---------------------------------------------------------------- scene model
def gid(x): return f"{x.get('sessionID', 0)}:{x.get('localID', 0)}" if x else "0:0"

class Scene:
    def __init__(s, msg):
        s.nodes = {}; s.kids = collections.defaultdict(list)
        for n in msg["pixsoNodes"]:
            if n.get("phase") == "REMOVED": continue
            s.nodes[gid(n.get("guid"))] = n
            if "parentIndex" in n:
                s.kids[gid(n["parentIndex"].get("guid"))].append(n)
        for k in s.kids.values():
            k.sort(key=lambda n: n["parentIndex"].get("position", "").encode())
    def children(s, i): return s.kids.get(i, [])
    def path(s, i):
        out = []; n = s.nodes.get(i)
        while n and "parentIndex" in n:
            n = s.nodes.get(gid(n["parentIndex"].get("guid")))
            if n: out.append(n)
        return out[::-1]

# ---------------------------------------------------------------- formatting
def num(v):
    if v is None or v != v: return None
    v = round(v, 2); return int(v) if v == int(v) else v

def hexcolor(c, opacity=1.0):
    r, g, b, a = (round(c.get(k, 0)) for k in "rgba")
    a = a / 255 * (opacity if opacity is not None else 1)
    h = f"#{r:02X}{g:02X}{b:02X}"
    return h if a >= 0.999 else f"{h}{round(a * 255):02X}"

def paints(ps, scene):
    out = []
    for p in ps or []:
        if p.get("visible") is False: continue
        t = p.get("type")
        if t == "SOLID": out.append(hexcolor(p.get("color", {}), p.get("opacity", 1)))
        elif t and t.startswith("GRADIENT"):
            stops = ", ".join(f"{hexcolor(st['color'])} {num(st.get('position', 0) * 100)}%" for st in p.get("stops", []))
            out.append(f"{t.lower().replace('gradient_', '')}-gradient({stops})")
        elif t == "IMAGE":
            h = p.get("image", {}).get("hash")
            out.append(f"image({bytes(h).hex() if h else '?'}, {str(p.get('imageScaleMode', 'FILL')).lower()})")
        else: out.append(str(t).lower())
    return out

def style_name(scene, ref):
    if not ref: return None
    n = scene.nodes.get(gid(ref)); return n.get("name") if n else None

def effects(es):
    out = []
    for e in es or []:
        if e.get("visible") is False: continue
        t = e.get("type", "")
        if "SHADOW" in t:
            o = e.get("offset", {})
            out.append(f"{'inset ' if t.startswith('INNER') else ''}{num(o.get('x', 0))} {num(o.get('y', 0))} {num(e.get('radius', 0))} {num(e.get('spread', 0)) or 0} {hexcolor(e.get('color', {}))}")
        elif "BLUR" in t: out.append(f"{t.lower()}({num(e.get('radius', 0))})")
    return out

# ---------------------------------------------------------------- instance expansion
MERGE_SKIP = {"guid", "guidPath", "parentIndex", "overrideKey"}

def merged(node, ov):
    if not ov: return node
    n = dict(node)
    for k, v in ov.items():
        if k in MERGE_SKIP: continue
        if k == "textData" and "textData" in n:
            t = dict(n["textData"]); t.update(v); n[k] = t
        else: n[k] = v
    return n

def apply_props(n, props):
    """Component properties: текст/видимость/подмена, заданные на инстансе."""
    refs = n.get("componentPropRef") or []
    if not refs or not props: return n
    n = dict(n)
    for ref in refs:
        if ref.get("isDeleted"): continue
        v = props.get(gid(ref.get("defID")))
        if not v: continue
        fld = ref.get("componentPropNodeField")
        if fld == "TEXT_DATA" and v.get("textValue"):
            td = dict(n.get("textData", {})); td["characters"] = v["textValue"].get("characters", td.get("characters", ""))
            td.pop("characterStyleIDs", None); n["textData"] = td
        elif fld == "VISIBLE" and "boolValue" in v: n["visible"] = v["boolValue"]
        elif fld == "OVERRIDDEN_SYMBOL_ID" and v.get("guidValue"): n["overriddenSymbolID"] = v["guidValue"]
    return n

def build(scene, n, ctx, prefix, depth, opts, props=None):
    """
    ctx    — overrides внешних инстансов: {guidPath(tuple) -> поля}.
    prefix — guidPath цепочки инстансов, внутри которых лежит узел (None — вне инстансов).
             Элементы — пары (guid, overrideKey): Pixso адресует overrides по guid, иногда по overrideKey.
    props  — значения component properties ближайшего инстанса {defID -> value}.
    """
    # порядок: узел мастер-компонента → component properties → прямые overrides (они главнее)
    n = apply_props(n, props)
    if prefix is not None:
        me = (gid(n.get("guid")), gid(n.get("overrideKey") or n.get("guid")))
        key = prefix + (me,)
        kg = tuple(a for a, b in key); ko = tuple(b for a, b in key)
        n = merged(n, ctx.get(kg) or ctx.get(ko))
    else:
        key = None
    if n.get("visible") is False and not opts.hidden: return None
    t = n.get("type")
    o = {"type": t, "name": n.get("name", "")}
    if prefix is None or opts.ids: o["id"] = gid(n.get("guid"))
    tr = n.get("transform"); sz = n.get("size")
    if tr: o["x"], o["y"] = num(tr.get("m02", 0)), num(tr.get("m12", 0))
    if tr and (abs(tr.get("m01", 0)) > 1e-3 or abs(tr.get("m00", 1) - 1) > 1e-3):
        import math; o["rotate"] = num(math.degrees(math.atan2(tr.get("m10", 0), tr.get("m00", 1))))
    if sz: o["w"], o["h"] = num(sz["x"]), num(sz["y"])
    if n.get("visible") is False: o["hidden"] = True
    if n.get("opacity", 1) < 0.999: o["opacity"] = num(n["opacity"])

    # авто-лейаут
    sm = n.get("stackMode")
    if sm in ("HORIZONTAL", "VERTICAL"):
        lay = {"dir": "row" if sm == "HORIZONTAL" else "column", "gap": num(n.get("stackSpacing", 0))}
        pads = [num(n.get(k, 0)) or 0 for k in ("stackPaddingTop", "stackPaddingRight", "stackPaddingBottom", "stackPaddingLeft")]
        if any(pads): lay["padding"] = pads
        if n.get("stackPrimaryAlignItems") not in (None, "MIN"): lay["justify"] = n["stackPrimaryAlignItems"].lower()
        if n.get("stackCounterAlignItems") not in (None, "MIN"): lay["align"] = n["stackCounterAlignItems"].lower()
        if n.get("stackWrap") == "WRAP": lay["wrap"] = True
        lay["sizing"] = {"main": str(n.get("stackPrimarySizing", "FIXED")).lower(), "cross": str(n.get("stackCounterSizing", "FIXED")).lower()}
        o["layout"] = lay
    if n.get("stackChildPrimarySizing") == "FILL" or n.get("stackChildCounterSizing") == "FILL" or n.get("autoLayoutAbsolutePos"):
        o["child"] = {k: v for k, v in {"grow": n.get("stackChildPrimarySizing") == "FILL" or None,
                                         "stretch": n.get("stackChildCounterSizing") == "FILL" or None,
                                         "absolute": n.get("autoLayoutAbsolutePos") or None}.items() if v}

    # оформление
    if t != "TEXT":
        f = paints(n.get("fillPaints"), scene)
        if f: o["fill"] = f
    s = paints(n.get("strokePaints"), scene)
    if s and n.get("strokeWeight", 0):
        o["stroke"] = {"color": s, "weight": num(n["strokeWeight"]), "align": str(n.get("strokeAlign", "INSIDE")).lower()}
        if n.get("borderStrokeWeightsIndependent"):
            o["stroke"]["sides"] = [num(n.get(k, 0)) for k in ("borderTopWeight", "borderRightWeight", "borderBottomWeight", "borderLeftWeight")]
        if n.get("dashPattern"): o["stroke"]["dash"] = [num(x) for x in n["dashPattern"]]
    if n.get("rectangleCornerRadiiIndependent"):
        rr = [num(n.get(k, 0)) for k in ("rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius", "rectangleBottomRightCornerRadius", "rectangleBottomLeftCornerRadius")]
        if any(rr): o["radius"] = rr
    elif n.get("cornerRadius"): o["radius"] = num(n["cornerRadius"])
    ef = effects(n.get("effects"))
    if ef: o["shadow"] = ef
    for k, lab in (("inheritFillStyleID", "fillStyle"), ("inheritStrokeStyleID", "strokeStyle"), ("inheritEffectStyleID", "effectStyle"), ("inheritTextStyleID", "textStyle")):
        nm = style_name(scene, n.get(k))
        if nm: o[lab] = nm
    if n.get("frameMaskDisabled") is False and t in ("FRAME", "INSTANCE", "SYMBOL"): o["clip"] = True

    if t == "TEXT":
        # недостающие свойства — из текстового стиля; fontSize по умолчанию в Pixso = 14 (не сериализуется)
        sty = scene.nodes.get(gid(n.get("inheritTextStyleID"))) if n.get("inheritTextStyleID") else None
        if sty:
            n = dict(n)
            for k in ("fontName", "fontSize", "lineHeight", "letterSpacing", "textCase", "textDecoration"):
                if k not in n and k in sty: n[k] = sty[k]
        if "fontSize" not in n: n = dict(n, fontSize=14.0)
        td = n.get("textData", {})
        o["text"] = td.get("characters", "")
        fn = n.get("fontName", {})
        st = {"font": f"{fn.get('family', '')} {fn.get('style', '')}".strip(), "size": num(n.get("fontSize"))}
        lh = n.get("lineHeight")
        if lh and lh.get("units") == "PIXELS": st["lineHeight"] = num(lh["value"])
        elif lh and lh.get("units") == "PERCENT" and lh.get("value") != 100: st["lineHeight"] = f"{num(lh['value'])}%"
        ls = n.get("letterSpacing")
        if ls and ls.get("value"): st["letterSpacing"] = f"{num(ls['value'])}{'%' if ls.get('units') == 'PERCENT' else 'px'}"
        c = paints(n.get("fillPaints"), scene)
        if c: st["color"] = c[0] if len(c) == 1 else c
        if n.get("textAlignHorizontal") not in (None, "LEFT"): st["align"] = n["textAlignHorizontal"].lower()
        if n.get("textCase") not in (None, "ORIGINAL"): st["case"] = n["textCase"].lower()
        if n.get("textDecoration") not in (None, "NONE"): st["decoration"] = n["textDecoration"].lower()
        if n.get("textAutoResize"): st["autoResize"] = n["textAutoResize"].lower()
        # смешанные стили внутри текста
        ids = td.get("characterStyleIDs") or []; table = {x.get("styleID"): x for x in td.get("styleOverrideTable") or []}
        if ids and any(ids) and table:
            runs, cur, start = [], ids[0], 0
            for i, v in enumerate(ids + [None]):
                if v != cur:
                    if cur and cur in table:
                        x = table[cur]; rs = {"text": o["text"][start:i]}
                        if x.get("fontName"): rs["font"] = f"{x['fontName'].get('family', '')} {x['fontName'].get('style', '')}"
                        if x.get("fontSize"): rs["size"] = num(x["fontSize"])
                        if x.get("fillPaints"): rs["color"] = paints(x["fillPaints"], scene)
                        if x.get("textDecoration"): rs["decoration"] = x["textDecoration"].lower()
                        runs.append(rs)
                    cur, start = v, i
            if runs: st["runs"] = runs
        o["textStyle_"] = st

    kids = []
    if t == "INSTANCE":
        sd = n.get("symbolData", {})
        sym_id = gid(n.get("overriddenSymbolID") or sd.get("symbolID"))
        sym = scene.nodes.get(sym_id)
        if sym:
            o["component"] = sym.get("name", "")
            par = scene.nodes.get(gid(sym.get("parentIndex", {}).get("guid")))
            if par and par.get("isStateGroup"): o["component"] = f"{par.get('name', '')} / {sym.get('name', '')}"
            # overrides этого инстанса + derivedSymbolData (вычисленные размеры/тексты)
            # приоритет: derivedSymbolData < overrides этого инстанса < overrides внешних инстансов
            inner = key if key is not None else ()
            ig = tuple(a for a, b in inner)
            own = {}
            derived = [{k: v for k, v in d.items() if k in ("guidPath", "size", "transform")} for d in n.get("derivedSymbolData") or []]
            for ov in derived + (sd.get("symbolOverrides") or []):
                gp = tuple(gid(g) for g in ov.get("guidPath", {}).get("guids", []))
                if gp: own[ig + gp] = merged(own.get(ig + gp, {}), ov)
            sub = dict(own)
            for k, v in ctx.items(): sub[k] = merged(sub.get(k, {}), v)
            # component properties: значения по умолчанию из определения компонента + назначения инстанса
            holder = par if par and par.get("isStateGroup") else sym
            iprops = {gid(d.get("id")): d.get("initialValue") for d in (holder.get("componentPropDef") or []) if d.get("initialValue")}
            for a in n.get("componentPropAssignment") or []:
                if a.get("value"): iprops[gid(a.get("defID"))] = a["value"]
            if depth < opts.depth:
                for c in scene.children(sym_id):
                    r = build(scene, c, sub, inner, depth + 1, opts, iprops)
                    if r: kids.append(r)
        else:
            o["component"] = f"<не найден {sym_id}>"
    else:
        for c in scene.children(gid(n.get("guid"))):
            # guidPath содержит только цепочку инстансов, обычные фреймы в него не входят
            r = build(scene, c, ctx, prefix, depth + 1, opts, props)
            if r: kids.append(r)
    if kids: o["children"] = kids
    return o

# ---------------------------------------------------------------- markdown
def md_line(o):
    bits = [f"**{o['type']}**"]
    if o.get("name"): bits.append(f"`{o['name']}`")
    if o.get("id"): bits.append(f"#{o['id']}")
    if o.get("component"): bits.append(f"⟶ компонент «{o['component']}»")
    geo = f"{o.get('w', '?')}×{o.get('h', '?')}"
    if "x" in o: geo += f" @({o['x']},{o['y']})"
    bits.append(geo)
    attrs = []
    if "layout" in o:
        L = o["layout"]; s = f"flex-{L['dir']} gap {L['gap']}"
        if "padding" in L: s += " pad " + " ".join(map(str, L["padding"]))
        if "justify" in L: s += f" justify {L['justify']}"
        if "align" in L: s += f" align {L['align']}"
        if L.get("wrap"): s += " wrap"
        s += f" (size {L['sizing']['main']}/{L['sizing']['cross']})"
        attrs.append(s)
    if "child" in o: attrs.append(" ".join(k for k in o["child"]))
    if "fill" in o: attrs.append("bg " + ", ".join(o["fill"]) + (f" [{o['fillStyle']}]" if "fillStyle" in o else ""))
    if "stroke" in o:
        s = o["stroke"]; attrs.append(f"border {s['weight']} {s['align']} {', '.join(s['color'])}" + (f" sides {s['sides']}" if 'sides' in s else "") + (" dashed" if 'dash' in s else ""))
    if "radius" in o: attrs.append(f"radius {o['radius']}")
    if "shadow" in o: attrs.append("shadow " + "; ".join(o["shadow"]) + (f" [{o['effectStyle']}]" if "effectStyle" in o else ""))
    if "opacity" in o: attrs.append(f"opacity {o['opacity']}")
    if "rotate" in o: attrs.append(f"rotate {o['rotate']}°")
    if o.get("clip"): attrs.append("overflow hidden")
    if o.get("hidden"): attrs.append("HIDDEN")
    if "textStyle_" in o:
        st = o["textStyle_"]
        s = f"{st.get('font')} {st.get('size')}" + (f"/{st['lineHeight']}" if 'lineHeight' in st else "")
        for k in ("color", "align", "letterSpacing", "case", "decoration"):
            if k in st: s += f" {k if k not in ('color',) else ''}{' ' if k != 'color' else ''}{st[k]}".replace("  ", " ")
        if "textStyle" in o: s += f" [{o['textStyle']}]"
        attrs.append(s)
    line = " ".join(bits)
    if attrs: line += " | " + " | ".join(attrs)
    if "text" in o:
        txt = o["text"].replace("\n", "⏎")
        line += f'\n{{indent}}  «{txt}»'
        for r in o["textStyle_"].get("runs", []):
            line += f"\n{{indent}}  ↳ фрагмент «{r['text']}»: " + ", ".join(f"{k} {v}" for k, v in r.items() if k != "text")
    return line

def to_md(o, depth=0, out=None):
    out = [] if out is None else out
    ind = "  " * depth
    out.append(ind + "- " + md_line(o).replace("{indent}", ind))
    for c in o.get("children", []): to_md(c, depth + 1, out)
    return out

def collect(o, acc):
    for k in ("fill",):
        for v in o.get(k, []): acc["colors"][v.split()[0] if v.startswith("#") else v] += 1
    if "stroke" in o:
        for v in o["stroke"]["color"]: acc["colors"][v] += 1
    st = o.get("textStyle_")
    if st:
        acc["fonts"][f"{st.get('font')} {st.get('size')}" + (f"/{st['lineHeight']}" if 'lineHeight' in st else "")] += 1
        if isinstance(st.get("color"), str): acc["colors"][st["color"]] += 1
    if o.get("component"): acc["components"][o["component"]] += 1
    for f in o.get("fill", []):
        m = re.match(r"image\(([0-9a-f]+)", f)
        if m: acc["images"].add(m.group(1))
    for c in o.get("children", []): collect(c, acc)
    return acc

# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("har")
    ap.add_argument("--node", help="id фрейма, напр. 185:274028 (по умолчанию item-id из ссылки в HAR)")
    ap.add_argument("--list", action="store_true", help="показать страницы и фреймы верхнего уровня")
    ap.add_argument("--out", default="out")
    ap.add_argument("--depth", type=int, default=12, help="макс. глубина раскрытия вложенных компонентов")
    ap.add_argument("--hidden", action="store_true", help="включать скрытые слои")
    ap.add_argument("--ids", action="store_true", help="писать id у каждого узла")
    opts = ap.parse_args()

    print("Читаю HAR…", file=sys.stderr)
    schema, raw, page_url, images = load_har(opts.har)
    print("Декодирую документ (может занять ~30 с)…", file=sys.stderr)
    scene = Scene(decode_doc(schema, raw))
    print(f"Узлов в файле: {len(scene.nodes)}", file=sys.stderr)

    if opts.list:
        for p in scene.children("0:0"):
            if p.get("internalOnly") or p.get("name") == "Internal Only Canvas": continue
            print(f"\n📄 {p.get('name')}  ({gid(p['guid'])})")
            for f in scene.children(gid(p["guid"])):
                sz = f.get("size", {})
                print(f"   {gid(f['guid']):>14}  {f.get('type'):<9} {f.get('name')}  {num(sz.get('x'))}×{num(sz.get('y'))}")
        return

    node = opts.node
    if not node and page_url:
        q = parse_qs(urlparse(page_url).query); node = (q.get("item-id") or q.get("node-id") or [None])[0]
    if not node: sys.exit("Укажите --node <id> (см. --list)")
    node = node.replace("-", ":")
    n = scene.nodes.get(node)
    if not n: sys.exit(f"Узел {node} не найден. Посмотрите --list")

    tree = build(scene, n, {}, None, 0, opts)
    acc = collect(tree, {"colors": collections.Counter(), "fonts": collections.Counter(), "components": collections.Counter(), "images": set()})

    os.makedirs(opts.out, exist_ok=True)
    safe = node.replace(":", "-")
    json.dump(tree, open(f"{opts.out}/{safe}.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    crumbs = " / ".join(p.get("name", "") for p in scene.path(node) if p.get("type") != "DOCUMENT")
    md = [f"# Макет: {n.get('name')} ({node})", "",
          f"Страница: {crumbs}  ", f"Источник: {page_url or '-'}", "",
          "## Как читать", "",
          "- Каждая строка — слой: `ТИП` `имя` ширина×высота @(x,y относительно родителя) | свойства.",
          "- `flex-row/column gap G pad T R B L` — auto-layout (= CSS flexbox). `size hug/fixed` — `resize_to_fit` = hug content.",
          "- `grow` — flex: 1 по главной оси, `stretch` — align-self: stretch, `absolute` — position: absolute.",
          "- Цвета #RRGGBB или #RRGGBBAA. В [квадратных скобках] — имя стиля/токена из дизайн-системы.",
          "- `⟶ компонент «…»` — инстанс компонента дизайн-системы, внутри уже раскрыт с учётом переопределений.",
          "- Текст: шрифт размер/межстрочный, цвет; строка ниже — сам текст.", "",
          "## Сводка", "",
          "**Цвета:** " + ", ".join(f"`{c}`×{k}" for c, k in acc["colors"].most_common(30)), "",
          "**Типографика:** " + ", ".join(f"`{c}`×{k}" for c, k in acc["fonts"].most_common(20)), "",
          "**Компоненты:** " + ", ".join(f"«{c}»×{k}" for c, k in acc["components"].most_common(40)), ""]
    if acc["images"]:
        md += ["**Картинки:** " + ", ".join(f"`images/{h}`" + (" ✓" if h in images else " (нет в HAR)") for h in sorted(acc["images"])), ""]
    md += ["## Дерево слоёв", ""] + to_md(tree)
    open(f"{opts.out}/{safe}.md", "w", encoding="utf-8").write("\n".join(md) + "\n")

    if acc["images"]:
        os.makedirs(f"{opts.out}/images", exist_ok=True)
        for h in acc["images"]:
            if h in images:
                body, mt = images[h]; ext = mt.split("/")[-1].replace("jpeg", "jpg")
                open(f"{opts.out}/images/{h}.{ext}", "wb").write(body)

    print(f"Готово: {opts.out}/{safe}.md ({len(md)} строк заголовка + дерево), {opts.out}/{safe}.json", file=sys.stderr)

if __name__ == "__main__":
    main()
