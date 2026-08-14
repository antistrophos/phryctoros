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

  /* The stage-2 entry point: all emitters in the frame. Acceptance: rank all
     geometric triples by timing+structure; the BEST is accepted on structure
     alone (blur-tolerant — a real fiducial outranks ring/collar decoys whenever
     its timing resolves, and still verifies structurally when blur erases the
     timing). ADDITIONAL emitters (multi-emitter/§5.1, decoy-exposed) must pass
     the strict timing signature too. */
  function registerAll(img, opts) {
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
    scored.sort(function (a, b) { return (b.timingScore + b.structureScore) - (a.timingScore + a.structureScore); });
    var emitters = [];
    for (var k = 0; k < scored.length; k++) {
      var s = scored[k];
      if (emitters.length === 0) {
        if (s.structureScore >= 0.7) emitters.push(s);
      } else if (s.timingScore >= 0.6 && s.structureScore >= 0.7) emitters.push(s);
    }
    return { emitters: emitters, candidates: cands };
  }

  var API = { registerAll: registerAll, findFinderCandidates: findFinderCandidates, groupTriples: groupTriples, threshold: threshold, FC: FC };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.OC = global.OC || {}; global.OC.register = API;
})(typeof window !== "undefined" ? window : globalThis);
