/* pipeline.js — the decoder pipeline (spec §9), stages 1–8 + scoring, per emitter.
   Multi-emitter is structural (spec §5.1): registration returns a LIST and the
   pipeline decodes each. Mirror parity is applied ONCE, to the frame, before
   registration (C9 — config flag, never auto-detected). */
(function (global) {
  "use strict";

  function dep(n) { return (typeof module !== "undefined" && module.exports) ? require("./" + n + ".js") : global.OC[n]; }

  /* Target arc pitch for boundary sampling, in image pixels — roughly two rays
     per PSF width at the blur we measure in the field. See the sampOpts block
     in decodeSequence for the measurement this came from. */
  var ARC_PITCH_PX = 2.4;

  /* frames: [{ f, img }] — f is the capture/emission frame index.
     opts: { mirror: {receive}, aligned, staticCamera (default true), maxEmitters } */
  function decodeSequence(frames, profile, opts) {
    opts = opts || {};
    var register = dep("register"), sample = dep("sample"), transform = dep("transform"),
        separate = dep("separate"), demap = dep("demap"), serM = dep("ser"), degrade = dep("degrade");

    // opts.timing: per-stage wall-clock accumulators (ms) returned as
    // result.timings — the CPU map (where a phone's decode time goes).
    var T = opts.timing ? { register: 0, conic: 0, solve: 0, sample: 0, dft: 0, rowtime: 0, track: 0, align: 0, demod: 0, samples: 0, downstreams: 0 } : null;
    var tnow = (typeof performance !== "undefined" && performance.now) ? function () { return performance.now(); } : function () { return Date.now(); };
    var work = frames;
    if (opts.mirror && opts.mirror.receive)
      work = frames.map(function (fr) { return { f: fr.f, img: degrade.flipH(fr.img) }; });

    // Group capture frames by EMISSION index f. A 30 fps capture of the 15 fps
    // emission delivers ~2 candidates per emission frame; the tear (field-clip-2)
    // corrupts at most one of them, and each annulus later SELECTS its cleanest
    // candidate by spectral residual. Cap 3 candidates (60 fps recordings).
    var groups = [], byF = {};
    for (var wi = 0; wi < work.length; wi++) {
      var fr2 = work[wi];
      var g = byF[fr2.f];
      if (!g) { g = { f: fr2.f, imgs: [] }; byF[fr2.f] = g; groups.push(g); }
      if (g.imgs.length < 3) g.imgs.push(fr2.img);
    }

    // Registration anchors at the FIRST group where it succeeds — captures routinely
    // begin on a dead screen (the emitter's countdown freeze, or pre-framing wobble).
    // opts.registerOn: an alternate (already parity-corrected) frame to register on —
    // harness-only isolation of annulus degradation from registration death.
    var regOpts = { profile: profile, maxEmitters: opts.maxEmitters };
    var reg = null, regFrame = 0;
    var tReg = T && tnow();
    if (opts.registerOn) {
      reg = register.registerAll(opts.registerOn, regOpts);
    } else {
      // For a TILED profile the operator declared how many plates exist, so
      // stopping at the first frame that yields ANY plate under-registers a
      // lattice whenever that instant was blurred (the first field 2-up:
      // both plates solve on clean frames, one on smeared ones — handheld
      // frame luck). Keep the best frame seen among a bounded SPREAD of
      // candidates (registration is the expensive stage — never per-frame);
      // stop early the moment the declared count is met. Untiled behavior
      // unchanged: first hit wins on the same spread.
      var wantN = profile.plate ? (profile.tiling || 1) : 1;
      var triesN = Math.min(groups.length, wantN > 1 ? 8 : groups.length);
      for (var rt2 = 0; rt2 < triesN; rt2++) {
        var rf = wantN > 1 ? Math.min(groups.length - 1, Math.floor(rt2 * groups.length / triesN)) : rt2;
        var rTry = register.registerAll(groups[rf].imgs[0], regOpts);
        if (rTry.emitters.length > (reg ? reg.emitters.length : 0)) { reg = rTry; regFrame = rf; }
        if (reg && reg.emitters.length >= wantN) break;
      }
    }
    if (!reg || !reg.emitters.length)
      return { error: "no emitter found in any frame", frames: work.length, emitters: [] };
    if (T) T.register += tnow() - tReg;
    var emitters = reg.emitters.slice(0, opts.maxEmitters || 4);

    // Per-frame homographies: static camera reuses H; handheld re-registers every
    // frame and tracks each emitter by fiducial-centre proximity (falls back to the
    // previous H on a missed frame — a wobble costs nothing downstream but noise).
    var geom = dep("geom");
    var tracksH = emitters.map(function (em) {
      var hs = new Array(groups.length);
      for (var z = 0; z <= regFrame && z < groups.length; z++) hs[z] = em.H;
      return { Hs: hs };
    });
    // v3.1 quadrant + per-frame solve: the saddle TRACKER owns the handheld
    // path (chained solve-as-tracker in the solve loop below). Blind per-frame
    // re-registration is both ~8× slower and ROLL-AMBIGUOUS across frames — a
    // mod-180 flip between frames scrambles every odd-harmonic phase. The
    // export loopback proved it: handheld per-frame registration zeroed the
    // decode; static + tracking rained 29 droplets in 18 s on the same file.
    var saddleTracked = !!(opts.plateSolve && profile.plate && profile.plate.corner_style === "quadrant");
    if (opts.handheld && !saddleTracked) {
      var prev = emitters.map(function (em) { return geom.applyH(em.H, 0, 0); });
      for (var fi = regFrame + 1; fi < groups.length; fi++) {
        var reg2 = register.registerAll(groups[fi].imgs[0], regOpts);
        for (var ei = 0; ei < tracksH.length; ei++) {
          var best = null, bd = Infinity;
          for (var c2 = 0; c2 < reg2.emitters.length; c2++) {
            var cc = geom.applyH(reg2.emitters[c2].H, 0, 0);
            var dd = Math.hypot(cc[0] - prev[ei][0], cc[1] - prev[ei][1]);
            if (dd < bd) { bd = dd; best = reg2.emitters[c2]; }
          }
          if (best && bd < emitters[ei].fiducialWidthPx * 0.8) {
            tracksH[ei].Hs[fi] = best.H;
            prev[ei] = geom.applyH(best.H, 0, 0);
          } else tracksH[ei].Hs[fi] = tracksH[ei].Hs[fi - 1];
        }
      }
    } else {
      for (var fj = regFrame + 1; fj < groups.length; fj++)
        for (var ej = 0; ej < tracksH.length; ej++) tracksH[ej].Hs[fj] = emitters[ej].H;
    }

    // Static-geometry correction (conic.js): a camera off the screen normal
    // leaves each ring's presumed circle on an ellipse registration didn't
    // absorb, and k=1/k=2 are DATA harmonics — the walk-7/8 outer-ring
    // wreckage. Estimate the static k≤2 from frame-averaged boundaries and
    // fold it into every per-frame H as ONE composition; everything below
    // samples through applyH and inherits the fix. Self-gated: below the
    // fit's own noise floor A stays the exact identity and this block
    // changes nothing (no branch doubling — the criterion-hunt lesson).
    // Skip the static conic when the saddle tracker owns geometry: trackSolve
    // re-fits a full per-frame projective H from the corner constellation and
    // OVERWRITES this composition on every frame it solves, so the frame-
    // averaged k≤2 estimate is wasted work (~11% of decode) except on the
    // frames trackSolve misses — and those keep their registration H, which
    // the tracker seeds from anyway. Bullseye plateSolve still gets the conic
    // (its circle-fit benefits from the seed).
    var conicBriefs = null;
    if (opts.conic !== false && !saddleTracked) {
      var conicM = dep("conic");
      conicBriefs = emitters.map(function (_, ce) {
        var tC = T && tnow();
        var est = conicM.estimateStatic(groups, tracksH[ce].Hs, profile, opts.conicOpts);
        if (T) T.conic += tnow() - tC;
        if (est.applied) {
          var HsC = tracksH[ce].Hs;
          for (var ch = 0; ch < HsC.length; ch++) HsC[ch] = conicM.compose(HsC[ch], est.A);
        }
        var brief = {};
        for (var bk in est) if (bk !== "A") brief[bk] = est[bk];
        // Wander probe (opt-in diagnostic): per-window k≤2 fits through the
        // same Hs the decode uses — confirms/kills a moving-pose hypothesis.
        if (opts.conicScan) brief.scan = conicM.scanWindows(groups, tracksH[ce].Hs, profile, opts.conicOpts);
        return brief;
      });
    }

    // Per-frame plate solve (v3 §9, the ladder's second rung): re-fit H from
    // the measured bullseye constellation on every frame — the center-shift
    // field IS the perspective k=1, so the DLT absorbs per-frame what the
    // static conic could only average. Runs AFTER the conic composition:
    // frames where the solve verifies replace their H; frames where it fails
    // keep the conic-corrected track (each rung degrades to the one below).
    var solveBriefs = null;
    if (opts.plateSolve && profile.plate) {
      var plateM = dep("plate");
      // v3.1 quadrant corners: the per-frame solve IS the saddle tracker —
      // project last H, cross-selective refine, re-DLT (solve-as-tracker,
      // §9's shape). Bullseye corners keep the circle-fit plateSolve.
      var saddleM = profile.plate.corner_style === "quadrant" ? dep("saddle") : null;
      solveBriefs = emitters.map(function (_, pe) {
        var HsP = tracksH[pe].Hs, solved = 0, residSum = 0, usedMin = 9;
        // qr_persistent: the center is a QR, not a bullseye — allow the
        // H-derived center anchor when a corner is missing (the A/B fix).
        var solveOpts = { hCenter: !!profile.qr_persistent };
        var tS = T && tnow();
        for (var pf = 0; pf < groups.length; pf++) {
          // The saddle tracker ALWAYS chains from the previous frame's best H:
          // for a static camera the prior H equals the registration H (no
          // cost), for any drift (handheld OR the slow fatigue wander of a
          // "static" hold) the prior H is the nearest pose and the only seed
          // trackSolve's local Förstner can reach the drifted corners from.
          // This is what lets the tracker stand in for the static conic
          // (which we now skip). On loss: re-register if handheld, else keep
          // the last good H. Bullseye plateSolve keeps the frame-static seed.
          var seedH = (saddleM && pf > 0 && HsP[pf - 1]) ? HsP[pf - 1] : HsP[pf];
          var sol = saddleM ? saddleM.trackSolve(groups[pf].imgs[0], seedH, profile, solveOpts)
                            : plateM.plateSolve(groups[pf].imgs[0], HsP[pf], profile, solveOpts);
          if (sol) { HsP[pf] = sol.H; solved++; residSum += sol.residPx; if (sol.used < usedMin) usedMin = sol.used; }
          else if (saddleM) {
            var rr = opts.handheld ? register.registerAll(groups[pf].imgs[0], regOpts) : null;
            if (rr && rr.emitters.length) HsP[pf] = rr.emitters[0].H;
            else if (pf > 0 && HsP[pf - 1]) HsP[pf] = HsP[pf - 1]; // keep the last good pose
          }
        }
        if (T) T.solve += tnow() - tS;
        return { solved: solved, frames: groups.length, usedMin: solved ? usedMin : null,
                 meanResidPx: solved ? Math.round(residSum / solved * 100) / 100 : null };
      });
    }

    // The beacon rides as one more channel (§5): the breaker ring's outer
    // edge through the identical sample→track→align→demap chain; only the
    // byte framing downstream is beacon-specific. layer −1 = out of every
    // layer lookup; excluded from the payload pool.
    var channels = profile.annuli;
    if (opts.beacon && profile.plate) channels = channels.concat([dep("plate").beaconAnnulus(profile)]);

    // Multi-tile identity (§5): exactly one tile carries the breaker pair —
    // find it, then read every other tile's grid offset in the designated
    // tile's own frame (tile 0 renders top-left, so offsets are non-negative
    // in emission coords; mirror stays config, never auto-detected). Tiles
    // differ ONLY by carousel seeds, so decode proceeds identically and the
    // tile index matters exactly twice: the assemble seed, and the pool.
    var tileOf = null, designatedIdx = -1;
    var tilesN = profile.plate ? (profile.tiling || 1) : 1;
    if (tilesN > 1 && emitters.length) {
      var plateT = dep("plate");
      var imgT = opts.registerOn || groups[regFrame].imgs[0];
      tileOf = emitters.map(function () { return -1; });
      for (var de = 0; de < emitters.length; de++) {
        var bT = plateT.findBullseye(imgT, emitters[de].H, 0, 0, profile.plate.center.r_out, { breaker: profile.plate.breaker });
        if (bT && bT.breaker && designatedIdx < 0) designatedIdx = de;
      }
      if (designatedIdx >= 0) {
        var gT = dep("geom");
        var HinvT = gT.invertH(emitters[designatedIdx].H);
        var colsT = tilesN === 2 ? 2 : 3;
        for (var te = 0; te < emitters.length; te++) {
          var cT = gT.applyH(emitters[te].H, 0, 0);
          var uT = gT.applyH(HinvT, cT[0], cT[1]);
          var gx = Math.round(uT[0] / (profile.tile_pitch || 7.2));
          var gy = Math.round(uT[1] / (profile.tile_pitch || 7.2));
          var tt = gy * colsT + gx;
          tileOf[te] = (gx >= 0 && gx < colsT && tt >= 0 && tt < tilesN) ? tt : -1;
        }
      }
    }
    var ringsByEmitter = tilesN > 1 && opts.payload ? [] : null;

    var results = emitters.map(function (em, emIdx) {
      var annuliPairs = channels.map(function (a) {
        var kmax = Math.max.apply(null, a.boundary.harmonics) + 4;
        // ARC-PITCH SAMPLING. The sampler used a fixed 256 rays per ring
        // regardless of circumference, so an inner edge was sampled ~2× denser
        // in PIXELS than an outer one — meaning the OUTER rings, which carry
        // the most droplets, were the under-sampled ones and were throwing
        // away signal for free. Ray count now comes from a target arc pitch
        // (~2 rays per PSF width), floored at the old 256 so no ring ever
        // samples coarser than before. Measured at field scale (70 px/unit,
        // blur 1.2 px, noise 0.028) against the old fixed-256 baseline:
        // a1 +1.2 dB, a2 +2.0 dB, a3 +3.0 dB, a0 unchanged (already at pitch),
        // for ~19% more decode time — the gain tracks radius exactly as
        // σ ∝ 1/√N predicts, so the rays really are independent at this pitch.
        // Computed ONCE per annulus from the registration H: N must stay
        // constant across a ring's series (the DFT and row-time compare
        // contours frame to frame). opts.arcPitchPx overrides; ≤ 0 restores
        // the flat 256.
        // V3 ONLY. v2 (defaultProfile) is a frozen profile with an archived clip
        // corpus; its sampling stays bit-stable so those captures keep decoding
        // exactly as recorded — the same contract logic that keeps
        // profileV3("classic") around for field37–44. (Enabling it for v2 moved
        // T12's torn-duplicate stress case across its tolerance bar, which is
        // the archived-decode drift this rule exists to prevent.)
        var pitchPx = opts.arcPitchPx != null ? opts.arcPitchPx
                    : ((profile.bands && profile.plate) ? ARC_PITCH_PX : 0);
        var sampOpts = null;
        if (pitchPx > 0) {
          var scale0 = sample.unitScale(em.H);
          var nWant = Math.round(2 * Math.PI * a.r0 * scale0 / pitchPx);
          sampOpts = { N: Math.max(256, Math.min(1024, 2 * Math.round(nWant / 2))) };
        }
        // Presence is judged over the ACTIVE span (first valid frame onward) — a
        // capture that starts on the countdown freeze has honest dead frames first.
        var series = [], contrastAct = 0, valid = 0, firstValidIdx = -1, tornRejected = 0;
        var candsPerGroup = new Array(groups.length);
        for (var i = 0; i < groups.length; i++) {
          // Candidate selection, pass 1 (spatial): sample every capture of this
          // emission frame; keep the lowest inactive-bin residual — a torn frame's
          // r(θ) step splashes broadband energy the clean duplicate doesn't have.
          var cands = [];
          for (var ci = 0; ci < groups[i].imgs.length; ci++) {
            var tSm = T && tnow();
            var s = sample.sampleBoundary(groups[i].imgs[ci], tracksH[emIdx].Hs[i], a, sampOpts);
            // Pre-fill copy for the F2 row-time scan: gap-filled angles are
            // fabrications the least-squares refit must never see, and each
            // retained radius + H reproduces its own image row on demand.
            var rRaw = new Float64Array(s.r);
            var gapFrac = sample.fillGaps(s.r);
            if (T) { T.sample += tnow() - tSm; T.samples++; }
            if (gapFrac < 0 || s.found < s.N * 0.7) continue;
            var tDf = T && tnow();
            var spec2 = transform.dft(s.r, kmax);
            cands.push({ spec: spec2, sigma: transform.noiseSigma(spec2, a.boundary.harmonics, kmax), contrast: s.contrast, rRaw: rRaw });
            if (T) T.dft += tnow() - tDf;
          }
          candsPerGroup[i] = cands;
          if (!cands.length) { series.push(null); continue; }
          var best = cands[0];
          for (var c4 = 1; c4 < cands.length; c4++) if (cands[c4].sigma < best.sigma) best = cands[c4];
          if (cands.length > 1) tornRejected += cands.length - 1;
          if (firstValidIdx < 0) firstValidIdx = i;
          valid++;
          contrastAct += best.contrast;
          series.push({ f: groups[i].f, spec: best.spec, rRaw: best.rRaw, H: tracksH[emIdx].Hs[i] });
        }
        var activeN = firstValidIdx >= 0 ? groups.length - firstValidIdx : 0;
        var meanContrast = valid ? contrastAct / valid : 0;
        var present = firstValidIdx >= 0 && valid >= activeN * 0.6 && meanContrast > 0.02;
        if (!present)
          // The row keeps its CHANNEL identity even when absent: downstream
          // filters branch on `beacon` (the payload pool indexes profile.annuli
          // by row position for data rows), and a presence-failed beacon row
          // without the flag walks into the data branch — the first field 2-up
          // at breaker placement found it: tile 1 has no beacon ring, its
          // beacon channel fails presence, and the pool read profile.annuli[4].
          return { res: { annulus: a.index, layer: a.layer, beacon: a.beacon || undefined, present: false, contrast: round3(meanContrast), validFrames: valid }, retry: null };

        // The downstream (track → onset → carrier gates → align → demap → score)
        // as a function of the series, so the row-time branch can be judged
        // EMPIRICALLY (walk 5: the repair stage rescued 5× enhancement rings,
        // 0.87→0.12, and destroyed lit-1× base tracks, 0.14→0.67 — the same
        // gates cannot serve both; the decoder tries both and keeps the winner).
        var downstream = function (seriesX, tearX, consensus) {
          if (T) T.downstreams++;
          var tT = T && tnow();
          var track = separate.trackPhase(seriesX, a, profile);
          // Motion onset: the emitter freezes frame 0 through the countdown, so a
          // capture may begin with valid-but-static samples. Sync bases at onset;
          // no onset at all IS the emitter-stall case.
          var onset = separate.motionOnset(track, a, profile);

          // Carrier check BEFORE symbol work: is the pattern actually rotating?
          // ratio ≈ 1 → healthy; ≈ 0 → static (emitter stalled); else clock mismatch.
          var omega = 2 * Math.PI * a.rotation.nominal_hz;
          var nomStep = omega / profile.frame_rate_hz + Math.PI / (a.rotation.M * a.rotation.frames_per_symbol);
          var stepSum = 0, stepN = 0, pF = null, pPhi = null;
          for (var ff = (onset !== null ? onset : 0); ff <= track.maxF; ff++) {
            if (isNaN(track.phi[ff])) continue;
            if (pF !== null && ff - pF === 1) { stepSum += track.phi[ff] - pPhi; stepN++; }
            pF = ff; pPhi = track.phi[ff];
          }
          var carrierRatio = stepN ? round3((stepSum / stepN) / nomStep) : null;
          // Early-verdict rows carry the same per-harmonic receipt as the
          // no-lock row: STRONG harmonics on a slow track = the emitter's
          // pacing; ABSENT harmonics = the channel never reached the camera
          // (range floor / wrong placement) — a bare static verdict cannot
          // say which, and the first a42r retry take needed exactly that.
          var sigmaEV = averageNoise(seriesX, a, kmax, transform);
          var snrEV = {};
          a.boundary.harmonics.forEach(function (kEV) {
            snrEV[kEV] = round1(20 * Math.log10((track.meanMag[kEV] || 1e-9) / (sigmaEV + 1e-9)));
          });
          // Beacon rows NEVER take the early static/clock verdicts: a window
          // straddling the countdown carries a legitimately static prefix
          // (the D-ring HOLDS through the countdown face by design), reads a
          // low mean carrier, and the early return would starve the chunk
          // sweep — the a42r retry take sealed over its full span while every
          // harvest window static-verdicted and banked nothing. The stalled-
          // emitter verdict belongs to annulus 0 (a stalled canvas stalls ALL
          // annuli); the beacon falls through to alignment + sweep, and the
          // row keeps carrier + snr as its receipt.
          if (onset === null && a.rotation.M <= 4 && !a.beacon)
            return { annulus: a.index, layer: a.layer, present: true, contrast: round3(meanContrast), validFrames: valid,
                     carrierRatio: carrierRatio, snr_db: snrEV,
                     error: "STATIC PATTERN — no motion onset in the whole capture (" + (carrierRatio !== null ? carrierRatio + "× expected" : "no track") + "). The emitter's rendering was stalled: re-film with the rings visibly turning; keep the emitter window focused, plugged in, Fullscreen." };
          // Gate only on low-M annuli (M ≤ 4): a stalled canvas stalls ALL annuli,
          // so annulus 0's verdict covers the emission; higher-M rows report only.
          // A LOW carrier is not always a stalled emitter: walk 4 produced 0.37×
          // from a heavily sway-degraded handheld capture. Say so.
          var swayHint = tearX && valid && (tearX.slipSuspect > valid * 0.2 || tearX.torn > valid * 0.1)
            ? " OR this is a sway-degraded handheld capture (tear/slip diagnostics are heavy) — steady the phone or add light and re-film."
            : "";
          if (carrierRatio !== null && a.rotation.M <= 4 && Math.abs(carrierRatio) < 0.4 && !a.beacon)
            return { annulus: a.index, layer: a.layer, present: true, contrast: round3(meanContrast), validFrames: valid,
                     carrierRatio: carrierRatio, tear: tearBrief(tearX), snr_db: snrEV,
                     error: "STATIC PATTERN — annulus present but not rotating (" + carrierRatio + "× expected). The emitter's rendering was stalled (browser throttling / battery saver): re-film with the emitter animating; keep its window focused, plug in power, use Fullscreen." + swayHint };
          if (carrierRatio !== null && a.rotation.M <= 4 && (carrierRatio < 0.4 || carrierRatio > 1.8) && !a.beacon)
            return { annulus: a.index, layer: a.layer, present: true, contrast: round3(meanContrast), validFrames: valid,
                     carrierRatio: carrierRatio, snr_db: snrEV,
                     error: "CLOCK MISMATCH — rotation at " + carrierRatio + "× expected. Emitter stalling intermittently, or capture fps ≠ profile fps." };

          if (T) T.track += tnow() - tT;
          var tA = T && tnow();
          var syncBase = onset !== null ? onset : null;
          var maxLagSym = Math.ceil(((opts.loopSeconds || 60) * profile.frame_rate_hz) / a.rotation.frames_per_symbol) + profile.preamble_symbols;
          var align = opts.aligned ? { offset: 0, lag: 0, score: null, method: "aligned" } : demap.findAlignment(track, a, profile, syncBase);
          if (align && !align.method) align.method = "preamble";
          if (!align && !a.beacon) {
            // Payload mode has no reference stream — CRC-pass scanning is the
            // mid-loop sync (fountain.js); reference mode correlates the seeds.
            // opts.alignHints[annulus index] = {min,max} predicted-lag band
            // (harvest hop windows price their own lag from the bootstrap lock).
            align = opts.payload
              ? dep("fountain").crcAlign(track, a, profile, syncBase, maxLagSym,
                  opts.alignHints && opts.alignHints[a.index])
              : demap.correlateStream(track, a, profile, maxLagSym, syncBase);
          }
          if (!align && a.beacon) {
            // The beacon's mid-loop join: its data is the control carousel,
            // not the seeded stream, and it carries no droplets — so it frames
            // on ITSELF (magic + CRC8 + the envelope's CRC16; plate.beaconAlign).
            // Until this existed the beacon only read from captures that saw
            // the preamble, which field captures never do.
            align = dep("plate").beaconAlign(track, a, profile, syncBase, opts.beaconAlign);
          }
          // CONSENSUS ADMISSION (second chance): sibling rings already agreed a
          // framing, so this ring is not choosing one — it is reading at a given
          // one, and a single CRC pass there is the ordinary 1/256 standard.
          // Fixes the long-droplet ring's structural disadvantage: base carries
          // 24 symbols per droplet at high-rate against 10 for M=32, so a short
          // window offers it ~2 chances to clear a 2-pass bar and one CRC miss
          // costs it the whole window (measured: base locked 2 of 3 windows
          // where every other ring locked 3 of 3).
          if (!align && !a.beacon && opts.payload && consensus) {
            var Fc = a.rotation.frames_per_symbol;
            // The siblings pinned the window's START FRAME; this ring's lag is
            // that frame divided by its OWN F. The floor leaves ≤2 candidates
            // when F differs, still a ~2000× collapse from the full scan.
            var lagLo = Math.max(0, Math.floor(consensus.lagF / Fc));
            var lagHi = Math.max(0, Math.floor((consensus.lagF + consensus.F - 1) / Fc));
            var baseOff = (syncBase !== null && syncBase !== undefined) ? syncBase : (track.firstValid || 0);
            // Offset is only transferable when the siblings shared this ring's
            // symbol grid. Otherwise scan this ring's own offsets — which puts
            // F hypotheses back in play, so hold the 2-pass bar there rather
            // than relaxing a bar whose safety argument no longer applies.
            var sameGrid = consensus.sameGrid && consensus.F === Fc;
            var aOpts = sameGrid
              ? { minPasses: 1, hintOnly: true, offsets: [baseOff + ((((consensus.offMod - baseOff) % Fc) + Fc) % Fc)] }
              : { minPasses: 2, hintOnly: true };
            align = dep("fountain").crcAlign(track, a, profile, syncBase, maxLagSym,
              { min: lagLo, max: lagHi }, aOpts);
            if (align) align.method = "consensus";
          }
          if (T) T.align += tnow() - tA;
          var tDm = T && tnow();
          if (!align) {
            // A beacon window shorter than the envelope cycle can still carry
            // CHUNKS (the first a42 field clip: 13.3 s cycle vs 8–12 s harvest
            // windows). Sweep the best alignment's CRC8-passing chunks so the
            // lease can BANK them across windows and bind on assembly — the
            // droplet pattern applied to the control plane. Sub-seal evidence:
            // the row stays a no-lock row; only the assembled CRC16 ever binds.
            var sweep = a.beacon ? dep("plate").beaconChunkSweep(track, a, profile, syncBase) : null;
            // The no-lock row keeps its per-harmonic receipt (mag/sigma dB per
            // tracked k, same figure as the locked path): the measured SHAPE
            // identifies the emitted amp split from the clip alone, and the
            // absolute level separates a STARVED channel from a WRONG CLOCK —
            // the two readings of a low carrier that need different fixes.
            var sigmaNL = averageNoise(seriesX, a, kmax, transform);
            var snrNL = {};
            a.boundary.harmonics.forEach(function (kNL) {
              snrNL[kNL] = round1(20 * Math.log10((track.meanMag[kNL] || 1e-9) / (sigmaNL + 1e-9)));
            });
            return { annulus: a.index, layer: a.layer, beacon: a.beacon || undefined,
                     present: true, contrast: round3(meanContrast), validFrames: valid,
                     carrierRatio: carrierRatio, tear: tearBrief(tearX), snr_db: snrNL,
                     chunkSweep: sweep && sweep.passes ? sweep.chunks : undefined,
                     chunkSweepPasses: sweep ? sweep.passes : undefined,
                     tagSeen: sweep && sweep.tagSeen != null ? ("0000" + (sweep.tagSeen >>> 0).toString(16)).slice(-4) : undefined,
                     tagSightings: sweep ? sweep.tagSightings : undefined,
                     error: "no lock — symbols match neither preamble nor stream at any lag (carrier " + carrierRatio + "× expected" + (carrierRatio !== null && carrierRatio < 0.5 ? "; low carrier — see the layer-0 row" : "") + ")" +
                            (sweep && sweep.passes ? " — chunk sweep banked " + Object.keys(sweep.chunks).length + " idx (" + sweep.passes + " passes)" : "") };
          }
          var decoded = demap.decode(track, a, profile, align.offset);

          if (a.beacon) {
            var plateB = dep("plate");
            var envFrames = plateB.beaconFramesFor(decoded, align, a.rotation.M);
            var envParses = false;
            for (var ep = 0; ep < envFrames.length && !envParses; ep++)
              envParses = !!plateB.parseEnvelope(envFrames[ep].envelope);
            if (align.method !== "framed" && !envParses) {
              // A preamble lock that yields no PARSED envelope is suspect two
              // ways: at M=2 the preamble (1, M−1, 1, …) is ALL ONES, so any
              // run of 1-bits false-locks it at a small lag (T22r found it);
              // and a genuine preamble lock reads only the v0 frame scan,
              // which is blind to the chunked framing and can even chance-hit
              // 0xB3 inside a chunk stream. Refit on the carousel itself —
              // beaconAlign scans BOTH framings — and keep the original read
              // if it finds nothing better (short synthetic envelopes parse
              // as nothing yet still frame legitimately).
              var alignF = plateB.beaconAlign(track, a, profile, syncBase, opts.beaconAlign);
              if (alignF) {
                align = alignF;
                decoded = demap.decode(track, a, profile, align.offset);
                envFrames = plateB.beaconFramesFor(decoded, align, a.rotation.M);
              }
            }
            // Prefer a frame that parses as a sealed v1 envelope (CRC16);
            // fall back to the first CRC8-framed one (short synthetic envelopes).
            var env = null, envFields = null;
            for (var ef = 0; ef < envFrames.length && !envFields; ef++) {
              var pf = plateB.parseEnvelope(envFrames[ef].envelope);
              if (pf) { env = envFrames[ef]; envFields = pf; }
            }
            if (!env && envFrames.length) env = envFrames[0];
            // Symbol-level receipt: the control frame is LONG (23 bytes = 184
            // symbols at M=2) under one CRC, so a few erasures sink every frame
            // where a 24-symbol droplet would shrug — the count says whether a
            // missing envelope is symbol quality or the carousel-phase draw.
            var nullSyms = 0;
            for (var ns = 0; ns < decoded.length; ns++) if (decoded[ns].s === null || decoded[ns].s === undefined) nullSyms++;
            // The chunk sweep must also run HERE: a false preamble lock (or
            // any alignment that parses nothing) routes around the no-lock
            // return where the sweep lives, and T22v's middle window lost its
            // two chunks to exactly that — the bank then never assembled.
            var sweepB = (!env && !align.tagConfirmed) ? plateB.beaconChunkSweep(track, a, profile, syncBase) : null;
            var sigmaBk = averageNoise(seriesX, a, kmax, transform);
            var snrBk = {};
            a.boundary.harmonics.forEach(function (kBk) {
              snrBk[kBk] = round1(20 * Math.log10((track.meanMag[kBk] || 1e-9) / (sigmaBk + 1e-9)));
            });
            return {
              annulus: a.index, layer: a.layer, present: true, beacon: true,
              contrast: round3(meanContrast), validFrames: valid, snr_db: snrBk,
              carrierRatio: carrierRatio, alignMethod: align.method || "preamble",
              alignOffset: align.offset, alignLag: align.lag,
              framing: align.framing || "frame",
              symbols: decoded.length, erasures: nullSyms,
              erasureRate: decoded.length ? round3(nullSyms / decoded.length) : null,
              folded: align.folded || undefined,
              foldAgree: align.folded ? align.foldAgree : undefined,
              foldCompared: align.folded ? align.foldCompared : undefined,
              // The fast tag = the envelope's CRC16 seal (ruling 2) — derivable
              // under either framing once the envelope is in hand; chunked
              // alignments also report how often the tag chunk itself was
              // seen, and a tagConfirmed row re-verified a KNOWN tag without
              // a full seal (the lease's identity heartbeat).
              tag: env && env.envelope.length === 20 ? toHex(env.envelope.subarray ? env.envelope.subarray(18, 20) : env.envelope.slice(18, 20)) : (align.tag || undefined),
              tagConfirmed: align.tagConfirmed || undefined,
              tagSightings: align.tagSightings !== undefined ? align.tagSightings :
                            (sweepB ? sweepB.tagSightings : undefined),
              chunkConflicts: align.chunkConflicts || undefined,
              chunkSweep: sweepB && sweepB.passes ? sweepB.chunks : undefined,
              chunkSweepPasses: sweepB ? sweepB.passes : undefined,
              tagSeen: sweepB && sweepB.tagSeen != null ? ("0000" + (sweepB.tagSeen >>> 0).toString(16)).slice(-4) : undefined,
              envelope: env ? toHex(env.envelope) : null,
              envelopeAt: env ? env.at : null,
              envelopeFrames: envFrames.length,
              envelopeFields: envFields || undefined,
              error: (env || align.tagConfirmed) ? undefined : "beacon locked but no framed envelope in the captured span (" + nullSyms + "/" + decoded.length + " symbols erased)" +
                     (sweepB && sweepB.passes ? " — chunk sweep banked " + Object.keys(sweepB.chunks).length + " idx (" + sweepB.passes + " passes)" : "")
            };
          }

          var sigma = averageNoise(seriesX, a, kmax, transform);
          var snr = {};
          a.boundary.harmonics.forEach(function (k) {
            snr[k] = round1(20 * Math.log10((track.meanMag[k] || 1e-9) / (sigma + 1e-9)));
          });

          if (opts.payload) {
            var col = dep("fountain").collect(decoded, align.lag, a, profile);
            if (T) T.demod += tnow() - tDm;
            return {
              annulus: a.index, layer: a.layer, present: true,
              contrast: round3(meanContrast), validFrames: valid, firstValidFrame: firstValidIdx >= 0 ? groups[firstValidIdx].f : null,
              duplicatesSeen: work.length - groups.length,
              carrierRatio: carrierRatio, alignMethod: align.method,
              alignOffset: align.offset, alignLag: align.lag, alignScore: align.score,
              dropletsPassed: col.passed.length, dropletsTried: col.tried,
              droplets: col.passed.map(function (d) { return { c: d.c, hex: toHex(d.bytes) }; }),
              _droplets: col.passed,
              snr_db: snr, tear: tearBrief(tearX)
            };
          }

          var score = serM.evaluate(decoded, a, profile, align.lag);
          if (T) T.demod += tnow() - tDm;
          return {
            annulus: a.index, layer: a.layer, present: true,
            contrast: round3(meanContrast), validFrames: valid, firstValidFrame: firstValidIdx >= 0 ? groups[firstValidIdx].f : null,
            duplicatesSeen: work.length - groups.length,
            carrierRatio: carrierRatio, alignMethod: align.method, alignMatchFrac: align.matchFrac,
            alignOffset: align.offset, alignLag: align.lag, alignScore: align.score,
            ser: round3(score.ser), errors: score.errors, compared: score.compared,
            erasures: score.erasures, erasureRate: round3(score.erasureRate),
            preambleMiss: score.preambleMiss, ok: score.ok, snr_db: snr,
            tear: tearBrief(tearX)
          };
        };

        // F2 row-time repair (rowtime.js): seams refit from the clean side,
        // sway-warps de-warped, unlabelable seams invalidated to erasures.
        // (A neighbor-midpoint temporal adjudicator was tried and REVERTED:
        // at symbol kinks the midpoint is itself a temporal blend.)
        var rowtime = opts.rowTime !== false ? dep("rowtime") : null;
        var tear = null;
        var tR = T && tnow();
        if (rowtime) {
          var track0 = separate.trackPhase(series, a, profile);
          tear = rowtime.repairSeries(series, track0, a, profile, opts.rowTimeOpts);
          if (tear.repaired > 0 || tear.invalidated > 0 || tear.warped > 0) {
            var trackR = separate.trackPhase(series, a, profile);
            var tear2 = rowtime.repairSeries(series, trackR, a, profile, opts.rowTimeOpts);
            tear.repaired = tear2.repaired; tear.torn = tear2.torn;
            tear.warped = tear2.warped; tear.warpRate = tear2.warpRate;
            tear.invalidated = tear2.invalidated; tear.reasons = tear2.reasons;
            tear.slipSuspect = tear2.slipSuspect; tear.cuts = tear2.cuts;
          }
        }
        if (T) T.rowtime += tnow() - tR;
        var mutated = tear && (tear.repaired > 0 || tear.invalidated > 0 || tear.warped > 0);
        // Judge the repairs by outcome, not by gate: decode BOTH the repaired
        // series and the untouched originals (spec0, retained for exactly
        // this), and keep the better result. Rank: hard error < decodes;
        // then ok, lower SER, fewer erasures, stronger alignment.
        var seriesPlain = mutated ? series.map(function (e) {
          return e && e.spec0 ? { f: e.f, spec: e.spec0 } : e;
        }) : null;
        var rank = function (r) {
          return [r.error ? 0 : 1, r.ok ? 1 : 0,
                  r.dropletsPassed != null ? r.dropletsPassed : -1, // payload mode: droplets are the quality
                  r.ser != null && !isNaN(r.ser) ? -r.ser : -9,
                  r.erasures != null ? -r.erasures : -999,
                  r.alignMatchFrac != null ? r.alignMatchFrac : -1];
        };
        // Resolve this ring, optionally with a sibling-supplied framing. Kept
        // as a closure so a ring that fails to lock can be retried against the
        // consensus WITHOUT re-sampling (the expensive part is already done).
        var resolve = function (consensus) {
          if (!mutated) return downstream(series, tear, consensus);
          tear.applied = true;
          var rRep = downstream(series, tear, consensus);
          var tearOff = {};
          for (var tk in tear) tearOff[tk] = tear[tk];
          tearOff.applied = false;
          var rPlain = downstream(seriesPlain, tearOff, consensus);
          var ra = rank(rRep), rb = rank(rPlain), pick = rRep;
          for (var ri = 0; ri < ra.length; ri++) {
            if (ra[ri] > rb[ri]) { pick = rRep; break; }
            if (ra[ri] < rb[ri]) { pick = rPlain; break; }
          }
          return pick;
        };
        var first = resolve(null);
        return { res: first, retry: (first && first.error && !a.beacon) ? resolve : null };
      });

      // ——— consensus admission across this emitter's rings ———
      // A framing agreed by ≥2 rings is evidence independent of any one ring's
      // droplet supply; rings that could not clear the 2-pass bar on their own
      // get one read at exactly that (lag, offset mod frames_per_symbol).
      var annuli = annuliPairs.map(function (p) { return p.res; });
      if (opts.payload && opts.consensusLock !== false) {
        // Agreement is about WHEN the window began, so it is compared in
        // FRAMES: lag counts each ring's own symbols and a ring's symbol index
        // at emission frame f is floor(f / F), making lag × F the
        // ring-independent quantity. Raw-lag comparison is only valid while
        // every ring shares F; normalising here is what makes per-ring
        // frames_per_symbol safe to vary.
        var groups2 = [], cons = null;
        for (var cq = 0; cq < annuli.length; cq++) {
          var rq = annuli[cq];
          if (!rq || rq.beacon || rq.error || rq.alignLag == null || rq.alignOffset == null) continue;
          var pa2 = profile.annuli[rq.annulus];
          var Fq = pa2 ? pa2.rotation.frames_per_symbol : 4;
          var lagF = rq.alignLag * Fq, offM = (((rq.alignOffset % Fq) + Fq) % Fq);
          var placed = false;
          for (var gq = 0; gq < groups2.length; gq++) {
            var G = groups2[gq];
            if (Math.abs(G.lagF - lagF) <= Math.max(G.F, Fq)) {
              G.n++; if (Fq !== G.F) G.mixedF = true;
              if (G.offMod !== offM) G.mixedOff = true;
              placed = true; break;
            }
          }
          if (!placed) groups2.push({ lagF: lagF, F: Fq, offMod: offM, n: 1, mixedF: false, mixedOff: false });
        }
        for (var gq2 = 0; gq2 < groups2.length; gq2++) if (groups2[gq2].n >= 2) {
          var G2 = groups2[gq2];
          cons = { lagF: G2.lagF, offMod: G2.offMod, F: G2.F, sameGrid: !G2.mixedF && !G2.mixedOff };
          break;
        }
        if (cons) {
          for (var cr = 0; cr < annuli.length; cr++) {
            if (!annuliPairs[cr].retry) continue;
            var r2 = annuliPairs[cr].retry(cons);
            if (r2 && !r2.error) annuli[cr] = r2;
          }
        }
      }
      // Payload mode: pool every ring's verified droplets into one peel.
      var payload;
      if (opts.payload) {
        // beacon rides last in channels — profile.annuli[ri] stays aligned
        // for the data rows; the beacon banks no droplets and joins no peel.
        // Tile seeds: this emitter's droplets were encoded under its tile's
        // shifted seeds — the assemble subsets must match.
        var emTile = tileOf ? tileOf[emIdx] : 0;
        var FNp = dep("fountain");
        var rings = annuli.map(function (r, ri) {
          // beacon rows never pool; the profile.annuli guard keeps any future
          // extra channel from aliasing into a data ring by position
          return (r.beacon || !profile.annuli[ri]) ? null : { seed: FNp.tileSeed(profile.annuli[ri].rotation.seed, emTile >= 0 ? emTile : 0), droplets: r._droplets || [] };
        }).filter(function (x) { return x; });
        annuli.forEach(function (r) { delete r._droplets; });
        if (ringsByEmitter) ringsByEmitter[emIdx] = emTile >= 0 ? rings : null;
        payload = FNp.assemble(rings, profile);
        if (payload && payload.bytes) payload.hex = toHex(payload.bytes);
        if (payload) delete payload.bytes;
      }
      // Plate centre in capture pixels (H maps plate units → image): the
      // spatial identity of this emitter for anything keyed per plate.
      var cPx = em.H ? dep("geom").applyH(em.H, 0, 0) : null;
      return { fiducialWidthPx: Math.round(em.fiducialWidthPx * 10) / 10, method: em.method || "finder",
               center: cPx ? [Math.round(cPx[0] * 10) / 10, Math.round(cPx[1] * 10) / 10] : undefined,
               conic: conicBriefs ? conicBriefs[emIdx] : undefined,
               plateSolve: solveBriefs ? solveBriefs[emIdx] : undefined,
               tile: tileOf ? tileOf[emIdx] : undefined,
               annuli: annuli, payload: payload };
    });

    // The multi-tile prize: one peel over every tile's verified droplets —
    // tile-distinct seeds make the (ringSeed, c) dedupe key collision-free
    // across the pool, so this is a longer rings list, nothing more.
    var pooled;
    if (ringsByEmitter) {
      var allRings = [];
      ringsByEmitter.forEach(function (rr) { if (rr) allRings = allRings.concat(rr); });
      if (allRings.length) {
        pooled = dep("fountain").assemble(allRings, profile);
        if (pooled && pooled.bytes) { pooled.hex = toHex(pooled.bytes); delete pooled.bytes; }
      }
    }

    return { emitters: results, emitterCount: emitters.length, regFrame: regFrame,
             designatedTile: designatedIdx >= 0 ? designatedIdx : undefined, pooled: pooled,
             timings: T || undefined };
  }

  /* v3 preset auto-detect (§2, as ruled: binary, dual-geometry, ≥2 agreeing
     CRC passes). The presets share every optical stage — only M and droplet
     geometry differ — so the mechanism is decode-under-both and let the CRC
     passes vote: the wrong geometry's chance rate is 1/256 per droplet.
     Resilient first (the default); one full re-decode when wrong is the v0
     price — reusing the phase tracks across geometries is recorded future
     work, not a correctness need. */
  function decodeV3Auto(frames, opts) {
    opts = opts || {};
    var PRF = dep("profile");
    function passes(res) {
      if (!res || res.error) return 0;
      var t = 0;
      res.emitters.forEach(function (em) {
        em.annuli.forEach(function (r) { if (r.dropletsPassed) t += r.dropletsPassed; });
      });
      return t;
    }
    var o = {};
    for (var k in opts) o[k] = opts[k];
    o.payload = true;
    // The vote is COMPARATIVE, not first-past-bar: a wrong-geometry crcAlign
    // scan (≈458 lags × 4 offsets × 4 edges) has order-1 odds of a 2-pass
    // chance lock, so "≥2 agreeing passes" alone can misfire. The true
    // geometry lights up with many passes; chance produces a couple. Decode
    // both, let the counts vote; short-circuit only when the default's count
    // is already beyond what chance produces.
    var pR = PRF.profileV3(), rR = decodeSequence(frames, pR, o);
    var nR = passes(rR);
    if (nR >= 6) return { preset: "resilient", passes: nR, result: rR };
    var pH = PRF.profileV3("high-rate"), rH = decodeSequence(frames, pH, o);
    var nH = passes(rH);
    var win = nH > nR ? "high-rate" : "resilient";
    var nW = Math.max(nR, nH);
    if (nW >= 2 && nR !== nH)
      return { preset: win, passes: nW, passesOther: Math.min(nR, nH), result: win === "high-rate" ? rH : rR };
    return { preset: null, passes: nW, result: nR >= nH ? rR : rH };
  }

  function toHex(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i++) s += (u8[i] < 16 ? "0" : "") + u8[i].toString(16);
    return s;
  }

  function tearBrief(t) {
    if (!t) return undefined;
    return { applied: t.applied, scanned: t.scanned, torn: t.torn, repaired: t.repaired, warped: t.warped, warpRate: t.warpRate, invalidated: t.invalidated, slipSuspect: t.slipSuspect, reasons: t.reasons, cuts: t.cuts };
  }

  function averageNoise(series, a, kmax, transform) {
    var sum = 0, n = 0;
    for (var i = 0; i < series.length; i++) {
      if (!series[i] || !series[i].spec) continue; // row-time may invalidate a seam frame
      sum += transform.noiseSigma(series[i].spec, a.boundary.harmonics, kmax);
      n++;
    }
    return n ? sum / n : 0;
  }

  function round3(x) { return Math.round(x * 1000) / 1000; }
  function round1(x) { return Math.round(x * 10) / 10; }

  var API = { decodeSequence: decodeSequence, decodeV3Auto: decodeV3Auto };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.pipeline = API;
})(typeof window !== "undefined" ? window : globalThis);
