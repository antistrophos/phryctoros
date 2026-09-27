# Testing

The tests are pages. They run in a browser against `serve.py` and post their
verdicts to `harness/results/`. Run the suites after any change to `src/`, and
run the checks below before any commit.

Start the server first (`python serve.py 8126`), and keep the tab that runs a
test **in the foreground**. Browsers throttle background tabs: a suite that
takes four minutes in front can take forty behind another tab, and its timing
assertions can fail.

## The suite pages

| page | results file | covers | cases | time in front |
|---|---|---|---|---|
| `test.html` | `v2.json` | the v2 core: registration, the degradation ladder, the tear defense, payload framing, rate variants, the TH harvest family | 57 | ~4 min |
| `test-v3.html` | `v3.json` | conic correction (T21), the v3 emitter and decoder core (T22), tiling (T23) | 31 | ~8 min |
| `test-saddle.html` | `saddle.json` | quadrant marks, saddle registration, the 30° and 45° tilt referees, the tracker (T24) | 8 | ~2 min |
| `test-v3-dring.html` | `v3dring.json` | the beacon, chunked framing, the rotor, the lease, per-tile variants (T22e0 … T22var) | 13 | ~15–20 min |
| `test-track.html` | `track.json` | the continuous receiver: the track, conviction, the coalition peel, the committed specimen, streams, lease pricing, the scheduler, sources (TR1–TR12) | 12 | ~1–2 min |

Case counts are as of the last certification (2026-09-03); the pages are the
source of truth.

To run a suite, open its page. The tab title shows live progress, such as
`v3 19P — T22h: …`. The page posts:

- `<results>-progress.json` after every case: a heartbeat, so a quiet run can
  be told apart from a frozen one from the file system.
- `<results>.json` when it finishes, then a final progress post with
  `done: true`. Read the results only after `done: true` appears.

`?only=<prefix>[,<prefix>…]` runs the matching cases only (for example
`test-v3-dring.html?only=T22z`). A filtered run posts to
`<results>-partial.json` and titles itself `PARTIAL`; it never counts as
certification. The suite pages refuse to run from `file://`.

## Synthetic twins

A **twin** renders the emission inside the receive page and feeds the frames to
the real harvest driver: the same scheduler, track, streams, lease, and peel
that a camera clip gets. It certifies the receiver with no camera and no video.

`harness/receive.html?synth=<code>&loop=<seconds>` starts one. Parameters:

| parameter | meaning |
|---|---|
| `synth` | the D-ring code, or a comma list with one code per tile (for example `a42q,a42k`) |
| `loop` | loop length in seconds (default 180, minimum 30) |
| `msg` | the payload text, URL-encoded (default: a fixed quotation) |
| `tiling` | number of tiles (default: the length of the `synth` list) |
| `prof` | `v3` (default) or `v3hr` |
| `quad` | `0` removes the quadrant corners (default: on) |
| `minwin`, `maxwin` | window floor and ceiling in seconds (defaults 8 and 12) |
| `poison` | `w0-w1`: the cure fixture — see below |
| `poisonscale` | the false solve's scale for `poison` (default 1/3) |
| `live` | `1`: the live twin — frames become available on the wall clock |
| `take` | a take id to record in the log (the take console sets it) |
| `return` | `runner`: go back to `runner.html` when finished |

Every twin posts its harvest log and store like a camera harvest
(`field-<stamp>.json`, `store-<stamp>.json`) and a verdict:

| verdict file | written by |
|---|---|
| `synth-harvest.json` | every twin (last write wins) |
| `synth-harvest-<code>.json` | clean twins: the per-configuration baseline (commas are dropped from the name) |
| `synth-cure-<code>.json` | poisoned twins; they never overwrite a baseline |
| `synth-live-<code>.json` | live twins |

A clean twin asserts four things: the driver finished, a context bound (or a
carried store completed without decoding), the peel completed and validated,
and the decoded text matches the emitted text byte for byte.

### Trajectory parity

A change that should not alter the receiver's behavior must reproduce the
reference twins **exactly**: the same window boundaries, the same droplets
added per window, the same seeks per window, the same content key, and the same
decoded text. That is the strongest check a receiver refactor can pass, and it
is how the continuous receiver's three phases were certified. The references:

| twin | windows (start–end s: droplets added, seeks) | content key | notes |
|---|---|---|---|
| `?synth=a42k&loop=180` | 0–10: 44, 300 · 9.2–17.3: 36, 244 · 16.5–24.7: 37, 245 · 23.9–32.1: 37, 246 | `24:105:210:142` | binds in window 2 |
| `?synth=a42c&loop=180&msg=…` (below) | the same four windows | `24:93:185:4e12` | binds in window 2 |
| `?synth=a42q,a42k&loop=180` | 0–10: 88 · 9.2–17.3: 72 · 16.5–24.7: 74 | `24:105:210:142` | both tiles bind in window 2 (tags `bb59`, `8868`); 105/105 blocks |

The a42c reference message contains the bytes `0x1C` and `0x1D`; its `msg` is:

```
The%20electric%20light%20escapes%20attention%20as%20a%20communication%20medium%20just%20because%20it%20has%20no%20%1Ccontent.%1D%20And%20this%20makes%20it%20an%20invaluable%20instance%20of%20how%20people%20fail%20to%20study%20media%20at%20all.
```

Compare the per-window seeks, which must match exactly. A run's total seek
count also includes the prefetch that the early exit cancels (about 300 frames
here, varying by a few tens with timing), so the totals can differ.

### The cure fixture

`?synth=a42q&loop=60&poison=2-3&msg=<text>` injects a false registration into
windows 2 and 3: a one-third-scale solve on the ring-fit path, with every
droplet's bytes corrupted. The receiver must convict the false hypothesis,
exclude its epochs, re-decode the two spans under the track's pose, and
validate the peel. Use a payload long enough that the honest windows alone
cannot complete it: the certified run uses the sentence
`The intake is the hole, not the validation. ` eight times followed by
`Phase A closes it.` (370 characters, K = 188). The fixture adds three
assertions to the clean four; all seven must pass.

### The live twin

`?synth=a42k&loop=60&live=1` gates the synthetic frames on the wall clock, so
the scheduler must wait for frames the way it waits for a camera. It adds three
assertions: the source and the scheduler ran live, the driver waited at least
once, and the run ended by early exit rather than dead air.

## Page selftests

The field pages check themselves when opened with `?selftest=1` and post
`<page>-selftest.json`:

| page | checks |
|---|---|
| `registry.html?selftest=1` | ingestion of the posted logs, metric extraction, settings parsing, goodput (4) |
| `take.html?selftest=1` | the card's canonical settings string and its URLs (6) |
| `orders.html?selftest=1` | the ticket matcher and completion logic (5) |
| `emit.html?settings=<string>&selftest=1` | the profile validates as armed, and the settings string round-trips exactly (2) |

The registry and order window need the server, and a few seconds to post.

## The runner

`harness/runner.html` runs jobs that a script or an agent writes to
`harness/jobs/next.json`, so tests can be driven without anyone clicking. Keep
it open in a foreground tab. It polls every 2 s and runs the job whenever its
`id` differs from the last job it ran.

```json
{ "id": "cert-v3-1", "kind": "suite", "page": "test-v3", "only": "T22z", "note": "optional" }
{ "id": "twin-a42q-1", "kind": "suite", "page": "receive", "params": "synth=a42q&loop=60" }
{ "id": "probe-1", "kind": "eval", "code": "return OC.fountain.geom(OC.profile.profileV3());" }
```

- A **suite** job navigates the runner tab to `<page>.html`, which returns when
  it has posted; `only` and `params` are passed through. Selftest pages get
  `selftest=1` automatically.
- An **eval** job runs `code` as the body of an async function with `OC` in
  scope. It has the same privileges as any page in the repository.
- Each job's result is written to `harness/results/job-<id>.json` (the id is
  cut to 30 characters), and the runner's heartbeat to
  `harness/results/runner-status.json`.
- After adding a script to `runner.html`, reload the runner with an eval job:
  `setTimeout(() => location.reload(), 400); return { reloading: true };`

`harness/jobs/` is not committed.

## Fixtures

`harness/fixtures/` holds committed evidence the suites replay:
`field-20260901003751.json` and `store-20260901003751.json`, the 2026-09-01
range take whose false one-third-scale registration banked 127 poisoned
droplets. TR5 replays it through the track and must convict exactly those
epochs. Field clips themselves are never committed.

## Before a commit

- **Any change to `src/`**: all five suite pages green, unfiltered.
- **A change to the receiver** (`harvest.js`, `track.js`, `stream.js`,
  `schedule.js`, `source.js`, or the harvest driver in `receive.html`): the
  reference twins at exact trajectory parity, the cure fixture, and the live
  twin.
- **A change to a field page** (`registry.html`, `take.html`, `orders.html`,
  `emit.html`): that page's selftest.
- **Any change to `src/` or `receive.html`**: rebuild the single-file receiver
  with `python build_standalone.py`.
