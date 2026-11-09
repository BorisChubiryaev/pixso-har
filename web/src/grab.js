// Закладка «Раскрой»: запускается на вкладке Pixso (той, где открыт макет) и достаёт документ
// тем же путём, что и сам редактор: токен файла → схема → WebSocket /ws/coop → FileInit → документ.
// Ничего не меняет в макете: соединение только читает файл и сразу закрывается.
// Требует ZSTD и CORE (вклеиваются при сборке).
(() => {
  if (window.__raskroy) { window.__raskroy.show(); return; }
  const fileKey = (location.pathname.match(/\/app\/design\/([^/?#]+)/) || [])[1];

  // ---------------------------------------------------------------- панель
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host{all:initial}
    .p{width:368px;max-width:calc(100vw - 32px);font:14px/1.45 "Onest","Segoe UI",system-ui,sans-serif;color:#10221b;background:#f3f7f4;border:1px solid rgba(16,40,30,.18);border-radius:10px;box-shadow:0 18px 40px -16px rgba(16,40,30,.45);overflow:hidden}
    .h{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#cddcd2;background-image:linear-gradient(rgba(18,72,52,.1) 1px,transparent 1px),linear-gradient(90deg,rgba(18,72,52,.1) 1px,transparent 1px);background-size:12px 12px}
    .h b{font:800 15px/1 "Unbounded","Arial Black",sans-serif;letter-spacing:-.01em}.h b span{color:#a96400}
    .x{border:0;background:transparent;font-size:18px;line-height:1;cursor:pointer;color:#4a6057;padding:2px 6px}
    .b{padding:12px;display:grid;gap:10px}
    ul{list-style:none;margin:0;padding:0;display:grid;gap:5px;font-size:12.5px}
    li{display:grid;grid-template-columns:12px 1fr;gap:8px;align-items:center;color:#7d9188}
    li i{width:8px;height:8px;border-radius:50%;border:1.5px solid currentColor}
    li.ok{color:#10221b}li.ok i{background:#1f7a3f;border-color:#1f7a3f}
    li.now{color:#10221b}li.now i{border-color:#a96400;background:#a96400}
    li span{overflow-wrap:anywhere}
    .m{font:500 11px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#4a6057}
    .err{padding:8px 10px;border:1px solid #b8371f;border-radius:6px;color:#b8371f;font-size:12.5px}
    label{display:grid;gap:4px;font-size:12px;color:#4a6057}
    select{font:inherit;height:32px;border:1px solid rgba(16,40,30,.18);border-radius:6px;background:#fff;padding:0 6px;max-width:100%}
    .row{display:flex;gap:8px;flex-wrap:wrap}
    .btn{white-space:nowrap;font:500 13px/1 inherit;font-family:inherit;height:34px;padding:0 12px;border-radius:6px;border:1px solid rgba(16,40,30,.18);background:#fff;cursor:pointer;color:#10221b}
    .btn.pr{background:#a96400;border-color:#a96400;color:#fff8ea;flex:1}
    .btn:focus-visible,select:focus-visible{outline:2px solid #a96400;outline-offset:2px}
    .ok-msg{font-size:12.5px;color:#1f7a3f;min-height:1em}
  </style>
  <div class="p" role="dialog" aria-label="Раскрой">
    <div class="h"><b>Раск<span>рой</span></b><button class="x" title="Закрыть" aria-label="Закрыть">×</button></div>
    <div class="b"><ul id="steps"></ul><div id="out"></div></div>
  </div>`;
  document.body.append(host);
  const $ = (s) => root.querySelector(s);
  $(".x").onclick = () => (host.style.display = "none");
  const api = { show: () => (host.style.display = "") };
  window.__raskroy = api;

  const steps = $("#steps");
  const step = (text) => {
    steps.querySelectorAll("li.now").forEach((li) => { li.className = "ok"; });
    const li = document.createElement("li"); li.className = "now";
    li.innerHTML = "<i></i><span></span>"; li.querySelector("span").textContent = text; steps.append(li);
    return (detail) => { li.querySelector("span").textContent = detail ? `${text} · ${detail}` : text; };
  };
  const fail = (msg) => {
    steps.querySelectorAll("li.now").forEach((li) => (li.className = ""));
    const d = document.createElement("div"); d.className = "err"; d.textContent = msg; $("#out").replaceChildren(d);
    window.__raskroy = null;
  };

  if (!fileKey) { fail("Откройте макет Pixso (адрес вида …/app/design/…) и нажмите закладку ещё раз."); return; }

  // ---------------------------------------------------------------- загрузка
  const u8 = (s) => new TextEncoder().encode(s);
  function fileInit(version) {
    const json = JSON.stringify({ is_initial: true, is_reconnect: false, access: "LoadAll", check_schema_version: true, schema_version: version });
    // PixsoMsg{type:5, signalName:"FileInit", signalPayload:json, cmdNum:{0,0}} в формате Kiwi
    const parts = [Uint8Array.of(0x01, 0x05, 0x0e), u8("FileInit"), Uint8Array.of(0, 0x0f), u8(json), Uint8Array.of(0, 0x12, 0, 0, 0)];
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));

  async function getToken() {
    const r = await fetch(`/api/pix/file/${fileKey}/access`, { credentials: "include", headers: { "Px-Referer": location.href, "X-Lang": navigator.language || "ru-RU" } });
    let j = null; try { j = await r.json(); } catch (_) {}
    const t = j && j.data && j.data.token;
    if (!t) throw new Error(`Pixso не выдал доступ к файлу (HTTP ${r.status}${j && j.msg ? ", " + j.msg : ""}). Проверьте, что вы вошли в Pixso и файл открывается.`);
    return t;
  }
  function getDocument(token) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws/coop?file_key=${encodeURIComponent(fileKey)}&conn_id=${uuid()}&conn_param=${encodeURIComponent(btoa(token))}`);
      ws.binaryType = "arraybuffer";
      let sent = false;
      const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error("Pixso не прислал документ за 90 секунд. Попробуйте ещё раз или снимите HAR.")); }, 90000);
      ws.onmessage = (e) => {
        const isText = typeof e.data === "string";
        const b = isText ? null : new Uint8Array(e.data);
        const head = isText ? e.data.slice(0, 400) : new TextDecoder().decode(b.subarray(0, Math.min(400, b.length)));
        if (isText && (sent || !head.includes("schema_version"))) return;
        if (!sent) {
          const v = (head.match(/"schema_version":"([^"]+)"/) || [])[1] || "v9.99";
          ws.send(fileInit(v)); sent = true; return;
        }
        if (head.startsWith("pixso-kw")) { clearTimeout(timer); try { ws.close(1000); } catch (_) {} resolve(b); }
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("Не удалось подключиться к Pixso по WebSocket.")); };
      ws.onclose = (e) => { if (!sent || e.code !== 1000) { clearTimeout(timer); reject(new Error(`Соединение закрылось до получения документа (код ${e.code}).`)); } };
    });
  }

  let scene = null, schemaBytes = null, docBytes = null, pages = [];
  (async () => {
    try {
      let s = step("Доступ к файлу"); const token = await getToken(); s("получен");
      s = step("Схема Pixso");
      const sr = await fetch(`/app/pixso.binary?t=${Date.now()}`, { credentials: "include" });
      if (!sr.ok) throw new Error(`Не удалось скачать схему (HTTP ${sr.status}).`);
      schemaBytes = new Uint8Array(await sr.arrayBuffer()); s(`${(schemaBytes.length / 1024).toFixed(0)} КБ`);
      s = step("Документ");
      docBytes = await getDocument(token); s(`${(docBytes.length / 1048576).toFixed(1)} МБ`);
      const d = step("Раскраиваю");
      await new Promise((r) => setTimeout(r, 30));
      const r = CORE.decodeDocument(schemaBytes, docBytes);
      scene = r.scene; pages = scene.pages();
      d(`${r.meta.nodes.toLocaleString("ru-RU")} слоёв`);
      steps.querySelectorAll("li.now").forEach((li) => (li.className = "ok"));
      ready();
    } catch (err) { fail(String(err.message || err)); }
  })();

  // ---------------------------------------------------------------- результат
  const currentId = () => { const q = new URLSearchParams(location.search); const v = q.get("item-id") || q.get("node-id"); return v ? v.replace("-", ":") : null; };
  function ready() {
    const out = $("#out");
    out.innerHTML = `<label>Фрейм<select id="sel"></select></label>
      <div class="m" id="info"></div>
      <div class="row"><button class="btn pr" id="copy">Копировать для ГигаКода</button><button class="btn" id="pack" title="Файл для приложения «Раскрой»: все фреймы, превью, слои">Пакет .raskroy</button></div>
      <div class="ok-msg" id="msg" role="status"></div>`;
    const sel = $("#sel");
    const fill = () => {
      const cur = currentId();
      sel.replaceChildren();
      if (cur && scene.nodes.has(cur) && !pages.some((p) => p.frames.some((f) => f.id === cur))) {
        const n = scene.nodes.get(cur); const o = document.createElement("option");
        o.value = cur; o.textContent = `Выделенный: ${n.name || n.type}`; sel.append(o);
      }
      for (const p of pages) {
        const g = document.createElement("optgroup"); g.label = p.name;
        for (const f of p.frames) { const o = document.createElement("option"); o.value = f.id; o.textContent = `${f.depth ? "  " : ""}${f.name} — ${f.w}×${f.h}`; g.append(o); }
        sel.append(g);
      }
      if (cur && scene.nodes.has(cur)) sel.value = cur;
      info();
    };
    const info = () => {
      const n = scene.nodes.get(sel.value);
      $("#info").textContent = n ? `${sel.value} · ${scene.crumbs(sel.value).join(" / ")}` : "";
    };
    sel.onchange = info;
    let lastUrl = location.href;
    setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; const c = currentId(); if (c && scene.nodes.has(c)) fill(); } }, 800);
    fill();
    const msg = (t, bad) => { const m = $("#msg"); m.textContent = t; m.style.color = bad ? "#b8371f" : "#1f7a3f"; };
    $("#copy").onclick = () => {
      try {
        const { tree } = CORE.buildFrame(scene, sel.value);
        const md = CORE.markdown(tree, { crumbs: scene.crumbs(sel.value), source: location.origin + location.pathname + "?item-id=" + sel.value });
        const done = () => msg(`Скопировано: ${(md.length / 1024).toFixed(1)} КБ, ${md.split("\n").length} строк. Вставьте в ГигаКод.`);
        const fallback = () => { const ta = document.createElement("textarea"); ta.value = md; ta.style.cssText = "position:fixed;left:-9999px"; root.append(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove(); ok ? done() : msg("Браузер не дал скопировать. Используйте «Пакет .raskroy».", true); };
        navigator.clipboard ? navigator.clipboard.writeText(md).then(done, fallback) : fallback();
      } catch (err) { msg(String(err.message || err), true); }
    };
    $("#pack").onclick = () => {
      const b64 = (u) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
      const pack = JSON.stringify({ format: "raskroy-pack", v: 1, url: location.origin + location.pathname + "?item-id=" + sel.value, schema: b64(schemaBytes), doc: b64(docBytes) });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([pack], { type: "application/json" }));
      a.download = `${fileKey}.raskroy`; root.append(a); a.click(); a.remove();
      msg("Пакет сохранён. Перетащите его в Раскрой — там превью, слои и все фреймы.");
    };
  }
})();
