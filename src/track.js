/* track.js — the continuous receiver's persistent registration/designation
   state (phase A of the continuous-receiver design, drafted 2026-09-01 on the
   range-take specimen). Window boundaries are load-bearing for I/O and
   incidental-but-harmful for STATE: this module is the state that survives
   them. One registration TRACK per emitter per clip — a new solve updates the
   track only on agreement; a divergent solve is recorded as a HYPOTHESIS,
   never silently adopted, never silently discarded. Designation accumulates
   evidence clip-wide. Every banked droplet carries a (burst, hypothesis)
   EPOCH id, and conviction excludes epochs from the trusted coalition —
   exclusion, never deletion, so every verdict is reversible and the machinery
   may act automatically.

   The specimen this is built against (field-20260901003751): windows w2/w3
   fell to a ⅓-scale registration (fid 40.6, ring-path fallback) amid a
   fid-122 saddle consensus and banked 127 CRC8-passing droplets of poison;
   recovery "completed" 115/115 invalid, and droplet-level elimination was
   structurally hopeless against 127. Three signals convict that hypothesis —
   scale discontinuity against the hardened consensus, method minority,
   support minority — and all three are judged ADAPTIVELY from the clip's own
   honest population, not from fixed magic numbers (floors exist only where
   quantization would otherwise divide by zero).

   Pure logic — no DOM, no video. The receive harness drives it per window;
   the suite drives it against synthetic solve streams and the committed
   specimen fixture. */
