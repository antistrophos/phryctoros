/* saddle.js — quadrant swap-target detection + constellation solve
   (v3.1 amendment 2: saddle-first registration).

   The mark: a disc of radius R whose quadrants alternate shade/background,
   polarity inverted inside the swap circle at 0.5R (emission.quadrantCov).
   Three properties carry the whole design:
     1. The crossing point is PROJECTIVELY EXACT — the two boundary lines map
        to lines under any homography, so their intersection is the true
        projected center. No eccentricity bias (the failure that killed the
        circle-center DLT at angle).
     2. The pattern is CENTRALLY SYMMETRIC, and central symmetry survives any
        linear map — so odd angular harmonics vanish at ANY pose. The
        detector's |c2| >> |c1|,|c3| gate is tilt-immune, and it is the
        anti-decoy discriminator: QR corners and texture junk have no such
        symmetry.
     3. The swap circle gives a radial 2nd-harmonic profile with two lobes in
        ANTI-PHASE — a signature no accidental saddle (QR module diagonals
        included) reproduces, plus a size estimate (flip radius = 0.5R).

   Detection: pyramid ring-response scan (16-point rings, radius 5px/level)
   → per-candidate radial-profile verify → cross-selective Förstner subpixel
   (gradients on the crossing lines vote for the center; ring/ellipse edges,
   whose gradients run radial, are weighted out — keeping the refined point
   exact under tilt). Constellation: 4-subset enumeration ordered by angle,
   scored by the fold's φ2 pattern (each plate corner is oriented radially
   from plate center, so diagonal pairs share polarity — roll resolves mod
   180°, which DPSK absorbs) + per-corner scale coherence + a flat-circle
   band-contrast gate. Mirrored captures produce reversed winding and fall
   through to ring registration, which is mirror-invariant. */
