/* degrade.js — the degradation suite's transforms (spec §10.2), applied to clean
   frames: blur, noise, flip, rotation, exposure/white-balance ramps, resampling,
   composites for multi-emitter frames. All pure functions on {w,h,data}. */
(function (global) {
  "use strict";

  function P() { return (typeof module !== "undefined" && module.exports) ? require("./prng.js") : global.OC.prng; }
  function G() { return (typeof module !== "undefined" && module.exports) ? require("./geom.js") : global.OC.geom; }

  function clone(img) { return { w: img.w, h: img.h, data: new Float32Array(img.data) }; }

  function gaussianKernel(sigma) {
    var half = Math.max(1, Math.ceil(3 * sigma));
    var k = new Float64Array(2 * half + 1), sum = 0;
    for (var i = -half; i <= half; i++) { var v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + half] = v; sum += v; }
    for (var j = 0; j < k.length; j++) k[j] /= sum;
    return { k: k, half: half };
  }

  function blur(img, sigma) {
    if (sigma <= 0) return clone(img);
    var kk = gaussianKernel(sigma), k = kk.k, half = kk.half;
    var w = img.w, h = img.h;
    var tmp = new Float32Array(w * h), out = { w: w, h: h, data: new Float32Array(w * h) };
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var acc = 0;
      for (var t = -half; t <= half; t++) {
        var xx = Math.min(w - 1, Math.max(0, x + t));
        acc += img.data[y * w + xx] * k[t + half];
      }
      tmp[y * w + x] = acc;
    }
    for (var y2 = 0; y2 < h; y2++) for (var x2 = 0; x2 < w; x2++) {
      var acc2 = 0;
      for (var t2 = -half; t2 <= half; t2++) {
        var yy = Math.min(h - 1, Math.max(0, y2 + t2));
        acc2 += tmp[yy * w + x2] * k[t2 + half];
      }
      out.data[y2 * w + x2] = acc2;
    }
    return out;
  }

  function addNoise(img, sigma, seed) {
    var out = clone(img);
    var g = P().gaussian(P().mulberry32(seed >>> 0));
    for (var i = 0; i < out.data.length; i++) {
      var v = out.data[i] + sigma * g();
      out.data[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
    }
    return out;
  }

  function flipH(img) {
    var out = { w: img.w, h: img.h, data: new Float32Array(img.w * img.h) };
    for (var y = 0; y < img.h; y++)
      for (var x = 0; x < img.w; x++)
        out.data[y * img.w + x] = img.data[y * img.w + (img.w - 1 - x)];
    return out;
  }

  function rotate(img, deg) {
    var th = deg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
    var cx = img.w / 2, cy = img.h / 2;
    var out = { w: img.w, h: img.h, data: new Float32Array(img.w * img.h) };
    var g = G();
    for (var y = 0; y < img.h; y++) for (var x = 0; x < img.w; x++) {
      var dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      var sx = cx + c * dx + s * dy - 0.5, sy2 = cy - s * dx + c * dy - 0.5;
      out.data[y * img.w + x] = (sx < 0 || sy2 < 0 || sx > img.w - 1 || sy2 > img.h - 1) ? img.data[0] : g.bilinear(img, sx, sy2);
    }
    return out;
  }

  /* Affine warp about the image centre (inverse-mapped, bilinear) — the tilt
     proxy for the ellipse-correction suite: a camera off the screen normal
     sees the emission's circles as ellipses. m = [a, b, c, d] is the FORWARD
     linear map [[a, b], [c, d]] applied about the centre. */
  function warpAffine(img, m) {
    var a = m[0], b = m[1], c = m[2], d = m[3];
    var det = a * d - b * c;
    var ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
    var cx = img.w / 2, cy = img.h / 2;
    var out = { w: img.w, h: img.h, data: new Float32Array(img.w * img.h) };
    var g = G();
    for (var y = 0; y < img.h; y++) for (var x = 0; x < img.w; x++) {
      var dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      var sx = cx + ia * dx + ib * dy - 0.5, sy = cy + ic * dx + id * dy - 0.5;
      out.data[y * img.w + x] = (sx < 0 || sy < 0 || sx > img.w - 1 || sy > img.h - 1) ? img.data[0] : g.bilinear(img, sx, sy);
    }
    return out;
  }

  /* Projective warp about the image centre — the finite-distance tilt. Unlike
     warpAffine, ring centres shift with r² (the perspective k=1 that field30
     convicted: invisible to a fiducial-local affine, lethal at ring radius).
     H3 is the FORWARD row-major 3x3 applied about the centre. */
  function warpH(img, H3) {
    var g = G();
    var inv = g.invertH(H3);
    var cx = img.w / 2, cy = img.h / 2;
    var out = { w: img.w, h: img.h, data: new Float32Array(img.w * img.h) };
    for (var y = 0; y < img.h; y++) for (var x = 0; x < img.w; x++) {
      var pt = g.applyH(inv, x + 0.5 - cx, y + 0.5 - cy);
      var sx = cx + pt[0] - 0.5, sy = cy + pt[1] - 0.5;
      out.data[y * img.w + x] = (sx < 0 || sy < 0 || sx > img.w - 1 || sy > img.h - 1) ? img.data[0] : g.bilinear(img, sx, sy);
    }
    return out;
  }

  /* Exposure/white-balance ramp: gain and offset (C2 witness — must have no effect). */
  function exposure(img, gain, offset) {
    var out = clone(img);
    for (var i = 0; i < out.data.length; i++) {
      var v = out.data[i] * gain + offset;
      out.data[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
    }
    return out;
  }

  function resample(img, scale) {
    var w = Math.round(img.w * scale), h = Math.round(img.h * scale);
    var out = { w: w, h: h, data: new Float32Array(w * h) };
    var g = G();
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++)
      out.data[y * w + x] = g.bilinear(img, (x + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5);
    return out;
  }

  /* Two-emitter composite: A at left, B (scaled) at right, on a light ground. */
  function composite2(imgA, imgB, scaleB, bgVal) {
    var b = resample(imgB, scaleB);
    var w = imgA.w + b.w + 24, h = Math.max(imgA.h, b.h);
    var out = { w: w, h: h, data: new Float32Array(w * h) };
    out.data.fill(bgVal);
    blit(out, imgA, 0, Math.floor((h - imgA.h) / 2));
    blit(out, b, imgA.w + 24, Math.floor((h - b.h) / 2));
    return out;
  }

  /* Rolling-shutter/refresh tear: top rows from A (earlier instant), bottom rows
     from B (later instant) — the temporal composite field-clip-2 photographed. */
  function tearComposite(imgA, imgB, splitRow) {
    var out = clone(imgA);
    for (var y = splitRow; y < imgB.h; y++)
      for (var x = 0; x < imgB.w; x++)
        out.data[y * out.w + x] = imgB.data[y * imgB.w + x];
    return out;
  }

  function blit(dst, src, ox, oy) {
    for (var y = 0; y < src.h; y++)
      for (var x = 0; x < src.w; x++)
        dst.data[(oy + y) * dst.w + (ox + x)] = src.data[y * src.w + x];
  }

  function dropSet(nFrames, frac, seed) {
    var rng = P().mulberry32(seed >>> 0), s = {};
    for (var f = 0; f < nFrames; f++) if (rng() < frac) s[f] = true;
    return s;
  }

  var API = { clone: clone, blur: blur, addNoise: addNoise, flipH: flipH, rotate: rotate, warpAffine: warpAffine, warpH: warpH, exposure: exposure, resample: resample, composite2: composite2, tearComposite: tearComposite, dropSet: dropSet };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.degrade = API;
})(typeof window !== "undefined" ? window : globalThis);
