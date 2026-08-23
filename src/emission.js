/* emission.js — profile-driven emission: symbol schedule + analytic per-pixel renderer.
   Shared by the emitter page, the golden renderer (deterministic trig), and the
   synthetic test path. Rendering is ANALYTIC (no canvas primitives): every pixel is
   evaluated from the profile, which is what makes a pinned reference rasterizer
   possible at all (review F8).

   Conventions (must match the decoder):
     φ_a(f)      = 2π·nominal_hz·f/fps + θ_data(f)           [radians]
     r_out(θ, f) = r0 + Σ_k a_k · cos(k·(θ − φ_a) + ψ_k)
     so arg(c_k) of the decoder's DFT (e^{-ikθ} convention) equals ψ_k − k·φ_a.
   Differential data: symbol s → Δθ = wrapSigned(s · 2π/M), swept linearly across
   frames_per_symbol frames (CPM: no phase jumps; rate steps at symbol boundaries). */
(function (global) {
  "use strict";

  function P() { return (typeof module !== "undefined" && module.exports) ? require("./prng.js") : global.OC.prng; }

  var TAU = Math.PI * 2;

  function wrapSigned(x) { // wrap to (-π, π]
    x = x % TAU; if (x > Math.PI) x -= TAU; if (x <= -Math.PI) x += TAU; return x;
  }

  /* Symbol schedule for one annulus: preamble (alternating +step/−step) then data.
     Data source: the seeded reference stream (Phase 0 measurement), or — when
     dataSymbols is supplied — a payload CAROUSEL cycled at its own period
     (Phase 1; see fountain.js). Returns { symbols, deltas, base, thetaData(f),
     nSymbols } — angles in radians. */
  function buildSchedule(annulus, fps, nFrames, preambleSymbols, dataSymbols) {
    var F = annulus.rotation.frames_per_symbol, M = annulus.rotation.M;
    var nSym = Math.ceil(nFrames / F) + 1;
    var symbols = new Uint8Array(nSym);
    var nData = Math.max(0, nSym - preambleSymbols);
    var data = dataSymbols || P().symbolStream(annulus.rotation.seed, nData, M);
    for (var i = 0; i < nSym; i++)
      symbols[i] = i < preambleSymbols ? (i % 2 === 0 ? 1 : M - 1) : data[(i - preambleSymbols) % data.length];
    var deltas = new Float64Array(nSym), base = new Float64Array(nSym + 1);
    for (var j = 0; j < nSym; j++) {
      deltas[j] = wrapSigned(symbols[j] * TAU / M);
      base[j + 1] = base[j] + deltas[j];
    }
    function thetaData(f) {
      var i2 = Math.floor(f / F);
      if (i2 >= nSym) i2 = nSym - 1;
      var u = (f - i2 * F) / F;
      return base[i2] + deltas[i2] * u;
    }
    return { symbols: symbols, deltas: deltas, base: base, thetaData: thetaData, nSymbols: nSym, dataSymbols: data };
  }

  /* Full emission schedule: one per annulus. carousels: per-annulus payload
     symbol arrays from fountain.encodeCarousels (Phase 1), else seeded. */
  function buildSchedules(profile, nFrames, carousels) {
    return profile.annuli.map(function (a, i) {
      return buildSchedule(a, profile.frame_rate_hz, nFrames, profile.preamble_symbols,
                           carousels ? carousels[i] : undefined);
    });
  }

  function phaseAt(annulus, schedule, fps, f) {
    return TAU * annulus.rotation.nominal_hz * f / fps + schedule.thetaData(f);
  }

  /* Fiducial module map: finders (TL/TR/BL), timing lines, seeded static fill. 1 = dark. */
  function fiducialModules(fid) {
    var n = fid.modules, m = new Uint8Array(n * n);
    var rng = P().mulberry32(fid.seed);
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) m[y * n + x] = rng() < 0.5 ? 1 : 0;
    function finder(ox, oy) {
      for (var j = 0; j < 7; j++) for (var i = 0; i < 7; i++) {
        var d = Math.max(Math.abs(i - 3), Math.abs(j - 3));
        m[(oy + j) * n + (ox + i)] = (d === 3 || d <= 1) ? 1 : 0;
      }
      for (var q = -1; q <= 7; q++) { // one-module light separator ring (clipped at edges)
        setIf(ox + q, oy - 1, 0); setIf(ox + q, oy + 7, 0);
        setIf(ox - 1, oy + q, 0); setIf(ox + 7, oy + q, 0);
      }
    }
    function setIf(x, y, v) { if (x >= 0 && y >= 0 && x < n && y < n) m[y * n + x] = v; }
    finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
    for (var t = 8; t <= n - 9; t++) { m[6 * n + t] = (t % 2 === 0) ? 1 : 0; m[t * n + 6] = (t % 2 === 0) ? 1 : 0; }
    return m;
  }

  /* ————— v3: the calibration plate that happens to carry data —————
     Contract technical/phryctoros-v3-contract.md. Three dark bands, four
     modulated EDGES (bands B carries two — its inner boundary wiggles too),
     the unmodulated outer circle at exactly flat_circle_r (the units anchor
     and per-frame conic gauge), a 2:1:2 bullseye at three deployments, the
     breaker/beacon ring pair on the center bullseye, and a recurring
     countdown QR whose center-mean matches the steady face (§5). */

  function isV3(p) { return !!(p && p.bands && p.plate); }

  function FN() { return (typeof module !== "undefined" && module.exports) ? require("./fountain.js") : global.OC.fountain; }

  /* §6 envelope, internal format v1, 20 bytes. info: { K, len, pcrc, capability }
     for an attached payload (null → zeros: identity-only envelope).
     tile: the index of the tile carrying THIS copy (D-ring ruling 4,
     2026-08-23) — the beacon rides tile 0 today, so it defaults to 0; the
     per-tile D-ring (ruling 1b) will stamp each tile's own. */
  function envelopeBytes(profile, info, tile) {
    var F = FN();
    var b = new Uint8Array(20);
    b[0] = 1;                                        // envelope format version
    b[1] = 3;                                        // profile family: v3
    b[2] = profile.preset === "high-rate" ? 1 : 0;   // §2: the ONE toggle rides the envelope
    var s32 = (profile.session32 || 0) >>> 0;
    b[3] = s32 >>> 24; b[4] = (s32 >>> 16) & 255; b[5] = (s32 >>> 8) & 255; b[6] = s32 & 255;
    if (info) {
      b[7] = info.K & 255;
      b[8] = (info.len >> 8) & 255; b[9] = info.len & 255;
      b[10] = (info.pcrc >> 8) & 255; b[11] = info.pcrc & 255;
    }
    b[12] = (info && info.capability !== undefined) ? info.capability : 1; // bit0 = 60 fps capture
    b[13] = profile.countdown ? Math.round(profile.countdown.freeze_s * 10) & 255 : 0; // deciseconds
    b[14] = profile.countdown ? profile.countdown.loop_s & 255 : 0;
    b[15] = profile.tiling || 1;
    // [16..17] — D-ring ruling 4 (2026-08-23): tile index + grid shape, SCOPED
    // TO ONE PANEL. b[16] = index of the tile carrying this copy; b[17] = the
    // panel's lattice, cols<<4 | rows, with 0 meaning single-panel (1×1) so
    // every tiling=1 envelope ever emitted — zeros here — stays byte-exact
    // under the definition. Tiles pool only within one session's grid: two
    // screens, or two grids, are two sessions and never tile together by
    // default. (Both bytes sit under the CRC16, so a grid change moves the
    // fast tag — a config change is a tag change, as the interlock requires.)
    b[16] = (tile || 0) & 255;
    var lay = tileLayout(profile);
    b[17] = lay.n > 1 ? (((lay.cols & 15) << 4) | (lay.rows & 15)) : 0;
    var crc = F.crc16(b.subarray(0, 18));
    b[18] = crc >> 8; b[19] = crc & 255;
    return b;
  }

  /* Countdown QR module map: finders TL/TR/BL + separators + timing (the same
     shape the v2 fiducial scan already registers), data cells = the envelope
     bit stream repeated and WHITENED to ~50% density (the matched-mean rule
     leans on that density; repetition is the v0 FEC). 1 = dark. */
  function envelopeModules(qr, envBytes) {
    var n = qr.modules, m = new Uint8Array(n * n), reserved = new Uint8Array(n * n);
    var rng = P().mulberry32(qr.seed);
    function setIf(x, y, v) { if (x >= 0 && y >= 0 && x < n && y < n) m[y * n + x] = v; }
    function finder(ox, oy) {
      for (var j = 0; j < 7; j++) for (var i = 0; i < 7; i++) {
        var d = Math.max(Math.abs(i - 3), Math.abs(j - 3));
        m[(oy + j) * n + (ox + i)] = (d === 3 || d <= 1) ? 1 : 0;
      }
      for (var q = -1; q <= 7; q++) { setIf(ox + q, oy - 1, 0); setIf(ox + q, oy + 7, 0); setIf(ox - 1, oy + q, 0); setIf(ox + 7, oy + q, 0); }
      for (var yy = oy - 1; yy <= oy + 7; yy++) for (var xx = ox - 1; xx <= ox + 7; xx++)
        if (xx >= 0 && yy >= 0 && xx < n && yy < n) reserved[yy * n + xx] = 1;
    }
    finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
    for (var t = 8; t <= n - 9; t++) {
      m[6 * n + t] = (t % 2 === 0) ? 1 : 0; reserved[6 * n + t] = 1;
      m[t * n + 6] = (t % 2 === 0) ? 1 : 0; reserved[t * n + 6] = 1;
    }
    var bi = 0, nBytes = envBytes.length;
    for (var y2 = 0; y2 < n; y2++) for (var x2 = 0; x2 < n; x2++) {
      var idx = y2 * n + x2;
      if (reserved[idx]) continue;
      var bit = (envBytes[(bi >> 3) % nBytes] >> (7 - (bi & 7))) & 1;
      m[idx] = bit ^ (rng() < 0.5 ? 1 : 0);
      bi++;
    }
    return m;
  }

  /* §5 beacon control carousel v0: the envelope mirror — magic, length, envelope
     bytes, CRC8 — as M=2 bits (M=4: Gray pairs), cycled by the schedule. */
  function beaconSymbols(envBytes, M) {
    var F = FN();
    var payload = new Uint8Array(envBytes.length + 3);
    payload[0] = 0xB3; payload[1] = envBytes.length & 255;
    payload.set(envBytes, 2);
    payload[payload.length - 1] = F.crc8(payload, payload.length - 1);
    var bitsPer = M === 4 ? 2 : 1, nBits = payload.length * 8;
    var syms = new Uint8Array(Math.ceil(nBits / bitsPer));
    for (var s = 0; s < syms.length; s++) {
      var v = 0;
      for (var b = 0; b < bitsPer; b++) {
        var i = s * bitsPer + b;
        v = (v << 1) | (i < nBits ? (payload[i >> 3] >> (7 - (i & 7))) & 1 : 0);
      }
      syms[s] = M === 4 ? F.toGray(v) : v;
    }
    return syms;
  }

  function buildBeaconSchedule(profile, nFrames, envBytes) {
    return buildSchedule({ rotation: profile.beacon.rotation }, profile.frame_rate_hz, nFrames,
                         profile.preamble_symbols, beaconSymbols(envBytes, profile.beacon.rotation.M));
  }

  /* §6 recurring countdown: wall-clock frame → { freeze, eff }. The emission
     clock PAUSES during freeze (v2's frozen-frame-0 scheme, recurring): eff is
     the schedule position, so a mid-loop joiner sees motion resume exactly
     where the plate froze. */
  function timeline(profile, wallF) {
    var cd = profile.countdown;
    if (!cd) return { freeze: false, eff: wallF, loopIdx: 0, inLoop: wallF };
    var fps = profile.frame_rate_hz;
    var loopF = Math.max(2, Math.round(cd.loop_s * fps)), freezeF = Math.min(loopF - 1, Math.round(cd.freeze_s * fps));
    var loopIdx = Math.floor(wallF / loopF), inLoop = wallF - loopIdx * loopF;
    var effBase = loopIdx * (loopF - freezeF);
    if (inLoop < freezeF) return { freeze: true, eff: effBase, loopIdx: loopIdx, inLoop: inLoop };
    return { freeze: false, eff: effBase + (inLoop - freezeF), loopIdx: loopIdx, inLoop: inLoop };
  }

  /* 2:1:2 bullseye coverage (chord 2:1:4:1:2): dark disc to 0.4·R, light gap,
     dark ring 0.6·R → R. Anti-QR twice over (outer:inner runs 2:1 vs QR's 1:1,
     center 4 vs 3). */
  function bullseyeCov(rr, R, scale, soft) {
    var covDisc = clamp01((0.4 * R - rr) * scale / soft + 0.5);
    var covRing = clamp01((rr - 0.6 * R) * scale / soft + 0.5) * clamp01((R - rr) * scale / soft + 0.5);
    return covDisc > covRing ? covDisc : covRing;
  }

  /* v3.1 amendment-2 corner mark: the quadrant swap-target. Dark where
     dx·dy > 0 outside the swap circle (0.5R), polarity inverted inside it.
     The saddle center is projectively exact (lines map to lines under H —
     no eccentricity bias); the swap circle carries sizing + the phase-flip
     verify. Coverage stays analytic: half-plane ramps multiply per quadrant
     (exactly 0.5 on each axis, 0.5 at the crossing = a soft saddle), the
     swap blends by ring membership. Callers pass FOLDED local coords at
     plate corners (each mark oriented radially from plate center — diagonal
     pairs share polarity) and ABSOLUTE offsets at gutter vertices (a third
     φ2 class: vertex-vs-corner identity by phase). */
  function quadrantCov(dx, dy, rr, R, scale, soft) {
    var covDisc = clamp01((R - rr) * scale / soft + 0.5);
    if (covDisc <= 0) return 0;
    var sx = clamp01(dx * scale / soft + 0.5), sy = clamp01(dy * scale / soft + 0.5);
    var q = sx * sy + (1 - sx) * (1 - sy);
    var wIn = clamp01((0.5 * R - rr) * scale / soft + 0.5);
    return (wIn * (1 - q) + (1 - wIn) * q) * covDisc;
  }

  /* ——— Fast-render tables (opt-in: opts.fast) ———
     The analytic renderer costs one atan2 plus ~12 cos() per BAND pixel —
     ~8M transcendental calls per 1024² frame, measured at 85% of video-export
     wall clock. Two caches remove them:
       · ANGLE MAP — θ per pixel is a pure function of pixel position (the
         unit scale cancels inside atan2), so it is built once per canvas size
         and reused across every frame and every profile.
       · CONTOUR TABLES — r(θ) = r0 + Σ a·cos(kθ+β) sampled on an NA-point θ
         grid per frame, each harmonic's phase folded into two coefficients
         (C·cos kθ + S·sin kθ) against cached cos/sin tables: NA·harmonics
         multiply-adds per edge instead of cosines per pixel.
     Per pixel the band test becomes two linear interpolations. This is NOT
     bit-identical to the exact path — θ interpolates between grid points —
     but the error is bounded by ⅛·max|r″|·Δθ² ≈ 4e-6 units ≈ 6e-4 px, three
     orders under the 1.6 px soft edge and ~30× under 8-bit quantisation.
     T22L asserts it against the exact renderer, pixels and droplets both.
     1-up only; the tiled renderer keeps the exact path (per-tile centres want
     per-tile maps — worth doing when 6-up emission becomes a field case). */
  var FAST_NA = 2048;
  var _angleCache = null;
  function angleMap(size) {
    if (_angleCache && _angleCache.size === size) return _angleCache.map;
    var m = new Float32Array(size * size), half = size / 2, kf = FAST_NA / TAU;
    var lim = FAST_NA - 1e-4;
    for (var py = 0; py < size; py++) {
      var y = py + 0.5 - half, off = py * size;
      for (var px = 0; px < size; px++) {
        var th = Math.atan2(y, px + 0.5 - half);
        if (th < 0) th += TAU;
        var t = th * kf;
        m[off + px] = t >= lim ? lim : t;   // keep j+1 inside the table
      }
    }
    _angleCache = { size: size, map: m };
    return m;
  }
  var _harmCos = {}, _harmSin = {};
  function harmTable(k) {
    if (!_harmCos[k]) {
      var c = new Float64Array(FAST_NA + 1), s = new Float64Array(FAST_NA + 1);
      for (var j = 0; j <= FAST_NA; j++) {
        var th = TAU * j / FAST_NA;
        c[j] = Math.cos(k * th); s[j] = Math.sin(k * th);
      }
      _harmCos[k] = c; _harmSin[k] = s;
    }
  }
  function contourTable(r0, betas) {
    var out = new Float64Array(FAST_NA + 1);
    out.fill(r0);
    if (betas) for (var h = 0; h < betas.length; h++) {
      var b = betas[h];
      harmTable(b.k);
      var c = _harmCos[b.k], s = _harmSin[b.k];
      var C = b.a * Math.cos(b.beta), S = -b.a * Math.sin(b.beta);
      for (var j = 0; j <= FAST_NA; j++) out[j] += C * c[j] + S * s[j];
    }
    return out;
  }

  /* The v3 renderer. f is the EFFECTIVE frame (schedule position — the caller
     maps wall clock through timeline()). opts.countdown renders the freeze
     face: bands frozen at f, corners kept, center = envelope QR (the swap the
     matched-mean rule governs — no bullseye, no beacon, no data flow).
     opts.beaconSchedule: undefined → built from the default envelope
     (deterministic); null → static breaker ring (δ = 0). */
  function renderFrameV3(profile, f, opts) {
    opts = opts || {};
    var sin = opts.trig ? opts.trig.sin : Math.sin;
    var cos = opts.trig ? opts.trig.cos : Math.cos;
    var atan2 = opts.trig ? opts.trig.atan2 : Math.atan2;
    var schedules = opts.schedules || buildSchedules(profile, f + 1, opts.carousels);

    var R = profile.render, size = R.size_px, scale = R.scale_px_per_unit;
    var img = { w: size, h: size, data: new Float32Array(size * size) };
    var bg = R.background, fill = R.fill, soft = R.edge_soft_px;
    var fps = profile.frame_rate_hz;
    var pad = (soft / scale) * 2 + 0.01;
    var pl = profile.plate, shade = pl.shade !== undefined ? pl.shade : fill;

    var edges = profile.annuli.map(function (a, ai) {
      var phi = phaseAt(a, schedules[ai], fps, f);
      return a.boundary.harmonics.map(function (k, j) {
        return { k: k, a: a.boundary.amplitudes[j], beta: a.boundary.phases_deg[j] * Math.PI / 180 - k * phi };
      });
    });
    function resolveB(ref) {
      if (ref.edge !== undefined) {
        var a = profile.annuli[ref.edge], sum = 0;
        for (var j = 0; j < a.boundary.amplitudes.length; j++) sum += a.boundary.amplitudes[j];
        return { r0: a.r0, betas: edges[ref.edge], sum: sum };
      }
      return { r0: ref.fixed, betas: null, sum: 0 };
    }
    var bands = profile.bands.map(function (band) {
      var lo = resolveB(band.lo), hi = resolveB(band.hi);
      return { lo: lo, hi: hi, rMin: lo.r0 - lo.sum - pad, rMax: hi.r0 + hi.sum + pad };
    });
    function evalBetas(betas, th) {
      if (!betas) return 0;
      var s = 0;
      for (var h = 0; h < betas.length; h++) s += betas[h].a * cos(betas[h].k * th + betas[h].beta);
      return s;
    }

    // qr_persistent (diagnostic): the envelope QR owns the center donut on
    // EVERY face — the finder path then registers angled captures
    // continuously (the interim lock until saddle-first lands). Suppresses
    // the center bullseye and the beacon.
    var centerQR = !!(opts.countdown || profile.qr_persistent);
    var beacon = null;
    if (!centerQR) {
      var bs = opts.beaconSchedule;
      if (bs === undefined) bs = buildBeaconSchedule(profile, f + 1, opts.envBytes || envelopeBytes(profile, opts.payloadInfo || null));
      var phiB = bs ? phaseAt({ rotation: profile.beacon.rotation }, bs, fps, f) : 0;
      var bSum = 0;
      for (var q = 0; q < profile.beacon.amplitudes.length; q++) bSum += profile.beacon.amplitudes[q];
      beacon = {
        sum: bSum,
        betas: profile.beacon.harmonics.map(function (k, j) {
          return { k: k, a: profile.beacon.amplitudes[j], beta: profile.beacon.phases_deg[j] * Math.PI / 180 - k * phiB };
        })
      };
    }
    var qrm = null, qrHalf = 0, qrModU = 0, qrN = 0;
    if (centerQR) {
      qrm = opts.qrModules || envelopeModules(profile.qr, opts.envBytes || envelopeBytes(profile, opts.payloadInfo || null));
      qrN = profile.qr.modules;
      qrHalf = profile.qr.width_units / 2;
      qrModU = profile.qr.width_units / qrN;
    }

    // Opt-in fast tables (see the FAST_NA block above). Built per frame:
    // one contour per band boundary plus the beacon's radial offset.
    var fast = !!opts.fast, tMap = null, loT = null, hiT = null, bconT = null;
    if (fast) {
      tMap = angleMap(size);
      loT = bands.map(function (B) { return contourTable(B.lo.r0, B.lo.betas); });
      hiT = bands.map(function (B) { return contourTable(B.hi.r0, B.hi.betas); });
      if (beacon) bconT = contourTable(0, beacon.betas);
    }

    // Loop invariants hoisted out of the ~1M-pixel body: every one of these
    // was a chained property load per pixel (pl.quiet_r, B.rMin, B.lo.r0 …).
    // Pure hoisting — no arithmetic is reassociated, so the exact path stays
    // bit-identical while shedding most of its per-pixel overhead.
    var quietLim = pl.quiet_r + pad;
    var centerRout = pl.center.r_out;
    var brIn = pl.breaker.r_in, brOut = pl.breaker.r_out;
    var reach = beacon ? beacon.sum : 0;
    var brLoLim = brIn - reach - pad, brHiLim = brOut + reach + pad;
    var qrDark = centerQR ? profile.qr.dark : 0;
    var nb = bands.length;
    var bRMin = new Float64Array(nb), bRMax = new Float64Array(nb);
    var bLoR0 = new Float64Array(nb), bHiR0 = new Float64Array(nb);
    var bLoBet = new Array(nb), bHiBet = new Array(nb);
    for (var bh = 0; bh < nb; bh++) {
      bRMin[bh] = bands[bh].rMin; bRMax[bh] = bands[bh].rMax;
      bLoR0[bh] = bands[bh].lo.r0; bHiR0[bh] = bands[bh].hi.r0;
      bLoBet[bh] = bands[bh].lo.betas; bHiBet[bh] = bands[bh].hi.betas;
    }

    var cAt = pl.corners.at, cR = pl.corners.r_out;
    var cornerQuad = pl.corner_style === "quadrant";
    var cLoLim = -cR - pad, cHiLim = cR + pad;
    var half = size / 2, d = img.data;
    for (var py = 0; py < size; py++) {
      var y = (py + 0.5 - half) / scale;
      var rowOff = py * size;
      for (var px = 0; px < size; px++) {
        var x = (px + 0.5 - half) / scale;
        var v = bg;
        var r = Math.sqrt(x * x + y * y);
        if (r <= quietLim) {
          if (centerQR) {
            var ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
            if (ax <= qrHalf && ay <= qrHalf) {
              var mx = Math.floor((x + qrHalf) / qrModU); if (mx >= qrN) mx = qrN - 1;
              var my = Math.floor((y + qrHalf) / qrModU); if (my >= qrN) my = qrN - 1;
              if (qrm[my * qrN + mx]) v = qrDark;
            }
          } else {
            var cov = bullseyeCov(r, centerRout, scale, soft);
            var loB = brIn, hiBk = brOut;
            if (r >= brLoLim && r <= brHiLim) {
              var dlt;
              if (fast) {
                var bt = tMap[rowOff + px], bj = bt | 0, bfr = bt - bj;
                dlt = bconT ? bconT[bj] + (bconT[bj + 1] - bconT[bj]) * bfr : 0;
              } else dlt = beacon ? evalBetas(beacon.betas, atan2(y, x)) : 0;
              var covB = clamp01((r - (loB + dlt)) * scale / soft + 0.5) * clamp01(((hiBk + dlt) - r) * scale / soft + 0.5);
              if (covB > cov) cov = covB;
            }
            if (cov > 0) v = bg + (shade - bg) * cov;
          }
        } else {
          var axc = (x < 0 ? -x : x) - cAt, ayc = (y < 0 ? -y : y) - cAt;
          if (axc >= cLoLim && axc <= cHiLim && ayc >= cLoLim && ayc <= cHiLim) {
            var rc = Math.sqrt(axc * axc + ayc * ayc);
            var covK = cornerQuad ? quadrantCov(axc, ayc, rc, cR, scale, soft)
                                  : bullseyeCov(rc, cR, scale, soft);
            if (covK > 0) v = bg + (shade - bg) * covK;
          } else {
            for (var bi2 = 0; bi2 < nb; bi2++) {
              if (r < bRMin[bi2] || r > bRMax[bi2]) continue;
              var bLo, bHi;
              if (fast) {
                var tf = tMap[rowOff + px], tj = tf | 0, tfr = tf - tj;
                var Lt = loT[bi2], Ht = hiT[bi2];
                bLo = Lt[tj] + (Lt[tj + 1] - Lt[tj]) * tfr;
                bHi = Ht[tj] + (Ht[tj + 1] - Ht[tj]) * tfr;
              } else {
                var th = atan2(y, x);
                bLo = bLoR0[bi2] + evalBetas(bLoBet[bi2], th);
                bHi = bHiR0[bi2] + evalBetas(bHiBet[bi2], th);
              }
              var cov2 = clamp01((bHi - r) * scale / soft + 0.5) * clamp01((r - bLo) * scale / soft + 0.5);
              if (cov2 > 0) v = bg + (fill - bg) * cov2;
              break; // bands are disjoint by the trough guards
            }
          }
        }
        d[rowOff + px] = v;
      }
    }
    return img;
  }

  /* §7 tiling layout: 1 / 2 / 6-up as a grid (2×1, 3×2 — grid beats hex on
     16:9 to two rows). Tile 0 = top-left = the DESIGNATED tile: the only one
     carrying the breaker pair + beacon (§5's count asymmetry is the decoder's
     tile identity). Gutter-vertex bullseyes sit on INTERIOR lattice vertices
     (border vertices would clip half a bullseye off the canvas; 2-up has no
     interior vertex and leans on its ten plate bullseyes). */
  function tileLayout(p) {
    var n = p.tiling || 1;
    if (n <= 1) return { n: 1, cols: 1, rows: 1, pitch: 0 };
    var cols = n === 2 ? 2 : 3, rows = n === 2 ? 1 : 2;
    return { n: n, cols: cols, rows: rows, pitch: p.tile_pitch || 7.2 };
  }

  /* The tiled analytic renderer. f is the effective frame; opts.schedulesT =
     per-tile per-edge schedules (tile-seeded carousels); opts.countdown puts
     the envelope QR on EVERY tile center (any tile in frame carries the
     envelope; per-tile matched-mean stays inside the 0.05 bound with and
     without the breaker: Δ≈0.026/0.029). Beacon renders on tile 0 only. */
  function renderFrameV3Tiled(profile, f, opts) {
    opts = opts || {};
    var sin = opts.trig ? opts.trig.sin : Math.sin;
    var cos = opts.trig ? opts.trig.cos : Math.cos;
    var atan2 = opts.trig ? opts.trig.atan2 : Math.atan2;
    var layout = tileLayout(profile);
    var R = profile.render, scale = R.scale_px_per_unit;
    var wPx = Math.round(layout.cols * layout.pitch * scale);
    var hPx = Math.round(layout.rows * layout.pitch * scale);
    var img = { w: wPx, h: hPx, data: new Float32Array(wPx * hPx) };
    var bg = R.background, fill = R.fill, soft = R.edge_soft_px;
    var fps = profile.frame_rate_hz;
    var pad = (soft / scale) * 2 + 0.01;
    var pl = profile.plate, shade = pl.shade !== undefined ? pl.shade : fill;

    var schedulesT = opts.schedulesT;
    if (!schedulesT) {
      schedulesT = [];
      for (var t0 = 0; t0 < layout.n; t0++) schedulesT.push(buildSchedules(profile, f + 1, undefined));
    }
    function betasFor(t) {
      return profile.annuli.map(function (a, ai) {
        var phi = phaseAt(a, schedulesT[t][ai], fps, f);
        return a.boundary.harmonics.map(function (k, j) {
          return { k: k, a: a.boundary.amplitudes[j], beta: a.boundary.phases_deg[j] * Math.PI / 180 - k * phi };
        });
      });
    }
    var edgesT = [], bandsT = [];
    for (var tb = 0; tb < layout.n; tb++) {
      var eb = betasFor(tb);
      edgesT.push(eb);
      bandsT.push(profile.bands.map(function (band) {
        function res(ref) {
          if (ref.edge !== undefined) {
            var a = profile.annuli[ref.edge], sum = 0;
            for (var j = 0; j < a.boundary.amplitudes.length; j++) sum += a.boundary.amplitudes[j];
            return { r0: a.r0, betas: eb[ref.edge], sum: sum };
          }
          return { r0: ref.fixed, betas: null, sum: 0 };
        }
        var lo = res(band.lo), hi = res(band.hi);
        return { lo: lo, hi: hi, rMin: lo.r0 - lo.sum - pad, rMax: hi.r0 + hi.sum + pad };
      }));
    }
    function evalB(betas, th) {
      if (!betas) return 0;
      var s = 0;
      for (var h = 0; h < betas.length; h++) s += betas[h].a * cos(betas[h].k * th + betas[h].beta);
      return s;
    }

    var centerQR = !!(opts.countdown || profile.qr_persistent);
    var beacon = null;
    if (!centerQR) {
      var bs = opts.beaconSchedule;
      if (bs === undefined) bs = buildBeaconSchedule(profile, f + 1, opts.envBytes || envelopeBytes(profile, opts.payloadInfo || null));
      var phiB = bs ? phaseAt({ rotation: profile.beacon.rotation }, bs, fps, f) : 0;
      var bSum = 0;
      for (var q = 0; q < profile.beacon.amplitudes.length; q++) bSum += profile.beacon.amplitudes[q];
      beacon = {
        sum: bSum,
        betas: profile.beacon.harmonics.map(function (k, j) {
          return { k: k, a: profile.beacon.amplitudes[j], beta: profile.beacon.phases_deg[j] * Math.PI / 180 - k * phiB };
        })
      };
    }
    var qrm = null, qrHalf = 0, qrModU = 0, qrN = 0;
    if (centerQR) {
      qrm = opts.qrModules || envelopeModules(profile.qr, opts.envBytes || envelopeBytes(profile, opts.payloadInfo || null));
      qrN = profile.qr.modules;
      qrHalf = profile.qr.width_units / 2;
      qrModU = profile.qr.width_units / qrN;
    }

    // interior gutter-lattice vertices, canvas units
    var verts = [];
    for (var vc = 1; vc < layout.cols; vc++)
      for (var vr = 1; vr < layout.rows; vr++)
        verts.push({ x: vc * layout.pitch, y: vr * layout.pitch });
    var vR = pl.corners.r_out;

    var cAt = pl.corners.at, cR = pl.corners.r_out;
    var cornerQuad = pl.corner_style === "quadrant";
    var d = img.data, pitch = layout.pitch;
    for (var py = 0; py < hPx; py++) {
      var yG = (py + 0.5) / scale;
      var rowOff = py * wPx;
      for (var px = 0; px < wPx; px++) {
        var xG = (px + 0.5) / scale;
        var v = bg;
        var owned = false;
        for (var vi = 0; vi < verts.length; vi++) {
          var dvx = xG - verts[vi].x, dvy = yG - verts[vi].y;
          if (dvx >= -vR - pad && dvx <= vR + pad && dvy >= -vR - pad && dvy <= vR + pad) {
            var rv = Math.sqrt(dvx * dvx + dvy * dvy);
            var covV = cornerQuad ? quadrantCov(dvx, dvy, rv, vR, scale, soft)
                                  : bullseyeCov(rv, vR, scale, soft);
            if (covV > 0) v = bg + (shade - bg) * covV;
            owned = true;
            break;
          }
        }
        if (!owned) {
          var col = Math.floor(xG / pitch); if (col >= layout.cols) col = layout.cols - 1;
          var row = Math.floor(yG / pitch); if (row >= layout.rows) row = layout.rows - 1;
          var t = row * layout.cols + col;
          var x = xG - (col + 0.5) * pitch, y = yG - (row + 0.5) * pitch;
          var r = Math.sqrt(x * x + y * y);
          if (r <= pl.quiet_r + pad) {
            if (centerQR) {
              var ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
              if (ax <= qrHalf && ay <= qrHalf) {
                var mx = Math.floor((x + qrHalf) / qrModU); if (mx >= qrN) mx = qrN - 1;
                var my = Math.floor((y + qrHalf) / qrModU); if (my >= qrN) my = qrN - 1;
                if (qrm[my * qrN + mx]) v = profile.qr.dark;
              }
            } else {
              var cov = bullseyeCov(r, pl.center.r_out, scale, soft);
              if (t === 0) {
                var loB = pl.breaker.r_in, hiBk = pl.breaker.r_out;
                var reach = beacon ? beacon.sum : 0;
                if (r >= loB - reach - pad && r <= hiBk + reach + pad) {
                  var dlt = beacon ? evalB(beacon.betas, atan2(y, x)) : 0;
                  var covB = clamp01((r - (loB + dlt)) * scale / soft + 0.5) * clamp01(((hiBk + dlt) - r) * scale / soft + 0.5);
                  if (covB > cov) cov = covB;
                }
              }
              if (cov > 0) v = bg + (shade - bg) * cov;
            }
          } else {
            var axc = (x < 0 ? -x : x) - cAt, ayc = (y < 0 ? -y : y) - cAt;
            if (axc >= -cR - pad && axc <= cR + pad && ayc >= -cR - pad && ayc <= cR + pad) {
              var rc = Math.sqrt(axc * axc + ayc * ayc);
              var covK = cornerQuad ? quadrantCov(axc, ayc, rc, cR, scale, soft)
                                    : bullseyeCov(rc, cR, scale, soft);
              if (covK > 0) v = bg + (shade - bg) * covK;
            } else {
              var bands = bandsT[t];
              for (var bi2 = 0; bi2 < bands.length; bi2++) {
                var B = bands[bi2];
                if (r < B.rMin || r > B.rMax) continue;
                var th = atan2(y, x);
                var bLo = B.lo.r0 + evalB(B.lo.betas, th);
                var bHi = B.hi.r0 + evalB(B.hi.betas, th);
                var cov2 = clamp01((bHi - r) * scale / soft + 0.5) * clamp01((r - bLo) * scale / soft + 0.5);
                if (cov2 > 0) v = bg + (fill - bg) * cov2;
                break;
              }
            }
          }
        }
        d[rowOff + px] = v;
      }
    }
    return img;
  }

  /* Matched-mean arithmetic (§5): exact areas for the steady face, the actual
     module map for the countdown face. The validator errors past 0.05; T22
     re-checks the same bound on rendered pixels. */
  function centerMeans(profile) {
    var pl = profile.plate, bg = profile.render.background;
    var shade = pl.shade !== undefined ? pl.shade : profile.render.fill;
    var donut = Math.PI * pl.quiet_r * pl.quiet_r;
    var c = pl.center.r_out;
    var darkSteady = Math.PI * (0.16 * c * c + (c * c - 0.36 * c * c) +
                                (pl.breaker.r_out * pl.breaker.r_out - pl.breaker.r_in * pl.breaker.r_in));
    var env = envelopeBytes(profile, null);
    var m = envelopeModules(profile.qr, env);
    var darkCells = 0;
    for (var i = 0; i < m.length; i++) if (m[i]) darkCells++;
    var cell = profile.qr.width_units / profile.qr.modules;
    return {
      steady: bg + (shade - bg) * (darkSteady / donut),
      countdown: bg + (profile.qr.dark - bg) * (darkCells * cell * cell / donut)
    };
  }

  /* Render frame f to {w,h,data} luminance. opts: { trig: {sin,cos,atan2} } for the
     deterministic golden path; defaults to native Math. */
  function renderFrame(profile, f, opts) {
    if (isV3(profile)) {
      return tileLayout(profile).n > 1 ? renderFrameV3Tiled(profile, f, opts)
                                       : renderFrameV3(profile, f, opts);
    }
    opts = opts || {};
    var sin = opts.trig ? opts.trig.sin : Math.sin;
    var cos = opts.trig ? opts.trig.cos : Math.cos;
    var atan2 = opts.trig ? opts.trig.atan2 : Math.atan2;
    var schedules = opts.schedules || buildSchedules(profile, f + 1);

    var R = profile.render, size = R.size_px, scale = R.scale_px_per_unit;
    var img = { w: size, h: size, data: new Float32Array(size * size) };
    var bg = R.background, fill = R.fill, soft = R.edge_soft_px;
    var fid = profile.fiducial, nMod = fid.modules;
    var modules = opts.modules || fiducialModules(fid);
    var quietHalf = 0.5 + fid.quiet_modules / nMod;
    var fps = profile.frame_rate_hz;

    // Per-annulus per-frame constants.
    var ann = profile.annuli.map(function (a, ai) {
      var phi = phaseAt(a, schedules[ai], fps, f);
      var betas = a.boundary.harmonics.map(function (k, j) {
        return { k: k, a: a.boundary.amplitudes[j], beta: a.boundary.phases_deg[j] * Math.PI / 180 - k * phi };
      });
      var sA = 0; for (var j2 = 0; j2 < a.boundary.amplitudes.length; j2++) sA += a.boundary.amplitudes[j2];
      var pad = (soft / scale) * 2 + 0.01;
      return { a: a, betas: betas, rMin: a.r_inner - pad, rMax: a.r0 + sA + pad, phi: phi };
    });

    var half = size / 2, d = img.data;
    for (var py = 0; py < size; py++) {
      var y = (py + 0.5 - half) / scale;
      var rowOff = py * size;
      for (var px = 0; px < size; px++) {
        var x = (px + 0.5 - half) / scale;
        var v = bg;
        var ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
        if (ax <= quietHalf && ay <= quietHalf) {
          v = fid.light;
          if (ax <= 0.5 && ay <= 0.5) {
            var mx = Math.floor((x + 0.5) * nMod); if (mx >= nMod) mx = nMod - 1;
            var my = Math.floor((y + 0.5) * nMod); if (my >= nMod) my = nMod - 1;
            v = modules[my * nMod + mx] ? fid.dark : fid.light;
          }
        } else {
          var r = Math.sqrt(x * x + y * y);
          if (fid.af_collar && r >= fid.af_collar.r_in && r <= fid.af_collar.r_out) {
            // Static AF arcs in the dead band — never sampled by the decoder.
            // Cardinal-centered (offset half a wedge) so the quiet-square corners
            // clip only LIGHT wedges.
            var thc = atan2(y, x) + Math.PI / (fid.af_collar.spokes * 2);
            v = (Math.floor(((thc / TAU + 1) % 1) * fid.af_collar.spokes * 2) % 2 === 0) ? fid.dark : fid.light;
          } else {
            for (var ai2 = 0; ai2 < ann.length; ai2++) {
              var A = ann[ai2];
              if (r < A.rMin || r > A.rMax) continue;
              var th = atan2(y, x);
              var b = A.a.r0;
              for (var h2 = 0; h2 < A.betas.length; h2++) {
                var B = A.betas[h2];
                b += B.a * cos(B.k * th + B.beta);
              }
              var covOuter = clamp01((b - r) * scale / soft + 0.5);
              var covInner = clamp01((r - A.a.r_inner) * scale / soft + 0.5);
              var cov = covOuter * covInner;
              if (cov > 0) v = bg + (fill - bg) * cov;
              break; // annuli are disjoint by validation
            }
          }
        }
        d[rowOff + px] = v;
      }
    }
    return img;
  }

  function clamp01(u) { return u < 0 ? 0 : (u > 1 ? 1 : u); }

  /* Render a sequence [f0, f0+n) sharing schedules/modules.
     opts.carousels: payload-mode symbol carousels (fountain.encodeCarousels). */
  function renderSequence(profile, n, opts) {
    opts = opts || {};
    var schedules = buildSchedules(profile, n, opts.carousels);
    if (isV3(profile)) {
      // Steady-state sequence; countdown weaving is the emit page's job via
      // timeline(). One beacon schedule and one envelope serve every frame.
      var envB = opts.envBytes || envelopeBytes(profile, opts.payloadInfo || null);
      var beaconSchedule = opts.beaconSchedule !== undefined ? opts.beaconSchedule : buildBeaconSchedule(profile, n, envB);
      var layout = tileLayout(profile);
      if (layout.n > 1) {
        // Per-tile carousels (tile-shifted seeds; same payload blocks) and
        // per-tile schedules. opts.payloadBytes triggers payload mode; a
        // seeded reference stream per tile otherwise.
        var FN2 = FN();
        var schedulesT = [];
        for (var tt = 0; tt < layout.n; tt++) {
          var carT = opts.payloadBytes !== undefined && opts.payloadBytes !== null
            ? FN2.encodeCarousels(profile, opts.payloadBytes, { tile: tt }).carousels
            : (opts.carouselsT ? opts.carouselsT[tt] : undefined);
          schedulesT.push(buildSchedules(profile, n, carT));
        }
        var framesT = [];
        for (var ft = 0; ft < n; ft++)
          framesT.push({ f: ft, img: renderFrameV3Tiled(profile, ft, { trig: opts.trig, schedulesT: schedulesT, beaconSchedule: beaconSchedule, envBytes: envB }) });
        return { frames: framesT, schedulesT: schedulesT, beaconSchedule: beaconSchedule };
      }
      // opts.payloadBytes triggers payload mode here exactly as in the tiled
      // branch (it used to be tiled-only — an untiled payloadBytes sequence
      // silently emitted the seeded REFERENCE stream: preamble locks, every
      // droplet CRC fails; the T24 referee caught it).
      if (opts.payloadBytes !== undefined && opts.payloadBytes !== null && !opts.carousels)
        schedules = buildSchedules(profile, n, FN().encodeCarousels(profile, opts.payloadBytes).carousels);
      var frames3 = [];
      for (var f3 = 0; f3 < n; f3++)
        frames3.push({ f: f3, img: renderFrameV3(profile, f3, { trig: opts.trig, schedules: schedules, beaconSchedule: beaconSchedule, envBytes: envB }) });
      return { frames: frames3, schedules: schedules, beaconSchedule: beaconSchedule };
    }
    var modules = fiducialModules(profile.fiducial);
    var frames = [];
    for (var f = 0; f < n; f++)
      frames.push({ f: f, img: renderFrame(profile, f, { trig: opts.trig, schedules: schedules, modules: modules }) });
    return { frames: frames, schedules: schedules };
  }

  /* Browser helper: luminance image -> ImageData (RGBA gray). */
  function toImageData(img, imageData) {
    var n = img.w * img.h, src = img.data, out = imageData.data;
    for (var i = 0; i < n; i++) {
      var g = Math.round(clamp01(src[i]) * 255);
      var o = i * 4; out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
    }
    return imageData;
  }

  var API = {
    wrapSigned: wrapSigned, buildSchedule: buildSchedule, buildSchedules: buildSchedules,
    phaseAt: phaseAt, fiducialModules: fiducialModules, renderFrame: renderFrame,
    renderSequence: renderSequence, toImageData: toImageData, TAU: TAU,
    isV3: isV3, envelopeBytes: envelopeBytes, envelopeModules: envelopeModules,
    beaconSymbols: beaconSymbols, buildBeaconSchedule: buildBeaconSchedule,
    timeline: timeline, renderFrameV3: renderFrameV3, renderFrameV3Tiled: renderFrameV3Tiled,
    tileLayout: tileLayout, centerMeans: centerMeans, bullseyeCov: bullseyeCov, quadrantCov: quadrantCov
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.emission = API;
})(typeof window !== "undefined" ? window : globalThis);
