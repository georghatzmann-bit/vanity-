# @aegis/ui – AEGIS Design-System

Tokens, Logo, Start-Animation, UI-Klang und Showcase für die AEGIS Suite.
Wird als TypeScript-Quelle eingebunden (kein eigener Build-Schritt, siehe D-002).

```ts
import '@aegis/ui/styles.css'; // Tailwind 4 + Schriften + Tokens + Basis-Stile
import { AegisLogo, BootSequence, themes, contrastRatio } from '@aegis/ui';
```

```bash
pnpm --filter @aegis/ui dev            # Showcase (deutsch) auf http://localhost:5173
pnpm --filter @aegis/ui test:coverage  # Vitest + Abdeckung (Schwelle 80 %)
pnpm --filter @aegis/ui export-logo    # Logo-Assets aus der Geometrie neu erzeugen
pnpm --filter @aegis/ui check-logo     # nur prüfen (Exit-Code 1 bei Abweichung)
```

## Tokens (`src/tokens`)

- `tokens.css` – Rohwerte als `--aegis-*` je Theme (dunkel = Standard auf `:root`,
  hell über `data-theme="light"` – auf `<html>` oder einem Teilbaum). Abbildung nach
  Tailwind per `@theme inline`, daher wechseln Utilities wie `bg-surface-1`,
  `text-text-muted`, `border-border`, `text-risk-dangerous`, `shadow-glow` mit dem Theme.
  Die Standard-Farbpalette von Tailwind ist entfernt (`--color-*: initial`): es gibt nur
  semantische Farben, keine hart codierten.
- `tokens.ts` – typisierter Spiegel (Farben, Schatten, Radien, Schriften, Typo-Skala,
  Dauern in ms, Bézier-Tupel, Motion-Federn `snappy`/`gentle`).
- `contrast.ts` – WCAG-Leuchtdichte und Kontrastverhältnis.
- `tokens.test.ts` – erzwingt 1 : 1-Gleichheit von CSS und TS und WCAG AA in beiden Themes:
  `text`, `text-muted` und `text-subtle` ≥ 4,5 : 1 auf `bg` und allen Flächen (`surface-1/2/3`,
  auch für 11–12-px-Beschriftungen), `focus` und `border-strong` ≥ 3 : 1 auf allen Flächen
  (WCAG 1.4.11), Status- und Risikofarben ≥ 4,5 : 1.

| Token                                             | Dunkel                            | Hell                              |
| ------------------------------------------------- | --------------------------------- | --------------------------------- |
| bg                                                | `#07090c`                         | `#f5f7fa`                         |
| surface-1 / 2 / 3                                 | `#0d1116` / `#131820` / `#1a212b` | `#ffffff` / `#f0f3f7` / `#e6ebf1` |
| border / border-strong                            | `#232c38` / `#5d6b84`             | `#d5dce5` / `#7b8899`             |
| text / muted / subtle                             | `#e7edf4` / `#9ba8b7` / `#7b8999` | `#0b1220` / `#475467` / `#606b7b` |
| accent / accent-strong / on-accent                | `#22d3ee` / `#67e8f9` / `#031418` | `#0b6a84` / `#0a5368` / `#ffffff` |
| success / warn / danger                           | `#34d399` / `#fbbf24` / `#f87171` | `#05704f` / `#a04a06` / `#b91c1c` |
| Risiko: Sauber / Info / Spiel-Tool/Cheat          | `#34d399` / `#60a5fa` / `#a78bfa` | `#05704f` / `#1d4ed8` / `#6d28d9` |
| Risiko: Tool mit Risiko / Verdächtig / Gefährlich | `#facc15` / `#fb923c` / `#f87171` | `#875c00` / `#b13a0a` / `#b91c1c` |

Zu jeder Risikostufe gibt es eine deckende `-subtle`-Fläche (Badges); Text darauf ≥ 4,5 : 1.
Bezeichnungen wie in `crates/core/src/risk.rs`; `riskLevelFromCoreId('risky_tool')` bildet die
serde-Kennungen des Kerns auf die UI-Schlüssel (`clean … dangerous`) ab.

## Logo (`src/logo`)

Facettierter Schild aus zwei gespiegelten Strichen, die sich an der Spitze treffen; darin ein
spitzes Λ und ein waagerechter Scan-Balken – zusammen das „A“ von AEGIS. Raster 64 × 64,
Strich 4, senkrechte/waagerechte Kanten pixelgenau bei 16 und 32 px. Der Schriftzug besteht
aus eigenen geometrischen Versalien (Pfade, keine Schriftabhängigkeit).

