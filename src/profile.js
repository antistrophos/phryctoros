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
      // the biggest ring. The swap is an emission version, not a patch — the
      // profile is the CONTRACT. (v1's builder was pruned 2026-08-21; v1 clips
      // now need it revived from git.)
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

  /* PRUNED 2026-08-21 (practitioner's ruling): profileV1, profileV2r20 and
     profileV2r30 are gone. Every selectable standard is a mode-mismatch
     surface, and mismatch — not optics — has cost three field trials; these
     three bought nothing against that. Their clips are no longer decodable
     without reviving the builders from git, which is the accepted price.

     defaultProfile (v2 @15) STAYS: it is not legacy but the TEST SUBSTRATE,
     exercising sample/register/demap/rowtime/harvest through a simpler profile
     on all three suite pages, with T2b's acuity regimes calibrated against its
     numbers.

     Coverage that left with them, recorded rather than quietly transplanted:
     T19b's 20@30 worst phase — alternate frames torn with NO clean duplicate to
     select — was the hardest exercise of the rowtime repair path, and that
     regime can still arise in the field through dropped frames at any rate. It
     wants a test authored on its own terms at v3, not a re-tuned transplant.

     harness/pool36.html carried a frozen literal instead (preservation
     artifact: the mined droplets outlive the builder that framed them). */

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
  /* preset: undefined | "high-rate" | "classic" | "paced" | "high-rate-paced"
     ("inverted" is kept as an alias for the default — it names what the
     default now IS, and older settings strings still carry it.)

     THE LADDER IS INVERTED BY DEFAULT as of 2026-08-21 (the practitioner's
     ruling, amending the frozen contract's §1 M-ladder): base innermost,
     fine constellations outward. Field-decided — the first complete v3
     carriage (::b) ran inverted, and the mechanism the field showed is
     radial, not preset-specific: registration error is radius-leveraged, so
     the outermost edge takes the largest pixel displacement per unit of H
     error, while base's droplets are the longest CRC exposure on the plate.
     Both push base inward. It also matches the D-ring's radial semantics
     (coarse and robust near centre, fine outward) for the v4 plate.

     "classic" keeps the ORIGINAL ladder so pre-flip captures still decode —
     the profile is the CONTRACT. It is the one legacy preset kept through the
     2026-08-21 prune, because field37–44 are the pre-saddle angle ladder and
     that autopsy is still queued. High-rate inverts too (my reading of "the inverted structure",
     flagged: the radial argument is preset-independent and a split family
     would leave the two presets with opposite radial semantics; revert by
     making `inv` false for hi if that reading is wrong). */
  function profileV3(preset, overrides) {
    // PACED IS THE STANDARD (practitioner's ruling, 2026-08-23): per-ring
    // frames_per_symbol is the v3.1 definition, not a mode — so (family,
    // preset) fully determines every ring's F, discovery has nothing extra
    // to learn, and the envelope's b[2] stays the one toggle it was frozen
    // as. "flat" is the explicit legacy opt-out ("flat", "high-rate-flat")
    // for pre-ruling captures, which decode by deliberate profile selection,
    // never by discovery. "paced" remains accepted as a no-op alias so the
    // trial-era names (v3p / v3hrp, and their pasted settings strings) keep
    // meaning what they meant. "classic" stays flat + the pre-flip ladder.
    var ps = String(preset == null ? "" : preset);
    var pacedExplicit = ps.indexOf("paced") >= 0;
    var flat = ps.indexOf("flat") >= 0;
    var base = ps.replace(/-?paced/, "").replace(/-?flat/, "").replace(/^-+|-+$/g, "");
    // "high-rate-classic" was pruned 2026-08-21: a combination that existed only
    // because two flags composed, never filmed, and it broke the envelope's
    // high-rate toggle (envelopeBytes b[2] compares preset exactly).
    var hi = base === "high-rate";
    var classic = base === "classic";
    var inv = !classic;
    var paced = flat ? false : (classic ? pacedExplicit : true);
    var p = {
      // hi and classic are mutually exclusive since the high-rate-classic prune.
      // Version strings tell the truth across the ruling boundary: the paced
      // default is v3.1; the historical strings "v3" / "v3-hr" keep naming
      // exactly the flat profiles that recorded them in old ledgers.
      profile_version: hi ? "v3-hr" : (classic ? "v3-classic" : "v3"),
      units: "flat-circle-3.00",
      preset: hi ? "high-rate" : (classic ? "resilient-classic" : "resilient"),
      frame_rate_hz: 30,            // §7: 30 fps emission @ 60 fps capture baseline
      render: {
        size_px: 1024,
        scale_px_per_unit: 166,     // half-size 3.084 units; corners at 2.65+0.40=3.05 fit (§5 amended)
        background: 0.62,
        fill: 0.32,                 // contrast 0.30 — the F1 dividend, carried from v2
        edge_soft_px: 1.6
      },
      preamble_symbols: 8,          // §1: preamble as v2
      // §2/§3. subset_version 2 = ring-dependent forced seeds + K-scaled max
      // degree (see fountain.subsetFor); "classic" keeps v1 alongside the
      // original ladder, since a clip filmed then used both. Decoders fall
      // back automatically on a validated mismatch, so pre-flip captures need
      // no setting — the version is a default, not a requirement.
      // carousel_version 2 sizes each ring's carousel to the LOOP rather than to
      // a flat 2K+12, so a fast ring's surplus carries distinct droplets instead
      // of repeats. classic keeps 1 so pre-change scenes re-emit bit-identically.
      carriage: { droplet_bits: hi ? 48 : 24, self_framing: true, subset_version: classic ? 1 : 2,
                  carousel_version: classic ? 1 : 2 },
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
      // DIAGNOSTIC variant, off the frozen contract (ruling 2: steady state is
      // QR-free): render the envelope QR in the center donut on EVERY frame —
      // the v2-proven finder path then registers angled captures continuously.
      // The interim lock for angled-capture data collection until saddle-first
      // registration lands; suppresses the center bullseye + beacon.
      qr_persistent: false,
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
        // corner_style "quadrant" = v3.1 amendment 2 (practitioner's mark):
        // quadrant swap-target — saddle center is PROJECTIVELY EXACT (lines map
        // to lines; the circle-center DLT's eccentricity bias vanishes), the
        // swap circle at 0.5·r_out carries sizing + phase-flip verify, and the
        // folded rendering orients every mark radially from plate center so
        // diagonal corner pairs share polarity (roll mod 180 for free).
        // Default stays "bullseye" — the frozen v3 contract's geometry.
        corner_style: "bullseye",
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
    // The inversion itself: mirror the four edge CONFIGS across radii —
    // constellation, harmonic set, amplitudes, AND rotation rate move
    // together; only geometry (r0, crossing, bands) stays put. Because the
    // rates travel with their configs, every k·f_rot product in the flicker
    // analysis is preserved EXACTLY (a naive M-only swap would have parked
    // k13 × 1.5 Hz = 19.5 Hz in the photosensitivity peak). Base inherits
    // the deepest branch-guide ladder (k ≤ 13) at the calmest radius.
    if (inv) {
      var cfgs = p.annuli.map(function (a) { return { rotation: a.rotation, boundary: a.boundary }; });
      for (var iv = 0; iv < p.annuli.length; iv++) {
        var srcC = cfgs[p.annuli.length - 1 - iv];
        p.annuli[iv].rotation = srcC.rotation;
        p.annuli[iv].boundary = srcC.boundary;
        p.annuli[iv].layer = iv;
      }
    }
    // PACED RINGS — the practitioner's ruling that the inner data ring's
    // frames_per_symbol shackles come off, the coming dedicated signal ring
    // taking over the low-rate robust duty.
    //
    // A droplet occupies D·F frames, D = ceil(droplet_bits / log2 M). Under a
    // FLAT F the base ring's droplets are the longest — lowest M means the most
    // symbols per droplet — so the base is simultaneously the slowest to deliver
    // a carousel AND the one starved inside a harvest window. That starvation is
    // measured, not assumed: ~2.5 droplets per 8 s window against crcAlign's
    // ≥2-pass bar was the diagnosed cause of a0's lock fragility, and finer
    // sampling did not move it.
    //
    // Pacing sets each ring's F to equalise droplet DURATION at the FASTEST
    // ring's, so nothing slows down and the slow rings speed up. F is already
    // per-annulus everywhere in emission and demod, it is FLICKER-NEUTRAL (it
    // changes how often a data step lands, never nominal_hz, so the
    // photosensitivity table is untouched), and lag normalisation made mixed-F
    // decoding safe. The cost is real and bounded: fewer frames in demap's
    // least-squares slope fit, Var(Δθ) = 12F·σ²/((F+1)(F+2)), so F 4→2 is ~0.97
    // dB worse per symbol — spent on the ring with the WIDEST decision threshold
    // (M=4 ⟹ π/4, against π/16 outward) and the highest per-harmonic SNR.
    if (paced) {
      var dbits = p.carriage.droplet_bits;
      var Dof = function (a) { return Math.ceil(dbits / Math.round(Math.log(a.rotation.M) / Math.LN2)); };
      var target = Infinity;
      p.annuli.forEach(function (a) { target = Math.min(target, Dof(a) * a.rotation.frames_per_symbol); });
      p.annuli.forEach(function (a) { a.rotation.frames_per_symbol = Math.max(1, Math.round(target / Dof(a))); });
      // Marker, not a preset rename: profile.preset is read as an envelope
      // toggle (emission.envelopeBytes b[2]) and must keep its exact spelling.
      p.carriage.paced = true;
      // classic+paced stays a suffix (a compat curiosity, not a standard);
      // the v3.1 names are reserved for the current-ladder standard profiles.
      p.profile_version = classic ? p.profile_version + "-paced" : (hi ? "v3.1-hr" : "v3.1");
    }
    if (overrides) deepMerge(p, overrides);
    return p;
  }

  function isV3(p) { return !!(p && p.bands && p.plate); }

  /* Resolve a band boundary ref to { r0, sum, edge } (sum = worst excursion).
     D-ring ruling 1b (2026-08-23): with beacon.placement "a-inner", band A's
     fixed inner boundary CARRIES the control betas, so its worst excursion is
     the beacon amplitude sum — the pinch and quiet arithmetic see the wiggle. */
  function bandBoundary(p, ref) {
    if (ref.edge !== undefined) { var a = p.annuli[ref.edge]; return { r0: a.r0, sum: sumAmp(a), edge: a }; }
    var s = 0;
    if (p.beacon && p.beacon.placement === "a-inner" && p.bands && ref === p.bands[0].lo)
      for (var q = 0; q < p.beacon.amplitudes.length; q++) s += p.beacon.amplitudes[q];
    return { r0: ref.fixed, sum: s, edge: null };
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
    var cstyle = pl.corner_style || "bullseye";
    if (cstyle !== "bullseye" && cstyle !== "quadrant")
      errors.push("plate.corner_style must be \"bullseye\" (frozen v3) or \"quadrant\" (v3.1 amendment 2)");
    if (cstyle === "quadrant")
      warnings.push("corner_style quadrant is the v3.1 amendment-2 mark — pending the full v3.1 freeze; the frozen v3 contract's corners are bullseyes");
    // v4 clause 2′ trial: the CENTER becomes a three-section quadrant target
    // and the breaker retires into it (identity = the designated VARIANT).
    // Requires the a-inner beacon (the breaker was the beacon's carrier
    // otherwise), freeze 0 (no countdown face exists to match means against),
    // and quadrant corners (the saddle-detector world).
    var ctr = pl.center_style || "bullseye";
    if (ctr !== "bullseye" && ctr !== "quadrant3")
      errors.push("plate.center_style must be \"bullseye\" (frozen v3) or \"quadrant3\" (v4 clause 2′ trial)");
    if (ctr === "quadrant3") {
      if (p.beacon.placement !== "a-inner")
        errors.push("center_style quadrant3 requires beacon.placement \"a-inner\" — the breaker (retired by the target) was the beacon's carrier otherwise");
      if (!p.countdown || p.countdown.freeze_s !== 0)
        errors.push("center_style quadrant3 requires freeze_s 0 — no countdown face exists over the target (the matched-mean rule has nothing to govern)");
      if (cstyle !== "quadrant")
        errors.push("center_style quadrant3 requires corner_style quadrant (saddle-first registration carries the plate)");
      if (pl.center.r_out + 0.10 > pl.quiet_r + 1e-9)
        errors.push("center target " + pl.center.r_out + " + 0.10 moat exceeds quiet_r " + pl.quiet_r);
    }
    // D-ring ruling 1b: with placement "a-inner" the control betas ride band
    // A's inner boundary and the BREAKER RENDERS STATIC (it stays one
    // generation as the derived-identity degrade rung, retiring at v4) — so
    // the breaker-gap checks see no excursion, and the donut-quiet floor
    // amends 0.15 → 0.125 (the v3.1 draft's own arithmetic: 1.05 − 0.025 −
    // 0.90). At the frozen default everything reads exactly as before.
    var dringAt = p.beacon.placement === "a-inner";
    var brExc = dringAt ? 0 : beaconSum;
    if (ctr !== "quadrant3") {
      // the breaker exists only under the bullseye center — quadrant3 retired
      // it into the target (its containment is the target-moat check above)
      if (pl.center.r_out + 0.02 > pl.breaker.r_in - brExc)
        errors.push("beacon excursion erodes the center-bullseye/breaker gap (0.60→0.70 must hold at worst wiggle)");
      if (pl.breaker.r_out + brExc > pl.quiet_r)
        errors.push("breaker + beacon excursion " + (pl.breaker.r_out + brExc).toFixed(3) + " exceeds the donut budget " + pl.quiet_r);
    }
    var innermostLo = bandBoundary(p, p.bands[0].lo);
    var quietFloor = dringAt ? 0.125 : 0.15;
    if (pl.quiet_r + quietFloor > innermostLo.r0 - innermostLo.sum + 1e-9)
      errors.push("donut budget " + pl.quiet_r + " leaves under " + quietFloor + " quiet to the innermost band edge" +
                  (dringAt ? " (a-inner D-ring: 1.05 − excursion " + innermostLo.sum.toFixed(3) + ")" : ""));

    // Beacon (§5): M ∈ {2,4}; amplitude bound keeps the ring's quiet gaps.
    // At a-inner the bound is the CONTROL CLASS itself: 0.025 is what the
    // pinch + donut budgets price (a full data edge breaks both).
    if (p.beacon.rotation.M !== 2 && p.beacon.rotation.M !== 4 && p.beacon.rotation.M !== 8)
      errors.push("beacon M must be 2 (default), 4 (negotiable), or 8 (D-ring ruling-2 chunked trial)");
    if (p.beacon.placement !== undefined && p.beacon.placement !== "a-inner")
      errors.push("beacon.placement must be absent (breaker — frozen §5) or \"a-inner\" (D-ring ruling 1b)");
    if (p.beacon.harmonics.length !== p.beacon.amplitudes.length ||
        p.beacon.harmonics.length !== p.beacon.phases_deg.length)
      errors.push("beacon harmonics/amplitudes/phases_deg length mismatch");
    // The class bound IS the geometry (2026-08-27, generalizing ruling 1b's
    // 0.025): at a-inner the sum may spend exactly what sits between the
    // band floor and the quiet reference, minus the 0.125 quiet floor. The
    // frozen default (floor 1.05, quiet_r 0.90) prices 0.025 byte-for-byte;
    // the a42g trial (1.00, 0.80) prices 0.075. The pinch check caps
    // independently through bandBoundary's beacon-sum accounting.
    var classBound = dringAt ? (p.bands[0].lo.fixed - pl.quiet_r - 0.125) : 0;
    if (dringAt && beaconSum > classBound + 1e-9)
      errors.push("D-ring amplitude sum " + beaconSum.toFixed(3) + " exceeds the geometry-priced class " +
                  classBound.toFixed(3) + " (floor " + p.bands[0].lo.fixed + " − quiet_r " + pl.quiet_r + " − 0.125 quiet)");
    // v4 clause 3 (ruled 2026-08-28): geometry past the a42g bridge (floor
    // 1.00 / quiet 0.80) is the family-4 dividend and must ANNOUNCE it —
    // b[1] = 4, the version signal — so stores and receipts carry which
    // contract priced the plate. The bridge and everything shallower stays
    // family 3 (b[1] byte-exact for every fielded config; the tag holds).
    if (p.family !== undefined && p.family !== 4)
      errors.push("profile.family must be absent (v3, b[1]=3) or 4 (the v4 geometry dividend)");
    if (p.family === 4 && ctr !== "quadrant3")
      errors.push("family 4 requires center_style quadrant3 — the v4 plate is the clause-2′ target plate");
    if (dringAt && (p.bands[0].lo.fixed < 1.00 - 1e-9 || pl.quiet_r < 0.80 - 1e-9) && p.family !== 4)
      errors.push("geometry past the a42g bridge (floor " + p.bands[0].lo.fixed + " / quiet_r " + pl.quiet_r +
                  ") requires the family-4 version signal (v4 clause 3)");
    else if (!dringAt && beaconSum > 0.045 + 1e-9)
      errors.push("beacon amplitude sum " + beaconSum.toFixed(3) + " exceeds the ring-gap bound 0.045");
    else if (!dringAt && beaconSum > 0.030 + 1e-9)
      warnings.push("beacon amplitude sum " + beaconSum.toFixed(3) + " above 0.030 — quiet-zone margin thins");

    if (p.qr_persistent)
      warnings.push("qr_persistent is a DIAGNOSTIC variant — off the frozen contract (§ ruling 2: steady state is QR-free); for angled-capture data until saddle-first registration lands");

    // Tiling (§7): the knob is 1/2/6; the pitch keeps §5's 1.2-unit gutter.
    var tn = p.tiling || 1;
    if (tn !== 1 && tn !== 2 && tn !== 6)
      errors.push("tiling " + tn + " is not a contract density (1 / 2 / 6-up)");
    if (tn > 1 && (p.tile_pitch || 0) < p.flat_circle_r * 2 + 1.2 - 1e-9)
      errors.push("tile_pitch " + p.tile_pitch + " under " + (p.flat_circle_r * 2 + 1.2) + " — the 1.2-unit gutter is the §5 floor");

    // Countdown (§6): freeze ≥ 1 s is the optical-intrinsic floor (AF/AE settle
    // + motion-onset anchor); the envelope is the only movable function.
    // EXACTLY 0 is the v4-preview trial (rulings 1+4 pulled forward
    // 2026-08-27): no countdown, no QR ever rendered, rotation from frame 0,
    // the loop is pure emission airtime — b[13]=0 self-describes it on the
    // wire and mid-loop framing never needed the onset anchor. Values in
    // (0, 1) stay illegal: a freeze too short to settle is worse than none.
    var cd = p.countdown;
    if (!cd || !(cd.freeze_s >= 1 || cd.freeze_s === 0))
      errors.push("freeze_s must be ≥ 1 s (AF/AE settle + onset anchor) or exactly 0 (the v4-preview no-countdown trial)");
    else if (cd.freeze_s === 0) {
      if (!(cd.loop_s > 0)) errors.push("loop_s must be positive");
    } else {
      if (!(cd.loop_s > cd.freeze_s)) errors.push("loop_s must exceed freeze_s");
      else if (cd.freeze_s / cd.loop_s > 0.10)
        warnings.push("freeze airtime " + Math.round(100 * cd.freeze_s / cd.loop_s) + "% over 10% — the envelope is an accelerant, not a tax");
    }

    // Matched-mean (§5): countdown-center vs steady-center within 0.05 — the
    // QR↔bullseye swap must not kick AE. Exact when the emission module is
    // loadable (it owns the QR module map); T22 re-checks on rendered pixels.
    var em = (global.OC && global.OC.emission) ||
             (typeof require !== "undefined" && typeof module !== "undefined" && module.exports ? require("./emission.js") : null);
    if (cd && cd.freeze_s === 0) {
      // no countdown face exists — there is no QR↔bullseye swap to keep
      // AE-neutral; the matched-mean rule has nothing to govern.
    } else if (em && em.centerMeans) {
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

  /* D-ring ruling-2 trial configs (2026-08-23). code: "f24" = v0 frame at
     M=2/F=4 (the frozen §5 default), "c42" = chunked M=4/F=2 (the primary
     trial: tag 1.07 s, envelope 13.3 s), "c82" = chunked M=8/F=2 (the A/B:
     tag 0.71 s, SNR-risky at the 0.010 amplitude — the filming session
     decides). Amplitude re-split trials (2026-08-24 — the a-inner ring
     under-resolves at range): trackPhase EXCLUDES k=1 from the phase
     estimate (F5b: centering error rides the k=1 coefficient), so the
     default split spends 0.010 of the 0.025 class on a branch guide. Both
     trials keep the class sum at exactly 0.025 (no validator change):
     "a42r" re-splits within [1,2,3] → k≥2 estimation power Σ(k·a)² ×3.0
     (+4.8 dB); "a42x" extends the ladder to [1,2,3,5] → ×5.6 (+7.5 dB),
     k=5 riding the ascending-k branch resolution the way the data rings
     already run k=13, same ~1.3u spatial wavelength. Framing is
     auto-detected on receive, so framing only has to be right on the EMIT
     side; the receive/batch selects exist for the beacon's M/F — and the
     amplitude lists, which the carrier gate and tracker weights DO need.
     Every branch resets the beacon lists so toggling codes on a live
     profile never carries a previous trial's split. Mutates and returns
     the profile; anything unrecognised restores the default. */
  function applyDring(p, code) {
    if (!p || !p.beacon) return p;
    p.beacon.harmonics = [1, 2, 3];
    p.beacon.amplitudes = [0.010, 0.008, 0.007];
    p.beacon.phases_deg = [0, 45, 90];
    // Geometry rides the same reset rule as the amplitude lists: every branch
    // restores the frozen defaults FIRST, so toggling codes on a live profile
    // can never carry a previous trial's geometry (T22w's stale-split trap,
    // one level up).
    if (p.bands && p.bands[0] && p.bands[0].lo) p.bands[0].lo.fixed = 1.05;
    if (p.plate) { p.plate.quiet_r = 0.90; p.plate.center_style = "bullseye"; }
    delete p.family;
    if (code === "c42" || code === "c82" || code === "a42" || code === "a82" ||
        code === "a42r" || code === "a42x" || code === "a42g" || code === "a42q" || code === "a44q" ||
        code === "a42v") {
      p.beacon.framing = "chunked";
      p.beacon.rotation.M = (code === "c82" || code === "a82") ? 8 : 4;
      p.beacon.rotation.gray = true;
      p.beacon.rotation.frames_per_symbol = 2;
      // a42/a82/a42r/a42x — ruling 1b: the control ring RELOCATES to band
      // A's inner boundary on every tile (per-tile envelopes, announced
      // identity); the breaker renders static and stays the derived-identity
      // degrade rung.
      if (code === "c42" || code === "c82") delete p.beacon.placement;
      else p.beacon.placement = "a-inner";
      if (code === "a42r") {
        p.beacon.amplitudes = [0.005, 0.005, 0.015];
      } else if (code === "a42x") {
        p.beacon.harmonics = [1, 2, 3, 5];
        p.beacon.amplitudes = [0.004, 0.004, 0.005, 0.012];
        p.beacon.phases_deg = [0, 45, 90, 135];
      } else if (code === "a42g") {
        // THE GEOMETRY TRIAL (2026-08-27; the QR retired emit-side, freeze-0
        // era): the ring moves IN and the class rises to what the geometry
        // prices — quiet_r 0.80 (the breaker's own outer edge; containment
        // holds exactly), floor 1.00, class 0.075 split k3-heavy per F5b.
        // Quiet width lands ON the 0.125 floor and band A's pinch stays at
        // the frozen 0.255 exactly; no data edge moves, ledgers survive.
        p.bands[0].lo.fixed = 1.00;
        p.plate.quiet_r = 0.80;
        p.beacon.amplitudes = [0.012, 0.018, 0.045];
      } else if (code === "a42q" || code === "a44q") {
        // THE CENTER REVISION (v4 clause 2′, practitioner's proposal): a42g's
        // proven geometry + the three-section quadrant center — bullseye and
        // breaker retire into the target, the designated tile carries the
        // VARIANT (identity by shape; the count asymmetry ends). One new
        // variable against a42g. Requires freeze 0 (validator enforces).
        // a44q = the same plate at F=4 (practitioner's rate lever, 2026-08-27:
        // tag ~2.7 s, envelope 26.7 s, +3 dB per symbol at half rate) — the
        // photons-at-range A/B against a42q decides whether symbol SNR or
        // chunk content is the binding constraint out there.
        p.bands[0].lo.fixed = 1.00;
        p.plate.quiet_r = 0.80;
        p.plate.center_style = "quadrant3";
        p.beacon.amplitudes = [0.012, 0.018, 0.045];
        if (code === "a44q") p.beacon.rotation.frames_per_symbol = 4;
      } else if (code === "a42v") {
        // THE v4 GEOMETRY DIVIDEND (clause 3, ruled 2026-08-28): the full
        // step past the a42g bridge — quiet_r 0.70 (the target rim + its
        // 0.10 moat exactly), floor 0.95, class 0.090 = a42q's k3-heavy
        // split scaled 1.2×. Both walls carry margin for the first time
        // (quiet width 0.160 vs the 0.125 floor, class 0.090 vs the 0.125
        // ceiling). Announces family 4 — b[1], the version signal — so the
        // tag moves, as the content-switch interlock requires. The DEFAULT
        // emission stays a42q until one clean 0.090 take + the flicker
        // report pass (the ruling's own gate).
        p.bands[0].lo.fixed = 0.95;
        p.plate.quiet_r = 0.70;
        p.plate.center_style = "quadrant3";
        p.beacon.amplitudes = [0.014, 0.022, 0.054];
        p.family = 4;
      }
    } else {
      delete p.beacon.framing;
      delete p.beacon.placement;
      p.beacon.rotation.M = 2;
      p.beacon.rotation.gray = false;
      p.beacon.rotation.frames_per_symbol = 4;
    }
    return p;
  }

  var API = { defaultProfile: defaultProfile, profileV3: profileV3, isV3: isV3, bandBoundary: bandBoundary, validate: validate, sumAmp: sumAmp, sampleWindow: sampleWindow, deepMerge: deepMerge, applyDring: applyDring };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.profile = API;
})(typeof window !== "undefined" ? window : globalThis);
