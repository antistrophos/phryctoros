# Field workflow

A capture moves through five steps: a **ticket** in the order window, a
**synthetic twin**, the **emitter**, the **camera**, and the **ingest** into the
registry. One card, filled once in the take console, configures every step
with the same settings, so the steps cannot disagree.

```
orders.html ──► take.html ──► ① twin      receive.html?synth=…
  the ticket     the card  ├─► ② emit      emit.html?settings=…
                           └─► ③ ingest    receive.html?settings=…  ──► registry.html
                                           (choose the clip file)
```

## 1. The order window

`harness/orders.html` shows the capture queue, `harness/capture-queue.json`,
against the evidence on disk. The queue is committed: the experiment plan is
part of the record. Each ticket names what to capture and how to recognize it:

```json
{
  "id": "stream-handheld-range",
  "title": "…", "why": "…",
  "twin": true, "count": 1,
  "match": { "dring": "a42q,a42k", "tiling": 2, "distance_ft": 13, "distance_tol": 2,
             "zoom_x": 5, "mount": "hand", "peel_ok": true },
  "card": { "t_dring": "a42q", "t_tiling": "2", "t_dring2": "a42k", "t_loop": "180", "…": "…" }
}
```

Completion is derived from evidence, never checked off by hand. Every 10 s the
page scans the posted harvest logs (`harness/results/field-*.json`). A ticket is
satisfied when a matching twin exists (if `twin` is true) and `count` camera
logs match. The `match` fields are `dring`, `tiling`, `distance_ft` (with
`distance_tol`, default ±1), `zoom_x` (±0.5), `angle_deg` (with `angle_tol`,
default ±8), `mount` (a substring of the card's mount), `live` (the log came
from a live harvest), and `peel_ok` (the payload validated).

The top card is the next capture to take. Its button opens the take console
with the ticket's card.

## 2. The take console

`harness/take.html` holds the card. Fill it once:

- **The emission**: the D-ring code (a second code for the B tile of a 2-up,
  or a list of six for a 6-up sweep), the profile (v3.1 resilient or
  high-rate), the tiling, the loop length (default 180 s), quadrant corners
  (on), the countdown freeze (off: the current center target requires none),
  and the payload text. The window floor and ceiling are optional.
- **The shot**: distance (ft), angle (°), zoom (×), lux, lighting, device,
  mount (tripod, handheld, or braced), and notes. The console stamps a take id.

The card becomes one settings string, the same for every step:

```
oc1 prof=v3 payload=1 tiling=1 quad=1 qrp=0 dring=a42q loop=180 freeze=0 capfps=60
```

The three buttons hand it on:

1. **Twin** — `receive.html?synth=…` runs the synthetic twin of this exact
   configuration and posts its log. Run it before the film session: if the twin
   fails, the fault is in the software, and no footage is needed to find it.
2. **Emit** — `emit.html?settings=…&msg=…&take=…` arms the emitter.
3. **Ingest** — `receive.html?settings=…&take=…&phys=…` arms the receiver. The
   take id and the shot's conditions ride into the harvest log, so the registry
   inherits them without retyping.

## 3. The emitter

The emitter page validates the profile and shows the flicker report. Press
**Start**, then **Fullscreen**. Keep the emitter plugged in, its window
focused, and battery saver off: a throttled browser freezes the pattern, and
the page then paints a red **RENDERING STALLED** banner. Do not film while the
banner shows. Stop the emission before changing any setting.

**Export loop video** renders the whole loop to a `.webm` file. Any screen that
plays video becomes an emitter, and ingesting the export directly is a
camera-free check of the video path (the registry lists it as an export
capture).

## 4. The camera

- Use the stock camera app at **60 fps** (the v3.1 emission runs at 30 fps, so
  each emission frame gets two looks).
- Use **optical zoom only**. On a phone whose telephoto lens is 5×, zoom past
  5× is digital: in the 2-up takes at 13 ft, digital zoom kept the payload but
  lost the beacon.
- Frame every plate with margin. Hold still or use a tripod, and record the
  mount honestly on the card.
- Start at any point in the loop; the receiver joins mid-loop. Film for a minute
  or more at range. The harvest stops as soon as the payload validates, so a
  longer clip costs nothing.
- **Keep clips local.** Footage shows the room. Store clips outside the
  repository or in `clips/`, which git ignores; never commit them.

## 5. The ingest

The card's **Ingest** link opens the receiver armed. Choose the clip in the
video-file input. The harvest decodes window by window and prints a line for
each: droplets banked, binds and seals, the peel's progress. When it finishes
it posts:

- `harness/results/field-<stamp>.json` — the harvest log: settings, take id,
  physical conditions, per-window rows, the event stream, and the verdict.
- `harness/results/store-<stamp>.json` — the ending store, which a later
  harvest can carry in so it decodes only what this one lacked.

Within 10 s the order window counts the log against its tickets.

## Live capture

The receiver can also decode straight from a camera: **Start camera**, frame
the plate, then **Live harvest**. The harvest follows the camera and stops when
the payload validates, or after 30 s in which nothing locks; **Stop live** ends
it early. The log records the source as live.

Live capture needs a secure context: `localhost`, or HTTPS. `serve.py` listens
on `127.0.0.1` only, so the practical rig is a computer's own camera on
`localhost`. A phone can reach the page only through an HTTPS tunnel or another
server. Live capture is certified on the synthetic live twin
([testing.md](testing.md)) but not yet on a camera.

## The registry

`harness/registry.html` turns harvest logs into capture records. It ingests the
posted logs, extracts the metrics (per-ring lock duty, wire rate, goodput, the
exit point, bind and seal windows, the receiver's exit reason, convictions,
re-decodes), and shows each record's physical conditions — inherited from the
take card, or annotated by hand. It compares the captures against proposed
standards and fits range falloff.

Select a capture to **re-run** it: the registry re-arms the emitter and the
receiver with the capture's exact settings, and can carry its ending store.

**Save** writes `harness/results/registry.json`, the one results file the
repository lets you commit.

## Practice

- Run the twin before every film session.
- Change one thing between takes, and let the card record it.
- Record the conditions honestly: mount, zoom, lighting.
- Leave the room safe: the emitter never autoplays, and nobody needs to watch
  it.
