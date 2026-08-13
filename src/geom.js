/* geom.js — homography (DLT), 3x3 ops, bilinear sampling.
   Images everywhere are {w, h, data: Float32Array} luminance in [0,1]. */
(function (global) {
  "use strict";

  // Solve A x = b, A is n x n (row-major), Gaussian elimination w/ partial pivot.
  function solve(A, b, n) {
    var M = new Float64Array(n * (n + 1));
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) M[r * (n + 1) + c] = A[r * n + c];
      M[r * (n + 1) + n] = b[r];
    }
    for (var col = 0; col < n; col++) {
      var piv = col;
      for (var r2 = col + 1; r2 < n; r2++)
        if (Math.abs(M[r2 * (n + 1) + col]) > Math.abs(M[piv * (n + 1) + col])) piv = r2;
      if (Math.abs(M[piv * (n + 1) + col]) < 1e-12) return null;
      if (piv !== col)
        for (var c2 = col; c2 <= n; c2++) {
          var tmp = M[col * (n + 1) + c2]; M[col * (n + 1) + c2] = M[piv * (n + 1) + c2]; M[piv * (n + 1) + c2] = tmp;
        }
      var d = M[col * (n + 1) + col];
      for (var c3 = col; c3 <= n; c3++) M[col * (n + 1) + c3] /= d;
      for (var r3 = 0; r3 < n; r3++) {
        if (r3 === col) continue;
        var f = M[r3 * (n + 1) + col];
        if (f === 0) continue;
        for (var c4 = col; c4 <= n; c4++) M[r3 * (n + 1) + c4] -= f * M[col * (n + 1) + c4];
      }
    }
    var x = new Float64Array(n);
    for (var i = 0; i < n; i++) x[i] = M[i * (n + 1) + n];
    return x;
  }

  // Homography from 4 correspondences (src -> dst), row-major 3x3 with H[8]=1.
  function homographyFromPoints(src, dst) {
    var A = new Float64Array(64), b = new Float64Array(8);
    for (var i = 0; i < 4; i++) {
      var x = src[i][0], y = src[i][1], X = dst[i][0], Y = dst[i][1];
      var r1 = 2 * i, r2 = 2 * i + 1;
      A[r1 * 8 + 0] = x; A[r1 * 8 + 1] = y; A[r1 * 8 + 2] = 1;
      A[r1 * 8 + 6] = -x * X; A[r1 * 8 + 7] = -y * X; b[r1] = X;
      A[r2 * 8 + 3] = x; A[r2 * 8 + 4] = y; A[r2 * 8 + 5] = 1;
      A[r2 * 8 + 6] = -x * Y; A[r2 * 8 + 7] = -y * Y; b[r2] = Y;
    }
    var h = solve(A, b, 8);
    if (!h) return null;
    return new Float64Array([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]);
  }

  function applyH(H, x, y) {
    var w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  function invertH(H) {
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7], i = H[8];
    var A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
    var D = f * g - d * i, E = a * i - c * g, F = c * d - a * f;
    var G = d * h - e * g, Hh = b * g - a * h, I = a * e - b * d;
    var det = a * A + b * D + c * G;
    if (Math.abs(det) < 1e-14) return null;
    return new Float64Array([A / det, B / det, C / det, D / det, E / det, F / det, G / det, Hh / det, I / det]);
  }

  function bilinear(img, x, y) {
    var w = img.w, h = img.h, d = img.data;
    if (x < 0) x = 0; if (y < 0) y = 0;
    if (x > w - 1.001) x = w - 1.001; if (y > h - 1.001) y = h - 1.001;
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var fx = x - x0, fy = y - y0;
    var i00 = y0 * w + x0;
    var v00 = d[i00], v10 = d[i00 + 1], v01 = d[i00 + w], v11 = d[i00 + w + 1];
    return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
  }

  function makeImage(w, h) { return { w: w, h: h, data: new Float32Array(w * h) }; }

  var API = { solve: solve, homographyFromPoints: homographyFromPoints, applyH: applyH, invertH: invertH, bilinear: bilinear, makeImage: makeImage };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.geom = API;
})(typeof window !== "undefined" ? window : globalThis);
