/* fountain.js — Phase 1 payload framing: LT droplet carousels per ring.
   The three walks characterized the channel precisely: an ERASURE channel
   (honest erasures everywhere, low residual confident-error rate) received
   in arbitrary capture windows. That is the fountain code's home turf.

   Layout per ring: [preamble] then droplets c = 0..L−1 cycled forever
   (period L·D symbols; D = droplet_bits / log2(M) symbols). Droplet 0 is
   the HEADER (magic, K, and — when capacity allows — payload length +
   CRC16); droplets 1..L−1 are LT droplets: XOR of a pseudo-random subset
   of the K payload blocks, subset derived from (ring seed, c) — both ends
   share the profile, so the wire carries no subset descriptions. Every
   droplet ends in CRC8 over (c || data): residual symbol ERRORS become
   erasures (a poisoned XOR would corrupt the peel), and the CRC doubles as
   the ALIGNMENT signal — scan candidate lags within one carousel period
   and the true lag lights up with CRC passes. No reference stream needed:
   sync in payload mode never requires knowing the payload.
   All rings carry the SAME blocks with ring-distinct subsets; one peeling
   decoder pools every verified droplet from every ring (and, later, every
   tile). Bits→symbol mapping is Gray (adjacent phase error = 1 bit). */
(function (global) {
  "use strict";

  function P() { return (typeof module !== "undefined" && module.exports) ? require("./prng.js") : global.OC.prng; }

  var MAGIC = 0xA7;

  function crc8(bytes, n) {
    var c = 0;
    for (var i = 0; i < n; i++) {
      c ^= bytes[i];
      for (var b = 0; b < 8; b++) c = (c & 0x80) ? (((c << 1) ^ 0x07) & 0xFF) : ((c << 1) & 0xFF);
    }
    return c;
  }

  function crc16(bytes) {
    var c = 0xFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c ^= bytes[i] << 8;
      for (var b = 0; b < 8; b++) c = (c & 0x8000) ? (((c << 1) ^ 0x1021) & 0xFFFF) : ((c << 1) & 0xFFFF);
    }
    return c;
  }

  function toGray(n) { return n ^ (n >> 1); }
  function fromGray(g) { var n = 0; while (g) { n ^= g; g >>= 1; } return n; }

  function log2M(M) { return M === 4 ? 2 : M === 8 ? 3 : M === 16 ? 4 : Math.round(Math.log(M) / Math.LN2); }

  /* Droplet geometry. droplet_bits must be divisible by 12 so every
     constellation (2/3/4 bits per symbol) gets an integer symbol count.
     Production default 48 (40 data + 8 CRC); tests may shrink to 24. */
  function geom(profile) {
    var db = (profile.carriage && profile.carriage.droplet_bits) || 48;
    return { dropletBits: db, dataBits: db - 8, dataBytes: (db - 8) / 8 };
  }
  function ringD(annulus, g) { return g.dropletBits / log2M(annulus.rotation.M); }
  // A capture window is short; the header must RECUR or mid-loop assembly
  // would wait a whole carousel (~minutes on the base ring). Every 8th
  // droplet is a header — 12.5% overhead buys a header sighting every few
  // seconds of pooled 3-ring capture.
  var HEADER_EVERY = 8;
  function isHeaderSlot(c) { return c % HEADER_EVERY === 0; }
  function carouselLen(K) { return 2 * K + 12; }

  /* Degree + subset for LT droplet c (c ≥ 1), deterministic from ring seed.
     Droplets c = 1..min(3,K) are forced degree-1 singles of blocks 0..2 —
     guaranteed peel seeds for tiny K. */
  function subsetFor(ringSeed, c, K) {
    if (c >= 1 && c <= Math.min(3, K)) return [c - 1];
    var rng = P().mulberry32(((ringSeed * 2654435761) ^ (c * 40503)) >>> 0);
    var r = rng(), d;
    if (r < 0.12) d = 1;
    else if (r < 0.55) d = 2;
    else if (r < 0.80) d = 3;
    else if (r < 0.93) d = 4;
    else d = Math.min(8, K);
    if (d > K) d = K;
    var pool = [];
    for (var i = 0; i < K; i++) pool.push(i);
    var out = [];
    for (var j = 0; j < d; j++) {
      var pick = j + Math.floor(rng() * (K - j));
      var t = pool[j]; pool[j] = pool[pick]; pool[pick] = t;
      out.push(pool[j]);
    }
    return out;
  }

  /* Payload → K blocks of dataBytes each (zero-padded). */
  function toBlocks(payloadBytes, g) {
    var K = Math.max(1, Math.ceil(payloadBytes.length / g.dataBytes));
    var blocks = [];
    for (var i = 0; i < K; i++) {
      var b = new Uint8Array(g.dataBytes);
      for (var j = 0; j < g.dataBytes; j++) {
        var idx = i * g.dataBytes + j;
        b[j] = idx < payloadBytes.length ? payloadBytes[idx] : 0;
      }
      blocks.push(b);
    }
    return { blocks: blocks, K: K };
  }

  function headerBytes(K, payloadBytes, g) {
    var h = new Uint8Array(g.dataBytes);
    h[0] = MAGIC; h[1] = K & 0xFF;
    if (g.dataBytes >= 5) {
      h[2] = (payloadBytes.length >> 8) & 0xFF; h[3] = payloadBytes.length & 0xFF;
      h[4] = crc16(payloadBytes) >> 8;
      if (g.dataBytes >= 6) h[5] = crc16(payloadBytes) & 0xFF;
    }
    return h;
  }

  function parseHeader(bytes, g) {
    if (bytes[0] !== MAGIC) return null;
    var K = bytes[1];
    if (K < 1) return null;
    var h = { K: K, len: null, pcrc: null };
    if (g.dataBytes >= 5) {
      h.len = (bytes[2] << 8) | bytes[3];
      if (h.len < 1 || h.len > K * g.dataBytes) return null;
      h.pcrc = g.dataBytes >= 6 ? ((bytes[4] << 8) | bytes[5]) : bytes[4];
      h.pcrcBits = g.dataBytes >= 6 ? 16 : 8;
    }
    return h;
  }

  /* Droplet c's wire bytes: data(dataBytes) + crc8(c || data). */
  function dropletBytes(c, blocks, K, ringSeed, payloadBytes, g) {
    var data;
    if (isHeaderSlot(c)) data = headerBytes(K, payloadBytes, g);
    else {
      data = new Uint8Array(g.dataBytes);
      var sub = subsetFor(ringSeed, c, K);
      for (var s = 0; s < sub.length; s++)
        for (var j = 0; j < g.dataBytes; j++) data[j] ^= blocks[sub[s]][j];
    }
    var buf = new Uint8Array(g.dataBytes + 2);
    buf[0] = c & 0xFF;
    buf.set(data, 1);
    buf[g.dataBytes + 1] = crc8(buf, g.dataBytes + 1);
    return { data: data, crc: buf[g.dataBytes + 1] };
  }

  /* Bits → Gray symbols for one ring. */
  function bitsToSymbols(bytes, crc, annulus, g) {
    var b = log2M(annulus.rotation.M);
    var totalBits = g.dropletBits;
    var bits = new Uint8Array(totalBits);
    for (var i = 0; i < g.dataBits; i++) bits[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
    for (var j = 0; j < 8; j++) bits[g.dataBits + j] = (crc >> (7 - j)) & 1;
    var syms = new Uint8Array(totalBits / b);
    for (var s = 0; s < syms.length; s++) {
      var v = 0;
      for (var k = 0; k < b; k++) v = (v << 1) | bits[s * b + k];
      syms[s] = toGray(v);
    }
    return syms;
  }

  /* The emitter side: per-annulus symbol carousels (period L·D symbols). */
  function encodeCarousels(profile, payloadBytes) {
    var g = geom(profile);
    var tb = toBlocks(payloadBytes, g);
    if (tb.K > 200) throw new Error("payload too large: K=" + tb.K + " blocks (cap 200 — " + (200 * g.dataBytes) + " bytes at this droplet size)");
    var L = carouselLen(tb.K);
    var carousels = profile.annuli.map(function (a) {
      var D = ringD(a, g);
      var syms = new Uint8Array(L * D);
      for (var c = 0; c < L; c++) {
        var dr = dropletBytes(c, tb.blocks, tb.K, a.rotation.seed, payloadBytes, g);
        syms.set(bitsToSymbols(dr.data, dr.crc, a, g), c * D);
      }
      return syms;
    });
    return { carousels: carousels, K: tb.K, L: L, geom: g };
  }

  /* Decoder side: decoded symbol list (+erasures) at a known lag → verified
     droplets. Emission symbol j = i + lag; data position = j − preamble;
     droplet c = floor(dataPos / D) — captures live inside one carousel
     period, so c needs no modulus and no knowledge of L. */
  function collect(decoded, lag, annulus, profile) {
    var g = geom(profile);
    var D = ringD(annulus, g);
    var b = log2M(annulus.rotation.M);
    var Pn = profile.preamble_symbols;
    var buckets = {};
    for (var i = 0; i < decoded.length; i++) {
      var j = i + lag;
      if (j < Pn) continue;
      var dataPos = j - Pn;
      var c = Math.floor(dataPos / D), pos = dataPos % D;
      if (!buckets[c]) buckets[c] = { syms: new Array(D), n: 0 };
      if (buckets[c].syms[pos] === undefined) {
        buckets[c].syms[pos] = decoded[i].s;
        buckets[c].n++;
      }
    }
    var passed = [], tried = 0;
    for (var ck in buckets) {
      var bu = buckets[ck];
      if (bu.n < D) continue;
      var ok = true;
      for (var p2 = 0; p2 < D; p2++) if (bu.syms[p2] === null || bu.syms[p2] === undefined) { ok = false; break; }
      if (!ok) continue;
      tried++;
      var bits = new Uint8Array(g.dropletBits);
      for (var s2 = 0; s2 < D; s2++) {
        var v = fromGray(bu.syms[s2]);
        for (var k2 = 0; k2 < b; k2++) bits[s2 * b + k2] = (v >> (b - 1 - k2)) & 1;
      }
      var bytes = new Uint8Array(g.dataBytes), crcRead = 0;
      for (var i2 = 0; i2 < g.dataBits; i2++) bytes[i2 >> 3] |= bits[i2] << (7 - (i2 & 7));
      for (var j2 = 0; j2 < 8; j2++) crcRead = (crcRead << 1) | bits[g.dataBits + j2];
      var buf = new Uint8Array(g.dataBytes + 1);
      buf[0] = (+ck) & 0xFF; buf.set(bytes, 1);
      if (crc8(buf, g.dataBytes + 1) === crcRead) passed.push({ c: +ck, bytes: bytes });
    }
    passed.sort(function (a, b2) { return a.c - b2.c; });
    return { passed: passed, tried: tried };
  }

  /* Alignment without a reference stream: scan (offset, lag) and score by
     CRC passes — the true framing lights up (chance rate 1/256/droplet).
     Needs ≥2 passes to lock. */
  function crcAlign(track, annulus, profile, baseOverride, maxLagSymbols) {
    var demap = (typeof module !== "undefined" && module.exports) ? require("./demap.js") : global.OC.demap;
    var F = annulus.rotation.frames_per_symbol;
    var maxLag = maxLagSymbols || 4096;
    var base = (baseOverride !== undefined && baseOverride !== null) ? baseOverride : (track.firstValid || 0);
    var best = null;
    for (var off = base; off < base + F; off++) {
      var decoded = demap.decode(track, annulus, profile, off);
      if (!decoded.length) continue;
      for (var lag = 0; lag <= maxLag; lag++) {
        var col = collect(decoded, lag, annulus, profile);
        if (col.passed.length < 2) continue;
        if (!best || col.passed.length > best.score ||
            (col.passed.length === best.score && lag < best.lag))
          best = { offset: off, lag: lag, score: col.passed.length, max: col.tried, method: "crc" };
      }
    }
    return best;
  }

  /* Pool verified droplets from every ring (and eventually every tile) and
     peel. Header (c=0, MAGIC) supplies K; blocks XOR out one by one. */
  function assemble(perRing, profile) {
    var g = geom(profile);
    var header = null;
    var lt = []; // { ringSeed, c, bytes }
    for (var r = 0; r < perRing.length; r++) {
      var ring = perRing[r];
      if (!ring || !ring.droplets) continue;
      for (var i = 0; i < ring.droplets.length; i++) {
        var d = ring.droplets[i];
        if (isHeaderSlot(d.c)) {
          var h = parseHeader(d.bytes, g);
          if (h) header = header || h;
        } else lt.push({ ringSeed: ring.seed, c: d.c, bytes: d.bytes });
      }
    }
    if (!header) return { ok: false, reason: "no header droplet yet", got: lt.length };
    var K = header.K;
    // dedupe (same ring+c seen across carousel repeats/branches)
    var seen = {}, uniq = [];
    for (var u = 0; u < lt.length; u++) {
      var key = lt[u].ringSeed + ":" + lt[u].c;
      if (seen[key]) continue;
      seen[key] = 1; uniq.push(lt[u]);
    }
    // peel
    var drops = uniq.map(function (d2) {
      return { sub: subsetFor(d2.ringSeed, d2.c, K).slice(), bytes: new Uint8Array(d2.bytes) };
    });
    var blocks = new Array(K), recovered = 0, progress = true;
    while (progress) {
      progress = false;
      for (var q = 0; q < drops.length; q++) {
        var dr = drops[q];
        if (!dr.sub) continue;
        var unknown = [];
        for (var s3 = 0; s3 < dr.sub.length; s3++) {
          var bi = dr.sub[s3];
          if (blocks[bi]) { for (var j3 = 0; j3 < g.dataBytes; j3++) dr.bytes[j3] ^= blocks[bi][j3]; }
          else unknown.push(bi);
        }
        dr.sub = unknown;
        if (unknown.length === 1) {
          blocks[unknown[0]] = new Uint8Array(dr.bytes);
          recovered++;
          dr.sub = null;
          progress = true;
        } else if (unknown.length === 0) dr.sub = null;
      }
    }
    if (recovered < K) return { ok: false, reason: "peel incomplete", K: K, recovered: recovered, droplets: uniq.length };
    var len = header.len !== null ? header.len : K * g.dataBytes;
    var out = new Uint8Array(len);
    for (var b3 = 0; b3 < len; b3++) out[b3] = blocks[Math.floor(b3 / g.dataBytes)][b3 % g.dataBytes];
    var ok = true, why = null;
    if (header.pcrc !== null && header.pcrcBits === 16 && crc16(out) !== header.pcrc) { ok = false; why = "payload CRC16 mismatch"; }
    return { ok: ok, reason: why, K: K, recovered: recovered, droplets: uniq.length, bytes: out,
             text: bytesToText(out) };
  }

  function bytesToText(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) {
      var c = bytes[i];
      s += (c >= 32 && c < 127) ? String.fromCharCode(c) : (c === 0 ? "" : "\\x" + c.toString(16));
    }
    return s;
  }

  function textToBytes(t) {
    var out = new Uint8Array(t.length);
    for (var i = 0; i < t.length; i++) out[i] = t.charCodeAt(i) & 0xFF;
    return out;
  }

  var API = { encodeCarousels: encodeCarousels, collect: collect, crcAlign: crcAlign, assemble: assemble,
              geom: geom, ringD: ringD, carouselLen: carouselLen, subsetFor: subsetFor,
              crc8: crc8, crc16: crc16, toGray: toGray, fromGray: fromGray,
              textToBytes: textToBytes, bytesToText: bytesToText, MAGIC: MAGIC };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.fountain = API;
})(typeof window !== "undefined" ? window : globalThis);
