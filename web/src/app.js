// Интерфейс «Раскроя». Тяжёлая работа (HAR, zstd, Kiwi) — в Web Worker из встроенных исходников.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
    return el;
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem("raskroy:" + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem("raskroy:" + k, JSON.stringify(v)); } catch (_) {} },
  };
  const fmt = (n) => (n === undefined ? "?" : String(n).replace(".", ","));
  const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };

  // ---------------------------------------------------------------- состояние
  const S = {
    demo: true, pages: DEMO.pages, currentId: "demo:root", tree: DEMO.tree, crumbs: DEMO.crumbs, images: {},
    md: CORE.markdown(DEMO.tree, { crumbs: DEMO.crumbs, source: "пример" }),
    flat: [], selected: null, zoom: 1, fit: true, file: null, meta: null, req: 0, filter: "",
    tab: store.get("tab", "md"), hidden: store.get("hidden", false),
  };

  // ---------------------------------------------------------------- worker
  let worker = null;
  function getWorker() {
    if (worker) return worker;
    const src = ["zstd-src", "core-src", "worker-src"].map((id) => document.getElementById(id).textContent).join("\n;\n");
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    worker.onmessage = onWorker;
    worker.onerror = (e) => showError(e.message || "Ошибка в фоновом обработчике");
    return worker;
  }
  function onWorker(e) {
    const m = e.data;
    if (m.type === "progress") stepProgress(m.stage, m.detail);
    else if (m.type === "ready") {
      stepProgress("done");
      S.demo = false; S.pages = m.pages; S.meta = m.meta; S.pageUrl = m.pageUrl; S.innerName = m.innerName;
      renderHeader(); renderRail();
      if (m.defaultId) openFrame(m.defaultId); else { hideProgress(); toast("В файле нет фреймов"); }
    } else if (m.type === "frame") {
      if (m.req !== S.req) return;
      hideProgress();
      S.currentId = m.id; S.tree = m.tree; S.md = m.md; S.images = m.images; S.crumbs = m.crumbs; S.selected = null;
      S.fit = true;
      renderAll();
    } else if (m.type === "error") {
      if (m.during === "build" && m.req !== S.req) return;
      showError(m.message);
    }
  }

  // ---------------------------------------------------------------- загрузка файла
  async function takeFile(file) {
    if (!file) return;
    S.file = { name: file.name, size: file.size };
    showProgress(file);
    try {
      const buf = await file.arrayBuffer();
      getWorker().postMessage({ type: "load", buffer: buf }, [buf]);
    } catch (err) { showError("Не удалось прочитать файл: " + err.message); }
  }
  function openFrame(id) {
    if (S.demo) return;
    S.req++;
    if (!$(".progress")) { $(".stage").classList.add("busy"); }
    getWorker().postMessage({ type: "build", req: S.req, id, opts: { hidden: S.hidden } });
    S.currentId = id; renderRail();
  }

  // ---------------------------------------------------------------- прогресс
  const STAGES = [["zip", "Архив"], ["har", "HAR"], ["schema", "Схема"], ["doc", "Документ"], ["nodes", "Слои"]];
  function showProgress(file) {
    hideProgress();
    const ul = h("ul", {}, STAGES.map(([k, label]) => h("li", { "data-k": k, class: k === "zip" && !/\.zip$/i.test(file.name) ? "skip" : "" }, h("span", { class: "dot" }), h("span", {}, label), h("span", { class: "d mono" }, ""))));
    ul.querySelectorAll(".skip").forEach((li) => li.remove());
    ul.firstElementChild.classList.add("now");
    const card = h("div", { class: "card", role: "status", "aria-live": "polite" },
      h("div", { class: "blade" }), h("h4", {}, "Раскраиваю файл"),
      h("div", { class: "file mono" }, `${file.name} · ${(file.size / 1048576).toFixed(1)} МБ`), ul);
    $(".stage").append(h("div", { class: "progress" }, card));
    $("#intro") && ($("#intro").hidden = true);
  }
  function stepProgress(stage, detail) {
    const box = $(".progress"); if (!box) return;
    const items = [...box.querySelectorAll("li")];
    if (stage === "done") { items.forEach((li) => { li.classList.remove("now"); li.classList.add("done"); }); return; }
    const i = items.findIndex((li) => li.dataset.k === stage);
    if (i < 0) return;
    items.forEach((li, j) => { li.classList.toggle("done", j <= i); li.classList.toggle("now", j === i + 1); });
    items[i].querySelector(".d").textContent = detail || "";
  }
  function hideProgress() { const p = $(".progress"); if (p) p.remove(); $(".stage").classList.remove("busy"); }
  function showError(msg) {
    $(".stage").classList.remove("busy");
    let box = $(".progress");
    if (!box) { showProgress(S.file || { name: "файл", size: 0 }); box = $(".progress"); }
    const card = box.querySelector(".card");
    card.querySelector(".blade")?.remove();
    card.querySelector("h4").textContent = "Не получилось раскроить";
    card.querySelectorAll(".now").forEach((li) => li.classList.remove("now"));
    card.append(h("div", { class: "err" }, msg), h("button", { class: "btn", onclick: () => { hideProgress(); if (S.demo) $("#intro").hidden = false; } }, "Закрыть"));
  }

  // ---------------------------------------------------------------- шапка
  function renderHeader() {
    const box = $("#filechip"); box.replaceChildren();
    if (S.demo) {
      box.append(h("button", { class: "btn primary", onclick: () => $("#file").click() }, icon("upload"), "Открыть файл"));
      return;
    }
    const m = S.meta || {};
    box.append(
      h("div", { class: "meta mono" }, h("b", {}, S.file?.name || "файл"), h("br"),
        `${(m.nodes || 0).toLocaleString("ru-RU")} слоёв · Kiwi ${m.schema || "?"}${m.created ? " · Pixso " + m.created : ""}`),
      h("button", { class: "btn", onclick: () => $("#file").click() }, icon("upload"), "Другой файл"),
    );
  }

  // ---------------------------------------------------------------- список фреймов
  function renderRail() {
    const list = $("#frames"), sel = $("#frame-select");
    list.replaceChildren(); sel.replaceChildren();
    const q = S.filter.trim().toLowerCase();
    let total = 0;
    for (const p of S.pages) {
      const frames = p.frames.filter((f) => !q || f.name.toLowerCase().includes(q) || f.id.includes(q));
      if (!frames.length) continue;
      list.append(h("div", { class: "page label" }, h("span", {}, p.name), h("span", { class: "tnum" }, frames.length)));
      const og = h("optgroup", { label: p.name });
      for (const f of frames) {
        total++;
        list.append(h("button", {
          class: f.depth ? "sub" : "", "aria-current": f.id === S.currentId ? "true" : "false", title: `${f.name} · ${f.id}`,
          onclick: () => { if (f.id !== S.currentId) openFrame(f.id); },
        }, h("i", { class: "sq" }), h("span", { class: "nm" }, f.name), h("span", { class: "dim mono tnum" }, `${fmt(f.w)}×${fmt(f.h)}`)));
        og.append(h("option", { value: f.id, selected: f.id === S.currentId }, `${f.depth ? "  " : ""}${f.name} — ${fmt(f.w)}×${fmt(f.h)}`));
      }
      sel.append(og);
    }
    if (!total) list.append(h("div", { class: "empty" }, q ? "Ничего не нашлось. Попробуйте часть имени фрейма или его id." : "На страницах нет фреймов."));
    $("#frames-count").textContent = S.pages.reduce((a, p) => a + p.frames.length, 0);
  }

  // ---------------------------------------------------------------- превью
  const CSS_GRAD = (f) => {
    const m = f.match(/^(\w+)-gradient\((.*)\)$/); if (!m) return null;
    const stops = m[2];
    if (m[1] === "linear") return `linear-gradient(180deg, ${stops})`;
    if (m[1] === "angular") return `conic-gradient(${stops})`;
    return `radial-gradient(closest-side, ${stops})`;
  };
  const firstColor = (c) => { if (!c) return null; const s = Array.isArray(c) ? c[0] : c; if (s.startsWith("#")) return s; const m = s.match(/#[0-9A-F]{6,8}/i); return m ? m[0] : null; };
  const px = (v) => `${v}px`;

  function renderBoard() {
    const t = S.tree, board = $("#board"), sheet = $("#sheet");
    board.replaceChildren(); S.flat = [];
    board.style.width = px(t.w); board.style.height = px(t.h);
    const root = node(t, true, -1);
    board.append(root);
    applyZoom();
  }
  function node(o, isRoot, parent) {
    const i = S.flat.length;
    const el = document.createElement("div");
    el.className = "n" + (o.type === "TEXT" ? " txt" : "");
    el.dataset.i = i;
    S.flat.push({ o, el, parent });
    const st = el.style;
    if (!isRoot && o.m) { st.left = "0"; st.top = "0"; st.transform = `matrix(${o.m.join(",")})`; }
    else { st.left = px(isRoot ? 0 : o.x || 0); st.top = px(isRoot ? 0 : o.y || 0); }
    st.width = px(Math.max(o.w || 0, 0)); st.height = px(Math.max(o.h || 0, 0));
    const vec = !!(o.paths || o.strokePaths);
    if (o.fill && o.type !== "TEXT" && !vec) {
      const layers = o.fill.slice().reverse().map((f) => {
        if (f.startsWith("#")) return `linear-gradient(${f},${f})`;
        if (f.includes("-gradient(")) return CSS_GRAD(f);
        const m = f.match(/^image\(([0-9a-f?]+)/);
        if (m) return S.images[m[1]] ? `url("${S.images[m[1]]}") center/cover no-repeat` : "repeating-linear-gradient(45deg, #9aa9a2 0 6px, #c5d0cb 6px 12px)";
        return null;
      }).filter(Boolean);
      if (layers.length) st.background = layers.reverse().join(",");
    }
    if (o.type === "ELLIPSE") st.borderRadius = "50%";
    else if (o.radius !== undefined) st.borderRadius = Array.isArray(o.radius) ? o.radius.map(px).join(" ") : px(o.radius);
    const shadows = [], filters = [];
    if (o.stroke && !vec) {
      const s = o.stroke, c = firstColor(s.color) || "#000";
      if (s.sides) { st.boxSizing = "border-box"; st.borderStyle = s.dash ? "dashed" : "solid"; st.borderColor = c; st.borderWidth = s.sides.map(px).join(" "); }
      else if (s.dash) { st.outline = `${s.weight}px dashed ${c}`; st.outlineOffset = s.align === "outside" ? "0" : `-${s.weight}px`; }
      else if (s.align === "outside") shadows.push(`0 0 0 ${s.weight}px ${c}`);
      else if (s.align === "center") shadows.push(`inset 0 0 0 ${s.weight / 2}px ${c}`, `0 0 0 ${s.weight / 2}px ${c}`);
      else shadows.push(`inset 0 0 0 ${s.weight}px ${c}`);
    }
    for (const sh of o.shadow || []) {
      const b = sh.match(/^(\w+)_blur\(([\d.]+)\)$/);
      if (b) { if (b[1] === "background") st.backdropFilter = `blur(${b[2] / 2}px)`; else filters.push(`blur(${b[2] / 2}px)`); continue; }
      const p = sh.split(" "); const inset = p[0] === "inset"; if (inset) p.shift();
      const [x, y, r, s, c] = p;
      if (o.type === "TEXT" || vec) filters.push(`drop-shadow(${x}px ${y}px ${r / 2}px ${c})`);
      else shadows.push(`${inset ? "inset " : ""}${x}px ${y}px ${r}px ${s}px ${c}`);
    }
    if (shadows.length) st.boxShadow = shadows.join(",");
    if (filters.length) st.filter = filters.join(" ");
    if (o.opacity !== undefined) st.opacity = o.opacity;
    if (o.clip) st.overflow = "hidden";

    if (vec) {
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("width", Math.max(o.w || 0, 1)); svg.setAttribute("height", Math.max(o.h || 0, 1));
      const fillC = firstColor(o.fill?.find((f) => f.startsWith("#") || f.includes("gradient")));
      for (const p of o.paths || []) { if (!fillC) break; const e = document.createElementNS(ns, "path"); e.setAttribute("d", p.d); e.setAttribute("fill", fillC); e.setAttribute("fill-rule", p.rule); svg.append(e); }
      const strokeC = firstColor(o.stroke?.color);
      for (const p of o.strokePaths || []) { if (!strokeC) break; const e = document.createElementNS(ns, "path"); e.setAttribute("d", p.d); e.setAttribute("fill", strokeC); e.setAttribute("fill-rule", p.rule); svg.append(e); }
      el.append(svg);
    }
    if (o.type === "TEXT") {
      const ts = o.textStyle_ || {};
      st.fontFamily = `"${ts.family || ""}", var(--font-ui)`;
      st.fontWeight = ts.weight || 400; if (ts.italic) st.fontStyle = "italic";
      st.fontSize = px(ts.size || 14);
      if (ts.lineHeight !== undefined) st.lineHeight = typeof ts.lineHeight === "number" ? px(ts.lineHeight) : ts.lineHeight;
      if (ts.letterSpacing) st.letterSpacing = ts.letterSpacing.endsWith("%") ? `${parseFloat(ts.letterSpacing) / 100}em` : ts.letterSpacing;
      st.color = firstColor(ts.color) || "#000";
      if (ts.align) st.textAlign = ts.align === "justified" ? "justify" : ts.align;
      if (ts.valign) st.justifyContent = ts.valign === "center" ? "center" : "flex-end";
      if (ts.case === "upper") st.textTransform = "uppercase"; else if (ts.case === "lower") st.textTransform = "lowercase"; else if (ts.case === "title") st.textTransform = "capitalize";
      if (ts.decoration) st.textDecoration = ts.decoration === "strikethrough" ? "line-through" : "underline";
      st.whiteSpace = ts.autoResize === "width_and_height" ? "pre" : "pre-wrap";
      const span = document.createElement("span");
      if (ts.runs) for (const r of ts.runs) {
        const s = document.createElement("span"); s.textContent = r.text;
        if (r.color) s.style.color = firstColor(r.color); if (r.size) s.style.fontSize = px(r.size);
        if (r.weight) s.style.fontWeight = r.weight; if (r.family) s.style.fontFamily = `"${r.family}", var(--font-ui)`;
        if (r.decoration) s.style.textDecoration = r.decoration === "strikethrough" ? "line-through" : "underline";
        span.append(s);
      } else span.textContent = o.text;
      el.append(span);
    }
    for (const c of o.children || []) el.append(node(c, false, i));
    return el;
  }

  function fitZoom() {
    const v = $("#view"); const pad = innerWidth <= 820 ? 40 : 96;
    const z = Math.min((v.clientWidth - pad) / S.tree.w, 2);
    return Math.max(0.05, Math.floor(z * 100) / 100);
  }
  function applyZoom() {
    if (S.fit) S.zoom = fitZoom();
    const z = S.zoom, t = S.tree;
    $("#board").style.transform = `scale(${z})`;
    $("#sheet").style.width = px(t.w * z); $("#sheet").style.height = px(t.h * z);
    $("#zoom-val").textContent = `${Math.round(z * 100)}%`;
    document.querySelectorAll("#zoom button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.z === "fit" ? S.fit : !S.fit && +b.dataset.z === z)));
    placeSel(); drawRulers();
  }

  // наведение и выбор
  function rectIn(el) {
    const sr = $("#sheet").getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height };
  }
  function place(box, i) {
    if (i === null || i === undefined || !S.flat[i]) { box.hidden = true; return; }
    const { o, el } = S.flat[i]; const r = rectIn(el);
    box.hidden = false;
    Object.assign(box.style, { left: px(r.x), top: px(r.y), width: px(Math.max(r.w, 1)), height: px(Math.max(r.h, 1)) });
    box.querySelector(".tagx").textContent = `${o.name || (o.text ? "«" + (o.text.length > 26 ? o.text.slice(0, 25) + "…" : o.text) + "»" : o.type)} · ${fmt(o.w)}×${fmt(o.h)}`;
  }
  function placeSel() { place($("#sel"), S.selected); }
  function select(i, from) {
    S.selected = i; placeSel(); drawRulers(); renderInspector();
    document.querySelectorAll(".tree .row[aria-selected='true']").forEach((r) => r.setAttribute("aria-selected", "false"));
    if (i === null) return;
    // раскрыть предков в дереве
    let p = S.flat[i].parent; const chain = [];
    while (p >= 0) { chain.push(p); p = S.flat[p].parent; }
    for (const a of chain.reverse()) { const row = $(`.tree .row[data-i="${a}"]`); if (row) expand(row, true); }
    const row = $(`.tree .row[data-i="${i}"]`);
    if (row) { row.setAttribute("aria-selected", "true"); if (from !== "tree") row.scrollIntoView({ block: "nearest" }); }
  }

  // линейки в пикселях фрейма
  function drawRulers() {
    const rx = $("#rx"), ry = $("#ry"), v = $("#view");
    if (!rx.offsetWidth) return;
    const dpr = devicePixelRatio || 1, cs = getComputedStyle(document.documentElement);
    const ink = cs.getPropertyValue("--ink-faint").trim(), acc = cs.getPropertyValue("--accent-soft").trim(), accLine = cs.getPropertyValue("--accent").trim();
    const vr = v.getBoundingClientRect(), sr = $("#sheet").getBoundingClientRect(), z = S.zoom;
    const steps = [5, 10, 20, 50, 100, 200, 500, 1000, 2000];
    const major = steps.find((s) => s * z >= 64) || 5000, minor = major / (major % 5 === 0 ? 5 : 2);
    const sel = S.selected !== null && S.flat[S.selected] ? rectIn(S.flat[S.selected].el) : null;
    for (const [cv, horiz] of [[rx, true], [ry, false]]) {
      const W = cv.offsetWidth, H = cv.offsetHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      const c = cv.getContext("2d"); c.scale(dpr, dpr); c.clearRect(0, 0, W, H);
      const origin = horiz ? sr.left - vr.left : sr.top - vr.top, len = horiz ? W : H;
      if (sel) { c.fillStyle = acc; const a = origin + (horiz ? sel.x : sel.y), b = horiz ? sel.w : sel.h; horiz ? c.fillRect(a, 0, b, H) : c.fillRect(0, a, W, b); c.fillStyle = accLine; horiz ? (c.fillRect(a, 0, 1, H), c.fillRect(a + b - 1, 0, 1, H)) : (c.fillRect(0, a, W, 1), c.fillRect(0, a + b - 1, W, 1)); }
      c.fillStyle = ink; c.strokeStyle = ink; c.font = `500 9px ${cs.getPropertyValue("--font-mono")}`; c.lineWidth = 1;
      const from = Math.floor(-origin / z / minor) * minor, to = (len - origin) / z;
      for (let p = from; p <= to; p += minor) {
        const s = Math.round(origin + p * z) + 0.5; const isMajor = Math.abs(p % major) < 1e-6;
        const tl = isMajor ? 9 : 4;
        c.beginPath();
        if (horiz) { c.moveTo(s, H); c.lineTo(s, H - tl); } else { c.moveTo(W, s); c.lineTo(W - tl, s); }
        c.stroke();
        if (isMajor) {
          if (horiz) c.fillText(String(Math.round(p)), s + 3, 10);
          else { c.save(); c.translate(10, s - 3); c.rotate(-Math.PI / 2); c.fillText(String(Math.round(p)), 0, 0); c.restore(); }
        }
      }
    }
  }

  // ---------------------------------------------------------------- панель
  function setTab(t) {
    S.tab = t; store.set("tab", t);
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
    document.querySelectorAll(".tabpane").forEach((p) => (p.hidden = p.dataset.tab !== t));
    if (t === "layers" && S.selected !== null) select(S.selected);
  }
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  function renderMd() {
    const html = esc(S.md).split("\n").map((line) => {
      if (line.startsWith("#")) return `<span class="h">${line}</span>`;
      return line
        .replace(/\*\*([A-Z_]+)\*\*/g, '<span class="t">$1</span>')
        .replace(/⟶ компонент «([^»]*)»/g, '<span class="cmp">⟶ «$1»</span>')
        .replace(/^(\s*)«(.*)»$/g, '$1<span class="tx">«$2»</span>')
        .replace(/`([^`]+)`/g, '<span class="nm">$1</span>')
        .replace(/#[0-9A-F]{6}(?:[0-9A-F]{2})?\b/g, (c) => `<i class="sw" style="background:${c}"></i>${c}`);
    }).join("\n");
    $("#md").innerHTML = html;
    const kb = new Blob([S.md]).size / 1024;
    $("#md-meta").textContent = `${kb.toFixed(1).replace(".", ",")} КБ · ≈${Math.round(S.md.length / 3.2).toLocaleString("ru-RU")} токенов`;
    $("#tab-md-n").textContent = `${S.md.split("\n").length}`;
  }
  function renderTree() {
    const box = $("#tree"); box.replaceChildren();
    const TY = { FRAME: "FR", INSTANCE: "IN", TEXT: "TX", VECTOR: "VC", RECTANGLE: "RE", ELLIPSE: "EL", GROUP: "GR", LINE: "LN", BOOLEAN_OPERATION: "BO", SYMBOL: "SY", SECTION: "SE", STAR: "ST", REGULAR_POLYGON: "PO" };
    const build = (i, depth) => {
      const { o } = S.flat[i];
      const kidsIdx = []; for (let j = i + 1; j < S.flat.length; j++) if (S.flat[j].parent === i) kidsIdx.push(j);
      const open = depth < 2;
      const tw = kidsIdx.length ? h("button", { class: "tw", "aria-expanded": String(open), "aria-label": "Развернуть", onclick: (e) => { e.stopPropagation(); expand(e.currentTarget.closest(".row")); } }, icon("caret")) : h("span");
      const label = o.type === "TEXT" ? h("span", { class: "nm" }, h("q", {}, (o.text || "").slice(0, 60))) : h("span", { class: "nm" }, o.name || o.type, o.component ? h("span", { class: "dm" }, "  " + o.component) : null);
      const row = h("div", { class: "row", role: "treeitem", tabindex: "0", "data-i": i, "aria-selected": "false", style: `padding-left:${depth * 12}px`,
        onclick: () => select(i, "tree"), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(i, "tree"); } } },
        tw, h("span", { class: "ty" + (o.type === "INSTANCE" ? " in" : o.type === "TEXT" ? " tx" : "") }, TY[o.type] || o.type.slice(0, 2)), label,
        h("span", { class: "dm mono tnum" }, `${fmt(o.w)}×${fmt(o.h)}`));
      const wrap = h("div", { role: "group" }, row);
      if (kidsIdx.length) {
        const kids = h("div", { class: "kids", hidden: !open });
        if (open) kidsIdx.forEach((j) => kids.append(build(j, depth + 1)));
        else kids.dataset.lazy = JSON.stringify(kidsIdx), kids.dataset.depth = depth + 1;
        wrap.append(kids);
      }
      return wrap;
    };
    box._build = build;
    if (S.flat.length) box.append(build(0, 0));
    $("#tab-layers-n").textContent = S.flat.length;
  }
  function expand(row, force) {
    const btn = row.querySelector(".tw"); if (!btn || !btn.tagName || btn.tagName !== "BUTTON") return;
    const kids = row.parentElement.querySelector(":scope > .kids"); if (!kids) return;
    const open = force === true ? true : btn.getAttribute("aria-expanded") !== "true";
    if (open && kids.dataset.lazy) { const d = +kids.dataset.depth; JSON.parse(kids.dataset.lazy).forEach((j) => kids.append($("#tree")._build(j, d))); delete kids.dataset.lazy; }
    btn.setAttribute("aria-expanded", String(open)); kids.hidden = !open;
  }
  function renderInspector() {
    const box = $("#inspector"); box.replaceChildren();
    if (S.selected === null) { box.append(h("p", { class: "empty" }, "Выберите слой на превью или в дереве — здесь появятся его размеры, отступы, цвета и шрифт, а ещё кнопка, чтобы скопировать только этот блок.")); return; }
    const { o } = S.flat[S.selected];
    const rows = [];
    const add = (k, ...v) => rows.push(h("dt", {}, k), h("dd", {}, ...v));
    add("Размер", h("span", { class: "tnum" }, `${fmt(o.w)} × ${fmt(o.h)}`), o.x !== undefined ? h("span", { class: "mono", style: "color:var(--ink-faint)" }, `  x ${fmt(o.x)} · y ${fmt(o.y)}`) : null);
    if (o.component) add("Компонент", o.component);
    if (o.layout) { const L = o.layout; add("Auto-layout", `${L.dir === "row" ? "строка →" : "колонка ↓"} · gap ${L.gap}` + (L.padding ? ` · padding ${L.padding.join(" ")}` : "") + (L.justify ? ` · ${L.justify}` : "") + (L.align ? ` · align ${L.align}` : "")); }
    if (o.child) add("В родителе", Object.keys(o.child).map((k) => ({ grow: "растягивается", stretch: "на всю ширину", absolute: "абсолютно" })[k]).join(", "));
    const chips = (list) => list.map((c) => h("span", { class: "chip" }, h("i", { style: `background:${c.startsWith("#") ? c : c.includes("gradient") ? CSS_GRAD(c) : "transparent"}` }), c.length > 40 ? c.slice(0, 40) + "…" : c));
    if (o.fill) add("Заливка", ...chips(o.fill), o.fillStyle ? h("div", { class: "mono" }, o.fillStyle) : null);
    if (o.stroke) add("Обводка", `${o.stroke.weight}px ${o.stroke.align} `, ...chips(o.stroke.color));
    if (o.radius !== undefined) add("Скругление", Array.isArray(o.radius) ? o.radius.join(" ") : String(o.radius));
    if (o.shadow) add("Эффекты", o.shadow.join("; "));
    if (o.opacity !== undefined) add("Прозрачность", String(o.opacity));
    if (o.textStyle_) {
      const ts = o.textStyle_;
      add("Текст", o.text);
      add("Шрифт", `${ts.font} · ${ts.size}${ts.lineHeight !== undefined ? "/" + ts.lineHeight : ""}${ts.letterSpacing ? " · " + ts.letterSpacing : ""}`, ...(ts.color ? chips([].concat(ts.color)) : []), o.textStyle ? h("div", { class: "mono" }, o.textStyle) : null);
    }
    box.append(
      h("h5", {}, o.name || (o.text ? `«${o.text.slice(0, 40)}»` : o.type)),
      h("div", { class: "sub mono" }, `${o.type} · ${o.id}`),
      h("dl", {}, rows),
      h("button", { class: "btn", onclick: () => copy(`Фрагмент макета «${S.tree.name}» (${S.tree.id}), слой «${o.name || o.type}»:\n\n` + CORE.toMd(o).join("\n") + "\n", "Блок скопирован") }, icon("copy"), "Копировать этот блок"),
    );
  }
  function renderSummary() {
    const s = CORE.summarize(S.tree);
    const sw = $("#swatches"); sw.replaceChildren();
    for (const [c, k] of s.colors.slice(0, 48)) sw.append(h("button", { title: "Скопировать " + c, onclick: () => copy(c, `${c} скопирован`) }, h("i", { style: `background:${c}` }), h("span", {}, c, h("em", {}, "×" + k))));
    if (!s.colors.length) sw.append(h("p", { class: "empty" }, "Сплошных цветов нет."));
    const sp = $("#specimens"); sp.replaceChildren();
    const fams = new Map();
    (function walk(o) { if (o.textStyle_) { const st = o.textStyle_; const key = `${st.font} ${st.size}` + (st.lineHeight !== undefined ? `/${st.lineHeight}` : ""); if (!fams.has(key)) fams.set(key, { st, text: o.text }); } (o.children || []).forEach(walk); })(S.tree);
    for (const [key, k] of s.fonts) {
      const f = fams.get(key); if (!f) continue;
      sp.append(h("div", {}, h("span", { class: "s", style: `font-family:"${f.st.family}",var(--font-ui);font-weight:${f.st.weight};font-size:${Math.min(f.st.size, 26)}px;line-height:1.25` }, (f.text || "Съешь же ещё").split("\n")[0].slice(0, 40) || "Аа Бб"), h("span", { class: "mono tnum" }, `${key} ×${k}`)));
    }
    const cl = $("#comps"); cl.replaceChildren();
    for (const [c, k] of s.components) cl.append(h("li", {}, h("span", {}, c), h("span", { class: "mono tnum" }, "×" + k)));
    if (!s.components.length) cl.append(h("li", {}, h("span", {}, "Компонентов нет")));
    $("#tab-sum-n").textContent = s.colors.length;
  }
  function renderStageBar() {
    $("#st-name").textContent = S.tree.name || S.tree.type;
    $("#st-crumbs").textContent = `${S.crumbs.join(" / ")} · ${S.tree.id} · ${fmt(S.tree.w)}×${fmt(S.tree.h)}`;
    $("#demo-badge").hidden = !S.demo;
  }
  function renderAll() {
    renderStageBar(); renderBoard(); renderMd(); renderTree(); renderInspector(); renderSummary(); renderRail();
    $("#dl").hidden = !(window.self === window.top);
  }

  // ---------------------------------------------------------------- копирование / скачивание
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("on"), 1800); }
  function copy(text, ok = "Скопировано") {
    const fallback = () => {
      const ta = h("textarea", { style: "position:fixed;left:-9999px;top:0" }); ta.value = text; document.body.append(ta); ta.select();
      let done = false; try { done = document.execCommand("copy"); } catch (_) {}
      ta.remove(); toast(done ? ok : "Не удалось скопировать — выделите текст вручную");
    };
    try { navigator.clipboard.writeText(text).then(() => toast(ok), fallback); } catch (_) { fallback(); }
  }
  function download() {
    try {
      const a = h("a", { href: URL.createObjectURL(new Blob([S.md], { type: "text/markdown" })), download: `${(S.tree.id || "frame").replace(":", "-")}.md` });
      document.body.append(a); a.click(); a.remove();
      toast("Файл сохранён");
    } catch (_) { toast("Сохранение недоступно — скопируйте текст"); }
  }

  // ---------------------------------------------------------------- иконки
  function icon(name) {
    const P = {
      upload: "M8 11V2M4.5 5.5 8 2l3.5 3.5M2.5 10.5v3h11v-3",
      copy: "M5.5 5.5h8v8h-8zM2.5 10.5v-8h8",
      save: "M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11",
      caret: "M5 3l5 5-5 5",
    };
    const ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "1.6"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(ns, "path"); p.setAttribute("d", P[name]); s.append(p); return s;
  }

  // ---------------------------------------------------------------- события
  function init() {
    document.querySelectorAll("[data-icon]").forEach((el) => el.prepend(icon(el.dataset.icon)));
    $("#file").addEventListener("change", (e) => { takeFile(e.target.files[0]); e.target.value = ""; });
    const dz = $("#dropzone");
    dz.addEventListener("click", () => $("#file").click());
    dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#file").click(); } });
    let depth = 0;
    addEventListener("dragenter", (e) => { if (![...e.dataTransfer.types].includes("Files")) return; e.preventDefault(); depth++; $("#dropall").hidden = false; dz.classList.add("over"); });
    addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
    addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) { $("#dropall").hidden = true; dz.classList.remove("over"); } });
    addEventListener("drop", (e) => { e.preventDefault(); depth = 0; $("#dropall").hidden = true; dz.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) takeFile(f); });

    // ссылка на макет
    const link = $("#link"), openA = $("#open-link"), hint = $("#linkhint");
    const checkLink = () => {
      const v = link.value.trim();
      let ok = false, msg = "Вставьте ссылку из адресной строки Pixso или из «Копировать ссылку»", cls = "";
      if (v) {
        try {
          const u = new URL(v);
          const key = (u.pathname.match(/\/app\/design\/([^/?#]+)/) || [])[1];
          const item = u.searchParams.get("item-id") || u.searchParams.get("node-id");
          if (key) { ok = true; cls = "ok"; msg = `Файл ${key}${item ? " · фрейм " + item.replace("-", ":") : ""} — откройте и нажмите закладку «Раскрой ▸ Pixso»`; }
          else { cls = "bad"; msg = "Это не ссылка на макет: нужен адрес вида …/app/design/<файл>"; }
        } catch (_) { cls = "bad"; msg = "Не похоже на ссылку"; }
      }
      openA.setAttribute("aria-disabled", String(!ok));
      openA.href = ok ? v : "#";
      hint.textContent = msg; hint.className = "linkhint mono " + cls;
      store.set("link", v);
    };
    link.value = store.get("link", "");
    link.addEventListener("input", checkLink); checkLink();
    $("#linkform").addEventListener("submit", (e) => { e.preventDefault(); if (openA.getAttribute("aria-disabled") === "false") openA.click(); });
    $("#bookmarklet").addEventListener("click", (e) => { e.preventDefault(); toast("Перетащите кнопку на панель закладок, а нажимайте её на вкладке Pixso"); });
    $("#copy-snippet").addEventListener("click", () => copy($("#snippet-src").textContent, "Код скопирован — вставьте его в консоль на вкладке Pixso"));

    $("#filter").addEventListener("input", (e) => { S.filter = e.target.value; renderRail(); });
    $("#frame-select").addEventListener("change", (e) => openFrame(e.target.value));
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
    $("#copy-md").addEventListener("click", () => copy(S.md, "Описание скопировано — вставьте его в ГигаКод"));
    $("#dl").addEventListener("click", download);
    $("#copy-prompt").addEventListener("click", (e) => { e.preventDefault(); copy($("#prompt-text").textContent, "Промпт скопирован"); });
    $("#hidden-layers").checked = S.hidden;
    $("#hidden-layers").addEventListener("change", (e) => { S.hidden = e.target.checked; store.set("hidden", S.hidden); if (!S.demo) openFrame(S.currentId); });
    $("#zoom").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; if (b.dataset.z === "fit") S.fit = true; else { S.fit = false; S.zoom = +b.dataset.z; } applyZoom(); });

    const board = $("#board"), hl = $("#hl");
    board.addEventListener("pointermove", (e) => { const n = e.target.closest(".n"); place(hl, n ? +n.dataset.i : null); });
    board.addEventListener("pointerleave", () => (hl.hidden = true));
    board.addEventListener("click", (e) => { const n = e.target.closest(".n"); if (n) { select(+n.dataset.i); } });
    $("#view").addEventListener("scroll", () => { drawRulers(); hl.hidden = true; }, { passive: true });
    $("#view").addEventListener("wheel", (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); S.fit = false; S.zoom = Math.min(4, Math.max(0.05, +(S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)).toFixed(3))); applyZoom(); }, { passive: false });
    addEventListener("keydown", (e) => { if (e.key === "Escape") select(null); });
    let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(applyZoom, 80); });
    matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", drawRulers);
    new MutationObserver(drawRulers).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    renderHeader(); setTab(S.tab); renderAll();
    if (document.fonts) document.fonts.ready.then(() => { applyZoom(); });
  }
  init();
})();