(function (global) {
  "use strict";

  function G() { return (typeof module !== "undefined" && module.exports) ? require("./geom.js") : global.OC.geom; }

  var NS = 16, RESP_RHO = 5;
  var COS = [], SIN = [], C1R = [], C1I = [], C2R = [], C2I = [], C3R = [], C3I = [];
  (function () {
    for (var k = 0; k < NS; k++) {
      var th = 2 * Math.PI * k / NS;
      COS.push(Math.cos(th)); SIN.push(Math.sin(th));
      C1R.push(Math.cos(th)); C1I.push(-Math.sin(th));
      C2R.push(Math.cos(2 * th)); C2I.push(-Math.sin(2 * th));
      C3R.push(Math.cos(3 * th)); C3I.push(-Math.sin(3 * th));
    }
  })();

  function wrapPi(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  /* Angular harmonics 1..3 on a 16-sample ring about (cx, cy). Returns null
     when the ring leaves the frame. phi2 = arg Σ (I−mean)·e^{−2iθ}; for a
     quadrant mark whose DARK diagonal sits at image angle β this reads
     π − 2β (asserted empirically by T24b — the convention the constellation
     scorer encodes). */
  function ringHarm(img, cx, cy, rho) {
    var w = img.w, h = img.h, d = img.data;
    if (cx - rho < 1 || cy - rho < 1 || cx + rho >= w - 2 || cy + rho >= h - 2) return null;
    var vals = new Float64Array(NS), m = 0;
    for (var k = 0; k < NS; k++) {
      var x = cx + rho * COS[k], y = cy + rho * SIN[k];
      var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      var o = y0 * w + x0;
      var v = d[o] * (1 - fx) * (1 - fy) + d[o + 1] * fx * (1 - fy) +
              d[o + w] * (1 - fx) * fy + d[o + w + 1] * fx * fy;
      vals[k] = v; m += v;
    }
    m /= NS;
    var a1r = 0, a1i = 0, a2r = 0, a2i = 0, a3r = 0, a3i = 0, ss = 0;
    for (var q = 0; q < NS; q++) {
      var dv = vals[q] - m;
      ss += dv * dv;
      a1r += dv * C1R[q]; a1i += dv * C1I[q];
      a2r += dv * C2R[q]; a2i += dv * C2I[q];
      a3r += dv * C3R[q]; a3i += dv * C3I[q];
    }
    var s = 2 / NS;
    return { mean: m, rms: Math.sqrt(ss / NS),
             m1: Math.hypot(a1r, a1i) * s, m2: Math.hypot(a2r, a2i) * s, m3: Math.hypot(a3r, a3i) * s,
             re2: a2r * s, im2: a2i * s, phi2: Math.atan2(a2i, a2r) };
  }

  function downsample2(img) {
    var w2 = img.w >> 1, h2 = img.h >> 1, d = img.data;
    var out = { w: w2, h: h2, data: new Float32Array(w2 * h2) };
    for (var y = 0; y < h2; y++) {
      var o0 = (2 * y) * img.w, o1 = o0 + img.w, oo = y * w2;
      for (var x = 0; x < w2; x++) {
        var x2 = 2 * x;
        out.data[oo + x] = 0.25 * (d[o0 + x2] + d[o0 + x2 + 1] + d[o1 + x2] + d[o1 + x2 + 1]);
      }
    }
    return out;
  }

  /* Förstner subpixel: solve (Σ w·ggᵀ)·x = Σ w·ggᵀ·p over the window — the
     point every weighted gradient line passes through. crossOnly weights by
     sin⁴ of the angle between the gradient and the radius from the current
     estimate: crossing-line edges (tangential gradients) keep full weight,
     ring/ellipse edges (radial gradients) drop out — the projective-exactness
     selector. */
  function forstner(img, cx, cy, rad, crossOnly) {
    var w = img.w, h = img.h, d = img.data;
    var x0 = Math.max(1, Math.round(cx - rad)), x1 = Math.min(w - 2, Math.round(cx + rad));
    var y0 = Math.max(1, Math.round(cy - rad)), y1 = Math.min(h - 2, Math.round(cy + rad));
    if (x1 - x0 < 3 || y1 - y0 < 3) return null;
    var Sxx = 0, Sxy = 0, Syy = 0, Bx = 0, By = 0;
    for (var y = y0; y <= y1; y++) {
      var o = y * w + x0;
      for (var x = x0; x <= x1; x++, o++) {
        var gx = (d[o + 1] - d[o - 1]) * 0.5;
        var gy = (d[o + w] - d[o - w]) * 0.5;
        var g2 = gx * gx + gy * gy;
        if (g2 < 1e-8) continue;
        var wgt = 1;
        if (crossOnly) {
          var rx = x - cx, ry = y - cy, rr2 = rx * rx + ry * ry;
          if (rr2 > 1e-9) {
            var dot = gx * rx + gy * ry;
            wgt = 1 - (dot * dot) / (g2 * rr2);
            wgt *= wgt;
          }
        }
        var wxx = wgt * gx * gx, wxy = wgt * gx * gy, wyy = wgt * gy * gy;
        Sxx += wxx; Sxy += wxy; Syy += wyy;
        Bx += wxx * x + wxy * y;
        By += wxy * x + wyy * y;
      }
    }
    var det = Sxx * Syy - Sxy * Sxy;
    if (det < 1e-10) return null;
    var px = (Syy * Bx - Sxy * By) / det;
    var py = (Sxx * By - Sxy * Bx) / det;
    if (!isFinite(px) || !isFinite(py) || Math.hypot(px - cx, py - cy) > rad) return null;
    var tr = Sxx + Syy, disc = Math.sqrt(Math.max(0, tr * tr * 0.25 - det));
    var lmax = tr / 2 + disc, lmin = tr / 2 - disc;
    if (lmax <= 0 || lmin / lmax < 0.08) return null;
    return { x: px, y: py, cond: lmin / lmax };
  }

  /* Cheap 2D-structure check for a scan hit: the gradient structure tensor's
     eigenvalue conditioning over a small window. A straight edge through the
     ring center is ALSO pure 2nd harmonic (the flooded-scan lesson: every
     point along a boundary line ties a true crossing on |c2| alone), but its
     tensor is rank-1; a crossing is 2D. */
  function structure2D(img, cx, cy, rad) {
    var w = img.w, h = img.h, d = img.data;
    var x0 = Math.max(1, cx - rad), x1 = Math.min(w - 2, cx + rad);
    var y0 = Math.max(1, cy - rad), y1 = Math.min(h - 2, cy + rad);
    var Sxx = 0, Sxy = 0, Syy = 0;
    for (var y = y0; y <= y1; y++) {
      var o = y * w + x0;
      for (var x = x0; x <= x1; x++, o++) {
        var gx = (d[o + 1] - d[o - 1]) * 0.5;
        var gy = (d[o + w] - d[o - w]) * 0.5;
        Sxx += gx * gx; Sxy += gx * gy; Syy += gy * gy;
      }
    }
    var tr = Sxx + Syy;
    if (tr <= 0) return 0;
    var det = Sxx * Syy - Sxy * Sxy;
    var disc = Math.sqrt(Math.max(0, tr * tr * 0.25 - det));
    var lmax = tr / 2 + disc, lmin = tr / 2 - disc;
    return lmax > 0 ? lmin / lmax : 0;
  }

  /* One pyramid level: grid scan of the 16-point ring response. The gates:
     absolute contrast floor, |c2| ≥ 1.1·rms (quadrant signature — an ideal
     square wave reads 1.27, blur pushes it UP toward the sine's 1.41),
     |c2| ≥ 1.5·max(|c1|,|c3|) (central symmetry — tilt-immune), and 2D
     structure (rejects the boundary-line flood before the caps). */
  function scanLevel(img, opts) {
    var w = img.w, h = img.h;
    var margin = RESP_RHO + 2, step = 2;
    var floorRms = opts.contrastFloor !== undefined ? opts.contrastFloor : 0.015;
    var hits = [];
    for (var y = margin; y < h - margin; y += step) {
      for (var x = margin; x < w - margin; x += step) {
        var hm = ringHarm(img, x, y, RESP_RHO);
        if (!hm || hm.rms < floorRms) continue;
        if (hm.m2 < 1.1 * hm.rms) continue;
        if (hm.m2 < 1.5 * Math.max(hm.m1, hm.m3)) continue;
        if (structure2D(img, x, y, 4) < 0.15) continue;
        hits.push({ x: x, y: y, strength: hm.m2 });
      }
    }
    hits.sort(function (a, b) { return b.strength - a.strength; });
    var keep = [], cap = opts.maxPerLevel || 32;
    for (var i = 0; i < hits.length && keep.length < cap; i++) {
      var c = hits[i], sup = false;
      for (var j = 0; j < keep.length; j++)
        if (Math.abs(keep[j].x - c.x) <= 6 && Math.abs(keep[j].y - c.y) <= 6) { sup = true; break; }
      if (!sup) keep.push(c);
    }
    return keep;
  }

  /* Full-res verify + refine of one candidate. The radial φ2 profile is
     projected onto its dominant complex axis (angle-doubling estimate), which
     turns the two anti-phase lobes into a signed profile: inner lobe one
     sign, outer lobe the other, zero crossing = the swap circle. Checks: both
     lobes present (inner ≥ 0.2·outer — blur eats the inner one first), outer
     death by ~2.8× flip radius, purity at the outer peak. Then two rounds of
     cross-selective Förstner. */
  function measureAt(img, x0, y0, opts) {
    opts = opts || {};
    var c0 = forstner(img, x0, y0, 6, false);
    var cx = c0 ? c0.x : x0, cy = c0 ? c0.y : y0;
    var floorC = opts.contrastFloor !== undefined ? opts.contrastFloor : 0.015;
    var rMaxLim = opts.rMax || 96;

    var prof = [];
    for (var r = 2; r <= rMaxLim; r++) {
      var hm = ringHarm(img, cx, cy, r);
      if (!hm) break;
      prof.push(hm);
      if (prof.length > 8) {
        // stop once well past a strong outer lobe: last 3 radii all under 15% of peak
        var pk = 0;
        for (var t = 0; t < prof.length; t++) if (prof[t].m2 > pk) pk = prof[t].m2;
        var n = prof.length;
        if (pk > floorC && prof[n - 1].m2 < 0.15 * pk && prof[n - 2].m2 < 0.15 * pk && prof[n - 3].m2 < 0.15 * pk) break;
      }
    }
    if (prof.length < 5) return null;

    // dominant axis by angle doubling: ψ = arg(Σ z²)/2, z = m2·e^{iφ2}
    var zr = 0, zi = 0;
    for (var i = 0; i < prof.length; i++) {
      var p = prof[i];
      zr += p.re2 * p.re2 - p.im2 * p.im2;
      zi += 2 * p.re2 * p.im2;
    }
    var psi = 0.5 * Math.atan2(zi, zr);
    var cs = Math.cos(psi), sn = Math.sin(psi);
    var s = prof.map(function (p) { return p.re2 * cs + p.im2 * sn; });

    // extreme lobes: global min and max of the signed profile
    var iMin = 0, iMax = 0;
    for (var k = 1; k < s.length; k++) { if (s[k] < s[iMin]) iMin = k; if (s[k] > s[iMax]) iMax = k; }
    var inner = Math.min(iMin, iMax), outer = Math.max(iMin, iMax);
    var innerMag = Math.abs(s[inner]), outerMag = Math.abs(s[outer]);
    if (inner === outer || outerMag < floorC) return null;
    if (s[inner] * s[outer] >= 0) return null;                 // must be anti-phase
    if (innerMag < 0.2 * outerMag) return null;                // both lobes present
    // zero crossing between the lobes = the swap circle
    var flipI = -1;
    for (var f = inner; f < outer; f++) {
      if (s[f] * s[f + 1] <= 0) {
        flipI = f; break;
      }
    }
    if (flipI < 0) return null;
    var frac = s[flipI] === s[flipI + 1] ? 0.5 : s[flipI] / (s[flipI] - s[flipI + 1]);
    var rFlip = (2 + flipI) + frac;
    // outer death → R̂. The death must be OBSERVED inside the profile window:
    // a runaway (concentric-ring junk walking structure after structure, or a
    // frame-edge truncation) can't verify a mark.
    var died = false, rEnd = 0;
    for (var e = outer; e < s.length; e++) {
      if (Math.abs(s[e]) < 0.25 * outerMag) { rEnd = 2 + e; died = true; break; }
    }
    if (!died) return null;
    var Rhat = rEnd;
    if (Rhat / rFlip < 1.4 || Rhat / rFlip > 3.0) return null;
    // purity at the outer peak (central symmetry, pose-invariant)
    var po = prof[outer];
    if (po.m2 < 1.4 * Math.max(po.m1, po.m3)) return null;
    // central symmetry along the WHOLE mark: odd harmonics quiet at every
    // radius. An off-center point among concentric circles (the center-
    // bullseye junk class) reads a ladder of strong |c1| instead.
    var m1sum = 0;
    for (var q1 = 0; q1 <= outer; q1++) m1sum += prof[q1].m1;
    if (m1sum / (outer + 1) > 0.3 * outerMag) return null;

    // outer-lobe phase (grid orientation reference)
    var phi2 = s[outer] > 0 ? psi : psi + Math.PI;
    phi2 = Math.atan2(Math.sin(phi2), Math.cos(phi2));

    // cross-selective Förstner, window inside the swap circle
    var rad = Math.max(4, Math.min(14, 0.9 * rFlip));
    var f1 = forstner(img, cx, cy, rad, true);
    if (!f1) return null;
    var f2 = forstner(img, f1.x, f1.y, rad, true) || f1;
    return { x: f2.x, y: f2.y, phi2: phi2, rFlip: rFlip, R: Rhat,
             strength: outerMag, rms: prof[outer].rms, cond: f2.cond };
  }

  /* Pyramid detect: scan every level, map hits to full-res, verify + refine
     each at full res, dedupe. Strongest first. */
  function detect(img, opts) {
    opts = opts || {};
    var pyr = [img], maxLevels = opts.maxLevels || 4;
    while (pyr.length < maxLevels) {
      var top = pyr[pyr.length - 1];
      if (Math.min(top.w, top.h) < 96) break;
      pyr.push(downsample2(top));
    }
    var raw = [];
    for (var L = 0; L < pyr.length; L++) {
      var hits = scanLevel(pyr[L], opts);
      var fct = 1 << L, off = (fct - 1) / 2;
      for (var i = 0; i < hits.length; i++)
        raw.push({ x: hits[i].x * fct + off, y: hits[i].y * fct + off,
                   strength: hits[i].strength, level: L });
    }
    raw.sort(function (a, b) { return b.strength - a.strength; });
    var seeds = [];
    for (var r = 0; r < raw.length; r++) {
      var c = raw[r], dup = false;
      for (var m = 0; m < seeds.length; m++) {
        var tol = 3 * (1 << Math.max(c.level, seeds[m].level));
        if (Math.hypot(seeds[m].x - c.x, seeds[m].y - c.y) < tol) { dup = true; break; }
      }
      if (!dup) seeds.push(c);
    }
    var out = [], cap = opts.maxCandidates || 24;
    for (var v = 0; v < seeds.length && out.length < cap; v++) {
      var meas = measureAt(img, seeds[v].x, seeds[v].y, opts);
      if (!meas) continue;
      var dupe = false;
      for (var o = 0; o < out.length; o++)
        if (Math.hypot(out[o].x - meas.x, out[o].y - meas.y) < 3) { dupe = true; break; }
      if (dupe) continue;
      meas.level = seeds[v].level;
      out.push(meas);
    }
    out.sort(function (a, b) { return b.strength - a.strength; });
    return out;
  }

  function jacobianAt(H, x, y) {
    var w = H[6] * x + H[7] * y + H[8];
    var X = H[0] * x + H[1] * y + H[2], Y = H[3] * x + H[4] * y + H[5];
    var a = (H[0] * w - X * H[6]) / (w * w), b = (H[1] * w - X * H[7]) / (w * w);
    var c = (H[3] * w - Y * H[6]) / (w * w), d = (H[4] * w - Y * H[7]) / (w * w);
    return { a: a, b: b, c: c, d: d, det: a * d - b * c };
  }

  function ringMeanH(img, H, radiusU, g) {
    var n = 24, sum = 0, cnt = 0;
    var w = img.w, h = img.h;
    for (var k = 0; k < n; k++) {
      var th = 2 * Math.PI * k / n;
      var p = g.applyH(H, radiusU * Math.cos(th), radiusU * Math.sin(th));
      if (p[0] < 1 || p[1] < 1 || p[0] >= w - 2 || p[1] >= h - 2) continue;
      sum += g.bilinear(img, p[0], p[1]); cnt++;
    }
    if (cnt < n * 0.7) return null;
    return sum / cnt;
  }

  /* Score one correspondence hypothesis: model corners (plate units) → 4
     image candidates. Gates: positive orientation (mirror rejected), φ2
     pattern match through the local Jacobian (the fold's radial orientation
     — kills wrong rotations beyond the harmless 180°), per-corner scale
     coherence (R̂ vs Jacobian scale), then the decisive flat-circle
     band-contrast gate (C band fill inside r=2.85 vs background outside at
     r=3.20 — vote-safety against off-plate constellations). */
  function scoreHypothesis(model, pts, profile, img, g, opts) {
    var dst = pts.map(function (p) { return [p.x, p.y]; });
    var H = g.homographyFromPoints(model, dst);
    if (!H) return null;
    if (jacobianAt(H, 0, 0).det <= 0) return null;
    var cR = profile.plate.corners.r_out;
    var phiErr = 0, ratios = [];
    for (var c = 0; c < 4; c++) {
      var J = jacobianAt(H, model[c][0], model[c][1]);
      if (J.det <= 0) return null;
      var dx = 1, dy = model[c][0] * model[c][1] > 0 ? 1 : -1;   // dark diagonal, model frame
      var ix = J.a * dx + J.b * dy, iy = J.c * dx + J.d * dy;
      var expPhi = Math.PI - 2 * Math.atan2(iy, ix);
      phiErr += Math.abs(wrapPi(pts[c].phi2 - expPhi));
      ratios.push(pts[c].R / (cR * Math.sqrt(J.det)));
    }
    phiErr /= 4;
    if (phiErr > (opts.phiTol !== undefined ? opts.phiTol : 0.7)) return null;
    ratios.sort(function (a, b) { return a - b; });
    if (ratios[0] < 0.5 || ratios[3] > 2.0 || ratios[3] / ratios[0] > 2.0) return null;
    // outer reference hugs the flat circle: the emitter canvas leaves only
    // 0.084u of background beyond it (half-size 3.084), so anything farther
    // out walks off the plate's own canvas on suite frames and off-screen
    // content on field frames.
    var flatR = profile.flat_circle_r;
    var inMean = ringMeanH(img, H, flatR * 0.95, g);
    var outMean = ringMeanH(img, H, flatR + 0.06, g);
    if (inMean === null || outMean === null) return null;
    var bandContrast = outMean - inMean;
    if (bandContrast < (opts.bandContrastMin !== undefined ? opts.bandContrastMin : 0.06)) return null;
    var total = bandContrast + 0.3 * (0.7 - phiErr);
    return { total: total, H: H, phiErr: phiErr, bandContrast: bandContrast };
  }

  /* Constellation: choose 4 of ≤12 candidates, order by angle about their
     centroid (mirror winds backwards and never matches), try the 4 cyclic
     assignments, keep the best hypothesis passing every gate. */
  function constellation(cands, profile, img, opts) {
    opts = opts || {};
    if (!cands || cands.length < 4) return null;
    var g = G();
    var a = profile.plate.corners.at;
    var model = [[-a, -a], [a, -a], [a, a], [-a, a]];   // ascending atan2 about origin
    var n = Math.min(cands.length, opts.maxConstellation || 12);
    var list = cands.slice(0, n);
    var best = null, bestPts = null;
    for (var i = 0; i <= n - 4; i++)
      for (var j = i + 1; j <= n - 3; j++)
        for (var k = j + 1; k <= n - 2; k++)
          for (var l = k + 1; l <= n - 1; l++) {
            var quad = [list[i], list[j], list[k], list[l]];
            var rs = [quad[0].R, quad[1].R, quad[2].R, quad[3].R].sort(function (A, B) { return A - B; });
            if (rs[3] > 2.4 * rs[0]) continue;
            var mx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
            var my = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
            var byAng = quad.slice().sort(function (A, B) {
              return Math.atan2(A.y - my, A.x - mx) - Math.atan2(B.y - my, B.x - mx);
            });
            for (var rot = 0; rot < 4; rot++) {
              var pts = [byAng[rot], byAng[(rot + 1) % 4], byAng[(rot + 2) % 4], byAng[(rot + 3) % 4]];
              var sc = scoreHypothesis(model, pts, profile, img, g, opts);
              if (sc && (!best || sc.total > best.total)) { best = sc; bestPts = pts; }
            }
          }
    if (!best) return null;
    return { H: best.H, points: bestPts, phiErr: best.phiErr,
             bandContrast: best.bandContrast, candidates: cands.length };
  }

  /* One-call registration: detect + constellation. */
  function solve(img, profile, opts) {
    var cands = detect(img, opts);
    return constellation(cands, profile, img, opts);
  }

  /* Per-frame solve-as-tracker: project the 4 model corners through the
     current H, refine each with cross-selective Förstner, light-verify the
     anti-phase signature at two radii, re-DLT. All four must hold — a miss
     returns null and the caller keeps its conic-corrected track (each rung
     degrades to the one below, exactly plateSolve's shape). residPx reports
     mean point movement (the drift the solve absorbed). */
  function trackSolve(img, Hprev, profile, opts) {
    opts = opts || {};
    var g = G();
    var a = profile.plate.corners.at, cR = profile.plate.corners.r_out;
    var model = [[-a, -a], [a, -a], [a, a], [-a, a]];
    var floorC = opts.contrastFloor !== undefined ? opts.contrastFloor : 0.01;
    var pts = [], moved = 0;
    for (var c = 0; c < 4; c++) {
      var p = g.applyH(Hprev, model[c][0], model[c][1]);
      var J = jacobianAt(Hprev, model[c][0], model[c][1]);
      if (J.det <= 0) return null;
      var rFlipPx = 0.5 * cR * Math.sqrt(J.det);
      var rad = Math.max(4, Math.min(14, 0.9 * rFlipPx));
      var f1 = forstner(img, p[0], p[1], rad, true);
      if (!f1) return null;
      var f2 = forstner(img, f1.x, f1.y, rad, true) || f1;
      var hIn = ringHarm(img, f2.x, f2.y, Math.max(2, 0.6 * rFlipPx));
      var hOut = ringHarm(img, f2.x, f2.y, 1.5 * rFlipPx);
      if (!hIn || !hOut) return null;
      if (hOut.m2 < floorC || hOut.m2 < 1.2 * Math.max(hOut.m1, hOut.m3)) return null;
      if (Math.cos(hIn.phi2 - hOut.phi2) > -0.2) return null;
      moved += Math.hypot(f2.x - p[0], f2.y - p[1]);
      pts.push([f2.x, f2.y]);
    }
    var Hn = g.homographyFromPoints(model, pts);
    if (!Hn) return null;
    return { H: Hn, points: pts, residPx: moved / 4, used: 4 };
  }

  var API = { detect: detect, measureAt: measureAt, constellation: constellation,
              solve: solve, trackSolve: trackSolve, ringHarm: ringHarm, forstner: forstner };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.saddle = API;
})(typeof window !== "undefined" ? window : globalThis);
