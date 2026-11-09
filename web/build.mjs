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
parts.GRAB = src("grab.js");

// закладка: zstd + core + grab в одной функции; лёгкое сжатие (убираем отступы и строчные комментарии)
const lite = (code) => code.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")).join("\n");
const grabCode = lite(`(()=>{\n${parts.ZSTD}\n${parts.CORE}\n${src("grab.js")}\n})();`);
const bookmarklet = "javascript:" + grabCode.replace(/%/g, "%25").replace(/\n/g, "%0A").replace(/#/g, "%23").replace(/"/g, "%22");
parts.BOOKMARKLET = bookmarklet.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
parts.SNIPPET = grabCode.replace(/<\/script/gi, "<\\/script");
writeFileSync(join(dir, "raskroy-grab.js"), grabCode + "\n");

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
console.log(`raskroy.html: ${(full.length / 1024).toFixed(1)} КБ · закладка ${(bookmarklet.length / 1024).toFixed(1)} КБ`);
