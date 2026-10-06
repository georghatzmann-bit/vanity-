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
| `intro.js` | The start sequence (ES module). `VeloxIntro.mount(…)`, the pure `render(t)` and `soundPlan()`. |
| `sound.js` | Web Audio synthesis (ES module). It turns a plan into sound, live or offline. No samples. |
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
| `preview.html` (+ `preview.js`, `preview.css`) | Dev page. Shows the full, short, reduced and still variants, the installer layout with the progress, mute, status, progress, `done()` and `skip()`. Not shipped. |
| `src/` | `geometry.mjs` (letterforms), `build.mjs` (regenerates every SVG and `glyphs.js`), `pixelfit.mjs` (small masters). |
| `tools/` | `check-copies.mjs`, `verify.mjs` (browser checks), `export-icons.mjs` (PNGs). |

Ship only the runtime files: `intro.js`, `sound.js`, `glyphs.js`, `intro.css`, `tokens.css`, plus
`ticks.js` and `kit.css` in the installer, `tokens-app.css` in `ui/`, and the SVGs a surface uses.

---

## API

```js
import { VeloxIntro } from './brand/intro.js';

const intro = VeloxIntro.mount(container, {
  variant: 'full',          // 'full' | 'short' | 'still'
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
});
```

The container decides the size. It gets the class `vx-host` (`position: relative`), and the
intro fills it and follows resizes (ResizeObserver) and DPI changes.

| Returned | |
|---|---|
| `intro.status(text)` | Sets the status line (`aria-live="polite"`). |
| `intro.progress(p)` | `0..1` shows a determinate fill and a mono percentage. `null` goes back to the sliding segment. The fill eases frame-rate independently. |
| `intro.done()` → `Promise` | The hand-over. It waits until the intro has settled (it never cuts the intro short). Then the loader fades, its orange segment snaps up into the cut line with one quiet click (+120 ms), holds, and retracts right to left into the V's foot. The promise resolves **430 ms** after the snap starts, on the canonical wordmark. A timer also resolves it if the window is hidden and rAF stops. It also releases the keyboard. |
| `intro.destroy()` | **Required** when the host is done with the intro (after `done()` and your fade, or when you replace the page content). Removes the DOM, the listeners, the DPI watcher and the ResizeObserver, and closes the audio context. |
| `intro.skip()` | Jumps to the settled state and fades any playing sound out within 60 ms. Esc, Enter, Space and the *Überspringen* button do the same. Enter and Space on a button inside the slot are left alone. |
| `intro.setMuted(b)` | Mutes or unmutes. `M` and the sound button toggle it. The setting is remembered. Unmuting mid-intro plays the part of the cue that is still ahead, but only if it can still land the hit in sync. |
| `intro.settled` | A promise that resolves when the intro is at rest. The installer brings its welcome in on it (automatic for `loader: false`). |
| `intro.slot` | An element under the word, on the same left edge. The installer puts its content here. |
| `intro.ready` | Resolves after boot (CSS loaded, audio prepared, clock started). |
| `intro.muted`, `intro.audible`, `intro.blocked`, `intro.startedAt`, `intro.variant`, `intro.keysActive` | State, for hosts and tests. `blocked`: sound is wanted but the browser has not allowed audio yet. `keysActive`: the window keydown listener is attached. |
| `intro.replay()` | |
| `intro.seek(ms, {doneAt, fill})`, `intro.plan()`, `intro.layout()`, `intro.timeline()` | Capture and test hooks. Use them with `clock: 'manual'`. |

