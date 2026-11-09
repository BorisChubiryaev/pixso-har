// Web Worker: держит раскодированную сцену и собирает фреймы по запросу.
let state = null;
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      state = null;
      const r = await CORE.loadHar(new Uint8Array(m.buffer), (stage, detail) => self.postMessage({ type: "progress", stage, detail }));
      state = r;
      const pages = r.scene.pages();
      let def = null;
      try {
        const q = r.pageUrl ? new URL(r.pageUrl).searchParams : null;
        def = q && (q.get("item-id") || q.get("node-id"));
        if (def) def = def.replace("-", ":");
      } catch (_) { def = null; }
      if (!def || !r.scene.nodes.has(def)) def = pages.find((p) => p.frames.length)?.frames[0]?.id || null;
      self.postMessage({ type: "ready", pages, meta: r.meta, pageUrl: r.pageUrl, innerName: r.fileName, defaultId: def });
    } else if (m.type === "build") {
      if (!state) throw new Error("Документ ещё не загружен");
      const { tree, usedImages } = CORE.buildFrame(state.scene, m.id, m.opts);
      const crumbs = state.scene.crumbs(m.id);
      const md = CORE.markdown(tree, { crumbs, source: state.pageUrl });
      const images = {};
      for (const h of usedImages) if (state.images[h]) images[h] = state.images[h];
      self.postMessage({ type: "frame", req: m.req, id: m.id, tree, md, images, crumbs });
    }
  } catch (err) {
    self.postMessage({ type: "error", req: m.req, during: m.type, message: String((err && err.message) || err) });
  }
};
