/* flicker.js — review finding F1 made executable.
   Local flicker at a fixed retinal point near an annulus boundary is k·f_rot,
   NOT f_rot: harmonic k alternates a fixed point k times per revolution. The
   modulation deviation adds k·(dφ/dt)_dev on top during symbol sweeps. This
   report computes the worst local flicker per annulus/harmonic and flags the
   3–60 Hz photosensitive band (peak sensitivity ~15–25 Hz). Numbers cited
   secondhand — spec §7.7 says check current WCAG / ITU-R BT.1702 text. */
(function (global) {
  "use strict";

  var BAND_LO = 3, BAND_HI = 60, PEAK_LO = 15, PEAK_HI = 25;

  function report(p) {
    var rows = [], worstBandHit = false, worstPeakHit = false;
    var fps = p.frame_rate_hz;
    for (var i = 0; i < p.annuli.length; i++) {
      var a = p.annuli[i];
      var symRate = fps / a.rotation.frames_per_symbol;
      // Worst deviation sweep rate: |Δθ| up to 180° over one symbol.
      var devHz = 0.5 * symRate; // (180°/360°) · symbols/sec = rev/sec equivalent
      for (var j = 0; j < a.boundary.harmonics.length; j++) {
        var k = a.boundary.harmonics[j];
        var fNominal = k * a.rotation.nominal_hz;
        var fWorst = k * (a.rotation.nominal_hz + devHz);
        var inBand = (fWorst >= BAND_LO && fNominal <= BAND_HI);
        var inPeak = (fWorst >= PEAK_LO && fNominal <= PEAK_HI);
        if (inBand) worstBandHit = true;
        if (inPeak) worstPeakHit = true;
        rows.push({ annulus: a.index, k: k, f_nominal_hz: round2(fNominal), f_worst_hz: round2(fWorst), in_band_3_60: inBand, in_peak_15_25: inPeak });
      }
    }
    // The beacon (2026-08-30): its rotating contour rides p.beacon, not
    // p.annuli, so this report never saw it — the a42x notes called the
    // k=5 in-band question unanalyzed for exactly that reason. Same
    // worst-case convention as the data rings; rows tag annulus "beacon".
    // v2 profiles carry no beacon and are unchanged.
    if (p.beacon && p.beacon.rotation && p.beacon.harmonics) {
      var b = p.beacon;
      var devB = 0.5 * (fps / b.rotation.frames_per_symbol);
      for (var jb = 0; jb < b.harmonics.length; jb++) {
        var kb = b.harmonics[jb];
        var fN = kb * b.rotation.nominal_hz;
        var fW = kb * (b.rotation.nominal_hz + devB);
        var inB = (fW >= BAND_LO && fN <= BAND_HI);
        var inP = (fW >= PEAK_LO && fN <= PEAK_HI);
        if (inB) worstBandHit = true;
        if (inP) worstPeakHit = true;
        rows.push({ annulus: "beacon", k: kb, f_nominal_hz: round2(fN), f_worst_hz: round2(fW), in_band_3_60: inB, in_peak_15_25: inP });
      }
    }
    var contrast = p.render.background - p.render.fill;
    return {
      rows: rows,
      contrast: round2(contrast),
      worstBandHit: worstBandHit,
      worstPeakHit: worstPeakHit,
      advice: advice(worstBandHit, worstPeakHit, contrast)
    };
  }

  function advice(band, peak, contrast) {
    var out = [];
    if (peak) out.push("Harmonic content reaches the 15–25 Hz peak-sensitivity band. Mitigated here by low contrast (" + contrast + ") and thin-band area; for projector/wall deployment REDUCE contrast further or lower nominal_hz — the area argument does not hold there.");
    else if (band) out.push("Harmonic content lands in the 3–60 Hz band (outside the 15–25 Hz peak). Keep contrast low; log this configuration's flicker row in every capture session.");
    else out.push("No harmonic reaches the 3–60 Hz band at these parameters.");
    out.push("Require explicit start; show the first-run warning; nobody needs to watch the emission for the link to work (spec §7.7).");
    return out;
  }

  function round2(x) { return Math.round(x * 100) / 100; }

  var API = { report: report, BAND: [BAND_LO, BAND_HI], PEAK: [PEAK_LO, PEAK_HI] };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.flicker = API;
})(typeof window !== "undefined" ? window : globalThis);
