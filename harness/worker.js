/* worker.js — the decode off the UI thread (the v3.1 obligation the first
   6-up field session forced: every decode stage was synchronous on the main
   thread, so the page froze for each window and painted only at boundaries).
   decodeSequence itself is untouched and stays synchronous — it just runs
   HERE. Frames arrive as transferred ArrayBuffers (zero-copy); results are
   plain JSON-safe objects (droplets travel as hex, buffers never return).
   The suite still calls the pipeline in-page; only receive.html routes
   through this file, with an in-thread fallback where workers can't load
   (the file:// standalone). */
importScripts(
  "../src/prng.js", "../src/dtrig.js", "../src/geom.js", "../src/flicker.js",
  "../src/profile.js", "../src/emission.js", "../src/register.js",
  "../src/plate.js", "../src/sample.js", "../src/conic.js",
  "../src/transform.js", "../src/separate.js", "../src/rowtime.js",
  "../src/demap.js", "../src/fountain.js", "../src/harvest.js",
  "../src/ser.js", "../src/degrade.js", "../src/pipeline.js"
);

onmessage = function (e) {
  var m = e.data;
  try {
    var frames = m.frames.map(function (fr) {
      return {
        f: fr.f,
        img: { w: fr.w, h: fr.h, norm: fr.norm,
               data: fr.u8 ? new Uint8Array(fr.buf) : new Float32Array(fr.buf) }
      };
    });
    var res = m.auto
      ? OC.pipeline.decodeV3Auto(frames, m.opts)
      : OC.pipeline.decodeSequence(frames, m.profile, m.opts);
    postMessage({ id: m.id, result: res });
  } catch (err) {
    postMessage({ id: m.id, error: String((err && err.stack) || err) });
  }
};
