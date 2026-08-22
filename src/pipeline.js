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
      for (var rf = 0; rf < groups.length; rf++) {
        var rTry = register.registerAll(groups[rf].imgs[0], regOpts);
        if (rTry.emitters.length) { reg = rTry; regFrame = rf; break; }
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
          return { res: { annulus: a.index, layer: a.layer, present: false, contrast: round3(meanContrast), validFrames: valid }, retry: null };

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
          if (onset === null && a.rotation.M <= 4)
            return { annulus: a.index, layer: a.layer, present: true, contrast: round3(meanContrast), validFrames: valid,
                     carrierRatio: carrierRatio,
                     error: "STATIC PATTERN — no motion onset in the whole capture (" + (carrierRatio !== null ? carrierRatio + "× expected" : "no track") + "). The emitter's rendering was stalled: re-film with the rings visibly turning; keep the emitter window focused, plugged in, Fullscreen." };
          // Gate only on low-M annuli (M ≤ 4): a stalled canvas stalls ALL annuli,
          // so annulus 0's verdict covers the emission; higher-M rows report only.
          // A LOW carrier is not always a stalled emitter: walk 4 produced 0.37×
          // from a heavily sway-degraded handheld capture. Say so.
          var swayHint = tearX && valid && (tearX.slipSuspect > valid * 0.2 || tearX.torn > valid * 0.1)
            ? " OR this is a sway-degraded handheld capture (tear/slip diagnostics are heavy) — steady the phone or add light and re-film."
            : "";
          if (carrierRatio !== null && a.rotation.M <= 4 && Math.abs(carrierRatio) < 0.4)
            return { annulus: a.index, layer: a.layer, present: true, contrast: round3(meanContrast), validFrames: valid,
                     carrierRatio: carrierRatio, tear: tearBrief(tearX),
                     error: "STATIC PATTERN — annulus present but not rotating (" + carrierRatio + "× expected). The emitter's rendering was stalled (browser throttling / battery saver): re-film with the emitter animating; keep its window focused, plug in power, use Fullscreen." + swayHint };
          if (carrierRatio !== null && a.rotation.M <= 4 && (carrierRatio < 0.4 || carrierRatio > 1.8))
            return { annulus: a.index, layer: a.layer, present: true, contrast: round3(meanContrast), validFrames: valid,
                     carrierRatio: carrierRatio,
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
            // The beacon has neither fallback (its data is the control
            // carousel, not the seeded stream, and it carries no droplets):
            // preamble lock or an honest no-lock row — v0 limitation, mid-
            // cycle beacon joins wait on a framing-based aligner.
            align = opts.payload
              ? dep("fountain").crcAlign(track, a, profile, syncBase, maxLagSym,
                  opts.alignHints && opts.alignHints[a.index])
              : demap.correlateStream(track, a, profile, maxLagSym, syncBase);
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
          if (!align)
            return { annulus: a.index, layer: a.layer, present: true, contrast: round3(meanContrast), validFrames: valid,
                     carrierRatio: carrierRatio, tear: tearBrief(tearX),
                     error: "no lock — symbols match neither preamble nor stream at any lag (carrier " + carrierRatio + "× expected" + (carrierRatio !== null && carrierRatio < 0.5 ? "; low carrier — see the layer-0 row" : "") + ")" };
          var decoded = demap.decode(track, a, profile, align.offset);

          if (a.beacon) {
            var env = dep("plate").beaconDecode(decoded, align.lag, a.rotation.M);
            return {
              annulus: a.index, layer: a.layer, present: true, beacon: true,
              contrast: round3(meanContrast), validFrames: valid,
              carrierRatio: carrierRatio, alignMethod: align.method || "preamble",
              alignOffset: align.offset, alignLag: align.lag,
              envelope: env ? toHex(env.envelope) : null,
              envelopeAt: env ? env.at : null,
              error: env ? undefined : "beacon locked but no framed envelope in the captured span"
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
          return r.beacon ? null : { seed: FNp.tileSeed(profile.annuli[ri].rotation.seed, emTile >= 0 ? emTile : 0), droplets: r._droplets || [] };
        }).filter(function (x) { return x; });
        annuli.forEach(function (r) { delete r._droplets; });
        if (ringsByEmitter) ringsByEmitter[emIdx] = emTile >= 0 ? rings : null;
        payload = FNp.assemble(rings, profile);
        if (payload && payload.bytes) payload.hex = toHex(payload.bytes);
        if (payload) delete payload.bytes;
      }
      return { fiducialWidthPx: Math.round(em.fiducialWidthPx * 10) / 10, method: em.method || "finder",
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
