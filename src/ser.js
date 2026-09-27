/* ser.js — stage-9 scoring for reference-mode streams: score decoded symbols
   against the known seeded reference and report SER/erasure-rate per layer (the
   Phase 0 measurement, still used by the v2 suite). Payload mode does not use
   it: fountain.js carries the droplets and the peel. */
(function (global) {
  "use strict";

  function P() { return (typeof module !== "undefined" && module.exports) ? require("./prng.js") : global.OC.prng; }

  /* decoded: [{i, s|null}] where i counts from the alignment offset; `lag` is the
     whole-symbol lag from findAlignment (decoded[i] ↔ emission symbol i+lag).
     Reference: preamble (P symbols) then seeded data stream. */
  function evaluate(decoded, annulus, profile, lag) {
    lag = lag || 0;
    var M = annulus.rotation.M, Pn = profile.preamble_symbols;
    var nData = Math.max(0, decoded.length + lag - Pn);
    var ref = P().symbolStream(annulus.rotation.seed, nData + 8, M);
    var errors = 0, compared = 0, erasures = 0, preambleMiss = 0;
    for (var idx = 0; idx < decoded.length; idx++) {
      var d = decoded[idx];
      var j = d.i + lag; // emission symbol index
      if (j < Pn) {
        var expect = (j % 2 === 0) ? 1 : M - 1;
        if (d.s !== null && d.s !== expect) preambleMiss++;
        continue;
      }
      var r = ref[j - Pn];
      if (d.s === null) { erasures++; continue; }
      compared++;
      if (d.s !== r) errors++;
    }
    var total = compared + erasures;
    return {
      ser: compared ? errors / compared : (total ? 1 : NaN),
      errors: errors, compared: compared,
      erasures: erasures, erasureRate: total ? erasures / total : 0,
      dataSymbols: total, preambleMiss: preambleMiss,
      ok: compared > 0 && (errors / compared) < 0.05
    };
  }

  var API = { evaluate: evaluate };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.ser = API;
})(typeof window !== "undefined" ? window : globalThis);
