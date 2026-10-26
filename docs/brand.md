# Niobium brand

The launcher used to be called "Vanity". From now on it is **Niobium**.

## Name

| What | Value |
| --- | --- |
| Display name | **Niobium** |
| Long form + tagline | **NiobiumFN — old seasons, new shine.** |
| Short tagline | old seasons, new shine. |
| Lowercase id | `niobium` (files, ids, env vars, pipe name) |
| In-game chat / console prefix | `[Niobium] ` (with the trailing space) |

Why this name: niobium is element 41 (symbol **Nb**). When niobium is anodised it turns deep blue, violet and gold. The logo uses exactly those colours.

Write "Niobium" with a capital N and the rest lower case. Never write "NIOBIUM" in running text. "NiobiumFN" is only used as the long form (tagline, installer sidebar, about screen).

## Colours

### Core palette

| Token | Hex | Use |
| --- | --- | --- |
| `bg` | `#0A0B12` | App background. **Also the installer header band and the Welcome/Finish page background.** |
| `surface` | `#11131C` | Cards, panels, the sidebar |
| `surface-raised` | `#171A26` | Popovers, menus, hovered rows |
| `border` | `rgb(255 255 255 / 0.08)` | Hairlines on glass and cards |
| `text` | `#F2F3F8` | Main text (17.7:1 on `bg`) |
| `text-muted` | `#A3A8C3` | Secondary text and hints (8.4:1 on `bg`) |
| `text-faint` | `#6E7392` | Captions, disabled labels (4.2:1, large or non-essential text only) |
| `blue` | `#2B5BFF` | Brand colour 1: gradients, fills, glows |
| `violet` | `#7A3CFF` | Brand colour 2: gradients, fills, glows, main accent |
| `gold` | `#FFC857` | A touch only: the logo corner, "New" dots, the end of a progress bar, small sparkles. Never a large fill. |
| `blue-text` | `#8FA8FF` | Blue used as text or icons on dark (8.6:1) |
| `violet-text` | `#B49BFF` | Violet used as text, links and active labels (8.5:1) |
| `ring` | `#9B7BFF` | Focus rings |

`blue` and `violet` are only about 3.7:1 on `bg`. Do not use them for small text. Use `blue-text` and `violet-text` for text instead.

White text on a `blue` fill is 5.2:1 and on a `violet` fill 5.4:1, so both work as button fills. For dark text on `gold` use `bg` (12.8:1).

Status colours stay as they are and are not brand colours: success `#22C55E`, warning `#F59E0B`, danger `#EF4444`. Gold is **not** a warning colour.

### Gradients and effects

```css
:root {
  --nb-bg: #0A0B12;
  --nb-surface: #11131C;
  --nb-surface-raised: #171A26;
  --nb-border: rgb(255 255 255 / 0.08);
  --nb-text: #F2F3F8;
  --nb-text-muted: #A3A8C3;
  --nb-text-faint: #6E7392;
  --nb-blue: #2B5BFF;
  --nb-violet: #7A3CFF;
  --nb-gold: #FFC857;
  --nb-blue-text: #8FA8FF;
  --nb-violet-text: #B49BFF;
  --nb-ring: #9B7BFF;

  /* main brand gradient (buttons, active states, progress) */
  --nb-gradient: linear-gradient(135deg, #2B5BFF 0%, #5546FF 50%, #7A3CFF 85%);
  /* same with the gold tip, for hero moments only (splash progress, Play button hover) */
  --nb-gradient-shine: linear-gradient(135deg, #2B5BFF 0%, #7A3CFF 70%, #FFC857 100%);
  /* glass panel */
  --nb-glass: rgb(17 19 28 / 0.62);
  --nb-glass-strong: rgb(23 26 38 / 0.82);
  /* brand glow (primary button, active nav item, logo) */
  --nb-glow: 0 0 0 1px rgb(122 60 255 / 0.35), 0 10px 40px -10px rgb(122 60 255 / 0.6);
  --nb-glow-blue: 0 10px 40px -12px rgb(43 91 255 / 0.65);
}
```

Suggested mapping onto the existing shadcn tokens in `launcher/src/index.css`: `--background` = `bg`, `--card` = `surface`, `--popover` = `surface-raised`, `--foreground` = `text`, `--muted-foreground` = `text-muted`, `--primary` = `#5546FF` (or the `--nb-gradient` on the main button), `--primary-text` = `violet-text`, `--ring` = `ring`, `--border` = `border`.

In-game F9 menu (ImGui): accent `#7A3CFF` = `ImVec4(0.478f, 0.235f, 1.0f, 1.0f)`, hover `#9B7BFF`, pressed `#5546FF`, window background `#11131C` and title bar `#0A0B12`. This replaces the ATLAS accent `#00A2CE`.

## Logo

