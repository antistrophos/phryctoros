/* plate.js — v3 decoder rung 2 (contract §5/§9): the bullseye constellation as
   a per-frame registration instrument, and the beacon ring as a channel.

   The 2:1:2 template read radially from a bullseye's center is three circle
   edges — disc→gap at 0.4·R (up), gap→ring at 0.6·R (down), ring→out at R
   (up). Each edge is fit the way ring registration fits the flat circle: per-
   angle subpixel crossings, first-harmonic center correction (k=1 IS the
   centering error — F5b's diagnostic as corrector), mean radius as scale.
   Three edges × five deployments = fifteen circle fits per frame; the solve
   turns the verified centers into one least-squares homography (the §9
   "per-frame plate solve" rung — the center-shift field across bullseyes is
   the measured perspective k=1, so the DLT absorbs exactly the term the
   static conic can only average).

   The beacon (§5) needs no machinery of its own: the breaker ring's OUTER
   edge is one more boundary-CPM channel — an annulus-shaped descriptor sends
   it through the same sample→DFT→track→demap chain as the data edges, and
   the only beacon-specific code is the byte framing (magic, len, envelope,
   CRC8) laid over the decoded bit stream. */
(function (global) {
  "use strict";

  function G() { return (typeof module !== "undefined" && module.exports) ? require("./geom.js") : global.OC.geom; }
  function SM() { return (typeof module !== "undefined" && module.exports) ? require("./sample.js") : global.OC.sample; }

  var TAU = Math.PI * 2;

  /* Fit one circle edge around center (cx,cy) px: per-angle subpixel crossing
     nearest rExp px (searched within ±tol·rExp), direction "up" (dark→light
     walking outward) or "down". Returns { n, mean, dx, dy } px or null. */
  function fitCircleEdge(img, cx, cy, rExp, dir, tol, NANG, floor) {
    var g = G();
    var norm = img.norm || 1;
    var lo = rExp * (1 - tol), hi = rExp * (1 + tol);
    var step = Math.max(0.35, (hi - lo) / 24);
    var S = Math.max(8, Math.ceil((hi - lo) / step) + 1);
    var found = 0, sum = 0, sxr = 0, syr = 0, sct = 0, sst = 0;
    var prof = new Float64Array(S);
    for (var a = 0; a < NANG; a++) {
      var th = TAU * a / NANG, ct = Math.cos(th), st = Math.sin(th);
      var pLo = Infinity, pHi = -Infinity;
      for (var s = 0; s < S; s++) {
        var r = lo + s * step;
        var v = g.bilinear(img, cx + r * ct, cy + r * st);
        prof[s] = v;
        if (v < pLo) pLo = v; if (v > pHi) pHi = v;
      }
      if ((pHi - pLo) / norm < 0.05) continue;
      var bestIdx = -1, bestSlope = 0;
      var qPrev = (prof[0] - pLo) / (pHi - pLo);
      for (var s2 = 1; s2 < S; s2++) {
        var q = (prof[s2] - pLo) / (pHi - pLo);
        if (dir === "down" ? (qPrev >= 0.5 && q < 0.5) : (qPrev < 0.5 && q >= 0.5)) {
          var slope = dir === "down" ? qPrev - q : q - qPrev;
          if (slope > bestSlope) { bestSlope = slope; bestIdx = s2; }
        }
        qPrev = q;
      }
      if (bestIdx < 0) continue;
      var q0 = (prof[bestIdx - 1] - pLo) / (pHi - pLo), q1 = (prof[bestIdx] - pLo) / (pHi - pLo);
      var frac = (0.5 - q0) / (q1 - q0);
      var rEdge = lo + (bestIdx - 1 + frac) * step;
      found++;
      sum += rEdge;
      sxr += rEdge * ct; syr += rEdge * st; sct += ct; sst += st;
    }
    if (found < NANG * (floor || 0.55)) return null;
    var mean = sum / found;
    // First radial harmonic ≈ center offset (the ring-reg refine identity).
    // Subtract the mean's projection so missing angles (Σcosθ ≠ 0 over a
    // partial circle) don't leak the radius into the offset.
    return { n: found, mean: mean, dx: 2 * (sxr - mean * sct) / found, dy: 2 * (syr - mean * sst) / found };
  }

  /* Find one bullseye near the H-projected unit position. R in units; the
     breaker option verifies the center bullseye's extra ring pair (±30%
     radial tolerance — it wiggles by design). Returns
     { ok, cx, cy, pxPerUnit, edges, breaker } or null. */
  function findBullseye(img, H, ux, uy, R, opts) {
    opts = opts || {};
    var g = G();
    var p0 = g.applyH(H, ux, uy);
    var o = g.applyH(H, 0, 0), u1 = g.applyH(H, 1, 0), u2 = g.applyH(H, 0, 1);
    var sPx = (Math.hypot(u1[0] - o[0], u1[1] - o[1]) + Math.hypot(u2[0] - o[0], u2[1] - o[1])) / 2;
    var cx = p0[0], cy = p0[1];
    var NANG = opts.NANG || 40;
    // A dark surround (screen bezel) can crush the outward-facing half of a
    // peripheral bullseye's fits — the gauge's field42 lesson. Callers near
    // the canvas edge pass a lower floor; the ratio verify stays the guard.
    var eFloor = opts.edgeFloor || 0.55;
    var edges = null;
    for (var it = 0; it < 3; it++) {
      var e1 = fitCircleEdge(img, cx, cy, 0.4 * R * sPx, "up", 0.35, NANG, eFloor);
      var e2 = fitCircleEdge(img, cx, cy, 0.6 * R * sPx, "down", 0.28, NANG, eFloor);
      var e3 = fitCircleEdge(img, cx, cy, 1.0 * R * sPx, "up", 0.22, NANG, eFloor);
      var got = [e1, e2, e3].filter(function (e) { return e; });
      if (got.length < 2) return null;
      var dx = 0, dy = 0;
      for (var i = 0; i < got.length; i++) { dx += got[i].dx; dy += got[i].dy; }
      dx /= got.length; dy /= got.length;
      cx += dx; cy += dy;
      edges = { e1: e1, e2: e2, e3: e3 };
      if (Math.hypot(dx, dy) < 0.05 * sPx) break;
    }
    if (!edges || !edges.e3) return null;
    // radial-symmetry verify: the template's frozen ratios, ±0.08 absolute
    var r10 = edges.e3.mean;
    var ratio1 = edges.e1 ? edges.e1.mean / r10 : null;
    var ratio2 = edges.e2 ? edges.e2.mean / r10 : null;
    if (ratio1 !== null && Math.abs(ratio1 - 0.4) > 0.08) return null;
    if (ratio2 !== null && Math.abs(ratio2 - 0.6) > 0.08) return null;
    if (ratio1 === null && ratio2 === null) return null;
    var pxPerUnit = r10 / R;
    var out = { ok: true, cx: cx, cy: cy, pxPerUnit: pxPerUnit, edges: [edges.e1 ? 1 : 0, edges.e2 ? 1 : 0, 1] };
    if (opts.breaker) {
      // the wiggling pair: presence check at ±30% — annular mean inside the
      // ring's worst reach vs the quiet gap beyond it
      var bIn = opts.breaker.r_in * pxPerUnit, bOut = opts.breaker.r_out * pxPerUnit;
      var mid = (bIn + bOut) / 2, gap = (opts.breaker.r_out + 0.09) * pxPerUnit;
      var sm = 0, sg = 0, n = 0;
      for (var a2 = 0; a2 < NANG; a2++) {
        var th2 = TAU * a2 / NANG;
        sm += g.bilinear(img, cx + mid * Math.cos(th2), cy + mid * Math.sin(th2));
        sg += g.bilinear(img, cx + gap * Math.cos(th2), cy + gap * Math.sin(th2));
        n++;
      }
      out.breaker = (sg - sm) / n / (img.norm || 1) > 0.05;
    }
    return out;
  }

  /* The §9 plate solve: measure every deployed bullseye, least-squares a
     fresh homography from the verified centers. HIERARCHICAL, because the
     seed H's scale error is levered by the corner arm (2% scale × 2.65 u ×
     166 px ≈ 9 px of corner displacement — past the edge-fit windows): fit
     the CENTER bullseye first (small arm, and §5's crop-survival anchor),
     fold its measured center + px-per-unit into the working H, then seed the
     corners — their residual is rotation/perspective only. Needs ≥ minPoints
     (default 4). Returns { H, used, points, residPx } or null. */
  function plateSolve(img, H, profile, opts) {
    opts = opts || {};
    var g = G();
    var pl = profile.plate;
    var src = [], dst = [], points = [];

    // Stage 1: center → similarity pre-correction of the working H.
    var c0 = findBullseye(img, H, 0, 0, pl.center.r_out, { breaker: pl.breaker });
    points.push(c0 ? { ux: 0, uy: 0, cx: c0.cx, cy: c0.cy, breaker: c0.breaker } : null);
    var Hwork = H;
    if (c0) {
      src.push([0, 0]); dst.push([c0.cx, c0.cy]);
      var o = g.applyH(H, 0, 0), u1 = g.applyH(H, 1, 0), u2 = g.applyH(H, 0, 1);
      var sH = (Math.hypot(u1[0] - o[0], u1[1] - o[1]) + Math.hypot(u2[0] - o[0], u2[1] - o[1])) / 2;
      var k = c0.pxPerUnit / sH;
      Hwork = [H[0] * k, H[1] * k, H[2], H[3] * k, H[4] * k, H[5], H[6] * k, H[7] * k, H[8]];
      var oW = g.applyH(Hwork, 0, 0);
      Hwork[2] += c0.cx - oW[0];
      Hwork[5] += c0.cy - oW[1];
    }

    // Stage 1b — the FLAT GAUGE as stage-1's substitute when the center
    // bullseye is absent (qr_persistent: the QR sits there). The first anchor
    // attempt (H-derived point, fires after 3 corners verify) failed in the
    // field at 0/601 — the failure was UPSTREAM: without a measured
    // center+scale, corners seed from the raw static H and ≤2 verify. §4's
    // unmodulated outer circle is present in every variant and radially
    // symmetric: fit it per frame (k=1 center + mean-radius scale, the
    // ring-reg refine identity), fold the measurement into Hwork, THEN seek
    // corners — and its measured center becomes the fifth correspondence.
    var gaugeC = null;
    if (!c0 && opts.hCenter) {
      var flatA = { r0: profile.flat_circle_r, crossing: "up",
                    boundary: { harmonics: [], amplitudes: [0.06], phases_deg: [] } };
      var Hg = H;
      for (var gi = 0; gi < 3; gi++) {
        var sb = SM().sampleBoundary(img, Hg, flatA);
        // Floor 0.35, not 0.5: with a dark screen surround the gray margin
        // beyond 3.00 is a ~5 px sliver and bezel-adjacent angles lose the
        // crossing — field42 measured 41% coverage with mean 2.988 (accurate
        // where found). The mean-sanity gate below keeps a low-coverage
        // decoy arc from impersonating the gauge.
        if (sb.found < sb.N * 0.35) { Hg = null; break; }
        var n9 = 0, mean9 = 0, sct9 = 0, sst9 = 0, sxr9 = 0, syr9 = 0;
        for (var i9 = 0; i9 < sb.N; i9++) {
          if (isNaN(sb.r[i9])) continue;
          var th9 = TAU * i9 / sb.N, ct9 = Math.cos(th9), st9 = Math.sin(th9);
          mean9 += sb.r[i9]; sxr9 += sb.r[i9] * ct9; syr9 += sb.r[i9] * st9;
          sct9 += ct9; sst9 += st9; n9++;
        }
        mean9 /= n9;
        if (Math.abs(mean9 - profile.flat_circle_r) > 0.2) { Hg = null; break; }
        var dxU = 2 * (sxr9 - mean9 * sct9) / n9, dyU = 2 * (syr9 - mean9 * sst9) / n9;
        var kG = mean9 / profile.flat_circle_r;
        // compose Hg ∘ [k,0,dx; 0,k,dy; 0,0,1] — unit-domain scale+shift
        Hg = [Hg[0] * kG, Hg[1] * kG, Hg[0] * dxU + Hg[1] * dyU + Hg[2],
              Hg[3] * kG, Hg[4] * kG, Hg[3] * dxU + Hg[4] * dyU + Hg[5],
              Hg[6] * kG, Hg[7] * kG, Hg[6] * dxU + Hg[7] * dyU + Hg[8]];
        if (Math.abs(dxU) < 0.003 && Math.abs(dyU) < 0.003 && Math.abs(kG - 1) < 0.003) break;
      }
      if (Hg) {
        Hwork = Hg;
        var gp = g.applyH(Hg, 0, 0);
        gaugeC = { cx: gp[0], cy: gp[1] };
      }
    }

    // Stage 2: corners from the corrected seed.
    var wantC = [
      { ux: pl.corners.at, uy: pl.corners.at },
      { ux: -pl.corners.at, uy: pl.corners.at },
      { ux: pl.corners.at, uy: -pl.corners.at },
      { ux: -pl.corners.at, uy: -pl.corners.at }
    ];
    for (var i = 0; i < wantC.length; i++) {
      var w = wantC[i];
      var b = findBullseye(img, Hwork, w.ux, w.uy, pl.corners.r_out, { edgeFloor: 0.4 });
      points.push(b ? { ux: w.ux, uy: w.uy, cx: b.cx, cy: b.cy } : null);
      if (b) { src.push([w.ux, w.uy]); dst.push([b.cx, b.cy]); }
    }
    // The gauge center as the fifth correspondence when a corner is missing:
    // MEASURED (the flat-circle k=1 fit), not H-derived. Four verified
    // corners still solve alone — no center drag when none is needed.
    if (gaugeC && src.length === (opts.minPoints || 4) - 1) {
      src.unshift([0, 0]); dst.unshift([gaugeC.cx, gaugeC.cy]);
      points[0] = { ux: 0, uy: 0, cx: gaugeC.cx, cy: gaugeC.cy, anchor: "gauge" };
    }
    if (src.length < (opts.minPoints || 4)) return null;
    var Hs = g.homographyFromPointsN(src, dst);
    if (!Hs) return null;
    var resid = 0;
    for (var j = 0; j < src.length; j++) {
      var p = g.applyH(Hs, src[j][0], src[j][1]);
      resid += Math.hypot(p[0] - dst[j][0], p[1] - dst[j][1]);
    }
    return { H: Hs, used: src.length, points: points, residPx: resid / src.length };
  }

  /* The beacon as a channel: an annulus-shaped descriptor for the breaker
     ring's OUTER edge — the whole existing chain (sampleWindow, sampleBoundary
     "up", DFT, trackPhase, findAlignment on the all-flips preamble, demap at
     M=2/4) runs it unmodified. layer −1 keeps it out of every layer lookup. */
  function beaconAnnulus(profile) {
    // D-ring ruling 1b: at placement "a-inner" the control channel is band
    // A's inner boundary (r0 1.05, light→dark walking outward = crossing
    // "down", per tile); the frozen default stays the breaker pair's outer
    // edge on the designated tile. Same chain either way — only the geometry
    // descriptor moves.
    if (profile.beacon.placement === "a-inner")
      return {
        index: "beacon", layer: -1, beacon: true, edge: "beacon", crossing: "down",
        r0: profile.bands[0].lo.fixed,
        rotation: profile.beacon.rotation,
        boundary: { harmonics: profile.beacon.harmonics, amplitudes: profile.beacon.amplitudes, phases_deg: profile.beacon.phases_deg }
      };
    return {
      index: "beacon", layer: -1, beacon: true, edge: "beacon", crossing: "up",
      r0: profile.plate.breaker.r_out,
      rotation: profile.beacon.rotation,
      boundary: { harmonics: profile.beacon.harmonics, amplitudes: profile.beacon.amplitudes, phases_deg: profile.beacon.phases_deg }
    };
  }

  /* Decoded beacon symbols → EVERY CRC8-passing control frame in the window.
     Framing per the emitter (emission.beaconSymbols): magic 0xB3, len,
     envelope bytes, CRC8 over everything before it; the carousel cycles, so
     scan every byte offset in the reassembled absolute stream. Erasures
     poison their byte. `lag` only matters modulo the byte grid (8 bits at
     M=2, 4 symbols at M=4) — the magic scan absorbs the rest — which is what
     lets beaconAlign frame a capture that never saw the preamble. Frames
     come back in stream order; each is { envelope, at, len }. */
  function beaconBitsPer(M) { return M === 8 ? 3 : (M === 4 ? 2 : 1); }

  /* Reassemble the decoded symbol stream into control BYTES (null where any
     contributing symbol was erased). `lag` matters modulo the byte grid only. */
  function beaconBytes(decoded, lag, M) {
    var F = (typeof module !== "undefined" && module.exports) ? require("./fountain.js") : global.OC.fountain;
    var bitsPer = beaconBitsPer(M);
    var bits = {};
    var maxPos = -1;
    for (var i = 0; i < decoded.length; i++) {
      var s = decoded[i].s;
      if (s === null || s === undefined) continue;
      var v = M > 2 ? F.fromGray(s) : s;
      var pos = (i + lag) * bitsPer;
      for (var b = 0; b < bitsPer; b++) {
        bits[pos + b] = (v >> (bitsPer - 1 - b)) & 1;
        if (pos + b > maxPos) maxPos = pos + b;
      }
    }
    var nBytes = Math.floor((maxPos + 1) / 8);
    var bytes = new Array(nBytes);
    for (var k = 0; k < nBytes; k++) {
      var val = 0, ok = true;
      for (var b2 = 0; b2 < 8; b2++) {
        var bit = bits[k * 8 + b2];
        if (bit === undefined) { ok = false; break; }
        val = (val << 1) | bit;
      }
      bytes[k] = ok ? val : null;
    }
    return bytes;
  }

  function beaconFrames(decoded, lag, M) {
    var F = (typeof module !== "undefined" && module.exports) ? require("./fountain.js") : global.OC.fountain;
    var bytes = beaconBytes(decoded, lag, M);
    var nBytes = bytes.length;
    var out = [];
    for (var at = 0; at + 2 < nBytes; at++) {
      if (bytes[at] !== 0xB3) continue;
      var len = bytes[at + 1];
      if (len === null || len < 1 || len > 64) continue; // bounds guarded in the copy loop
      var frame = [];
      var whole = true;
      for (var m = 0; m < 2 + len + 1; m++) {
        if (at + m >= nBytes || bytes[at + m] === null) { whole = false; break; }
        frame.push(bytes[at + m]);
      }
      if (!whole) continue;
      var u8 = new Uint8Array(frame);
      if (F.crc8(u8, u8.length - 1) !== u8[u8.length - 1]) continue;
      out.push({ envelope: u8.subarray(2, 2 + len), at: at, len: len });
    }
    return out;
  }

  /* CHUNKED framing scan — D-ring ruling 2 (emission.beaconChunkStream is the
     writer): tag chunks [0xC0][crc16][crc8] and data chunks [0xC0|idx 1–5]
     [4 envelope bytes][crc8]. Chunks assemble from ANYWHERE in the stream —
     chunking is the fold done at the emitter — so a window covering one cycle
     in pieces still yields the envelope. Per-chunk check is only magic nibble
     + CRC8 (12 bits), so nothing here is trusted alone: the caller accepts a
     chunked alignment ONLY when the assembled envelope passes its CRC16 seal,
     and the fast tag is exactly that seal (bytes 18–19), so tag sightings are
     confirmed the moment assembly succeeds. Same-index chunks that disagree
     mark the slot conflicted (first-seen kept — assembly then fails the seal
     unless the first was right; the counters surface it). */
  function beaconChunkScan(decoded, lag, M) {
    var F = (typeof module !== "undefined" && module.exports) ? require("./fountain.js") : global.OC.fountain;
    var bytes = beaconBytes(decoded, lag, M);
    var nBytes = bytes.length;
    var data = {}, counts = [0, 0, 0, 0, 0, 0], conflicts = 0, tags = {};
    for (var at = 0; at < nBytes; at++) {
      var h = bytes[at];
      if (h === null || (h & 0xF0) !== 0xC0) continue;
      var idx = h & 15;
      if (idx === 0) {
        if (at + 3 >= nBytes) continue;
        var t = [bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]];
        if (t.some(function (x) { return x === null; })) continue;
        var tu = new Uint8Array(t);
        if (F.crc8(tu, 3) !== tu[3]) continue;
        var tagVal = (tu[1] << 8) | tu[2];
        tags[tagVal] = (tags[tagVal] || 0) + 1;
        counts[0]++;
      } else if (idx <= 5) {
        if (at + 5 >= nBytes) continue;
        var d = [bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3], bytes[at + 4], bytes[at + 5]];
        if (d.some(function (x) { return x === null; })) continue;
        var du = new Uint8Array(d);
        if (F.crc8(du, 5) !== du[5]) continue;
        var key = "" + idx;
        if (data[key]) {
          var samePayload = true;
          for (var q = 1; q <= 4; q++) if (data[key][q] !== du[q]) { samePayload = false; break; }
          if (!samePayload) conflicts++;
        } else data[key] = du;
        counts[idx]++;
      }
    }
    var envelope = null, tag = null;
    if (data["1"] && data["2"] && data["3"] && data["4"] && data["5"]) {
      var env = new Uint8Array(20);
      for (var c = 1; c <= 5; c++) for (var j = 0; j < 4; j++) env[4 * (c - 1) + j] = data["" + c][1 + j];
      var crc = F.crc16(env.subarray(0, 18));
      if (((env[18] << 8) | env[19]) === crc) { envelope = env; tag = crc; }
    }
    var bestTag = null, bestTagN = 0;
    for (var tv in tags) if (tags[tv] > bestTagN) { bestTagN = tags[tv]; bestTag = +tv; }
    return { envelope: envelope, tag: tag, sealed: envelope !== null,
             tagSeen: bestTag, tagSightings: bestTagN,
             tagMatchesSeal: envelope !== null && bestTag !== null && bestTag === tag,
             chunkCounts: counts, conflicts: conflicts };
  }

  /* First framed envelope in the window (the original single-frame read). */
  function beaconDecode(decoded, lag, M) {
    var fr = beaconFrames(decoded, lag, M);
    return fr.length ? fr[0] : null;
  }

  /* The frames an alignment actually yields: a FOLDED alignment (beaconAlign
     below) carries its synthesised carousel ring, and the frame lives in the
     doubled ring, not in the contiguous stream; anything else reads the
     stream at the alignment's bit phase. */
  function beaconFramesFor(decoded, align, M) {
    if (align && align.framing === "chunked") {
      var scan = beaconChunkScan(decoded, align.lag, M);
      return scan.sealed ? [{ envelope: scan.envelope, at: null, chunked: true,
                              tag: scan.tag, tagSightings: scan.tagSightings }] : [];
    }
    if (align && align.folded && align.ring) {
      var P = align.ring.length, doubled = new Array(2 * P);
      for (var j = 0; j < 2 * P; j++) {
        var sv = align.ring[j % P];
        doubled[j] = { s: (sv === undefined || sv === null) ? null : sv };
      }
      return beaconFrames(doubled, align.lag, M);
    }
    return beaconFrames(decoded, align ? align.lag : 0, M);
  }

  /* §6 envelope, internal format v1 (emission.envelopeBytes is the writer):
     version · family · flags (bit0 = high-rate) · session32 · K · len ·
     pcrc16 · capability · freeze (ds) · loop (s) · tiling · tile · grid ·
     CRC16 over bytes 0–17. Returns the fields, or null when the bytes are
     not a sealed v1 envelope (wrong length, version, or CRC).
     tile/grid (D-ring ruling 4, 2026-08-23): b[16] = the index of the tile
     carrying this copy; b[17] = the panel's lattice (cols<<4 | rows), 0
     meaning single-panel — pre-ruling envelopes wrote zeros, which parse
     identically under the definition. The scope is ONE panel: tiles pool
     only when they share session32 AND hold a valid slot in that session's
     grid; separate screens or grids are separate sessions and never tile
     together by default. */
  function parseEnvelope(env) {
    var F = (typeof module !== "undefined" && module.exports) ? require("./fountain.js") : global.OC.fountain;
    if (!env || env.length !== 20 || env[0] !== 1) return null;
    var crc = F.crc16(env.subarray ? env.subarray(0, 18) : Array.prototype.slice.call(env, 0, 18));
    if (((env[18] << 8) | env[19]) !== crc) return null;
    return {
      version: env[0], family: env[1], flags: env[2],
      preset: (env[2] & 1) ? "high-rate" : "resilient",
      session32: ((env[3] << 24) | (env[4] << 16) | (env[5] << 8) | env[6]) >>> 0,
      K: env[7], len: (env[8] << 8) | env[9], pcrc: (env[10] << 8) | env[11],
      capability: env[12], freeze_s: env[13] / 10, loop_s: env[14], tiling: env[15],
      tile: env[16],
      grid: env[17] === 0 ? { cols: 1, rows: 1 } : { cols: env[17] >> 4, rows: env[17] & 15 }
    };
  }

  /* FRAMING-BASED BEACON ALIGNER — the mid-loop join. The control carousel
     is periodic and self-delimiting, so a capture that never saw the preamble
     can still frame it: the data rings' crcAlign applied to a fixed frame.
     Two unknowns, as always — the sub-symbol frame offset o ∈ [0, F) and the
     bit phase (the byte grid: 8 phases at M=2, 4 at M=4; any whole-byte lag
     is absorbed by the magic scan). Decode at each offset, try each phase,
     collect CRC8-passing frames, and ACCEPT only on evidence stronger than
     one 16-bit pass (magic + CRC8 is a 1-in-65536 chance PER candidate
     position and a window tries ~10³ of them): a frame that also passes the
     envelope's own CRC16 (24 check bits — the v1 envelope carries it), or
     ≥2 frames with identical bytes (the carousel repeating), or opts.verify
     saying yes. opts.minFrames = 1 lowers the bar explicitly (tests with
     synthetic short envelopes). Score = passing frames, verified first;
     ties break to the lower offset. Returns { offset, lag, score, max,
     method: "framed", verified } or null — lag is the BIT PHASE, which is all
     beaconDecode needs, not an emission-symbol count. */
  function beaconAlign(track, annulus, profile, baseOverride, opts) {
    var demap = (typeof module !== "undefined" && module.exports) ? require("./demap.js") : global.OC.demap;
    opts = opts || {};
    var F = annulus.rotation.frames_per_symbol, M = annulus.rotation.M;
    // Bit phases that change the byte grid: 8 at 1 bit/symbol, 4 at 2 (lag
    // parity beyond that repeats the grid), 8 again at 3 (3 and 8 coprime —
    // lag 0..7 walks every bit shift).
    var bitsPer = beaconBitsPer(M), phases = bitsPer === 2 ? 4 : 8;
    var base = (baseOverride !== undefined && baseOverride !== null) ? baseOverride : (track.firstValid || 0);
    var verify = opts.verify || function (env) { return !!parseEnvelope(env); };
    var minFrames = opts.minFrames || 2;
    // THE FOLD. The carousel is periodic, so a window holding ≥1 period has
    // seen EVERY carousel position even when no single frame lies contiguous
    // inside it (the 5 ft field clip: 246 clean symbols, period 184, no
    // frame — the frame start fell past symbol 62). Fold the symbols modulo
    // the period, erase positions whose repeats disagree, and scan the
    // doubled ring — a frame starting anywhere is then contiguous. Needs the
    // period: the v1 envelope frames as 23 bytes (opts.frameBytes overrides,
    // ≤ 0 disables); a wrong period merely yields no frame. Folded frames are
    // SYNTHESISED, so they are accepted only when verify says yes (the CRC16
    // seal) — repeat-agreement is reported, not trusted alone.
    var frameBytes = opts.frameBytes !== undefined ? opts.frameBytes : 23;
    var Psym = frameBytes > 0 ? Math.round(frameBytes * 8 / bitsPer) : 0;
    var best = null;
    var consider = function (cand) {
      if (!best || (cand.verified && !best.verified) ||
          (cand.verified === best.verified && !cand.folded && best.folded) ||
          (cand.verified === best.verified && !!cand.folded === !!best.folded && cand.score > best.score))
        best = cand;
    };
    for (var oi = 0; oi < F; oi++) {
      var off = base + oi;
      var decoded = demap.decode(track, annulus, profile, off);
      if (!decoded.length) continue;
      for (var ph = 0; ph < phases; ph++) {
        var frames = beaconFrames(decoded, ph, M);
        if (frames.length) {
          var verified = false, agree = 1;
          for (var q = 0; q < frames.length; q++) {
            if (verify(frames[q].envelope)) { verified = true; break; }
          }
          if (!verified && frames.length >= 2) {
            // identical bytes across repeats — the carousel's own redundancy
            var counts = {};
            for (var r = 0; r < frames.length; r++) {
              var key = Array.prototype.join.call(frames[r].envelope, ",");
              counts[key] = (counts[key] || 0) + 1;
              if (counts[key] > agree) agree = counts[key];
            }
          }
          if (verified || agree >= minFrames)
            consider({ offset: off, lag: ph, score: frames.length, max: decoded.length,
                       method: "framed", framing: "frame", verified: verified });
        }
        // Chunked framing (ruling 2) — scanned at every candidate alignment
        // regardless of what the profile declares, so the receiver never has
        // to know which framing the emitter runs. A chunked alignment is
        // accepted ONLY sealed (per-chunk checks are 12 bits — never alone).
        var scan = beaconChunkScan(decoded, ph, M);
        if (scan.sealed)
          consider({ offset: off, lag: ph, score: scan.chunkCounts.reduce(function (a, b) { return a + b; }, 0),
                     max: decoded.length, method: "framed", framing: "chunked", verified: true,
                     tag: scan.tag, tagSightings: scan.tagSightings, chunkConflicts: scan.conflicts });
      }
      if (best && best.offset === off && !best.folded) continue; // contiguous frame at this offset — no fold needed
      if (Psym > 0 && (frameBytes * 8) % bitsPer === 0 && decoded.length >= Psym) {
        var ring = new Array(Psym), seen = 0, compared = 0, agreed = 0;
        for (var di = 0; di < decoded.length; di++) {
          var sv = decoded[di].s;
          if (sv === null || sv === undefined) continue;
          var pos = di % Psym;
          if (ring[pos] === undefined) { ring[pos] = sv; seen++; }
          else if (ring[pos] !== null) {
            compared++;
            if (ring[pos] === sv) agreed++; else ring[pos] = null; // repeats disagree → erase
          }
        }
        if (seen < Psym) continue;
        var doubled = new Array(2 * Psym);
        for (var dj = 0; dj < 2 * Psym; dj++) doubled[dj] = { s: ring[dj % Psym] === undefined ? null : ring[dj % Psym] };
        for (var ph2 = 0; ph2 < phases; ph2++) {
          var ff = beaconFrames(doubled, ph2, M);
          for (var fq = 0; fq < ff.length; fq++) {
            if (!verify(ff[fq].envelope)) continue;
            consider({ offset: off, lag: ph2, score: 1, max: decoded.length, method: "framed", framing: "frame", verified: true,
                       folded: true, foldAgree: compared ? Math.round(1000 * agreed / compared) / 1000 : null, foldCompared: compared,
                       ring: ring });
            break;
          }
        }
      }
    }
    return best;
  }

  var API = { findBullseye: findBullseye, plateSolve: plateSolve, fitCircleEdge: fitCircleEdge,
              beaconAnnulus: beaconAnnulus, beaconDecode: beaconDecode, beaconFrames: beaconFrames,
              beaconBytes: beaconBytes, beaconChunkScan: beaconChunkScan,
              beaconFramesFor: beaconFramesFor, beaconAlign: beaconAlign, parseEnvelope: parseEnvelope };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.plate = API;
})(typeof window !== "undefined" ? window : globalThis);
