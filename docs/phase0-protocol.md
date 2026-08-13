# Phase 0 field protocol — the afternoon in the hallway

Spec §6: produce the acuity curve — per device pair, range, lighting: which layers
decode, at what rate. The harness logs everything; you provide legs and phones.
"This is an afternoon in a long hallway or a car park, not an engineering project."

## Setup

1. **Emitter**: a laptop (or TV) serving the repo (`python serve.py 8123` — the
   no-store server; hard-refresh pages after updates), showing `harness/emit.html`.
   Validate the profile (flicker table appears — read it), set loop 60 s, Start,
   **Fullscreen, plugged into power, window focused**. Browsers throttle rendering
   under battery saver — the first field clip recorded a frozen emission. The
   emitter paints a red STALL banner into the canvas and the HUD when rendered
   fps sags; **do not film while the banner shows**. Note the screen's physical
   width for the tx_size field.
2. **Receiver**: a phone. Two modes — run both when possible:
   - **Live** (needs HTTPS or localhost — usually easiest on a laptop receiver, or
     via a local HTTPS tunnel): open `harness/receive.html`, start camera, capture 8 s.
   - **Recorded (§9.1, the default for phones)**: film the emitter ~15 s with the
     STOCK camera app at **normal 30 fps** (60 also works; highest quality, no
     zoom past optical), then feed the file to `receive.html` — or the single-file
     `dist/receive-standalone.html` — via the video-file input. The emission runs
     at **15 fps** so every emission frame gets ≥2 camera looks: the decoder keeps
     the tear-free one (rolling shutter reading a mid-update screen splices two
     instants into one frame — the field-clip-2 finding). **Start filming during
     the 3-2-1 countdown freeze**; mid-loop starts also decode via stream lock.
3. Fill the metadata row BEFORE each capture: range (measure or pace it), lighting
   category, tx type/size, rx device, camera (rear/front — C10: they are different
   instruments), handheld unless propped.

## The walk

- Start at 1 m. Capture. Step back: 2, 3, 4, 6, 8, 12, 16, 24 m (double-ish steps
  once past 4 m). Capture at each.
- Watch the per-layer table: the range where each annulus stops decoding is the
  acuity curve materialising. Keep walking one or two steps past where layer 0 dies
  (that tail pins the curve's knee).
- Repeat the whole walk: (a) rear camera, (b) front camera, (c) at least one other
  lighting condition, (d) at least three phone models before the curve is trusted.
- Export CSV after each sweep (rows accumulate in-page; export before closing).

## What to watch for (the review's open questions)

- **Registration death vs layer-0 death** (suite finding): note the range where
  "no emitter found" appears vs where annulus 0 stops. If registration dies first
  in the field too, the fallback circle-fit registration moves up the queue.
- **Recorded vs live at the same range**: recorded should be equal or better
  (non-causal decode headroom) except where codec loss bites — §9.1 says
  compression is the real cost; the CSV pairs will show it.
- **Sub-3 Hz decode parity** (§7.7 / F1): the default profile's rotations are
  already ≤1.5 Hz. If SERs match the physics expectations at these rates, the safe
  rate costs nothing — log it and the question closes.
- **Handheld vs propped**: tick the handheld box honestly; it switches per-frame
  re-registration on.

## The §9.1 spike on real phones (single highest-value unknown)

On each phone, with the repo copied to local storage (USB/AirDrop/Files app):
1. Open `harness/receive.html` from the local file manager in the default browser.
2. Check the capability banner: it states origin and camera availability.
3. Feed it a clip filmed with the stock camera app. Record in the session notes:
   does file-input decode work from `file://` (or the platform's local-file origin)?
   - Android/Chrome: also try a localhost file server app if plain file:// balks.
   - iOS/Safari: try both Files-app open and a saved-to-Photos clip.
4. Any failure: note the exact error text — it decides whether the sneakernet
   enrollment story needs a packaging change (single-file build, PWA, or app shell).

## Outputs

- One CSV per sweep, named `acuity-<device>-<camera>-<lighting>.csv`.
- The receive page's plot is the live sketch; the committed curve comes from the
  CSVs (layer index vs range, per camera, per lighting).
- File findings to Pharos (thread `out-of-band-carriage`) — especially §9.1
  results and any registration-death ranges.
