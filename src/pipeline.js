/* pipeline.js — the decoder pipeline (spec §9), stages 1–8 + scoring, per emitter.
   Multi-emitter is structural (spec §5.1): registration returns a LIST and the
   pipeline decodes each. Mirror parity is applied ONCE, to the frame, before
   registration (C9 — config flag, never auto-detected). */
(function (global) {
  "use strict";

  function dep(n) { return (typeof module !== "undefined" && module.exports) ? require("./" + n + ".js") : global.OC[n]; }

  /* frames: [{ f, img }] — f is the capture/emission frame index.
     opts: { mirror: {receive}, aligned, staticCamera (default true), maxEmitters } */
  function decodeSequence(frames, profile, opts) {
    opts = opts || {};
    var register = dep("register"), sample = dep("sample"), transform = dep("transform"),
        separate = dep("separate"), demap = dep("demap"), serM = dep("ser"), degrade = dep("degrade");

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
    var reg = null, regFrame = 0;
    if (opts.registerOn) {
      reg = register.registerAll(opts.registerOn);
    } else {
      for (var rf = 0; rf < groups.length; rf++) {
        var rTry = register.registerAll(groups[rf].imgs[0]);
        if (rTry.emitters.length) { reg = rTry; regFrame = rf; break; }
      }
    }
    if (!reg || !reg.emitters.length)
      return { error: "no emitter found in any frame", frames: work.length, emitters: [] };
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
    if (opts.handheld) {
      var prev = emitters.map(function (em) { return geom.applyH(em.H, 0, 0); });
      for (var fi = regFrame + 1; fi < groups.length; fi++) {
        var reg2 = register.registerAll(groups[fi].imgs[0]);
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

    var results = emitters.map(function (em, emIdx) {
      var annuli = profile.annuli.map(function (a) {
        var kmax = Math.max.apply(null, a.boundary.harmonics) + 4;
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
            var s = sample.sampleBoundary(groups[i].imgs[ci], tracksH[emIdx].Hs[i], a);
            var gapFrac = sample.fillGaps(s.r);
            if (gapFrac < 0 || s.found < s.N * 0.7) continue;
            var spec2 = transform.dft(s.r, kmax);
            cands.push({ spec: spec2, sigma: transform.noiseSigma(spec2, a.boundary.harmonics, kmax), contrast: s.contrast });
          }
          candsPerGroup[i] = cands;
          if (!cands.length) { series.push(null); continue; }
          var best = cands[0];
          for (var c4 = 1; c4 < cands.length; c4++) if (cands[c4].sigma < best.sigma) best = cands[c4];
          if (cands.length > 1) tornRejected += cands.length - 1;
          if (firstValidIdx < 0) firstValidIdx = i;
          valid++;
          contrastAct += best.contrast;
          series.push({ f: groups[i].f, spec: best.spec });
        }
        var activeN = firstValidIdx >= 0 ? groups.length - firstValidIdx : 0;
        var meanContrast = valid ? contrastAct / valid : 0;
        var present = firstValidIdx >= 0 && valid >= activeN * 0.6 && meanContrast > 0.02;
        if (!present)
          return { annulus: a.index, layer: a.layer, present: false, contrast: round3(meanContrast), validFrames: valid };

        var track = separate.trackPhase(series, a, profile);
        // NOTE on the residual tear class: a seam that MISSES this annulus's band
        // yields a clean-looking ring at the wrong instant — invisible to the
        // spatial residual, worth ~1 symbol error per ~13 under 100%-torn
        // pollution (T12). A neighbor-midpoint temporal adjudicator was tried and
        // REVERTED: at symbol-boundary kinks the midpoint is itself a temporal
        // blend and sides with the torn candidate. The principled fix is F2
        // row-time regression — each sample's row says which instant it belongs to.

        // Carrier check BEFORE symbol work: is the pattern actually rotating?
        // Expected per-frame advance = nominal + mean data drift (uniform symbols
        // are NOT zero-mean: mean delta = π/M per symbol = π/(M·F) per frame).
        // ratio ≈ 1 → healthy; ≈ 0 → static (emitter stalled); else clock mismatch.
        var omega = 2 * Math.PI * a.rotation.nominal_hz;
        var nomStep = omega / profile.frame_rate_hz + Math.PI / (a.rotation.M * a.rotation.frames_per_symbol);
        var stepSum = 0, stepN = 0, pF = null, pPhi = null;
        for (var ff = 0; ff <= track.maxF; ff++) {
          if (isNaN(track.phi[ff])) continue;
          if (pF !== null && ff - pF === 1) { stepSum += track.phi[ff] - pPhi; stepN++; }
          pF = ff; pPhi = track.phi[ff];
        }
        var carrierRatio = stepN ? round3((stepSum / stepN) / nomStep) : null;
        // Gate only on low-M annuli (M ≤ 4): short seeded streams have large drift
        // variance, so static-vs-running is statistically separable only where the
        // nominal advance dominates — and a stalled canvas stalls ALL annuli, so
        // annulus 0's verdict covers the emission. Higher-M rows report, never gate.
        if (carrierRatio !== null && a.rotation.M <= 4 && Math.abs(carrierRatio) < 0.4)
          return { annulus: a.index, layer: a.layer, present: true, contrast: round3(meanContrast), validFrames: valid,
                   carrierRatio: carrierRatio,
                   error: "STATIC PATTERN — annulus present but not rotating (" + carrierRatio + "× expected). The emitter's rendering was stalled (browser throttling / battery saver): re-film with the emitter animating; keep its window focused, plug in power, use Fullscreen." };
        if (carrierRatio !== null && a.rotation.M <= 4 && (carrierRatio < 0.4 || carrierRatio > 1.8))
          return { annulus: a.index, layer: a.layer, present: true, contrast: round3(meanContrast), validFrames: valid,
                   carrierRatio: carrierRatio,
                   error: "CLOCK MISMATCH — rotation at " + carrierRatio + "× expected. Emitter stalling intermittently, or capture fps ≠ profile fps." };

        var align = opts.aligned ? { offset: 0, lag: 0, score: null, method: "aligned" } : demap.findAlignment(track, a, profile);
        if (align && !align.method) align.method = "preamble";
        if (!align) {
          var maxLagSym = Math.ceil(((opts.loopSeconds || 60) * profile.frame_rate_hz) / a.rotation.frames_per_symbol) + profile.preamble_symbols;
          align = demap.correlateStream(track, a, profile, maxLagSym);
        }
        if (!align)
          return { annulus: a.index, layer: a.layer, present: true, contrast: round3(meanContrast), validFrames: valid,
                   carrierRatio: carrierRatio,
                   error: "no lock — symbols match neither preamble nor stream at any lag (carrier " + carrierRatio + "× expected" + (carrierRatio !== null && carrierRatio < 0.5 ? "; low carrier — see the layer-0 row" : "") + ")" };
        var decoded = demap.decode(track, a, profile, align.offset);
        var score = serM.evaluate(decoded, a, profile, align.lag);

        var sigma = averageNoise(series, a, kmax, transform);
        var snr = {};
        a.boundary.harmonics.forEach(function (k) {
          snr[k] = round1(20 * Math.log10((track.meanMag[k] || 1e-9) / (sigma + 1e-9)));
        });

        return {
          annulus: a.index, layer: a.layer, present: true,
          contrast: round3(meanContrast), validFrames: valid, firstValidFrame: firstValidIdx >= 0 ? groups[firstValidIdx].f : null,
          duplicatesSeen: work.length - groups.length,
          carrierRatio: carrierRatio, alignMethod: align.method, alignMatchFrac: align.matchFrac,
          alignOffset: align.offset, alignLag: align.lag, alignScore: align.score,
          ser: round3(score.ser), errors: score.errors, compared: score.compared,
          erasures: score.erasures, erasureRate: round3(score.erasureRate),
          preambleMiss: score.preambleMiss, ok: score.ok, snr_db: snr
        };
      });
      return { fiducialWidthPx: Math.round(em.fiducialWidthPx * 10) / 10, annuli: annuli };
    });

    return { emitters: results, emitterCount: emitters.length, regFrame: regFrame };
  }

  function averageNoise(series, a, kmax, transform) {
    var sum = 0, n = 0;
    for (var i = 0; i < series.length; i++) {
      if (!series[i]) continue;
      sum += transform.noiseSigma(series[i].spec, a.boundary.harmonics, kmax);
      n++;
    }
    return n ? sum / n : 0;
  }

  function round3(x) { return Math.round(x * 1000) / 1000; }
  function round1(x) { return Math.round(x * 10) / 10; }

  var API = { decodeSequence: decodeSequence };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.pipeline = API;
})(typeof window !== "undefined" ? window : globalThis);
