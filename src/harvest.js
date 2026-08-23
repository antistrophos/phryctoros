/* harvest.js — the harvest decoder's bookkeeping: the droplet LEDGER, the
   slot↔time LOCKS, and the hop PLANNER (practitioner's design, 2026-08-15:
   droplet-aware bootstrap-then-hop — "skip the seeks for what you hold, stop
   when the peel completes"). SEEKING dominates decode wall-clock (~7,000
   browser video seeks per full pass at 60 fps stepping; the DSP is cheap
   beside it), so droplet-awareness deletes seeks: a held droplet's span is
   ~96 seeks that never happen. This module is the pure logic — no DOM, no
   video. The receive harness drives it against a clip; the suite drives it
   against synthetic decodes.

   The ledger retains RAW BYTES ALWAYS (a lesson bought twice) and is JSON
   round-trippable so it travels BETWEEN clips: the two-fresh-takes filming
   pattern becomes decoder-exploited — clip 2 is mined only for what clip 1
   lacked. Locks are NOT in the ledger: an alignment is a fact about one
   clip's time axis; droplets are facts about the session. */
(function (global) {
  "use strict";

  function F() { return (typeof module !== "undefined" && module.exports) ? require("./fountain.js") : global.OC.fountain; }

  function bytesToHex(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i++) s += (u8[i] < 16 ? "0" : "") + u8[i].toString(16);
    return s;
  }
  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length >> 1);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  /* ---------- the ledger ---------- */

  function createLedger(profile, session) {
    return {
      version: 1,
      profile_version: profile.profile_version,
      droplet_bits: F().geom(profile).dropletBits,
      tiling: profile.tiling || 1, // tile-keyed rings: rings[tileSeed(seed, t)] (absent on old ledgers = 1)
      session: session || null,
      header: null,               // { K, len, hex } once any header droplet lands
      rings: {},                  // rings[seed][c] = hex — witnessed droplets only; seed is the TILE seed
      clips: []                   // provenance: { name, windows: [[t0,t1],…] } per clip harvested
    };
  }

  function serializeLedger(ledger) { return JSON.stringify(ledger); }

  function parseLedger(text) {
    var l = JSON.parse(text);
    if (l.version !== 1 || !l.rings) throw new Error("not a harvest ledger (version " + l.version + ")");
    return l;
  }

  function counts(ledger) {
    var rings = 0, droplets = 0;
    for (var seed in ledger.rings) {
      rings++;
      for (var c in ledger.rings[seed]) droplets++; // eslint-disable-line no-unused-vars
    }
    return { rings: rings, droplets: droplets, header: !!ledger.header };
  }

  /* Feed one window's decodeSequence result (payload mode) into the ledger.
     Every CRC-passed droplet enters under its ring's TILE seed
     (fountain.tileSeed(seed, tile) — tile 0 / untiled is the base seed, so
     1-up ledgers are byte-identical to before); duplicates are free (the
     same wire bytes recur every carousel period and across clips — the
     dedupe key is (tile ring, c); session identity is the operator's ledger
     choice pre-v3). Tiles carry the SAME blocks under DIFFERENT subsets, so
     a tile-blind key would bank tile 3's slot c as tile 0's and poison the
     peel — the 6-up harvest failure. An emitter whose tile could not be
     placed (tile −1) is skipped: its seed cannot be named, so its droplets
     cannot be banked honestly (the pipeline's own pool skips it the same
     way). The header is banked once: header BYTES are identical at every
     header slot of every ring and tile (they depend only on K + payload), so
     one sighting holds them all — the planner prices every header slot as
     held from that moment. A droplet_bits mismatch refuses the absorb
     rather than silently mixing framings. */
  function absorb(ledger, res, profile) {
    var g = F().geom(profile);
    if (ledger.droplet_bits !== g.dropletBits)
      return { added: 0, dup: 0, conflicts: 0, quarantined: 0, mismatch: true };
    var added = 0, dup = 0, conflicts = 0, quarantined = 0, consensus = null, unplaced = 0;
    if (!res || res.error || !res.emitters)
      return { added: 0, dup: 0, conflicts: 0, quarantined: 0, lagConsensus: null };
    for (var e = 0; e < res.emitters.length; e++) {
      var annuli = res.emitters[e].annuli || [];
      var tile = res.emitters[e].tile;
      if (tile === -1) {
        for (var ui = 0; ui < annuli.length; ui++) if (annuli[ui] && annuli[ui].droplets) unplaced += annuli[ui].droplets.length;
        continue;
      }
      var tileIdx = tile > 0 ? tile : 0;
      // Lag consensus, IN FRAMES. Every ring shares the emission clock and the
      // capture start, so within a window every locked ring must agree about
      // WHEN the window began — but lag counts that ring's own SYMBOLS, and a
      // ring's symbol index at emission frame f is floor(f / frames_per_symbol).
      // So the ring-independent quantity is lag × F (the window's start frame);
      // comparing raw lags is only valid while every ring runs the same F.
      // Normalising here is what makes per-ring frames_per_symbol safe to vary.
      // Tolerance scales with the coarsest ring involved, since a ring with
      // larger F pins the start frame only to within F frames.
      // A lone disagreeing ring is a chance CRC double-pass wearing a lock —
      // transient before the ledger (a 1/256 residual per decode), but
      // PERSISTENT now: its droplets would enter as first-seen poison and
      // block the real bytes forever. With ≥2 rings in agreement the outlier
      // is quarantined: nothing banked, no lock taken (callers gate on
      // lagConsensus, which is reported in FRAMES).
      var fpsOf = function (idx) {
        var pz = annulusByIndex(profile, idx);
        return (pz && pz.rotation.frames_per_symbol) || 4;
      };
      var lagsF = [];
      for (var li = 0; li < annuli.length; li++) {
        var al = annuli[li];
        if (al && al.alignLag != null && al.droplets && al.droplets.length)
          lagsF.push({ f: al.alignLag * fpsOf(al.annulus), F: fpsOf(al.annulus) });
      }
      if (lagsF.length >= 2) {
        var bestN = 0;
        for (var bi = 0; bi < lagsF.length; bi++) {
          var n = 0;
          for (var bj = 0; bj < lagsF.length; bj++) {
            var tol = Math.max(lagsF[bi].F, lagsF[bj].F);
            if (Math.abs(lagsF[bj].f - lagsF[bi].f) <= tol) n++;
          }
          if (n > bestN || (n === bestN && (consensus === null || lagsF[bi].f < consensus))) { bestN = n; consensus = lagsF[bi].f; }
        }
        if (bestN < 2) consensus = null; // no two rings agree — judge nothing
      }
      for (var ai = 0; ai < annuli.length; ai++) {
        var a = annuli[ai];
        if (!a || !a.droplets || !a.droplets.length) continue;
        if (consensus !== null && a.alignLag != null) {
          var Fa = fpsOf(a.annulus);
          if (Math.abs(a.alignLag * Fa - consensus) > Fa) {
            quarantined += a.droplets.length;
            continue;
          }
        }
        var pa = annulusByIndex(profile, a.annulus);
        if (!pa) continue;
        var seed = F().tileSeed(pa.rotation.seed, tileIdx);
        var ring = ledger.rings[seed] || (ledger.rings[seed] = {});
        for (var d = 0; d < a.droplets.length; d++) {
          var dr = a.droplets[d]; // { c, hex }
          if (ring[dr.c] !== undefined) {
            if (ring[dr.c] !== dr.hex) conflicts++; // same slot, different bytes — surfaced, never silent
            dup++;
            continue;
          }
          ring[dr.c] = dr.hex;
          added++;
          if (!ledger.header && F().isHeaderSlot(dr.c)) {
            var h = F().parseHeader(hexToBytes(dr.hex), g);
            if (h) ledger.header = { K: h.K, len: h.len, hex: dr.hex };
          }
        }
      }
    }
    return { added: added, dup: dup, conflicts: conflicts, quarantined: quarantined, unplaced: unplaced, lagConsensus: consensus };
  }

  /* The ledger in fountain.assemble's shape — the peel never knows whether a
     droplet arrived this window, last window, from another clip's take, or
     from another TILE: every held tile-ring goes in (tile-distinct seeds make
     the pool collision-free, exactly as the pipeline's own multi-tile peel),
     so a 6-up harvest peels across tiles the way a 6-up window does. */
  function ringsFor(ledger, profile) {
    var out = [];
    for (var seedKey in ledger.rings) {
      var held = ledger.rings[seedKey];
      var droplets = [];
      for (var c in held) droplets.push({ c: +c, bytes: hexToBytes(held[c]) });
      out.push({ seed: +seedKey, droplets: droplets });
    }
    // Stable order: the profile's base rings first (tile 0), then the rest
    // ascending — the peel is order-independent, the receipt is not.
    var baseSeeds = profile.annuli.map(function (a) { return a.rotation.seed; });
    out.sort(function (x, y) {
      var bx = baseSeeds.indexOf(x.seed), by = baseSeeds.indexOf(y.seed);
      if (bx >= 0 && by >= 0) return bx - by;
      if (bx >= 0) return -1;
      if (by >= 0) return 1;
      return x.seed - y.seed;
    });
    return out;
  }

  /* Tile seeds that have banked anything for a given base ring — the tiles
     the harvest has actually SEEN (a tile never in frame never enters the
     union, so the planner never waits on what cannot be received). */
  function seenTileSeeds(ledger, baseSeed) {
    var tiles = ledger.tiling || 1, out = [];
    for (var t = 0; t < tiles; t++) {
      var s = F().tileSeed(baseSeed, t);
      if (ledger.rings[s]) out.push(s);
    }
    return out;
  }

  /* EARLY EXIT's question, asked after every window: is the payload in hand?
     (field34 decoded 64 s; the payload may have been in hand by 40.) */
  function tryPeel(ledger, profile) {
    return F().assemble(ringsFor(ledger, profile), profile);
  }

  function annulusByIndex(profile, index) {
    for (var i = 0; i < profile.annuli.length; i++)
      if (profile.annuli[i].index === index) return profile.annuli[i];
    return null;
  }

  /* ---------- locks: the capture-time→carousel-slot mapping ---------- */

  /* A lock binds one ring's carousel to the clip's absolute emission-frame
     axis: emission symbol j sits at absolute frame
         frameOfSymbol(j) = fBase + offset + (j − lag)·F
     (fBase = the window's first absolute frame; offset/lag from that
     window's own alignment). Extrapolated forward it prices every future
     slot's span. It can be WRONG past an emitter loop restart — priced in:
     a window planned on a stale lock fails its narrow realign, the full CRC
     scan re-locks it, and planning continues on the fresh lock. A wrong
     prediction costs a wasted window, never wrong data — CRC gates the
     ledger. */
  function lockFrom(a, annulus, profile, fBase) {
    if (!a || a.alignOffset == null || a.alignLag == null) return null;
    var g = F().geom(profile);
    return {
      annulus: a.annulus, seed: annulus.rotation.seed,
      F: annulus.rotation.frames_per_symbol, D: F().ringD(annulus, g),
      Pn: profile.preamble_symbols,
      fBase: fBase, offset: a.alignOffset, lag: a.alignLag
    };
  }

  function frameOfSymbol(lock, j) { return lock.fBase + lock.offset + (j - lock.lag) * lock.F; }
  function symbolAtFrame(lock, f) { return (f - lock.fBase - lock.offset) / lock.F + lock.lag; }
  function slotSpan(lock, c) {
    var j0 = lock.Pn + c * lock.D;
    return [frameOfSymbol(lock, j0), frameOfSymbol(lock, j0 + lock.D)];
  }
  function slotAtFrame(lock, f) {
    return Math.floor((symbolAtFrame(lock, f) - lock.Pn) / lock.D);
  }

  /* One max-droplet span in EMISSION frames — the overlap unit (field36
     run-1's edge-truncation lesson): the longest time any single droplet
     occupies on any ring. A window boundary truncates every droplet that
     straddles it, and a truncated droplet can never pass CRC — so follow-on
     windows must start this many frames early to make every slot lie FULLY
     inside some window. */
  function maxDropletFrames(profile) {
    var g = F().geom(profile), m = 0;
    for (var i = 0; i < profile.annuli.length; i++) {
      var a = profile.annuli[i];
      var span = F().ringD(a, g) * a.rotation.frames_per_symbol;
      if (span > m) m = span;
    }
    return m;
  }

  /* Predicted-lag band for a window starting at absolute frame fBase — the
     crcAlign hint that turns a hop window's full carousel scan into a narrow
     confirmation. Band ±24 symbols covers rounding + mild emitter drift. */
  function predictLag(lock, fBase, band) {
    var b = band || 24;
    var pred = Math.round(symbolAtFrame(lock, fBase));
    if (pred + b < 0) return null;
    return { min: Math.max(0, pred - b), max: pred + b, pred: pred };
  }

  /* ---------- interval bookkeeping (absolute emission frames) ---------- */

  function mergeSpans(spans) {
    if (!spans.length) return [];
    var s = spans.slice().sort(function (a, b) { return a[0] - b[0]; });
    var out = [s[0].slice()];
    for (var i = 1; i < s.length; i++) {
      var last = out[out.length - 1];
      if (s[i][0] <= last[1]) { if (s[i][1] > last[1]) last[1] = s[i][1]; }
      else out.push(s[i].slice());
    }
    return out;
  }

  function subtractSpans(spans, cut) {
    var out = spans;
    for (var i = 0; i < cut.length; i++) {
      var next = [];
      for (var j = 0; j < out.length; j++) {
        var a = out[j][0], b = out[j][1], c0 = cut[i][0], c1 = cut[i][1];
        if (c1 <= a || c0 >= b) { next.push([a, b]); continue; }
        if (c0 > a) next.push([a, c0]);
        if (c1 < b) next.push([c1, b]);
      }
      out = next;
    }
    return out;
  }

  /* Visited is a fact whatever the window yielded — a barren window is
     marked, not retried. In-place insert-merge. */
  function markVisited(visited, f0, f1) {
    visited.push([f0, f1]);
    var merged = mergeSpans(visited);
    visited.length = 0;
    for (var i = 0; i < merged.length; i++) visited.push(merged[i]);
  }

  /* ---------- the hop planner ---------- */

  /* Spans worth seeking in [f0,f1]: wherever ANY locked ring holds an
     UNKNOWN slot. Held slots price at zero; header slots price at zero once
     the header is banked; never-locking rings contribute nothing (they drop
     out of the union — a later lock brings their unknowns in: the
     revisit-on-later-lock). Visited is subtracted whatever it yielded.
     Raw spans are then clustered into WORK WINDOWS of at least minFrames
     (~8–10 s), because below that a window cannot confirm its own CRC
     alignment — each window self-aligns; the padding spends a few held
     seeks to keep every window self-sufficient. */
  function planSpans(ledger, locks, f0, f1, opts) {
    opts = opts || {};
    var minF = opts.minFrames || 1, joinGap = opts.joinGap || 0;
    var spans = [];
    for (var li = 0; li < locks.length; li++) {
      var lock = locks[li];
      if (!lock) continue;
      // Tiles share the clock, so slot c is simultaneous on every tile's
      // ring; it is HELD only when every tile seen so far holds it (one
      // tile's gap is still worth the seek). Untiled: the base seed alone.
      var tileRings = seenTileSeeds(ledger, lock.seed).map(function (s) { return ledger.rings[s]; });
      var heldAll = function (c) {
        if (!tileRings.length) return false;
        for (var ti = 0; ti < tileRings.length; ti++) if (tileRings[ti][c] === undefined) return false;
        return true;
      };
      var cA = Math.max(0, slotAtFrame(lock, f0));
      var cB = slotAtFrame(lock, f1);
      for (var c = cA; c <= cB; c++) {
        if (heldAll(c)) continue;
        if (ledger.header && F().isHeaderSlot(c)) continue;
        var s = slotSpan(lock, c);
        var a = Math.max(f0, s[0]), b = Math.min(f1, s[1]);
        if (b > a) spans.push([a, b]);
      }
    }
    spans = mergeSpans(spans);
    if (opts.visited && opts.visited.length) spans = subtractSpans(spans, opts.visited);
    // Cluster into work windows: pad each span forward to minFrames (backward
    // at the clip end), then merge windows separated by less than joinGap —
    // seeking through a small held gap is cheaper than a second window's
    // alignment overhead.
    var wins = [];
    for (var i = 0; i < spans.length; i++) {
      var w0 = spans[i][0], w1 = spans[i][1];
      if (w1 - w0 < minF) {
        w1 = w0 + minF;
        if (w1 > f1) { w1 = f1; w0 = Math.max(f0, w1 - minF); }
      }
      wins.push([w0, w1]);
    }
    var padded = [];
    for (var k = 0; k < wins.length; k++) {
      var last = padded[padded.length - 1];
      if (last && wins[k][0] - last[1] <= joinGap) { if (wins[k][1] > last[1]) last[1] = wins[k][1]; }
      else padded.push(wins[k]);
    }
    // Back-pad (opts.overlap = one max-droplet span; field36 run-1's
    // edge-truncation lesson): a droplet straddling a prior window's end
    // never completed, so every follow-on window starts one droplet-span
    // early — the seam is re-seeked deliberately, and every unknown slot
    // then lies FULLY inside some window.
    var overlap = opts.overlap || 0;
    if (overlap > 0) {
      for (var ov = 0; ov < padded.length; ov++)
        padded[ov][0] = Math.max(f0, padded[ov][0] - overlap);
      padded = mergeSpans(padded);
    }
    // The cap: window length IS the early-exit granularity — pooling happens
    // per window, so one giant unknown remainder would postpone the peel
    // check to the clip's end and early exit could never fire (field34's
    // "in hand by 40 s" needs the tail to be SEPARATE windows). Split any
    // over-cap window into consecutive pieces of ~minFrames; a window under
    // 2×minFrames is indivisible (each piece must still self-align). Pieces
    // after the first also start `overlap` early — a split seam truncates
    // droplets exactly like a window seam.
    if (opts.maxFrames > 0) {
      var split = [];
      for (var q = 0; q < padded.length; q++) {
        var w0q = padded[q][0], w1q = padded[q][1], len = w1q - w0q;
        var pieces = len > opts.maxFrames ? Math.floor(len / minF) : 1;
        if (pieces <= 1) { split.push(padded[q]); continue; }
        var size = len / pieces;
        for (var pz = 0; pz < pieces; pz++)
          split.push([Math.max(f0, Math.round(w0q + pz * size) - (pz ? overlap : 0)), Math.round(w0q + (pz + 1) * size)]);
      }
      padded = split;
    }
    if (opts.visited && opts.visited.length) {
      // Padding may have re-covered visited ground entirely (a window nested
      // inside old coverage helps nobody) — drop windows that add nothing.
      var keep = [];
      for (var m = 0; m < padded.length; m++) {
        var fresh = subtractSpans([padded[m]], opts.visited);
        var freshLen = 0;
        for (var n = 0; n < fresh.length; n++) freshLen += fresh[n][1] - fresh[n][0];
        if (freshLen > 0) keep.push(padded[m]);
      }
      padded = keep;
    }
    return { spans: spans, windows: padded };
  }

  /* The no-lock / still-hungry fallback: the first unvisited chunk, started
     one overlap early (a sweep seam truncates droplets exactly like a
     planned seam). With no lock the harvest degrades to a chunked classic
     pass; with locks exhausted and the peel still short it keeps the
     coverage promise honest before declaring the clip dry. */
  function nextUnvisited(visited, f0, f1, chunkFrames, overlap) {
    var gaps = subtractSpans([[f0, f1]], visited);
    if (!gaps.length) return null;
    var g0 = gaps[0][0];
    return [Math.max(f0, g0 - (overlap || 0)), Math.min(g0 + chunkFrames, gaps[0][1])];
  }

  var API = {
    createLedger: createLedger, serializeLedger: serializeLedger, parseLedger: parseLedger,
    counts: counts, absorb: absorb, ringsFor: ringsFor, tryPeel: tryPeel, seenTileSeeds: seenTileSeeds,
    lockFrom: lockFrom, frameOfSymbol: frameOfSymbol, symbolAtFrame: symbolAtFrame,
    slotSpan: slotSpan, slotAtFrame: slotAtFrame, predictLag: predictLag,
    maxDropletFrames: maxDropletFrames,
    mergeSpans: mergeSpans, subtractSpans: subtractSpans, markVisited: markVisited,
    planSpans: planSpans, nextUnvisited: nextUnvisited,
    bytesToHex: bytesToHex, hexToBytes: hexToBytes
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.harvest = API;
})(typeof window !== "undefined" ? window : globalThis);
