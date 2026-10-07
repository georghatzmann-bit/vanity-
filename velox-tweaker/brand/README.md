# VELOX brand – "Versatz"

This folder is the **single source of truth** for the VELOX identity: the wordmark, the app
icon, the colour tokens, the start sequence with its sound, and the installer's progress and
readout pieces. Three surfaces embed it **unchanged**:

1. **VeloxSetup.exe**: the installer intro (WebView2, 880×560 borderless). The welcome screen
   arrives under the settled wordmark on the same surface, and so does the install progress.
2. **VELOX.exe**: the start screen shown while the PowerShell backend starts (0.5–10 s), then the
   hand-over to `http://127.0.0.1:<port>/`.
3. **The web UI (`ui/`)**: the in-app splash (Start.bat / Edge window, and the short continuation
   after the VELOX.exe hand-over), the sidebar brand, and the retheme tokens.

**Rule: copies must stay byte-identical.** A surface copies the files it needs into a folder
named `brand/` (for example `ui/brand/`, `native/setup-ui/brand/` or `native/host/start/brand/`)
and never edits them there. Change things here, then copy them again.
`node brand/tools/check-copies.mjs` compares every `brand/` copy in `velox-tweaker/` with this
folder (SHA-256) and exits 1 on any difference. Put it in the build.

The idea: every letter is cut once horizontally (band 44–52 of a 100-unit cap) and sheared 9°.
The upper halves sit one step (+7) ahead, so the word looks like it is already moving. The intro
shows that cut happening and then strikes the halves into place. The signal orange lives only
where the cut is.

---

## Files

| File | What it is |
|---|---|
| `intro.js` | The start sequence (ES module). `VeloxIntro.mount(…)`, the pure `render(t)` (word **and** light: the canvas light, the letters' colour, the SVG light on the letters, the needle), `soundPlan()`, `celebratePlan()` and the light painter. Also exports `SPARKS` / `LEAD` (the sparks and the halves' leading edges they come from) for tests. |
| `light-worker.js` | The light, drawn off the main thread: a module worker with an OffscreenCanvas that runs the same `render(t)`. Loaded by `intro.js`; ship it next to it. |
| `sound.js` | Web Audio synthesis (ES module). It turns a plan into sound, live or offline. No samples: the noise and the room's impulse response are generated from seeds. |
| `glyphs.js` | **Generated** letterform data for `intro.js`. Do not edit by hand. |
| `ticks.js` | The installer's tick-row progress (ES module), `VeloxTicks.mount(…)`. |
| `intro.css` | Styles for the sequence. `mount()` links it automatically if the page has not. It `@import`s `tokens.css` only. |
| `kit.css` | Styles for the installer pieces in the slot: mono readouts (`dl.vx-readout`) and the tick row. Imports `tokens.css` only. |
| `tokens.css` | The palette. Only `--vx-*` names, so loading it never changes a host page's own variables. |
| `tokens-app.css` | The mapping of the palette onto the app's existing variable names (`--bg`, `--accent`, …). **Only `ui/` links it**, explicitly. Nothing in the intro imports it. |
| `wordmark.svg` / `wordmark-light.svg` | The wordmark for dark / light grounds. Use from 24 px cap height up. |
| `wordmark-small.svg` / `wordmark-small-light.svg` | The small master: cut band 2 px at 16 px height, offset 1 px, horizontals on the 16 px grid. Use it below 24 px cap height and render it at **16 or 32 CSS px** high (sidebar, title bars). |
| `mark.svg` | The mark: the wordmark's V, lifted out, with no tile. For in-UI use. |
| `app-icon.svg` | The app icon: the V on a lifted tile (`#1A1B1F`) with a keyline (`#45484F`), so it separates on a dark taskbar. |
| `mark-16.svg` | The 16 px pixel master (see *Small icons*). |
| `lockup.svg` | Icon tile plus wordmark, for documents and the README. **Not** for the sidebar: the sidebar shows the wordmark alone. |
| `export/app-icon-{16…256}.png` | PNGs for the `.ico` and the installer. 16/20/24 come from the pixel masters, 32/40/48 from edge-snapped vectors, 64+ from `app-icon.svg`. |
| `preview.html` (+ `preview.js`, `preview.css`) | Dev page. Shows the long, short, reduced and still variants, `celebrate()`, the installer layout with the progress, mute, status, progress, `done()` and `skip()`. Not shipped. |
| `src/` | `geometry.mjs` (letterforms), `build.mjs` (regenerates every SVG and `glyphs.js`), `pixelfit.mjs` (small masters). |
| `tools/` | `check-copies.mjs`, `verify.mjs` (browser checks), `export-icons.mjs` (PNGs). |

Ship only the runtime files: `intro.js`, `light-worker.js`, `sound.js`, `glyphs.js`, `intro.css`, `tokens.css`, plus
`ticks.js` and `kit.css` in the installer, `tokens-app.css` in `ui/`, and the SVGs a surface uses.

---

## API

