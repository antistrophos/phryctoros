# Architecture

This document describes the emission, the wire format, the per-window decode
pipeline, and the receiver that runs it over a clip or a live camera. It is the
map. The header comment of each module in `src/` is the detailed reference, and
the code governs where the two differ. The last section defines the short IDs
(C1, F5b, D-ring ruling 1b, …) that comments in the code use.

## Terms

| term | meaning |
|---|---|
| plate | the emission's image: the data rings, the registration marks, the beacon ring |
| emitter | one plate on a screen; an array shows several |
| ring (annulus) | one modulated ring edge; each ring carries its own droplet carousel |
| symbol | one phase step of a ring's rotation |
| droplet | one CRC8-checked unit of the fountain code, carried by one ring |
| carousel | a ring's droplet sequence, repeated for the whole loop |
| block | one fixed-size piece of the framed payload; a payload has K blocks |
| peel | rebuilding the K blocks from droplets |
| envelope | the beacon's 20-byte description of the emission |
| tag | the envelope's CRC16: the emission's short identity |
| window | one span of frames decoded as a unit |
| harvest | the receiver's decode run over a clip or a live camera: plans windows, pools droplets, stops when the payload validates |
| store | the harvest's durable state: droplet ledgers and identity contexts, as JSON |
| twin | a synthetic run: the emission rendered in the page and fed to the real harvest |

## The emission

`src/profile.js` holds the profiles and the validator; `src/emission.js`
renders them. Every length is in **fiducial widths** from the plate center, so
the geometry is independent of the camera's scale.

- **v2** (`defaultProfile`): three rings at 15 fps emission, seeded reference
  streams, the Phase 0 measurement profile. Archived clips still decode.
- **v3.1** (`profileV3`): four data rings at 30 fps emission, filmed at 60 fps,
  in payload mode. The presets are resilient (24-bit droplets) and high-rate
  (48-bit droplets). The legacy variants `flat` and `classic` decode clips
  filmed before the pacing and ladder rulings.

The v3.1 data rings:

| ring | edge | radius | nominal rotation | M (resilient / high-rate) | frames per symbol | harmonics |
|---|---|---|---|---|---|---|
| 0 | A-outer | 1.42 | 0.75 Hz | 16 / 32 | 4 | 1, 2, 3, 5, 8, 13 |
| 1 | B-inner | 1.80 | 1.0 Hz | 16 / 32 | 4 | 1, 2, 3, 5, 8, 13 |
| 2 | B-outer | 2.30 | 1.0 Hz | 8 / 16 | 3 | 1, 2, 3, 5, 8 |
| 3 | C-inner | 2.68 | 1.5 Hz | 4 | 2 | 1, 2, 3 |

Ring 3 is layer 0, the base: the most robust constellation, and the carrier
gate for the emission. **Pacing** sets each ring's symbol length so that every
ring's droplets last the same time — 24 frames (0.8 s) in the resilient preset.

**Symbols.** Each ring's edge is a sum of harmonics that rotates at a nominal
rate. A symbol is a Gray-coded, differential phase step of s·2π/M, spread
linearly across the symbol's frames (continuous-phase modulation). The decoder
removes the nominal rotation, fits the slope of the remaining phase across each
symbol, and rounds it to the nearest step. A low-confidence step becomes an
**erasure**, never a guess.

**The plate.** Registration marks sit at the four corners: bullseyes by default,
or quadrant swap-targets (`quad=1`, the field configuration), whose crossing
points are exact under perspective. In the current beacon configurations the
center is a three-section quadrant target; on an array, the designated tile
carries the inverted variant, so tile identity is readable from the shape
alone. A quiet zone separates the center from the rings.

