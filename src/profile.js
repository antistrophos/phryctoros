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
        // Finders need CONTRAST, not brightness. light == render.background: the
        // fiducial must never be the brightest thing on screen — the practitioner
        // watched AE meter on the old 0.95 white (especially under the advised
        // AF/AE-lock on the fiducial) and crush the low-contrast annuli. Dark
        // modules on the field's own gray give the 1:1:3:1:1 scan a 0.57 swing.
        dark: 0.05, light: 0.62,
        // AF collar — DISABLED after two suite-caught failures. Both 12 thin
        // spokes AND 4 fat cardinal arcs generated finder-like candidates (arc
        // edges/tips scan at ~4px units, inside the grouper's 1.6× unit
        // tolerance) and corrupted triple grouping into plausible-but-wrong
        // homographies (fid read 96px where truth was 124). ANY high-contrast
        // texture near the fiducial is a registration decoy until triple
        // acceptance VERIFIES against the fiducial's own structure (timing
        // pattern along the implied grid) — that decoy-robust grouping is the
        // prerequisite, queued with the registration work. Until then the AF
        // answer is operational: AE/AF-lock on the fiducial before recording.
        // af_collar: { r_in: 0.72, r_out: 0.98, spokes: 4 }
        af_collar: null
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
    if (isV3(p)) return validateV3(p);
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
      if (i === 0 && p.fiducial.af_collar && p.fiducial.af_collar.r_out + 0.05 > a.r0 - s - 0.08)
        errors.push("AF collar r_out " + p.fiducial.af_collar.r_out + " intrudes on annulus " + a.index + "'s sampling window");
      if (i === 0 && a.r_inner < fidCornerRadius + 0.03)
        errors.push(tag + "r_inner " + a.r_inner + " intrudes on fiducial quiet zone (corner radius " + fidCornerRadius.toFixed(3) + ")");
      if (i === 0 && p.fiducial.light > p.render.background + 0.05)
        warnings.push("fiducial.light " + p.fiducial.light + " out-brights the field (" + p.render.background + ") — AE meters the white and crushes the annuli (field finding)");
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

  /* The 20 fps rate variant of v2 (walk-6 follow-on). Same geometry, same
     rotation nominal_hz — the F1 flicker report is seconds-denominated, so it
     is IDENTICAL to v2's — and the same frames_per_symbol, so the symbol rate
     rises 3.75 → 5 sym/s (+33%) on every ring. 20 divides the 60 Hz refresh
     (each frame holds exactly 3 vsyncs; 24 does not divide 60, which is why
     20 goes first). Against 30 fps capture each emission frame gets 1.5 looks:
     worst-phase cameras leave alternate frames with only a TORN look, so this
     variant stands on F2 row-time repair where v2 stood on duplicate
     selection. Slip margin improves (per-frame nominal advance shrinks 15/20). */
  function profileV2r20(overrides) {
    var p = defaultProfile();
    p.profile_version = "phase0-v2r20";
    p.frame_rate_hz = 20;
    for (var i = 0; i < p.annuli.length; i++) p.annuli[i].rotation.rate_tier_fps = 20;
    if (overrides) deepMerge(p, overrides);
    return p;
  }

  /* The 30 fps rate variant — REQUIRES 60 fps capture (the 24 fps design
     note's condition, satisfied the clean way): 60/30 = the exact 2-looks-
     per-frame geometry the proven 15@30 tear defense was designed around,
     with duplicate SELECTION carrying tears again (rowtime stays backstop).
     Same nominal_hz (flicker identical), same frames_per_symbol → symbol
     rate 3.75 → 7.5 sym/s (+100% on every ring, droplet rate included);
     slip margin improves further (L0 per-frame advance 81° → 63°). 30
     divides the 60 Hz refresh (2 vsyncs/frame). Costs are capture-side and
     physical: 1/60 s exposure halves per-frame light, 60 fps halves
     per-frame codec bitrate — film LIT and well-framed. */
  function profileV2r30(overrides) {
    var p = defaultProfile();
    p.profile_version = "phase0-v2r30";
    p.frame_rate_hz = 30;
    for (var i = 0; i < p.annuli.length; i++) p.annuli[i].rotation.rate_tier_fps = 30;
    if (overrides) deepMerge(p, overrides);
    return p;
  }

  /* THE V3 CONTRACT (frozen 2026-08-16, corpus technical/phryctoros-v3-contract.md):
     trough-packed tiles on a self-anchoring calibration plate. Four boundary-CPM
     EDGE channels in three dark bands — the entries in `annuli` are now EDGES
     (r0 = edge base radius, crossing = luminance sense walking outward: "up" =
     fill→bg, "down" = bg→fill, the sampler's flipped mode) so every per-channel
     machine (schedules, fountain carousels, demap) rides unchanged. Bands are
     the render primitive; each references its lo/hi boundary as a fixed radius
     or an edge index. UNITS SELF-ANCHOR: the unmodulated outer circle ≡ 3.00
     units, measured every frame with nothing to average — no fiducial-width
     anchor, QR-free steady state. Presets (§2): ONE toggle, session-atomic;
     the base edge never upgrades (must-decode tier + the M≤4 carrier gate). */
  function profileV3(preset, overrides) {
    var hi = preset === "high-rate";
    var p = {
      profile_version: hi ? "v3-hr" : "v3",
      units: "flat-circle-3.00",
      preset: hi ? "high-rate" : "resilient",
      frame_rate_hz: 30,            // §7: 30 fps emission @ 60 fps capture baseline
      render: {
        size_px: 1024,
        scale_px_per_unit: 166,     // half-size 3.084 units; corners at 2.65+0.40=3.05 fit (§5 amended)
        background: 0.62,
        fill: 0.32,                 // contrast 0.30 — the F1 dividend, carried from v2
        edge_soft_px: 1.6
      },
      preamble_symbols: 8,          // §1: preamble as v2
      carriage: { droplet_bits: hi ? 48 : 24, self_framing: true },  // §2/§3
      countdown: { freeze_s: 3, loop_s: 60 },  // §6: defaults 3/60, floor freeze ≥ 1
      // §6 envelope QR (recurring, internal format, dark-on-gray). Width chosen so
      // the quiet-inclusive half-DIAGONAL stays inside the 0.90 donut budget.
      qr: { modules: 25, quiet_modules: 2, width_units: 1.08, dark: 0.05, seed: 909 },
      session32: 0,                 // emit page stamps the real session id
      // §7 density knob: 1 / 2 / 6-up (grid beats hex on 16:9 to 2 rows).
      // §5: gutter ≥ 1.2 between flat circles → tile pitch ≥ 7.2. Tile 0 is
      // the DESIGNATED tile — the only one carrying the breaker ring pair and
      // the beacon (§5's count asymmetry doing tile identity); gutter-vertex
      // bullseyes (0.40) sit on the shared lattice. Tiles carry the same
      // blocks under tile-shifted seeds (fountain.tileSeed).
      tiling: 1,
      tile_pitch: 7.2,
      // §1 edge table. B's edges share nominal φ (same nominal_hz), distinct data
      // (distinct seeds) — the differential-pair demod is the decoder follow-on.
      annuli: [
        { index: 0, layer: 3, band: 0, edge: "A-outer", crossing: "up", r0: 1.42,
          rotation: { nominal_hz: 0.75, rate_tier_fps: 30, constellation: hi ? "d32psk" : "d16psk", M: hi ? 32 : 16, gray: true, frames_per_symbol: 4, seed: 401 },
          boundary: { harmonics: [1, 2, 3, 5, 8, 13], amplitudes: [0.030, 0.012, 0.012, 0.012, 0.012, 0.012], phases_deg: [0, 25, 50, 75, 100, 125] } },
        { index: 1, layer: 2, band: 1, edge: "B-inner", crossing: "down", r0: 1.80,
          rotation: { nominal_hz: 1.0, rate_tier_fps: 30, constellation: hi ? "d32psk" : "d16psk", M: hi ? 32 : 16, gray: true, frames_per_symbol: 4, seed: 402 },
          boundary: { harmonics: [1, 2, 3, 5, 8, 13], amplitudes: [0.030, 0.012, 0.012, 0.012, 0.012, 0.012], phases_deg: [0, 30, 60, 90, 120, 150] } },
        { index: 2, layer: 1, band: 1, edge: "B-outer", crossing: "up", r0: 2.30,
          rotation: { nominal_hz: 1.0, rate_tier_fps: 30, constellation: hi ? "d16psk" : "d8psk", M: hi ? 16 : 8, gray: true, frames_per_symbol: 4, seed: 403 },
          boundary: { harmonics: [1, 2, 3, 5, 8], amplitudes: [0.030, 0.015, 0.015, 0.015, 0.015], phases_deg: [0, 35, 70, 105, 140] } },
        { index: 3, layer: 0, band: 2, edge: "C-inner", crossing: "down", r0: 2.68,
          rotation: { nominal_hz: 1.5, rate_tier_fps: 30, constellation: "dqpsk", M: 4, gray: true, frames_per_symbol: 4, seed: 404 },
          boundary: { harmonics: [1, 2, 3], amplitudes: [0.030, 0.030, 0.030], phases_deg: [0, 40, 80] } }
      ],
      bands: [
        { index: 0, name: "A", lo: { fixed: 1.05 }, hi: { edge: 0 } },
        { index: 1, name: "B", lo: { edge: 1 }, hi: { edge: 2 } },
        { index: 2, name: "C", lo: { edge: 3 }, hi: { fixed: 3.00, flat: true } }
      ],
      flat_circle_r: 3.00,
      // §5 plate, as amended: corners plain 0.40 at (±2.65, ±2.65); center 2:1:2
      // to 0.60 plus the breaker ring pair to 0.80 (= the count asymmetry AND the
      // beacon carrier); donut budget 0.90 with 0.15 quiet to A-inner. The plate
      // renders at the FILL shade (contrast 0.30, same as the bands): a full-dark
      // bullseye field would make the center an AE sink no countdown QR could
      // match-mean against — detection is self-normalized and the structures are
      // huge, so the F1-dividend contrast is the right spend here too.
      plate: {
        shade: 0.32,
        corners: { r_out: 0.40, at: 2.65 },
        center: { r_out: 0.60 },
        breaker: { r_in: 0.70, r_out: 0.80 },
        quiet_r: 0.90
      },
      // §5 THE BEACON RING: boundary-CPM on the breaker pair, both edges carrying
      // the SAME offset (constant ring width → luminance-constant; temporal keying
      // would land in the F1 band — wiggle is forced). M=2 default / 4 negotiable;
      // 7.5–15 bit/s = the acoustic FSK rate class. Near-field tier by physics.
      beacon: {
        rotation: { nominal_hz: 0.75, rate_tier_fps: 30, constellation: "beacon-cpm", M: 2, gray: false, frames_per_symbol: 4, seed: 505 },
        harmonics: [1, 2, 3], amplitudes: [0.010, 0.008, 0.007], phases_deg: [0, 45, 90]
      },
      layers: [
        { index: 0, role: "base" },          // C-inner: best radius, most robust M, carrier gate
        { index: 1, role: "mid" },           // B-outer
        { index: 2, role: "enhancement" },   // B-inner (close-range)
        { index: 3, role: "enhancement" }    // A-outer (close-range)
      ]
    };
    if (overrides) deepMerge(p, overrides);
    return p;
  }

  function isV3(p) { return !!(p && p.bands && p.plate); }

  /* Resolve a band boundary ref to { r0, sum, edge } (sum = worst excursion). */
  function bandBoundary(p, ref) {
    if (ref.edge !== undefined) { var a = p.annuli[ref.edge]; return { r0: a.r0, sum: sumAmp(a), edge: a }; }
    return { r0: ref.fixed, sum: 0, edge: null };
  }

  /* The v3 validator. Geometry rules derive from the ACTUAL numbers (a probe
     variant with smaller amps passes on its own geometry); deviations from the
     frozen contract numbers warn rather than error, so §1's "amendments = v3.1"
     stays a human rule, not a code gate. */
  function validateV3(p) {
    var errors = [], warnings = [];
    var fps = p.frame_rate_hz;
    var halfSizeUnits = (p.render.size_px / 2) / p.render.scale_px_per_unit;
    var softU = p.render.edge_soft_px / p.render.scale_px_per_unit;
    var APPROACH_MIN = 0.20, PINCH_MIN = 0.23, CONTRACT_SUM = 0.090;

    for (var i = 0; i < p.annuli.length; i++) {
      var a = p.annuli[i], tag = "edge " + (a.edge || a.index) + ": ";
      var s = sumAmp(a);
      if (a.boundary.harmonics.length !== a.boundary.amplitudes.length ||
          a.boundary.harmonics.length !== a.boundary.phases_deg.length)
        errors.push(tag + "harmonics/amplitudes/phases_deg length mismatch");
      if (a.crossing !== "up" && a.crossing !== "down")
        errors.push(tag + "crossing must be 'up' or 'down'");
      var hasOdd = a.boundary.harmonics.some(function (k) { return k % 2 === 1; });
      if (!hasOdd) errors.push(tag + "all harmonics even — half-turn symmetry halves the slip bound (F5c)");
      if (a.boundary.harmonics[0] !== 1)
        errors.push(tag + "k=1 pilot must lead the ladder (the pose-trap anchor, field-priced)");
      else if (a.boundary.amplitudes[0] < 0.030 - 1e-9)
        warnings.push(tag + "k=1 pilot " + a.boundary.amplitudes[0] + " under 0.030 — below the field-priced pose-trap margin (the 0.020 ring was the wander's first victim)");
      if (Math.abs(s - CONTRACT_SUM) > 1e-9)
        warnings.push(tag + "amplitude sum " + s.toFixed(3) + " ≠ frozen " + CONTRACT_SUM + " (contract sums are frozen by geometry, zero slack)");
      for (var j = 0; j < a.boundary.amplitudes.length; j++)
        if (a.boundary.amplitudes[j] * p.render.scale_px_per_unit < 1.5)
          warnings.push(tag + "harmonic k=" + a.boundary.harmonics[j] + " amplitude under ~1.5 px at this scale (accepted deliberately for the 0.012 tails — 6-up is the close mode)");
      var nomDeg = 360 * a.rotation.nominal_hz / fps;
      var devDeg = 180 / a.rotation.frames_per_symbol;
      var per = nomDeg + devDeg;
      if (per > 150) errors.push(tag + "per-frame advance " + per.toFixed(1) + "° breaks the slip bound");
      else if (per > 90) warnings.push(tag + "per-frame advance " + per.toFixed(1) + "° leaves little headroom");
    }

    // Trough guards: within-band pinch ≥ 0.23 (C sits exactly at the bound in
    // the frozen numbers), facing-edge approach across each trough ≥ 0.20.
    for (var b = 0; b < p.bands.length; b++) {
      var band = p.bands[b];
      var lo = bandBoundary(p, band.lo), hiB = bandBoundary(p, band.hi);
      var pinch = (hiB.r0 - hiB.sum) - (lo.r0 + lo.sum);
      if (pinch < PINCH_MIN - 1e-9)
        errors.push("band " + band.name + " pinch " + pinch.toFixed(3) + " under " + PINCH_MIN + " — the fill vanishes at worst excursion");
      if (b > 0) {
        var prevHi = bandBoundary(p, p.bands[b - 1].hi);
        var approach = (lo.r0 - lo.sum) - (prevHi.r0 + prevHi.sum);
        if (approach < APPROACH_MIN - 1e-9)
          errors.push("trough " + p.bands[b - 1].name + "→" + band.name + " facing-edge approach " + approach.toFixed(3) + " under " + APPROACH_MIN);
      }
    }
    var outer = p.bands[p.bands.length - 1].hi;
    if (!outer.flat || Math.abs(outer.fixed - p.flat_circle_r) > 1e-9)
      warnings.push("outermost boundary is not the flat units anchor — the self-anchoring gauge (units ≡ flat " + p.flat_circle_r + ") is the v3 identity");
    if (p.flat_circle_r + softU * 2 + 0.01 > halfSizeUnits)
      errors.push("flat circle " + p.flat_circle_r + " + soft margin exceeds render half-size " + halfSizeUnits.toFixed(3));

    // Plate containment (§5 as amended — the axis-containment repair is exactly
    // what this check exists to hold).
    var pl = p.plate;
    var beaconSum = 0;
    for (var k2 = 0; k2 < p.beacon.amplitudes.length; k2++) beaconSum += p.beacon.amplitudes[k2];
    if (pl.corners.at + pl.corners.r_out + softU > halfSizeUnits)
      errors.push("corner bullseye " + pl.corners.r_out + " at ±" + pl.corners.at + " fails axis containment (needs " + (pl.corners.at + pl.corners.r_out).toFixed(3) + " vs half-size " + halfSizeUnits.toFixed(3) + ")");
    if (Math.hypot(pl.corners.at, pl.corners.at) - pl.corners.r_out < p.flat_circle_r + 0.03)
      errors.push("corner bullseye intrudes on the flat circle + 0.03 margin");
    if (pl.center.r_out + 0.02 > pl.breaker.r_in - beaconSum)
      errors.push("beacon excursion erodes the center-bullseye/breaker gap (0.60→0.70 must hold at worst wiggle)");
    if (pl.breaker.r_out + beaconSum > pl.quiet_r)
      errors.push("breaker + beacon excursion " + (pl.breaker.r_out + beaconSum).toFixed(3) + " exceeds the donut budget " + pl.quiet_r);
    var innermostLo = bandBoundary(p, p.bands[0].lo);
    if (pl.quiet_r + 0.15 > innermostLo.r0 - innermostLo.sum + 1e-9)
      errors.push("donut budget " + pl.quiet_r + " leaves under 0.15 quiet to the innermost band edge");

    // Beacon (§5): M ∈ {2,4}; amplitude bound keeps the ring's quiet gaps.
    if (p.beacon.rotation.M !== 2 && p.beacon.rotation.M !== 4)
      errors.push("beacon M must be 2 (default) or 4 (negotiable)");
    if (p.beacon.harmonics.length !== p.beacon.amplitudes.length ||
        p.beacon.harmonics.length !== p.beacon.phases_deg.length)
      errors.push("beacon harmonics/amplitudes/phases_deg length mismatch");
    if (beaconSum > 0.045 + 1e-9)
      errors.push("beacon amplitude sum " + beaconSum.toFixed(3) + " exceeds the ring-gap bound 0.045");
    else if (beaconSum > 0.030 + 1e-9)
      warnings.push("beacon amplitude sum " + beaconSum.toFixed(3) + " above 0.030 — quiet-zone margin thins");

    // Tiling (§7): the knob is 1/2/6; the pitch keeps §5's 1.2-unit gutter.
    var tn = p.tiling || 1;
    if (tn !== 1 && tn !== 2 && tn !== 6)
      errors.push("tiling " + tn + " is not a contract density (1 / 2 / 6-up)");
    if (tn > 1 && (p.tile_pitch || 0) < p.flat_circle_r * 2 + 1.2 - 1e-9)
      errors.push("tile_pitch " + p.tile_pitch + " under " + (p.flat_circle_r * 2 + 1.2) + " — the 1.2-unit gutter is the §5 floor");

    // Countdown (§6): freeze ≥ 1 s is the optical-intrinsic floor (AF/AE settle
    // + motion-onset anchor); the envelope is the only movable function.
    var cd = p.countdown;
    if (!cd || !(cd.freeze_s >= 1))
      errors.push("freeze_s under the 1 s floor (AF/AE settle + onset anchor are optical-intrinsic)");
    else {
      if (!(cd.loop_s > cd.freeze_s)) errors.push("loop_s must exceed freeze_s");
      else if (cd.freeze_s / cd.loop_s > 0.10)
        warnings.push("freeze airtime " + Math.round(100 * cd.freeze_s / cd.loop_s) + "% over 10% — the envelope is an accelerant, not a tax");
    }

    // Matched-mean (§5): countdown-center vs steady-center within 0.05 — the
    // QR↔bullseye swap must not kick AE. Exact when the emission module is
    // loadable (it owns the QR module map); T22 re-checks on rendered pixels.
    var em = (global.OC && global.OC.emission) ||
             (typeof require !== "undefined" && typeof module !== "undefined" && module.exports ? require("./emission.js") : null);
    if (em && em.centerMeans) {
      var mm = em.centerMeans(p);
      var dm = Math.abs(mm.steady - mm.countdown);
      if (dm > 0.05) errors.push("matched-mean: countdown center " + mm.countdown.toFixed(3) + " vs steady " + mm.steady.toFixed(3) + " differ by " + dm.toFixed(3) + " (> 0.05) — the swap will kick AE");
      else if (dm > 0.035) warnings.push("matched-mean margin thin: |" + mm.countdown.toFixed(3) + " − " + mm.steady.toFixed(3) + "| = " + dm.toFixed(3));
    } else warnings.push("matched-mean unchecked — emission module not loaded");

    var flicker = (global.OC && global.OC.flicker) ? global.OC.flicker.report(p)
      : (typeof require !== "undefined" ? require("./flicker.js").report(p) : null);
    if (flicker && flicker.worstBandHit && p.render.background - p.render.fill > 0.35)
      warnings.push("flicker: harmonic content lands in the 3–60 Hz band at contrast > 0.35 — drop contrast or slow rotation (F1)");

    return { ok: errors.length === 0, errors: errors, warnings: warnings, flicker: flicker };
  }

  var API = { defaultProfile: defaultProfile, profileV1: profileV1, profileV2r20: profileV2r20, profileV2r30: profileV2r30, profileV3: profileV3, isV3: isV3, bandBoundary: bandBoundary, validate: validate, sumAmp: sumAmp, sampleWindow: sampleWindow, deepMerge: deepMerge };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.profile = API;
})(typeof window !== "undefined" ? window : globalThis);