```js
import { VeloxIntro } from './brand/intro.js';

const intro = VeloxIntro.mount(container, {
  variant: 'long',          // 'long' (default, every launch) | 'full' (= 'long', 1.2.0's name) | 'short' ('Kurz') | 'still'
  sound: true,              // false: no audio at all, and no sound button ('still' never has either)
  muted: undefined,         // true/false overrides the remembered setting (localStorage 'velox.sound')
  reducedMotion: 'auto',    // 'auto' (prefers-reduced-motion or ?reduced=1) | true | false
  place: 'hero',            // 'hero' = start screen, 'header' = word near the top, slot below (installer)
  loader: true,             // the hairline loader + status line under the word
  statusText: 'Dienst wird gestartet',
  labels: null,             // e.g. 'Version 1.1.0': one small label, top right, sentence case
                            // (an array [left, right] still works; leave the left one empty)
  handedOver: false,        // 'still' only: start in VELOX.exe's end pose (canonical wordmark, no loader)
  onMuteChange(muted) {},   // called on every mute change (M key or button); persist it yourself if storage is off
  lightWorker: true,        // false: draw the light on the main thread (it falls back to that by itself if the worker cannot load or has not come up within 0.9 s of boot; the clock starts after)
  quality: 'auto',          // 'auto': measure the first ~30 frames; if their 95th percentile is over 18 ms, step down
                            // to 'low' (the light canvas on half the pixels, no veil, no bloom). 'high' | 'low' force it.
});
```

The container decides the size. It gets the class `vx-host` (`position: relative`), and the
intro fills it and follows resizes (ResizeObserver) and DPI changes.

| Returned | |
|---|---|
| `intro.status(text)` | Sets the status line (`aria-live="polite"`). |
| `intro.progress(p)` | `0..1` shows a determinate fill and a mono percentage. `null` goes back to the sliding segment. The fill eases frame-rate independently. |
| `intro.done()` → `Promise` | The hand-over. It waits until the motion is over — the end of the light sweep (`calm`, **2.55 s** in the long intro; the settle in the others) — not for the loader to come in; it never cuts the strike or the sweep short. Then the loader fades, the ember in the cut goes out, its orange segment snaps up into the cut line with one quiet click (+120 ms), holds, and retracts right to left into the V's foot. The promise resolves **430 ms** after the snap starts, on the canonical wordmark. A timer also resolves it if the window is hidden and rAF stops. It also releases the keyboard. |
| `intro.destroy()` | **Required** when the host is done with the intro (after `done()` and your fade, or when you replace the page content). Removes the DOM, the listeners, the DPI watcher and the ResizeObserver, and closes the audio context. |
| `intro.skip()` | Jumps to the settled state and fades any playing sound out within 60 ms. Esc, Enter, Space, a click on the intro and the *Überspringen* button do the same (at any time; a skip during boot, before `ready`, is kept and applied when the clock starts, without sound). Enter and Space on a button inside the slot are left alone; a click that unlocks blocked audio replays instead (see *Autoplay*). |
| `intro.celebrate()` → `Promise` | **New.** The installer's finish, for the done screen — the identity's own motion, small: while a light streak runs the cut (220 ms) the upper halves draw back 1.8 units, then **re-lock**: they snap forward into the stop (+8.7, a 17 ms hit-stop, a spring back to +7); the cut flashes (needle, flare, a light bloom), its light rises on the cut edges, a few sparks fly forward, and a narrow sheared sweep crosses the word (430–770 ms). Sound: the streak's whoosh, a dry **thump on the stop**, a bright G-major chime, the glint, in the room (about −22 LUFS). Waits for the settle, resolves at **1.3 s** with the word at rest and only the resting ember left. Reduced motion: a calm ember pulse only, and the chime. Callable again afterwards. |
| `intro.setMuted(b)` | Mutes or unmutes. `M` and the sound button toggle it. The setting is remembered. Muting stops the cue (60 ms fade) and `audible` turns `false`. Unmuting mid-intro plays the cue's events that are still ahead (including the impact), but only if it can still land the hit in sync (up to 30 ms before the strike); a drone or riser already under way is not picked up halfway. |
| `intro.settled` | A promise that resolves when the intro is at rest. The installer brings its welcome in on it (automatic for `loader: false`). |
| `intro.slot` | An element under the word, on the same left edge. The installer puts its content here. |
| `intro.ready` | Resolves after boot (CSS loaded, audio prepared, clock started). |
| `intro.muted`, `intro.audible`, `intro.blocked`, `intro.startedAt`, `intro.variant`, `intro.keysActive` | State, for hosts and tests. `blocked`: sound is wanted but the browser has not allowed audio yet. `keysActive`: the window keydown listener is attached. |
| `intro.replay()` | |
| `intro.seek(ms, {doneAt, fill, celebAt})`, `intro.plan()`, `intro.celebratePlan()`, `intro.layout()`, `intro.timeline()` | Capture and test hooks. Use them with `clock: 'manual'` (the light is then drawn on the main thread, frame-exact). `timeline().name` is the timeline that plays (`'long'` for `'full'`). |
| `intro.lightThread`, `intro.lightProbe()`, `intro.lightStats()`, `intro.lightQuality` | Tests: `'worker'`/`'main'`/`'none'`; the number of lit light pixels right now (Promise; at rest that is the low ember in the cut); the worker's draw cost per frame `{ n, max, over }` (over = frames over 8 ms); `'high'`, or `'low'` once the adaptive quality stepped down. |

