# Rift brand

The launcher was called "Vanity", then "Niobium". From now on it is **Rift**: like the rifts in Fortnite, it is a portal back to the old seasons.

> **Status:** everything players see is Rift: logo, colours, texts, the `[Rift]` chat/console prefix, the data folders (`%APPDATA%\Rift`, `%LOCALAPPDATA%\Rift`) and the DLLs (`rift_*.dll`). A few internal names that players never see keep "niobium" for compatibility (pipe, backend env vars and routes, login domain, `--nb-*` CSS variables, …) – see [`02-architecture.md`](02-architecture.md#names).

## Name

| What | Value |
| --- | --- |
| Display name | **Rift** |
| Long form | **RiftFN** |
| Tagline | **Step back into any season.** |
| Lowercase id | `rift` (files, ids, env vars, pipe name) |
| In-game chat / console prefix | `[Rift] ` (with the trailing space) |

Write "Rift" with a capital R and the rest lower case in running text. All caps "RIFT" only appears in the wordmark (artwork), never typed. "RiftFN" is only the long form (installer sidebar, about screen).

## Colours

### Core palette

Near-black with two accents that always travel together: **violet** (the portal, fills) and **neon cyan** (the light coming through the rift). Contrast ratios are WCAG 2.x, measured on `bg` / `surface` / `surface-raised`.

| Token | Hex | Use | Contrast |
| --- | --- | --- | --- |
| `bg` | `#07070C` | App background. **Also the installer header band and the Welcome/Finish page background.** | |
| `surface` | `#0F0F19` | Cards, panels, the sidebar, the F9 menu window | |
| `surface-raised` | `#161624` | Popovers, menus, hovered rows, fields and buttons in the F9 menu | |
| `border` | `rgb(255 255 255 / 0.08)` | Hairlines on glass and cards (F9 menu: `#24243A`) | |
| `text` | `#F4F4F8` | Main text | 18.3 / 17.4 / 16.3 |
| `text-muted` | `#A6A6BC` | Secondary text and hints | 8.4 / 8.0 / 7.5 |
| `text-faint` | `#80809A` | Captions, disabled labels, key hints | 5.2 / 5.0 / 4.7 |
| `violet` | `#8B5CF6` | Brand colour 1: the rift edge and vortex, fills, glows, the main accent | 4.7 / 4.5 / 4.2 |
| `violet-fill` | `#7C3AED` | Button fills with white text (white on it: 5.7:1) | |
| `cyan` | `#22D3EE` | Brand colour 2: the rift light, thin lines, indicators, glows, focus rings | 11.1 / 10.5 / 9.9 |
| `violet-text` | `#C4B5FD` | Violet used as text, links and active labels | 10.9 / 10.3 / 9.7 |
| `cyan-text` | `#67E8F9` | Cyan used as text or icons ("New" badges, highlights) | 13.9 / 13.1 / 12.3 |
| `ring` | `#22D3EE` | Focus rings (non-text, 9.9:1 or more) | |

Rules:

- Small text (under 18.66 px bold / 24 px regular) needs at least 4.5:1. Every text token above passes on all three backgrounds.
- `violet` is below 4.5:1 on `surface-raised`, so it is **never** used for text. Use `violet-text` / `cyan-text` for anything that is read.
- White text on `violet-fill` is 5.7:1, on `violet` only 4.2:1, so buttons use `violet-fill` (or `--nb-gradient`, at least 5.3:1 everywhere).
- Never put white text on `cyan`. If something has to sit on a cyan fill, use `bg` (11.1:1).

Status colours stay as they are and are not brand colours: success `#22C55E`, warning `#F59E0B`, danger `#EF4444`. Cyan is **not** an info/success colour.

### Gradients and effects

```css
:root {
  --nb-bg: #07070c;
  --nb-surface: #0f0f19;
  --nb-surface-raised: #161624;
  --nb-border: rgb(255 255 255 / 0.08);
  --nb-text: #f4f4f8;
  --nb-text-muted: #a6a6bc;
  --nb-text-faint: #80809a;
  --nb-violet: #8b5cf6;
  --nb-violet-fill: #7c3aed;
  --nb-cyan: #22d3ee;
  --nb-violet-text: #c4b5fd;
  --nb-cyan-text: #67e8f9;
  --nb-ring: #22d3ee;

  /* button fill: violet into a deep cyan; white text stays >= 5.3:1 over the whole gradient */
  --nb-gradient: linear-gradient(135deg, #7c3aed 0%, #6d28d9 55%, #0e7490 100%);
  /* decoration only (lines, bars, rims, hover tips): the violet -> neon cyan of the logo edge */
  --nb-gradient-shine: linear-gradient(135deg, #8b5cf6 0%, #7c6cf6 55%, #22d3ee 100%);
  /* headline text */
  --nb-gradient-text: linear-gradient(100deg, #f4f4f8 0%, #c4b5fd 55%, #67e8f9 100%);
  /* glass panel */
  --nb-glass: rgb(15 15 25 / 0.62);
  --nb-glass-strong: rgb(22 22 36 / 0.82);
  /* brand glow (primary button, active nav item, logo): violet with a cyan halo */
  --nb-glow: 0 0 0 1px rgb(139 92 246 / 0.35), 0 10px 40px -10px rgb(139 92 246 / 0.6),
    0 0 28px -10px rgb(34 211 238 / 0.45);
  --nb-glow-cyan: 0 10px 40px -12px rgb(34 211 238 / 0.6);
}
```

Tailwind colours (`launcher/src/index.css`, `@theme`): `brand-violet`, `brand-violet-fill`, `brand-cyan`, `violet-text`, `cyan-text`, `faint`, `surface`, `surface-raised`; utilities `bg-brand`, `bg-brand-shine`, `text-gradient`, `text-gradient-brand`, `glow-primary`, `glow-cyan`, `focus-ring`. shadcn mapping: `--background` = `bg`, `--card` = `surface`, `--popover` = `surface-raised`, `--primary` = `violet-fill`, `--primary-text` = `violet-text`, `--ring` = `ring`.

In-game F9 menu (ImGui, `native/client/ATLAS/Private/GUI.cpp`): accent `#8B5CF6` = `ImVec4(0.545f, 0.361f, 0.965f)`, pressed `#7C3AED`, text accent `#C4B5FD`, cyan `#22D3EE` for the active-tab indicator (`AccentCyan()`), window `#0F0F19`, title bar and sidebar `#07070C`, fields and buttons `#161624`, borders `#24243A`. The trickshot banner uses a cyan glow and a `cyan-text` title. This replaces the ATLAS accent `#00A2CE`.

## Logo

The logo is a **rift**: a torn, jagged-edged hole in space (an irregular outline with a few long spikes and deep notches, not a clean ring) with glowing edges that run from light violet through violet `#8B5CF6` and magenta `#E879F9` into cyan `#67E8F9`. Inside, a vortex of four curved spiral arms (violet at the rim → magenta → cyan) turns inwards and converges on a white-hot core. Large versions add faint extra arms and a few small shards and sparkles floating around the tear. It is an original drawing in the spirit of the in-game rifts, not Epic artwork.

### Variants

| Variant | When | Looks like |
| --- | --- | --- |
| **Rich** | 64 px and larger in the UI, app icon master | Tear (24-point outline) with outer violet glow, glowing rim and a thin white edge line, 4 arms + 4 faint arms with glow, white core, 7 shards and 3 sparkles around it |
| **Simple** | Smaller than 64 px in the UI, F9 menu, lockup | The tear fills the box, 4 arms, core and glowing rim; no shards |
| **Pixel-tuned** | Exactly 16, 24, 32, 48 and 64 px (the `.ico`) | 16 to 32 px: a simpler 12-point jagged silhouette, 3 bold arms, a big bright core and a 1.2 to 1.8 px rim, no blur. 48/64 px: the simple variant with sizes tuned per pixel. |
| **Lock-up** | Splash, welcome, about, installer | Mark + "RIFT" wordmark |

### Files

| File | What |
| --- | --- |
| `launcher/assets/app-icon.svg` | Master, rich, 1024 x 1024. The source of truth. |
| `launcher/assets/app-icon-simple.svg` | Simple variant, 1024 x 1024 |
| `launcher/assets/sizes/icon-{16,24,32,48,64}.svg` | Pixel-tuned sources for the small icon sizes |
| `launcher/assets/app-icon.png` | 1024 px render of the master. Input for `pnpm tauri icon`. |
| `launcher/public/logo.svg` | Rich logo for the web UI (also the favicon) |
| `launcher/public/logo-simple.svg` | Simple logo for small spots |
| `launcher/public/logo-wordmark.svg` | Lock-up: mark + "RIFT", for dark backgrounds |
| `launcher/src-tauri/icons/*` | App icons. `icon.ico` holds 16/24/32/48/64 (pixel-tuned) and 256 (rich). |
| `launcher/src/components/layout/Logo.tsx` | React: `LogoMark`, `Wordmark`, `Logo` |
| `launcher/splash.html` | Splash window with the rich mark and the wordmark inline |
| `native/client/ATLAS/Public/Icon.h` | F9-menu logo: the simple mark as a 512 x 512 PNG byte array |
| `launcher/src-tauri/windows/assets/*.bmp` | Installer art (see below) |

### Construction

- 1024 box, centre (512, 512). The outline is generated (seeded, so it is stable): 24 points on a slightly tall ellipse tilted by -16°, alternating in/out with random depth, plus fixed spikes and notches; it is scaled so its furthest point is R = 372 (rich, leaves room for the shards) or 470 (simple).
- Inside the tear: space gradient `#3B1680` → `#1C0B45` → `#0A0617`. Arms: tapered spirals (each turns 243°) from just outside the rim into the core, filled with one radial gradient: white 0 %, `#CFFAFE` 12 %, `#22D3EE` 30 %, `#E879F9` 55 %, `#A855F7` 80 %, `#7C3AED` 100 %. Core: white dot plus a white → cyan halo.
- Edge: the outline stroked with the edge gradient (`#C4B5FD`, `#8B5CF6`, `#E879F9`, `#67E8F9`, diagonal) over a blurred copy, and a wide blurred violet glow outside.
- Shards are small irregular triangles in cyan, violet, magenta and white with a soft glow; sparkles are thin four-point stars.
- The wordmark is "RIFT" in Inter Display Bold (by Rasmus Andersson, SIL Open Font License 1.1) with +6 % tracking, converted to outlines. No font file ships, so it looks the same everywhere. Always use the `Wordmark` component or `logo-wordmark.svg`; never type it in a font.

### Rules

- Leave clear space around the mark of at least 25 % of its size. The minimum size is 16 px.
- Put it on dark backgrounds (`bg`, `surface`, or dark glass). The inside of the tear is dark, so the mark also works as an app icon on light taskbars, but never put the wordmark on light backgrounds; the wordmark is light.
- Do not recolour, stretch, mirror or rotate the mark. The vortex always turns the same way and the edge always goes violet (top left) to cyan (bottom right).
- Glow is allowed: the soft violet/cyan glow behind the mark (`LogoMark glow`) on the splash, the welcome screen and the about page.

### React API (`@/components/layout/Logo`)

```tsx
<LogoMark className="size-9" />            // simple mark, sized by class (default 32 px)
<LogoMark size={96} glow />                // rich mark (auto: rich from 64 px) + breathing glow
<LogoMark size={48} variant="rich" />      // force the shards and faint arms
<Wordmark className="h-6 text-foreground" />  // "RIFT", uses the current text colour
<Logo size={56} glow tagline />            // mark + wordmark + tagline
```

The glow stays still when the OS asks for reduced motion or the app's "Reduce motion" option is on (it reads `MotionConfig`). Every instance gets its own gradient, mask and filter ids (`useId`), so many logos can share one page.

### Regenerating the app icons

The assets come from one small Python + Playwright pipeline (geometry in `brand.py`, installer art in `art.py`, `build_all.py` writes everything into the project):

1. `python3 build_all.py` writes the SVG masters, the per-size SVGs, `public/logo*.svg`, renders `assets/app-icon.png` (1024 px, transparent) and the three installer BMPs.
2. Run `cd launcher && pnpm tauri icon assets/app-icon.png`. Then delete the `android/` and `ios/` folders it creates; this app is desktop-only.
3. `python3 build_all.py post-cli` replaces the blurry small sizes from the CLI with pixel-tuned renders (`32x32`, `64x64`, `Square30/44/71/89`, `StoreLogo`), rebuilds `icon.ico` from the pixel-tuned 16/24/32/48/64 plus a 256 px render of the master, and regenerates `native/client/ATLAS/Public/Icon.h`.
4. `Logo.tsx` and `splash.html` carry the same shapes inline: `gen_logo_tsx.py` rewrites the `LogoMark` part of `Logo.tsx`; the splash mark is `logo_svg(1024, "rich", uid="sp")`.

## Installer (NSIS)

| Setting | Value |
| --- | --- |
| `MUI_BGCOLOR` | **`07070C`**. This is the exact background of `header.bmp` and the colour the sidebar fades into. |
| `MUI_TEXTCOLOR` | `F4F4F8` |
| `MUI_FINISHPAGE_LINK_COLOR` | `C4B5FD` (violet-text, 10.9:1 on `07070C`) |
| Win11 caption colour (`DWMWA_CAPTION_COLOR`) | `0x000C0707` (COLORREF is 0x00BBGGRR for `#07070C`) |

| File | Size | Notes |
| --- | --- | --- |
| `windows/assets/sidebar.bmp` | 164 x 314 | Welcome and Finish pages. Glowing rift mark in front of a faint vertical streak of light, "RIFT", "Step back into any season.", a violet → cyan line and "RIFTFN". The right edge is exactly `#07070C`, so it melts into the page. |
| `windows/assets/header.bmp` | 150 x 57 | Small mark + wordmark on the right. **Every edge pixel is exactly `#07070C`**, so with `MUI_HEADERIMAGE_RIGHT` it blends into the header band. |
| `windows/assets/splash.bmp` | 420 x 240 | AdvSplash card: mark, wordmark, tagline and a violet → cyan line on a dark card with 22 px rounded corners. Everything outside the card is pure `#FF00FF` (the colour key), with hard edges and no pink fringe. Call it with `advsplash::show 900 350 300 0xFF00FF "$PLUGINSDIR\<name>"` (no `.bmp`). |

All three files are 24-bit, uncompressed (`BI_RGB`), use the 40-byte BITMAPINFOHEADER and have no alpha (the CI checks this in "Check the installer images").

## UI direction

**Mood: "a rift in the dark."** A near-black background and glass panels. Colour comes from light (glows, gradients, thin rims), not from big flat coloured areas. Violet is the body, cyan is the light that leaks through.

- **Glass.** Panels use `--nb-glass` with `backdrop-filter: blur(20px) saturate(140%)`, a 1 px `--nb-border` and an inner top highlight `inset 0 1px 0 rgb(255 255 255 / 0.06)`. The hairline (`--nb-edge`) goes from white at the top left to violet and a hint of cyan at the bottom right. Radius: 12 px for cards, 8 px for controls, full for pills.
- **Glow.** Save the brand glow for the one thing that matters on a screen: the Play/Launch button, the active nav item and the logo. Everything else stays calm.
- **Cyan.** Use cyan as light, not as paint: indicators, the tip of a progress bar, "New" dots and badges, focus rings, a short sparkle when something finishes. Never a large fill.
- **Background.** Slow "aurora": big soft blobs (violet, a smaller cyan one, a deep violet one) drifting over 40 to 60 s at 35 % opacity or less, plus the faint dot grid. It is static when motion is reduced.
- **Motion.** Entrances ease out with `cubic-bezier(0.16, 1, 0.3, 1)`. Exits use `cubic-bezier(0.7, 0, 0.84, 0)` and are shorter. Durations: 120 ms for hover and press, 200 to 260 ms for toggles and panels, 400 to 600 ms for page changes and hero moments. Springs: stiffness 380 / damping 32 for UI, and stiffness 200 / damping 22 for playful moments such as the logo pop. Stagger lists by 40 ms. On press, scale buttons to 0.97. On hover, lift cards by 2 px and add a faint glow.
- **Signature move: the sheen sweep.** A diagonal white band (about 25 % opacity, tilted 30°) sweeps across the logo (clipped to a circle inside the tear) or the Play button once on load and again on hover, over 700 ms.
- **Splash (440 x 300).** At 0 ms the mark scales from 0.86 to 1 and goes from blur 12 px to 0 and from opacity 0 to 1 (spring). At 250 ms the glow fades in. At 450 ms the sheen sweeps. At 500 ms the wordmark rises 8 px and fades in, and at 650 ms the tagline follows. A thin violet → cyan line loops until `app_ready`. The splash should feel finished within 1.2 s.
- **First-run welcome.** Start with the large `Logo` lock-up with glow, then cards that slide in with a 40 ms stagger. "What's new" is a single glass card with a cyan "New" dot.
- **Type.** Keep Segoe UI Variable for the UI. Headings are semibold with -0.01em tracking. Use tabular numbers for versions and stats. The name is always the `Wordmark` SVG.
- **Reduced motion.** Respect the OS setting and the app's own setting. When either is on, use no infinite animations and replace movement with fades of 150 ms or less.
- **Words.** Plain, short, friendly English. Say "Play", not "Execute"; say "Your builds", not "Installations".
