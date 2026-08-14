/* rowtime.js — stage 6b: the F2 row-time regression (the TEAR repair).
   A capture frame that straddles an emission-frame transition shows emission
   frame f on one side of a seam row and f±1 on the other (panel scanout ×
   rolling shutter — field-clip-2's named mechanism). The full-circle DFT of
   such a frame BLENDS the two phases; that bias is the residual tear class
   the duplicate selector can't remove when every look is torn.

   Each sample's image row says which instant it belongs to. The regression is
   a STEP model, not a ramp — emission is discrete, so within a captured frame
   the truth is two constant phases with a cut, never a gradient (the reverted
   temporal-adjudicator taught us what blending at kinks costs). Per frame:

     1. fit r(θ) = β0 + Σ [A_k cos kθ + B_k sin kθ] over ALL valid samples;
     2. scan candidate seam coordinates on both image axes (a rotated capture
        tears vertically), refitting the two sides independently;
     3. a real tear drops the split SSE far below the unsplit SSE (a clean
        frame only buys the ~(n−2P)/(n−P) parameter dividend);
     4. adjudicate WHICH side is this frame's emission instant by the phase
        ladder's own prediction, and rewrite the frame's active-harmonic
        coefficients from that side's fit. Wrong-side risk is favorable by
        construction: the sides differ by one per-frame step, so they are
        separable exactly when picking wrong would cost something.

   Scan detection is per annulus (each ring carries enough samples); the seam
   row is physically shared across rings, so per-ring cut rows landing at the
   same coordinate is a field diagnostic, not an input assumption. Upgrade
   path if the field wants pooled power: joint scan across annuli at shared
   candidate rows. */
