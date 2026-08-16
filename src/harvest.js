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
      session: session || null,
      header: null,               // { K, len, hex } once any header droplet lands
      rings: {},                  // rings[seed][c] = hex — witnessed droplets only
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
     Every CRC-passed droplet enters under its ring's seed; duplicates are
     free (the same wire bytes recur every carousel period and across clips —
     the dedupe key is (ring, c); session identity is the operator's ledger
     choice pre-v3). The header is banked once: header BYTES are identical at
     every header slot of every ring (they depend only on K + payload), so
     one sighting holds them all — the planner prices every header slot as
     held from that moment. A droplet_bits mismatch refuses the absorb
     rather than silently mixing framings. */
  function absorb(ledger, res, profile) {
    var g = F().geom(profile);
    if (ledger.droplet_bits !== g.dropletBits)
      return { added: 0, dup: 0, conflicts: 0, quarantined: 0, mismatch: true };
    var added = 0, dup = 0, conflicts = 0, quarantined = 0, consensus = null;
    if (!res || res.error || !res.emitters)
      return { added: 0, dup: 0, conflicts: 0, quarantined: 0, lagConsensus: null };
    for (var e = 0; e < res.emitters.length; e++) {
      var annuli = res.emitters[e].annuli || [];
      // Lag consensus. Every ring shares the emission clock and the capture
      // start (all profiles run one frames_per_symbol), so within a window
      // every locked ring's lag must agree. A lone disagreeing ring is a
      // chance CRC double-pass wearing a lock — transient before the ledger
      // (a 1/256 residual per decode), but PERSISTENT now: its droplets
      // would enter as first-seen poison and block the real bytes forever.
      // With ≥2 rings in agreement the outlier is quarantined: nothing
      // banked, no lock taken from it (callers gate on lagConsensus).
      var lags = [];
      for (var li = 0; li < annuli.length; li++) {
        var al = annuli[li];
        if (al && al.alignLag != null && al.droplets && al.droplets.length) lags.push(al.alignLag);
      }
      if (lags.length >= 2) {
        var bestN = 0;
        for (var bi = 0; bi < lags.length; bi++) {
          var n = 0;
          for (var bj = 0; bj < lags.length; bj++) if (Math.abs(lags[bj] - lags[bi]) <= 1) n++;
          if (n > bestN || (n === bestN && (consensus === null || lags[bi] < consensus))) { bestN = n; consensus = lags[bi]; }
        }
        if (bestN < 2) consensus = null; // no two rings agree — judge nothing
      }
      for (var ai = 0; ai < annuli.length; ai++) {
        var a = annuli[ai];
        if (!a || !a.droplets || !a.droplets.length) continue;
        if (consensus !== null && a.alignLag != null && Math.abs(a.alignLag - consensus) > 1) {
          quarantined += a.droplets.length;
          continue;
        }
        var pa = annulusByIndex(profile, a.annulus);
        if (!pa) continue;
        var seed = pa.rotation.seed;
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
    return { added: added, dup: dup, conflicts: conflicts, quarantined: quarantined, lagConsensus: consensus };
  }

  /* The ledger in fountain.assemble's shape — the peel never knows whether a
     droplet arrived this window, last window, or from another clip's take. */
  function ringsFor(ledger, profile) {
    return profile.annuli.map(function (a) {
      var seed = a.rotation.seed;
      var held = ledger.rings[seed] || {};
      var droplets = [];
      for (var c in held) droplets.push({ c: +c, bytes: hexToBytes(held[c]) });
      return { seed: seed, droplets: droplets };
    });
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
      var held = ledger.rings[lock.seed] || {};
      var cA = Math.max(0, slotAtFrame(lock, f0));
      var cB = slotAtFrame(lock, f1);
      for (var c = cA; c <= cB; c++) {
        if (held[c] !== undefined) continue;
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
    counts: counts, absorb: absorb, ringsFor: ringsFor, tryPeel: tryPeel,
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
