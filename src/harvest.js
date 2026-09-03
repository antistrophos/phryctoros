/* harvest.js — the harvest decoder's bookkeeping: the droplet LEDGER, the
   slot↔time LOCKS, and the hop PLANNER (practitioner's design, 2026-08-15:
   droplet-aware bootstrap-then-hop — "skip the seeks for what you hold, stop
   when the peel completes"). SEEKING dominates decode wall-clock (~7,000
   browser video seeks per full pass at 60 fps stepping; the DSP is cheap
   beside it), so droplet-awareness deletes seeks: a held droplet's span is
   ~96 seeks that never happen. This module is the pure logic — no DOM, no
   video. The receive harness drives it against a clip; the suite drives it
   against synthetic decodes.

   The ledger retains RAW BYTES ALWAYS (a lesson bought twice) and is JSON
   round-trippable so it travels BETWEEN clips: the two-fresh-takes filming
   pattern becomes decoder-exploited — clip 2 is mined only for what clip 1
   lacked. Locks are NOT in the ledger: an alignment is a fact about one
   clip's time axis; droplets are facts about the session. */
(function (global) {
  "use strict";

  function F() { return (typeof module !== "undefined" && module.exports) ? require("./fountain.js") : global.OC.fountain; }
  function PL() { return (typeof module !== "undefined" && module.exports) ? require("./plate.js") : global.OC.plate; }

  function bytesToHex(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i++) s += (u8[i] < 16 ? "0" : "") + u8[i].toString(16);
    return s;
  }
  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length >> 1);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  /* ---------- the ledger ---------- */

  function createLedger(profile, session) {
    return {
      version: 1,
      profile_version: profile.profile_version,
      droplet_bits: F().geom(profile).dropletBits,
      tiling: profile.tiling || 1, // tile-keyed rings: rings[tileSeed(seed, t)] (absent on old ledgers = 1)
      session: session || null,
      header: null,               // { K, len, hex } once any header droplet lands
      rings: {},                  // rings[seed][c] = hex — witnessed droplets only; seed is the TILE seed
      clips: []                   // provenance: { name, windows: [[t0,t1],…] } per clip harvested
    };
  }

  function serializeLedger(ledger) { return JSON.stringify(ledger); }

  function parseLedger(text) {
    var l = JSON.parse(text);
    if (l.version !== 1 || !l.rings) throw new Error("not a harvest ledger (version " + l.version + ")");
    return l;
  }

  function counts(ledger) {
    var rings = 0, droplets = 0;
    for (var seed in ledger.rings) {
      rings++;
      for (var c in ledger.rings[seed]) droplets++; // eslint-disable-line no-unused-vars
    }
    return { rings: rings, droplets: droplets, header: !!ledger.header };
  }

  /* Feed one window's decodeSequence result (payload mode) into the ledger.
     Every CRC-passed droplet enters under its ring's TILE seed
     (fountain.tileSeed(seed, tile) — tile 0 / untiled is the base seed, so
     1-up ledgers are byte-identical to before); duplicates are free (the
     same wire bytes recur every carousel period and across clips — the
     dedupe key is (tile ring, c); session identity is the operator's ledger
     choice pre-v3). Tiles carry the SAME blocks under DIFFERENT subsets, so
     a tile-blind key would bank tile 3's slot c as tile 0's and poison the
     peel — the 6-up harvest failure. An emitter whose tile could not be
     placed (tile −1) is skipped: its seed cannot be named, so its droplets
     cannot be banked honestly (the pipeline's own pool skips it the same
     way). The header is banked once: header BYTES are identical at every
     header slot of every ring and tile (they depend only on K + payload), so
     one sighting holds them all — the planner prices every header slot as
     held from that moment. A droplet_bits mismatch refuses the absorb
     rather than silently mixing framings.

     EPOCHS (the continuous receiver, phase A): `ep` — the caller's (burst,
     hypothesis) id — is recorded per banked droplet in a SIDE TABLE
     (ledger.eps[seed][c]), never in the ring itself, so every v2 store and
     every epoch-blind reader stays byte-compatible: absent = one epoch,
     trusted forever. Conflicts and cross-epoch duplicate sightings are
     RETAINED as witnesses (ledger.alts[seed][c] = [{x, ep}]) — first-seen
     still wins the ring, but exclusion can later re-project the slot from a
     non-excluded witness: the first-seen-poison-blocks-forever disease dies
     here. Exclusion is a VIEW (ringsFor), never a deletion. */
  function absorb(ledger, res, profile, ep) {
    var g = F().geom(profile);
    if (ledger.droplet_bits !== g.dropletBits)
      return { added: 0, dup: 0, conflicts: 0, quarantined: 0, mismatch: true };
    var added = 0, dup = 0, conflicts = 0, quarantined = 0, consensus = null, unplaced = 0;
    if (!res || res.error || !res.emitters)
      return { added: 0, dup: 0, conflicts: 0, quarantined: 0, lagConsensus: null };
    for (var e = 0; e < res.emitters.length; e++) {
      var annuli = res.emitters[e].annuli || [];
      var tile = res.emitters[e].tile;
      if (tile === -1) {
        for (var ui = 0; ui < annuli.length; ui++) if (annuli[ui] && annuli[ui].droplets) unplaced += annuli[ui].droplets.length;
        continue;
      }
      var tileIdx = tile > 0 ? tile : 0;
      // Lag consensus, IN FRAMES. Every ring shares the emission clock and the
      // capture start, so within a window every locked ring must agree about
      // WHEN the window began — but lag counts that ring's own SYMBOLS, and a
      // ring's symbol index at emission frame f is floor(f / frames_per_symbol).
      // So the ring-independent quantity is lag × F (the window's start frame);
      // comparing raw lags is only valid while every ring runs the same F.
      // Normalising here is what makes per-ring frames_per_symbol safe to vary.
      // Tolerance scales with the coarsest ring involved, since a ring with
      // larger F pins the start frame only to within F frames.
      // A lone disagreeing ring is a chance CRC double-pass wearing a lock —
      // transient before the ledger (a 1/256 residual per decode), but
      // PERSISTENT now: its droplets would enter as first-seen poison and
      // block the real bytes forever. With ≥2 rings in agreement the outlier
      // is quarantined: nothing banked, no lock taken (callers gate on
      // lagConsensus, which is reported in FRAMES).
      var fpsOf = function (idx) {
        var pz = annulusByIndex(profile, idx);
        return (pz && pz.rotation.frames_per_symbol) || 4;
      };
      var lagsF = [];
      for (var li = 0; li < annuli.length; li++) {
        var al = annuli[li];
        if (al && al.alignLag != null && al.droplets && al.droplets.length)
          lagsF.push({ f: al.alignLag * fpsOf(al.annulus), F: fpsOf(al.annulus) });
      }
      if (lagsF.length >= 2) {
        var bestN = 0;
        for (var bi = 0; bi < lagsF.length; bi++) {
          var n = 0;
          for (var bj = 0; bj < lagsF.length; bj++) {
            var tol = Math.max(lagsF[bi].F, lagsF[bj].F);
            if (Math.abs(lagsF[bj].f - lagsF[bi].f) <= tol) n++;
          }
          if (n > bestN || (n === bestN && (consensus === null || lagsF[bi].f < consensus))) { bestN = n; consensus = lagsF[bi].f; }
        }
        if (bestN < 2) consensus = null; // no two rings agree — judge nothing
      }
      for (var ai = 0; ai < annuli.length; ai++) {
        var a = annuli[ai];
        if (!a || !a.droplets || !a.droplets.length) continue;
        if (consensus !== null && a.alignLag != null) {
          var Fa = fpsOf(a.annulus);
          if (Math.abs(a.alignLag * Fa - consensus) > Fa) {
            quarantined += a.droplets.length;
            continue;
          }
        }
        var pa = annulusByIndex(profile, a.annulus);
        if (!pa) continue;
        var seed = F().tileSeed(pa.rotation.seed, tileIdx);
        var ring = ledger.rings[seed] || (ledger.rings[seed] = {});
        for (var d = 0; d < a.droplets.length; d++) {
          var dr = a.droplets[d]; // { c, hex }
          if (ring[dr.c] !== undefined) {
            if (ring[dr.c] !== dr.hex) conflicts++; // same slot, different bytes — surfaced, never silent
            dup++;
            // Witness retention: a conflicting read, or the SAME bytes seen
            // under a DIFFERENT epoch, is evidence a later exclusion can
            // re-project from. Capped — a slot at war is already surfaced
            // through the conflict count, and four witnesses decide it.
            var bankedEp = ledger.eps && ledger.eps[seed] && ledger.eps[seed][dr.c];
            if (ring[dr.c] !== dr.hex || (ep != null && ep !== bankedEp)) {
              var alts = ledger.alts || (ledger.alts = {});
              var aSlot = (alts[seed] || (alts[seed] = {}))[dr.c] || (alts[seed][dr.c] = []);
              var have = false;
              for (var wq = 0; wq < aSlot.length; wq++)
                if (aSlot[wq].x === dr.hex && aSlot[wq].ep === ep) { have = true; break; }
              if (!have && aSlot.length < 4) aSlot.push(ep != null ? { x: dr.hex, ep: ep } : { x: dr.hex });
            }
            continue;
          }
          ring[dr.c] = dr.hex;
          added++;
          if (ep != null) {
            var eps = ledger.eps || (ledger.eps = {});
            (eps[seed] || (eps[seed] = {}))[dr.c] = ep;
          }
          if (!ledger.header && F().isHeaderSlot(dr.c)) {
            var h = F().parseHeader(hexToBytes(dr.hex), g);
            if (h) ledger.header = { K: h.K, len: h.len, hex: dr.hex };
          }
        }
      }
    }
    return { added: added, dup: dup, conflicts: conflicts, quarantined: quarantined, unplaced: unplaced, lagConsensus: consensus };
  }

  /* The ledger in fountain.assemble's shape — the peel never knows whether a
     droplet arrived this window, last window, from another clip's take, or
     from another TILE: every held tile-ring goes in (tile-distinct seeds make
     the pool collision-free, exactly as the pipeline's own multi-tile peel),
     so a 6-up harvest peels across tiles the way a 6-up window does.

     opts.excluded (the coalition view): a slot whose banked epoch is excluded
     re-projects from its first NON-excluded witness in the alts table —
     droplets a convicted epoch banked first stop blocking honest bytes — and
     drops entirely when no trusted witness exists. Un-attributed droplets
     (no epoch recorded — every pre-epoch store) are trusted always. */
  function ringsFor(ledger, profile, opts) {
    var excluded = opts && opts.excluded;
    var out = [];
    for (var seedKey in ledger.rings) {
      var held = ledger.rings[seedKey];
      var eps = excluded && ledger.eps && ledger.eps[seedKey];
      var alts = excluded && ledger.alts && ledger.alts[seedKey];
      var droplets = [];
      for (var c in held) {
        var hex = held[c];
        if (excluded && eps && eps[c] != null && excluded[eps[c]]) {
          hex = null;
          var aSlot = alts && alts[c];
          for (var w = 0; aSlot && w < aSlot.length; w++)
            if (!(aSlot[w].ep != null && excluded[aSlot[w].ep])) { hex = aSlot[w].x; break; }
        }
        if (hex != null) droplets.push({ c: +c, bytes: hexToBytes(hex) });
      }
      out.push({ seed: +seedKey, droplets: droplets });
    }
    // Stable order: the profile's base rings first (tile 0), then the rest
    // ascending — the peel is order-independent, the receipt is not.
    var baseSeeds = profile.annuli.map(function (a) { return a.rotation.seed; });
    out.sort(function (x, y) {
      var bx = baseSeeds.indexOf(x.seed), by = baseSeeds.indexOf(y.seed);
      if (bx >= 0 && by >= 0) return bx - by;
      if (bx >= 0) return -1;
      if (by >= 0) return 1;
      return x.seed - y.seed;
    });
    return out;
  }

  /* Tile seeds that have banked anything for a given base ring — the tiles
     the harvest has actually SEEN (a tile never in frame never enters the
     union, so the planner never waits on what cannot be received). */
  function seenTileSeeds(ledger, baseSeed) {
    var tiles = ledger.tiling || 1, out = [];
    for (var t = 0; t < tiles; t++) {
      var s = F().tileSeed(baseSeed, t);
      if (ledger.rings[s]) out.push(s);
    }
    return out;
  }

  /* EARLY EXIT's question, asked after every window: is the payload in hand?
     (field34 decoded 64 s; the payload may have been in hand by 40.) */
  function tryPeel(ledger, profile) {
    return F().assemble(ringsFor(ledger, profile), profile);
  }

  function annulusByIndex(profile, index) {
    for (var i = 0; i < profile.annuli.length; i++)
      if (profile.annuli[i].index === index) return profile.annuli[i];
    return null;
  }

  /* ---------- THE LEASE (D-ring lease build, 2026-08-23) ----------

     Two identities, split the way the identity principle says to:

     CONTENT-ADDRESSED LEDGERS. Droplets are a pure function of config +
     payload — session32 never enters the fountain — so the ledger keys by
     the content fingerprint the envelope carries: (droplet_bits, K, len,
     pcrc16). Two emitters, two sessions, or two clips carrying the same
     content pool into ONE ledger (the choir's redundancy falling out of the
     keying); a restart re-stamps the session and changes nothing here. A
     16-bit pcrc collision is caught where every wrong-rule case is caught:
     the peel's own validation.

     TAG-ADDRESSED LEASES. A context = one announced identity, keyed by THE
     TAG (the envelope's CRC16 seal — the ASID). Not by session32: a
     same-session content switch changes the tag and must split. The context
     holds trust and continuity — state, plates, grace — and points at the
     content ledger it feeds.

     The hold matrix (practitioner's ruling, 2026-08-23):
       bound    — tag detecting (sealed envelope, or a tag chunk confirming
                  the KNOWN tag). Data-ring flapping is forgiven
                  indefinitely; droplets bank direct whenever a lock holds.
                  The edge-of-detection emitter stays bound and accumulates.
       coasting — tag lost, data held. Tenuous by design: the FIRST
                  zero-lock window ends the hold (framing cannot see a
                  content switch, so the binding must not coast far).
       grace    — nothing locks. Banking has already stopped (no locks, no
                  droplets, no risk); the context survives graceWindows
                  windows so an occlusion or focus hunt is not a cold start.
                  Resumption inside grace routes through a PROVISIONAL
                  ledger and is adopted when the next seal/confirmation
                  matches the tag — nothing enters a content ledger
                  un-attributed, ever.
       clipped  — grace expired. Any later appearance is a fresh bind.

     PROVISIONAL ledgers (the degrade rung's bottom): plates with data locks
     but no announced identity bank into per-plate spatial ledgers (nearest-
     centre matching within a clip, never exported). Adoption is peel-time
     UNION, validate-gated: a completed-but-invalid peel retries without the
     provisionals and reports them rejected — the auto-fallback pattern.

     Locks stay OUT of the store (an alignment is a fact about one clip's
     time axis); the driver keys them per context. */

  function contentKeyOf(fields, dropletBits) {
    return dropletBits + ":" + fields.K + ":" + fields.len + ":" + (fields.pcrc >>> 0).toString(16);
  }

  function createStore(profile) {
    return {
      version: 2,
      profile_version: profile.profile_version,
      droplet_bits: F().geom(profile).dropletBits,
      tiling: profile.tiling || 1,
      ledgers: {},    // contentKey → ledger (createLedger shape) + .fields (envelope copy)
      contexts: {},   // tag (hex string) → context
      clips: []
    };
  }

  function serializeStore(store) {
    // provisionals are clip-scoped and never travel
    return JSON.stringify(store, function (k, v) { return k === "provisionals" ? undefined : v; });
  }

  function parseStore(text) {
    var s = JSON.parse(text);
    if (s.version !== 2 || !s.ledgers || !s.contexts)
      throw new Error("not a v2 harvest store (version " + s.version + ") — v1 ledgers predate the lease and do not import");
    return s;
  }

  function storeCounts(store) {
    var ledgers = 0, droplets = 0, contexts = 0;
    for (var k in store.ledgers) { ledgers++; var c = counts(store.ledgers[k]); droplets += c.droplets; }
    for (var t in store.contexts) contexts++; // eslint-disable-line no-unused-vars
    return { ledgers: ledgers, droplets: droplets, contexts: contexts };
  }

  /* A ledger shell inside a store — same shape createLedger builds, without
     needing a profile (the store already fixed droplet_bits and tiling). */
  function bareLedger(store) {
    return { version: 1, profile_version: store.profile_version, droplet_bits: store.droplet_bits,
             tiling: store.tiling, session: null, header: null, rings: {}, clips: [] };
  }

  /* THE ENVELOPE CYCLE in seconds — the beacon's own clock, config-aware:
     one full envelope copy on the air. Chunked framing carries 5 × (4-byte
     tag chunk + 6-byte data chunk) = 50 bytes per rotor block; the v0 frame
     framing 23 bytes per frame. symbols = bytes·8/bitsPer(M), frames =
     symbols·F, seconds = frames/fps — 13.3 s for the A-inner M=4/F=2 family
     at 30 fps. null without a beacon (v2), and callers keep counting
     windows. The lease's time-pricing UNIT (the mini-ruling, 2026-09-01):
     beacon-priced rules count cycles, data-priced rules plain seconds. */
  function envelopeCycleSeconds(profile) {
    var b = profile && profile.beacon;
    if (!b || !b.rotation || !b.rotation.M) return null;
    var M = b.rotation.M, F = b.rotation.frames_per_symbol || 1;
    var bitsPer = M === 8 ? 3 : (M === 4 ? 2 : 1);
    var bytes = b.framing === "chunked" ? 50 : 23;
    return Math.round(10 * (bytes * 8 / bitsPer) * F / (profile.frame_rate_hz || 30)) / 10;
  }

  function leaseCreate(opts) {
    opts = opts || {};
    return {
      graceWindows: opts.graceWindows !== undefined ? opts.graceWindows : 2,
      // TIME-PRICING (the lease mini-ruling, ruled as defaults 2026-09-01;
      // phase C): with the envelope cycle known, grace runs 2 CYCLES and a
      // coasting hold ends only when a zero-lock stretch reaches
      // coastEndSeconds (8 s, data-priced) — the hold matrix's semantics are
      // unchanged, only the units move from windows to time. Callers pass
      // each window's span (opts.span, seconds) to leaseObserve; without a
      // cycle (or a span) the window counting stands byte-for-byte.
      cycleSeconds: opts.cycleSeconds || null,
      graceSeconds: opts.cycleSeconds ? 2 * opts.cycleSeconds : null,
      coastEndSeconds: opts.cycleSeconds ? (opts.coastEndSeconds || 8) : null,
      matchFidFrac: opts.matchFidFrac !== undefined ? opts.matchFidFrac : 0.75,
      // The degrade ladder's TOP rung: with no announced context live, the
      // operator's own declaration (the profile they selected) is the
      // identity — the primary emitter (and every tile of a declared
      // lattice) banks into the "operator" ledger exactly as the pre-lease
      // harvest did. The first SEAL adopts that ledger into the announced
      // content ledger: in operator mode there is one emission by
      // declaration, and the seal came from the very plate the operator
      // pointed at.
      operatorKey: opts.operator ? "operator" : null,
      provisionals: {},   // pid → { center, fid, ledger, lastSeen, forTag, adopted, rejected }
      nextProv: 1
    };
  }

  /* First-seen-wins ring merge (conflicts surfaced, headers carried; epoch
     attribution and retained witnesses ride along — an operator-merge or an
     adoption must not launder a droplet's provenance). */
  function mergeLedger(dst, src) {
    var moved = 0, conflicts = 0;
    var altPush = function (seed, c, x, ep) {
      var alts = dst.alts || (dst.alts = {});
      var slot = (alts[seed] || (alts[seed] = {}))[c] || (alts[seed][c] = []);
      for (var i = 0; i < slot.length; i++) if (slot[i].x === x && slot[i].ep === ep) return;
      if (slot.length < 4) slot.push(ep != null ? { x: x, ep: ep } : { x: x });
    };
    for (var seed in src.rings) {
      var d = dst.rings[seed] || (dst.rings[seed] = {});
      for (var c in src.rings[seed]) {
        var sEp = src.eps && src.eps[seed] && src.eps[seed][c];
        if (d[c] === undefined) {
          d[c] = src.rings[seed][c]; moved++;
          if (sEp != null) {
            var eps = dst.eps || (dst.eps = {});
            (eps[seed] || (eps[seed] = {}))[c] = sEp;
          }
        } else {
          if (d[c] !== src.rings[seed][c]) conflicts++;
          var dEp = dst.eps && dst.eps[seed] && dst.eps[seed][c];
          if (d[c] !== src.rings[seed][c] || (sEp != null && sEp !== dEp))
            altPush(seed, c, src.rings[seed][c], sEp);
        }
      }
      if (src.alts && src.alts[seed])
        for (var c2 in src.alts[seed])
          for (var a2 = 0; a2 < src.alts[seed][c2].length; a2++)
            altPush(seed, c2, src.alts[seed][c2][a2].x, src.alts[seed][c2][a2].ep);
    }
    if (!dst.header && src.header) dst.header = src.header;
    return { moved: moved, conflicts: conflicts };
  }

  /* A new clip is a clip (the ruling's sense): plates, locks and holds are
     facts about one clip's time axis. Contexts survive as IDENTITY MEMORY —
     the same tag re-binding on its first seal is exactly the cross-clip
     resumption the lease exists to make safe — but nothing banks to them
     until that seal. */
  function leaseNewClip(store) {
    for (var t in store.contexts) {
      var ctx = store.contexts[t];
      ctx.plates = [];
      ctx.state = "clipped";
    }
  }

  function nearPlate(center, fid, cand, frac) {
    if (!center || !cand.center) return false;
    var tol = frac * Math.max(fid || 0, cand.fid || 0, 1);
    var dx = center[0] - cand.center[0], dy = center[1] - cand.center[1];
    return dx * dx + dy * dy <= tol * tol;
  }

  /* One window's decode result → the store, through the lease. Returns the
     window's events (the receipt stream) and which content ledgers banked.
     `w` = the window ordinal (grace accounting). Pure over (store, lease).
     opts (the continuous receiver, phase A): { eps, excluded } — eps[i] is
     emitter i's (burst, hypothesis) epoch id, recorded on every droplet and
     chunk sighting this window banks; excluded is the CURRENT conviction
     view, consulted only where evidence is aggregated (the chunk-bank
     majority) — banking itself never filters, because exclusion is a peel-
     time view and a reversed conviction must find the droplets still there. */
  function leaseObserve(store, lease, res, profile, w, opts) {
    var events = [], bankedKeys = {};
    var emitters = (!res || res.error || !res.emitters) ? [] : res.emitters;
    // time-priced when the lease carries a cycle AND this window carries its span
    var spanS = (opts && opts.span && opts.span.length === 2) ? Math.max(0, opts.span[1] - opts.span[0]) : null;
    var timed = !!(lease.graceSeconds && spanS !== null);
    var graceInit = timed ? lease.graceSeconds : lease.graceWindows;

    // ——— classify each emitter ———
    var obs = emitters.map(function (em, ei) {
      var beacon = null, dataLocked = false;
      for (var i = 0; i < (em.annuli || []).length; i++) {
        var a = em.annuli[i];
        if (!a) continue;
        if (a.beacon) beacon = a;
        else if (a.alignLag != null) dataLocked = true;
      }
      var fields = beacon && beacon.envelopeFields;
      // the pipeline's tag field (the seal, hex) is authoritative; the seal
      // bytes at the envelope hex's tail are the derivation fallback
      var sealedTag = fields ? (beacon.tag ||
        (beacon.envelope && beacon.envelope.length === 40 ? beacon.envelope.slice(36, 40) : null)) : null;
      var confirmedTag = (!fields && beacon && beacon.tagConfirmed && beacon.tag) ? beacon.tag : null;
      return { em: em, index: ei, beacon: beacon, fields: fields || null, sealedTag: sealedTag,
               confirmedTag: confirmedTag, dataLocked: dataLocked,
               center: em.center || null, fid: em.fiducialWidthPx || 0 };
    });

    // ——— route seals: create/refresh contexts ———
    var routeSeal = function (o) {
      var tag = o.sealedTag;
      var ctx = store.contexts[tag];
      if (!ctx) {
        ctx = store.contexts[tag] = {
          tag: tag, session32: o.fields.session32, fields: o.fields,
          contentKey: contentKeyOf(o.fields, store.droplet_bits),
          state: "bound", graceLeft: graceInit,
          plates: [], boundAt: w, lastSeen: w
        };
        if (!store.ledgers[ctx.contentKey]) {
          store.ledgers[ctx.contentKey] = bareLedger(store);
          store.ledgers[ctx.contentKey].fields = o.fields;
          events.push({ ev: "ledger", key: ctx.contentKey });
        }
        events.push({ ev: "bind", tag: tag, session: o.fields.session32, key: ctx.contentKey, index: o.index });
        // The operator ledger predates this seal: by declaration it is this
        // very emission, so its droplets adopt into the announced content
        // ledger (first-seen kept, conflicts surfaced — and the peel's own
        // validation stands behind the merge as everywhere else).
        if (lease.operatorKey && store.ledgers[lease.operatorKey] &&
            counts(store.ledgers[lease.operatorKey]).droplets > 0) {
          var mg = mergeLedger(store.ledgers[ctx.contentKey], store.ledgers[lease.operatorKey]);
          delete store.ledgers[lease.operatorKey];
          events.push({ ev: "operator-merge", tag: tag, key: ctx.contentKey,
                        moved: mg.moved, conflicts: mg.conflicts });
        }
      } else if (ctx.state === "clipped") {
        ctx.state = "grace"; // the matrix below re-binds on this window's tag
        events.push({ ev: "rebind", tag: tag });
      }
      // plate bookkeeping (announced tile; centre track)
      var plate = null;
      for (var p = 0; p < ctx.plates.length; p++)
        if (nearPlate(o.center, o.fid, ctx.plates[p], lease.matchFidFrac)) { plate = ctx.plates[p]; break; }
      if (!plate) { plate = { }; ctx.plates.push(plate); }
      plate.center = o.center; plate.fid = o.fid;
      plate.tile = o.fields.tile; plate.lastSeen = w;
      o.ctx = ctx; o.viaSeal = true;
      // a provisional track at this plate is claimed by the seal
      for (var pid in lease.provisionals) {
        var pr = lease.provisionals[pid];
        if (!pr.adopted && !pr.rejected && nearPlate(o.center, o.fid, pr, lease.matchFidFrac)) {
          pr.adopted = true; pr.forTag = tag;
          events.push({ ev: "adopt", tag: tag, provisional: pid, droplets: counts(pr.ledger).droplets });
        }
      }
    };
    obs.forEach(function (o) { if (o.fields && o.sealedTag) routeSeal(o); });

    // ——— route unsealed emitters: context plates first, else provisional ———
    // (an emitter carrying only a chunk SWEEP — beacon evidence without a
    // data lock — still routes, so its chunks can bank)
    obs.forEach(function (o) {
      if (o.ctx || (!o.dataLocked && !(o.beacon && o.beacon.chunkSweep))) return;
      var tags = Object.keys(store.contexts);
      for (var t = 0; t < tags.length; t++) {
        var ctx = store.contexts[tags[t]];
        if (ctx.state === "clipped") continue;
        for (var p = 0; p < ctx.plates.length; p++) {
          if (nearPlate(o.center, o.fid, ctx.plates[p], lease.matchFidFrac)) {
            if (o.confirmedTag && o.confirmedTag !== ctx.tag) break; // confirmed a DIFFERENT tag — not this context
            if (ctx.state === "grace" && !o.confirmedTag) break;      // grace: no direct banking without the tag
            o.ctx = ctx; o.plate = ctx.plates[p];
            ctx.plates[p].center = o.center; ctx.plates[p].fid = o.fid; ctx.plates[p].lastSeen = w;
            return;
          }
        }
      }
      // A DECLARED-LATTICE MEMBER follows its designated tile's context: the
      // derived tile index is anchored at the breaker plate — the very plate
      // that sealed — so at breaker placement (where only tile 0 carries a
      // beacon) the other tiles are the sealed session's tiles by the
      // operator's own lattice declaration. Only unambiguous when exactly ONE
      // live tiled context exists; otherwise fall through to provisional.
      if (o.em.tile !== undefined && o.em.tile >= 0) {
        var tiledTag = null, tiledN = 0;
        for (var tl2 in store.contexts) {
          var cL = store.contexts[tl2];
          if (cL.state !== "clipped" && cL.fields && cL.fields.tiling > 1) { tiledTag = tl2; tiledN++; }
        }
        if (tiledN === 1 && (!o.confirmedTag || o.confirmedTag === tiledTag)) {
          var ctxL = store.contexts[tiledTag];
          // grace still demands the tag before direct banking, members included
          if (ctxL.state !== "grace" || o.confirmedTag === tiledTag) {
            var plateL = null;
            for (var pl2 = 0; pl2 < ctxL.plates.length; pl2++)
              if (nearPlate(o.center, o.fid, ctxL.plates[pl2], lease.matchFidFrac)) { plateL = ctxL.plates[pl2]; break; }
            if (!plateL) { plateL = {}; ctxL.plates.push(plateL); }
            plateL.center = o.center; plateL.fid = o.fid; plateL.tile = o.em.tile; plateL.lastSeen = w;
            o.ctx = ctxL; o.plate = plateL;
            return;
          }
        }
      }
      // no announced context claims it → the operator rung, when it applies:
      // no live announced context, and this is the primary emitter or a tile
      // of the operator's declared lattice
      if (lease.operatorKey) {
        var live = false;
        for (var lt in store.contexts) if (store.contexts[lt].state !== "clipped") { live = true; break; }
        if (!live && (o.index === 0 || store.tiling > 1)) { o.operator = true; return; }
      }
      // otherwise provisional (create or extend by proximity)
      var provId = null;
      for (var pid in lease.provisionals) {
        var pr = lease.provisionals[pid];
        if (!pr.adopted && !pr.rejected && nearPlate(o.center, o.fid, pr, lease.matchFidFrac)) { provId = pid; break; }
      }
      if (!provId) {
        provId = "p" + lease.nextProv++;
        lease.provisionals[provId] = { center: o.center, fid: o.fid, ledger: bareLedger(store),
          lastSeen: w, adopted: false, rejected: false };
        events.push({ ev: "provisional", id: provId, center: o.center });
      }
      var prv = lease.provisionals[provId];
      prv.center = o.center; prv.fid = o.fid; prv.lastSeen = w;
      o.prov = prv; o.provId = provId;
    });

    // ——— the chunk bank: control-plane droplets across windows ———
    // A window shorter than the envelope cycle still carries CHUNKS; they
    // bank on the routed target (context plate / provisional / the operator
    // rung) with per-(idx, bytes) sighting counts, and when the majority set
    // assembles under the CRC16 seal that IS a seal — the context binds
    // exactly as if one window had read the whole envelope. Junk chunks from
    // a wrong-alignment sweep cost one sighting, never the seal.
    var assembleBank = function (bank, bankEps) {
      var excluded = opts && opts.excluded;
      var env = new Uint8Array(20);
      for (var ix = 1; ix <= 5; ix++) {
        var slot = bank["" + ix];
        if (!slot) return null;
        var epsSlot = excluded && bankEps && bankEps["" + ix];
        var bestHex = null, bestN = 0, tie = false;
        for (var hx in slot) {
          var n = slot[hx];
          // sightings attributed to a convicted epoch drop out of the
          // majority; un-attributed sightings stay trusted (absent = one
          // honest epoch — the pre-epoch contract)
          if (epsSlot && epsSlot[hx])
            for (var xe in epsSlot[hx]) if (excluded[xe]) n -= epsSlot[hx][xe];
          if (n <= 0) continue;
          if (n > bestN) { bestN = n; bestHex = hx; tie = false; }
          else if (n === bestN) tie = true;
        }
        if (!bestHex || tie) return null;
        for (var bj = 0; bj < 4; bj++) env[4 * (ix - 1) + bj] = parseInt(bestHex.substr(2 * bj, 2), 16);
      }
      if (((env[18] << 8) | env[19]) !== F().crc16(env.subarray(0, 18))) return null;
      return env;
    };
    obs.forEach(function (o) {
      var sw = o.beacon && o.beacon.chunkSweep;
      if (!sw) return;
      var bank = null, bankEps = null, opKey = "operator";
      var epO = opts && opts.eps ? opts.eps[o.index] : null;
      if (o.ctx && o.plate) { bank = o.plate.chunkBank || (o.plate.chunkBank = {}); bankEps = o.plate.chunkBankEps || (o.plate.chunkBankEps = {}); }
      else if (o.prov) { bank = o.prov.chunkBank || (o.prov.chunkBank = {}); bankEps = o.prov.chunkBankEps || (o.prov.chunkBankEps = {}); }
      else if (o.operator) {
        // PER-EMITTER operator banks (the continuous receiver, phase B): with
        // the registration track naming each emitter (opts.emIds[i]), the
        // pre-bind rung banks each emitter's chunks under its OWN key — a
        // 2-up's two envelopes (differing at the tile byte) never pool into
        // one majority again: the mixed-bank limitation and the window-floor
        // doctrine it forced both dissolve here. Without emIds the single
        // legacy bank stands, byte-for-byte.
        if (opts && opts.emIds && opts.emIds[o.index] != null) {
          opKey = "operator:" + opts.emIds[o.index];
          var banks = lease.operatorBanks || (lease.operatorBanks = {});
          var banksE = lease.operatorBanksEps || (lease.operatorBanksEps = {});
          bank = banks[opKey] || (banks[opKey] = {});
          bankEps = banksE[opKey] || (banksE[opKey] = {});
        } else {
          bank = lease.operatorBank || (lease.operatorBank = {});
          bankEps = lease.operatorBankEps || (lease.operatorBankEps = {});
        }
      }
      else return;
      var newIdx = 0;
      for (var ix2 in sw) {
        var slot2 = bank[ix2] || (bank[ix2] = {});
        if (!slot2[sw[ix2]]) newIdx++;
        slot2[sw[ix2]] = (slot2[sw[ix2]] || 0) + 1;
        if (epO != null) {
          var eSlot = bankEps[ix2] || (bankEps[ix2] = {});
          var eHex = eSlot[sw[ix2]] || (eSlot[sw[ix2]] = {});
          eHex[epO] = (eHex[epO] || 0) + 1;
        }
      }
      var targetLabel = o.ctx ? o.ctx.tag : (o.provId || opKey);
      events.push({ ev: "chunk-bank", chunks: Object.keys(sw).length, fresh: newIdx,
                    have: Object.keys(bank).length, target: targetLabel, index: o.index });
      if (o.fields) return;                       // a real seal already routed this window
      var env2 = assembleBank(bank, bankEps);
      if (env2) {
        var fields2 = PL().parseEnvelope(env2);
        if (fields2) {
          o.fields = fields2;
          o.sealedTag = ("0000" + (((env2[18] << 8) | env2[19]) >>> 0).toString(16)).slice(-4);
          routeSeal(o);                            // binds/rebinds; operator-merge + adoption ride along
          events.push({ ev: "bank-seal", tag: o.sealedTag, session: fields2.session32, target: targetLabel, index: o.index });
        }
      }
    });

    // ——— bank ———
    obs.forEach(function (o) {
      var target = null, tileForBank;
      if (o.ctx) {
        // announced tile when the plate carries one; derived as fallback;
        // disagreement quarantines the emitter for this window.
        var announced = o.plate && o.plate.tile !== undefined ? o.plate.tile
                       : (o.fields ? o.fields.tile : undefined);
        var derived = o.em.tile;
        if (announced !== undefined && derived !== undefined && derived >= 0 && announced !== derived) {
          events.push({ ev: "tile-disagree", tag: o.ctx.tag, announced: announced, derived: derived });
          return;
        }
        tileForBank = announced !== undefined ? announced : derived;
        target = store.ledgers[o.ctx.contentKey];
      } else if (o.operator) {
        tileForBank = o.em.tile;
        target = store.ledgers[lease.operatorKey] || (store.ledgers[lease.operatorKey] = bareLedger(store));
      } else if (o.prov) {
        tileForBank = o.em.tile;
        target = o.prov.ledger;
      }
      if (!target) return;
      var emB = tileForBank === o.em.tile ? o.em : Object.assign({}, o.em, { tile: tileForBank });
      var got = absorb(target, { emitters: [emB] }, profile,
        opts && opts.eps ? opts.eps[o.index] : undefined);
      if (got.added || got.dup || got.conflicts || got.quarantined) {
        events.push({ ev: "bank", tag: o.ctx ? o.ctx.tag : null,
                      operator: o.operator || undefined, provisional: o.provId || null,
                      added: got.added, dup: got.dup, conflicts: got.conflicts, quarantined: got.quarantined });
        if (o.ctx && got.added) bankedKeys[o.ctx.contentKey] = true;
        if (o.operator && got.added) bankedKeys[lease.operatorKey] = true;
      }
      o.lagConsensus = got.lagConsensus;
    });

    // ——— the hold matrix, per context ———
    for (var tg in store.contexts) {
      var ctx = store.contexts[tg];
      if (ctx.state === "clipped") continue;
      var sawTag = false, sawData = false;
      obs.forEach(function (o) {
        if (o.ctx !== ctx) return;
        if (o.viaSeal || (o.confirmedTag && o.confirmedTag === ctx.tag)) sawTag = true;
        if (o.dataLocked) sawData = true;
      });
      var was = ctx.state;
      if (sawTag) { ctx.state = "bound"; ctx.graceLeft = graceInit; ctx.zeroLockS = 0; ctx.lastSeen = w; }
      else if (sawData) {
        if (ctx.state !== "grace") ctx.state = "coasting";   // grace needs the tag to resume — handled in routing
        ctx.zeroLockS = 0;
        ctx.lastSeen = w;
      } else {
        if (ctx.state === "grace") {
          ctx.graceLeft -= timed ? spanS : 1;
          if (ctx.graceLeft <= 0) { ctx.state = "clipped"; events.push({ ev: "clip", tag: ctx.tag }); }
        } else if (timed && ctx.state === "coasting" &&
                   (ctx.zeroLockS = (ctx.zeroLockS || 0) + spanS) < lease.coastEndSeconds) {
          // time-priced coasting: a short zero-lock stretch does not end the
          // hold — only a stretch reaching coastEndSeconds does (framing
          // cannot see a content switch, so the binding still must not coast far)
          events.push({ ev: "coast-hold", tag: ctx.tag, zero_lock_s: Math.round(ctx.zeroLockS * 10) / 10 });
        } else {
          ctx.state = "grace"; ctx.graceLeft = graceInit; ctx.zeroLockS = 0;
          events.push({ ev: was === "coasting" ? "hold-end" : "all-lost", tag: ctx.tag });
        }
      }
      if (was !== ctx.state)
        events.push({ ev: "state", tag: ctx.tag, from: was, to: ctx.state });
    }

    return { events: events, banked: Object.keys(bankedKeys), obs: obs };
  }

  /* Peel a content ledger with its adopted provisionals UNIONED in,
     validate-gated: a completed-but-invalid union retries bare, and if the
     bare peel is no worse the provisionals are marked rejected (the poison
     was theirs). Ranking mirrors the subsetFor fallback: validated >
     honestly-incomplete > completed-but-invalid. `dry` skips the rejected-
     marking side effect — coalition attempts probe without leaving verdicts;
     only the winning view's pass is allowed to judge provisionals. */
  function peelView(store, lease, contentKey, profile, aOpts, excluded, dry) {
    var ledger = store.ledgers[contentKey];
    var exView = excluded ? { excluded: excluded } : undefined;
    var base = ringsFor(ledger, profile, exView);
    var adoptedIds = [];
    for (var pid in lease.provisionals) {
      var pr = lease.provisionals[pid];
      if (pr.adopted && !pr.rejected && store.contexts[pr.forTag] &&
          store.contexts[pr.forTag].contentKey === contentKey) adoptedIds.push(pid);
    }
    // assembleEliminating (hardening layer 1): a completed-but-invalid peel
    // runs the liar elimination before surrendering — leave-one-out with the
    // validation ladder as the oracle, suspect-set pairs/triples behind it.
    if (!adoptedIds.length) return F().assembleEliminating(base, profile, aOpts);
    var bySeed = {};
    base.forEach(function (r) { bySeed[r.seed] = { seed: r.seed, droplets: r.droplets.slice(), have: {} };
      r.droplets.forEach(function (d) { bySeed[r.seed].have[d.c] = true; }); });
    adoptedIds.forEach(function (pid) {
      ringsFor(lease.provisionals[pid].ledger, profile, exView).forEach(function (r) {
        var slot = bySeed[r.seed] || (bySeed[r.seed] = { seed: r.seed, droplets: [], have: {} });
        r.droplets.forEach(function (d) { if (!slot.have[d.c]) { slot.have[d.c] = true; slot.droplets.push(d); } });
      });
    });
    var union = [];
    for (var s in bySeed) union.push({ seed: bySeed[s].seed, droplets: bySeed[s].droplets });
    var withProv = F().assemble(union, profile, aOpts);
    if (withProv.ok === true || withProv.recovered == null || withProv.recovered !== withProv.K) return withProv;
    // completed but did not validate — the union is suspect; try bare
    // (with the liar elimination behind it: a liar in the BASE ledger is a
    // different disease than a bad provisional, and both walls should hold)
    var bare = F().assembleEliminating(base, profile, aOpts);
    if (bare.ok === true || (bare.recovered != null && bare.recovered !== bare.K)) {
      if (!dry) {
        adoptedIds.forEach(function (pid) { lease.provisionals[pid].rejected = true; });
      }
      bare.provisionalsRejected = adoptedIds.length;
      return bare;
    }
    return withProv;
  }

  /* opts.coalitions (the continuous receiver, phase A): a RANKED list of
     views [{ name, excluded }] from the registration track's conviction —
     trusted first, everything second, each convicted challenger's alternate
     last. The peel trusts the top coalition; a failed validation retries
     down the ranking (retention: exclusion is reversible, so retrying costs
     an assemble, never data). Attempts run DRY; the winner re-runs live so
     provisional verdicts land under the winning view only. No coalitions →
     the pre-track path, byte-identical. */
  function tryPeelStore(store, lease, contentKey, profile, opts) {
    var ledger = store.ledgers[contentKey];
    if (!ledger) return { ok: false, reason: "no such ledger" };
    // A content key carries its own 16-bit fingerprint (bits:K:len:pcrc16 —
    // the envelope's pcrc, which a 48-bit header cannot: 5 data bytes hold
    // only the high byte). Passing it down arms the peel's full-strength
    // validation; the "operator" pseudo-key has none and rides the header's
    // 8-bit check. The a42g specimen (two chance-passed CRC8 droplets
    // printing a corrupted payload as valid) is the case this closes.
    // The key's len rides along too: 24-bit droplets hold 2 data bytes, so
    // their headers carry neither len nor pcrc — the envelope (through the
    // key) is the only source of BOTH the exact wire length and the full
    // fingerprint. This closes the validation gap for the 24-bit mode as
    // well, not just the 48-bit high byte.
    var kp = /^\d+:\d+:(\d+):([0-9a-f]+)$/.exec(contentKey);
    var aOpts = kp ? { expectLen: +kp[1], expectPcrc16: parseInt(kp[2], 16) } : undefined;
    var coalitions = opts && opts.coalitions;
    if (!coalitions || !coalitions.length)
      return peelView(store, lease, contentKey, profile, aOpts, null, false);
    var rankOf = function (r) {
      if (r.ok === true && r.validatedBy) return 3;
      if (r.ok === true) return 2;
      if (r.recovered != null && r.K && r.recovered < r.K) return 1;
      return 0;
    };
    var best = null, bestRank = -1, bestC = null, tried = 0;
    for (var i = 0; i < coalitions.length; i++) {
      var c = coalitions[i];
      var r = peelView(store, lease, contentKey, profile, aOpts, c.excluded, true);
      tried++;
      var rk = rankOf(r);
      if (rk > bestRank) { bestRank = rk; best = r; bestC = c; }
      if (rk === 3) break;   // validated — the ladder stops here
    }
    var live = peelView(store, lease, contentKey, profile, aOpts, bestC && bestC.excluded, false);
    live.coalition = bestC ? bestC.name : undefined;
    var exKeys = bestC ? Object.keys(bestC.excluded || {}) : [];
    if (exKeys.length) live.excludedEps = exKeys;
    live.coalitionsTried = tried;
    return live;
  }

  /* ---------- locks: the capture-time→carousel-slot mapping ---------- */

  /* A lock binds one ring's carousel to the clip's absolute emission-frame
     axis: emission symbol j sits at absolute frame
         frameOfSymbol(j) = fBase + offset + (j − lag)·F
     (fBase = the window's first absolute frame; offset/lag from that
     window's own alignment). Extrapolated forward it prices every future
     slot's span. It can be WRONG past an emitter loop restart — priced in:
     a window planned on a stale lock fails its narrow realign, the full CRC
     scan re-locks it, and planning continues on the fresh lock. A wrong
     prediction costs a wasted window, never wrong data — CRC gates the
     ledger. */
  function lockFrom(a, annulus, profile, fBase) {
    if (!a || a.alignOffset == null || a.alignLag == null) return null;
    var g = F().geom(profile);
    return {
      annulus: a.annulus, seed: annulus.rotation.seed,
      F: annulus.rotation.frames_per_symbol, D: F().ringD(annulus, g),
      Pn: profile.preamble_symbols,
      fBase: fBase, offset: a.alignOffset, lag: a.alignLag
    };
  }

  function frameOfSymbol(lock, j) { return lock.fBase + lock.offset + (j - lock.lag) * lock.F; }
  function symbolAtFrame(lock, f) { return (f - lock.fBase - lock.offset) / lock.F + lock.lag; }
  function slotSpan(lock, c) {
    var j0 = lock.Pn + c * lock.D;
    return [frameOfSymbol(lock, j0), frameOfSymbol(lock, j0 + lock.D)];
  }
  function slotAtFrame(lock, f) {
    return Math.floor((symbolAtFrame(lock, f) - lock.Pn) / lock.D);
  }

  /* One max-droplet span in EMISSION frames — the overlap unit (field36
     run-1's edge-truncation lesson): the longest time any single droplet
     occupies on any ring. A window boundary truncates every droplet that
     straddles it, and a truncated droplet can never pass CRC — so follow-on
     windows must start this many frames early to make every slot lie FULLY
     inside some window. */
  function maxDropletFrames(profile) {
    var g = F().geom(profile), m = 0;
    for (var i = 0; i < profile.annuli.length; i++) {
      var a = profile.annuli[i];
      var span = F().ringD(a, g) * a.rotation.frames_per_symbol;
      if (span > m) m = span;
    }
    return m;
  }

  /* Predicted-lag band for a window starting at absolute frame fBase — the
     crcAlign hint that turns a hop window's full carousel scan into a narrow
     confirmation. Band ±24 symbols covers rounding + mild emitter drift. */
  function predictLag(lock, fBase, band) {
    var b = band || 24;
    var pred = Math.round(symbolAtFrame(lock, fBase));
    if (pred + b < 0) return null;
    return { min: Math.max(0, pred - b), max: pred + b, pred: pred };
  }

  /* ---------- interval bookkeeping (absolute emission frames) ---------- */

  function mergeSpans(spans) {
    if (!spans.length) return [];
    var s = spans.slice().sort(function (a, b) { return a[0] - b[0]; });
    var out = [s[0].slice()];
    for (var i = 1; i < s.length; i++) {
      var last = out[out.length - 1];
      if (s[i][0] <= last[1]) { if (s[i][1] > last[1]) last[1] = s[i][1]; }
      else out.push(s[i].slice());
    }
    return out;
  }

  function subtractSpans(spans, cut) {
    var out = spans;
    for (var i = 0; i < cut.length; i++) {
      var next = [];
      for (var j = 0; j < out.length; j++) {
        var a = out[j][0], b = out[j][1], c0 = cut[i][0], c1 = cut[i][1];
        if (c1 <= a || c0 >= b) { next.push([a, b]); continue; }
        if (c0 > a) next.push([a, c0]);
        if (c1 < b) next.push([c1, b]);
      }
      out = next;
    }
    return out;
  }

  /* Visited is a fact whatever the window yielded — a barren window is
     marked, not retried. In-place insert-merge. */
  function markVisited(visited, f0, f1) {
    visited.push([f0, f1]);
    var merged = mergeSpans(visited);
    visited.length = 0;
    for (var i = 0; i < merged.length; i++) visited.push(merged[i]);
  }

  /* ---------- the hop planner ---------- */

  /* Spans worth seeking in [f0,f1]: wherever ANY locked ring holds an
     UNKNOWN slot. Held slots price at zero; header slots price at zero once
     the header is banked; never-locking rings contribute nothing (they drop
     out of the union — a later lock brings their unknowns in: the
     revisit-on-later-lock). Visited is subtracted whatever it yielded.
     Raw spans are then clustered into WORK WINDOWS of at least minFrames
     (~8–10 s), because below that a window cannot confirm its own CRC
     alignment — each window self-aligns; the padding spends a few held
     seeks to keep every window self-sufficient. */
  function planSpans(ledger, locks, f0, f1, opts) {
    opts = opts || {};
    var minF = opts.minFrames || 1, joinGap = opts.joinGap || 0;
    var spans = [];
    for (var li = 0; li < locks.length; li++) {
      var lock = locks[li];
      if (!lock) continue;
      // Tiles share the clock, so slot c is simultaneous on every tile's
      // ring; it is HELD only when every tile seen so far holds it (one
      // tile's gap is still worth the seek). Untiled: the base seed alone.
      var tileRings = seenTileSeeds(ledger, lock.seed).map(function (s) { return ledger.rings[s]; });
      var heldAll = function (c) {
        if (!tileRings.length) return false;
        for (var ti = 0; ti < tileRings.length; ti++) if (tileRings[ti][c] === undefined) return false;
        return true;
      };
      var cA = Math.max(0, slotAtFrame(lock, f0));
      var cB = slotAtFrame(lock, f1);
      for (var c = cA; c <= cB; c++) {
        if (heldAll(c)) continue;
        if (ledger.header && F().isHeaderSlot(c)) continue;
        var s = slotSpan(lock, c);
        var a = Math.max(f0, s[0]), b = Math.min(f1, s[1]);
        if (b > a) spans.push([a, b]);
      }
    }
    spans = mergeSpans(spans);
    if (opts.visited && opts.visited.length) spans = subtractSpans(spans, opts.visited);
    // Cluster into work windows: pad each span forward to minFrames (backward
    // at the clip end), then merge windows separated by less than joinGap —
    // seeking through a small held gap is cheaper than a second window's
    // alignment overhead.
    var wins = [];
    for (var i = 0; i < spans.length; i++) {
      var w0 = spans[i][0], w1 = spans[i][1];
      if (w1 - w0 < minF) {
        w1 = w0 + minF;
        if (w1 > f1) { w1 = f1; w0 = Math.max(f0, w1 - minF); }
      }
      wins.push([w0, w1]);
    }
    var padded = [];
    for (var k = 0; k < wins.length; k++) {
      var last = padded[padded.length - 1];
      if (last && wins[k][0] - last[1] <= joinGap) { if (wins[k][1] > last[1]) last[1] = wins[k][1]; }
      else padded.push(wins[k]);
    }
    // Back-pad (opts.overlap = one max-droplet span; field36 run-1's
    // edge-truncation lesson): a droplet straddling a prior window's end
    // never completed, so every follow-on window starts one droplet-span
    // early — the seam is re-seeked deliberately, and every unknown slot
    // then lies FULLY inside some window.
    var overlap = opts.overlap || 0;
    if (overlap > 0) {
      for (var ov = 0; ov < padded.length; ov++)
        padded[ov][0] = Math.max(f0, padded[ov][0] - overlap);
      padded = mergeSpans(padded);
    }
    // The cap: window length IS the early-exit granularity — pooling happens
    // per window, so one giant unknown remainder would postpone the peel
    // check to the clip's end and early exit could never fire (field34's
    // "in hand by 40 s" needs the tail to be SEPARATE windows). Split any
    // over-cap window into consecutive pieces of ~minFrames; a window under
    // 2×minFrames is indivisible (each piece must still self-align). Pieces
    // after the first also start `overlap` early — a split seam truncates
    // droplets exactly like a window seam.
    if (opts.maxFrames > 0) {
      var split = [];
      for (var q = 0; q < padded.length; q++) {
        var w0q = padded[q][0], w1q = padded[q][1], len = w1q - w0q;
        var pieces = len > opts.maxFrames ? Math.floor(len / minF) : 1;
        if (pieces <= 1) { split.push(padded[q]); continue; }
        var size = len / pieces;
        for (var pz = 0; pz < pieces; pz++)
          split.push([Math.max(f0, Math.round(w0q + pz * size) - (pz ? overlap : 0)), Math.round(w0q + (pz + 1) * size)]);
      }
      padded = split;
    }
    if (opts.visited && opts.visited.length) {
      // Padding may have re-covered visited ground entirely (a window nested
      // inside old coverage helps nobody) — drop windows that add nothing.
      var keep = [];
      for (var m = 0; m < padded.length; m++) {
        var fresh = subtractSpans([padded[m]], opts.visited);
        var freshLen = 0;
        for (var n = 0; n < fresh.length; n++) freshLen += fresh[n][1] - fresh[n][0];
        if (freshLen > 0) keep.push(padded[m]);
      }
      padded = keep;
    }
    return { spans: spans, windows: padded };
  }

  /* The no-lock / still-hungry fallback: the first unvisited chunk, started
     one overlap early (a sweep seam truncates droplets exactly like a
     planned seam). With no lock the harvest degrades to a chunked classic
     pass; with locks exhausted and the peel still short it keeps the
     coverage promise honest before declaring the clip dry. */
  function nextUnvisited(visited, f0, f1, chunkFrames, overlap) {
    var gaps = subtractSpans([[f0, f1]], visited);
    if (!gaps.length) return null;
    var g0 = gaps[0][0];
    return [Math.max(f0, g0 - (overlap || 0)), Math.min(g0 + chunkFrames, gaps[0][1])];
  }

  var API = {
    createLedger: createLedger, serializeLedger: serializeLedger, parseLedger: parseLedger,
    counts: counts, absorb: absorb, ringsFor: ringsFor, tryPeel: tryPeel, seenTileSeeds: seenTileSeeds,
    contentKeyOf: contentKeyOf, createStore: createStore, serializeStore: serializeStore,
    parseStore: parseStore, storeCounts: storeCounts, leaseCreate: leaseCreate,
    envelopeCycleSeconds: envelopeCycleSeconds,
    leaseNewClip: leaseNewClip, mergeLedger: mergeLedger,
    leaseObserve: leaseObserve, tryPeelStore: tryPeelStore,
    lockFrom: lockFrom, frameOfSymbol: frameOfSymbol, symbolAtFrame: symbolAtFrame,
    slotSpan: slotSpan, slotAtFrame: slotAtFrame, predictLag: predictLag,
    maxDropletFrames: maxDropletFrames,
    mergeSpans: mergeSpans, subtractSpans: subtractSpans, markVisited: markVisited,
    planSpans: planSpans, nextUnvisited: nextUnvisited,
    bytesToHex: bytesToHex, hexToBytes: hexToBytes
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.harvest = API;
})(typeof window !== "undefined" ? window : globalThis);