`VeloxIntro.pickVariant(version, opts)` returns **`'long'` on every launch** (the owner's call:
like a console or G HUB boot). It returns `'short'` only when the person chose *Kurz*:
`opts.prefer === 'short'` or localStorage `velox.intro` = `'short'`. It still records `version`
in `velox.intro.seen` (the 1.2.0 signature `pickVariant(version, key)` works). Native hosts can
pass the variant directly; a setting "Startanimation: Lang / Kurz" maps onto `prefer`.

**Keyboard.** The intro listens on `window` only while its controls exist: until `done()`
resolves (start screen), until the intro settles (installer, `loader: false`), never for
`still`, and never after `destroy()`. So `M` pressed later in the app or in the installer form
changes nothing.

**Autoplay.** The intro tries to play sound right away. If the browser blocks it, the intro runs
silent and the sound button says **"Ton: klicken"** (not pressed) instead of claiming "Ton an".
The unlocking gesture — a click on the intro, the button, or `M` — never mutes: it resumes audio
and, **before the settle and only while the slot is empty**, replays the intro from the start
with sound, once. After the settle, or with installer content in the slot, a click is just a
click: nothing restarts under content someone is reading. Both native hosts should allow autoplay
(see below), so this is the fallback for the Edge window.

**Reduced motion** (`prefers-reduced-motion` or `?reduced=1`): the word fades in over 0.6 s,
already locked. No light, no camera, no blade and no travel, the loader segment rests (it breathes in
opacity only), and the sound is only the soft tone.

### `ticks.js` (installer progress)

```js
import { VeloxTicks } from './brand/ticks.js';     // + <link rel="stylesheet" href="brand/kit.css">
const bar = VeloxTicks.mount(intro.slot, { status: 'Dateien werden kopiert', step: '1 / 5' });
bar.set(0.42);  bar.status('Sicherung wird angelegt');  bar.step('3 / 5');
bar.done('Fertig. VELOX ist installiert.');   // or bar.fail('Kopieren fehlgeschlagen')
bar.destroy();
```

A row of 1-device-pixel scale ticks every 6 px (every tenth one taller), on a common baseline.
Done ticks are bone, the one being worked on is the only orange column (on `fail()` it turns
`--vx-risk`), at 100 % there is no orange at all. Status left (UI font), step and percentage
right (mono, tabular). The canvas is sized and nudged onto whole device pixels, so the ticks stay
one crisp pixel wide at 100, 125 and 150 %. The fill eases frame-rate independently and runs
rAF only while it moves; with reduced motion it jumps. `role="progressbar"` with `aria-valuenow`.

Readouts: `<dl class="vx-readout"><dt>Ziel</dt><dd>C:\Program Files\VELOX</dd>…</dl>` — mono,
tabular, labels in ash, values in bone, sentence case, no letter-spacing.

---

## Timings

All times are on the intro clock (t = 0 when boot is done, about 100 ms after mount; with sound, the cue is scheduled 250 ms ahead and t = 0 is put on its start).

**Long ("Zündung"): 3.00 s to settled, `done()` can hand over from 2.55 s. On every launch and
in the installer** (`'full'` plays it too). Benchmark: a G HUB launch — light draws the mark,
ignites it, sweeps it — but every light lives in the cut, every colour is the heat ramp of the
signal orange (ember → signal → amber → white-hot), and the strike is still 1.2.0's spring.
The letters' own light (outlines, rims, the sweep) is SVG, as crisp as the letters; the light in
the cut and around the word is the canvas; the cut's white-hot core is one DOM line in whole
device pixels (the *needle*).

