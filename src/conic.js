/* conic.js — the ellipse correction: fold the static k≤2 geometry residual
   into the homography as ONE affine composition.
   A camera off the screen normal sees the emission's concentric CIRCLES as
   concentric ELLIPSES, and registration does not fully absorb that: the
   finder path fits an affine to the tiny central fiducial (perspective
   divergence grows with radius), and the ring fallback is a similarity by
   design. What remains is a STATIC k≤2 signature on every ring boundary —
   and k=1/k=2 are DATA harmonics on every ring, so the static vector beats
   against the rotating modulation: the tracked phase wanders (carriers
   above AND below nominal — the walk-7 signature), and rings die
   outermost-first because the tilt term grows as e·r0 while the data
   amplitudes stay roughly flat across rings.
   The estimate: frame-average each ring's boundary r(θ) over a probe span —
   rotation and DPSK sweep the data component toward zero while the static
   geometry stands still; per-frame registration has already removed sway
   (a fixed-H probe of this signature was sway-DC-confounded and measured
   nothing — walk 7). Then one JOINT least-squares across rings: a free
   radius bias per ring (scale / edge-detection bias — diagnostic only,
   never applied), one shared centre term (k=1: the same absolute amplitude
   on every ring), and one shared ellipse term scaled by r0 (k=2: a tilt
   flattens every circle by the same RATIO — the physics prior). The affine
   A built from that fit composes into every per-frame homography once,
   H' = H·A; every stage downstream samples through applyH and inherits the
   fix. Estimated twice: after the first correction the sampling window
   re-centres on the true boundary, and the second pass mops up what window
   clipping biased in the first.
   SELF-GATED: below max(gate × the fit's own noise floor, an absolute
   sub-pixel floor) the correction is the EXACT identity and the decode is
   byte-identical to a build without this module — no branch doubling, no
   thresholds tuned on synthetics (the criterion-hunt lesson). */