The logo is a periodic-table tile: a bold white **Nb** with a small **41** in the top-left corner. It sits on a rounded square with the anodised-niobium gradient (deep blue `#2B5BFF` at the top left, violet `#7A3CFF`, and a gold `#FFC857` flare in the bottom-right corner). Large versions add a soft diagonal sheen, a thin light rim and a soft shadow under the letters.

### Variants

| Variant | When | Looks like |
| --- | --- | --- |
| **Rich** | 64 px and larger | Gradient, gold corner, sheen, rim, letter shadow, and the "41" |
| **Simple** | Smaller than 64 px | The same tile without the "41"; the letters sit in the middle |
| **Pixel-tuned** | Exactly 16, 24, 32, 48 and 64 px (the `.ico`) | Simple tile redrawn on the pixel grid so every stem is sharp. 16 to 32 px is just bold white "Nb" on the gradient. |
| **Lock-up** | Splash, welcome, about | Tile + "Niobium" wordmark |

### Files

| File | What |
| --- | --- |
| `launcher/assets/app-icon.svg` | Master, rich, 1024 x 1024. The source of truth. |
| `launcher/assets/app-icon-simple.svg` | Simple variant, 1024 x 1024 |
| `launcher/assets/sizes/icon-{16,24,32,48,64}.svg` | Pixel-tuned sources for the small icon sizes |
| `launcher/assets/app-icon.png` | 1024 px render of the master. Input for `pnpm tauri icon`. |
| `launcher/public/logo.svg` | Rich logo for the web UI (also the favicon) |
| `launcher/public/logo-simple.svg` | Simple logo for small spots |
| `launcher/public/logo-wordmark.svg` | Lock-up: tile + "Niobium", for dark backgrounds |
| `launcher/src-tauri/icons/*` | App icons. `icon.ico` holds 16/24/32/48/64 (pixel-tuned) and 256 (rich). |
| `launcher/src/components/layout/Logo.tsx` | React: `LogoMark`, `Wordmark`, `Logo` |
| `native/client/ATLAS/Public/Icon.h` | F9-menu logo: the simple tile as a 512 x 512 PNG byte array |
| `launcher/src-tauri/windows/assets/*.bmp` | Installer art (see below) |

### Construction

- 1024 box. The tile is 896 x 896 at (64, 64) with a corner radius of 208.
- Layers, bottom to top: the blue to violet gradient (diagonal, with `#5546FF` in the middle), a light-blue bloom at the top left, a dark-indigo depth shade at the bottom left, the gold corner flare (gold into a soft pink `#FF6FA8` and then into the violet, like real anodised metal), the glass sheen (a diagonal with a soft edge at 40 %), an inner rim (white 42 % at the top, fading out), the "41", and the letters.
- "Nb" is a hand-built geometric monogram: a stem width of 25 % of the cap height, the b-bowl at 74 % of the cap height, and white to a faint lavender `#E6E4FF` from top to bottom.
- The "41" and the wordmark are outlines of Inter Display Bold (by Rasmus Andersson, SIL Open Font License 1.1). Only the outlines are used. No font file ships, so the logo looks the same everywhere.
- The wordmark is "Niobium" in Inter Display Bold with -1 % tracking. Always use the `Wordmark` component or `logo-wordmark.svg`. Never type it in a font.

### Rules

- Leave clear space around the tile of at least 25 % of its size. The minimum size is 16 px.
- Put it on dark backgrounds (`bg`, `surface`, or dark glass). On light backgrounds it still works as an app icon, but do not place the wordmark on light backgrounds; the wordmark is light.
- Do not recolour, stretch, rotate, outline or add new effects to the tile. Do not swap the corner the gold sits in.
- Glow is allowed: the soft violet/blue glow behind the tile (`LogoMark glow`) on the splash, the welcome screen and the about page.

### React API (`@/components/layout/Logo`)

```tsx
<LogoMark className="size-9" />            // simple tile, sized by class (default 32 px)
<LogoMark size={96} glow />                // rich tile (auto: rich from 64 px) + breathing glow
<LogoMark size={48} variant="rich" />      // force the "41"
<Wordmark className="h-6 text-foreground" />  // "Niobium", uses the current text colour
<Logo size={56} glow tagline />            // tile + wordmark + "old seasons, new shine."
```

The glow stays still when the OS asks for reduced motion or the app's "Reduce motion" option is on (it reads `MotionConfig`). Every instance gets its own gradient ids (`useId`), so many logos can share one page.

### Regenerating the app icons

1. Edit `launcher/assets/app-icon.svg` (and the simple and size files if the letters change). Render it to `launcher/assets/app-icon.png` at 1024 px with a transparent background.
2. Run `cd launcher && pnpm tauri icon assets/app-icon.png`. Then delete the `android/` and `ios/` folders it creates; this app is desktop-only.
3. The CLI scales every size down from the 1024 master, so small sizes get blurry. Render `assets/sizes/icon-*.svg` at their exact sizes and rebuild `icon.ico` from those (16/24/32/48/64) plus a 256 px render of the master. Also overwrite `32x32.png` and `64x64.png`, and `Square30/44/71/89` and `StoreLogo` with the simple variant.