**Flicker.** `src/flicker.js` computes the worst local flicker per ring and
harmonic (k·f_rot plus the modulation's deviation) against the 3–60 Hz
photosensitive band. The validator consults it, and the emitter shows it before
it will start.

## The wire

### Payload

1. **Self-frame** (`fountain.selfFrame`): `[len hi][len lo][type][0]` then the
   payload, then for frame type 1 a CRC16 of the payload. The CRC16 sits outside
   `len`, so a type-0 reader parses a type-1 frame unchanged.
2. **Blocks.** The frame splits into K blocks of the droplet's data size: 2
   bytes (resilient) or 5 bytes (high-rate). K is at most 200.
3. **Droplets** (`fountain.dropletBytes`). Droplet `c` is the XOR of a seeded
   subset of the blocks (an LT fountain code), followed by a CRC8 over
   `[c, data]`. The CRC binds the slot number, so a droplet read at the wrong
   position fails its check. Every 8th slot is a header droplet:
   `[magic, K, len, pcrc]` as far as the data size allows (a resilient header
   holds only `[magic, K]`).
4. **Carousels.** Each ring cycles its own droplet sequence for the whole loop
   (about 2K+12 slots), after a short preamble. Each ring, and each tile of an
   array, uses a different seed (`tileSeed(seed, t) = seed + 7919·t`), so its
   droplets are a different view of the same blocks, and all of them pool into
   one peel.
5. **Peel** (`fountain.assemble`). Iterative peeling over every held droplet. A
   completed peel must validate: the frame's CRC16, and the envelope's
   fingerprint when the emission's identity is known.
   `fountain.assembleEliminating` retries without suspected liars (droplets
   whose CRC8 passed by chance) before it gives up.

### Beacon

The envelope (`plate.parseEnvelope`; written by `emission.envelopeBytes`):

| byte | field |
|---|---|
| 0 | format version (1) |
| 1 | profile family: 3, or 4 for the v4 geometry |
| 2 | flags; bit 0 = high-rate preset |
| 3–6 | session id (32 bits) |
| 7 | K |
| 8–9 | wire length |
| 10–11 | payload CRC16 (the fingerprint) |
| 12 | capability; bit 0 = 60 fps capture |
| 13 | freeze, in tenths of a second |
| 14 | loop length, in seconds |
| 15 | tiling |
| 16 | index of the tile carrying this copy |
| 17 | grid, cols·16 + rows (0 = single plate) |
| 18–19 | CRC16 over bytes 0–17: the **tag** |

**Chunked framing** (`emission.beaconChunkStream`, `plate.beaconChunkScan`).
The beacon repeats a stream of chunks: tag chunks `[0xC0][tag][crc8]` between
data chunks `[0xC0 + rot·8 + idx][4 envelope bytes XOR mask(rot, idx)][crc8]`,
idx 1–5 covering the 20 envelope bytes. The **rotor** steps `rot` through 1, 2,
3, 0, so no chunk repeats as a constant run; rot 0 is the identity, so older
streams read through the same path. A receiver assembles the five data chunks
from anywhere in the stream and accepts the envelope only when its CRC16 checks.
One rotor block is 50 bytes: the **envelope cycle**, 13.3 s at M=4, 2 frames per
symbol, 30 fps. The legacy framing (`dring=f24`) sends the envelope as one
23-byte CRC8 frame.

**Content key.** The harvest keys droplet ledgers by content, not by session:
`<droplet bits>:<K>:<len>:<pcrc16>`. The same content pools across sessions,
restarts, and clips, and the key's fingerprint arms the peel's full validation.

**Beacon configurations.** `dring=<code>` selects the beacon's placement,
modulation, and plate revision (`profile.applyDring`; the codes are
`profile.DRING_CHUNKED`). `a42q` is the working configuration: the beacon on
band A's inner edge at M=4 and 2 frames per symbol, with the three-section
center. The others are the trials that led to it. A comma list, such as
`dring=a42q,a42k`, gives each tile of an array its own code: geometry and symbol
clock stay shared, and the validator enforces that.

## The decode pipeline (one window)

`pipeline.decodeSequence(frames, profile, opts)` decodes one window. It is
synchronous and keeps no state between calls; the receive page runs it in a
worker (`harness/worker.js`).

1. **Group** the frames by emission index and keep up to three looks per
   emission frame, so the cleanest look can win.
2. **Register** every plate in frame (`register.registerAll`: saddle
   constellations, finder patterns, or a ring fit), or take pose priors from the
   caller (`opts.regPrior`).
3. **Track the pose** per frame: the saddle tracker re-solves each frame from
   the previous one (`saddle.trackSolve`); bullseye corners use
   `plate.plateSolve`, with the static ellipse correction (`conic.js`).
4. **Identify tiles**: find the designated tile (the center variant, or the
   breaker on older plates) and index the rest from the lattice. The caller's
   tile hints (`opts.tileHints`) place plates the fresh read could not.
5. **Per ring**: sample the edge radially through the pose (`sample.js`), take
   the harmonics (`transform.js`), track the rotation phase (`separate.js`),
   repair rolling-shutter tears (`rowtime.js` — the repaired and the plain
   series are both decoded and the better result is kept), align (preamble,
   CRC-pass scan, or the sibling rings' consensus), demodulate (`demap.js`), and
   collect the droplets whose CRC passes (`fountain.collect`).
6. **Beacon**: align on the chunk stream or frame (`plate.beaconAlign`), parse
   the envelope, or report a partial chunk sweep. The beacon row also exports its
   phase track for the receiver's streams.
7. **Pool** the tiles' droplets and peel.

## The receiver

The receiver runs the pipeline over time. It is the practitioner's staging:
**source → temporal scheduler → spatial slicer → processing**. Window
boundaries are load-bearing for I/O and nothing else; the state lives across
them.

```
source            scheduler              pipeline (per window)     state
recording ──┐     which span next;       pose priors and tile      track: registration hypotheses,
synthetic ──┼──►  WAIT when live   ──►   hints from the track  ──► designation, epochs, convictions
live ───────┘     frames lag                                       streams: per-emitter beacon phase
                                                                   store + lease: ledgers, identities
                                                                          │
                                                   exit ◄── peel ◄────────┘
                                          (early exit, exhausted,  (coalition ladder)
                                           dead clip, dead air)
```

- **Source** (`src/source.js`): one interface — how much exists so far, and the
  frames of a span. A recording seeks; a synthetic source renders lazily; a
  live source is a ring buffer the camera fills, and a span that does not exist
  yet is waited for.
- **Scheduler** (`src/schedule.js`): which spans to decode and when to stop —
  the bootstrap window, the ledger-steered plan (`harvest.planSpans`: seek only
  spans that hold unknown droplets), the unvisited sweep, one retry at double
  length for a window that locks nothing, the hold for a beacon still
  assembling after the payload completes, the dead-clip guard, and the cure
  windows.
- **Track** (`src/track.js`): one registration history per emitter per clip. A
  new solve continues its hypothesis only within a scale class; a jump starts a
  new hypothesis, recorded and never silently adopted. Tile designation is a
  clip-wide majority. Every banked droplet carries its **epoch** — the window
  and the hypothesis it was read under.
- **Conviction.** A hypothesis is convicted when its scale breaks from the
  clip's hardened consensus by more than that consensus's own spread allows,
  and it is also a minority in support or used a different registration method.
  Conviction is reversible and recomputed as evidence arrives.
- **The cure** for a false registration: droplet-level liar elimination, then
  exclusion of the convicted epochs, then a re-decode of their spans under the
  track's consensus pose. Exclusion is a view, never a deletion: the ledger
  keeps every conflicting read as a witness, and the peel tries a ranked ladder
  of views (trusted, everything, each alternative) until one validates.
- **Streams** (`src/stream.js`): each emitter's beacon phase track accumulates
  across windows, so an envelope longer than a window still frames. Seams are
  stitched by whole-turn offsets; a span that overlaps nothing is marked with an
  erasure. The span rolls at 60 s to bound clock drift.
- **Store and lease** (`src/harvest.js`): ledgers are content-addressed;
  identity **contexts** are keyed by the tag. A context is *bound* while the tag
  is seen, *coasting* while only data locks hold, in *grace* when nothing locks,
  and *clipped* when grace expires. Resumption in grace banks provisionally
  until the next seal matches. Before any seal, the operator's declared profile
  stands in for the identity: droplets bank into one operator ledger, and each
  emitter's beacon chunks bank separately until its envelope seals.

**Time pricing** (the lease defaults, ruled 2026-09-01). Beacon-priced rules
count envelope cycles; data-priced rules count seconds.

| rule | default |
|---|---|
| grace before a lost context is clipped | 2 envelope cycles |
| a coasting hold ends after a zero-lock stretch of | 8 s |
| a beacon bank is stale after no new chunk for | 1.5 envelope cycles |
| holding for a beacon after the payload completes, at most | 4 envelope cycles |

Profiles without a beacon count windows instead.

**Outputs.** Every harvest posts a log, `harness/results/field-<stamp>.json`:
per-window rows, the event stream, the track and stream summaries, the
scheduler's exit reason, and the final peel. Beside it goes the ending store,
`harness/results/store-<stamp>.json`, which a later harvest can carry in so it
decodes only what this one lacked.

## Module map

| group | modules |
|---|---|
| emission | `profile.js` (the contract and validator), `emission.js` (schedules and the analytic renderer), `flicker.js`, `dtrig.js` (deterministic trig for golden frames), `prng.js` |
| geometry and registration | `geom.js` (homographies, sampling), `register.js`, `saddle.js`, `plate.js` (bullseye solve and the beacon channel), `conic.js` |
| measurement | `sample.js`, `transform.js`, `separate.js`, `rowtime.js` |
| symbols and carriage | `demap.js`, `fountain.js`, `ser.js` (reference-stream scoring) |
| orchestration | `pipeline.js` |
| receiver state | `harvest.js` (ledgers, the lease, the planner), `track.js`, `stream.js`, `schedule.js`, `source.js` |
| test support | `degrade.js` (blur, noise, drops, flips, rotations, exposure, resampling) |

## Conventions

- Plain classic scripts. Each module registers `OC.<name>` in the browser and
  exports through a CommonJS guard. No dependencies, no build step, no WASM.
- Images are `{w, h, data}` luminance: `Float32Array` in [0, 1], or
  `Uint8Array` with `norm`.
- The `src/` modules are pure. The pages own the DOM, the video element, and
  the network.
- The golden render path uses `dtrig.js`, so frames are bit-identical across
  engines; the live decoder uses native `Math`.

## Reference IDs

Comments in the code refer to the design's constraints, findings, and rulings
by short IDs. The documents they come from — the original design spec, its
first review, and the rulings recorded as the design evolved — are not in this
repository; this section defines every ID the code uses. Comments also credit
decisions to *the practitioner*, the project's owner, with the date each was
made.

### Constraints (C1–C11)

The original spec's hard constraints on the deployment environment.

| ID | constraint |
|---|---|
| C1 | Live camera capture (`getUserMedia`) needs a secure context: HTTPS or `localhost`. Recorded clips do not. |
| C2 | Auto white balance and auto exposure cannot be reliably disabled, so no information may live in absolute brightness or colour — only in geometry, rate, and phase. |
| C3 | A rolling shutter reads the sensor row by row, so a moving edge shears during capture (see F2). |
| C4 | Frames drop routinely, so nothing may depend on a contiguous frame sequence: the symbols are differential and the payload is fountain-coded. |
| C5 | Display refresh limits modulation to 60–240 Hz. |
| C6 | Global-shutter phone cameras exist: never depend on rolling-shutter behavior. |
| C7 | Visible light only in practice: near-infrared is never required. |
| C8 | The decoder is plain JavaScript: no WASM and no libraries. |
| C9 | A mirror flips handedness. The receiver is told through a configuration flag and never guesses. |
| C10 | Front and rear cameras are different instruments: measure each separately. |
| C11 | People can see the emission, so photosensitivity limits its parameters (see F1). |

### Findings (F1–F9)

The findings of the spec's first review.

| ID | finding |
|---|---|
| F1 | Local flicker near a ring edge is k·f_rot for harmonic k, not f_rot. The photosensitivity bound applies to k times the rotation rate, including the modulation's deviation; low contrast and soft edges are the free mitigation. `flicker.js` computes it. |
| F2 | A rolling shutter samples each part of a ring at a different time. The static shear cancels in frame-to-frame phase differences; the remaining tears are repaired by fitting against each sample's image row (`rowtime.js`). |
| F3 | Layer 0's parameters are fixed; everything above layer 0 is declared by the emission. A receiver must not decode higher rings before reading that declaration, because a rotating pattern can alias into a plausible false rotation. |
| F4 | Every length is measured in fiducial widths from the plate center (in v3, the flat outer circle defines the unit), so the geometry is independent of the camera's scale. |
| F5 | Coupling rules between the shape and phase channels: (a) the harmonics' phases are static pilots; (b) the k = 1 harmonic is confounded with registration error, so it guides the phase branch but never enters the estimate (**F5b**); (c) every ring needs an odd harmonic, or a half-turn symmetry halves the cycle-slip bound (**F5c**); (d) harmonic magnitudes need floors so their phase stays defined. |
| F6 | A one-way broadcast has no return path, so any liveness signal must ride another medium. |
| F7 | Persistent occlusion identifies itself: mark it as erasures, not errors, because erasures are worth about twice as much to the decoder. |
| F8 | Golden vectors: a decoder must be byte-exact against committed frames, and an encoder conforms when a reference decoder recovers its output byte-exact. The reference frames render with deterministic trigonometry (`dtrig.js`). |
| F9 | Smaller notes, among them: keep a mid-gray surround so the plate never saturates, and normalize each radial profile locally, because an absolute threshold would bring back intensity dependence. |

### Rulings and amendments

| ID | ruled | what it settled |
|---|---|---|
| v3 ruling 1 | 2026-08-16 | Two presets — resilient (24-bit droplets) and high-rate (48-bit) — each with one droplet size shared by every ring. |
| v3 ruling 2 | 2026-08-16 | The steady state is QR-free; the envelope rode a countdown QR at each loop boundary (later omitted by v4 clause 1). |
| v3.1 amendment 2 | Aug 2026 | Quadrant swap-target corner marks, read by saddle registration. |
| D-ring ruling 1b | 2026-08-23 | The control ring moves to band A's inner edge on every tile; the breaker ring stays, static. |
| D-ring ruling 2 | 2026-08-23 | Chunked control framing, with the envelope's CRC16 as the fast identity tag. |
| D-ring ruling 3 | 2026-08-23 | Pacing is the v3.1 standard, so it needs no wire flag. |
| D-ring ruling 4 | 2026-08-23 | The envelope's tile and grid fields, scoped to one panel; sessions never tile together by default. |
| v4 clause 1 | 2026-08-28 | The envelope QR is omitted. |
| v4 clause 2′ | 2026-08-28 | The bullseye and the breaker retire into a three-section center target; the designated tile carries the inverted variant. |
| v4 clause 3 | 2026-08-28 | The geometry change: quiet zone to 0.70, band A's inner edge to 0.95, and the control amplitude budget to 0.090, behind family byte 4. |
| v4 clause 4 | 2026-08-29 | The training window. Its content was refuted — a droplet's CRC binds its slot to its position in the stream — so freeze 0 is the standing posture instead. |

Test IDs (T…, TH…, TR…) name the cases on the suite pages ([testing.md](testing.md)).
