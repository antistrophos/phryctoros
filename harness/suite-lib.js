/* suite-lib.js — shared scaffolding for the split suite pages
   (test.html = v2 core + TH, test-v3.html = T21/T22 core + T23 tiling,
   test-v3-dring.html = the D-ring/beacon/lease family, test-saddle.html = T24).
   The tab TITLE carries live progress — readable from tab context without
   touching the page — and the final verdict POSTs to serve.py ->
   harness/results/<page>.json so results are file-readable.

   PROGRESS HEARTBEAT (2026-08-29): every record()/tick() also posts a tiny
   doc to results/<page>-progress.json — whether a quiet run is GRINDING or
   PARKED is readable from the filesystem with the pane hidden (a frozen tab
   posts nothing: heartbeat absence IS the park signal), and done:true is
   posted only AFTER the results body lands, so a reader that waits for it
   never races the results write.

   CASE FILTER: ?only=T22s,T22z runs just the gated cases on pages that gate
   with caseOn(). Filtered runs post to <page>-partial.json and title as
   PARTIAL — a filtered green can never masquerade as the certification run.

   file:// GUARD: suiteStart() refuses to run under file:// (the editor-hook
   tabs used to self-start heavy suites in the pane) — pages idle with a
   pointer at the dev server instead. */
"use strict";
const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");
const results = [];
const SUITE_FILTER = ((new URLSearchParams(location.search)).get("only") || "")
  .split(",").map(s => s.trim()).filter(Boolean);
let skippedCases = 0;
function caseOn(id) {
  const on = !SUITE_FILTER.length || SUITE_FILTER.some(f => id.toLowerCase().startsWith(f.toLowerCase()));
  if (!on) skippedCases++;
  return on;
}
function log(cls, msg) {
  const d = document.createElement("div");
  d.className = cls; d.textContent = msg;
  logEl.appendChild(d);
}
function record(name, pass, details) {
  results.push({ name, pass, details });
  log(pass ? "pass" : "fail", (pass ? "PASS  " : "FAIL  ") + name + (details ? "  — " + details : ""));
  bumpTitle();
  postProgress();
}
function note(name, details) { results.push({ name, pass: null, details }); log("info", "note  " + name + " — " + details); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function tick(msg) { statusEl.textContent = msg; bumpTitle(msg); postProgress(); await sleep(15); }

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
  document.title = (SUITE_FILTER.length ? "PARTIAL " : "") + (window.SUITE_PAGE || "suite") + " " + p + "P" + (f ? " " + f + "F" : "") +
    (msg ? " — " + String(msg).slice(0, 60) : "");
}

async function postResult(page, body) {
  // degrades silently everywhere the endpoint is absent (file:// standalone,
  // pre-restart serve.py) — the title + DOM json remain the fallback channel.
  // Retries ×3: a sleep/wake mid-run once dropped a certification verdict
  // while the progress heartbeat survived (2026-08-30) — the two channels
  // must not be separable by one flaky fetch. Resolves either way so a
  // caller can ORDER a later post after this one settles.
  for (var att = 0; att < 3; att++) {
    try {
      var r = await fetch("/harness-result?page=" + encodeURIComponent(page), { method: "POST", body });
      if (r && (r.ok || r.status === 204)) return;
    } catch (e) {}
    await new Promise(function (res) { setTimeout(res, 1200 * (att + 1)); });
  }
}

let progressSeq = 0;
function postProgress(extra) {
  const p = results.filter(r => r.pass === true).length;
  const f = results.filter(r => r.pass === false).length;
  const body = JSON.stringify(Object.assign({
    page: window.SUITE_PAGE || "suite", seq: ++progressSeq,
    phase: statusEl ? String(statusEl.textContent).slice(0, 120) : "",
    cases: results.length, passes: p, fails: f,
    last: results.length ? String(results[results.length - 1].name).slice(0, 90) : null,
    filter: SUITE_FILTER.length ? SUITE_FILTER : undefined,
    skipped: skippedCases || undefined,
    t: new Date().toISOString(), done: false
  }, extra || {}));
  return postResult((window.SUITE_PAGE || "suite") + "-progress", body);
}

function suiteFinish(page) {
  const passes = results.filter(r => r.pass === true).length;
  const fails = results.filter(r => r.pass === false).length;
  const partial = SUITE_FILTER.length > 0;
  statusEl.textContent = (partial ? "PARTIAL (only=" + SUITE_FILTER.join(",") + ", " + skippedCases + " skipped) — " : "DONE — ") +
    passes + " passed, " + fails + " failed";
  statusEl.className = fails ? "fail" : "pass";
  document.title = (partial ? "PARTIAL " : "DONE ") + page + " — " + passes + "P " + fails + "F";
  const body = JSON.stringify({ done: true, page, partial: partial || undefined,
    filter: partial ? SUITE_FILTER : undefined, skipped: partial ? skippedCases : undefined,
    passes, fails, results }, null, 1);
  document.getElementById("results-json").textContent = body;
  // Filtered runs land in <page>-partial.json — the certification record in
  // <page>.json is never clobbered by an iteration lap.
  postResult(partial ? page + "-partial" : page, body)
    .then(() => postProgress({ done: true, partial: partial || undefined }))
    .then(() => suiteReturn());
}

// ?return=runner: the runner navigated here for a suite job (each suite runs
// TOP-LEVEL in its designed environment — an iframed suite shares the
// runner's renderer thread and freezes it). Go back once the verdict has
// posted; the runner picks up its pending marker and reports the job.
function suiteReturn() {
  try {
    if ((new URLSearchParams(location.search)).get("return") === "runner")
      setTimeout(function () { location.href = "runner.html"; }, 1500);
  } catch (e) {}
}

function suiteError(page, e) {
  statusEl.textContent = "SUITE ERROR: " + (e.stack || e);
  statusEl.className = "fail";
  document.title = "ERROR " + page;
  const partial = SUITE_FILTER.length > 0;
  const body = JSON.stringify({ done: true, page, partial: partial || undefined, error: String(e.stack || e) });
  document.getElementById("results-json").textContent = body;
  postResult(partial ? page + "-partial" : page, body)
    .then(() => postProgress({ done: true, error: true, partial: partial || undefined }))
    .then(() => suiteReturn());
}

function suiteStart(mainFn) {
  if (location.protocol === "file:") {
    statusEl.textContent = "file:// — suite idle (open via the dev server: http://localhost:8126/harness/…)";
    statusEl.className = "info";
    document.title = "idle " + (window.SUITE_PAGE || "suite");
    return;
  }
  // Stall watchdog (2026-08-24, shared 2026-08-29): one run parked forever
  // between a tick and its case with the main thread RESPONSIVE and no
  // exception. An interval can only run when the thread is free, so it
  // cleanly separates "runner parked, thread alive" (title marks STALL, the
  // progress file says stalled:true) from a heavy case legitimately grinding
  // (the interval can't fire mid-block). A FROZEN tab posts nothing at all —
  // heartbeat absence is that third state's signature.
  let wdCount = -1, wdSince = Date.now();
  setInterval(() => {
    if (results.length !== wdCount) { wdCount = results.length; wdSince = Date.now(); }
    else if (Date.now() - wdSince > 120000 && !/^(DONE|ERROR|PARTIAL)/.test(document.title)) {
      document.title = "STALL " + (window.SUITE_PAGE || "suite") + " " + results.length + "R — " + statusEl.textContent.slice(0, 50);
      postProgress({ stalled: true });
    }
  }, 30000);
  mainFn().then(() => suiteFinish(window.SUITE_PAGE)).catch(e => suiteError(window.SUITE_PAGE, e));
}