- `geometry.ts` – alle Pfade (Umriss-Hälften, Λ, Scan-Balken, Füllform, Schriftzug, Lockup).
- `<AegisLogo size variant="mark|full" appearance="line|solid" tone="accent|mono" title decorative>`
- `<AegisWordmark height title decorative>` – Farbe = `currentColor`.
- `assets/logo-mark.svg` (App-Icon 1024 × 1024 für `tauri icon`), `logo-mark-mono.svg`
  (currentColor), `logo-full.svg` (für dunkle Flächen) – erzeugt von `scripts/export-logo.mjs`,
  ein Test prüft, dass die Dateien exakt der Geometrie entsprechen.

## Start-Animation (`src/boot`)

`<BootSequence onComplete durationScale? skipLabel? statusLabel? sound? className? />` –
≈ 1,5 s: Umriss zeichnet sich von oben zur Spitze (0–0,7 s), Λ folgt; Lichtlinie wandert
über das Zeichen und legt den Scan-Balken frei (0,6–1,0 s); Schriftzug gleitet ein
(0,9–1,3 s); Ebene blendet aus (1,3–1,5 s). `onComplete` kommt genau einmal.

- Phasen per JS-Takt (`requestAnimationFrame`), Motion stellt nur dar → mit Fake-Timern testbar.
- Überspringen: Klick, `Esc`, `Enter`, Leertaste oder Button „Überspringen“ (150 ms Blende).
- Harte Obergrenze 4 s per Timer (greift z. B., wenn rAF im minimierten Fenster pausiert).
- „Bewegung reduzieren“: statisches Logo, nur Deckkraft, ≤ 300 ms (`durationScale` kann hier
  nur verkürzen, nicht strecken).
- Animiert werden nur `transform`/`opacity` und die Strich-Länge in SVG-Masken.
- Barrierefreiheit: Statusregion „AEGIS wird gestartet“, Grafik `aria-hidden`, keine
  Fokusfalle und kein Fokus-Diebstahl.
- **Pflicht für Einbindende:** den App-Inhalt bis `onComplete` `inert` und `aria-hidden` halten.
  Die Komponente nur vor dem Inhalt zu rendern reicht nicht – sonst erreicht Tab nach
  „Überspringen“ verdeckte Elemente (WCAG 2.4.11) und Screenreader lesen die Seite dahinter.
  Den Fokus erst nach dem Aufheben von `inert` setzen (Effekt nach `onComplete`, siehe
  `apps/desktop/src/App.tsx` und `showcase/Showcase.tsx`).

## Klang (`src/sound`)

`createUiSound()` / `getUiSound()` → `bootChime()`, `click()`, `alert()` – WebAudio-Synth ohne
Dateien, sehr leise. Schalter `setSoundEnabled`/`isSoundEnabled`/`useSoundEnabled`
(localStorage `aegis.sound` = `on`/`off`, Standard an, Speicherfehler werden abgefangen).
Ohne WebAudio oder bei Autoplay-Sperre bleibt es still; nichts wird nachgeholt. Meldet die
Umgebung `navigator.userActivation`, entsteht vor der ersten Nutzergeste gar kein AudioContext
(kein „suspended“ hängender Kontext, keine Chromium-Konsolenwarnung) – der Start-Klang beim
App-Start bleibt daher still, der erste Klang nach einer Geste geht nicht verloren. Ein
gesperrter Kontext wird in einer laufenden Geste fortgesetzt und der Klang trotzdem gespielt.
Soll der Start-Klang in der App hörbar sein, müsste das WebView die Autoplay-Sperre
ausdrücklich aufheben (z. B. `--autoplay-policy=no-user-gesture-required` in
`additionalBrowserArgs`) – bewusst nicht gesetzt. `volume` wird auf 0–1 begrenzt; ungültige
Werte (NaN, ±∞) ergeben den Standard 0,6.

## Showcase

`showcase/` – deutsche Übersichtsseite (Theme-Umschalter, Farbfelder mit Live-Kontrast,
Risikostufen, Typografie, Bewegung, Logo-Größen, Klang). Prüf-Parameter:
`?theme=light`, `?boot=1` (Start-Animation beim Laden), `?bootScale=2.5`.
