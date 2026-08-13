/* dtrig.js — deterministic sin/cos/atan2.
   WHY: Math.sin/cos/atan2 are implementation-defined in precision; golden-vector
   frames must be bit-identical across JS engines (review finding F8). The GOLDEN
   render path uses these; the live decoder uses native Math (it needs speed, not
   cross-engine determinism). fdlibm-style kernels; |err| ~1e-14 for sin/cos,
   ~1e-7 for atan2 (boundary-eval error far below one pixel). */
(function (global) {
  "use strict";

  var PIO2_HI = 1.57079632679489655800e+00;
  var PIO2_LO = 6.12323399573676603587e-17;

  var S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03,
      S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06,
      S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
  var C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03,
      C3 = 2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07,
      C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;

  function kernelSin(r) {
    var z = r * r;
    return r + r * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
  }
  function kernelCos(r) {
    var z = r * r;
    return 1 - 0.5 * z + z * z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  }
  function reduce(x) {
    var n = Math.round(x / PIO2_HI);
    var r = x - n * PIO2_HI - n * PIO2_LO;
    return { r: r, q: ((n % 4) + 4) % 4 };
  }
  function dsin(x) {
    var t = reduce(x);
    switch (t.q) {
      case 0: return kernelSin(t.r);
      case 1: return kernelCos(t.r);
      case 2: return -kernelSin(t.r);
      default: return -kernelCos(t.r);
    }
  }
  function dcos(x) {
    var t = reduce(x);
    switch (t.q) {
      case 0: return kernelCos(t.r);
      case 1: return -kernelSin(t.r);
      case 2: return -kernelCos(t.r);
      default: return kernelSin(t.r);
    }
  }

  // atan on [0, ~0.4142] by truncated series; fold with atan(t)=π/4+atan((t-1)/(t+1)).
  var TAN_PI_8 = 0.41421356237309503;
  function atanSmall(z) {
    var z2 = z * z;
    return z * (1 + z2 * (-1 / 3 + z2 * (1 / 5 + z2 * (-1 / 7 + z2 * (1 / 9 + z2 * (-1 / 11 + z2 * (1 / 13)))))));
  }
  function atanPos(t) { // t >= 0
    if (t > 1) return PIO2_HI - atanPos(1 / t);
    if (t > TAN_PI_8) return PIO2_HI / 2 + atanSmall((t - 1) / (t + 1));
    return atanSmall(t);
  }
  function datan2(y, x) {
    if (x === 0 && y === 0) return 0;
    var PI = 2 * PIO2_HI;
    if (x > 0) return y >= 0 ? atanPos(y / x) : -atanPos(-y / x);
    if (x < 0) return y >= 0 ? PI - atanPos(y / -x) : atanPos(-y / -x) - PI;
    return y > 0 ? PIO2_HI : -PIO2_HI;
  }

  var API = { dsin: dsin, dcos: dcos, datan2: datan2 };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.dtrig = API;
})(typeof window !== "undefined" ? window : globalThis);
