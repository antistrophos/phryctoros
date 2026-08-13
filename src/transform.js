/* transform.js — stage 6: contour r(θ) → Fourier coefficients c_k.
   Direct DFT at the harmonics of interest (plus noise bins), e^{−ikθ} convention
   scaled 2/N, so |c_k| estimates the emitted amplitude a_k and
   arg(c_k) = ψ_k − k·φ (see emission.js conventions). */
(function (global) {
  "use strict";

  var tables = {};
  function tab(N) {
    if (tables[N]) return tables[N];
    var c = new Float64Array(N), s = new Float64Array(N);
    for (var i = 0; i < N; i++) { var th = 2 * Math.PI * i / N; c[i] = Math.cos(th); s[i] = Math.sin(th); }
    tables[N] = { c: c, s: s };
    return tables[N];
  }

  /* dft(r, kmax) -> { r0m, mag[k], arg[k] } for k in 1..kmax (index 0 unused). */
  function dft(r, kmax) {
    var N = r.length, t = tab(N);
    var mean = 0;
    for (var i = 0; i < N; i++) mean += r[i];
    mean /= N;
    var mag = new Float64Array(kmax + 1), arg = new Float64Array(kmax + 1);
    for (var k = 1; k <= kmax; k++) {
      var re = 0, im = 0;
      for (var n = 0; n < N; n++) {
        var idx = (k * n) % N;
        var v = r[n] - mean;
        re += v * t.c[idx];
        im -= v * t.s[idx];
      }
      re *= 2 / N; im *= 2 / N;
      mag[k] = Math.hypot(re, im);
      arg[k] = Math.atan2(im, re);
    }
    return { r0m: mean, mag: mag, arg: arg };
  }

  /* Residual noise sigma after removing the active harmonics: read it off the
     inactive bins (median of magnitudes at k not in `active`, 1..kmax). */
  function noiseSigma(spec, active, kmax) {
    var inactive = [];
    for (var k = 1; k <= kmax; k++) if (active.indexOf(k) < 0) inactive.push(spec.mag[k]);
    if (!inactive.length) return 0;
    inactive.sort(function (a, b) { return a - b; });
    return inactive[Math.floor(inactive.length / 2)];
  }

  var API = { dft: dft, noiseSigma: noiseSigma };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.transform = API;
})(typeof window !== "undefined" ? window : globalThis);
