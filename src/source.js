/* source.js — SOURCE UNIFICATION (the continuous receiver, phase C, part
   ii): live capture or a recording behind ONE interface, the first stage of
   the practitioner's pipeline (source → temporal scheduler → spatial slicer
   → processing). A source answers two questions — how much exists so far
   (`availS`), and give me the frames of a span (`window`) — and nothing
   above it knows which kind it is. A recording seeks (the whole clip
   exists at once); a synthetic recording renders lazily; a LIVE source is
   a ring buffer the camera fills in real time, so `availS` advances with
   the wall clock, `window` hands back what has arrived, and a span that
   does not exist yet is WAITED for (`waitFor`) rather than fetched — the
   scheduler answers WAIT with the frame count it needs, the driver waits
   here. The synthetic source can run LIVE too (frames become available on
   a wall clock at the emission rate): the same driver, the same scheduler,
   the same wait — the live path certified without a camera.

   Seeks remain the recording's receipt currency; a live window costs no
   seeks (it reports grabs instead). Frames carry LOCAL emission indices
   from the window's first emission frame (the pipeline sees each window
   like a capture that started there); the caller keeps fBase.

   No DOM here: the recording and live sources take the fetch/grab
   closures the harness owns; the ring buffer is plain arrays. */
(function (global) {
  "use strict";

  /* A recording: `fetchWindow(tA, tB, onStep)` is the harness's seek loop
     (video element + crop geometry live in that closure); returns
     { frames, seeks, fBase }. */
  function sourceRecording(durationS, fetchWindow) {
    return {
      kind: "recording", live: false, ended: true,
      duration: function () { return durationS; },
      availS: function () { return durationS; },
      window: function (tA, tB, onStep) { return fetchWindow(tA, tB, onStep); },
      waitFor: function () { return Promise.resolve(true); },
      end: function () {}
    };
  }

  /* A synthetic recording, rendered lazily; `live` gates availability on
     the wall clock at the emission rate (the live twin). `renderWindow(tA,
     tB, onStep)` is the harness's synth window loop. */
  function sourceSynth(durationS, renderWindow, opts) {
    opts = opts || {};
    var live = !!opts.live, t0 = null, ended = !live;
    var now = function () { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); };
    var availS = function () {
      if (!live) return durationS;
      if (t0 === null) t0 = now();
      var a = (now() - t0) / 1000 - (opts.latencyS !== undefined ? opts.latencyS : 0.2);
      if (a >= durationS) { ended = true; return durationS; }
      return Math.max(0, a);
    };
    return {
      kind: live ? "synth-live" : "synth", live: live,
      get ended() { return ended; },
      duration: function () { return durationS; },
      availS: availS,
      window: function (tA, tB, onStep) { return renderWindow(tA, Math.min(tB, availS()), onStep); },
      waitFor: function (tS) {
        if (!live) return Promise.resolve(true);
        return new Promise(function (resolve) {
          (function poll() {
            if (availS() >= tS || ended) resolve(availS() >= tS);
            else setTimeout(poll, opts.pollMs || 150);
          })();
        });
      },
      end: function () { ended = true; }
    };
  }

  /* The LIVE source: a ring buffer of camera frames. The harness's grab
     loop calls push({ t, img }) with t = the media time in seconds (the
     capture's own clock); frames older than retentionS fall off. window
     maps t → local emission index floor(t·emitFps) − fBase and keeps at most
     `looks` looks per emission frame (the duplicate defense: the camera
     runs faster than the emission). */
  function sourceLive(emitFps, opts) {
    opts = opts || {};
    var retentionS = opts.retentionS || 90, looks = opts.looks || 2;
    var buf = [], latest = 0, ended = false, grabs = 0;
    var prune = function () {
      var cut = latest - retentionS;
      var i = 0;
      while (i < buf.length && buf[i].t < cut) i++;
      if (i > 0) buf.splice(0, i);
    };
    return {
      kind: "live", live: true,
      get ended() { return ended; },
      duration: function () { return ended ? latest : Infinity; },
      availS: function () { return latest; },
      push: function (frame) {
        if (ended) return;
        buf.push(frame); grabs++;
        if (frame.t > latest) latest = frame.t;
        if (grabs % 60 === 0) prune();
      },
      buffered: function () { return buf.length; },
      window: function (tA, tB) {
        var fBase = Math.round(tA * emitFps), frames = [], perIdx = {};
        for (var i = 0; i < buf.length; i++) {
          var fr = buf[i];
          if (fr.t < tA || fr.t >= tB) continue;
          var idx = Math.floor(fr.t * emitFps) - fBase;
          if ((perIdx[idx] || 0) >= looks) continue;
          perIdx[idx] = (perIdx[idx] || 0) + 1;
          frames.push({ f: idx, img: fr.img });
        }
        return { frames: frames, seeks: 0, grabs: frames.length, fBase: fBase };
      },
      waitFor: function (tS) {
        return new Promise(function (resolve) {
          (function poll() {
            if (latest >= tS || ended) resolve(latest >= tS);
            else setTimeout(poll, opts.pollMs || 150);
          })();
        });
      },
      end: function () { ended = true; }
    };
  }

  var API = { sourceRecording: sourceRecording, sourceSynth: sourceSynth, sourceLive: sourceLive };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.source = API;
})(typeof window !== "undefined" ? window : globalThis);
