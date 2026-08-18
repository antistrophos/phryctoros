/* suite-lib.js — shared scaffolding for the split suite pages
   (test.html = v2 core + TH, test-v3.html = T21/T22/T23,
   test-saddle.html = T24). The tab TITLE carries live progress —
   readable from tab context without touching the page — and the
   final verdict POSTs to serve.py -> harness/results/<page>.json
   so results are file-readable. Both degrade silently on file://. */
"use strict";
const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");
const results = [];
function log(cls, msg) {
  const d = document.createElement("div");
  d.className = cls; d.textContent = msg;
  logEl.appendChild(d);
}
function record(name, pass, details) {
  results.push({ name, pass, details });
  log(pass ? "pass" : "fail", (pass ? "PASS  " : "FAIL  ") + name + (details ? "  — " + details : ""));
  bumpTitle();
}
function note(name, details) { results.push({ name, pass: null, details }); log("info", "note  " + name + " — " + details); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function tick(msg) { statusEl.textContent = msg; bumpTitle(msg); await sleep(15); }

function annulusResult(res, emitterIdx, annulusIdx) {
  return res.emitters[emitterIdx].annuli[annulusIdx];
}
// v2 swapped the ring order (layer 0 outermost, per spec §7.1's rule) — assertions
// that mean "the robust base layer" must look up by LAYER, not ring index.
function layerResult(res, emitterIdx, L) {
  if (!res || res.error || !res.emitters || !res.emitters[emitterIdx])
    return { present: false, error: (res && res.error) || "no emitter", ser: NaN, erasures: NaN };
  return res.emitters[emitterIdx].annuli.find(x => x.layer === L);
}
function dead(a) { // "degraded/dead" predicate for ordering assertions
  if (!a || !a.present || a.error) return 3;
  if (isNaN(a.ser) || a.ser > 0.2 || a.erasureRate > 0.5) return 2;
  if (a.ser > 0.05 || a.erasureRate > 0.25) return 1;
  return 0;
}
function fmt(a) {
  if (!a) return "absent";
  if (!a.present) return "not-present(contrast " + a.contrast + ")";
  if (a.error) return a.error;
  return "ser " + a.ser + " (" + a.errors + "/" + a.compared + "), eras " + a.erasures;
}


function bumpTitle(msg) {
  const p = results.filter(r => r.pass === true).length;
  const f = results.filter(r => r.pass === false).length;
  document.title = (window.SUITE_PAGE || "suite") + " " + p + "P" + (f ? " " + f + "F" : "") +
    (msg ? " — " + String(msg).slice(0, 60) : "");
}

function postResult(page, body) {
  // degrades silently everywhere the endpoint is absent (file:// standalone,
  // pre-restart serve.py) — the title + DOM json remain the fallback channel
  try { fetch("/harness-result?page=" + encodeURIComponent(page), { method: "POST", body }).catch(function () {}); }
  catch (e) {}
}

function suiteFinish(page) {
  const passes = results.filter(r => r.pass === true).length;
  const fails = results.filter(r => r.pass === false).length;
  statusEl.textContent = "DONE — " + passes + " passed, " + fails + " failed";
  statusEl.className = fails ? "fail" : "pass";
  document.title = "DONE " + page + " — " + passes + "P " + fails + "F";
  const body = JSON.stringify({ done: true, page, passes, fails, results }, null, 1);
  document.getElementById("results-json").textContent = body;
  postResult(page, body);
}

function suiteError(page, e) {
  statusEl.textContent = "SUITE ERROR: " + (e.stack || e);
  statusEl.className = "fail";
  document.title = "ERROR " + page;
  const body = JSON.stringify({ done: true, page, error: String(e.stack || e) });
  document.getElementById("results-json").textContent = body;
  postResult(page, body);
}