(function (global) {
  "use strict";

  function dep(n) { return (typeof module !== "undefined" && module.exports) ? require("./" + n + ".js") : global.OC[n]; }

  var TAU = Math.PI * 2;

  /* Row-major 3x3 product: applyH(mul3(P,Q), x, y) === applyH(P, applyH(Q, x, y)). */
  function mul3(P, Q) {
    var R = new Float64Array(9);
    for (var r = 0; r < 3; r++)
      for (var c = 0; c < 3; c++)
        R[r * 3 + c] = P[r * 3] * Q[c] + P[r * 3 + 1] * Q[3 + c] + P[r * 3 + 2] * Q[6 + c];
    return R;
  }

  /* The correction: presumed circle → fitted static geometry. The traceless
     symmetric part [[p,q],[q,-p]] moves radius by r·(p·cos2θ + q·sin2θ);
     the translation carries the fitted centre offset; the PROJECTIVE row
     (g,h) moves radius by −r²·(g·cosθ + h·sinθ) — the perspective term.
     field30 convicted that last one: a fiducial-fit affine absorbs the
     local linear pose but cannot see the quadratic, so an angled capture
     keeps a static k=1 growing as r² — same harmonic as the k=1 DATA and
     the k-ladder's branch guide, which is why rings die middle-and-outer
     first with carriers wandering BOTH directions. */
  function affineOf(p, q, dx, dy, g, h) {
    return new Float64Array([1 + p, q, dx, q, 1 - p, dy, g || 0, h || 0, 1]);
  }

  /* 2x2 singular values + the output (image-side) major-axis angle. */
  function svd2(a, b, c, d) {
    var E = (a + d) / 2, F = (a - d) / 2, G2 = (c + b) / 2, H2 = (c - b) / 2;
    var Q = Math.hypot(E, H2), R = Math.hypot(F, G2);
    var a1 = Math.atan2(G2, F), a2 = Math.atan2(H2, E);
    var axis = ((((a2 + a1) / 2) * 180 / Math.PI) % 180 + 180) % 180;
    return { smax: Q + R, smin: Math.abs(Q - R), axisDeg: axis };
  }

  /* One estimation pass: per-angle boundary means per ring through each
     frame's own H (composed with the correction so far), then the joint fit.
     Angles are dropped, never gap-filled — a fabricated mean would fit as
     fake geometry. */
  function fitPass(groups, Hs, Acur, profile, span, step, N) {
    var sample = dep("sample"), geom = dep("geom");
    var ann = profile.annuli, R = ann.length;
    var sums = [], cnts = [], used = [];
    for (var a0 = 0; a0 < R; a0++) { sums.push(new Float64Array(N)); cnts.push(new Int32Array(N)); used.push(0); }
    for (var i = span[0]; i < span[1]; i += step) {
      var Heff = Acur ? mul3(Hs[i], Acur) : Hs[i];
      for (var ai = 0; ai < R; ai++) {
        var s = sample.sampleBoundary(groups[i].imgs[0], Heff, ann[ai], { N: N });
        if (s.found < N * 0.5) continue;
        used[ai]++;
        for (var j = 0; j < N; j++)
          if (s.r[j] === s.r[j]) { sums[ai][j] += s.r[j]; cnts[ai][j]++; }
      }
    }

    var ringIdx = [], r0max = 0;
    for (var ai2 = 0; ai2 < R; ai2++) {
      if (used[ai2] < 8) continue;
      var minCnt = Math.max(3, used[ai2] * 0.3), got = 0;
      for (var j2 = 0; j2 < N; j2++) if (cnts[ai2][j2] >= minCnt) got++;
      if (got >= N * 0.5) { ringIdx.push(ai2); if (ann[ai2].r0 > r0max) r0max = ann[ai2].r0; }
    }
    if (!ringIdx.length) return { ok: false, reason: "no ring averaged cleanly over the probe span" };

    // Unknowns: [bias per included ring..., dx, dy, cg, ch, p, q] where the
    // (cg, ch) columns are r0²·cosθ / r0²·sinθ — the perspective k=1. With
    // one ring the r² column is degenerate with the constant k=1; drop it.
    var withPersp = ringIdx.length >= 2;
    var u = ringIdx.length + (withPersp ? 6 : 4);
    var AtA = new Float64Array(u * u), Atb = new Float64Array(u), row = new Float64Array(u);
    var forEachPoint = function (fn) {
      for (var k = 0; k < ringIdx.length; k++) {
        var ai3 = ringIdx[k], r0 = ann[ai3].r0, minC = Math.max(3, used[ai3] * 0.3);
        for (var j3 = 0; j3 < N; j3++) {
          if (cnts[ai3][j3] < minC) continue;
          fn(k, r0, TAU * j3 / N, sums[ai3][j3] / cnts[ai3][j3]);
        }
      }
    };
    var n = 0;
    forEachPoint(function (k, r0, th, m) {
      for (var z = 0; z < u; z++) row[z] = 0;
      row[k] = 1;
      var b = ringIdx.length, ct = Math.cos(th), st = Math.sin(th);
      row[b] = ct; row[b + 1] = st;
      if (withPersp) {
        row[b + 2] = r0 * r0 * ct; row[b + 3] = r0 * r0 * st;
        row[b + 4] = r0 * Math.cos(2 * th); row[b + 5] = r0 * Math.sin(2 * th);
      } else {
        row[b + 2] = r0 * Math.cos(2 * th); row[b + 3] = r0 * Math.sin(2 * th);
      }
      for (var r1 = 0; r1 < u; r1++) {
        if (!row[r1]) continue;
        Atb[r1] += row[r1] * m;
        for (var c1 = 0; c1 < u; c1++) if (row[c1]) AtA[r1 * u + c1] += row[r1] * row[c1];
      }
      n++;
    });
    var x = geom.solve(AtA, Atb, u);
    if (!x) return { ok: false, reason: "singular fit" };
    var b0 = ringIdx.length;
    var dx = x[b0], dy = x[b0 + 1];
    var cg = withPersp ? x[b0 + 2] : 0, ch = withPersp ? x[b0 + 3] : 0;
    var p = x[b0 + (withPersp ? 4 : 2)], q = x[b0 + (withPersp ? 5 : 3)];
    var ss = 0;
    forEachPoint(function (k, r0, th, m) {
      var pred = x[k] + (dx + cg * r0 * r0) * Math.cos(th) + (dy + ch * r0 * r0) * Math.sin(th) +
                 r0 * (p * Math.cos(2 * th) + q * Math.sin(2 * th));
      ss += (m - pred) * (m - pred);
    });
    // The gate quantity: the model's own peak static radial displacement at
    // the worst ring — constant k=1, perspective k=1, and k=2 together.
    var dmax = 0;
    for (var km = 0; km < ringIdx.length; km++) {
      var r0m = ann[ringIdx[km]].r0;
      var d = Math.hypot(dx + cg * r0m * r0m, dy + ch * r0m * r0m) + Math.hypot(p, q) * r0m;
      if (d > dmax) dmax = d;
    }
    return {
      ok: true, p: p, q: q, dx: dx, dy: dy, cg: cg, ch: ch,
      sigma: Math.sqrt(ss / Math.max(1, n - u)),
      k2: Math.hypot(p, q) * r0max,
      k1c: Math.hypot(dx, dy),
      k1p: Math.hypot(cg, ch) * r0max * r0max,
      dmax: dmax,
      rings: ringIdx.length, frames: Math.max.apply(null, used),
      bias: ringIdx.map(function (ai4, k2) { return { annulus: ai4, bias: r4(x[k2] - ann[ai4].r0) }; })
    };
  }

  /* groups: the pipeline's emission-frame groups [{f, imgs}]; Hs: that
     emitter's per-frame homographies. Returns a diagnostic object; when the
     gate trips it carries A (the correction) and applied:true. */
  function estimateStatic(groups, Hs, profile, opts) {
    opts = opts || {};
    var gate = opts.gate != null ? opts.gate : 4;
    var minK2 = opts.minK2 != null ? opts.minK2 : 0.004;
    var N = opts.rays || 96;
    var maxUsed = opts.maxProbe || 180;

    var G = groups.length;
    var minHz = Infinity;
    for (var i = 0; i < profile.annuli.length; i++)
      if (profile.annuli[i].rotation.nominal_hz < minHz) minHz = profile.annuli[i].rotation.nominal_hz;
    var need = Math.ceil(2 * profile.frame_rate_hz / minHz); // two rotations of the slowest ring
    if (G < Math.ceil(need * 0.75))
      return { applied: false, reason: "short capture (" + G + " frames, want ≥" + Math.ceil(need * 0.75) + " to average the data out)" };
    // Skip the countdown-freeze prefix when there is room: a FROZEN emission's
    // data harmonics do not rotate and would masquerade as static geometry.
    var i0 = Math.min(Math.floor(G * 0.18), Math.max(0, G - need));
    // Every frame on short captures (leakage of the rotating data component
    // falls as 1/sqrt(frames averaged)); stride 2 once the span is long.
    var step = opts.step || (G - i0 < 240 ? 1 : 2);
    var span = [i0, Math.min(G, i0 + maxUsed * step)];

    var p1 = fitPass(groups, Hs, null, profile, span, step, N);
    if (!p1.ok) return { applied: false, reason: p1.reason };
    // Gate on the model's PEAK static displacement (k=1 const + k=1
    // perspective + k=2 together) — field30's lesson: a 10σ perspective
    // k=1 sat in the fit while a k2-only gate looked the other way.
    var floor = Math.max(gate * p1.sigma, minK2);
    if (p1.dmax <= floor)
      return { applied: false, dmax: r4(p1.dmax), k1c: r4(p1.k1c), k1p: r4(p1.k1p), k2: r4(p1.k2),
               noise: r4(p1.sigma), floor: r4(floor), rings: p1.rings, frames: p1.frames };

    // Sign: the fit measures Δr = +cg·r²cosθ…, A's projective row moves
    // radius by −r²(g·cosθ + h·sinθ) — so g = −cg, h = −ch.
    var A = affineOf(p1.p, p1.q, p1.dx, p1.dy, -p1.cg, -p1.ch);
    var p2 = fitPass(groups, Hs, A, profile, span, step, N);
    if (p2.ok) A = mul3(A, affineOf(p2.p, p2.q, p2.dx, p2.dy, -p2.cg, -p2.ch));

    var sv = svd2(A[0], A[1], A[3], A[4]);
    return {
      applied: true, A: A,
      dmax: r4(p1.dmax), k1c: r4(p1.k1c), k1p: r4(p1.k1p), k2: r4(p1.k2),
      noise: r4(p1.sigma), floor: r4(floor),
      residual: p2.ok ? r4(p2.dmax) : null,
      tiltDeg: r1(Math.acos(Math.min(1, sv.smin / Math.max(sv.smax, 1e-9))) * 180 / Math.PI),
      axisDeg: r1(sv.axisDeg),
      persp: [r4(A[6]), r4(A[7])],
      center: [r4(A[2]), r4(A[5])],
      ringBias: p1.bias, rings: p1.rings, frames: p1.frames
    };
  }

  /* Windowed DIAGNOSTIC scan — the wander probe. field30 taught the sharp
     lesson: the full-capture average measured k2 ≈ 0.006 (no static ellipse)
     while the rings stayed wrecked — a hand-sway pose that WANDERS is
     geometric at every instant and static never, and a whole-capture mean
     washes it to nothing (its residue inflates the fit noise instead). This
     scan fits the same k≤2 model over consecutive windows (each just long
     enough to average the rotating data out) and reports the per-window
     ellipse vector — if (p,q) is large per-window but wanders in direction,
     the wander hypothesis is confirmed and the window length calibrates the
     correction's timescale. Diagnostic only: changes nothing downstream. */
  function scanWindows(groups, Hs, profile, opts) {
    opts = opts || {};
    var N = opts.rays || 96;
    var G = groups.length;
    var minHz = Infinity;
    for (var i = 0; i < profile.annuli.length; i++)
      if (profile.annuli[i].rotation.nominal_hz < minHz) minHz = profile.annuli[i].rotation.nominal_hz;
    var need = Math.ceil(2 * profile.frame_rate_hz / minHz);
    var i0 = Math.min(Math.floor(G * 0.1), Math.max(0, G - need));
    var W = Math.max(need, opts.windowFrames || need);
    var out = [];
    for (var w0 = i0; w0 + Math.floor(W * 0.75) <= G; w0 += W) {
      var w1 = Math.min(G, w0 + W);
      var f = fitPass(groups, Hs, null, profile, [w0, w1], 1, N);
      if (!f.ok) { out.push({ w: [w0, w1], reason: f.reason }); continue; }
      var e = Math.hypot(f.p, f.q);
      out.push({
        w: [w0, w1], dmax: r4(f.dmax), k1c: r4(f.k1c), k1p: r4(f.k1p), k2: r4(f.k2), noise: r4(f.sigma),
        axisDeg: r1(((Math.atan2(f.q, f.p) / 2) * 180 / Math.PI % 180 + 180) % 180),
        tiltDeg: r1(Math.acos((1 - e) / (1 + e)) * 180 / Math.PI),
        center: [r4(f.dx), r4(f.dy)], persp: [r4(f.cg), r4(f.ch)], frames: f.frames
      });
    }
    return out;
  }

  function r4(x) { return Math.round(x * 10000) / 10000; }
  function r1(x) { return Math.round(x * 10) / 10; }

  var API = { estimateStatic: estimateStatic, scanWindows: scanWindows, compose: mul3, affineOf: affineOf, svd2: svd2 };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.conic = API;
})(typeof window !== "undefined" ? window : globalThis);
