/* separate.js — stage 7: rotation φ from coefficient phases, data from magnitudes.
   arg(c_k) = ψ_k − k·φ, so each harmonic votes for φ with a 2π/k ambiguity.
   The LADDER (review F5b/F5c executable): k=1 anchors the branch (its vote is
   unambiguous over a full turn — and it is treated as an ANCHOR, not a precision
   source, because k=1 is degenerate with registration error); higher k are then
   branch-resolved near the running estimate and dominate precision with weight
   (k·|c_k|)². Frame-to-frame prediction (previous φ + nominal advance) keeps the
   track unwrapped; gaps are bridged by nominal only and flagged, so symbols that
   span a gap become erasures downstream, not silent errors. */
(function (global) {
  "use strict";

  var TAU = Math.PI * 2;

  function wrap(x) { x = x % TAU; if (x > Math.PI) x -= TAU; if (x <= -Math.PI) x += TAU; return x; }

  /* Absolute anchor for the first frame WITHOUT k=1: enumerate the lowest usable
     harmonic's branch candidates over one turn and pick the one the next harmonic
     agrees with (a coprime pair, e.g. k=2 & k=3, is unambiguous over the full
     turn). The absolute offset only has to be self-consistent — differential
     decoding absorbs any constant. Falls back to k=1 when nothing else exists. */
  function initialAnchor(spec, ks, psis) {
    var iA = -1, iB = -1;
    for (var j = 0; j < ks.length; j++) {
      if (ks[j] < 2 || spec.mag[ks[j]] <= 0) continue;
      if (iA < 0) iA = j;
      else if (iB < 0) { iB = j; break; }
    }
    if (iA < 0) {
      var j1 = ks.indexOf(1);
      return j1 >= 0 ? wrap(psis[j1] - spec.arg[1]) : 0;
    }
    var kA = ks[iA], tA = psis[iA] - spec.arg[kA];
    if (iB < 0) return wrap((tA) / kA);
    var kB = ks[iB], tB = psis[iB] - spec.arg[kB];
    var best = null;
    for (var m = 0; m < kA; m++) {
      var cand = (tA + TAU * m) / kA;
      var mB = Math.round((kB * cand - tB) / TAU);
      var candB = (tB + TAU * mB) / kB;
      var err = Math.abs(wrap(candB - cand));
      if (!best || err < best.err) best = { cand: cand, err: err };
    }
    return wrap(best.cand);
  }

  /* series: array of { f, spec } (spec from transform.dft; null for invalid frames)
     Returns { phi: Float64Array indexed by frame (NaN where unknown), gapAfter: Set,
               meanMag[k], quality[] } */
  function trackPhase(series, annulus, profile) {
    var fps = profile.frame_rate_hz;
    var omega = TAU * annulus.rotation.nominal_hz;
    var ks = annulus.boundary.harmonics;
    var psis = annulus.boundary.phases_deg.map(function (d) { return d * Math.PI / 180; });

    var maxF = 0;
    for (var i = 0; i < series.length; i++) if (series[i] && series[i].f > maxF) maxF = series[i].f;
    var phi = new Float64Array(maxF + 1);
    for (var z = 0; z <= maxF; z++) phi[z] = NaN;

    var gapAfter = {};
    var magSum = {}, magN = 0;
    var prevF = -1, prevPhi = 0;
    var firstValid = -1;

    for (var s = 0; s < series.length; s++) {
      var fr = series[s];
      if (!fr || !fr.spec) continue;
      var f = fr.f, spec = fr.spec;
      if (firstValid < 0) firstValid = f;
      var pred;
      if (prevF < 0) {
        pred = initialAnchor(spec, ks, psis);
      } else if (f - prevF > 1) {
        gapAfter[prevF] = f - prevF;
        // Post-gap re-acquisition: nominal-only continuity carries up to 45°·gap of
        // deviation surprise — at gap 2 that is k=2's whole branch window. Re-anchor
        // absolutely (joint k≥2 vote), keeping only the turn count from continuity.
        var cont = prevPhi + omega * (f - prevF) / fps;
        var anch = initialAnchor(spec, ks, psis);
        pred = anch + TAU * Math.round((cont - anch) / TAU);
      } else {
        pred = prevPhi + omega * (f - prevF) / fps;
      }
      // Ladder: PREDICTION anchors (worst per-frame surprise is the deviation,
      // |Δ|max/F = 45° < k=2's ±90° branch window); then ascending k ≥ 2 blended
      // by (k·|c_k|)². k=1 is EXCLUDED from estimation — field-validated F5b:
      // on real footage the k=1 coefficient is the vector sum of the emitted
      // harmonic and the wandering centering error (handheld sway, affine
      // residual), and as an anchor it poisons every branch above it. It stays
      // measured (meanMag) as the centering-error diagnostic.
      var est = pred, W = 0.0001 /* tiny prior on the prediction */;
      // k=1 as BRANCH GUIDE only — zero weight in the estimate (F5b: its
      // centering noise poisons precision) but full-turn-unambiguous, so it
      // safely steers branch selection when k·Δφ per frame approaches the
      // ±180°/k window (v2's fast outer base ring exposed this: k=2 targets
      // can move ~160°/frame at 1.5 Hz + deviation, and prediction alone
      // under-tracks into a frozen attractor).
      var jg = ks.indexOf(1);
      if (jg >= 0 && spec.mag[1] > 0) {
        var tg = psis[jg] - spec.arg[1];
        var mg = Math.round((pred - tg) / TAU);
        est = (pred + (tg + TAU * mg)) / 2;
      }
      var estAcc = est * W;
      var usable = 0;
      for (var j = 0; j < ks.length; j++) {
        var k = ks[j], mag = spec.mag[k];
        if (k === 1 || mag <= 0) continue;
        var target = psis[j] - spec.arg[k]; // = k·φ + 2π·m
        var cur = estAcc / W;
        var m = Math.round((k * cur - target) / TAU);
        var cand = (target + TAU * m) / k;
        var w = Math.pow(k * mag, 2);
        estAcc += cand * w; W += w; usable++;
      }
      if (!usable) { // harmonics-[1]-only profile: k=1 is all there is
        var j1 = ks.indexOf(1);
        if (j1 >= 0 && spec.mag[1] > 0) {
          var t1 = psis[j1] - spec.arg[1];
          var m1 = Math.round((est - t1) / TAU);
          estAcc += (t1 + TAU * m1) * Math.pow(spec.mag[1], 2); W += Math.pow(spec.mag[1], 2);
        }
      }
      est = estAcc / W;
      phi[f] = est;
      prevF = f; prevPhi = est;

      for (var j2 = 0; j2 < ks.length; j2++) {
        magSum[ks[j2]] = (magSum[ks[j2]] || 0) + spec.mag[ks[j2]];
      }
      magN++;
    }

    var meanMag = {};
    for (var k2 in magSum) meanMag[k2] = magSum[k2] / Math.max(1, magN);
    return { phi: phi, gapAfter: gapAfter, meanMag: meanMag, frames: magN, maxF: maxF, firstValid: firstValid < 0 ? 0 : firstValid };
  }

  var API = { trackPhase: trackPhase, wrap: wrap };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.separate = API;
})(typeof window !== "undefined" ? window : globalThis);