(function (global) {
  "use strict";

  function dep(n) { return (typeof module !== "undefined" && module.exports) ? require("./" + n + ".js") : global.OC[n]; }

  var TAU = Math.PI * 2;

  var DEFAULTS = {
    gainMax: 0.55,    // split SSE must fall below this fraction of unsplit SSE
    gateRel: 1.3,     // scan only frames whose unsplit SSE exceeds this × stream median
    guardPx: 2.5,     // samples within this of the seam are on neither side (scanout blend band)
    cleanRel: 2.0,    // split halves must land near the stream's clean floor (× median mse):
                      // a true SEAM splits into two clean instants; handheld sway-WARP splits
                      // into two still-warped halves (walk 4: warps passed the gain gate en
                      // masse and the invalidation fallback shredded 20% of frames into gaps)
    sepMinFrac: 0.1,  // sides closer than this × nominal step: not a phase tear (and harmless either way)
    sepSlack: 1.25,   // window headroom over the physical one-frame step range
    discrim: 0.6      // chosen side must sit this much nearer prediction than the other
  };

  function wrap(x) { x = x % TAU; if (x > Math.PI) x -= TAU; if (x <= -Math.PI) x += TAU; return x; }

  /* Solve (M + λI)β = v, M symmetric P×P flat row-major. Gaussian elimination,
     partial pivoting. Tiny systems (P ≤ 15) — clarity over cleverness. */
  function solve(M, v, P) {
    var A = new Float64Array(P * (P + 1));
    var tr = 0;
    for (var d = 0; d < P; d++) tr += M[d * P + d];
    var ridge = 1e-8 * (tr / P + 1);
    for (var r = 0; r < P; r++) {
      for (var c = 0; c < P; c++) A[r * (P + 1) + c] = M[r * P + c] + (r === c ? ridge : 0);
      A[r * (P + 1) + P] = v[r];
    }
    for (var col = 0; col < P; col++) {
      var piv = col;
      for (var r2 = col + 1; r2 < P; r2++) if (Math.abs(A[r2 * (P + 1) + col]) > Math.abs(A[piv * (P + 1) + col])) piv = r2;
      if (piv !== col) for (var c2 = col; c2 <= P; c2++) { var t = A[col * (P + 1) + c2]; A[col * (P + 1) + c2] = A[piv * (P + 1) + c2]; A[piv * (P + 1) + c2] = t; }
      var p = A[col * (P + 1) + col];
      if (Math.abs(p) < 1e-12) return null;
      for (var r3 = col + 1; r3 < P; r3++) {
        var f = A[r3 * (P + 1) + col] / p;
        if (f === 0) continue;
        for (var c3 = col; c3 <= P; c3++) A[r3 * (P + 1) + c3] -= f * A[col * (P + 1) + c3];
      }
    }
    var beta = new Float64Array(P);
    for (var r4 = P - 1; r4 >= 0; r4--) {
      var s = A[r4 * (P + 1) + P];
      for (var c4 = r4 + 1; c4 < P; c4++) s -= A[r4 * (P + 1) + c4] * beta[c4];
      beta[r4] = s / A[r4 * (P + 1) + r4];
    }
    return beta;
  }

  /* Accumulate normal equations over a subset (indices into the sample arrays)
     and return { beta, sse, n }. basis is flat n×P. */
  function fitSubset(basis, rv, idxs, P) {
    var n = idxs.length;
    var M = new Float64Array(P * P), v = new Float64Array(P), rr = 0;
    for (var t = 0; t < n; t++) {
      var i = idxs[t], off = i * P, ri = rv[i];
      rr += ri * ri;
      for (var a = 0; a < P; a++) {
        var ba = basis[off + a];
        v[a] += ba * ri;
        for (var b = a; b < P; b++) M[a * P + b] += ba * basis[off + b];
      }
    }
    for (var a2 = 1; a2 < P; a2++) for (var b2 = 0; b2 < a2; b2++) M[a2 * P + b2] = M[b2 * P + a2];
    var beta = solve(M, v, P);
    if (!beta) return null;
    var sse = rr;
    for (var a3 = 0; a3 < P; a3++) {
      sse -= 2 * beta[a3] * v[a3];
      for (var b3 = 0; b3 < P; b3++) sse += beta[a3] * M[a3 * P + b3] * beta[b3];
    }
    return { beta: beta, sse: Math.max(0, sse), n: n };
  }

  /* Side fit β → a spec shaped like transform.dft's output, with the ACTIVE
     harmonics rewritten and every inactive bin inherited from origSpec (those
     bins stay the frame's broadband-noise diagnostic; the side fit never
     modeled them). Convention check against dft (e^{−ikθ}, 2/N): for
     r = a·cos(kθ+χ), dft gives arg=χ; the fit gives A=a·cosχ, B=−a·sinχ,
     so χ = atan2(−B, A). Pinned by suite T15. */
  function specFromBeta(beta, ks, origSpec) {
    var mag = new Float64Array(origSpec.mag.length), arg = new Float64Array(origSpec.arg.length);
    mag.set(origSpec.mag); arg.set(origSpec.arg);
    for (var j = 0; j < ks.length; j++) {
      var A = beta[1 + 2 * j], B = beta[2 + 2 * j], k = ks[j];
      mag[k] = Math.hypot(A, B);
      arg[k] = Math.atan2(-B, A);
    }
    return { r0m: beta[0], mag: mag, arg: arg };
  }

  /* φ from a spec near a prediction — the ladder's inner step, standalone.
     k=1 excluded (F5b: centering error lives there); k ≥ 2 branch-resolved
     near pred, weighted (k·mag)²; k=1 only if it is all the profile has. */
  function phiFromSpec(spec, annulus, pred) {
    var ks = annulus.boundary.harmonics;
    var psis = annulus.boundary.phases_deg;
    var acc = pred * 1e-4, W = 1e-4, usable = 0;
    for (var j = 0; j < ks.length; j++) {
      var k = ks[j], mag = spec.mag[k];
      if (k === 1 || !(mag > 0)) continue;
      var target = psis[j] * Math.PI / 180 - spec.arg[k]; // = k·φ + 2π·m
      var cur = acc / W;
      var m = Math.round((k * cur - target) / TAU);
      var cand = (target + TAU * m) / k;
      var w = Math.pow(k * mag, 2);
      acc += cand * w; W += w; usable++;
    }
    if (!usable) {
      var j1 = ks.indexOf(1);
      if (j1 >= 0 && spec.mag[1] > 0) {
        var t1 = psis[j1] * Math.PI / 180 - spec.arg[1];
        var m1 = Math.round((pred - t1) / TAU);
        return t1 + TAU * m1;
      }
      return pred;
    }
    return acc / W;
  }

  /* Scan one frame of one annulus for a seam. rRaw: Float64Array(N), NaN at
     angles with no located edge (gap-filled values are fabrications — the fit
     must never see them; unlike the DFT, least squares needs no uniformity).
     H: unit→pixel homography for this frame. Returns
     { n, mseAll, best: null | { axis, cut, gain, top, bot, nTop, nBot } }
     where top/bot are { beta, sse, n } for the lower/higher-coordinate sides.
     opts.gateOnly stops after the unsplit fit (the cheap first pass). */
  function scanAnnulus(rRaw, H, annulus, opts) {
    opts = opts || {};
    var geom = dep("geom");
    var ks = annulus.boundary.harmonics;
    var P = 1 + 2 * ks.length;
    var N = rRaw.length;
    var guard = opts.guardPx != null ? opts.guardPx : DEFAULTS.guardPx;

    var th = [], rv = [], px = [], py = [];
    for (var i = 0; i < N; i++) {
      if (isNaN(rRaw[i])) continue;
      var t = TAU * i / N;
      var pt = geom.applyH(H, rRaw[i] * Math.cos(t), rRaw[i] * Math.sin(t));
      th.push(t); rv.push(rRaw[i]); px.push(pt[0]); py.push(pt[1]);
    }
    var n = th.length;
    if (n < Math.max(40, 3 * P)) return null;

    var basis = new Float64Array(n * P);
    for (var s = 0; s < n; s++) {
      basis[s * P] = 1;
      for (var j = 0; j < ks.length; j++) {
        basis[s * P + 1 + 2 * j] = Math.cos(ks[j] * th[s]);
        basis[s * P + 2 + 2 * j] = Math.sin(ks[j] * th[s]);
      }
    }

    var allIdx = new Array(n);
    for (var q = 0; q < n; q++) allIdx[q] = q;
    var all = fitSubset(basis, rv, allIdx, P);
    if (!all) return null;
    var result = { n: n, mseAll: all.sse / n, all: all, best: null, warp: null };
    if (opts.gateOnly) return result;
    if (all.sse <= 0) return result;

    // WARP fit — the continuous half of F2 (field walk 4 taught the split):
    // handheld sway makes the boundary phase drift with row inside a frame
    // (largest ring pays most px per unit sway — the base ring's field
    // inversion). A rigid rotation warp shifts EVERY harmonic by the same
    // φ'·y, which equals evaluating the ideal boundary at the rotated angle
    // θ − φ'·y — so de-warp by RESAMPLING the contour there and fitting the
    // plain model, grid-searching the single rate φ'. (Free per-harmonic
    // row-linear terms are DEGENERATE on a circle: y ≡ r·sinθ makes the
    // derivative columns alias into neighboring harmonics — the function
    // fits but the yc=0 phase comes out wrong. One shared rate does not.)
    // A true SEAM is a step, which no continuous rate expresses — the seam
    // path wins its frames on gain.
    (function () {
      var meanY = 0;
      for (var s2 = 0; s2 < n; s2++) meanY += py[s2];
      meanY /= n;
      var scaleY = 0;
      for (var s3 = 0; s3 < n; s3++) scaleY = Math.max(scaleY, Math.abs(py[s3] - meanY));
      if (scaleY < 1) return;
      var yc = new Float64Array(n);
      for (var s4 = 0; s4 < n; s4++) yc[s4] = (py[s4] - meanY) / scaleY;
      var dofPlain = Math.max(1, n - P - 1); // P coefficients + the rate
      var fitAtRate = function (phiP) {
        var b2 = new Float64Array(n * P);
        for (var i2 = 0; i2 < n; i2++) {
          var thW = th[i2] - phiP * yc[i2];
          b2[i2 * P] = 1;
          for (var j2 = 0; j2 < ks.length; j2++) {
            b2[i2 * P + 1 + 2 * j2] = Math.cos(ks[j2] * thW);
            b2[i2 * P + 2 + 2 * j2] = Math.sin(ks[j2] * thW);
          }
        }
        return fitSubset(b2, rv, allIdx, P);
      };
      // One frame can hold at most ~one frame-time of rotation across its rows.
      var rot = annulus.rotation;
      var maxW = (TAU * rot.nominal_hz / (rot.rate_tier_fps || 15) +
                  Math.PI * (rot.M - 1) / (rot.M * rot.frames_per_symbol)) * 1.2;
      var bestR = null;
      for (var g2 = -6; g2 <= 6; g2++) {
        var cand = fitAtRate(maxW * g2 / 6);
        if (cand && (!bestR || cand.sse < bestR.fit.sse)) bestR = { rate: maxW * g2 / 6, fit: cand };
      }
      if (!bestR) return;
      // Parabolic refinement around the best grid point, then a final fit.
      var h = maxW / 6;
      var fm = fitAtRate(bestR.rate - h), fp = fitAtRate(bestR.rate + h);
      if (fm && fp) {
        var denom = fm.sse - 2 * bestR.fit.sse + fp.sse;
        if (Math.abs(denom) > 1e-20) {
          var delta = 0.5 * (fm.sse - fp.sse) / denom * h;
          if (Math.abs(delta) < h) {
            var refined = fitAtRate(bestR.rate + delta);
            if (refined && refined.sse < bestR.fit.sse) bestR = { rate: bestR.rate + delta, fit: refined };
          }
        }
      }
      result.warp = {
        beta: bestR.fit.beta, mse: bestR.fit.sse / dofPlain,
        gain: (bestR.fit.sse / dofPlain) / (all.sse / Math.max(1, n - P)),
        rate: bestR.rate
      };
    })();

    var minSide = Math.max(3 * P, n >> 2);
    var dofAll = Math.max(1, n - P);
    var axes = [py, px];
    var axisNames = ["y", "x"];
    var tryCut = function (coord, order, axName, ci) {
      if (ci < 1 || ci >= n) return null;
      var cut = (coord[order[ci - 1]] + coord[order[ci]]) / 2;
      var topIdx = [], botIdx = [];
      for (var u = 0; u < n; u++) {
        var o = order[u];
        if (coord[o] <= cut - guard) topIdx.push(o);
        else if (coord[o] >= cut + guard) botIdx.push(o);
      }
      if (topIdx.length < minSide || botIdx.length < minSide) return null;
      var ft = fitSubset(basis, rv, topIdx, P);
      var fb = fitSubset(basis, rv, botIdx, P);
      if (!ft || !fb) return null;
      // Degrees-of-freedom-normalized gain: a raw SSE ratio lets a 2P-param
      // split "win" on overfit alone when few samples survive degradation
      // (the suite caught exactly this under blur+noise). Per-DOF residuals
      // converge to the raw ratio at large n and remove the small-n freebie.
      var mseSplit = (ft.sse + fb.sse) / Math.max(1, ft.n + fb.n - 2 * P);
      var gain = mseSplit / (all.sse / dofAll);
      return { axis: axName, ci: ci, cut: cut, gain: gain, mseSplit: mseSplit, top: ft, bot: fb, nTop: ft.n, nBot: fb.n };
    };
    for (var ax = 0; ax < 2; ax++) {
      var coord = axes[ax];
      var order = allIdx.slice().sort(function (a, b) { return coord[a] - coord[b]; });
      var bestAx = null;
      for (var qf = 0.2; qf <= 0.801; qf += 0.05) {
        var cand = tryCut(coord, order, axisNames[ax], Math.round(qf * n));
        if (cand && (!bestAx || cand.gain < bestAx.gain)) bestAx = cand;
      }
      // Refine: the coarse quantile grid localizes the seam only to ~2% of
      // samples, and even a few misassigned samples poison the side fits —
      // detection survives (gain ~0.1 instead of ~1e-10) but the side phases
      // feed adjudication garbage. Sweep EVERY sample boundary near the best
      // coarse cut so the exact seam is always a candidate.
      if (bestAx) {
        var win = Math.max(3, Math.ceil(n * 0.06));
        for (var ci2 = bestAx.ci - win; ci2 <= bestAx.ci + win; ci2++) {
          var cand2 = tryCut(coord, order, axisNames[ax], ci2);
          if (cand2 && cand2.gain < bestAx.gain) bestAx = cand2;
        }
      }
      if (bestAx && (!result.best || bestAx.gain < result.best.gain)) result.best = bestAx;
    }
    return result;
  }

  /* The driver. series: pipeline entries { f, spec, rRaw, H } (nulls allowed);
     track: the CURRENT trackPhase output (predictions come from its φ at the
     neighbors — the torn frame's own blended value is never consulted);
     Recompute-from-original semantics: each call restores entry.spec from
     entry.spec0 before deciding, so a second adjudication pass with a better
     track can revise or rescind the first — repairs never compound.
     Returns { scanned, gated, torn, repaired, slipSuspect, cuts }. */
  function repairSeries(series, track, annulus, profile, opts) {
    opts = opts || {};
    var gainMax = opts.gainMax != null ? opts.gainMax : DEFAULTS.gainMax;
    var gateRel = opts.gateRel != null ? opts.gateRel : DEFAULTS.gateRel;
    var cleanRel = opts.cleanRel != null ? opts.cleanRel : DEFAULTS.cleanRel;
    var sepMinFrac = opts.sepMinFrac != null ? opts.sepMinFrac : DEFAULTS.sepMinFrac;
    var sepSlack = opts.sepSlack != null ? opts.sepSlack : DEFAULTS.sepSlack;
    var discrim = opts.discrim != null ? opts.discrim : DEFAULTS.discrim;

    var fps = profile.frame_rate_hz;
    var rot = annulus.rotation;
    var nomStep = TAU * rot.nominal_hz / fps + Math.PI / (rot.M * rot.frames_per_symbol);
    // The physical one-frame step range: pure nominal ± the true per-frame
    // deviation bound, (M−1)π/(M·F). On slow rings the deviation DOMINATES the
    // nominal (idx0 v2: ±0.74 vs 0.31 rad), so a window scaled by the nominal
    // step rejects exactly the large-deviation tears that hurt most — the
    // first suite run of T13 demonstrated this on the D16 ring.
    var nomStep0 = TAU * rot.nominal_hz / fps;
    var devPF = Math.PI * (rot.M - 1) / (rot.M * rot.frames_per_symbol);
    var sepLo = Math.max(0.02, sepMinFrac * nomStep0);
    var sepHi = (nomStep0 + devPF) * sepSlack;
    var ks = annulus.boundary.harmonics;

    var stats = { scanned: 0, gated: 0, torn: 0, repaired: 0, warped: 0, invalidated: 0, slipSuspect: 0,
                  warpRate: null, cuts: [],
                  reasons: { noisy: 0, nopred: 0, sepLo: 0, sepHi: 0, discrim: 0 } };
    var warpRates = [];

    // Pass 1 (cheap): unsplit misfit per frame → stream median → the gate.
    var mses = [], entries = [];
    for (var s = 0; s < series.length; s++) {
      var e = series[s];
      if (!e || !e.rRaw || !e.H || (!e.spec && !e.spec0)) continue;
      if (!e.spec0) e.spec0 = e.spec; // the original DFT, kept for rescindable repairs
      // (an entry invalidated last pass re-enters here via spec0 — a better
      //  track may adjudicate what the first one could not)
      var g = scanAnnulus(e.rRaw, e.H, annulus, { gateOnly: true, guardPx: opts.guardPx });
      if (!g) continue;
      entries.push({ e: e, mse: g.mseAll });
      mses.push(g.mseAll);
      stats.scanned++;
    }
    if (!entries.length) return stats;
    var sorted = mses.slice().sort(function (a, b) { return a - b; });
    var median = sorted[sorted.length >> 1];
    var gate = median * gateRel;
    // The seam test's reference is the CLEAN floor (lower quartile), not the
    // median: on sway-heavy handheld streams the median itself is warped, and
    // a median-relative bar let warps masquerade as clean-sided seams.
    var cleanFloor = sorted[sorted.length >> 2];

    var pred = function (f) {
      // Nearest valid neighbor, nominal-bridged — same bridge trackPhase uses.
      for (var d = 1; d <= 3; d++) {
        if (f - d >= 0 && !isNaN(track.phi[f - d])) return track.phi[f - d] + nomStep * d;
        if (f + d <= track.maxF && !isNaN(track.phi[f + d])) return track.phi[f + d] - nomStep * d;
      }
      return null;
    };

    // Phase 1 of the repair: scan every gated frame and CACHE each seam's two
    // side phases before adjudicating anything. In a consecutive torn run the
    // neighbor's track phase is itself a blend — partner-matching against it
    // penalizes the TRUE hypothesis by ~half a step (measured: repairs fell
    // 9→5 when partner refs came from the blended track). Seam pairs share an
    // instant, so a torn neighbor's own scanned sides are the honest partner
    // references.
    var torn = {}; // f -> { e, scan, specT, specB, phiT, phiB, p }
    for (var t = 0; t < entries.length; t++) {
      var ent = entries[t], e2 = ent.e;
      e2.spec = e2.spec0; // reset: decisions are made fresh each pass
      var p = pred(e2.f);
      if (p !== null && !isNaN(track.phi[e2.f])) {
        var dSelf = Math.abs(wrap(track.phi[e2.f] - p));
        if (Math.abs(dSelf - nomStep) < 0.25 * nomStep) stats.slipSuspect++;
      }
      if (ent.mse <= gate) continue;
      stats.gated++;
      var scan = scanAnnulus(e2.rRaw, e2.H, annulus, { guardPx: opts.guardPx });
      if (!scan) continue;
      // Route the frame to the model that explains it (field walk 4's split):
      // SEAM = a step in row — two CLEAN instants (sides at the clean floor);
      // WARP = a continuous phase-vs-row gradient (handheld sway) — the
      // extended-basis fit explains it and its yc=0 coefficients ARE the
      // de-warped frame. A warp is repaired in place, no side to adjudicate.
      var seamOK = scan.best && scan.best.gain < gainMax &&
                   scan.best.mseSplit <= cleanRel * cleanFloor + 1e-12;
      var warpOK = scan.warp && scan.warp.gain < gainMax;
      if (seamOK && (!warpOK || scan.best.gain <= scan.warp.gain)) {
        stats.torn++;
        var specT = specFromBeta(scan.best.top.beta, ks, e2.spec0);
        var specB = specFromBeta(scan.best.bot.beta, ks, e2.spec0);
        var anchor = p !== null ? p : (isNaN(track.phi[e2.f]) ? 0 : track.phi[e2.f]);
        torn[e2.f] = { e: e2, scan: scan, specT: specT, specB: specB, p: p,
                       phiT: phiFromSpec(specT, annulus, anchor),
                       phiB: phiFromSpec(specB, annulus, anchor) };
      } else if (warpOK) {
        e2.spec = specFromBeta(scan.warp.beta, ks, e2.spec0); // first P terms = yc=0 coefficients
        stats.warped++;
        if (warpRates.length < 400) warpRates.push(scan.warp.rate);
      } else {
        stats.reasons.noisy++;
      }
    }
    if (warpRates.length) {
      warpRates.sort(function (a, b) { return a - b; });
      stats.warpRate = Math.round(warpRates[warpRates.length >> 1] * 1000) / 1000;
    }

    // Phase 2: adjudicate. Partner references for neighbor f±1: its scanned
    // side phases if it is torn, else its measured track phase. The frame's
    // own member is scored against the prediction; the PARTNER against those
    // references — measurement vs measurement, free of the deviation
    // uncertainty that makes prediction-only scoring fail on exactly the
    // large-deviation symbols where a wrong blend costs most.
    var partnerRefs = function (fr) {
      if (torn[fr]) return [torn[fr].phiT, torn[fr].phiB];
      if (fr >= 0 && fr <= track.maxF && !isNaN(track.phi[fr])) return [track.phi[fr]];
      return null;
    };
    var minDist = function (phi, refs) {
      var m = Infinity;
      for (var i = 0; i < refs.length; i++) { var d = Math.abs(wrap(phi - refs[i])); if (d < m) m = d; }
      return m;
    };
    for (var f in torn) {
      var tf = torn[f], e3 = tf.e;
      var invalidate = function () { e3.spec = null; stats.invalidated++; };
      // A confirmed seam whose side can't be adjudicated must NOT vote as a
      // clean instant: the blend of two instants demaps as a CONFIDENT wrong
      // symbol (D16 pays first). Invalidate → gap → honest erasure downstream.
      if (tf.p === null) { stats.reasons.nopred++; invalidate(); continue; }
      var sep = Math.abs(wrap(tf.phiT - tf.phiB));
      if (sep < sepLo) { stats.reasons.sepLo++; continue; } // sides agree: not a phase seam, and the blend is harmless
      // Beyond a one-frame step: whatever split this is, it is NOT an emission
      // seam — evidence AGAINST the seam model, so the unsplit spec stands.
      // (Invalidating here amplified field sway-warps into mass frame loss.)
      if (sep > sepHi) { stats.reasons.sepHi++; continue; }
      var refN = partnerRefs(e3.f + 1), refP = partnerRefs(e3.f - 1);
      var dTp = Math.abs(wrap(tf.phiT - tf.p)), dBp = Math.abs(wrap(tf.phiB - tf.p));
      var hyps = [];
      if (refN) {
        hyps.push({ spec: tf.specT, side: "top", d: dTp + minDist(tf.phiB, refN) });
        hyps.push({ spec: tf.specB, side: "bot", d: dBp + minDist(tf.phiT, refN) });
      }
      if (refP) {
        hyps.push({ spec: tf.specB, side: "bot", d: dBp + minDist(tf.phiT, refP) });
        hyps.push({ spec: tf.specT, side: "top", d: dTp + minDist(tf.phiB, refP) });
      }
      if (!hyps.length) { // no reference at all: prediction-only fallback
        hyps.push({ spec: tf.specT, side: "top", d: 2 * dTp });
        hyps.push({ spec: tf.specB, side: "bot", d: 2 * dBp });
      }
      hyps.sort(function (a, b) { return a.d - b.d; });
      // Best must be clearly best against the top competitor CHOOSING THE
      // OTHER SIDE (same-side hypotheses differ only in partner direction) —
      // AND small in absolute terms relative to the seam it claims to
      // resolve. The absolute bound kills the degenerate case where an
      // adjacent symbol's near-zero step makes instant f phase-identical to
      // f∓1 and a wrong pairing scores well by accident: local evidence
      // genuinely cannot label such a seam, and an honest invalidation
      // (erasure) beats a coin-flip repair whose error is the full step.
      var rival = null;
      for (var hv = 1; hv < hyps.length; hv++) if (hyps[hv].side !== hyps[0].side) { rival = hyps[hv]; break; }
      var clearWin = (!rival || hyps[0].d < discrim * rival.d) && hyps[0].d < 0.35 * sep;
      if (!clearWin) { stats.reasons.discrim++; invalidate(); continue; }
      e3.spec = hyps[0].spec;
      stats.repaired++;
      if (stats.cuts.length < 8)
        stats.cuts.push({ f: e3.f, axis: tf.scan.best.axis, cut: Math.round(tf.scan.best.cut),
                          gain: Math.round(tf.scan.best.gain * 100) / 100, side: hyps[0].side });
    }
    return stats;
  }

  var API = { scanAnnulus: scanAnnulus, repairSeries: repairSeries, phiFromSpec: phiFromSpec, specFromBeta: specFromBeta, DEFAULTS: DEFAULTS };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.rowtime = API;
})(typeof window !== "undefined" ? window : globalThis);
