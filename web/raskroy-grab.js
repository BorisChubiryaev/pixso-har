(()=>{
const ZSTD = (() => {
const hb = (x) => 31 - Math.clz32(x); // индекс старшего бита
function peek(buf, base, off, n) {
if (n === 0) return 0;
const i = base + (off >>> 3);
const v = (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24)) >>> (off & 7);
return v & ((1 << n) - 1);
}
class BackReader {
constructor(buf, start, end) {
this.buf = buf; this.base = start;
const last = buf[end - 1];
if (!last) throw new Error("zstd: пустой маркер потока");
this.off = (end - start - 1) * 8 + hb(last);
}
read(n) {
if (n === 0) return 0;
if (n > 24) { const hi = this.read(n - 16); return hi * 65536 + this.read(16); }
this.off -= n;
if (this.off >= 0) return peek(this.buf, this.base, this.off, n);
if (this.off > -n) return peek(this.buf, this.base, 0, n + this.off) << -this.off;
return 0;
}
}
function readFseHeader(buf, start, maxAL) {
let off = 0;
const AL = peek(buf, start, off, 4) + 5; off += 4;
if (AL > maxAL) throw new Error("zstd: слишком большой accuracy log");
let remaining = 1 << AL;
const freqs = [];
while (remaining > 0 && freqs.length < 256) {
const bits = hb(remaining + 1) + 1;
let val = peek(buf, start, off, bits);
const lower = (1 << (bits - 1)) - 1;
const threshold = (1 << bits) - 1 - (remaining + 1);
if ((val & lower) < threshold) { off += bits - 1; val &= lower; }
else if (val > lower) { off += bits; val -= threshold; }
else off += bits;
const p = val - 1;
remaining -= p < 0 ? -p : p;
freqs.push(p);
if (p === 0) {
let rep = peek(buf, start, off, 2); off += 2;
for (;;) {
for (let i = 0; i < rep; i++) freqs.push(0);
if (rep === 3) { rep = peek(buf, start, off, 2); off += 2; } else break;
}
}
}
if (remaining !== 0) throw new Error("zstd: битая FSE-таблица");
return { table: buildFse(freqs, AL), size: (off + 7) >>> 3 };
}
function buildFse(freqs, AL) {
const size = 1 << AL;
const sym = new Uint8Array(size), nb = new Uint8Array(size), base = new Uint16Array(size);
const next = new Uint16Array(freqs.length);
let high = size;
for (let s = 0; s < freqs.length; s++) if (freqs[s] === -1) { sym[--high] = s; next[s] = 1; }
const step = (size >>> 1) + (size >>> 3) + 3, mask = size - 1;
let pos = 0;
for (let s = 0; s < freqs.length; s++) {
if (freqs[s] <= 0) continue;
next[s] = freqs[s];
for (let i = 0; i < freqs[s]; i++) {
sym[pos] = s;
do { pos = (pos + step) & mask; } while (pos >= high);
}
}
for (let i = 0; i < size; i++) {
const s = sym[i], n = next[s]++;
nb[i] = AL - hb(n);
base[i] = (n << nb[i]) - size;
}
return { AL, sym, nb, base };
}
const rleTable = (s) => ({ AL: 0, sym: Uint8Array.of(s), nb: Uint8Array.of(0), base: Uint16Array.of(0) });
const LL_DEF = buildFse([4,3,2,2,2,2,2,2,2,2,2,2,2,1,1,1,2,2,2,2,2,2,2,2,2,3,2,1,1,1,1,1,-1,-1,-1,-1], 6);
const ML_DEF = buildFse([1,4,3,2,2,2,2,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,-1,-1,-1,-1,-1,-1,-1], 6);
const OF_DEF = buildFse([1,1,1,1,1,1,2,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,-1,-1,-1,-1,-1], 5);
const LL_BASE = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,18,20,22,24,28,32,40,48,64,128,256,512,1024,2048,4096,8192,16384,32768,65536];
const LL_BITS = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,2,2,3,3,4,6,7,8,9,10,11,12,13,14,15,16];
const ML_BASE = []; const ML_BITS = [];
for (let i = 0; i < 32; i++) { ML_BASE.push(i + 3); ML_BITS.push(0); }
[[35,1],[37,1],[39,1],[41,1],[43,2],[47,2],[51,3],[59,3],[67,4],[83,4],[99,5],[131,7],[259,8],[515,9],[1027,10],[2051,11],[4099,12],[8195,13],[16387,14],[32771,15],[65539,16]]
.forEach(([b, n]) => { ML_BASE.push(b); ML_BITS.push(n); });
function readHuffTable(buf, p) {
const h = buf[p++];
let weights;
if (h < 128) {
const { table, size } = readFseHeader(buf, p, 6);
const r = new BackReader(buf, p + size, p + h);
weights = [];
let s1 = r.read(table.AL), s2 = r.read(table.AL);
for (;;) {
weights.push(table.sym[s1]); s1 = table.base[s1] + r.read(table.nb[s1]);
if (r.off < 0) { weights.push(table.sym[s2]); break; }
weights.push(table.sym[s2]); s2 = table.base[s2] + r.read(table.nb[s2]);
if (r.off < 0) { weights.push(table.sym[s1]); break; }
if (weights.length > 255) throw new Error("zstd: слишком много весов Huffman");
}
p += h;
} else {
const n = h - 127; weights = new Array(n);
for (let i = 0; i < n; i++) weights[i] = i & 1 ? buf[p + (i >> 1)] & 15 : buf[p + (i >> 1)] >> 4;
p += (n + 1) >> 1;
}
let sum = 0;
for (const w of weights) if (w > 0) sum += 1 << (w - 1);
const maxBits = hb(sum) + 1;
const left = (1 << maxBits) - sum;
weights.push(hb(left) + 1);
const size = 1 << maxBits;
const sym = new Uint8Array(size), nbits = new Uint8Array(size);
const bits = weights.map((w) => (w > 0 ? maxBits + 1 - w : 0));
const count = new Array(maxBits + 2).fill(0);
bits.forEach((b) => count[b]++);
const idx = new Array(maxBits + 2).fill(0);
idx[maxBits] = 0;
for (let i = maxBits; i >= 1; i--) {
idx[i - 1] = idx[i] + count[i] * (1 << (maxBits - i));
nbits.fill(i, idx[i], idx[i - 1]);
}
for (let s = 0; s < bits.length; s++) {
if (!bits[s]) continue;
const len = 1 << (maxBits - bits[s]);
sym.fill(s, idx[bits[s]], idx[bits[s]] + len);
idx[bits[s]] += len;
}
return { pos: p, huf: { maxBits, sym, nbits } };
}
function huffStream(buf, start, end, huf, out, op, n) {
const r = new BackReader(buf, start, end);
const { maxBits, sym, nbits } = huf, mask = (1 << maxBits) - 1;
let state = r.read(maxBits);
for (let i = 0; i < n; i++) {
out[op + i] = sym[state];
const b = nbits[state];
state = ((state << b) | r.read(b)) & mask;
}
}
function decompress(src) {
let out = new Uint8Array(Math.max(1 << 16, src.length * 8)), op = 0;
const ensure = (n) => {
if (op + n <= out.length) return;
let len = out.length * 2; while (len < op + n) len *= 2;
const o = new Uint8Array(len); o.set(out.subarray(0, op)); out = o;
};
const u32 = (p) => (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0;
let ip = 0;
while (ip + 4 <= src.length) {
const magic = u32(ip); ip += 4;
if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) { ip += 4 + u32(ip); continue; }
if (magic !== 0xfd2fb528) throw new Error("zstd: неверная сигнатура кадра");
const fhd = src[ip++];
const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
if (!single) ip++;
if (dictFlag) throw new Error("zstd: словари не поддерживаются");
const fcsSize = fcsFlag === 0 ? single : [1, 2, 4, 8][fcsFlag];
if (fcsSize) {
let fcs = 0;
for (let i = fcsSize - 1; i >= 0; i--) fcs = fcs * 256 + src[ip + i];
if (fcsSize === 2) fcs += 256;
if (fcs < 2 ** 31) ensure(fcs);
}
ip += fcsSize;
const st = { rep: [1, 4, 8], huf: null, ll: null, of: null, ml: null };
let last = 0;
while (!last) {
const bh = src[ip] | (src[ip + 1] << 8) | (src[ip + 2] << 16); ip += 3;
last = bh & 1;
const type = (bh >> 1) & 3, size = bh >>> 3;
if (type === 0) { ensure(size); out.set(src.subarray(ip, ip + size), op); op += size; ip += size; }
else if (type === 1) { ensure(size); out.fill(src[ip], op, op + size); op += size; ip += 1; }
else if (type === 2) { block(ip, ip + size, st); ip += size; }
else throw new Error("zstd: зарезервированный тип блока");
}
if (checksum) ip += 4;
}
return out.subarray(0, op);
function block(p, end, st) {
const b0 = src[p], ltype = b0 & 3, sf = (b0 >> 2) & 3;
let lit;
if (ltype < 2) {
let regen, hs;
if (sf === 0 || sf === 2) { regen = b0 >> 3; hs = 1; }
else if (sf === 1) { regen = (b0 >> 4) + (src[p + 1] << 4); hs = 2; }
else { regen = (b0 >> 4) + (src[p + 1] << 4) + (src[p + 2] << 12); hs = 3; }
p += hs;
if (ltype === 0) { lit = src.subarray(p, p + regen); p += regen; }
else { lit = new Uint8Array(regen).fill(src[p]); p += 1; }
} else {
let regen, comp, hs, streams;
if (sf < 2) {
streams = sf === 0 ? 1 : 4; hs = 3;
const h = b0 | (src[p + 1] << 8) | (src[p + 2] << 16);
regen = (h >> 4) & 0x3ff; comp = (h >> 14) & 0x3ff;
} else {
streams = 4; hs = sf === 2 ? 4 : 5;
const h = (b0 | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0;
if (sf === 2) { regen = (h >>> 4) & 0x3fff; comp = (h >>> 18) & 0x3fff; }
else { regen = (h >>> 4) & 0x3ffff; comp = ((h >>> 22) | (src[p + 4] << 10)) & 0x3ffff; }
}
p += hs;
const lend = p + comp;
let q = p;
if (ltype === 2) { const r = readHuffTable(src, q); q = r.pos; st.huf = r.huf; }
if (!st.huf) throw new Error("zstd: нет таблицы Huffman");
lit = new Uint8Array(regen);
if (streams === 1) huffStream(src, q, lend, st.huf, lit, 0, regen);
else {
const s1 = src[q] | (src[q + 1] << 8), s2 = src[q + 2] | (src[q + 3] << 8), s3 = src[q + 4] | (src[q + 5] << 8);
q += 6;
const seg = (regen + 3) >> 2;
const a = q, b = a + s1, c = b + s2, d = c + s3;
huffStream(src, a, b, st.huf, lit, 0, seg);
huffStream(src, b, c, st.huf, lit, seg, seg);
huffStream(src, c, d, st.huf, lit, seg * 2, seg);
huffStream(src, d, lend, st.huf, lit, seg * 3, regen - seg * 3);
}
p = lend;
}
let nseq = src[p++];
if (nseq >= 128) {
if (nseq < 255) nseq = ((nseq - 128) << 8) + src[p++];
else { nseq = src[p] + (src[p + 1] << 8) + 0x7f00; p += 2; }
}
if (nseq === 0) { ensure(lit.length); out.set(lit, op); op += lit.length; return; }
const modes = src[p++];
const pick = (mode, def, maxAL, key) => {
if (mode === 0) st[key] = def;
else if (mode === 1) st[key] = rleTable(src[p++]);
else if (mode === 2) { const r = readFseHeader(src, p, maxAL); st[key] = r.table; p += r.size; }
else if (!st[key]) throw new Error("zstd: повтор несуществующей таблицы");
};
pick(modes >> 6, LL_DEF, 9, "ll");
pick((modes >> 4) & 3, OF_DEF, 8, "of");
pick((modes >> 2) & 3, ML_DEF, 9, "ml");
const LL = st.ll, OF = st.of, ML = st.ml, rep = st.rep;
const r = new BackReader(src, p, end);
let ls = r.read(LL.AL), os = r.read(OF.AL), ms = r.read(ML.AL);
let lp = 0;
for (let i = 0; i < nseq; i++) {
const oc = OF.sym[os], lc = LL.sym[ls], mc = ML.sym[ms];
const ov = 2 ** oc + r.read(oc);
const ml = ML_BASE[mc] + r.read(ML_BITS[mc]);
const ll = LL_BASE[lc] + r.read(LL_BITS[lc]);
let off;
if (ov > 3) { off = ov - 3; rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = off; }
else {
let idx = ov - 1; if (ll === 0) idx++;
if (idx === 0) off = rep[0];
else {
off = idx < 3 ? rep[idx] : rep[0] - 1;
if (idx > 1) rep[2] = rep[1];
rep[1] = rep[0]; rep[0] = off;
}
}
if (i < nseq - 1) {
ls = LL.base[ls] + r.read(LL.nb[ls]);
ms = ML.base[ms] + r.read(ML.nb[ms]);
os = OF.base[os] + r.read(OF.nb[os]);
}
ensure(ll + ml);
out.set(lit.subarray(lp, lp + ll), op); op += ll; lp += ll;
if (off > op) throw new Error("zstd: ссылка за пределы окна");
let from = op - off;
if (off >= ml) { out.copyWithin(op, from, from + ml); op += ml; }
else for (let k = 0; k < ml; k++) out[op++] = out[from++];
}
const rest = lit.length - lp;
ensure(rest); out.set(lit.subarray(lp), op); op += rest;
}
}
return { decompress };
})();
const CORE = (() => {
const utf8 = new TextDecoder();
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
for (const c of scene.children(gid(n.guid))) { const r = build(c, ctx, prefix, depth + 1, props); if (r) kids.push(r); }
}
if (kids.length) out.children = kids;
return out;
}
}
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
(() => {
if (window.__raskroy) { window.__raskroy.show(); return; }
const fileKey = (location.pathname.match(/\/app\/design\/([^/?#]+)/) || [])[1];
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
const u8 = (s) => new TextEncoder().encode(s);
function fileInit(version) {
const json = JSON.stringify({ is_initial: true, is_reconnect: false, access: "LoadAll", check_schema_version: true, schema_version: version });
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
})();
