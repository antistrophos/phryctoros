/* sample.js — stages 4–5: per-annulus radial profiles → boundary contour r(θ).
   No edge detection, no contour tracing (spec §9): sample radially through the
   homography, SELF-NORMALIZE the profile (review F9: an absolute threshold would
   quietly reintroduce intensity dependence), and locate the 0.5 crossing subpixel.
   Each angle also records its source ROW — the rolling-shutter timestamp hook
   (review F2): carried now, corrected when Phase 0 shows it matters. */
(function (global) {
  "use strict";

  function G() { return (typeof module !== "undefined" && module.exports) ? require("./geom.js") : global.OC.geom; }
  function PR() { return (typeof module !== "undefined" && module.exports) ? require("./profile.js") : global.OC.profile; }

  var TAU = Math.PI * 2;

  /* Pixels per canonical unit, measured from H itself. */
  function unitScale(H) {
    var g = G();
    var o = g.applyH(H, 0, 0), ux = g.applyH(H, 1, 0), uy = g.applyH(H, 0, 1);
    return (Math.hypot(ux[0] - o[0], ux[1] - o[1]) + Math.hypot(uy[0] - o[0], uy[1] - o[1])) / 2;
  }

  /* Sample one annulus's outer boundary at N angles.
     Returns { r: Float64Array(N) (NaN where no edge), found, contrast, rowMin, rowMax }. */
  function sampleBoundary(img, H, annulus, opts) {
    opts = opts || {};
    var g = G();
    var N = opts.N || 256;
    var win = PR().sampleWindow(annulus);
    var scalePx = opts.scalePx || unitScale(H);
    var drUnits = Math.max(0.35 / scalePx, (win.hi - win.lo) / 240);
    var S = Math.max(12, Math.ceil((win.hi - win.lo) / drUnits) + 1);

    var r = new Float64Array(N);
    var found = 0, contrastSum = 0, rowMin = Infinity, rowMax = -Infinity;
    var prof = new Float64Array(S);
    var valScale = img.norm || 1; // Uint8 camera frames carry norm:255; synthetic Float32 default 1

    for (var i = 0; i < N; i++) {
      var th = TAU * i / N;
      var cx = Math.cos(th), sy = Math.sin(th);
      var lo = Infinity, hi = -Infinity;
      for (var s = 0; s < S; s++) {
        var rr = win.lo + s * drUnits;
        var pt = g.applyH(H, rr * cx, rr * sy);
        var v = g.bilinear(img, pt[0], pt[1]);
        prof[s] = v;
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
      var contrast = (hi - lo) / valScale;
      contrastSum += contrast;
      if (contrast < 0.03) { r[i] = NaN; continue; }

      // Light 3-tap smooth, then normalized upward crossing with the strongest slope.
      var bestIdx = -1, bestSlope = 0;
      var qPrev = norm(prof, 0, lo, hi);
      for (var s2 = 1; s2 < S; s2++) {
        var q = norm(prof, s2, lo, hi);
        if (qPrev < 0.5 && q >= 0.5) {
          var slope = q - qPrev;
          if (slope > bestSlope) { bestSlope = slope; bestIdx = s2; }
        }
        qPrev = q;
      }
      if (bestIdx < 0) { r[i] = NaN; continue; }
      var q0 = norm(prof, bestIdx - 1, lo, hi), q1 = norm(prof, bestIdx, lo, hi);
      var frac = (0.5 - q0) / (q1 - q0);
      var rEdge = win.lo + (bestIdx - 1 + frac) * drUnits;
      r[i] = rEdge;
      found++;
      var ptE = g.applyH(H, rEdge * cx, rEdge * sy);
      if (ptE[1] < rowMin) rowMin = ptE[1];
      if (ptE[1] > rowMax) rowMax = ptE[1];
    }

    return { r: r, found: found, N: N, contrast: contrastSum / N, rowMin: rowMin, rowMax: rowMax };
  }

  function norm(prof, s, lo, hi) {
    var a = prof[Math.max(0, s - 1)], b = prof[s], c = prof[Math.min(prof.length - 1, s + 1)];
    return (((a + 2 * b + c) / 4) - lo) / (hi - lo);
  }

  /* Fill NaN gaps by circular linear interpolation; returns fraction filled or -1 if hopeless. */
  function fillGaps(r) {
    var N = r.length, nan = 0;
    for (var i = 0; i < N; i++) if (isNaN(r[i])) nan++;
    if (nan === 0) return 0;
    if (nan > N * 0.2) return -1;
    for (var j = 0; j < N; j++) {
      if (!isNaN(r[j])) continue;
      var a = j, b = j;
      var guard = 0;
      while (isNaN(r[(a + N - 1) % N]) && guard++ < N) a = (a + N - 1) % N;
      guard = 0;
      while (isNaN(r[(b + 1) % N]) && guard++ < N) b = (b + 1) % N;
      var pa = (a + N - 1) % N, pb = (b + 1) % N;
      var span = ((b - a + N) % N) + 2;
      var t = ((j - a + N) % N) + 1;
      r[j] = r[pa] + (r[pb] - r[pa]) * (t / span);
    }
    return nan / N;
  }

  var API = { sampleBoundary: sampleBoundary, fillGaps: fillGaps, unitScale: unitScale };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.sample = API;
})(typeof window !== "undefined" ? window : globalThis);