`VeloxIntro.pickVariant(version)` returns `'full'` the first time it sees `version` and
`'short'` after that, using localStorage `velox.intro.seen`. Without storage it returns
`'short'`. Native hosts know about installs and updates themselves and can pass the variant
directly.

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
already locked. There is no blade and no travel, the loader segment rests (it breathes in
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

All times are on the intro clock (t = 0 when boot is done, about 100 ms after mount).

**Full: 1.60 s to settled.** On the first launch after an install or update, and in the installer.

| t (ms) | Picture | Sound |
|---|---|---|
| 0–140 | Black, the version label only. | Silence. |
| 140 | A 2 px solid blade leaves the left window edge on the cut line. It accelerates and reaches the word at 250. | One bright "tk", left. |
| 250–415 | The head runs along the cut at 2.35 units/ms. Each letter opens out of the cut as the head passes its centre (V 262, E 293, L 318, O 356, X 397, expo-out 300 ms). The upper halves arrive **10 units behind**. The head stops exactly at the end of the cut, and the tail runs into it: the blade ends *in* the cut. | A thin, **steady** air band (4.3 → 5 kHz, constant level, its pan follows the head). **One dry click per letter** as it opens (1.2–2.2 kHz, heavier letters lower and louder), 10–14 dB over the air band. |
| ~450–926 | Stillness: the word waits behind its cut. | **Digital silence** (0.45–0.926 s). |
| 820–900 | Draw-back to −12.5 (ease-out). | |
| 900–926 | **The throw:** the upper halves are thrown from −12.5 to a hard stop at **+12.8** (constant acceleration, 26 ms, about 1.5 frames, arrival speed 1.95 units/ms). | |
| **926** | **The stop.** The upper halves hit +12.8, the whole word pops **3.5 %** (about the V's foot), the lower halves recoil 2.5 units — all in one frame, no easing. | **The hit, on the same sample:** a 4–5 ms crack with a resonant metal body at 2.9/3.4 kHz, then (1.8 ms later) a saturated thud 150 → 48 Hz with its 2nd/3rd harmonics and 288/432 Hz seat partials, a 48 Hz sub, and two latch partials (1180/2013 Hz) that ring with the spring's τ. |
| **926–959** | **Hit-stop:** everything holds for two frames (33 ms) on the impact pose. | The crack and body sound under the frozen frame. |
| 959 → | A damped spring from the peak (at rest) to +7: x = 7 + 5.8 e^(−s/40)(cos 0.06s + sin(0.06s)/2.4). The pop and the recoil decay with it. | The thud and latch ring out. **No tone after the hit.** |
| 1011 | One undershoot, +5.43. Settled to < 0.25 units by 1.08 s. | |
| 1180–1560 | The loader (a hairline exactly as wide as the word, flush with the V's foot) and the status fade up 6 px. | 1.50–1.70 s linear fade. |
| **1600** | **Settled.** One orange segment slides along the hairline every 1.7 s. There is **no running clock.** | **Digital silence from 1.70 s.** |

The strike travels 25.3 units: **38 px** at 880×560 and **57 px** at 1360×880; the overshoot past
the lock is 9 / 13 px, and the pop moves the X's end by about 21 / 32 px. The lock reads with
the sound off.

**Short: 0.76 s to settled.** For every other launch. The V is already in place at t = 0. A short
blade runs from the V to the end of the cut (40–138 ms), and E, L, O and X open as it passes (54,
72, 100, 130 ms). Their upper halves wait 5 units behind (more would collide with the fixed V).
Thrown at 335, **stop at 352** on +8.9 with a 1.2 % pop and a one-frame (17 ms) hit-stop, one
undershoot (+6.53 at 411), settled by 425. The sound is **one small hit** (crack, thud and seat
partials, no sub). The loader arrives at 430–730.

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

**Frame timing** (Chromium 141 headless, software GL, real-time run with sound,
`tools/verify.mjs`): after the intro starts, **0 frames over 20 ms and no long tasks**, for full
880×560 and 1360×880, short and reduced (155–156 frames each, worst frame 16.8 ms). Audio
start-up is split into three tasks (create the context, prewarm the buffers and nodes, schedule)
that finish before the clock starts.

---

## Sound

`soundPlan(variant, layout)` in `intro.js` samples `render()` to build the event list.
`sound.js` plays it. The same code path renders offline (`renderOffline(plan)`, an
OfflineAudioContext) for WAV and video, so the video's audio *is* the live audio. In the MP4 the
hit's onset is at 0.9260 s, the stop is at 926 ms.

| Cue | Integrated | True peak | Length |
|---|---|---|---|
| full | **−18.7 LUFS** | **−3.3 dBTP** | digital silence 0.45–0.926 s and from 1.70 s |
| short (small hit) | −23.0 LUFS | −6.5 dBTP | silent from 0.77 s |
| reduced (soft tone) | −24.9 LUFS | −16.1 dBTP | silent from 1.70 s |
| hand-over click | −45.7 LUFS (padded) | −26.1 dBTP | 0.17 s |

Measured with ffmpeg `ebur128=peak=true` on 48 kHz / 24-bit renders. Chain: voices → 20 Hz
high-pass (no DC; measured mean below 1e-6) → master gain (`LEVEL.master = 0.67`) with the
closing fade. The fade comes after the filter, so the end is true digital silence. No limiter,
compressor, convolver or oversampled shaper.

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
  { variant: 'full', place: 'header', loader: false });
intro.slot.append(welcomeElement);   // arrives under the word when the intro settles (intro.css)
// on "Installieren": replace the slot's content, the word stays
intro.slot.replaceChildren(installHeading, readouts);
const bar = VeloxTicks.mount(intro.slot, { status: 'Dateien werden kopiert', step: '1 / 5' });
```
- Copy `brand/` to `native/setup-ui/brand/`. The existing CSP (`default-src 'self'`) works as it is.
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
  variant: firstRunAfterInstallOrUpdate ? 'full' : 'short',  // or VeloxIntro.pickVariant(version)
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
button, the active nav bar and the focus ring. Never for risk, never as a gradient, no glow, no
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

`tools/verify.mjs` checks (34 checks): the blocked-autoplay state and label, M/click unlocking
with a replay, no replay over installer content, the keyboard released after the installer
settles and after `done()`, M after `done()` leaving `velox.sound` alone, Esc skip, mute
remembered, status/progress, `done()` timing and the canonical end pose, `destroy()`, the still
variant, reduced motion, Enter on slot buttons, the host page's variables untouched by a mount,
CSP, the blade as pure signal rows at 100/125/150 %, the tick canvas on device pixels, and
real-time frame timing.

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
