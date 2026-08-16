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

  var TAU = Math.PI * 2;

  /* Fit one circle edge around center (cx,cy) px: per-angle subpixel crossing
     nearest rExp px (searched within ±tol·rExp), direction "up" (dark→light
     walking outward) or "down". Returns { n, mean, dx, dy } px or null. */
  function fitCircleEdge(img, cx, cy, rExp, dir, tol, NANG) {
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
    if (found < NANG * 0.55) return null;
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
    var edges = null;
    for (var it = 0; it < 3; it++) {
      var e1 = fitCircleEdge(img, cx, cy, 0.4 * R * sPx, "up", 0.35, NANG);
      var e2 = fitCircleEdge(img, cx, cy, 0.6 * R * sPx, "down", 0.28, NANG);
      var e3 = fitCircleEdge(img, cx, cy, 1.0 * R * sPx, "up", 0.22, NANG);
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

    // Stage 2: corners from the corrected seed.
    var wantC = [
      { ux: pl.corners.at, uy: pl.corners.at },
      { ux: -pl.corners.at, uy: pl.corners.at },
      { ux: pl.corners.at, uy: -pl.corners.at },
      { ux: -pl.corners.at, uy: -pl.corners.at }
    ];
    for (var i = 0; i < wantC.length; i++) {
      var w = wantC[i];
      var b = findBullseye(img, Hwork, w.ux, w.uy, pl.corners.r_out, {});
      points.push(b ? { ux: w.ux, uy: w.uy, cx: b.cx, cy: b.cy } : null);
      if (b) { src.push([w.ux, w.uy]); dst.push([b.cx, b.cy]); }
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
    return {
      index: "beacon", layer: -1, beacon: true, edge: "beacon", crossing: "up",
      r0: profile.plate.breaker.r_out,
      rotation: profile.beacon.rotation,
      boundary: { harmonics: profile.beacon.harmonics, amplitudes: profile.beacon.amplitudes, phases_deg: profile.beacon.phases_deg }
    };
  }

  /* Decoded beacon symbols → the control carousel's bytes. Framing per the
     emitter (emission.beaconSymbols): magic 0xB3, len, envelope bytes, CRC8
     over everything before it; the carousel cycles, so scan every byte offset
     in the reassembled absolute stream. Erasures poison their byte. */
  function beaconDecode(decoded, lag, M) {
    var F = (typeof module !== "undefined" && module.exports) ? require("./fountain.js") : global.OC.fountain;
    var bitsPer = M === 4 ? 2 : 1;
    var bits = {};
    var maxPos = -1;
    for (var i = 0; i < decoded.length; i++) {
      var s = decoded[i].s;
      if (s === null || s === undefined) continue;
      var v = M === 4 ? F.fromGray(s) : s;
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
      return { envelope: u8.subarray(2, 2 + len), at: at, len: len };
    }
    return null;
  }

  var API = { findBullseye: findBullseye, plateSolve: plateSolve, fitCircleEdge: fitCircleEdge,
              beaconAnnulus: beaconAnnulus, beaconDecode: beaconDecode };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.plate = API;
})(typeof window !== "undefined" ? window : globalThis);
