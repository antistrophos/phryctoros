/* schedule.js — the TEMPORAL SCHEDULER as its own stage (the continuous
   receiver, phase C; the practitioner's pipeline staging: source → temporal
   scheduler → spatial slicer → processing). Which spans to materialize, in
   what order, and when to stop — the bookkeeping that used to live inline
   in the harvest driver's window loop: the bootstrap, the ledger-steered
   plan (the seek economy, kept whole — the planner itself stays in
   harvest.planSpans and the driver hands it in as a callback), the
   unvisited sweep, adaptive growth of a lock-less window, hold-for-bank
   after the peel, the dead-clip guard, the cure worklist, and termination.
   Pure logic — no DOM, no video, no seeks: it names spans, the driver
   fetches them. Absolute emission frames throughout.

   Designed for LIVE as well as recorded sources: `availF` is how many
   frames exist so far (a recording's whole duration; a live ring buffer's
   high-water mark). When the next span would run past what exists, the
   scheduler answers WAIT with the frame count it needs rather than a span,
   and a live source's dead-air guard ends the run on time.

   Termination is un-quantized (the draft's §2): validated peel (early
   exit), coverage exhausted, dead clip, live dead-air, or a stop. */
(function (global) {
  "use strict";

  function HV() { return (typeof module !== "undefined" && module.exports) ? require("./harvest.js") : global.OC.harvest; }

  function schedCreate(cfg) {
    cfg = cfg || {};
    return {
      version: 1,
      cfg: {
        R: cfg.R || 30,
        minWinF: cfg.minWinF || 1, maxWinF: cfg.maxWinF || 0, joinGapF: cfg.joinGapF || 0,
        chunkF: cfg.chunkF || 300, overlapF: cfg.overlapF || 0, bootF: cfg.bootF || 300,
        holdCapS: cfg.holdCapS || null, holdCapWindows: cfg.holdCapWindows || 4,
        deadAirS: cfg.deadAirS || 30, cureCap: cfg.cureCap || 4, live: !!cfg.live
      },
      queue: cfg.carriedComplete ? [] : [{ f0: 0, f1: cfg.bootF || 300, kind: "boot" }],
      visited: [], grown: {},
      wrun: 0, everLocked: false, totalAdded: 0, lastLockF: -1,
      heldS: 0, heldWindows: 0, cures: 0,
      done: !!cfg.carriedComplete, exitReason: cfg.carriedComplete ? "carried" : null,
      events: []
    };
  }

  /* The next span to materialize. `plan(visited)` is the caller's
     ledger-steered planner ([f0, f1] or null); `availF` the frames that
     exist. Returns { f0, f1, kind } · { wait: true, needF } · null (nothing
     left — the caller then calls schedExhausted). */
  function schedNext(s, plan, availF) {
    if (s.done) return null;
    var c = s.cfg;
    if (s.queue.length) {
      var q = s.queue.shift();
      if (c.live && q.f1 > availF) {
        if (availF - q.f0 < c.minWinF) { s.queue.unshift(q); return { wait: true, needF: q.f0 + c.minWinF }; }
        q = { f0: q.f0, f1: availF, kind: q.kind, ep: q.ep };
      }
      return q;
    }
    var span = plan ? plan(s.visited) : null;
    var kind = "plan";
    if (!span) {
      span = HV().nextUnvisited(s.visited, 0, availF, c.chunkF, c.overlapF);
      kind = "sweep";
    }
    if (!span) return null;
    var f0 = span[0], f1 = Math.min(span[1], availF);
    if (f1 - f0 < Math.round(2 * c.R) && f1 - f0 < c.minWinF) {
      if (c.live) return { wait: true, needF: f0 + c.minWinF };
      return null;
    }
    return { f0: f0, f1: f1, kind: kind };
  }

  /* The provisional next span AFTER `current` is marked visited — what the
     driver may seek under the current decode (tier-1 overlap). Advisory:
     a post-decode divergence (growth, a hold, a plan change) just cancels
     the prefetch with its seeks counted honestly. */
  function schedPeek(s, plan, availF, current) {
    if (s.done || s.queue.length) return null;
    var vis = s.visited.map(function (sp) { return sp.slice(); });
    if (current) HV().markVisited(vis, current.f0, current.f1);
    var span = plan ? plan(vis) : null;
    if (!span) span = HV().nextUnvisited(vis, 0, availF, s.cfg.chunkF, s.cfg.overlapF);
    if (!span) return null;
    var f1 = Math.min(span[1], availF);
    if (f1 - span[0] < Math.round(2 * s.cfg.R)) return null;
    return { f0: span[0], f1: f1 };
  }

  /* What the window taught — decisions come back as flags.
     obs: { lockedAny, added, peelDone, bankLive, availF }. */
  function schedObserve(s, win, obs) {
    var c = s.cfg, out = {};
    s.wrun++;
    var lenS = (win.f1 - win.f0) / c.R;
    var availF = obs.availF !== undefined ? obs.availF : win.f1;
    // Adaptive growth (run-1's lock-failure lesson): a window that locks
    // NOTHING gets one doubled retry before its stretch is declared dead;
    // the failed window is NOT marked visited (the grown one marks both).
    // Cure windows are re-visits by construction and never grow.
    if (!obs.lockedAny && !obs.peelDone && !s.grown[win.f0] && win.f1 < availF && win.kind !== "cure" && win.kind !== "grow") {
      s.grown[win.f0] = 1;
      var g1 = Math.min(win.f0 + 2 * (win.f1 - win.f0), availF);
      s.queue.unshift({ f0: win.f0, f1: g1, kind: "grow" });
      s.events.push({ ev: "grow", w: s.wrun, f0: win.f0, f1: g1 });
      out.grew = true;
    } else {
      HV().markVisited(s.visited, win.f0, win.f1);
    }
    if (obs.lockedAny) { s.everLocked = true; s.lastLockF = win.f1; }
    s.totalAdded += obs.added || 0;
    if (win.kind === "cure") s.cures++;
    // Early exit — UNLESS a bank is mid-assembly and progressing (hold-for-
    // bank; identity is worth the extra windows), within the hold budget:
    // cycle-priced seconds when the lease is time-priced, else windows.
    if (obs.peelDone) {
      var budgetLeft = c.holdCapS ? s.heldS < c.holdCapS : s.heldWindows < c.holdCapWindows;
      if (obs.bankLive && budgetLeft) {
        s.heldS += lenS; s.heldWindows++;
        s.events.push({ ev: "hold", w: s.wrun, held_s: Math.round(s.heldS * 10) / 10 });
        out.hold = true;
      } else {
        s.done = true; s.exitReason = "early-exit"; out.exit = true;
      }
      return out;
    }
    // Dead-clip guard: nothing ever locked, nothing banked, four windows in.
    if (!s.everLocked && s.totalAdded === 0 && s.wrun >= 4) {
      s.done = true; s.exitReason = "dead-clip"; out.exit = true;
      return out;
    }
    // Live dead-air guard: locks stopped arriving for deadAirS.
    if (c.live && s.everLocked && s.lastLockF >= 0 && (availF - s.lastLockF) / c.R > c.deadAirS) {
      s.done = true; s.exitReason = "dead-air"; out.exit = true;
    }
    return out;
  }

  /* The cure worklist (rung 3): convicted epochs' spans, re-decoded under
     the track. Capped; each is a re-visit (never grows, never re-plans). */
  function schedCure(s, spans) {
    var n = 0;
    for (var i = 0; i < spans.length && s.cures + s.queue.length < s.cfg.cureCap; i++) {
      s.queue.push({ f0: spans[i].f0, f1: spans[i].f1, kind: "cure", ep: spans[i].ep });
      n++;
    }
    if (n) { s.done = false; s.exitReason = null; s.events.push({ ev: "cure-queued", spans: n }); }
    return n;
  }

  function schedExhausted(s) {
    if (!s.done) { s.done = true; s.exitReason = "exhausted"; }
    return s.exitReason;
  }

  function schedStop(s, reason) { s.done = true; s.exitReason = reason || "stopped"; }

  function schedSummary(s) {
    var vis = 0;
    for (var i = 0; i < s.visited.length; i++) vis += s.visited[i][1] - s.visited[i][0];
    return { windows: s.wrun, visited_s: Math.round(vis / s.cfg.R * 10) / 10, exit: s.exitReason,
             held_s: Math.round(s.heldS * 10) / 10, held_windows: s.heldWindows, cures: s.cures,
             grown: Object.keys(s.grown).length, live: s.cfg.live };
  }

  var API = { schedCreate: schedCreate, schedNext: schedNext, schedPeek: schedPeek, schedObserve: schedObserve,
              schedCure: schedCure, schedExhausted: schedExhausted, schedStop: schedStop, schedSummary: schedSummary };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.schedule = API;
})(typeof window !== "undefined" ? window : globalThis);
