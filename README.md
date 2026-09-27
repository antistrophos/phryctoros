# Phryctoros

**The beacon-watcher** (φρυκτωρός): an optical carriage lane that moves small
signed artifacts between devices as rotating light — any commodity screen is the
fire, any phone camera is the watcher. The contingency tier of the Stasima
carriage tree; sibling of [stasima](https://github.com/antistrophos/stasima).

## How it works

The emitter shows a **plate**: concentric rings drawn on a screen. Each ring's
edge is a shape made of a few harmonics, and the shape rotates. The rotation is
not steady: small, continuous deviations from its nominal rate carry the
symbols. A camera films the plate. The receiver finds the plate in each frame,
measures each ring's rotation phase, turns the phase steps back into symbols,
and reads the symbols as CRC-checked **droplets** of a fountain code. Any large
enough set of droplets, from any part of the loop, rebuilds the payload.

The link is one-way broadcast: no pairing, no network, no return path. A
receiver may start filming at any point in the loop.

One ring, the **beacon** (the D-ring), carries a 20-byte **envelope** that names
the emission: a session id, the payload's size and fingerprint, the tile layout,
and the loop length. A screen can show several plates at once (an **array**);
each plate is an emitter, and the receiver pools what it reads from all of them.

[docs/architecture.md](docs/architecture.md) describes the wire and the
receiver in full.

## Status (September 2026)

Built and covered by the suites:

- **The v3.1 profile** — four data rings with per-ring symbol pacing; 30 fps
  emission for 60 fps capture; a resilient preset (24-bit droplets) and a
  high-rate preset (48-bit); payloads self-framed with a CRC16 and validated
  against the envelope's fingerprint.
- **Registration** — quadrant swap-target corners read by saddle registration
  (suite referees at 30° and 45° tilt), a per-frame pose tracker, and fallbacks
  to finder patterns and ring fits. A three-section center target marks the
  designated tile of an array by its shape.
- **The beacon** — chunked framing with a whitening rotor, a fast identity tag,
  and a lease that binds, holds, and releases an emitter's identity.
- **Arrays** — 2-up and 6-up tilings, with per-tile beacon variants so that one
  capture can compare two configurations under identical conditions.
- **The continuous receiver** — registration state that survives window
  boundaries and convicts false solves; per-emitter beacon streams that frame an
  envelope across window seams; a scheduler that decides what to decode next;
  one source interface for recorded clips and live camera capture.

Field record, a phone camera filming a laptop screen: the payload and the
beacon's envelope both decoded at 13 ft (4 m), the longest range tested so far;
two beacon configurations compared inside one 2-up capture at 5 ft. Not yet
field-tested: the live camera harvest (certified on a synthetic live twin) and
handheld captures at range.

## Quick start

No build step and no dependencies: the code is plain JavaScript loaded as
classic scripts, and Python 3 runs the helper scripts.

1. Start the dev server from the repository root:

   ```
   python serve.py 8126
   ```

   The port is optional (default 8123). The server sends
   `Cache-Control: no-store`, so edited scripts always reload, and it accepts
   `POST /harness-result?page=<name>`, which writes
   `harness/results/<name>.json`. The pages post suite verdicts, harvest logs,
   and stores through it.
2. Open `http://localhost:8126/harness/` for the page index.
3. Confirm the install: run a suite page, or a synthetic twin such as
   `http://localhost:8126/harness/receive.html?synth=a42q&loop=60`.

**Without a server.** `harness/receive.html` also decodes a video file when
opened from disk. `dist/receive-standalone.html` is the same receiver with every
script inlined into one file, for copying to a phone. Rebuild it after any
change to `src/`:

```
python build_standalone.py
```

**Live camera** capture needs a secure context: `localhost` or HTTPS.

> **Photosensitivity.** The emission is a rotating concentric pattern. Local
> flicker near a ring edge is k·f_rot for harmonic k. The emitter computes a
> flicker report before it will start and never autoplays. Nobody needs to
> watch the screen for the link to work.

## Pages

Field work — how a capture goes from plan to record
([docs/field-workflow.md](docs/field-workflow.md)):

| page | purpose |
|---|---|
| `harness/orders.html` | the order window: the capture queue (`harness/capture-queue.json`) against the posted evidence; the top card is the next capture to take |
| `harness/take.html` | the take console: one card arms the synthetic twin, the emitter, and the receiver with the same settings string |
| `harness/emit.html` | the emitter: validate, read the flicker report, Start, Fullscreen; can export the loop as a WebM video |
| `harness/receive.html` | the receiver: video-file harvest, live camera harvest, synthetic twins; posts a structured log per harvest |
| `harness/registry.html` | the capture registry: harvest logs plus physical conditions, extracted metrics, standards, range-falloff fits, and a re-run lane |

Testing ([docs/testing.md](docs/testing.md)):

| page | purpose |
|---|---|
| `harness/test.html` | suite 1: the v2 core and the harvest family |
| `harness/test-v3.html` | suite 2: conic correction, the v3 emitter and decoder core, tiling |
| `harness/test-saddle.html` | suite 3: saddle registration and the tilt referees |
| `harness/test-v3-dring.html` | suite 4: the beacon, chunked framing, the lease, arrays |
| `harness/test-track.html` | suite 5: the continuous receiver |
| `harness/runner.html` | the job channel: runs suites and scripts from `harness/jobs/next.json` |

Diagnostics:

| page | purpose |
|---|---|
| `harness/diag.html` | stage-by-stage autopsy of one field clip |
| `harness/batch-diag.html` | batch autopsy: one row per capture |
| `harness/elim.html` | liar elimination over an exported store |
| `harness/pool36.html` | the field36 pooled peel (a historical specimen) |
| `harness/selfchar.html` | self-characterisation v0: latency and refresh/capture beat (untested on hardware) |
| `harness/golden.html` | golden-vector manifest scaffolding |

## Repository layout

```
src/                  the emitter and decoder core (browser globals under OC.*)
harness/              the pages, the suite pages, the decode and render workers
harness/fixtures/     committed specimens (the 2026-09-01 range take's log and store)
harness/capture-queue.json   the order window's tickets (committed)
harness/results/      posted verdicts, harvest logs, stores (not committed,
                      except registry.json when it is worth keeping)
harness/jobs/         the runner's job channel (not committed)
clips/                field footage — stays local, never committed
dist/                 the single-file receiver
docs/                 architecture, testing, field workflow, the Phase 0 protocol
serve.py              the dev server
build_standalone.py   inlines every script into dist/receive-standalone.html
peel36.py             a bit-exact Python port of the fountain peel (forensics)
```

## Design records

The design is recorded as entries on the Pharos seat of the Stasima Rehearsal
deployment, thread `phryctoros` (earlier entries: `out-of-band-carriage`). The
entries that govern the current code:

- `technical/phryctoros-v4-contract.md` — the v4 contract: the three-section
  center target, the family-4 geometry, freeze 0 as the standing posture, and
  the rotor
- `technical/phryctoros-the-lease.md` — identity binding and the hold matrix
- `technical/phryctoros-continuous-receiver-draft-rev2.md` — the continuous
  receiver's design, with the phase A/B/C build entries beside it
- `technical/phryctoros-emitter-contexts-rev2.md` — emitter contexts and the
  beacon as the acquisition gate

These entries are not in this repository. The module header comments in `src/`
carry the implementation detail, and the short IDs those comments use (C1,
F5b, D-ring ruling 1b, …) are defined in
[docs/architecture.md](docs/architecture.md#reference-ids).

## License

[Apache 2.0](LICENSE) — see also [NOTICE](NOTICE).