## Installer (NSIS)

| Setting | Value |
| --- | --- |
| `MUI_BGCOLOR` | **`0A0B12`**. This is the exact background of `header.bmp` and the colour the sidebar fades into. Use it instead of the old `0F1115`. |
| `MUI_TEXTCOLOR` | `F2F3F8` |
| `MUI_FINISHPAGE_LINK_COLOR` | `B49BFF` (violet-text, 8.5:1 on `0A0B12`) |
| Win11 caption colour (`DWMWA_CAPTION_COLOR`) | `0x00120B0A` (COLORREF is 0x00BBGGRR for `#0A0B12`) |

| File | Size | Notes |
| --- | --- | --- |
| `windows/assets/sidebar.bmp` | 164 x 314 | Welcome and Finish pages. Glowing logo, "Niobium", "old seasons, new shine.", a gradient line and "NIOBIUMFN". The right edge is exactly `#0A0B12`, so it melts into the page. |
| `windows/assets/header.bmp` | 150 x 57 | Small tile + wordmark on the right. **Every edge pixel is exactly `#0A0B12`**, so with `MUI_HEADERIMAGE_RIGHT` it blends into the header band. |
| `windows/assets/splash.bmp` | 420 x 240 | AdvSplash card: logo, wordmark, tagline and gradient line on a dark card with 22 px rounded corners. Everything outside the card is pure `#FF00FF` (the colour key). The edges are hard, with no anti-aliasing against magenta, so there is no pink fringe. Call it with `advsplash::show 900 350 300 0xFF00FF "$PLUGINSDIR\<name>"` (no `.bmp`). |

All three files are 24-bit, uncompressed (`BI_RGB`), use the 40-byte BITMAPINFOHEADER and have no alpha. The header bytes were checked with Python. They also built through makensis with Tauri's NSIS template without warning 5040.

## UI direction

**Mood: "anodised metal in the dark."** Use a near-black background and glass panels. Colour comes from light (glows, gradients, thin rims), not from big flat coloured areas.

- **Glass.** Panels use `--nb-glass` with `backdrop-filter: blur(20px) saturate(140%)`, a 1 px `--nb-border` and an inner top highlight `inset 0 1px 0 rgb(255 255 255 / 0.06)`. Radius: 12 px for cards, 8 px for controls, full for pills.
- **Glow.** Save the brand glow for the one thing that matters on a screen: the Play/Launch button, the active nav item and the logo. Everything else stays calm.
- **Gold.** Use gold sparingly, as a reward: a "New" dot, the tip of a progress bar, the trickshot highlight, a short sparkle when something finishes.
- **Background.** Slow "aurora": three big blurred blobs (blue, violet and a small gold one) drifting over 40 to 60 s at 35 % opacity or less, plus the faint dot grid. It is static when motion is reduced.
- **Motion.** Entrances ease out with `cubic-bezier(0.16, 1, 0.3, 1)`. Exits use `cubic-bezier(0.7, 0, 0.84, 0)` and are shorter. Durations: 120 ms for hover and press, 200 to 260 ms for toggles and panels, 400 to 600 ms for page changes and hero moments. Springs: stiffness 380 / damping 32 for UI, and stiffness 200 / damping 22 for playful moments such as the logo pop. Stagger lists by 40 ms. On press, scale buttons to 0.97. On hover, lift cards by 2 px and add a faint glow.
- **Signature move: the sheen sweep.** A diagonal white band (about 25 % opacity, tilted 30°) sweeps across the logo tile or the Play button once on load and again on hover, over 700 ms. It is the same diagonal as the sheen in the logo.
- **Splash (440 x 300).** At 0 ms the tile scales from 0.86 to 1 and goes from blur 12 px to 0 and from opacity 0 to 1 (spring). At 250 ms the glow fades in. At 450 ms the sheen sweeps. At 500 ms the wordmark rises 8 px and fades in, and at 650 ms the tagline follows. A thin `--nb-gradient-shine` line loops until `app_ready`. The splash should feel finished within 1.2 s.
- **First-run welcome.** Start with the large `Logo` lock-up with glow, then cards that slide in with a 40 ms stagger. "What's new" is a single glass card with a gold "New" dot.
- **Type.** Keep Segoe UI Variable for the UI. Headings are semibold with -0.01em tracking. Use tabular numbers for versions and stats. The name is always the `Wordmark` SVG.
- **Reduced motion.** Respect the OS setting and the app's own setting. When either is on, use no infinite animations and replace movement with fades of 150 ms or less.
- **Words.** Plain, short, friendly English. Say "Play", not "Execute"; say "Your builds", not "Installations".
