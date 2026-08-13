/* emission.js — profile-driven emission: symbol schedule + analytic per-pixel renderer.
   Shared by the emitter page, the golden renderer (deterministic trig), and the
   synthetic test path. Rendering is ANALYTIC (no canvas primitives): every pixel is
   evaluated from the profile, which is what makes a pinned reference rasterizer
   possible at all (review F8).

   Conventions (must match the decoder):
     φ_a(f)      = 2π·nominal_hz·f/fps + θ_data(f)           [radians]
     r_out(θ, f) = r0 + Σ_k a_k · cos(k·(θ − φ_a) + ψ_k)
     so arg(c_k) of the decoder's DFT (e^{-ikθ} convention) equals ψ_k − k·φ_a.
   Differential data: symbol s → Δθ = wrapSigned(s · 2π/M), swept linearly across
   frames_per_symbol frames (CPM: no phase jumps; rate steps at symbol boundaries). */
(function (global) {
  "use strict";

  function P() { return (typeof module !== "undefined" && module.exports) ? require("./prng.js") : global.OC.prng; }

  var TAU = Math.PI * 2;

  function wrapSigned(x) { // wrap to (-π, π]
    x = x % TAU; if (x > Math.PI) x -= TAU; if (x <= -Math.PI) x += TAU; return x;
  }

  /* Symbol schedule for one annulus: preamble (alternating +step/−step) then seeded data.
     Returns { symbols, deltas, base, thetaData(f), nSymbols } — angles in radians. */
  function buildSchedule(annulus, fps, nFrames, preambleSymbols) {
    var F = annulus.rotation.frames_per_symbol, M = annulus.rotation.M;
    var nSym = Math.ceil(nFrames / F) + 1;
    var symbols = new Uint8Array(nSym);
    var nData = Math.max(0, nSym - preambleSymbols);
    var data = P().symbolStream(annulus.rotation.seed, nData, M);
    for (var i = 0; i < nSym; i++)
      symbols[i] = i < preambleSymbols ? (i % 2 === 0 ? 1 : M - 1) : data[i - preambleSymbols];
    var deltas = new Float64Array(nSym), base = new Float64Array(nSym + 1);
    for (var j = 0; j < nSym; j++) {
      deltas[j] = wrapSigned(symbols[j] * TAU / M);
      base[j + 1] = base[j] + deltas[j];
    }
    function thetaData(f) {
      var i2 = Math.floor(f / F);
      if (i2 >= nSym) i2 = nSym - 1;
      var u = (f - i2 * F) / F;
      return base[i2] + deltas[i2] * u;
    }
    return { symbols: symbols, deltas: deltas, base: base, thetaData: thetaData, nSymbols: nSym, dataSymbols: data };
  }

  /* Full emission schedule: one per annulus. */
  function buildSchedules(profile, nFrames) {
    return profile.annuli.map(function (a) {
      return buildSchedule(a, profile.frame_rate_hz, nFrames, profile.preamble_symbols);
    });
  }

  function phaseAt(annulus, schedule, fps, f) {
    return TAU * annulus.rotation.nominal_hz * f / fps + schedule.thetaData(f);
  }

  /* Fiducial module map: finders (TL/TR/BL), timing lines, seeded static fill. 1 = dark. */
  function fiducialModules(fid) {
    var n = fid.modules, m = new Uint8Array(n * n);
    var rng = P().mulberry32(fid.seed);
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) m[y * n + x] = rng() < 0.5 ? 1 : 0;
    function finder(ox, oy) {
      for (var j = 0; j < 7; j++) for (var i = 0; i < 7; i++) {
        var d = Math.max(Math.abs(i - 3), Math.abs(j - 3));
        m[(oy + j) * n + (ox + i)] = (d === 3 || d <= 1) ? 1 : 0;
      }
      for (var q = -1; q <= 7; q++) { // one-module light separator ring (clipped at edges)
        setIf(ox + q, oy - 1, 0); setIf(ox + q, oy + 7, 0);
        setIf(ox - 1, oy + q, 0); setIf(ox + 7, oy + q, 0);
      }
    }
    function setIf(x, y, v) { if (x >= 0 && y >= 0 && x < n && y < n) m[y * n + x] = v; }
    finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
    for (var t = 8; t <= n - 9; t++) { m[6 * n + t] = (t % 2 === 0) ? 1 : 0; m[t * n + 6] = (t % 2 === 0) ? 1 : 0; }
    return m;
  }

  /* Render frame f to {w,h,data} luminance. opts: { trig: {sin,cos,atan2} } for the
     deterministic golden path; defaults to native Math. */
  function renderFrame(profile, f, opts) {
    opts = opts || {};
    var sin = opts.trig ? opts.trig.sin : Math.sin;
    var cos = opts.trig ? opts.trig.cos : Math.cos;
    var atan2 = opts.trig ? opts.trig.atan2 : Math.atan2;
    var schedules = opts.schedules || buildSchedules(profile, f + 1);

    var R = profile.render, size = R.size_px, scale = R.scale_px_per_unit;
    var img = { w: size, h: size, data: new Float32Array(size * size) };
    var bg = R.background, fill = R.fill, soft = R.edge_soft_px;
    var fid = profile.fiducial, nMod = fid.modules;
    var modules = opts.modules || fiducialModules(fid);
    var quietHalf = 0.5 + fid.quiet_modules / nMod;
    var fps = profile.frame_rate_hz;

    // Per-annulus per-frame constants.
    var ann = profile.annuli.map(function (a, ai) {
      var phi = phaseAt(a, schedules[ai], fps, f);
      var betas = a.boundary.harmonics.map(function (k, j) {
        return { k: k, a: a.boundary.amplitudes[j], beta: a.boundary.phases_deg[j] * Math.PI / 180 - k * phi };
      });
      var sA = 0; for (var j2 = 0; j2 < a.boundary.amplitudes.length; j2++) sA += a.boundary.amplitudes[j2];
      var pad = (soft / scale) * 2 + 0.01;
      return { a: a, betas: betas, rMin: a.r_inner - pad, rMax: a.r0 + sA + pad, phi: phi };
    });

    var half = size / 2, d = img.data;
    for (var py = 0; py < size; py++) {
      var y = (py + 0.5 - half) / scale;
      var rowOff = py * size;
      for (var px = 0; px < size; px++) {
        var x = (px + 0.5 - half) / scale;
        var v = bg;
        var ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
        if (ax <= quietHalf && ay <= quietHalf) {
          v = fid.light;
          if (ax <= 0.5 && ay <= 0.5) {
            var mx = Math.floor((x + 0.5) * nMod); if (mx >= nMod) mx = nMod - 1;
            var my = Math.floor((y + 0.5) * nMod); if (my >= nMod) my = nMod - 1;
            v = modules[my * nMod + mx] ? fid.dark : fid.light;
          }
        } else {
          var r = Math.sqrt(x * x + y * y);
          for (var ai2 = 0; ai2 < ann.length; ai2++) {
            var A = ann[ai2];
            if (r < A.rMin || r > A.rMax) continue;
            var th = atan2(y, x);
            var b = A.a.r0;
            for (var h2 = 0; h2 < A.betas.length; h2++) {
              var B = A.betas[h2];
              b += B.a * cos(B.k * th + B.beta);
            }
            var covOuter = clamp01((b - r) * scale / soft + 0.5);
            var covInner = clamp01((r - A.a.r_inner) * scale / soft + 0.5);
            var cov = covOuter * covInner;
            if (cov > 0) v = bg + (fill - bg) * cov;
            break; // annuli are disjoint by validation
          }
        }
        d[rowOff + px] = v;
      }
    }
    return img;
  }

  function clamp01(u) { return u < 0 ? 0 : (u > 1 ? 1 : u); }

  /* Render a sequence [f0, f0+n) sharing schedules/modules. */
  function renderSequence(profile, n, opts) {
    opts = opts || {};
    var schedules = buildSchedules(profile, n);
    var modules = fiducialModules(profile.fiducial);
    var frames = [];
    for (var f = 0; f < n; f++)
      frames.push({ f: f, img: renderFrame(profile, f, { trig: opts.trig, schedules: schedules, modules: modules }) });
    return { frames: frames, schedules: schedules };
  }

  /* Browser helper: luminance image -> ImageData (RGBA gray). */
  function toImageData(img, imageData) {
    var n = img.w * img.h, src = img.data, out = imageData.data;
    for (var i = 0; i < n; i++) {
      var g = Math.round(clamp01(src[i]) * 255);
      var o = i * 4; out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
    }
    return imageData;
  }

  var API = {
    wrapSigned: wrapSigned, buildSchedule: buildSchedule, buildSchedules: buildSchedules,
    phaseAt: phaseAt, fiducialModules: fiducialModules, renderFrame: renderFrame,
    renderSequence: renderSequence, toImageData: toImageData, TAU: TAU
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.emission = API;
})(typeof window !== "undefined" ? window : globalThis);
