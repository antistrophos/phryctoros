/* profile.js — the emission profile: the contract (spec §8), plus the validator.
   UNITS (review F4): every length is in units of FIDUCIAL WIDTH, measured from the
   emission centre. Registration measures the fiducial, so geometry is camera-
   invariant by construction. The validator embodies review findings F1 (flicker
   bound), F5 (coupling rules), and the spec's own collision/slip bounds. */
(function (global) {
  "use strict";

  function defaultProfile(overrides) {
    var p = {
      // v2: THE LAYER SWAP (first-walk finding 3). Spec §7.1's rule and §7.6's
      // table put layer 0 OUTERMOST; the §7.1 diagram says the opposite and v1
      // faithfully implemented the diagram. Field physics endorsed the rule:
      // phase noise scales as blur-px/radius-px, so the base layer belongs on
      // the biggest ring. v1 clips decode only under profileV1() — the profile
      // is the CONTRACT, and this swap is an emission version, not a patch.
      profile_version: "phase0-v2",
      units: "fiducial-width",
      // 15 fps emission against 30 fps capture: every emission frame persists two
      // camera frames, so one of each pair escapes the rolling-shutter/refresh
      // TEAR (field-clip-2 finding) and the decoder selects it by fit residual.
      // Also halves render load — margin against the throttle-stall failure mode.
      frame_rate_hz: 15,
      render: {
        size_px: 1024,
        scale_px_per_unit: 166,   // fiducial width in pixels (validator needs r_max + margin ≤ size/2)
        background: 0.62,
        fill: 0.32,               // low contrast by default — review F1/§7.7 dividend
        edge_soft_px: 1.6         // linear soft edge; decoder's 0.5-crossing is the boundary
      },
      fiducial: {
        type: "finders-only",     // Phase 0: registration only; enrollment QR payload is future work
        modules: 25,
        quiet_modules: 4,
        seed: 77,
        dark: 0.05, light: 0.95   // finders need punch; they are static (small area)
      },
      preamble_symbols: 8,
      annuli: [
        { index: 0, layer: 2, r_inner: 1.05, r0: 1.45,
          rotation: { nominal_hz: 0.75, rate_tier_fps: 15, constellation: "d16psk", M: 16, gray: true, frames_per_symbol: 4, seed: 101 },
          boundary: { harmonics: [1, 2, 3, 5, 8, 13, 20], amplitudes: [0.030, 0.020, 0.020, 0.015, 0.015, 0.015, 0.015], phases_deg: [0, 25, 50, 75, 100, 125, 150] } },
        { index: 1, layer: 1, r_inner: 1.75, r0: 2.15,
          rotation: { nominal_hz: 1.0, rate_tier_fps: 15, constellation: "d8psk", M: 8, gray: true, frames_per_symbol: 4, seed: 202 },
          boundary: { harmonics: [1, 2, 3, 5, 8], amplitudes: [0.020, 0.030, 0.030, 0.030, 0.030], phases_deg: [0, 30, 60, 90, 120] } },
        { index: 2, layer: 0, r_inner: 2.45, r0: 2.85,
          rotation: { nominal_hz: 1.5, rate_tier_fps: 15, constellation: "dqpsk", M: 4, gray: true, frames_per_symbol: 4, seed: 303 },
          boundary: { harmonics: [1, 2, 3], amplitudes: [0.030, 0.045, 0.045], phases_deg: [0, 40, 80] } }
      ],
      layers: [
        { index: 0, role: "base" },
        { index: 1, role: "enhancement" },
        { index: 2, role: "enhancement" }
      ]
    };
    if (overrides) deepMerge(p, overrides);
    return p;
  }

  function deepMerge(dst, src) {
    for (var k in src) {
      if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k]) && dst[k] && typeof dst[k] === "object" && !Array.isArray(dst[k])) deepMerge(dst[k], src[k]);
      else dst[k] = src[k];
    }
    return dst;
  }

  function sumAmp(a) { var s = 0; for (var i = 0; i < a.boundary.amplitudes.length; i++) s += a.boundary.amplitudes[i]; return s; }

  // Radial sampling window for an annulus (shared emitter/decoder assumption).
  function sampleWindow(a) {
    var s = sumAmp(a);
    return { lo: a.r0 - s - 0.08, hi: a.r0 + s + 0.08 };
  }

  /* validate(profile) -> { ok, errors[], warnings[], flicker } */
  function validate(p) {
    var errors = [], warnings = [];
    var fps = p.frame_rate_hz;
    var halfSizeUnits = (p.render.size_px / 2) / p.render.scale_px_per_unit;
    var fidHalfWithQuiet = 0.5 * (p.fiducial.modules + 2 * p.fiducial.quiet_modules) / p.fiducial.modules;
    var fidCornerRadius = fidHalfWithQuiet * Math.SQRT2;

    for (var i = 0; i < p.annuli.length; i++) {
      var a = p.annuli[i], tag = "annulus " + a.index + ": ";
      var s = sumAmp(a);
      if (a.boundary.harmonics.length !== a.boundary.amplitudes.length ||
          a.boundary.harmonics.length !== a.boundary.phases_deg.length)
        errors.push(tag + "harmonics/amplitudes/phases_deg length mismatch");

      // F5(c): slip ambiguity — require an odd harmonic (k=1 anchors the ladder).
      var hasOdd = a.boundary.harmonics.some(function (k) { return k % 2 === 1; });
      if (!hasOdd) errors.push(tag + "all harmonics even — half-turn symmetry halves the slip bound (F5c); include an odd pilot");
      if (a.boundary.harmonics[0] !== 1) warnings.push(tag + "no k=1 pilot — the phase ladder loses its unambiguous anchor");

      // F5(d): magnitude floors (static pilots in v0, but keep the floor stated).
      for (var j = 0; j < a.boundary.amplitudes.length; j++)
        if (a.boundary.amplitudes[j] * p.render.scale_px_per_unit < 1.5)
          warnings.push(tag + "harmonic k=" + a.boundary.harmonics[j] + " amplitude under ~1.5 px at this scale — phase reads will be noisy");

      // Geometry collisions (spec §7.4: enforce at validation, not render).
      if (a.r_inner + 0.03 > a.r0 - s - 0.08)
        errors.push(tag + "sampling window bottom (" + (a.r0 - s - 0.08).toFixed(3) + ") is inside r_inner + margin");
      if (i === 0 && a.r_inner < fidCornerRadius + 0.03)
        errors.push(tag + "r_inner " + a.r_inner + " intrudes on fiducial quiet zone (corner radius " + fidCornerRadius.toFixed(3) + ")");
      if (i > 0) {
        var prev = p.annuli[i - 1];
        if (prev.r0 + sumAmp(prev) + 0.05 > a.r_inner)
          errors.push(tag + "collides with annulus " + prev.index + " (prev outer max " + (prev.r0 + sumAmp(prev)).toFixed(3) + " vs r_inner " + a.r_inner + ")");
      }
      if (a.r0 + s + 0.04 > halfSizeUnits)
        errors.push(tag + "outer boundary max " + (a.r0 + s).toFixed(3) + " exceeds render half-size " + halfSizeUnits.toFixed(3));

      // Cycle-slip bound (spec §7.3): nominal advance + worst deviation per frame.
      var nomDeg = 360 * a.rotation.nominal_hz / fps;
      var devDeg = (180 / a.rotation.frames_per_symbol); // worst |Δ| = 180° spread over the symbol
      var per = nomDeg + devDeg;
      if (per > 150) errors.push(tag + "per-frame advance " + per.toFixed(1) + "° breaks the slip bound");
      else if (per > 90) warnings.push(tag + "per-frame advance " + per.toFixed(1) + "° leaves little headroom (spec asks 'well below 180°')");
    }

    var flicker = (global.OC && global.OC.flicker) ? global.OC.flicker.report(p)
      : (typeof require !== "undefined" ? require("./flicker.js").report(p) : null);
    if (flicker && flicker.worstBandHit && p.render.background - p.render.fill > 0.35)
      warnings.push("flicker: harmonic content lands in the 3–60 Hz band at contrast > 0.35 — drop contrast or slow rotation (F1)");

    return { ok: errors.length === 0, errors: errors, warnings: warnings, flicker: flicker };
  }

  /* The v1 emission contract, frozen: layer 0 innermost (the §7.1-diagram
     ordering v1 shipped with). Clips filmed under v1 decode ONLY under this. */
  function profileV1(overrides) {
    var p = defaultProfile();
    p.profile_version = "phase0-v1";
    p.annuli = [
      { index: 0, layer: 0, r_inner: 1.05, r0: 1.45,
        rotation: { nominal_hz: 1.5, rate_tier_fps: 30, constellation: "dqpsk", M: 4, gray: true, frames_per_symbol: 4, seed: 101 },
        boundary: { harmonics: [1, 2, 3], amplitudes: [0.030, 0.050, 0.050], phases_deg: [0, 40, 80] } },
      { index: 1, layer: 1, r_inner: 1.75, r0: 2.15,
        rotation: { nominal_hz: 1.0, rate_tier_fps: 30, constellation: "d8psk", M: 8, gray: true, frames_per_symbol: 4, seed: 202 },
        boundary: { harmonics: [1, 2, 3, 5, 8], amplitudes: [0.020, 0.030, 0.030, 0.030, 0.030], phases_deg: [0, 30, 60, 90, 120] } },
      { index: 2, layer: 2, r_inner: 2.45, r0: 2.85,
        rotation: { nominal_hz: 0.75, rate_tier_fps: 30, constellation: "d16psk", M: 16, gray: true, frames_per_symbol: 4, seed: 303 },
        boundary: { harmonics: [1, 2, 3, 5, 8, 13, 20], amplitudes: [0.014, 0.018, 0.018, 0.018, 0.018, 0.018, 0.018], phases_deg: [0, 25, 50, 75, 100, 125, 150] } }
    ];
    if (overrides) deepMerge(p, overrides);
    return p;
  }

  var API = { defaultProfile: defaultProfile, profileV1: profileV1, validate: validate, sumAmp: sumAmp, sampleWindow: sampleWindow, deepMerge: deepMerge };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.profile = API;
})(typeof window !== "undefined" ? window : globalThis);
