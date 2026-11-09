// Ядро «Раскроя»: HAR → документ Pixso (Kiwi) → дерево фрейма → описание для LLM.
// Работает в Web Worker (и в Node для тестов). Зависит от ZSTD (zstd.js).

const CORE = (() => {
  const utf8 = new TextDecoder();

  // ---------------------------------------------------------------- Kiwi
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  class R {
    constructor(b) { this.b = b; this.p = 0; }
    vu() { let r = 0, sh = 0, c; do { c = this.b[this.p++]; r |= (c & 127) << sh; sh += 7; } while (c & 128 && sh < 35); return r >>> 0; }
    vi() { const v = this.vu(); return v & 1 ? ~(v >>> 1) : v >>> 1; }
    vu64() { let r = 0, m = 1, c; do { c = this.b[this.p++]; r += (c & 127) * m; m *= 128; } while (c & 128 && m < 2 ** 63); return r; }
    vi64() { const v = this.vu64(); return v % 2 ? -(v + 1) / 2 : v / 2; }
    flt() {
      const b = this.b, p = this.p;
      if (b[p] === 0) { this.p++; return 0; }
      const bits = (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
      this.p += 4; u32[0] = ((bits << 23) | (bits >>> 9)) >>> 0; return f32[0];
    }
    str() { const e = this.b.indexOf(0, this.p); const s = utf8.decode(this.b.subarray(this.p, e)); this.p = e + 1; return s; }
  }
  const NAT = { [-1]: "bool", [-2]: "byte", [-3]: "int", [-4]: "uint", [-5]: "float", [-6]: "string", [-7]: "int64", [-8]: "uint64" };

  function parseSchema(b) {
    const r = new R(b), n = r.vu(), defs = [];
    for (let i = 0; i < n; i++) {
      const name = r.str(), kind = r.b[r.p++], fc = r.vu(), fields = [];
      for (let j = 0; j < fc; j++) { const fn = r.str(), t = r.vi(), arr = r.b[r.p++] !== 0, val = r.vu(); fields.push({ name: fn, t, arr, val }); }
      defs.push({ name, kind, fields });
    }
    const off = defs.length && defs[0].name === "schemaInfo" ? 1 : 0; // у Pixso индексы типов сдвинуты на служебный schemaInfo
    const S = {};
    for (const d of defs) {
      d.byVal = [];
      for (const f of d.fields) { f.type = NAT[f.t] || defs[f.t + off].name; d.byVal[f.val] = f; }
      S[d.name] = d;
    }
    S.__version = defs[0] && defs[0].name === "schemaInfo" ? defs[0].fields[0]?.name : "";
    S.__count = defs.length;
    return S;
  }

  function decodeMessage(S, buf, root) {
    const r = new R(buf);
    const val = (t) => {
      switch (t) {
        case "bool": return r.b[r.p++] !== 0;
        case "byte": return r.b[r.p++];
        case "int": return r.vi();
        case "uint": return r.vu();
        case "float": return r.flt();
        case "string": return r.str();
        case "int64": return r.vi64();
        case "uint64": return r.vu64();
        default: return dec(t);
      }
    };
    const field = (f) => {
      if (!f.arr) return val(f.type);
      const n = r.vu();
      if (f.type === "byte") { const v = r.b.subarray(r.p, r.p + n); r.p += n; return v; }
      const a = new Array(n); for (let i = 0; i < n; i++) a[i] = val(f.type); return a;
    };
    const dec = (tn) => {
      const d = S[tn];
      if (d.kind === 0) { const v = r.vu(); const f = d.byVal[v]; return f ? f.name : v; }
      const o = {};
      if (d.kind === 1) { for (const f of d.fields) o[f.name] = field(f); return o; }
      for (;;) {
        const k = r.vu();
        if (k === 0) return o;
        const f = d.byVal[k];
        if (!f) throw new Error(`Kiwi: неизвестное поле ${k} в ${tn}`);
        o[f.name] = field(f);
      }
    };
    return dec(root);
  }

  // ---------------------------------------------------------------- HAR
  function b64(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

  async function unzip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let e = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error("Это не zip-архив. Перетащите .har или .zip с .har внутри.");
    const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
    for (let k = 0; k < n; k++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      const name = utf8.decode(u8.subarray(p + 46, p + 46 + nl)); p += 46 + nl + xl + cl;
      if (!/\.har$/i.test(name) || /(^|\/)(__MACOSX|\._)/.test(name)) continue;
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const data = u8.subarray(start, start + csize);
      if (method === 0) return { name, data };
      if (method !== 8) throw new Error("В zip используется неподдерживаемое сжатие. Пересожмите архив обычным zip.");
      const ds = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return { name, data: new Uint8Array(await new Response(ds).arrayBuffer()) };
    }
    throw new Error("В архиве нет файла .har.");
  }

  async function loadHar(u8, progress = () => {}) {
    let fileName = null;
    if (u8[0] === 0x50 && u8[1] === 0x4b) {
      progress("zip", "распаковываю архив");
      const z = await unzip(u8); u8 = z.data; fileName = z.name;
    }
    progress("har", `${(u8.length / 1048576).toFixed(1)} МБ JSON`);
    let har;
    try { har = JSON.parse(utf8.decode(u8)); } catch (e) { throw new Error("Файл не читается как HAR (JSON). Сохраните его через DevTools → Network → «Save all as HAR with content»."); }
    const entries = har?.log?.entries;
    if (har?.format === "raskroy-pack") {
      const r = decodeDocument(b64(har.schema), b64(har.doc), progress);
      return Object.assign(r, { images: {}, pageUrl: har.url, fileName });
    }
    if (!entries) throw new Error("В файле нет log.entries — это не HAR.");
    let schema = null, doc = null, docRaw = 0, pageUrl = null;
    const images = {};
    for (const e of entries) {
      const url = e.request?.url || "", c = e.response?.content || {};
      if (!pageUrl && url.includes("/app/design/")) pageUrl = url;
      if (/\/pixso\.binary(\?|$)/.test(url) && c.text) schema = c.encoding === "base64" ? b64(c.text) : new TextEncoder().encode(c.text);
      const m = url.match(/\/image-url\/([0-9a-f]{40})/);
      if (m && c.text && (c.mimeType || "").startsWith("image/") && c.encoding === "base64") images[m[1]] = `data:${c.mimeType};base64,${c.text}`;
      for (const msg of e._webSocketMessages || []) {
        if (msg.type !== "receive" || msg.opcode !== 2 || msg.data.length < 64) continue;
        if (!msg.data.startsWith("cGl4c28ta3")) continue; // base64("pixso-kw")
        if (msg.data.length > docRaw) { docRaw = msg.data.length; doc = msg.data; }
      }
    }
    if (!schema) throw new Error("В HAR нет схемы Pixso (/app/pixso.binary). Включите Preserve log, обновите страницу с Ctrl+Shift+R и сохраните HAR «with content».");
    if (!doc) throw new Error("В HAR нет документа (WebSocket /ws/coop). Включите Preserve log, обновите страницу и дождитесь, пока макет отрисуется, затем сохраните HAR.");
    const r = decodeDocument(schema, b64(doc), progress);
    return Object.assign(r, { images, pageUrl, fileName });
  }

  // schema — байты /app/pixso.binary, raw — бинарное сообщение документа ("pixso-kw" + zstd)
  function decodeDocument(schema, raw, progress = () => {}) {
    const S = parseSchema(schema);
    progress("schema", `Kiwi ${S.__version || "?"} · ${S.__count} типов`);
    let body;
    const head = utf8.decode(raw.subarray(0, 20));
    if (head.includes("ZSTD")) {
      let i = 8; while (i < raw.length - 4 && !(raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd)) i++;
      body = ZSTD.decompress(raw.subarray(i));
    } else {
      const i = head.indexOf("NONE"); body = raw.subarray(i + 4 + 10);
    }
    progress("doc", `${(raw.length / 1048576).toFixed(1)} → ${(body.length / 1048576).toFixed(1)} МБ`);
    const msg = decodeMessage(S, body, "PixsoMsg");
    const scene = new Scene(msg);
    progress("nodes", `${scene.nodes.size.toLocaleString("ru-RU")} слоёв`);
    return { scene, meta: { schema: S.__version, created: msg.createVersion, nodes: scene.nodes.size, docMB: body.length / 1048576 } };
  }

  // ---------------------------------------------------------------- сцена
  const gid = (x) => (x ? `${x.sessionID || 0}:${x.localID || 0}` : "0:0");

  class Scene {
    constructor(msg) {
      this.nodes = new Map(); this.kids = new Map(); this.blobs = msg.blobs || [];
      for (const n of msg.pixsoNodes) {
        if (n.phase === "REMOVED") continue;
        this.nodes.set(gid(n.guid), n);
        if (n.parentIndex) {
          const p = gid(n.parentIndex.guid);
          if (!this.kids.has(p)) this.kids.set(p, []);
          this.kids.get(p).push(n);
        }
      }
      const pos = (n) => n.parentIndex.position || "";
      for (const k of this.kids.values()) k.sort((a, b) => (pos(a) < pos(b) ? -1 : pos(a) > pos(b) ? 1 : 0));
      this.pathCache = new Map();
    }
    children(id) { return this.kids.get(id) || []; }
    crumbs(id) {
      const out = []; let n = this.nodes.get(id);
      while (n && n.parentIndex) { n = this.nodes.get(gid(n.parentIndex.guid)); if (n && n.type !== "DOCUMENT") out.unshift(n.name || ""); }
      return out;
    }
    pages() {
      const pages = [];
      for (const p of this.children("0:0")) {
        if (p.type !== "CANVAS" || p.internalOnly || p.name === "Internal Only Canvas") continue;
        const frames = [];
        for (const f of this.children(gid(p.guid))) {
          if (!["FRAME", "SECTION", "SYMBOL", "INSTANCE", "GROUP"].includes(f.type) || f.visible === false) continue;
          frames.push(frameInfo(f, 0));
          if (f.type === "SECTION") for (const c of this.children(gid(f.guid))) if (["FRAME", "SYMBOL", "INSTANCE"].includes(c.type)) frames.push(frameInfo(c, 1));
        }
        pages.push({ id: gid(p.guid), name: p.name || "Без названия", frames });
      }
      return pages;
      function frameInfo(f, depth) { return { id: gid(f.guid), name: f.name || f.type, type: f.type, w: num(f.size?.x), h: num(f.size?.y), depth }; }
    }
    path(blobIndex) {
      if (this.pathCache.has(blobIndex)) return this.pathCache.get(blobIndex);
      const blob = this.blobs[blobIndex]?.bytes;
      let d = "";
      if (blob) {
        const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
        const n = { 0: 0, 1: 2, 2: 2, 3: 4, 4: 6 }, cmd = { 0: "Z", 1: "M", 2: "L", 3: "Q", 4: "C" };
        let p = 0; const parts = [];
        while (p < blob.length) {
          const c = blob[p++]; const k = n[c];
          if (k === undefined) break;
          const a = []; for (let i = 0; i < k; i++) { a.push(+dv.getFloat32(p, true).toFixed(2)); p += 4; }
          parts.push(cmd[c] + a.join(" "));
        }
        d = parts.join("");
      }
      this.pathCache.set(blobIndex, d);
      return d;
    }
  }

  // ---------------------------------------------------------------- форматирование
  function num(v) { if (v === undefined || v === null || Number.isNaN(v)) return undefined; const r = Math.round(v * 100) / 100; return Object.is(r, -0) ? 0 : r; }
  const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).toUpperCase().padStart(2, "0");
  function hexcolor(c = {}, opacity = 1) {
    const a = ((c.a ?? 255) / 255) * (opacity ?? 1);
    const h = `#${hex2(c.r || 0)}${hex2(c.g || 0)}${hex2(c.b || 0)}`;
    return a >= 0.999 ? h : h + hex2(a * 255);
  }
  function paints(ps, images) {
    const out = [];
    for (const p of ps || []) {
      if (p.visible === false) continue;
      const t = p.type || "";
      if (t === "SOLID") out.push(hexcolor(p.color, p.opacity));
      else if (t.startsWith("GRADIENT")) {
        const stops = (p.stops || []).map((s) => `${hexcolor(s.color, p.opacity)} ${num((s.position || 0) * 100)}%`).join(", ");
        out.push(`${t.toLowerCase().replace("gradient_", "")}-gradient(${stops})`);
      } else if (t === "IMAGE") {
        const h = p.image?.hash ? Array.from(p.image.hash, (b) => b.toString(16).padStart(2, "0")).join("") : "?";
        if (images) images.add(h);
        out.push(`image(${h}, ${String(p.imageScaleMode || "FILL").toLowerCase()})`);
      } else out.push(t.toLowerCase());
    }
    return out;
  }
  function effects(es) {
    const out = [];
    for (const e of es || []) {
      if (e.visible === false) continue;
      const t = e.type || "";
      if (t.includes("SHADOW")) { const o = e.offset || {}; out.push(`${t.startsWith("INNER") ? "inset " : ""}${num(o.x || 0)} ${num(o.y || 0)} ${num(e.radius || 0)} ${num(e.spread || 0) || 0} ${hexcolor(e.color)}`); }
      else if (t.includes("BLUR")) out.push(`${t.toLowerCase()}(${num(e.radius || 0)})`);
    }
    return out;
  }
  const WEIGHT = { thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, heavy: 900, black: 900 };
  const weightOf = (style = "") => WEIGHT[style.toLowerCase().replace(/[\s-]|italic/g, "")] || 400;

  // ---------------------------------------------------------------- раскрытие инстансов
  const SKIP = new Set(["guid", "guidPath", "parentIndex", "overrideKey"]);
  function merged(node, ov) {
    if (!ov) return node;
    const n = Object.assign({}, node);
    for (const k in ov) {
      if (SKIP.has(k)) continue;
      if (k === "textData" && n.textData) n.textData = Object.assign({}, n.textData, ov.textData);
      else n[k] = ov[k];
    }
    return n;
  }
  function applyProps(n, props) {
    const refs = n.componentPropRef;
    if (!refs || !refs.length || !props) return n;
    n = Object.assign({}, n);
    for (const ref of refs) {
      if (ref.isDeleted) continue;
      const v = props.get(gid(ref.defID)); if (!v) continue;
      const f = ref.componentPropNodeField;
      if (f === "TEXT_DATA" && v.textValue) { n.textData = Object.assign({}, n.textData, { characters: v.textValue.characters ?? n.textData?.characters ?? "" }); delete n.textData.characterStyleIDs; }
      else if (f === "VISIBLE" && "boolValue" in v) n.visible = v.boolValue;
      else if (f === "OVERRIDDEN_SYMBOL_ID" && v.guidValue) n.overriddenSymbolID = v.guidValue;
    }
    return n;
  }
  const VECTORISH = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "REGULAR_POLYGON", "LINE"]);

  function buildFrame(scene, id, opts = {}) {
    const o = Object.assign({ depth: 14, hidden: false }, opts);
    const root = scene.nodes.get(id);
    if (!root) throw new Error(`Слой ${id} не найден`);
    const usedImages = new Set();
    const tree = build(root, new Map(), null, 0, null);
    return { tree, usedImages };

    function build(n, ctx, prefix, depth, props) {
      n = applyProps(n, props);
      let key = null;
      if (prefix !== null) {
        const me = [gid(n.guid), gid(n.overrideKey || n.guid)];
        key = prefix.concat([me]);
        const kg = key.map((x) => x[0]).join("/"), ko = key.map((x) => x[1]).join("/");
        n = merged(n, ctx.get(kg) || ctx.get(ko));
      }
      if (n.visible === false && !o.hidden) return null;
      const t = n.type;
      const out = { type: t, name: n.name || "", id: gid(n.guid) };
      const tr = n.transform, sz = n.size;
      if (tr) {
        out.x = num(tr.m02 || 0); out.y = num(tr.m12 || 0);
        if (Math.abs(tr.m01 || 0) > 1e-3 || Math.abs((tr.m00 ?? 1) - 1) > 1e-3 || Math.abs((tr.m11 ?? 1) - 1) > 1e-3) {
          out.m = [tr.m00 ?? 1, tr.m10 || 0, tr.m01 || 0, tr.m11 ?? 1, tr.m02 || 0, tr.m12 || 0].map((v) => +v.toFixed(4));
          out.rotate = num((Math.atan2(tr.m10 || 0, tr.m00 ?? 1) * 180) / Math.PI);
        }
      }
      if (sz) { out.w = num(sz.x); out.h = num(sz.y); }
      if (n.visible === false) out.hidden = true;
      if ((n.opacity ?? 1) < 0.999) out.opacity = num(n.opacity);

      const sm = n.stackMode;
      if (sm === "HORIZONTAL" || sm === "VERTICAL") {
        const L = { dir: sm === "HORIZONTAL" ? "row" : "column", gap: num(n.stackSpacing || 0) };
        const pads = ["stackPaddingTop", "stackPaddingRight", "stackPaddingBottom", "stackPaddingLeft"].map((k) => num(n[k] || 0) || 0);
        if (pads.some(Boolean)) L.padding = pads;
        if (n.stackPrimaryAlignItems && n.stackPrimaryAlignItems !== "MIN") L.justify = n.stackPrimaryAlignItems.toLowerCase();
        if (n.stackCounterAlignItems && n.stackCounterAlignItems !== "MIN") L.align = n.stackCounterAlignItems.toLowerCase();
        if (n.stackWrap === "WRAP") L.wrap = true;
        L.sizing = { main: String(n.stackPrimarySizing || "FIXED").toLowerCase(), cross: String(n.stackCounterSizing || "FIXED").toLowerCase() };
        out.layout = L;
      }
      const child = {};
      if (n.stackChildPrimarySizing === "FILL") child.grow = true;
      if (n.stackChildCounterSizing === "FILL") child.stretch = true;
      if (n.autoLayoutAbsolutePos) child.absolute = true;
      if (Object.keys(child).length) out.child = child;

      if (t !== "TEXT") { const f = paints(n.fillPaints, usedImages); if (f.length) out.fill = f; }
      const s = paints(n.strokePaints);
      if (s.length && n.strokeWeight) {
        out.stroke = { color: s, weight: num(n.strokeWeight), align: String(n.strokeAlign || "INSIDE").toLowerCase() };
        if (n.borderStrokeWeightsIndependent) out.stroke.sides = ["borderTopWeight", "borderRightWeight", "borderBottomWeight", "borderLeftWeight"].map((k) => num(n[k] || 0));
        if (n.dashPattern && n.dashPattern.length) out.stroke.dash = n.dashPattern.map(num);
      }
      if (n.rectangleCornerRadiiIndependent) {
        const rr = ["rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius", "rectangleBottomRightCornerRadius", "rectangleBottomLeftCornerRadius"].map((k) => num(n[k] || 0));
        if (rr.some(Boolean)) out.radius = rr;
      } else if (n.cornerRadius) out.radius = num(n.cornerRadius);
      const ef = effects(n.effects); if (ef.length) out.shadow = ef;
      for (const [k, lab] of [["inheritFillStyleID", "fillStyle"], ["inheritStrokeStyleID", "strokeStyle"], ["inheritEffectStyleID", "effectStyle"], ["inheritTextStyleID", "textStyle"]]) {
        if (!n[k]) continue; const sn = scene.nodes.get(gid(n[k])); if (sn && sn.name) out[lab] = sn.name;
      }
      if (n.frameMaskDisabled === false && (t === "FRAME" || t === "INSTANCE" || t === "SYMBOL")) out.clip = true;
      if (VECTORISH.has(t)) {
        const fp = (n.fillGeometry || []).map((g) => ({ d: scene.path(g.blobIndex), rule: g.windingRule === "ODD" ? "evenodd" : "nonzero" })).filter((g) => g.d);
        const sp = (n.strokeGeometry || []).map((g) => ({ d: scene.path(g.blobIndex), rule: g.windingRule === "ODD" ? "evenodd" : "nonzero" })).filter((g) => g.d);
        if (fp.length) out.paths = fp;
        if (sp.length && s.length) out.strokePaths = sp;
      }

      if (t === "TEXT") {
        if (n.inheritTextStyleID) {
          const sty = scene.nodes.get(gid(n.inheritTextStyleID));
          if (sty) { n = Object.assign({}, n); for (const k of ["fontName", "fontSize", "lineHeight", "letterSpacing", "textCase", "textDecoration"]) if (!(k in n) && k in sty) n[k] = sty[k]; }
        }
        const fontSize = n.fontSize ?? 14; // Pixso не сериализует значение по умолчанию (14)
        const td = n.textData || {};
        out.text = td.characters || "";
        const fn = n.fontName || {};
        const st = { font: `${fn.family || ""} ${fn.style || ""}`.trim(), family: fn.family || "", weight: weightOf(fn.style), italic: /italic/i.test(fn.style || ""), size: num(fontSize) };
        const lh = n.lineHeight;
        if (lh && lh.units === "PIXELS") st.lineHeight = num(lh.value);
        else if (lh && lh.units === "PERCENT" && lh.value !== 100) st.lineHeight = `${num(lh.value)}%`;
        const ls = n.letterSpacing;
        if (ls && ls.value) st.letterSpacing = `${num(ls.value)}${ls.units === "PERCENT" ? "%" : "px"}`;
        const c = paints(n.fillPaints);
        if (c.length) st.color = c.length === 1 ? c[0] : c;
        if (n.textAlignHorizontal && n.textAlignHorizontal !== "LEFT") st.align = n.textAlignHorizontal.toLowerCase();
        if (n.textAlignVertical && n.textAlignVertical !== "TOP") st.valign = n.textAlignVertical.toLowerCase();
        if (n.textCase && n.textCase !== "ORIGINAL") st.case = n.textCase.toLowerCase();
        if (n.textDecoration && n.textDecoration !== "NONE") st.decoration = n.textDecoration.toLowerCase();
        if (n.textAutoResize) st.autoResize = n.textAutoResize.toLowerCase();
        const ids = td.characterStyleIDs || [], table = new Map((td.styleOverrideTable || []).map((x) => [x.styleID, x]));
        if (ids.length && ids.some(Boolean) && table.size) {
          const segs = []; let cur = ids[0], start = 0;
          for (let i = 0; i <= ids.length; i++) {
            const v = i < ids.length ? ids[i] : null;
            if (v !== cur) {
              const seg = { text: out.text.slice(start, i) };
              const x = cur ? table.get(cur) : null;
              if (x) {
                if (x.fontName) { seg.font = `${x.fontName.family || ""} ${x.fontName.style || ""}`.trim(); seg.family = x.fontName.family; seg.weight = weightOf(x.fontName.style); }
                if (x.fontSize) seg.size = num(x.fontSize);
                if (x.fillPaints) seg.color = paints(x.fillPaints)[0];
                if (x.textDecoration) seg.decoration = x.textDecoration.toLowerCase();
              }
              segs.push(seg); cur = v; start = i;
            }
          }
          if (segs.some((sg) => Object.keys(sg).length > 1)) st.runs = segs;
        }
        out.textStyle_ = st;
      }

      const kids = [];
      if (t === "INSTANCE") {
        const sd = n.symbolData || {};
        const symId = gid(n.overriddenSymbolID || sd.symbolID);
        const sym = scene.nodes.get(symId);
        if (sym) {
          const par = scene.nodes.get(gid(sym.parentIndex?.guid));
          out.component = par && par.isStateGroup ? `${par.name || ""} / ${sym.name || ""}` : sym.name || "";
          // derivedSymbolData < overrides этого инстанса < overrides внешних инстансов
          const inner = key || [];
          const ig = inner.map((x) => x[0]);
          const own = new Map();
          const derived = (n.derivedSymbolData || []).map((d) => ({ guidPath: d.guidPath, size: d.size, transform: d.transform, fillGeometry: d.fillGeometry, strokeGeometry: d.strokeGeometry }));
          for (const ov of derived.concat(sd.symbolOverrides || [])) {
            const gp = (ov.guidPath?.guids || []).map(gid);
            if (!gp.length) continue;
            const k = ig.concat(gp).join("/");
            const clean = {}; for (const kk in ov) if (ov[kk] !== undefined) clean[kk] = ov[kk];
            own.set(k, merged(own.get(k) || {}, clean));
          }
          const sub = new Map(own);
          for (const [k, v] of ctx) sub.set(k, merged(sub.get(k) || {}, v));
          const holder = par && par.isStateGroup ? par : sym;
          const iprops = new Map();
          for (const d of holder.componentPropDef || []) if (d.initialValue) iprops.set(gid(d.id), d.initialValue);
          for (const a of n.componentPropAssignment || []) if (a.value) iprops.set(gid(a.defID), a.value);
          if (depth < o.depth) for (const c of scene.children(symId)) { const r = build(c, sub, inner, depth + 1, iprops); if (r) kids.push(r); }
        } else out.component = `<не найден ${symId}>`;
      } else {
        // guidPath содержит только цепочку инстансов — обычные фреймы в него не входят
        for (const c of scene.children(gid(n.guid))) { const r = build(c, ctx, prefix, depth + 1, props); if (r) kids.push(r); }
      }
      if (kids.length) out.children = kids;
      return out;
    }
  }

  // ---------------------------------------------------------------- Markdown для LLM
  function mdLine(o) {
    const bits = [`**${o.type}**`];
    if (o.name) bits.push("`" + o.name + "`");
    if (o.component) bits.push(`⟶ компонент «${o.component}»`);
    let geo = `${o.w ?? "?"}×${o.h ?? "?"}`;
    if (o.x !== undefined) geo += ` @(${o.x},${o.y})`;
    bits.push(geo);
    const a = [];
    if (o.layout) {
      const L = o.layout; let s = `flex-${L.dir} gap ${L.gap}`;
      if (L.padding) s += " pad " + L.padding.join(" ");
      if (L.justify) s += ` justify ${L.justify}`;
      if (L.align) s += ` align ${L.align}`;
      if (L.wrap) s += " wrap";
      s += ` (size ${L.sizing.main}/${L.sizing.cross})`;
      a.push(s);
    }
    if (o.child) a.push(Object.keys(o.child).join(" "));
    if (o.fill) a.push("bg " + o.fill.join(", ") + (o.fillStyle ? ` [${o.fillStyle}]` : ""));
    if (o.stroke) { const s = o.stroke; a.push(`border ${s.weight} ${s.align} ${s.color.join(", ")}` + (s.sides ? ` sides ${s.sides.join(" ")}` : "") + (s.dash ? " dashed" : "") + (o.strokeStyle ? ` [${o.strokeStyle}]` : "")); }
    if (o.radius !== undefined) a.push(`radius ${Array.isArray(o.radius) ? o.radius.join(" ") : o.radius}`);
    if (o.shadow) a.push("shadow " + o.shadow.join("; ") + (o.effectStyle ? ` [${o.effectStyle}]` : ""));
    if (o.opacity !== undefined) a.push(`opacity ${o.opacity}`);
    if (o.rotate) a.push(`rotate ${o.rotate}°`);
    if (o.clip) a.push("overflow hidden");
    if (o.hidden) a.push("HIDDEN");
    if (o.textStyle_) {
      const st = o.textStyle_;
      let s = `${st.font} ${st.size}` + (st.lineHeight !== undefined ? `/${st.lineHeight}` : "");
      if (st.color) s += ` ${Array.isArray(st.color) ? st.color.join(",") : st.color}`;
      for (const k of ["align", "letterSpacing", "case", "decoration"]) if (st[k]) s += ` ${k} ${st[k]}`;
      if (o.textStyle) s += ` [${o.textStyle}]`;
      a.push(s);
    }
    let line = bits.join(" ");
    if (a.length) line += " | " + a.join(" | ");
    return line;
  }
  function toMd(o, depth = 0, out = []) {
    const ind = "  ".repeat(depth);
    out.push(ind + "- " + mdLine(o));
    if (o.text !== undefined) {
      out.push(`${ind}  «${o.text.replace(/\n/g, "⏎")}»`);
      for (const r of o.textStyle_?.runs || []) {
        const extra = Object.entries(r).filter(([k]) => !["text", "family", "weight"].includes(k)).map(([k, v]) => `${k} ${v}`);
        if (extra.length) out.push(`${ind}  ↳ фрагмент «${r.text}»: ${extra.join(", ")}`);
      }
    }
    for (const c of o.children || []) toMd(c, depth + 1, out);
    return out;
  }
  function summarize(tree) {
    const colors = new Map(), fonts = new Map(), comps = new Map(), images = new Set(); let count = 0;
    const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    (function walk(o) {
      count++;
      for (const f of o.fill || []) { if (f.startsWith("#")) inc(colors, f); const m = f.match(/^image\(([0-9a-f]+)/); if (m) images.add(m[1]); }
      for (const c of o.stroke?.color || []) if (c.startsWith("#")) inc(colors, c);
      const st = o.textStyle_;
      if (st) { inc(fonts, `${st.font} ${st.size}` + (st.lineHeight !== undefined ? `/${st.lineHeight}` : "")); if (typeof st.color === "string") inc(colors, st.color); }
      if (o.component) inc(comps, o.component);
      for (const c of o.children || []) walk(c);
    })(tree);
    const sort = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
    return { colors: sort(colors), fonts: sort(fonts), components: sort(comps), images: [...images], count };
  }
  function markdown(tree, meta = {}) {
    const s = summarize(tree);
    const lines = [
      `# Макет: ${tree.name} (${tree.id})`, "",
      `Страница: ${(meta.crumbs || []).join(" / ") || "—"}  `,
      `Источник: ${meta.source || "—"}`, "",
      "## Как читать", "",
      "- Каждая строка — слой: `ТИП` `имя` ширина×высота @(x,y относительно родителя) | свойства.",
      "- `flex-row/column gap G pad T R B L` — auto-layout (= CSS flexbox). `size resize_to_fit` = hug content, `fixed` = фиксированный размер.",
      "- `grow` — flex: 1 по главной оси, `stretch` — align-self: stretch, `absolute` — position: absolute.",
      "- Цвета #RRGGBB или #RRGGBBAA. В [квадратных скобках] — имя стиля/токена из дизайн-системы.",
      "- `⟶ компонент «…»` — инстанс компонента дизайн-системы, внутри уже раскрыт с учётом переопределений.",
      "- Текст: шрифт размер/межстрочный, цвет; строка ниже — сам текст.", "",
      "## Сводка", "",
      "**Цвета:** " + s.colors.slice(0, 30).map(([c, k]) => `\`${c}\`×${k}`).join(", "), "",
      "**Типографика:** " + s.fonts.slice(0, 20).map(([c, k]) => `\`${c}\`×${k}`).join(", "), "",
      "**Компоненты:** " + s.components.slice(0, 40).map(([c, k]) => `«${c}»×${k}`).join(", "), "",
    ];
    if (s.images.length) lines.push("**Картинки:** " + s.images.map((h) => `\`${h}\``).join(", "), "");
    lines.push("## Дерево слоёв", "", ...toMd(tree));
    return lines.join("\n") + "\n";
  }

  return { loadHar, decodeDocument, buildFrame, markdown, toMd, summarize, gid, Scene, parseSchema, decodeMessage };
})();
