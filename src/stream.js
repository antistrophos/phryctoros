/* stream.js — per-emitter BEACON STREAM accumulators (the continuous
   receiver, phase B). The beacon's alignment/framing state used to die at
   every window edge: an envelope cycle (13.3 s at M=4/F=2) longer than the
   window could never frame in one read, so the chunk BANK was invented to
   carry pieces across windows — and a 2-up's pre-bind bank MIXED both tiles'
   envelopes (they differ at the tile byte) and could never assemble a
   majority; hence the window-floor doctrine. Here the window's per-frame
   PHASE TRACK for the beacon ring is accumulated per EMITTER on the absolute
   emission-frame axis, and the SAME aligners (plate.beaconAlign, the chunk
   sweep) run over the accumulated track — an envelope frames wherever it
   completes, across any number of window seams. Window fit stops being a
   constraint; nothing mixes because the key is the emitter.

   Seams. Every window's phi is unwrapped from its own first frame, so two
   windows agree on the pattern angle only up to 2π·n at the frames they
   share; demap reads SLOPES, so a 2π·n step inside one symbol would corrupt
   exactly that symbol. Overlapping windows (the planner's back-pad) are
   STITCHED: the median phase difference over the shared frames rounds to a
   whole number of turns and the new window is shifted by it. A window that
   overlaps nothing gets its first two valid frames blanked instead — the
   straddling symbol reads as an honest erasure (gapIntersects' floor), never
   as a lie. Held frames win at overlaps (keep-first: deterministic, and the
   back-pad's frames are no better than the original's).

   The bound. The a82 lesson governs (windowed re-alignment beat one long
   alignment at M=8 — clock drift): the stream is a ROLLING span, long enough
   for any envelope to complete across one seam, short enough that drift
   cannot blur the aligner's single (offset, phase) hypothesis. Frames older
   than the span fall off; nothing else is ever deleted.

   Pure logic — no DOM, no video. The driver feeds it a beacon row's phi per
   window; the suite feeds it synthetic phase streams chopped into windows. */
(function (global) {
  "use strict";

  function PL() { return (typeof module !== "undefined" && module.exports) ? require("./plate.js") : global.OC.plate; }
  var TAU = 2 * Math.PI;

  function streamsCreate(opts) {
    opts = opts || {};
    return { version: 1, spanFrames: opts.spanFrames || 0, byEm: {} };
  }

  function countFinite(arr) {
    var n = 0;
    for (var i = 0; i < arr.length; i++) if (!isNaN(arr[i])) n++;
    return n;
  }

  /* One window's beacon phase track (local index 0.. = frame fBase..) into
     emitter emKey's stream. Returns the stitch receipt. */
  function streamAbsorb(streams, emKey, fBase, phi, meta) {
    meta = meta || {};
    var st = streams.byEm[emKey];
    if (!st) st = streams.byEm[emKey] = { f0: fBase, phi: [], meanMag: null, windows: 0, seams: 0, stitched: 0 };
    // a span earlier than anything held (a cure re-decode) extends the axis leftward
    if (fBase < st.f0) {
      var padN = st.f0 - fBase, pad = new Array(padN);
      for (var q = 0; q < padN; q++) pad[q] = NaN;
      st.phi = pad.concat(st.phi);
      st.f0 = fBase;
    }
    var rel0 = fBase - st.f0;
    while (st.phi.length < rel0 + phi.length) st.phi.push(NaN);
    // ——— stitch over the shared frames ———
    var diffs = [];
    for (var i = 0; i < phi.length; i++) {
      var v = phi[i];
      if (v === null || v === undefined || isNaN(v)) continue;
      var h = st.phi[rel0 + i];
      if (h === undefined || isNaN(h)) continue;
      diffs.push(v - h);
    }
    var turns = 0, stitched = false, seam = false, resid = null;
    if (diffs.length) {
      diffs.sort(function (a, b) { return a - b; });
      var med = diffs[diffs.length >> 1];
      turns = Math.round(med / TAU);
      resid = Math.round((med - turns * TAU) * 1000) / 1000;
      stitched = true; st.stitched++;
    } else if (st.windows > 0) {
      seam = true; st.seams++;
    }
    var offset = turns * TAU, added = 0, kept = 0, blanked = 0;
    for (var j = 0; j < phi.length; j++) {
      var vv = phi[j];
      if (vv === null || vv === undefined || isNaN(vv)) continue;
      if (seam && blanked < 2) { blanked++; continue; }   // the unstitched seam's erasure marker
      var idx = rel0 + j;
      if (!isNaN(st.phi[idx])) { kept++; continue; }        // keep-first
      st.phi[idx] = vv - offset;
      added++;
    }
    if (meta.meanMag) st.meanMag = meta.meanMag;
    st.windows++;
    // ——— the rolling span ———
    if (streams.spanFrames > 0 && st.phi.length > streams.spanFrames) {
      var cut = st.phi.length - streams.spanFrames;
      st.phi = st.phi.slice(cut);
      st.f0 += cut;
    }
    return { emKey: emKey, fBase: fBase, added: added, kept: kept, blanked: blanked,
             stitched: stitched, turns: turns, resid: resid, seam: seam,
             held: countFinite(st.phi), span: [st.f0, st.f0 + st.phi.length - 1] };
  }

  /* The accumulated stream in trackPhase's shape (relative frame index; the
     aligners only ever read slopes and gaps, so the axis origin is free). */
  function streamTrack(streams, emKey) {
    var st = streams.byEm[emKey];
    if (!st) return null;
    var n = st.phi.length;
    var phi = new Float64Array(n);
    var gapAfter = {}, firstValid = -1, lastValid = -1, frames = 0;
    for (var f = 0; f < n; f++) {
      var v = st.phi[f];
      phi[f] = (v === undefined || v === null) ? NaN : v;
      if (isNaN(phi[f])) continue;
      if (firstValid < 0) firstValid = f;
      if (lastValid >= 0 && f - lastValid > 1) gapAfter[lastValid] = f - lastValid;
      lastValid = f; frames++;
    }
    return { phi: phi, gapAfter: gapAfter, meanMag: st.meanMag || {}, frames: frames,
             maxF: n - 1, firstValid: firstValid < 0 ? 0 : firstValid, f0: st.f0 };
  }

  /* Read the stream: the full beacon read (seal / tag / chunks) over the
     accumulated track. null until the stream holds enough frames to say
     anything. opts.expectTag rides through to the aligner (tag confirmation
     between seals — the lease's heartbeat). */
  function streamRead(streams, emKey, annulus, profile, opts) {
    var track = streamTrack(streams, emKey);
    if (!track || track.frames < 8) return null;
    var read = PL().beaconRead(track, annulus, profile, opts);
    read.held = track.frames;
    read.span = [track.f0, track.f0 + track.maxF];
    read.windows = streams.byEm[emKey].windows;
    read.seams = streams.byEm[emKey].seams;
    return read;
  }

  function streamsSummary(streams) {
    var out = {};
    for (var k in streams.byEm) {
      var st = streams.byEm[k];
      out[k] = { held: countFinite(st.phi), windows: st.windows, stitched: st.stitched, seams: st.seams,
                 span: [st.f0, st.f0 + st.phi.length - 1] };
    }
    return out;
  }

  var API = { streamsCreate: streamsCreate, streamAbsorb: streamAbsorb, streamTrack: streamTrack,
              streamRead: streamRead, streamsSummary: streamsSummary };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.stream = API;
})(typeof window !== "undefined" ? window : globalThis);