(function (global) {
  "use strict";

  /* Hypothesis identity is a SCALE CLASS: solves within ±~20% relative
     fiducial size continue one hypothesis (zoom drift and handheld range
     creep are continuous facts); a jump beyond it is a different claim about
     the pose and gets its own hypothesis. The specimen's jump is log(3.0). */
  var HYP_LOG_TOL = 0.18;
  /* Emitter identity is spatial: a solve belongs to a tracked emitter when
     its center falls within this fraction of the larger fiducial width
     (the lease's nearPlate tolerance, reused deliberately — one notion of
     "the same plate" across the receiver). Solves without centers (older
     logs replayed as fixtures) fall back to observation-index identity. */
  var EM_MATCH_FRAC = 0.75;
  /* A hypothesis HARDENS on multi-solve agreement — the continuity prior can
     adopt a first false solve, so nothing is trusted at one sighting. */
  var HARDEN_N = 2;
  /* The adaptive scale-break bar: deviation beyond 4× the honest population's
     own log-fid sigma. The floor keeps a pathologically tight population
     (the specimen's honest sigma is ~0.002 — sub-quantization) from
     convicting ordinary jitter: below ±16% is never a break. */
  var BREAK_SIGMA_MULT = 4, BREAK_LOG_FLOOR = 0.15, SIGMA_FLOOR = 0.02;
  /* Support minority: a challenger at or under half the dominant's support
     convicts on a scale break alone; method minority (the solver fell back to
     a different registration path) is independent suspicion that convicts a
     scale break regardless of support. */
  var SUPPORT_MINORITY = 0.5;
  var MAX_SAMPLES = 32;

  function trackCreate(opts) {
    opts = opts || {};
    return {
      version: 1,
      hardenN: opts.hardenN || HARDEN_N,
      emitters: [],   // { id, center, fid, hyps: [hyp], votes: {} } — votes[tile] = { hyp: n, … }
      nextHyp: 1,
      epochs: [],     // { ep, w, hyp, em, fid, method, f0, f1 } — the registry (self-description)
      convicted: {}   // hyp id → { em, reasons: [] } — recomputed by trackConvict
    };
  }

  function logFid(fid) { return Math.log(Math.max(fid, 1e-6)); }

  function matchEmitter(track, solve) {
    if (solve.center) {
      for (var i = 0; i < track.emitters.length; i++) {
        var em = track.emitters[i];
        if (!em.center) continue;
        var tol = EM_MATCH_FRAC * Math.max(solve.fid || 0, em.fid || 0, 1);
        var dx = solve.center[0] - em.center[0], dy = solve.center[1] - em.center[1];
        if (dx * dx + dy * dy <= tol * tol) return em;
      }
      return null;
    }
    // index identity (fixture replay: logs carry e but no center)
    for (var j = 0; j < track.emitters.length; j++)
      if (track.emitters[j].byIndex === solve.e) return track.emitters[j];
    return null;
  }

  function matchHyp(em, fid) {
    var best = null, bd = Infinity;
    for (var i = 0; i < em.hyps.length; i++) {
      var d = Math.abs(logFid(fid) - logFid(em.hyps[i].fid));
      if (d <= HYP_LOG_TOL && d < bd) { bd = d; best = em.hyps[i]; }
    }
    return best;
  }

  function topMethod(hyp) {
    var best = null, bn = -1;
    for (var m in hyp.methods) if (hyp.methods[m] > bn) { bn = hyp.methods[m]; best = m; }
    return best;
  }

  /* The adopted hypothesis: the hardened one with the most support (ties go
     to the earlier id — first past the harden bar keeps the seat). */
  function adoptedHyp(em, hardenN) {
    var best = null;
    for (var i = 0; i < em.hyps.length; i++) {
      var h = em.hyps[i];
      if (h.count < hardenN) continue;
      if (!best || h.count > best.count || (h.count === best.count && h.id < best.id)) best = h;
    }
    return best;
  }

  /* Designation majority under the CURRENT convictions: votes cast by a
     convicted hypothesis's windows are discounted (the ⅓-scale solve also
     "placed" its tiles, from sub-features at the wrong scale — solve trust
     flows down the stack into designation trust). Majority needs ≥2 votes
     and strictly more than the best rival — STICKY by design (the
     designation-stickiness point-gate, subsumed here): one contradicting
     window never topples an established majority, a tie is answered with NO
     majority rather than a guess, and a genuine mid-clip re-arrangement can
     still out-vote a stale majority eventually. */
  function majorityOf(track, em) {
    var tally = {}, tiles = [];
    for (var tile in em.votes) {
      var n = 0;
      for (var hid in em.votes[tile]) if (!track.convicted[hid]) n += em.votes[tile][hid];
      if (n > 0) { tally[tile] = n; tiles.push(tile); }
    }
    var best = null, bn = 0, rival = 0;
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i], v = tally[t];
      if (v > bn) { rival = bn; bn = v; best = t; }
      else if (v > rival) rival = v;
    }
    if (best !== null && bn >= 2 && bn > rival) return +best;
    return null;
  }

  /* One window's registration evidence, solve by solve.
     solves: [{ e, center, fid, method, tile, H }] — e is the observation
     index (emitter order in the decode result), tile the pipeline's derived
     designation (−1/undefined = unplaced), H the registration homography
     when the caller has one. Returns per-solve routing:
       { em, hyp, ep, isNew, divergent, tileOut, placed, unplaced }
     tileOut is the designation JUDGMENT: the majority fills an unplaced read
     (evidence accumulated clip-wide), a contradicting read is unplaced for
     this span rather than re-keying the ledger. opts: { f0, f1 } (the
     window's absolute frame span, recorded on the epoch registry). */
  function trackObserve(track, w, solves, opts) {
    opts = opts || {};
    var out = [], events = [];
    for (var i = 0; i < (solves || []).length; i++) {
      var s = solves[i];
      if (s == null || !(s.fid > 0)) { out.push(null); continue; }
      var em = matchEmitter(track, s);
      if (!em) {
        em = { id: track.emitters.length + 1, byIndex: s.center ? undefined : s.e,
               center: s.center || null, fid: s.fid, hyps: [], votes: {} };
        track.emitters.push(em);
      }
      var hyp = matchHyp(em, s.fid), isNew = false;
      if (!hyp) {
        hyp = { id: track.nextHyp++, fid: s.fid, count: 0, firstW: w, lastW: w,
                methods: {}, samples: [], droplets: 0 };
        em.hyps.push(hyp);
        isNew = true;
      }
      hyp.count++;
      hyp.lastW = w;
      hyp.fid = 0.7 * hyp.fid + 0.3 * s.fid;   // continuous drift rides the EMA; a jump forks
      hyp.methods[s.method || "?"] = (hyp.methods[s.method || "?"] || 0) + 1;
      hyp.samples.push({ w: w, fid: s.fid, method: s.method });
      if (hyp.samples.length > MAX_SAMPLES) hyp.samples.shift();
      if (s.H) hyp.lastH = s.H;
      if (s.center) { em.center = s.center; em.fid = 0.7 * em.fid + 0.3 * s.fid; }
      var adopted = adoptedHyp(em, track.hardenN);
      var divergent = !!(adopted && adopted !== hyp);
      if (isNew && adopted && divergent)
        events.push({ ev: "hyp-new", w: w, em: em.id, hyp: hyp.id, fid: s.fid, method: s.method,
                      against: adopted.id, againstFid: Math.round(adopted.fid * 10) / 10 });

      // ——— designation: judge against the PRIOR majority, then vote ———
      var maj = majorityOf(track, em);
      var tileIn = (s.tile !== undefined && s.tile !== null && s.tile >= 0) ? s.tile : -1;
      var tileOut = tileIn, placed = false, unplaced = false;
      if (maj !== null && tileIn >= 0 && tileIn !== maj) {
        tileOut = -1; unplaced = true;
        events.push({ ev: "desig-unplace", w: w, em: em.id, read: tileIn, majority: maj });
      } else if (maj !== null && tileIn < 0) {
        tileOut = maj; placed = true;
        events.push({ ev: "desig-place", w: w, em: em.id, majority: maj });
      }
      if (tileIn >= 0) {
        var slot = em.votes[tileIn] || (em.votes[tileIn] = {});
        slot[hyp.id] = (slot[hyp.id] || 0) + 1;
      }

      // ——— the epoch: this burst under this hypothesis ———
      var ep = "w" + w + "h" + hyp.id;
      var reg = null;
      for (var r = track.epochs.length - 1; r >= 0; r--)
        if (track.epochs[r].ep === ep) { reg = track.epochs[r]; break; }
      if (!reg) {
        reg = { ep: ep, w: w, hyp: hyp.id, em: em.id,
                fid: Math.round(s.fid * 10) / 10, method: s.method };
        if (opts.f0 !== undefined) { reg.f0 = opts.f0; reg.f1 = opts.f1; }
        track.epochs.push(reg);
      }
      out.push({ em: em.id, hyp: hyp.id, ep: ep, isNew: isNew, divergent: divergent,
                 tileOut: tileOut, placed: placed, unplaced: unplaced });
    }
    var conv = trackConvict(track);
    for (var e2 = 0; e2 < conv.events.length; e2++) events.push(conv.events[e2]);
    return { out: out, events: events };
  }

  /* Conviction, recomputed from the whole track (idempotent; events only on
     change). A hypothesis is convicted when it BREAKS SCALE against the
     hardened dominant — deviation beyond BREAK_SIGMA_MULT × the dominant's
     own log-fid sigma, floored — AND carries independent suspicion: support
     at or under half the dominant's, or a method minority (its solver path
     differs from the consensus path). No hardened dominant → nothing is
     trusted enough to convict anything. The dominant itself is never
     convicted here; if it is the liar, the coalition ladder's alternates get
     their turn when the trusted peel fails to validate. */
  function trackConvict(track) {
    var next = {}, events = [];
    for (var i = 0; i < track.emitters.length; i++) {
      var em = track.emitters[i];
      var dom = adoptedHyp(em, track.hardenN);
      if (!dom) continue;
      var mean = 0, n = dom.samples.length;
      for (var a = 0; a < n; a++) mean += logFid(dom.samples[a].fid);
      mean /= Math.max(n, 1);
      var varr = 0;
      for (var b = 0; b < n; b++) { var d = logFid(dom.samples[b].fid) - mean; varr += d * d; }
      var sigma = Math.max(Math.sqrt(varr / Math.max(n, 1)), SIGMA_FLOOR);
      var bar = Math.max(BREAK_SIGMA_MULT * sigma, BREAK_LOG_FLOOR);
      var domMethod = topMethod(dom);
      for (var h = 0; h < em.hyps.length; h++) {
        var hyp = em.hyps[h];
        if (hyp === dom) continue;
        var dev = Math.abs(logFid(hyp.fid) - logFid(dom.fid));
        if (dev <= bar) continue;
        var reasons = ["scale-break dev " + Math.round(dev * 100) / 100 + " > bar " + Math.round(bar * 100) / 100];
        var minority = hyp.count <= SUPPORT_MINORITY * dom.count;
        var methodOdd = topMethod(hyp) !== domMethod;
        if (minority) reasons.push("support " + hyp.count + "/" + dom.count);
        if (methodOdd) reasons.push("method " + topMethod(hyp) + " vs " + domMethod);
        if (!minority && !methodOdd) continue;   // a scale break alone is a zoom cut, not a lie
        next[hyp.id] = { em: em.id, reasons: reasons };
      }
    }
    for (var id in next) if (!track.convicted[id])
      events.push({ ev: "convict", hyp: +id, em: next[id].em, reasons: next[id].reasons });
    for (var old in track.convicted) if (!next[old])
      events.push({ ev: "unconvict", hyp: +old });
    track.convicted = next;
    return { convicted: next, events: events };
  }

  function epsForHyps(track, hypIds) {
    var want = {}, out = {};
    for (var i = 0; i < hypIds.length; i++) want[hypIds[i]] = true;
    for (var e = 0; e < track.epochs.length; e++)
      if (want[track.epochs[e].hyp]) out[track.epochs[e].ep] = true;
    return out;
  }

  function excludedEps(track) {
    var ids = [];
    for (var id in track.convicted) ids.push(+id);
    return epsForHyps(track, ids);
  }

  /* The ranked coalition ladder for the peel. null when nothing is convicted
     — the caller then takes the untouched legacy path, byte-identical to the
     pre-track receiver (trajectory parity on clean clips is a design
     property, not a hope). With convictions: trust the honest coalition
     first; the everything-view second (exclusion is reversible — a wrong
     conviction costs one retry, not data); then each convicted challenger
     gets its turn as the trusted one (if the dominant was the liar, its
     exclusion is the cure — same machinery, roles swapped). */
  function coalitionLadder(track) {
    var convictedIds = [];
    for (var id in track.convicted) convictedIds.push(+id);
    if (!convictedIds.length) return null;
    var ladder = [{ name: "trusted", excluded: excludedEps(track) }, { name: "all", excluded: {} }];
    for (var i = 0; i < convictedIds.length; i++) {
      var cid = convictedIds[i], emId = track.convicted[cid].em;
      var others = [];
      for (var e = 0; e < track.emitters.length; e++) {
        var em = track.emitters[e];
        if (em.id !== emId) continue;
        for (var h = 0; h < em.hyps.length; h++)
          if (em.hyps[h].id !== cid) others.push(em.hyps[h].id);
      }
      ladder.push({ name: "alt:h" + cid, excluded: epsForHyps(track, others) });
    }
    return ladder;
  }

  /* Pose priors for re-acquisition and the span re-decode (cure rung 3):
     every adopted hypothesis's last homography. Tripod truth: the consensus
     pose IS the registration; handheld: the per-frame solve chains from it
     and re-earns locally (the a82 lesson — priors seed, they never freeze). */
  function trackPoses(track) {
    var out = [];
    for (var i = 0; i < track.emitters.length; i++) {
      var dom = adoptedHyp(track.emitters[i], track.hardenN);
      if (dom && dom.lastH)
        out.push({ H: dom.lastH, fid: dom.fid, method: "prior", em: track.emitters[i].id });
    }
    return out;
  }

  /* Convicted epochs' spans (absolute frames) — the re-decode worklist.
     Only epochs that recorded a span qualify (fixture replays carry none). */
  function convictedSpans(track) {
    var ex = track.convicted, out = [];
    for (var e = 0; e < track.epochs.length; e++) {
      var r = track.epochs[e];
      if (ex[r.hyp] && r.f0 !== undefined) out.push({ ep: r.ep, w: r.w, f0: r.f0, f1: r.f1 });
    }
    // one span per window (both emitters' epochs share the burst)
    var seen = {}, uniq = [];
    for (var i = 0; i < out.length; i++)
      if (!seen[out[i].w]) { seen[out[i].w] = true; uniq.push(out[i]); }
    return uniq;
  }

  function trackSummary(track) {
    var ems = track.emitters.map(function (em) {
      var maj = majorityOf(track, em);
      return {
        id: em.id, majority: maj,
        hyps: em.hyps.map(function (h) {
          return { id: h.id, fid: Math.round(h.fid * 10) / 10, count: h.count,
                   method: topMethod(h), firstW: h.firstW, lastW: h.lastW,
                   convicted: track.convicted[h.id] ? track.convicted[h.id].reasons : undefined };
        })
      };
    });
    return { emitters: ems, epochs: track.epochs.length,
             convicted: Object.keys(track.convicted).map(Number) };
  }

  var API = {
    trackCreate: trackCreate, trackObserve: trackObserve, trackConvict: trackConvict,
    coalitionLadder: coalitionLadder, excludedEps: excludedEps, epsForHyps: epsForHyps,
    trackPoses: trackPoses, convictedSpans: convictedSpans, trackSummary: trackSummary,
    majorityOf: majorityOf, adoptedHyp: adoptedHyp
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.track = API;
})(typeof window !== "undefined" ? window : globalThis);
