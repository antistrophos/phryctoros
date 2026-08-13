/* prng.js — seeded, deterministic randomness for symbol streams and noise.
   Dual-environment: browser global OC.prng / CommonJS module.exports. */
(function (global) {
  "use strict";

  // mulberry32 — small, fast, adequate statistical quality for streams/noise.
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Symbol stream: n symbols uniform in [0, M). Deterministic per (seed, M).
  function symbolStream(seed, n, M) {
    var rng = mulberry32(seed);
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = Math.floor(rng() * M) % M;
    return out;
  }

  // Gaussian via Box-Muller (paired), seeded.
  function gaussian(rng) {
    var spare = null;
    return function () {
      if (spare !== null) { var s = spare; spare = null; return s; }
      var u = 0, v = 0;
      while (u === 0) u = rng();
      v = rng();
      var m = Math.sqrt(-2.0 * Math.log(u));
      spare = m * Math.sin(2 * Math.PI * v);
      return m * Math.cos(2 * Math.PI * v);
    };
  }

  var API = { mulberry32: mulberry32, symbolStream: symbolStream, gaussian: gaussian };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.prng = API;
})(typeof window !== "undefined" ? window : globalThis);
