// Минимальный декодер Zstandard (RFC 8878) без зависимостей.
// Поддерживает всё, что нужно для документа Pixso: raw/RLE/compressed блоки,
// Huffman-литералы (1 и 4 потока, treeless), FSE-последовательности (predefined/RLE/compressed/repeat).
// Не поддерживает словари. Контрольную сумму пропускает.

const ZSTD = (() => {
  const hb = (x) => 31 - Math.clz32(x); // индекс старшего бита

  // Чтение n (<=24) бит, начиная с бита off (little-endian, бит 0 — младший бит первого байта)
  function peek(buf, base, off, n) {
    if (n === 0) return 0;
    const i = base + (off >>> 3);
    const v = (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24)) >>> (off & 7);
    return v & ((1 << n) - 1);
  }

  // Обратный битовый поток (FSE / Huffman): читаем от конца к началу
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

  // ---------- FSE
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

  // ---------- Huffman
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

  // ---------- распаковка
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
      // --- литералы
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
      // --- последовательности
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
