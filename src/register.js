/* register.js — stage 2: find EVERY fiducial in the frame (spec §5.1: never write a
   decoder that finds *a* fiducial). Finder-pattern detection is the classic
   1:1:3:1:1 run-length scan (plain JS, no QR library — C8). Output: one candidate
   emitter per finder triple, each with its own canonical→image homography.
   Canonical frame: x right, y down, origin at fiducial centre, unit = fiducial
   width. Finder centres: TL(−0.36,−0.36), TR(+0.36,−0.36), BL(−0.36,+0.36)
   (3.5/25 = 0.14 from the edge of a 25-module fiducial). */
(function (global) {
  "use strict";

  function G() { return (typeof module !== "undefined" && module.exports) ? require("./geom.js") : global.OC.geom; }

  var FC = 0.5 - 3.5 / 25; // 0.36

  function threshold(img) {
    // Percentile midpoint over a subsample — robust to the low-contrast annuli.
    var d = img.data, n = img.w * img.h, step = Math.max(1, Math.floor(n / 20000));
    var vals = [];
    for (var i = 0; i < n; i += step) vals.push(d[i]);
    vals.sort(function (a, b) { return a - b; });
    var lo = vals[Math.floor(vals.length * 0.02)], hi = vals[Math.floor(vals.length * 0.98)];
    return (lo + hi) / 2;
  }

  function ratioOK(w, u) {
    return Math.abs(w[0] - u) <= 0.75 * u && Math.abs(w[1] - u) <= 0.75 * u &&
           Math.abs(w[2] - 3 * u) <= 1.5 * u &&
           Math.abs(w[3] - u) <= 0.75 * u && Math.abs(w[4] - u) <= 0.75 * u;
  }

  /* Scan one line (array of booleans dark) for 1:1:3:1:1; call cb(centerIdx, unit). */
  function scanLine(dark, len, cb) {
    var runs = [], runStart = 0, cur = dark(0);
    for (var i = 1; i < len; i++) {
      var v = dark(i);
      if (v !== cur) { runs.push({ v: cur, s: runStart, w: i - runStart }); runStart = i; cur = v; }
    }
    runs.push({ v: cur, s: runStart, w: len - runStart });
    for (var r = 0; r + 4 < runs.length; r++) {
      if (!runs[r].v) continue; // pattern starts dark
      var w = [runs[r].w, runs[r + 1].w, runs[r + 2].w, runs[r + 3].w, runs[r + 4].w];
      var total = w[0] + w[1] + w[2] + w[3] + w[4];
      var u = total / 7;
      if (u < 1.2) continue;
      if (ratioOK(w, u)) cb(runs[r + 2].s + runs[r + 2].w / 2, u);
    }
  }

  function crossCheck(img, thr, cx, cy, unit) {
    // Verify the vertical profile through (cx, cy) shows the same pattern; refine cy.
    var half = Math.ceil(unit * 5), h = img.h, w = img.w;
    var y0 = Math.max(0, Math.round(cy - half)), y1 = Math.min(h - 1, Math.round(cy + half));
    var x = Math.round(cx);
    if (x < 0 || x >= w) return null;
    var found = null;
    scanLine(function (i) { return img.data[(y0 + i) * w + x] < thr; }, y1 - y0 + 1, function (c, u) {
      var yC = y0 + c;
      if (Math.abs(yC - cy) < unit * 2.5 && (!found || Math.abs(yC - cy) < Math.abs(found.y - cy)))
        found = { y: yC, u: u };
    });
    return found;
  }

  function findFinderCandidates(img, opts) {
    opts = opts || {};
    var thr = opts.thr !== undefined ? opts.thr : threshold(img);
    var stride = opts.rowStride || 2;
    var cands = [];
    for (var y = 0; y < img.h; y += stride) {
      (function (yy) {
        scanLine(function (i) { return img.data[yy * img.w + i] < thr; }, img.w, function (cx, u) {
          var v = crossCheck(img, thr, cx, yy, u);
          if (!v) return;
          if (Math.abs(v.u - u) > 0.7 * u) return;
          cands.push({ x: cx, y: v.y, unit: (u + v.u) / 2 });
        });
      })(y);
    }
    // Merge candidates within 3 units.
    var merged = [];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i], hit = null;
      for (var j = 0; j < merged.length; j++) {
        var m = merged[j];
        if (Math.abs(m.x - c.x) < 3 * m.unit && Math.abs(m.y - c.y) < 3 * m.unit) { hit = m; break; }
      }
      if (hit) { hit.x = (hit.x * hit.n + c.x) / (hit.n + 1); hit.y = (hit.y * hit.n + c.y) / (hit.n + 1); hit.unit = (hit.unit * hit.n + c.unit) / (hit.n + 1); hit.n++; }
      else merged.push({ x: c.x, y: c.y, unit: c.unit, n: 1 });
    }
    return merged.filter(function (m) { return m.n >= 2; });
  }

  /* Group candidates into triples: corner + two arms, equal length, ~90°. */
  function groupTriples(cands) {
    var out = [], used = {};
    var idx = [];
    for (var a = 0; a < cands.length; a++) idx.push(a);
    var combos = [];
    for (var i = 0; i < cands.length; i++)
      for (var j = i + 1; j < cands.length; j++)
        for (var k = j + 1; k < cands.length; k++) combos.push([i, j, k]);
    for (var c = 0; c < combos.length; c++) {
      var t = combos[c], A2 = cands[t[0]], B = cands[t[1]], C = cands[t[2]];
      var uMean = (A2.unit + B.unit + C.unit) / 3;
      if (Math.max(A2.unit, B.unit, C.unit) / Math.min(A2.unit, B.unit, C.unit) > 1.6) continue;
      // Try each point as corner.
      var best = null;
      var pts = [A2, B, C];
      for (var corner = 0; corner < 3; corner++) {
        var P0 = pts[corner], P1 = pts[(corner + 1) % 3], P2 = pts[(corner + 2) % 3];
        var v1 = [P1.x - P0.x, P1.y - P0.y], v2 = [P2.x - P0.x, P2.y - P0.y];
        var l1 = Math.hypot(v1[0], v1[1]), l2 = Math.hypot(v2[0], v2[1]);
        if (l1 < 6 * uMean || l2 < 6 * uMean) continue;
        if (Math.max(l1, l2) / Math.min(l1, l2) > 1.35) continue;
        var cosang = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2);
        if (Math.abs(cosang) > 0.30) continue;
        // Arm length should be ~0.72 fiducial widths; unit ~ width/25 → arms/unit ≈ 18.
        var armUnits = ((l1 + l2) / 2) / uMean;
        if (armUnits < 12 || armUnits > 26) continue;
        var score = Math.abs(cosang) + Math.abs(l1 - l2) / (l1 + l2);
        if (!best || score < best.score) best = { corner: P0, p1: P1, p2: P2, score: score };
      }
      if (best) out.push(best);
    }
    out.sort(function (a, b) { return a.score - b.score; });
    var final = [];
    for (var o = 0; o < out.length; o++) {
      var tr = out[o];
      var key = [tr.corner, tr.p1, tr.p2].map(function (p) { return Math.round(p.x) + "," + Math.round(p.y); }).sort().join("|");
      var members = [tr.corner, tr.p1, tr.p2];
      var clash = members.some(function (p) { return used[Math.round(p.x) + "," + Math.round(p.y)]; });
      if (clash) continue;
      members.forEach(function (p) { used[Math.round(p.x) + "," + Math.round(p.y)] = true; });
      final.push(tr);
      void key;
    }
    return final;
  }

  /* Orient a triple and build the canonical→image homography (affine; the 4th corner
     is parallelogram-completed — adequate near-frontal, refine later for steep warp). */
  function emitterFromTriple(tr) {
    var A = tr.corner, P1 = tr.p1, P2 = tr.p2;
    var cross = (P1.x - A.x) * (P2.y - A.y) - (P1.y - A.y) * (P2.x - A.x);
    var TR2 = cross > 0 ? P1 : P2;  // canonical (y down): TL→TR × TL→BL has positive cross
    var BL = cross > 0 ? P2 : P1;
    var chirality = 1;
    // (If both assignments were negative the frame is mirrored — registration still
    // returns a homography; C9 says the flip is CONFIG, never auto-detected. The
    // pipeline flips the frame before registration when mirror.receive is set.)
    var D = { x: TR2.x + BL.x - A.x, y: TR2.y + BL.y - A.y };
    var H = G().homographyFromPoints(
      [[-FC, -FC], [FC, -FC], [-FC, FC], [FC, FC]],
      [[A.x, A.y], [TR2.x, TR2.y], [BL.x, BL.y], [D.x, D.y]]
    );
    if (!H) return null;
    var unit = (A.unit + TR2.unit + BL.unit) / 3;
    return { H: H, moduleSizePx: unit, fiducialWidthPx: unit * 25, chirality: chirality, corners: { TL: A, TR: TR2, BL: BL } };
  }

  /* Decoy-robust triple verification: geometry alone accepts fakes (ring chords,
     collars, clutter — two incidents in one evening). The fiducial's TIMING
     pattern (row/col 6, alternating dark/light between finders) is a signature
     no decoy carries: sample the 18 timing cells through the candidate H,
     self-normalize (C2 posture), and score the alternation. */
  function timingScore(img, H) {
    var g = G();
    var vals = [], expected = [];
    for (var t = 8; t <= 16; t++) {
      var cx = -0.5 + (t + 0.5) / 25, cy = -0.5 + 6.5 / 25;
      var p1 = g.applyH(H, cx, cy);
      vals.push(g.bilinear(img, p1[0], p1[1])); expected.push(t % 2 === 0);
      var p2 = g.applyH(H, -0.5 + 6.5 / 25, -0.5 + (t + 0.5) / 25);
      vals.push(g.bilinear(img, p2[0], p2[1])); expected.push(t % 2 === 0);
    }
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < vals.length; i++) { if (vals[i] < lo) lo = vals[i]; if (vals[i] > hi) hi = vals[i]; }
    if (hi - lo < 1e-6) return 0;
    var mid = (lo + hi) / 2, match = 0;
    for (var j = 0; j < vals.length; j++) if ((vals[j] < mid) === expected[j]) match++;
    return match / vals.length;
  }

  /* Blur-tolerant structure check: the 3 finder centres must read DARK against
     the quiet zone's LIGHT — low-frequency features that survive heavy blur
     (the timing cells do not; σ2.4 erases their alternation). */
  function structureScore(img, H) {
    var g = G();
    var pts = [
      [-FC, -FC, true], [FC, -FC, true], [-FC, FC, true],          // finder centres: dark
      [0.58, 0, false], [-0.58, 0, false], [0, 0.58, false], [0, -0.58, false] // quiet: light
    ];
    var vals = [], lo = Infinity, hi = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var p = g.applyH(H, pts[i][0], pts[i][1]);
      var v = g.bilinear(img, p[0], p[1]);
      vals.push(v);
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    if (hi - lo < 1e-6) return 0;
    var mid = (lo + hi) / 2, match = 0;
    for (var j = 0; j < pts.length; j++) if ((vals[j] < mid) === pts[j][2]) match++;
    return match / pts.length;
  }

  /* ================= Ring registration (finder-less fallback) =================
     Walks 4–5 proved the failure order: the 25-module fiducial dies first
     (module-scale smear / geometric floor) while the RINGS — ten times
     coarser — stay perfectly legible. So register on the rings themselves:
       1. VOTE for centers: every circular edge's gradient ray passes through
          the center regardless of polarity or rotation; straight-edge clutter
          spreads into ridges, concentric structure into point peaks.
       2. SCALE from the radial profile: the three dark bands at the profile's
          known radii are a coarse, specific signature (the radial cousin of
          1:1:3:1:1), matched by normalized correlation over log-spaced scales.
       3. VERIFY per the decoy discipline: band-vs-gap darkness coverage over
          the full circle — a clock face or bezel ghost has no such profile.
       4. REFINE with the emission's own physics: the measured k=1 boundary
          coefficient IS the centering error (F5b's diagnostic becomes the
          corrector), and the mean radius calibrates scale.
     Rotation is deliberately unresolved: DPSK differencing absorbs a constant
     roll, so the similarity H uses rotation 0. Mirror stays config (C9).
     Limitation: the outer ring must lie mostly in frame. */

  function SAMP() { return (typeof module !== "undefined" && module.exports) ? require("./sample.js") : global.OC.sample; }

  function ringRegisterAll(img, profile, opts) {
    opts = opts || {};
    var maxE = opts.maxEmitters || 4;
    var annuli = profile.annuli;
    // Dark-band spans + the outer radius + the refine target. v2: annuli ARE
    // bands (r_inner→r0), outer ring's modulated boundary refines. v3: annuli
    // are EDGES — bands come from profile.bands at nominal radii, and the
    // refine target is THE FLAT CIRCLE at 3.00 (the units anchor, §4: measured
    // every frame with no modulation to average — sampleBoundary with an empty
    // harmonic set and sum 0 is exactly that gauge).
    var isV3 = !!(profile.bands && profile.plate);
    var spans, rOutU, refineA, refineR;
    if (isV3) {
      spans = profile.bands.map(function (b) {
        var lo = b.lo.edge !== undefined ? annuli[b.lo.edge].r0 : b.lo.fixed;
        var hi = b.hi.edge !== undefined ? annuli[b.hi.edge].r0 : b.hi.fixed;
        return [lo, hi];
      });
      rOutU = profile.flat_circle_r;
      refineR = rOutU;
      // amplitudes here only widen sampleWindow's search span (±0.14): the
      // NCC scale grid steps ~3%, and a 3% error puts the crossing outside a
      // bare ±0.08 window. The circle itself is unmodulated.
      refineA = { r0: rOutU, crossing: "up", boundary: { harmonics: [], amplitudes: [0.06], phases_deg: [] } };
    } else {
      spans = annuli.map(function (a) { return [a.r_inner, a.r0]; });
      var outerA = annuli[annuli.length - 1];
      rOutU = outerA.r0;
      refineR = rOutU;
      refineA = outerA;
    }

    // --- decimate for the vote/profile passes ---
    var dec = Math.max(1, Math.ceil(Math.max(img.w, img.h) / 640));
    var W = Math.floor(img.w / dec), H = Math.floor(img.h / dec);
    if (W < 32 || H < 32) return [];
    var lum = new Float64Array(W * H);
    for (var y = 0; y < H; y++)
      for (var x = 0; x < W; x++) {
        var s0 = 0;
        for (var dy = 0; dy < dec; dy++)
          for (var dx = 0; dx < dec; dx++)
            s0 += img.data[(y * dec + dy) * img.w + (x * dec + dx)];
        lum[y * W + x] = s0 / (dec * dec);
      }

    // --- gradients + edge threshold (percentile of magnitude) ---
    var mags = [], gxA = new Float64Array(W * H), gyA = new Float64Array(W * H);
    for (var y2 = 1; y2 < H - 1; y2++)
      for (var x2 = 1; x2 < W - 1; x2++) {
        var i2 = y2 * W + x2;
        var gx = lum[i2 + 1] - lum[i2 - 1];
        var gy = lum[i2 + W] - lum[i2 - W];
        gxA[i2] = gx; gyA[i2] = gy;
        var m = Math.hypot(gx, gy);
        if (m > 0) mags.push(m);
      }
    if (mags.length < 100) return [];
    mags.sort(function (a, b) { return a - b; });
    var thrG = mags[Math.floor(mags.length * 0.92)];

    // --- center vote: walk both ways along the gradient line ---
    var acc = new Float64Array(W * H);
    var rMin = 5, rMax = 0.6 * Math.min(W, H);
    for (var y3 = 1; y3 < H - 1; y3++)
      for (var x3 = 1; x3 < W - 1; x3++) {
        var i3 = y3 * W + x3;
        var m3 = Math.hypot(gxA[i3], gyA[i3]);
        if (m3 < thrG) continue;
        var ux = gxA[i3] / m3, uy = gyA[i3] / m3;
        for (var t = rMin; t < rMax; t += 2) {
          for (var sgn = -1; sgn <= 1; sgn += 2) {
            var px = Math.round(x3 + sgn * ux * t), py = Math.round(y3 + sgn * uy * t);
            if (px >= 0 && px < W && py >= 0 && py < H) acc[py * W + px] += 1;
          }
        }
      }
    // light smooth (two 3×3 box passes)
    for (var pass = 0; pass < 2; pass++) {
      var sm = new Float64Array(W * H);
      for (var y4 = 1; y4 < H - 1; y4++)
        for (var x4 = 1; x4 < W - 1; x4++) {
          var a4 = 0;
          for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) a4 += acc[(y4 + oy) * W + x4 + ox];
          sm[y4 * W + x4] = a4 / 9;
        }
      acc = sm;
    }

    // --- top-K peaks with suppression ---
    var peaks = [];
    var minSep = Math.max(24, Math.floor(0.12 * Math.min(W, H)));
    var work = new Float64Array(acc);
    for (var k2 = 0; k2 < maxE * 2 && peaks.length < maxE * 2; k2++) {
      var bi = -1, bv = 0;
      for (var i4 = 0; i4 < W * H; i4++) if (work[i4] > bv) { bv = work[i4]; bi = i4; }
      if (bi < 0 || bv <= 0) break;
      var pxk = bi % W, pyk = (bi - pxk) / W;
      peaks.push({ x: pxk, y: pyk, v: bv });
      for (var yy = Math.max(0, pyk - minSep); yy < Math.min(H, pyk + minSep); yy++)
        for (var xx = Math.max(0, pxk - minSep); xx < Math.min(W, pxk + minSep); xx++)
          work[yy * W + xx] = 0;
    }

    // --- per peak: radial profile → scale by template NCC → coverage verify ---
    var NANG = 48;
    var cosT = [], sinT = [];
    for (var a5 = 0; a5 < NANG; a5++) { cosT.push(Math.cos(2 * Math.PI * a5 / NANG)); sinT.push(Math.sin(2 * Math.PI * a5 / NANG)); }
    var bilin = function (fx, fy) {
      if (fx < 0 || fy < 0 || fx > W - 1.001 || fy > H - 1.001) return NaN;
      var x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      var i0 = y0 * W + x0;
      return lum[i0] * (1 - tx) * (1 - ty) + lum[i0 + 1] * tx * (1 - ty) + lum[i0 + W] * (1 - tx) * ty + lum[i0 + W + 1] * tx * ty;
    };
    var inBand = function (u) {
      for (var bi2 = 0; bi2 < spans.length; bi2++)
        if (u >= spans[bi2][0] && u <= spans[bi2][1]) return true;
      return false;
    };
    var found = [];
    for (var p5 = 0; p5 < peaks.length && found.length < maxE; p5++) {
      var pk = peaks[p5];
      var rProfMax = Math.floor(0.7 * Math.min(W, H));
      var prof = new Float64Array(rProfMax + 1);
      for (var r5 = 2; r5 <= rProfMax; r5++) {
        var vals = [];
        for (var a6 = 0; a6 < NANG; a6++) {
          var v6 = bilin(pk.x + r5 * cosT[a6], pk.y + r5 * sinT[a6]);
          if (!isNaN(v6)) vals.push(v6);
        }
        if (vals.length < NANG * 0.5) { prof[r5] = NaN; continue; }
        vals.sort(function (a, b) { return a - b; });
        var lo6 = Math.floor(vals.length * 0.17), hi6 = Math.ceil(vals.length * 0.83), s6 = 0;
        for (var t6 = lo6; t6 < hi6; t6++) s6 += vals[t6];
        prof[r5] = s6 / (hi6 - lo6);
      }
      // scale search: NCC of two-level template over the emission's radial span
      var sMinC = 6, sMaxC = rProfMax / (rOutU + 0.15);
      if (sMaxC <= sMinC) continue;
      var best = null;
      for (var st = 0; st < 48; st++) {
        var sc = sMinC * Math.pow(sMaxC / sMinC, st / 47);
        var xs = [], ys = [];
        for (var r7 = Math.max(2, Math.round(0.7 * sc)); r7 <= Math.min(rProfMax, Math.round((rOutU + 0.12) * sc)); r7++) {
          if (isNaN(prof[r7])) continue;
          xs.push(inBand(r7 / sc) ? 1 : 0);
          ys.push(prof[r7]);
        }
        if (xs.length < 20) continue;
        var mx = 0, my = 0;
        for (var i7 = 0; i7 < xs.length; i7++) { mx += xs[i7]; my += ys[i7]; }
        mx /= xs.length; my /= ys.length;
        var num = 0, dx7 = 0, dy7 = 0;
        for (var i8 = 0; i8 < xs.length; i8++) {
          var ax = xs[i8] - mx, ay = ys[i8] - my;
          num += ax * ay; dx7 += ax * ax; dy7 += ay * ay;
        }
        // A near-FLAT profile makes normalized correlation meaningless (÷~0
        // variance → ±1 on noise) — the T17c false-positive. Real ink is a
        // 0.3-deep modulation; require material variance before correlating.
        var norm7 = img.norm || 1;
        if (dx7 <= 0 || Math.sqrt(dy7 / xs.length) / norm7 < 0.015) continue;
        var ncc = -num / Math.sqrt(dx7 * dy7); // bands are DARK: anticorrelation is the match
        if (!best || ncc > best.ncc) best = { s: sc, ncc: ncc };
      }
      if (!best || best.ncc < 0.5) continue;
      // Absolute modulation depth at the chosen scale: gap radii must be
      // MATERIALLY brighter than band radii (ink is 0.3 deep; ask for 0.04).
      var bSum = 0, bN = 0, gSum = 0, gN = 0;
      for (var rD = Math.max(2, Math.round(0.7 * best.s)); rD <= Math.min(rProfMax, Math.round((rOutU + 0.12) * best.s)); rD++) {
        if (isNaN(prof[rD])) continue;
        if (inBand(rD / best.s)) { bSum += prof[rD]; bN++; } else { gSum += prof[rD]; gN++; }
      }
      if (!bN || !gN) continue;
      if ((gSum / gN - bSum / bN) / (img.norm || 1) < 0.04) continue;
      // coverage: per annulus, band midpoint darker than the gap beyond it, per angle
      var covs = [], covSum = 0;
      var okCov = true;
      for (var a8 = 0; a8 < spans.length; a8++) {
        var sp8 = spans[a8];
        var rBand = ((sp8[0] + sp8[1]) / 2) * best.s;
        var gapU = a8 + 1 < spans.length ? (sp8[1] + spans[a8 + 1][0]) / 2 : sp8[1] + 0.35;
        var rGap = gapU * best.s;
        var hits = 0, tries = 0;
        for (var a9 = 0; a9 < NANG; a9++) {
          var vb = bilin(pk.x + rBand * cosT[a9], pk.y + rBand * sinT[a9]);
          var vg = bilin(pk.x + rGap * cosT[a9], pk.y + rGap * sinT[a9]);
          if (isNaN(vb) || isNaN(vg)) continue;
          tries++;
          if (vb < vg - 1e-9) hits++;
        }
        var cov = tries ? hits / tries : 0;
        covs.push(cov); covSum += cov;
        if (cov < 0.6) okCov = false;
      }
      if (!okCov || covSum / spans.length < 0.72) continue;

      // --- promote to full-res similarity H, then physics refinement ---
      var sFull = best.s * dec;
      var cxF = (pk.x + 0.5) * dec, cyF = (pk.y + 0.5) * dec;
      var mkH = function (cx, cy, s) { return [s, 0, cx, 0, s, cy, 0, 0, 1]; };
      var Hc = mkH(cxF, cyF, sFull);
      var samp = SAMP();
      for (var it = 0; it < 3; it++) {
        var sb = samp.sampleBoundary(img, Hc, refineA);
        if (sb.found < sb.N * 0.5) break;
        var n9 = 0, mean9 = 0;
        for (var i9 = 0; i9 < sb.N; i9++) if (!isNaN(sb.r[i9])) { mean9 += sb.r[i9]; n9++; }
        mean9 /= n9;
        var dxU = 0, dyU = 0;
        for (var i10 = 0; i10 < sb.N; i10++) {
          if (isNaN(sb.r[i10])) continue;
          var th10 = 2 * Math.PI * i10 / sb.N;
          dxU += (sb.r[i10] - mean9) * Math.cos(th10);
          dyU += (sb.r[i10] - mean9) * Math.sin(th10);
        }
        dxU *= 2 / n9; dyU *= 2 / n9;
        cxF += sFull * dxU; cyF += sFull * dyU;
        sFull *= mean9 / refineR;
        Hc = mkH(cxF, cyF, sFull);
        if (Math.abs(dxU) < 0.003 && Math.abs(dyU) < 0.003 && Math.abs(mean9 / refineR - 1) < 0.003) break;
      }
      // duplicate suppression vs already-found (full-res coords)
      var dup = false;
      for (var f10 = 0; f10 < found.length; f10++) {
        var g10 = found[f10];
        if (Math.hypot(g10.cx - cxF, g10.cy - cyF) < 1.5 * Math.max(sFull, g10.s)) { dup = true; break; }
      }
      if (dup) continue;
      found.push({ cx: cxF, cy: cyF, s: sFull, ncc: best.ncc, coverage: covSum / spans.length, H: Hc });
    }

    // --- emitter objects shaped like the finder path's ---
    var g = G();
    return found.map(function (f) {
      var mk = function (ux, uy) { var p = g.applyH(f.H, ux, uy); return { x: p[0], y: p[1], unit: f.s / 25 }; };
      return {
        H: f.H, moduleSizePx: f.s / 25, fiducialWidthPx: f.s, chirality: 1,
        corners: { TL: mk(-FC, -FC), TR: mk(FC, -FC), BL: mk(-FC, FC) },
        method: "rings", timingScore: f.coverage, structureScore: f.ncc
      };
    });
  }

  /* The stage-2 entry point: all emitters in the frame. Acceptance: rank all
     geometric triples by timing+structure; the BEST is accepted on structure
     alone (blur-tolerant — a real fiducial outranks ring/collar decoys whenever
     its timing resolves, and still verifies structurally when blur erases the
     timing). ADDITIONAL emitters (multi-emitter/§5.1, decoy-exposed) must pass
     the strict timing signature too. When the finder path comes up EMPTY and
     the caller supplied the emission profile, fall back to ring registration
     (the fiducial dies before the rings — walks 4–5). */
  function registerAll(img, opts) {
    opts = opts || {};
    // v3: the steady plate carries NO fiducial — its band silhouette is the
    // PRIMARY registration. The corner bullseyes sit at exactly a virtual
    // fiducial's TL/TR/BL layout (dark centers, right angle), so on a
    // multi-tile plate the finder scan can chance-accept decoy triples —
    // T23b caught two on the 6-up frame (the AF-collar decoy lesson, third
    // appearance). Rings first; the finder path remains the COUNTDOWN
    // assist — QR frames, the far-field envelope rung, where rings may die
    // while the QR still reads.
    var pV3 = opts.profile;
    var isV3reg = !!(pV3 && pV3.bands && pV3.plate);
    // qr_persistent (diagnostic): the QR is guaranteed present, so the
    // finder path leads again (it is the perspective-capable one) and rings
    // return to being the fallback — the v2-proven order, deliberately.
    if (isV3reg && !pV3.qr_persistent && !opts.noRings) {
      var ringed3 = ringRegisterAll(img, pV3, opts);
      if (ringed3.length) return { emitters: ringed3, candidates: [], method: "rings" };
    }
    var cands = findFinderCandidates(img, opts);
    var triples = groupTriples(cands);
    var scored = [];
    for (var i = 0; i < triples.length; i++) {
      var e = emitterFromTriple(triples[i]);
      if (!e) continue;
      e.timingScore = timingScore(img, e.H);
      e.structureScore = structureScore(img, e.H);
      scored.push(e);
    }
    // v3 countdown frames: the envelope QR spans qr.width_units (≠ 1) in
    // plate units, but the triple's H maps QR-width units. Rescale so every
    // consumer keeps sampling in plate units — applyH(H', x, y) ≡
    // applyH(H, x/w, y/w).
    var p3 = opts.profile;
    if (p3 && p3.bands && p3.plate && p3.qr && p3.qr.width_units !== 1) {
      var w3 = p3.qr.width_units;
      for (var si = 0; si < scored.length; si++) {
        var Hs = scored[si].H;
        scored[si].H = [Hs[0] / w3, Hs[1] / w3, Hs[2], Hs[3] / w3, Hs[4] / w3, Hs[5], Hs[6] / w3, Hs[7] / w3, Hs[8]];
      }
    }
    scored.sort(function (a, b) { return (b.timingScore + b.structureScore) - (a.timingScore + a.structureScore); });
    var emitters = [];
    for (var k = 0; k < scored.length; k++) {
      var s = scored[k];
      if (emitters.length === 0) {
        if (s.structureScore >= 0.7) emitters.push(s);
      } else if (s.timingScore >= 0.6 && s.structureScore >= 0.7) emitters.push(s);
    }
    if (!emitters.length && opts.profile && !opts.noRings && (!isV3reg || pV3.qr_persistent)) {
      var ringed = ringRegisterAll(img, opts.profile, opts);
      if (ringed.length) return { emitters: ringed, candidates: cands, method: "rings" };
    }
    return { emitters: emitters, candidates: cands };
  }

  var API = { registerAll: registerAll, ringRegisterAll: ringRegisterAll, findFinderCandidates: findFinderCandidates, groupTriples: groupTriples, threshold: threshold, FC: FC };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.register = API;
})(typeof window !== "undefined" ? window : globalThis);
