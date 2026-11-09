// Пример фрейма для первого экрана (вымышленные данные), в том же формате, что выдаёт CORE.buildFrame.
const DEMO = (() => {
  let seq = 0;
  const id = () => `demo:${++seq}`;
  const text = (name, s, x, y, w, h, family, style, size, lh, color, extra = {}) => ({
    type: "TEXT", name, id: id(), x, y, w, h, text: s,
    textStyle_: Object.assign({ font: `${family} ${style}`, family, weight: { Regular: 400, Medium: 500, Semibold: 600 }[style], size, lineHeight: lh, color, autoResize: "width_and_height" }, extra.st || {}),
    ...(extra.o || {}),
  });
  const T = "SB Sans Text", D = "SB Sans Display";
  const ink = "#13211B", soft = "#5D6E66", faint = "#8FA39A", line = "#DDE6E1";

  const chip = (label, x, w, selected) => ({
    type: "INSTANCE", name: "Chip", id: id(), component: `Chip 36 / ${selected ? "Selected" : "Default"}`,
    x, y: 0, w, h: 36, fill: [selected ? ink : "#FFFFFF"], radius: 18,
    ...(selected ? {} : { stroke: { color: ["#D3DDD8"], weight: 1, align: "inside" } }),
    layout: { dir: "row", gap: 6, padding: [9, 16, 9, 16], align: "center", sizing: { main: "resize_to_fit", cross: "fixed" } },
    children: [text("Label", label, 16, 9, w - 32, 18, T, "Medium", 14, 18, selected ? "#FFFFFF" : ink)],
  });
  const badge = (label, bg, fg, w) => ({
    type: "INSTANCE", name: "Status", id: id(), component: `Badge 24 / ${label}`, x: 680, y: 30, w, h: 24, fill: [bg], radius: 12,
    layout: { dir: "row", gap: 0, padding: [3, 10, 3, 10], align: "center", sizing: { main: "resize_to_fit", cross: "resize_to_fit" } },
    children: [text("Label", label, 10, 3, w - 20, 18, T, "Medium", 12, 18, fg)],
  });
  const STATUS = { wait: ["На согласовании", "#FCEBC4", "#7A5000", 136], ok: ["Выдан", "#D9F2DF", "#1D7A37", 64], no: ["Отклонён", "#FADBD5", "#A33622", 84] };
  const rows = [
    ["Анна Смирнова", "Аналитик · Москва", "Jira", "Просмотр проектов", "wait", "до 14.11.2026", "#3F8E6B"],
    ["Олег Ким", "Разработчик · Казань", "GitLab", "Maintainer", "ok", "до 30.11.2026", "#5866C4"],
    ["Мария Гусева", "Дизайнер · Москва", "Pixso", "Редактор файлов", "ok", "бессрочно", "#C2577A"],
    ["Тимур Алиев", "DevOps · Новосибирск", "Grafana", "Администратор", "no", "—", "#B07A1F"],
    ["Ксения Орлова", "Тестировщик · Самара", "Confluence", "Чтение", "wait", "до 21.11.2026", "#2F7FA3"],
  ];
  const tableRows = rows.map(([name, sub, sys, role, st, date, av], i) => {
    const initials = name.split(" ").map((p) => p[0]).join("");
    const [label, bg, fg, bw] = STATUS[st];
    return {
      type: "FRAME", name: "Row", id: id(), x: 0, y: 44 + i * 84, w: 976, h: 84,
      stroke: { color: [line], weight: 1, align: "inside", sides: [1, 0, 0, 0] },
      children: [
        { type: "ELLIPSE", name: "Avatar", id: id(), x: 20, y: 22, w: 40, h: 40, fill: [av] },
        text("Initials", initials, 20, 33, 40, 18, T, "Semibold", 14, 18, "#FFFFFF", { st: { align: "center", autoResize: "none" } }),
        text("Name", name, 72, 22, 190, 20, T, "Semibold", 15, 20, ink),
        text("Caption", sub, 72, 44, 190, 16, T, "Regular", 13, 16, soft),
        text("System", sys, 280, 32, 150, 20, T, "Regular", 14, 20, ink),
        text("Role", role, 460, 32, 200, 20, T, "Regular", 14, 20, ink),
        badge(label, bg, fg, bw),
        text("Due", date, 856, 32, 100, 20, T, "Regular", 14, 20, soft),
      ],
    };
  });
  const headers = [["Сотрудник", 20], ["Система", 280], ["Роль", 460], ["Статус", 680], ["Срок", 856]].map(([s, x]) =>
    text("Header", s.toUpperCase(), x, 14, 120, 16, T, "Medium", 11, 16, soft, { st: { letterSpacing: "6%", case: "upper" } }));

  const tree = {
    type: "FRAME", name: "Заявки на доступ", id: "demo:root", x: 0, y: 0, w: 1040, h: 660,
    fill: ["#F3F6F4"], fillStyle: "Surfaces/Solid/surfacePrimary",
    layout: { dir: "column", gap: 24, padding: [32, 32, 32, 32], sizing: { main: "fixed", cross: "fixed" } },
    children: [
      {
        type: "FRAME", name: "Header", id: id(), x: 32, y: 32, w: 976, h: 44,
        layout: { dir: "row", gap: 16, justify: "space_between", align: "center", sizing: { main: "fixed", cross: "resize_to_fit" } },
        children: [
          {
            type: "FRAME", name: "Title", id: id(), x: 0, y: 0, w: 400, h: 44,
            layout: { dir: "column", gap: 2, sizing: { main: "resize_to_fit", cross: "fixed" } },
            children: [
              text("H1", "Заявки на доступ", 0, 0, 300, 28, D, "Semibold", 22, 28, ink, { o: { textStyle: "Header/H3" } }),
              text("Caption", "Отдел платформы · 24 заявки за ноябрь", 0, 28, 320, 16, T, "Regular", 13, 16, soft),
            ],
          },
          {
            type: "INSTANCE", name: "Button", id: id(), component: "Button 44 / Accent / IconLeft", x: 804, y: 0, w: 172, h: 44,
            fill: ["#21A038"], fillStyle: "Accent/accentPrimary", radius: 12,
            layout: { dir: "row", gap: 8, padding: [10, 18, 10, 14], align: "center", sizing: { main: "resize_to_fit", cross: "fixed" } },
            children: [
              { type: "INSTANCE", name: "Icon", id: id(), component: "24 / Plus", x: 14, y: 10, w: 24, h: 24, children: [
                { type: "VECTOR", name: "icon", id: id(), x: 5, y: 5, w: 14, h: 14, fill: ["#FFFFFF"], paths: [{ d: "M6 0h2v6h6v2H8v6H6V8H0V6h6z", rule: "nonzero" }] },
              ] },
              text("Label", "Новая заявка", 46, 13, 108, 18, T, "Medium", 14, 18, "#FFFFFF"),
            ],
          },
        ],
      },
      {
        type: "FRAME", name: "Filters", id: id(), x: 32, y: 100, w: 976, h: 36,
        layout: { dir: "row", gap: 8, sizing: { main: "fixed", cross: "resize_to_fit" } },
        children: [
          chip("Все · 24", 0, 92, true),
          chip("На согласовании · 7", 100, 182, false),
          chip("Выданы · 15", 290, 118, false),
          chip("Отклонены · 2", 416, 132, false),
          {
            type: "INSTANCE", name: "Search", id: id(), component: "Input 36 / Search", x: 736, y: 0, w: 240, h: 36, child: { absolute: true },
            fill: ["#FFFFFF"], radius: 10, stroke: { color: ["#D3DDD8"], weight: 1, align: "inside" },
            layout: { dir: "row", gap: 8, padding: [6, 12, 6, 10], align: "center", sizing: { main: "fixed", cross: "fixed" } },
            children: [
              { type: "VECTOR", name: "search", id: id(), x: 13, y: 11, w: 15, h: 15, fill: [faint], paths: [{ d: "M6.5 0a6.5 6.5 0 0 1 5.17 10.44l3.2 3.2-1.23 1.23-3.2-3.2A6.5 6.5 0 1 1 6.5 0zm0 1.75a4.75 4.75 0 1 0 0 9.5 4.75 4.75 0 0 0 0-9.5z", rule: "nonzero" }] },
              text("Placeholder", "Сотрудник или система", 36, 9, 180, 18, T, "Regular", 14, 18, faint),
            ],
          },
        ],
      },
      {
        type: "FRAME", name: "Table", id: id(), x: 32, y: 160, w: 976, h: 468, clip: true,
        fill: ["#FFFFFF"], fillStyle: "Surfaces/Solid/surfaceCard", radius: 16,
        stroke: { color: [line], weight: 1, align: "inside" }, shadow: ["0 1 2 0 #13211B14"],
        layout: { dir: "column", gap: 0, sizing: { main: "resize_to_fit", cross: "fixed" } },
        children: [{ type: "FRAME", name: "Head", id: id(), x: 0, y: 0, w: 976, h: 44, fill: ["#F7FAF8"], children: headers }, ...tableRows],
      },
    ],
  };
  return {
    tree,
    pages: [{ id: "demo", name: "Пример", frames: [{ id: "demo:root", name: "Заявки на доступ", type: "FRAME", w: 1040, h: 660, depth: 0 }] }],
    crumbs: ["Пример"],
  };
})();
