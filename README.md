# Phryctoros

**The beacon-watcher** (φρυκτωρός): an optical carriage lane that moves small
signed artifacts between devices as rotating light — any commodity screen is the
fire, any phone camera is the watcher. The contingency tier of the Stasima
carriage tree; sibling of [stasima](https://github.com/antistrophos/stasima).

Spec: `technical/optical-carriage-software-spec.md` on Pharos's branch (Rehearsal,
thread `out-of-band-carriage`); first-read review beside it. This repo currently
implements **Phase 0** — the measurement harness the spec says to build first —
plus the shared emission/decode core it sits on. Layer 0 already decodes end to
end from real phone footage: 25/25 symbols, zero errors, both sync paths proven,
Firefox/Chrome parity confirmed by the practitioner's own runs.

## No build, no dependencies, no Node

Everything is plain classic-script JavaScript (C8 discipline: the decode path is
plain JS, no WASM, no libraries). Serve the repo root over HTTP for the live-camera
path (C1 needs a secure context):

```
python -m http.server 8123
```

…or open `harness/receive.html` **directly from disk** for the recorded-input path
(§9.1): file-input decode needs no camera, no network, no secure context. The
`harness/` page plus the `src/` folder on a USB stick is the sneakernet deliverable —
or better, one file: `python build_standalone.py` inlines everything into
`dist/receive-standalone.html` (self-test verified). That single file is what goes
onto a phone. Re-run the script after any `src/` change.

## Pages

| page | what it is |
|---|---|
| `harness/emit.html` | over-provisioned test emission; flicker table (review F1) gates an explicit Start; loops with a marked capture window |
| `harness/receive.html` | live camera or video-file decode; session metadata; per-layer SER/SNR; CSV export; acuity plot |
| `harness/test.html` | the software round-trip + degradation suite — run after any change |
| `harness/selfchar.html` | §6.1 self-characterisation v0 (latency + refresh/capture beat) — untested on real hardware |
| `harness/golden.html` | golden-vector manifest scaffolding (F8 conformance model: decode-exact, encode-by-decode) |

## Architecture

`src/` is dual-environment (browser globals under `OC.*`; CommonJS-guarded for a
future Node runtime). Pipeline stages follow spec §9:

```
emission.js    profile → schedules → analytic per-pixel frames (dtrig.js = deterministic golden path)
register.js    stage 2 — EVERY fiducial in frame (1:1:3:1:1 scan), one homography per emitter (§5.1)
sample.js      stages 4–5 — radial profiles, self-normalized 0.5-crossing boundary; row timestamps carried (F2)
transform.js   stage 6 — DFT at harmonics of interest + noise bins
separate.js    stage 7 — phase ladder: k=1 anchors (down-weighted, F5b), high k carry precision
rowtime.js     stage 6b — F2 row-time TEAR repair: step-model seam scan, clean-side refit
demap.js       stage 8 — differential demap; (offset, lag) preamble alignment; low-confidence → erasure
ser.js         stage 9 stand-in — SER/erasures vs the seeded reference stream
pipeline.js    orchestration incl. mirror parity (C9, applied once), handheld re-registration
profile.js     the contract + validator (units: fiducial widths — F4; slip, collision, odd-pilot rules — F5)
flicker.js     k·f_rot photosensitivity report (F1) — consulted by the validator and the emitter page
degrade.js     §10.2 transforms (blur, noise, drops, flip, rotate, exposure, resample, composites)
```

## Suite status

All assertions green at last run — `harness/test.html` is the source of truth.
Coverage: clean round trip SER 0 on all three annuli; exposure/WB ramp zero-effect
(C2); mirror parity (C9); drops → erasures not errors (C4); preamble (offset, lag)
lock; mid-loop stream-correlation lock; blank-prefix (countdown) captures;
torn-duplicate selection (the 15 fps tear defense); 25° frame rotation; two-emitter
frames (§5.1); range-proxy degradation shapes; deterministic golden rendering.

**Two findings the suite produced** (details in the corpus entry):
1. Harmonic survival is **noise-limited, not resolution-limited** — subpixel edge
   integration reads a 0.45 px wiggle perfectly in noiseless frames. The field
   acuity curve will be set by sensor noise + codec loss (§9.1's "compression is
   the real cost", confirmed from the other side).
2. **Registration is the first casualty at extreme range** — the fiducial's modules
   die before layer 0's annulus does. Fallback coarse registration (outer-annulus
   circle fit) is the v0.2 item that extends range past finder death.

## v0 scope cuts (deliberate, documented)

- Boundary channel runs **static pilots** (per-harmonic SNR is measured, which is
  what the acuity triple needs); magnitude modulation is v1.
- Fiducial is finders-only (registration is what Phase 0 exercises); the enrollment
  QR payload needs a QR encoder and is future work — C8 binds the decoder, not the emitter.
- Homography is affine-from-3-finders + parallelogram completion; fine for
  near-frontal Phase 0 geometry, refine for steep off-axis later.
- Symbol clock assumes capture ≈ emitter fps (true-30 both sides); clock recovery is v1.
- Fountain layer deferred; erasures are counted and reported (F7 posture).

## Field protocol

`docs/phase0-protocol.md` — the hallway walk, per-camera sweeps, recorded-mode
phone flow, and the §9.1 file:// checks to run on real phones.

## License

[Apache 2.0](LICENSE) — see also [NOTICE](NOTICE).
