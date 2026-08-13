/* demap.js — stage 8: phase track → differential symbols.
   θ_data(f) = φ(f) − ω·f/fps; a symbol is the wrapped Δθ between consecutive
   boundary frames (offset + i·frames_per_symbol). Erasure, not error, when a
   boundary is unobserved, when a long gap undermines the bridge, or when the
   decision is low-confidence (>0.35 step residual) — erasures feed the fountain
   layer's accounting (spec C4; review F7 posture). Alignment: correlate against
   the known preamble (spec §7.3.1's fixed-rate-header move). */
(function (global) {
  "use strict";

  var TAU = Math.PI * 2;
  function wrap(x) { x = x % TAU; if (x > Math.PI) x -= TAU; if (x <= -Math.PI) x += TAU; return x; }

  function thetaData(track, annulus, profile, f) {
    var omega = TAU * annulus.rotation.nominal_hz;
    return track.phi[f] - omega * f / profile.frame_rate_hz;
  }

  function gapIntersects(track, f0, f1, minLen) {
    for (var g in track.gapAfter) {
      var gs = +g, ge = gs + track.gapAfter[g];
      if (track.gapAfter[g] >= minLen && gs < f1 && ge > f0) return true;
    }
    return false;
  }

  /* decode at a frame offset → [{ i, s (null=erasure), resid }].
     The within-symbol CPM sweep is LINEAR, so the symbol is the chord slope of
     θ_data across all F+1 frames of the symbol — a least-squares fit, not an
     endpoint difference. Identical on clean frames; on real footage it averages
     the per-frame time jitter (VFR capture, seek-nearest sampling) that an
     endpoint read eats whole. */
  function decode(track, annulus, profile, offset) {
    var F = annulus.rotation.frames_per_symbol, M = annulus.rotation.M;
    var step = TAU / M;
    var out = [];
    var maxF = track.maxF;
    for (var i = 0; ; i++) {
      var f0 = offset + i * F, f1 = offset + (i + 1) * F;
      if (f1 > maxF) break;
      if (gapIntersects(track, f0, f1, Math.max(2, F / 2))) {
        out.push({ i: i, s: null, resid: null });
        continue;
      }
      var sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
      var haveEnds = !isNaN(track.phi[f0]) && !isNaN(track.phi[f1]);
      for (var f = f0; f <= f1; f++) {
        if (isNaN(track.phi[f])) continue;
        var x = f - f0;
        var y = thetaData(track, annulus, profile, f);
        sx += x; sy += y; sxx += x * x; sxy += x * y; n++;
      }
      if (n < 3 || !haveEnds) { out.push({ i: i, s: null, resid: null }); continue; }
      var slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      var delta = slope * F;
      var sRaw = Math.round(delta / step);
      var resid = Math.abs(delta - sRaw * step);
      var s = ((sRaw % M) + M) % M;
      if (resid > 0.35 * step) out.push({ i: i, s: null, resid: resid });
      else out.push({ i: i, s: s, resid: resid });
    }
    return out;
  }

  /* Find symbol-boundary alignment. Two unknowns (a capture that starts mid-stream
     conflates them — the T8 lesson): the sub-symbol FRAME offset o ∈ [0, F), and the
     whole-symbol LAG λ (how many emission symbols were missed before capture).
     Correlate the known preamble (alternating s=1, s=M−1) at every (o, λ);
     decoded[i] is hypothesised to be emission symbol i+λ.
     Returns { offset, lag, score, max } or null. */
  function findAlignment(track, annulus, profile) {
    var F = annulus.rotation.frames_per_symbol, M = annulus.rotation.M;
    var P = profile.preamble_symbols;
    var best = null;
    // Base the search at the first frame the annulus was actually observed — a
    // capture that starts on the emitter's countdown freeze has a dead prefix,
    // and the emission (preamble first) begins where observation begins.
    var base = track.firstValid || 0;
    for (var off = base; off < base + F; off++) {
      var syms = decode(track, annulus, profile, off);
      // ≥4 preamble symbols must be visible — a 2-symbol window false-locks on
      // data (T11's lesson); shorter overlaps fall through to stream correlation.
      for (var lag = 0; lag <= P - 4; lag++) {
        var span = P - lag, score = 0;
        for (var i = 0; i < span && i < syms.length; i++) {
          var j = i + lag;
          var expect = (j % 2 === 0) ? 1 : M - 1;
          if (syms[i].s === expect) score++;
        }
        var need = Math.max(3, Math.ceil(0.75 * span));
        if (score >= need) {
          var cand = { offset: off, lag: lag, score: score, max: span };
          // Prefer more preamble evidence (smaller lag), then higher score.
          if (!best || lag < best.lag || (lag === best.lag && score > best.score)) best = cand;
        }
      }
    }
    return best;
  }

  /* Preamble-independent alignment: correlate decoded symbols against the KNOWN
     seeded stream at every whole-symbol lag (the data itself is the sync pattern —
     a capture that starts mid-loop missed the preamble but not the stream).
     Harness-legitimate: emitter and receiver share the profile's seeds. */
  function correlateStream(track, annulus, profile, maxLagSymbols) {
    var P2 = (typeof module !== "undefined" && module.exports) ? require("./prng.js") : global.OC.prng;
    var F = annulus.rotation.frames_per_symbol, M = annulus.rotation.M;
    var Pn = profile.preamble_symbols;
    var maxLag = Math.max(4, maxLagSymbols || 480);
    var stream = P2.symbolStream(annulus.rotation.seed, maxLag + 600, M);
    function ref(j) { return j < Pn ? ((j % 2 === 0) ? 1 : M - 1) : stream[j - Pn]; }
    var base = track.firstValid || 0;
    var best = null;
    for (var off = base; off < base + F; off++) {
      var syms = decode(track, annulus, profile, off);
      for (var lag = 0; lag <= maxLag; lag++) {
        var matches = 0, compared = 0;
        for (var i = 0; i < syms.length; i++) {
          if (syms[i].s === null) continue;
          compared++;
          if (syms[i].s === ref(i + lag)) matches++;
        }
        if (compared < 12) continue;
        var frac = matches / compared;
        if (frac < 0.75) continue;
        // Tie-break on compared count: a mis-framed offset can score a perfect
        // fraction over FEWER symbols (chord-rounding erases the hard ones) —
        // the true framing compares more symbols at the same fraction.
        if (!best || frac > best.matchFrac + 1e-9 ||
            (Math.abs(frac - best.matchFrac) < 1e-9 && matches > best.score))
          best = { offset: off, lag: lag, score: matches, max: compared, matchFrac: Math.round(frac * 1000) / 1000, method: "stream" };
      }
    }
    return best;
  }

  var API = { decode: decode, findAlignment: findAlignment, correlateStream: correlateStream, thetaData: thetaData, wrap: wrap };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.demap = API;
})(typeof window !== "undefined" ? window : globalThis);
