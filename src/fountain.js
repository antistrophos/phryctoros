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
    // subset_version selects the droplet-subset rule (see subsetFor). 1 is the
    // original and stays the DEFAULT for any profile that does not declare
    // one, so every archived clip and every legacy profile decodes unchanged.
    var sv = (profile.carriage && profile.carriage.subset_version) || 1;
    // carousel_version selects how long each ring's carousel is (see
    // ringCarouselLen). 1 is the original fixed 2K+12 and stays the DEFAULT for
    // any profile that does not declare one.
    var cv = (profile.carriage && profile.carriage.carousel_version) || 1;
    return { dropletBits: db, dataBits: db - 8, dataBytes: (db - 8) / 8, subsetVersion: sv, carouselVersion: cv };
  }
  // D = symbols per droplet. Ceil: droplet_bits divisible by 12 covers the
  // 2/3/4-bit constellations exactly; M=32 (5 bits, the v3 high-rate preset)
  // pads the tail symbol with zero bits — the block universe stays global
  // (ruling 1), only the wire pads.
  function ringD(annulus, g) { return Math.ceil(g.dropletBits / log2M(annulus.rotation.M)); }
  // A capture window is short; the header must RECUR or mid-loop assembly
  // would wait a whole carousel (~minutes on the base ring). Every 8th
  // droplet is a header — 12.5% overhead buys a header sighting every few
  // seconds of pooled 3-ring capture.
  var HEADER_EVERY = 8;
  function isHeaderSlot(c) { return c % HEADER_EVERY === 0; }
  function carouselLen(K) { return 2 * K + 12; }

  /* PER-RING carousel length (carousel_version 2).

     v1 gave every ring the same 2K+12 droplets. But D varies with M, so a ring's
     carousel period — (preamble + L·D)·F frames — varies too, and the fast rings
     come around long before the loop ends: measured at the shipped defaults
     (v3 resilient, 60 s loop, K=16), the M=16 rings finish their 44 droplets at
     36 s and spend the remaining 21 s re-sending, while the base ring never
     reaches its own 44 at all.

     v2 extends each ring's carousel to cover the loop, so that surplus buys
     DISTINCT droplets instead of repeats — strictly more information into the
     peel at identical rate, amplitude and symbol count. It never SHORTENS a
     carousel (max with the 2K+12 floor), so a ring too slow to finish is left
     exactly as it was.

     The decoder needs no version switch and no knowledge of L: it derives c from
     the symbol position alone, and collect() checksums [c, ...bytes] — the
     droplet INDEX is bound into the CRC. That binding is what keeps v1 SAFE
     rather than merely lucky: a re-sent droplet read at a shifted position fails
     CRC8 and is discarded, so it can never enter the peel under a wrong subset.
     The post-wrap airtime is therefore not corrupt, it is DEAD. Measured on the
     fast ring at the shipped defaults: 70 droplet slots fit inside the loop, v1
     fills 44 of them and the remaining 26 yield nothing at all; v2 fills 70.
     (Reading such a window through crcAlign rather than at absolute framing
     lands on the aliased-down lag instead, which recovers them as duplicates —
     no new information either way. Wasted, not wrong.) */
  function ringCarouselLen(annulus, profile, g, K) {
    var base = carouselLen(K);
    var cd = profile.countdown;
    if (g.carouselVersion !== 2 || !cd) return base;
    var fps = profile.frame_rate_hz;
    var loopF = Math.max(2, Math.round(cd.loop_s * fps));
    var freezeF = Math.min(loopF - 1, Math.round(cd.freeze_s * fps));
    // Mirrors emission.timeline/buildSchedule exactly: the freeze is carved OUT
    // of the loop, and buildSchedule sizes itself ceil(frames/F)+1 symbols.
    var symTotal = Math.ceil(Math.max(1, loopF - freezeF) / annulus.rotation.frames_per_symbol) + 1;
    var symData = Math.max(0, symTotal - profile.preamble_symbols);
    // Ceil so the droplet straddling the loop's end is a FRESH one rather than a
    // wrap back to c = 0 (it is truncated either way; only its identity differs).
    return Math.max(base, Math.ceil(symData / ringD(annulus, g)));
  }

  /* Degree + subset for LT droplet c (c ≥ 1), deterministic from ring seed.
     Droplets c = 1..min(3,K) are forced degree-1 singles of blocks 0..2 —
     guaranteed peel seeds for tiny K. */
  function subsetFor(ringSeed, c, K, ver) {
    var S = Math.min(3, K);
    if (c >= 1 && c <= S) {
      // v1 returned blocks 0,1,2 for EVERY ring at every K — it ignores
      // ringSeed entirely — so four rings' twelve forced seeds covered three
      // distinct blocks total: 25% of the payload seeded at K=12, but 4% at
      // K=72. v2 makes the seed ring-dependent and spreads a ring's three
      // across the block space, so four rings seed up to twelve distinct
      // blocks and the peel has somewhere to start at large K.
      if (ver !== 2) return [c - 1];
      var h = ((ringSeed * 2654435761) >>> 0) % K;
      var stride = Math.max(1, Math.floor(K / S));
      return [(h + (c - 1) * stride) % K];
    }
    var rng = P().mulberry32(((ringSeed * 2654435761) ^ (c * 40503)) >>> 0);
    var r = rng(), d;
    if (r < 0.12) d = 1;
    else if (r < 0.55) d = 2;
    else if (r < 0.80) d = 3;
    else if (r < 0.93) d = 4;
    // The top bucket is the coverage tail. v1 capped it at 8 regardless of K,
    // which left ~1 block of 73 untouched by ANY droplet even at 120 droplets
    // (measured) — a coverage ceiling the rank solve cannot lift, since it
    // cannot invent information. v2 scales the cap with K; for K ≤ 32 the two
    // are IDENTICAL, so small payloads are bit-for-bit unchanged.
    else d = ver === 2 ? Math.max(8, Math.round(K / 4)) : 8;
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
      var sub = subsetFor(ringSeed, c, K, g.subsetVersion);
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
    var nSyms = Math.ceil(totalBits / b);
    var bits = new Uint8Array(nSyms * b); // zero pad past totalBits (M=32 tail)
    for (var i = 0; i < g.dataBits; i++) bits[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
    for (var j = 0; j < 8; j++) bits[g.dataBits + j] = (crc >> (7 - j)) & 1;
    var syms = new Uint8Array(nSyms);
    for (var s = 0; s < syms.length; s++) {
      var v = 0;
      for (var k = 0; k < b; k++) v = (v << 1) | bits[s * b + k];
      syms[s] = toGray(v);
    }
    return syms;
  }

  /* v3 §3 payload self-framing: block 0 opens with len16 + type8 + reserved8,
     paid once per payload — the true length (and a type lane) ride the wire
     itself, so delivery NEVER depends on envelope sighting. The 24-mode header
     is just [magic, K]; this is where its length lives. */
  function selfFrame(payloadBytes, type) {
    var out = new Uint8Array(payloadBytes.length + 4);
    out[0] = (payloadBytes.length >> 8) & 255; out[1] = payloadBytes.length & 255;
    out[2] = (type || 0) & 255; out[3] = 0;
    out.set(payloadBytes, 4);
    return out;
  }
  /* Self-framing parse. This is the ONLY payload-level integrity check in
     24-bit mode — dataBytes is 2 there, so the header holds [magic, K] and
     carries no CRC — which makes its strictness load-bearing: it is what
     rejects a peel that completed over the wrong block assignment. len ≥ 1
     and the reserved byte are both free to demand (selfFrame always writes
     them) and together take a random block 0 from ~1-in-3000 to ~1-in-800000.
     Caught in testing: without them, decoding a v1-subset clip under v2 rules
     returned ok:true with an EMPTY payload rather than failing over to v1. */
  function unframe(bytes) {
    if (bytes.length < 4) return null;
    var len = (bytes[0] << 8) | bytes[1];
    if (len < 1 || len > bytes.length - 4) return null;
    if (bytes[3] !== 0) return null;              // reserved byte, always 0
    return { len: len, type: bytes[2], bytes: bytes.subarray(4, 4 + len) };
  }

  /* Tile t's ring seed (v3 multi-tile): same blocks, tile-distinct subsets —
     the (ringSeed, c) dedupe key is tile-safe because seeds never collide
     across tiles. Both ends derive it; the wire carries nothing. */
  function tileSeed(seed, t) { return (seed + 7919 * (t || 0)) >>> 0; }

  /* The emitter side: per-annulus symbol carousels (period L·D symbols).
     opts.tile: encode tile t's carousels (seed-shifted; forced degree-1
     slots stay the same blocks by design — the peel seeds every tile). */
  function encodeCarousels(profile, payloadBytes, opts) {
    var g = geom(profile);
    var framed = !!(profile.carriage && profile.carriage.self_framing);
    if (framed) payloadBytes = selfFrame(payloadBytes, opts && opts.type);
    var tb = toBlocks(payloadBytes, g);
    if (tb.K > 200) throw new Error("payload too large: K=" + tb.K + " blocks (cap 200 — " + (200 * g.dataBytes) + " bytes at this droplet size)");
    var L = carouselLen(tb.K);
    var tShift = opts && opts.tile ? opts.tile : 0;
    var Ls = [];
    var carousels = profile.annuli.map(function (a) {
      var D = ringD(a, g);
      var Lr = ringCarouselLen(a, profile, g, tb.K);
      Ls.push(Lr);
      var syms = new Uint8Array(Lr * D);
      for (var c = 0; c < Lr; c++) {
        var dr = dropletBytes(c, tb.blocks, tb.K, tileSeed(a.rotation.seed, tShift), payloadBytes, g);
        syms.set(bitsToSymbols(dr.data, dr.crc, a, g), c * D);
      }
      return syms;
    });
    // L stays the nominal 2K+12 (what the carousel would be without the loop
    // extension); Ls is what each ring actually carries.
    // wireCrc16 = the content fingerprint over the (framed) wire — what the
    // envelope's pcrc carries on the air, and what expectPcrc16 validates.
    return { carousels: carousels, K: tb.K, L: L, Ls: Ls, geom: g, framed: framed,
             wireLen: payloadBytes.length, wireCrc16: crc16(payloadBytes) };
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
      var bits = new Uint8Array(D * b); // D·b ≥ dropletBits; pad bits ignored below
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
     Needs ≥2 passes to lock. lagHint ({min,max}, harvest): a hop window's
     lag is already priced by the bootstrap lock, so the predicted band is
     scanned FIRST and the full carousel scan becomes the fallback, not the
     routine — the scan is most of a window's self-alignment cost, and the
     hint deletes it when the lock holds while losing nothing when it
     doesn't (a stale lock past an emitter loop restart just falls through).

     opts: { minPasses, hintOnly, offsets } — the CONSENSUS-ADMISSION path.
     The ≥2-pass bar exists to stop a wrong (offset, lag) being CHOSEN from
     this ring's own data: over ~4096 lags × 4 offsets, single chance passes
     are certain and doubles are order-1. When sibling rings have already
     agreed a framing, the hypothesis is not being chosen here at all — it is
     GIVEN — so scanning that one hypothesis and accepting a single CRC pass
     carries only CRC8's ordinary 1/256 residual, the same standard every
     banked droplet already meets. Callers must therefore pass a single
     explicit lag AND offset with hintOnly (never a band: predictLag's ±24
     symbols is ~196 hypotheses, where a 1-pass bar would be noise). */
  function crcAlign(track, annulus, profile, baseOverride, maxLagSymbols, lagHint, opts) {
    var demap = (typeof module !== "undefined" && module.exports) ? require("./demap.js") : global.OC.demap;
    var F = annulus.rotation.frames_per_symbol;
    var maxLag = maxLagSymbols || 4096;
    var base = (baseOverride !== undefined && baseOverride !== null) ? baseOverride : (track.firstValid || 0);
    opts = opts || {};
    var minPasses = opts.minPasses || 2;
    var offList = null;
    if (opts.offsets && opts.offsets.length) offList = opts.offsets;
    function scan(lagLo, lagHi) {
      var best = null;
      var nOff = offList ? offList.length : F;
      for (var oi = 0; oi < nOff; oi++) {
        var off = offList ? offList[oi] : base + oi;
        var decoded = demap.decode(track, annulus, profile, off);
        if (!decoded.length) continue;
        for (var lag = lagLo; lag <= lagHi; lag++) {
          var col = collect(decoded, lag, annulus, profile);
          if (col.passed.length < minPasses) continue;
          if (!best || col.passed.length > best.score ||
              (col.passed.length === best.score && lag < best.lag))
            best = { offset: off, lag: lag, score: col.passed.length, max: col.tried, method: "crc" };
        }
      }
      return best;
    }
    if (lagHint && lagHint.max >= 0 && lagHint.max >= (lagHint.min | 0)) {
      var hinted = scan(Math.max(0, lagHint.min | 0), Math.min(maxLag, lagHint.max | 0));
      if (hinted) { hinted.hinted = true; return hinted; }
      if (opts.hintOnly) return null;
    }
    if (opts.hintOnly) return null;
    return scan(0, maxLag);
  }

  /* GF(2) rank solve — the fallback when greedy peeling stalls.

     Belief-propagation peeling only advances through degree-1 droplets, so it
     stops the moment no droplet has exactly one unknown left — and the old
     code then THREW AWAY everything it held. But those droplets are a linear
     system: N equations over the U still-unknown blocks, and greedy succeeds
     only where a degree-1 cascade happens to exist, while elimination
     succeeds whenever the system has full rank — which typically happens
     well earlier. (Field case: K=72 with 107 droplets banked stalled at
     66/72, leaving ~41 unused droplets over 6 unknowns.)

     Input is the POST-PEEL reduced state: each surviving droplet's `sub` is
     its remaining unknowns and `bytes` already has every recovered block
     XORed out, so the system is pre-reduced for free. Row echelon over a
     bitset per row (U ≤ K ≤ 255, so ≤ 8 words), payload bytes carried along
     under the same XORs. Back-substitution runs high column to low and stops
     at any column without a pivot, so a rank-deficient system still yields
     whatever suffix IS determined rather than nothing. Decoder-side only —
     no wire change, and it re-reads existing clips and carried ledgers. */
  function rankSolve(drops, blocks, K, dataBytes) {
    var colOf = new Int32Array(K), cols = [], i, c, w;
    for (i = 0; i < K; i++) { colOf[i] = -1; }
    for (i = 0; i < K; i++) if (!blocks[i]) { colOf[i] = cols.length; cols.push(i); }
    var U = cols.length;
    if (!U) return 0;
    var W = (U + 31) >> 5;
    var pivot = new Array(U);
    for (i = 0; i < U; i++) pivot[i] = null;

    for (var q = 0; q < drops.length; q++) {
      var dr = drops[q];
      if (!dr.sub || !dr.sub.length) continue;
      var bits = new Uint32Array(W), bad = false;
      for (var s = 0; s < dr.sub.length; s++) {
        c = colOf[dr.sub[s]];
        if (c < 0) { bad = true; break; }        // already-known block: can't happen post-peel
        bits[c >> 5] ^= (1 << (c & 31));
      }
      if (bad) continue;
      var row = { bits: bits, bytes: new Uint8Array(dr.bytes) };
      for (c = 0; c < U && row; c++) {
        if (!((row.bits[c >> 5] >>> (c & 31)) & 1)) continue;
        if (!pivot[c]) { pivot[c] = row; row = null; break; }
        var pr = pivot[c];
        for (w = 0; w < W; w++) row.bits[w] ^= pr.bits[w];
        for (var b = 0; b < dataBytes; b++) row.bytes[b] ^= pr.bytes[b];
      }
    }

    // Back-substitute high→low: a pivot row for column c carries bits only at
    // columns ≥ c, so it resolves once every later column it touches is known.
    var sol = new Array(U), gained = 0;
    for (c = U - 1; c >= 0; c--) {
      var p = pivot[c];
      if (!p) continue;
      var val = new Uint8Array(p.bytes), okCol = true;
      for (var c2 = c + 1; c2 < U; c2++) {
        if (!((p.bits[c2 >> 5] >>> (c2 & 31)) & 1)) continue;
        if (!sol[c2]) { okCol = false; break; }
        for (var b2 = 0; b2 < dataBytes; b2++) val[b2] ^= sol[c2][b2];
      }
      if (!okCol) continue;
      sol[c] = val;
      blocks[cols[c]] = val;
      gained++;
    }
    return gained;
  }

  /* Pool verified droplets from every ring (and eventually every tile) and
     peel. Header (c=0, MAGIC) supplies K; blocks XOR out one by one. */
  /* Version fallback. A wrong subset_version still PEELS — the cascade is
     purely structural and never checks itself — so it completes and hands
     back garbage, which the payload CRC16 (48-bit mode) and the self-framing
     parse then reject. That "completed but did not validate" signature is
     exactly the wrong-version fingerprint, and it is the only case worth
     paying a second assemble for: while the peel is merely INCOMPLETE we are
     short of droplets, not on the wrong rule, so accumulation costs nothing
     extra. This is what lets a profile default to v2 while every clip already
     filmed under v1 — including the ::b carriage and the loopback specimens —
     keeps decoding with no setting to remember. */
  function assemble(perRing, profile, opts) {
    var declared = geom(profile).subsetVersion;
    var res = assembleWith(perRing, profile, opts, declared);
    if (res.ok === true || (opts && opts.noVersionFallback)) return res;
    // Only "completed but did not validate" is the mis-version fingerprint.
    // No header yet, or a peel still short, means we are accumulating — both
    // return before paying for a second assemble.
    if (res.recovered == null || res.recovered !== res.K) return res;
    var alt = declared === 2 ? 1 : 2;
    var res2 = assembleWith(perRing, profile, opts, alt);
    // Rank: validated > honestly incomplete > completed-but-invalid. The last
    // is EVIDENCE the rule is wrong — a correct rule with enough droplets
    // validates, and a correct rule without them reports incomplete — so a
    // short clip read under the wrong version (which peels to completion over
    // the wrong blocks and fails the framing check) must not be preferred over
    // the honest partial the right version gives. Ties go to the declared one.
    var rank = function (r) { return r.ok === true ? 2 : (r.recovered !== r.K ? 1 : 0); };
    if (rank(res2) > rank(res)) {
      res2.subsetVersion = alt;
      res2.versionFallback = true;
      return res2;
    }
    return res;
  }

  function assembleWith(perRing, profile, opts, ver) {
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
      return { sub: subsetFor(d2.ringSeed, d2.c, K, ver).slice(), bytes: new Uint8Array(d2.bytes) };
    });
    var blocks = new Array(K);
    var peelGreedy = function () {
      var progress = true;
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
            dr.sub = null;
            progress = true;
          } else if (unknown.length === 0) dr.sub = null;
        }
      }
    };
    var countBlocks = function () {
      var n = 0;
      for (var z = 0; z < K; z++) if (blocks[z]) n++;
      return n;
    };
    peelGreedy();
    var recovered = countBlocks(), rankGain = 0;
    // Greedy stalled with droplets still in hand: solve the residual system
    // instead of discarding it, then let peeling cascade on anything freed.
    if (recovered < K && (!opts || opts.rankSolve !== false)) {
      rankGain = rankSolve(drops, blocks, K, g.dataBytes);
      if (rankGain > 0) { peelGreedy(); recovered = countBlocks(); }
    }
    if (recovered < K)
      return { ok: false, reason: "peel incomplete", K: K, recovered: recovered, droplets: uniq.length, rankGain: rankGain };
    // opts.expectLen: the exact wire length when the header cannot carry one
    // (24-bit droplets) — from the content key / the envelope. Without it the
    // padded K·dataBytes buffer stands in, and a wire-length fingerprint
    // could never match.
    var len = header.len !== null ? header.len
            : (opts && opts.expectLen != null ? opts.expectLen : K * g.dataBytes);
    var out = new Uint8Array(len);
    for (var b3 = 0; b3 < len; b3++) out[b3] = blocks[Math.floor(b3 / g.dataBytes)][b3 % g.dataBytes];
    var ok = true, why = null;
    // The header's len/pcrc cover the WIRE — framed when self-framing is on —
    // so the CRC checks precede unframing.
    // opts.expectPcrc16: the FULL 16-bit fingerprint when the caller knows it
    // (a content-keyed ledger carries it in its own key; the envelope carries
    // it on the air). The header alone cannot: 48-bit droplets hold 5 data
    // bytes, so v3-family headers carry only the HIGH BYTE — and until
    // 2026-08-27 the validation below required pcrcBits === 16, which meant
    // NO v3 profile ever validated content at all. Two chance-passed CRC8
    // droplets (the priced 1/256 residual) peeled into a corrupted payload
    // that printed as valid: the a42g field specimen (store export
    // 1787846567849; liars 403:137 and 404:9; healed at exactly the
    // envelope's 0x9edc). The 8-bit branch catches 255/256 of that class;
    // expectPcrc16 catches it all.
    var wireCrc = crc16(out);
    var expect16 = opts && opts.expectPcrc16 != null ? opts.expectPcrc16 : null;
    if (expect16 !== null && wireCrc !== expect16) { ok = false; why = "payload CRC16 mismatch (vs the content key's fingerprint)"; }
    else if (header.pcrc !== null && header.pcrcBits === 16 && wireCrc !== header.pcrc) { ok = false; why = "payload CRC16 mismatch"; }
    else if (header.pcrc !== null && header.pcrcBits === 8 && ((wireCrc >> 8) & 0xFF) !== header.pcrc) { ok = false; why = "payload CRC8-of-16 mismatch (the header's high byte)"; }
    var ftype;
    if (ok && profile.carriage && profile.carriage.self_framing) {
      var fr = unframe(out);
      if (!fr) { ok = false; why = "self-framing parse failed (block 0 len16 out of range)"; }
      else { out = fr.bytes; ftype = fr.type; }
    }
    return { ok: ok, reason: why, K: K, recovered: recovered, droplets: uniq.length, bytes: out,
             ftype: ftype, text: bytesToText(out) };
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
              geom: geom, ringD: ringD, carouselLen: carouselLen, ringCarouselLen: ringCarouselLen, subsetFor: subsetFor,
              isHeaderSlot: isHeaderSlot, parseHeader: parseHeader, HEADER_EVERY: HEADER_EVERY,
              crc8: crc8, crc16: crc16, toGray: toGray, fromGray: fromGray,
              selfFrame: selfFrame, unframe: unframe, tileSeed: tileSeed,
              textToBytes: textToBytes, bytesToText: bytesToText, MAGIC: MAGIC };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.fountain = API;
})(typeof window !== "undefined" ? window : globalThis);
