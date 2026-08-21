/* render-worker.js — one core's share of a video export.

   The analytic renderer is pure (profile + frame index → pixels), so frames
   fan out across cores with no coordination beyond ordering at the encoder.
   Each worker REBUILDS the schedules from the profile and payload bytes
   rather than receiving them: the fountain and schedule builders are
   deterministic in their seeds, so every worker derives byte-identical
   carousels, beacon schedule, envelope, and QR modules — nothing that
   matters travels over postMessage except numbers the main thread already
   holds. Replies carry RGBA (the encoder's input) so the conversion cost
   leaves the main thread too; the buffer transfers zero-copy. */
importScripts(
  "../src/prng.js", "../src/dtrig.js", "../src/geom.js", "../src/flicker.js",
  "../src/profile.js", "../src/emission.js", "../src/fountain.js"
);

var P = null;      // profile
var S = null;      // { schedules, schedulesT, beaconSchedule, envBytes, qrModules, effLoopFrames }

function setup(m) {
  P = m.profile;
  var payloadBytes = m.payloadBytes ? new Uint8Array(m.payloadBytes) : null;
  var layout = OC.emission.tileLayout(P);
  var carousels = payloadBytes ? OC.fountain.encodeCarousels(P, payloadBytes).carousels : null;
  var envBytes = OC.emission.envelopeBytes(P, m.envInfo || null);
  var schedulesT = null;
  if (layout.n > 1) {
    schedulesT = [];
    for (var t = 0; t < layout.n; t++) {
      var carT = payloadBytes ? OC.fountain.encodeCarousels(P, payloadBytes, { tile: t }).carousels : carousels;
      schedulesT.push(OC.emission.buildSchedules(P, m.effLoopFrames, carT));
    }
  }
  S = {
    schedules: OC.emission.buildSchedules(P, m.effLoopFrames, carousels),
    schedulesT: schedulesT,
    beaconSchedule: OC.emission.buildBeaconSchedule(P, m.effLoopFrames, envBytes),
    envBytes: envBytes,
    qrModules: OC.emission.envelopeModules(P.qr, envBytes),
    effLoopFrames: m.effLoopFrames
  };
}

onmessage = function (e) {
  var m = e.data;
  try {
    if (m.cmd === "setup") { setup(m); postMessage({ ok: true, setup: true }); return; }
    var tl = OC.emission.timeline(P, m.f);
    var eff = tl.eff % S.effLoopFrames;
    var img = OC.emission.renderFrame(P, eff, {
      schedules: S.schedules, schedulesT: S.schedulesT, beaconSchedule: S.beaconSchedule,
      envBytes: S.envBytes, countdown: !!tl.freeze, qrModules: S.qrModules, fast: true
    });
    var n = img.w * img.h, src = img.data;
    var rgba = new Uint8ClampedArray(n * 4);
    for (var i = 0; i < n; i++) {
      var g = src[i]; g = g < 0 ? 0 : (g > 1 ? 1 : g);
      var q = Math.round(g * 255), o = i * 4;
      rgba[o] = q; rgba[o + 1] = q; rgba[o + 2] = q; rgba[o + 3] = 255;
    }
    postMessage({ ok: true, f: m.f, w: img.w, h: img.h, rgba: rgba.buffer }, [rgba.buffer]);
  } catch (err) {
    postMessage({ ok: false, f: m.f, error: String((err && err.stack) || err) });
  }
};