| t (ms) | Picture | Sound |
|---|---|---|
| 0–60 | Black, the version label only. | Silence. |
| **60** | **Act 1 – the ember.** It catches at the V's end of the cut (three flickers). | Three tiny dry crackles; a low drone opens (48 / 72 Hz + a dark rumble). |
| 90–400 | It charges once: the glow swells and pulls a short hot line into the cut. | The charge: a capacitor whine rising three octaves (220 → 1760 Hz) under a spool of filtered noise, cut the instant the streak fires. |
| **400–780** | **Act 2 – the light draws the mark.** The charge fires a streak along the cut (motion-blurred, anamorphic head glint, accelerating to the window's edge). The letters' **outlines** catch it: 1.75 device px, **white-hot where the head touches an edge**, cooling behind it to an ember glow; almost no light on the faces. | A whoosh that follows the head: pan = the head, brightest in the middle, pitch dropping as it passes. |
| 760–1010 | The blade (1.2.0's) runs the cut and opens V E L O X out of it (872, 903, 928, 966, 1007); light spills from each gap; the cooling outlines hand over to the solid letters. | A brighter whoosh; one dry click per letter. |
| 1010–1610 | The camera pushes in (to 104 %). The upper halves draw back (−10 → −13.5). Seven streaks race the cut, each faster and hotter (1145 … 1538, 160 → 70 ms per crossing); two hairlines close in onto the cut. **The word goes down into a warm near-black silhouette** (`#1F1916`, ~12 %) one step per streak, while the light in the cut grows: a 1 px rim lights the edges that face the cut, the needle (1 device px) burns in its centre. | The riser starts under the last click (no hole): three detuned saws low-passed at ≤ 2.6 kHz + a noise band, pulsing with every streak, a reversed swell at the end, cut dead at 1610. |
| **1610–1720** | **The held breath.** Only the needle: white-hot, 1 device px, edge to edge across the window; the silhouette; a glint on the cut edges. | **Digital silence, 94 ms** (1.628–1.722 s). |
| 1694–1720 | The throw: −13.5 → hard stop at +13.2 in 26 ms. | |
| **1720** | **Act 3 – ignition.** The stop. **Two frames (the hit-stop, 1720–1753) overexposed**: the letters white-hot, the needle 3 device px, the flare. From frame 3 the word is lit **from the cut outwards**: the V is signal orange again, the other letters dark with light rising off the cut edges (faces and rims) that cools white → amber → orange → ember (τ 110–220 ms) while their bone returns (bone again by ~2290). The bloom hugs the edges near the cut (τ 120 ms). The camera punches (+3.2 %), the word pops 3.5 %, the lower halves recoil. **Sparks** fly forward off the five upper halves' leading edges (17 tapered streaks, hot head → ember tail, length = speed × 22 ms, a slight arc, + 3 heavier, slower embers), behind the letters. | **The impact** (+2 ms): 1.2.0's crack and metal (+3.5 dB), a bright *shatter* (2–6 kHz), saturated thud, seat, latch, a short sub drop (98 → 48 Hz in 20 ms, τ 0.15 s), punch, mid body, and the metal's inharmonic partials ringing on (0.4–1.1 s) — all of it through a **room** (generated 1.3 s stereo response). |
| 1753–2550 | The spring settles (+7, one undershoot at 1805); the camera eases back to exactly 100 % by 2550; the cut cools into a low ember. | The sub and the metal decay into the tail: a quiet chord (G suspended, 192 / 256 / 288 Hz + 96, low voices τ ≤ 0.6 s) and slow-beating pairs at 768 / 1152 Hz, no tremolo. |
| **2200–2550** | **Act 4 – the sweep.** A narrow band (~2.5 % of the word), sheared at the letters' 9°, white-hot core with amber falloff, crosses the word in 350 ms; the letters' edges glint as it passes (SVG stroke), and the cut under it. | The glint travels with it (pan); at its middle the chord **resolves** (256 → 240 Hz, + 480 / 960 / 1536). No bell. |
| **2550** | **Calm**: the word is at rest. `done()` hands over from here. | |
| 2400–2800 | The loader and the status fade up. | The tail decays; fade 3.40–3.70 s. |
| **3000** | **Settled**: the canonical wordmark, the loader segment loops, and **a low ember stays in the cut** (signal heat 0.3 at 14 %, static: drawn once). It goes out in the `done()` hand-over. | **Digital silence from 3.70 s.** |

Skippable at any time: Esc, Enter, Space, a click, *Überspringen* (the sound fades in 60 ms).
Reduced motion: the calm 0.8 s fade, no light. The light in the cut is drawn on one canvas in a
band around the word, off the main thread (see *Frame timing*); the light on the letters is SVG
(gradients on copies of the pieces) and the needle one DOM line; the word moves by transforms
and is tinted (silhouette, white-hot) on its ten pieces.

**Short: 0.76 s to settled.** For every other launch. The V is already in place at t = 0. A short
blade runs from the V to the end of the cut (40–138 ms), and E, L, O and X open as it passes (54,
72, 100, 130 ms). Their upper halves wait 5 units behind (more would collide with the fixed V).
Thrown at 335, **stop at 352** on +8.9 with a 1.2 % pop and a one-frame (17 ms) hit-stop, one
undershoot (+6.53 at 411), settled by 425. **New in 2.0:** the stop ignites too, small (a white-hot
cut, a short flare, a light bloom, a few sparks; gone by ~600 ms). The sound is **one small hit**
(crack, thud and seat partials, no sub) and a short spark sizzle. The loader arrives at 430–730.

**Reduced: 0.8 s.** The word fades in over 0–600 ms, the loader over 250–750, and the soft tone plays at 100 ms.

**Still: 0 s.** The settled frame at once: word, hairline and status, **no segment** (a short bar
at rest reads as progress stuck), **no sound button**, no skip, no keyboard listener.

**Hand-over (`done()`):** the loader fades (140 ms). The segment accelerates (quadratic) from the
hairline up into the cut over 120 ms while its ends spread to the cut's full width (V to X). It
moves *behind* the letters, so it shows on the hairline and in the cut. **Click at 120 ms.** It
holds for 170 ms, then retracts right to left into the V's foot (140 ms, accelerating). The
promise resolves at **430 ms** on the canonical wordmark — never on a struck-through word — and
the in-app `still` + `handedOver` shows exactly that pose.

**Layout.** Left-aligned, like a hardware box: the V's foot on the left margin (7.2 % of the
width), loader and status hanging from the same edge. Start screen: cap height
`min(16.6 % of the width, 30 % of the height)`, so the word spans about two thirds of the width
(68 % at 880×560, 67 % at 1360×880). Installer header: `min(11.2 % of the width, 17.5 % of the
height)`. The scale is snapped so the cut band is an even number of device pixels; then the cap
line, both cut edges, the baseline and the blade all land on whole device pixels at 100, 125 and
150 %, also when the container itself starts on a fractional device pixel. The blade, the loader
segment and the track are whole device pixels thick (2 px → 3 device px at 125 / 150 %; no soft
fringe).

**Frame timing.** The light in the cut is drawn by `light-worker.js` (an OffscreenCanvas in a
module worker) on a band around the word at a budget of ~150k pixels (soft light, scaled up by
the compositor). The main thread moves the word, tints its ten pieces and updates the SVG light's
gradients (quantised, so most frames write only a few attributes). Audio start-up is split over
small tasks (the noise and room samples before the context exists, the context, the buffers, the
room's convolver in a task of its own, then the cue scheduled 250 ms ahead a few events per task).
**Adaptive quality:** the first ~30 frame intervals are measured; if their 95th percentile is over
18 ms, the light steps down to `'low'` (half the canvas pixels, no veil, no bloom; the SVG light
and the needle stay).

Measured in Chromium 141 headless (software compositing, no GPU) on a shared 4-core machine,
real time with sound, frames over 20 ms per run (~400 frames per run, 3.6–7.2 s watched):

| | 880×560, CPU 4x | 1360×880, CPU 4x | 1920×1080, CPU 4x | 1360×880, CPU 1x |
|---|---|---|---|---|
| this kit, one intro per browser (`perf.mjs`, 3 runs) | 1 / 0 / 0 | 2 / 1 / 4 | 2 / 12 / 3 | 0 / 2 / 0 |
| this kit, `verify.mjs` (final run) | 1 | 3 | 3 | 0 |
| the previous 2.0 draft, same machine, interleaved runs | – | 0 / 0 / 0 | – | – |

Long tasks after t = 0: none. Short and reduced (880×560, 4x): 0 frames over 20 ms. Every miss is a single dropped frame (33 ms, one 50 ms), spread over the intro. Under 4x the adaptive
quality steps down to `'low'` on its own; at 1x it stays `'high'`. The remaining cost against the
previous draft is the SVG light on the letters (crisp outlines, rims and sweep instead of the
blurred canvas copies): main-thread paint of gradient-filled paths. On a GPU-composited WebView2
this needs measuring on the owner's PC before shipping.

---

## Sound

`soundPlan(variant, layout)` in `intro.js` samples `render()` to build the event list (the
whooshes follow the streak heads, the riser pulses with the rush, the impact sits on the stop,
the chord resolves at the sweep's middle). `sound.js` plays it. The same code path renders
offline (`renderOffline(plan)`, an OfflineAudioContext) for WAV and video, so the video's audio
*is* the live audio. Long cue: the strike frame is 1720 ms, the impact's first sample 1.722 s
(+2 ms: the latency of the ceiling's 4x oversampling — under one frame).

| Cue | Integrated | True peak | Length |
|---|---|---|---|
| **long** | **−18.1 LUFS** | **−1.1 dBTP** | 3.70 s; digital silence 1.628–1.722 s (the held breath) and from 3.70 s |
| short (small hit + sizzle) | −20.0 LUFS | −3.3 dBTP | silent from 0.77 s |
| celebrate | −22.3 LUFS | −2.9 dBTP | 1.9 s |
| reduced (soft tone) | −24.9 LUFS | −16.1 dBTP | silent from 1.70 s |
| hand-over click | −45.7 LUFS (padded) | −26.1 dBTP | 0.17 s |

Long and short are 2 LU apart now (−18 / −20; before −15.8 / −23), and the long cue plays on
every launch at about the level of a system sound, not a trailer.

Measured with ffmpeg `ebur128=peak=true` on 48 kHz / 24-bit renders. Chain: voices (+ sends into
the **room**: a ConvolverNode with a generated 1.3 s stereo response — seeded noise, darkening
from ~7 kHz to ~1.1 kHz as it decays, 7 early reflections; the send is high-passed at 380 Hz so
the room adds air, not mud; only the impact, the metal, the tail, the glint and celebrate()'s
chime and thump go in) → 20 Hz high-pass → master gain (level, the gate of the held breath, the
closing fade) → for the long cue only, a **soft ceiling** (WaveShaper, linear to 0.59, rounding
off to 0.82, 4x oversampled) → out. Silence stays digital silence.

**The hit against the build-up** (sliding RMS, hit = 1.718–2.07 s, build-up = the 600 ms before
the held breath; previous draft in brackets, from the critique):

| Speaker simulation | 50 ms window | 300 ms window |
|---|---|---|
| full range | +10.6 dB (+11.9) | +8.4 dB |
| 180 Hz high-pass (laptop) | +13.0 dB (+7.9) | +10.4 dB |
| 400 Hz high-pass (phone) | +12.3 dB (+4.8) | +9.6 dB |
| 1 kHz high-pass | **+12.4 dB** (+3.7) | **+10.0 dB** (+3.9) |

How: the riser's noise band −9.5 dB and its suck-back −10.7 dB, the saws low-passed at ≤ 2.6 kHz,
the rush whooshes −5 dB; the crack and metal +3.5 dB plus a *shatter* (2–6 kHz noise, τ 32 ms)
that outlasts the crack. **Sub:** 20–60 Hz peaks 40 ms after the strike (20 ms window; 50 ms
window 22–72 ms) at −6.8 dB (50 ms RMS), 4.9 dB under the previous −1.9 dB that came 104–154 ms
late; decay τ 0.15–0.16 s. **Tail:** the 150–500 Hz band now falls from −21 dB at the hit to
−35 dB by 2.3 s (before: flat at −22 to −28 dB for 1.5 s): low voices τ ≤ 0.6 s, no tremolo, the
metal's partials ring 0.4–1.1 s into the chord, no bell. **No holes:** no 20 ms window above
150 Hz drops under −50 dB before the held breath (the riser starts under the last click, the
blade's whoosh bridges into it).

The rest of this section describes the 1.2.0 elements that the short cue (and the long cue's
clicks) still use.

**Balance** (each part rendered alone from the same plan, 4 ms RMS at each click):
- The five letter clicks sit **+11.6 to +14.2 dB over the air band** in 1.5–6 kHz, and +28 to +32 dB
  in 1–2.5 kHz. (Before: the E, L, O and X clicks were 3–9 dB *under* the air band.)
- The air band is steady: 4.6 dB of swing across its whole run (before: a 50 dB swell, which made it a riser).
- All five clicks share one excitation (seed 32), so their level is even letter to letter; their
  pitch and level come from the material the cut runs through.

**Small speakers** (laptop simulation: 180 Hz, 24 dB/oct high-pass): the hit window peaks
**15.5 dB over the prelude** (10 ms RMS: 19.1 dB). The integrated level drops 8.6 LU, because the
thud and sub are below 180 Hz by design; the crack, its 2.9/3.4 kHz body, the doubled latch
partials and the 288/432 Hz seat partials carry the hit there.

**Clean stops.** Every oscillator and noise source stops only after the cue's master fade has
reached zero. (A source stopping inside the audible cue left a one-sample spike of about
−44 dBFS in Chromium's render even with its envelope at −100 dB; the previous kit had one at
1.29 s.)

Determinism: the noise is seeded, so the plan is identical on every run. Two offline renders in
Chromium can differ after the hit by about 5e-5 (−86 dBFS, oscillator SIMD paths): inaudible, but
not bit-exact.

---

## How each surface embeds it

### 1. VeloxSetup.exe (native/setup-ui)

```html
<link rel="stylesheet" href="brand/intro.css">           <!-- optional, mount() links it anyway -->
<link rel="stylesheet" href="brand/kit.css">
<div id="stage"></div>
<script type="module" src="setup.js"></script>
```
```js
import { VeloxIntro } from './brand/intro.js';
import { VeloxTicks } from './brand/ticks.js';
const intro = VeloxIntro.mount(document.getElementById('stage'),
  { variant: 'long', place: 'header', loader: false });   // 'full' is the same intro
intro.slot.append(welcomeElement);   // arrives under the word when the intro settles (intro.css)
// on "Installieren": replace the slot's content, the word stays
intro.slot.replaceChildren(installHeading, readouts);
const bar = VeloxTicks.mount(intro.slot, { status: 'Dateien werden kopiert', step: '1 / 5' });
// on done{…}: the done screen, then the finish
bar.done('Fertig. VELOX ist installiert.'); intro.celebrate();
```
- Copy `brand/` to `native/setup-ui/brand/` (including `light-worker.js`). The existing CSP
  (`default-src 'self'`) works as it is: the module worker is same-origin. A CSP with an explicit
  `worker-src` must allow `'self'`; if it does not, the light falls back to the main thread.
- In `SetupWindow.cs`, set `CoreWebView2EnvironmentOptions.AdditionalBrowserArguments =
  "--autoplay-policy=no-user-gesture-required"` so the sound plays without a click. Also set the
  window and the `DefaultBackgroundColor` to `#0C0D0F`.
- The word never moves. Welcome, progress, done and error screens replace the slot's content, so
  the wordmark stays the fixed header of the whole installer. Orange in the installer: the V's
  foot, the primary button, the one active tick. Nothing else.
- Use `export/app-icon-*.png` for `velox.ico` (16, 20, 24, 32, 40, 48, 64, 256).
- Call `intro.destroy()` when the installer window closes.

### 2. VELOX.exe start screen (native/host)

The ES-module files need an origin, so `NavigateToString(splash.html)` cannot load them. Serve
the start screen from a folder instead: `SetVirtualHostNameToFolderMapping("start.velox.example",
<install dir>\start, CoreWebView2HostResourceAccessKind.DenyCors)`, with `start\brand\` a copy of
this folder. Keep the same autoplay argument and the `#0C0D0F` background.

```js
const intro = VeloxIntro.mount(stage, {
  variant: VeloxIntro.pickVariant(version, { prefer: settings.intro }),   // 'long' unless the person chose 'short'
  labels: 'Version ' + version,
});
// host -> page messages (existing protocol):
//   status{text} / starting{text}  -> intro.status(text)
//   ready                          -> await intro.done(); intro.destroy(); post {type:'continue'};
//                                     the host navigates to http://127.0.0.1:<port>/?from=host
//   error{…}                       -> put the error UI into intro.slot (word stays), skip()
```
The host should navigate on `continue`, or after 900 ms at the latest if that message never arrives.

### 3. Web UI (ui/)

- Copy the runtime files to `ui/brand/`. The backend already serves `.js` as `text/javascript`.
- **Retheme:** link `brand/tokens-app.css` **after** `app.css`, or replace app.css's `:root`
  palette with its block. It maps `--bg`, `--s1…s4`, `--hair*`, `--text`, `--muted`, `--faint`,
  `--ok/--warn/--err`, `--accent*`, `--on-accent`, and sets `--brand`, `--glass`, `--card` and
  `--glow` to solid or `none`. It adds `--accent-press`, `--focus-ring`, `--selection-bg/-fg`,
  `--risk-safe/-mid/-high` (+ `-bg`) and `--nav-active-bar/-bg`. The violet/cyan gradient, the
  aurora background and the accent glow go away with it. The intro never loads this file, so
  mounting it never rethemes a page by accident.
- **In-app splash:**
  - Opened by VELOX.exe (`?from=host`): `mount(splash, { variant: 'still', handedOver: true })`
    shows exactly the pose VELOX.exe ended on (the canonical wordmark). Fade the splash out
    (opacity, about 200 ms) when the app's first data is in, then call `intro.destroy()`.
  - Started with Start.bat (Edge window): `mount(splash, { variant: VeloxIntro.pickVariant(version) })`.
    Call `status()` while the first `/api` calls load, then `await intro.done()`, fade out, `destroy()`.
- **Sidebar brand:** `<img src="brand/wordmark-small.svg" alt="VELOX" height="16">`. Show the
  wordmark alone, no mark beside it. Active nav item: a 2 px `--nav-active-bar` on its left edge
  plus `--nav-active-bg`. Nothing else in the nav turns orange.

---

## Tokens (summary)

| | Hex | Contrast on ink |
|---|---|---|
| Tinte / Tinte 2 / 3 / 4 | `#0C0D0F` `#141518` `#1A1B1F` `#212328` | |
| Linie / Linie 2 | `#2A2C31` / `#45484F` | |
| Knochen (text) | `#ECE9E2` | 16.0 : 1 |
| Asche (secondary) | `#8E8B85` | 5.7 : 1 |
| Asche 2 (tertiary) | `#807D77` | 4.7 : 1 |
| Signal (accent) | `#FF5A1F` | 6.2 : 1 |
| Signal hover / pressed | `#FF7038` / `#E04812` | ink text on them: 7.1 / 4.7 |
| Text on signal | `#0C0D0F` | 6.2 : 1 (bone would be 2.6, so never use it) |
| Sicher | `#3FC98A` | 9.2 : 1, ΔE2000 to signal 65 (deuteranopia, simulated: 17.6) |
| Mittel | `#E9C440` | 11.5 : 1, ΔE 38 (deuteranopia: 12.0; the previous `#E8B53A` was 9.6) |
| Riskant | `#F25A80` | 6.1 : 1, ΔE 24 (deuteranopia: 17.1) — rose red, pulled away from orange |

Risk text on its own 12 % tint over ink-2: 7.0 / 8.5 / 5.0 : 1. Deuteranopia simulated with the
Machado 2009 matrix (severity 1.0). Badges always show the word and an icon as well. Colour is
never the only cue. **Rule: a Mittel badge never sits directly beside a primary button** — gold
and orange stay the closest pair for deuteranopes.

**Orange only for:** the V's foot, the blade, the loader segment, the active tick, the primary
button, the active nav bar and the focus ring. **Exception since 2.0: the light of the intro and
of `celebrate()`** — a heat ramp derived from the signal (deep ember → `#FF5A1F` → amber →
white-hot), with bloom, only in motion and gone in every resting pose. The app UI stays flat. Never for risk, never as a gradient, no glow, no
second accent. Text: Segoe UI Variable (system). Numbers and readouts: Cascadia Mono, tabular.
Labels in sentence case, never uppercase-and-letterspaced.

---

## Small icons

At 16–24 px the real outline (heavy arms, slope 0.29) stood both arms up as near-vertical
"ears" over a centred orange "nose" and read as a face. The 16/20/24 px masters are therefore
drawn by rule in `src/pixelfit.mjs`: two 3 px arms that converge visibly (one column every two
rows, at 16 px every two to three) down to a point, the cut on a whole row, the bone upper half
2 px ahead, and the orange foot continuing the same diagonals 2 px behind it — so the foot keeps
the V's notch and reads as the bottom of a V. Every pixel is on or off. 32/40/48 px use the real
outline with every horizontal edge on a whole pixel; 64+ use `app-icon.svg`. Checked side by side
on a dark (`#202020`) and a light (`#F3F3F3`) taskbar at 1:1 and zoomed. The small masters are
lighter than the 32+ drawing by design.

---

## Dev

```sh
# preview (ES modules need http; any static server works)
python3 -m http.server 8000 --directory velox-tweaker      # then open /brand/preview.html
node velox-tweaker/brand/src/build.mjs                     # regenerate SVGs + glyphs.js from geometry.mjs
PLAYWRIGHT=/path/to/playwright/index.mjs node velox-tweaker/brand/tools/verify.mjs
PLAYWRIGHT=/path/to/playwright/index.mjs node velox-tweaker/brand/tools/export-icons.mjs
node velox-tweaker/brand/tools/check-copies.mjs
```
`preview.html?capture=1&variant=full&place=hero` runs on a manual clock for frame-exact capture
(`window.__vx.seek(ms)`, `__vx.wav()`); `&place=header&install=0.42` shows the install progress.

`tools/verify.mjs` checks (50 + 1 known, plus 6 frame-timing runs): the blocked-autoplay state
and label, M/click unlocking with a replay, no replay over installer content, the keyboard
released after the installer settles and after `done()`, M after `done()` leaving `velox.sound`
alone, Esc skip, mute remembered, status/progress, `done()` handing over at the end of the sweep
(not after the loader) and the ember going out with it, the canonical end pose, `destroy()`, the
still variant, reduced motion, Enter on slot buttons, the host page's variables untouched by a
mount, CSP; `'full'` playing the long intro (settled 2.8–3.3 s), `pickVariant()`, click-to-skip,
the light drawn in the worker, **the low ember at rest**, the strike's white-hot cut edge to
edge, **the held breath (a dark silhouette, a white-hot needle right of the word), the two
overexposed hit-stop frames, the V orange again on frame 3, the sparks (12–20 streaks + 2–3
embers, forward, from the halves' leading edges)**, `celebrate()` (light, timing, only the
resting ember left after it, **the re-lock 7 → 5.2 → 8.7 → 7**, its sound with the thump),
**mute/unmute mid-intro (`audible` false while muted, true again after)**, **adaptive quality
(`'low'` = half the light pixels)**, reduced motion; the short blade as pure signal rows at
100/150 % (**known since 1.2.0:** at 125 % the 2.4 px line can show a half-covered third row at
some columns; reported as KNOWN), the tick canvas on device pixels, and real-time frame timing
at 880×560, 1360×880 and 1920×1080 with the CPU 4x slower and at 1360×880 unthrottled (each run
in its own browser context, closed afterwards, so earlier pages' loader loops do not add load).

---

## Open — for whoever owns `native/` and `ui/` (not doable from here)

- **WebView2 on Windows:** the autoplay argument actually taking effect, GPU compositing, and
  125 / 150 % scaling (the device-pixel snapping is verified in Chromium's emulation only).
- **Listening** on laptop speakers and on headphones. The sound is judged from ebur128,
  band-split renders, a high-pass laptop simulation, spectrogram and waveform — nobody has heard it.
- **Wiring** into the three surfaces, with Playwright frame tests there (`done()` → `destroy()`,
  `tokens-app.css` linked after `app.css`, the progress in the installer slot).
- **Alt+Tab** and taskbar thumbnails at 125 / 150 %.
- **Fonts:** Segoe UI Variable and Cascadia Mono fall back to other fonts on Linux renders.
- **Trademark search** for "VELOX" (EUIPO / DPMA, class 9).
- **2.0 integration:** the copies in `ui/brand/`, `native/setup-ui/brand/` and
  `native/host/start/brand/` are still 1.2.0 (`check-copies.mjs` fails until they are synced) and
  must include `light-worker.js`. Hosts that pass `'full'` get the long intro; VELOX.exe passes
  `'short'` after the first run today — switch it to `pickVariant(version, { prefer })` and add a
  *Startanimation: Lang / Kurz* setting. The installer calls `intro.celebrate()` on its done
  screen. `done()` now resolves from ~3.0 s (calm 2.55 s + 0.43 s), before `settled` (3.0 s)
  would have; `settled` still resolves first. `ui/`'s Playwright tests wait up to 10 s for the
  settle (fine at 3.0 s) and expect
  `variant === 'full'` / `'short'` from splash.js' own bookkeeping.
- **Frame timing on real hardware** (WebView2, GPU compositing, 125 / 150 %) — the measurements
  here are from software compositing on a shared machine.
- **Unmuting mid-intro** schedules only the cue's events that are still ahead (fixed: muting now
  clears `audible`, so the unmute really does that); a drone or riser that has already begun is not
  picked up halfway.
