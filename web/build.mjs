// Собирает web/src/* в один самодостаточный HTML-файл.
//   node web/build.mjs            → web/raskroy.html (открывается двойным кликом, работает офлайн)
//   node web/build.mjs --body X   → дополнительно X без <!doctype>/<html>/<head> (для публикации как Artifact)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(dir, "src", f), "utf8");
const parts = { CSS: src("app.css"), ZSTD: src("zstd.js"), CORE: src("core.js"), WORKER: src("worker-main.js"), DEMO: src("demo.js"), APP: src("app.js") };
for (const [k, v] of Object.entries(parts)) if (k !== "CSS" && /<\/script/i.test(v)) throw new Error(`${k}: содержит </script>`);

let body = src("shell.html");
for (const [k, v] of Object.entries(parts)) body = body.replace(`/*@@${k}@@*/`, () => v);

const full = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${body}
</body>
</html>
`;
writeFileSync(join(dir, "raskroy.html"), full);
const i = process.argv.indexOf("--body");
if (i > 0) writeFileSync(process.argv[i + 1], body);
console.log(`raskroy.html: ${(full.length / 1024).toFixed(1)} КБ`);
