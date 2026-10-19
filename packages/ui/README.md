# @aegis/ui – AEGIS Design-System

Tokens, Logo, Start-Animation, UI-Klang, Komponenten, Icons und Showcase für die AEGIS Suite.
Wird als TypeScript-Quelle eingebunden (kein eigener Build-Schritt, siehe D-002).

```ts
import '@aegis/ui/styles.css'; // Tailwind 4 + Schriften + Tokens + Basis-Stile
import { AegisLogo, BootSequence, Button, ConsentDialog, themes } from '@aegis/ui';
```

```bash
pnpm --filter @aegis/ui dev            # Showcase (deutsch) auf http://localhost:5173
pnpm --filter @aegis/ui test:coverage  # Vitest + Abdeckung (Paket 80 %, Komponenten 85 %, Freigabe 95 %)
                                       # (in CI – Umgebungsvariable CI – läuft die Abdeckung bei `test` immer mit)
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

## Komponenten (`src/components`)

Gemeinsame Regeln: typisierte Props (`exactOptionalPropertyTypes`-fest, optionale Props
akzeptieren `undefined`), Ref-Weitergabe über die `ref`-Prop (React 19), nur Tokens (keine
Rohfarben), Animationen nur über `transform`/`opacity` (Ausnahme: SVG-Striche zeichnen), bei
„Bewegung reduzieren“ (`useReducedMotionPreference`) keine Bewegung. Alle Texte haben deutsche
Standardwerte und lassen sich per Prop (`label…`/`labels`) ersetzen – die Übersetzung macht die
App. Für die zwei Dialoge und die Palette gibt es fertige englische Sätze
(`consentDialogLabelsEn`, `permanentDeleteLabelsEn`, `commandPaletteLabelsEn`).

| Komponente                                   | Wichtigste Props                                                                                                                                                                                                                          | Hinweise                                                                                                                                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                                     | `variant` `primary`/`secondary`/`ghost`/`danger`, `size` `sm`/`md`/`lg`, `loading`, `loadingLabel`, `iconStart`, `iconEnd`, `fullWidth`                                                                                                   | `type="button"` als Standard; Feder per `scale`; Laden = `aria-busy`, bleibt fokussierbar; gesperrte Haupt-/Gefahr-Buttons werden neutral grau                                                                         |
| `IconButton`                                 | `label` (Pflicht → `aria-label`), `icon`, `variant`, `size`, `pressed`                                                                                                                                                                    | `pressed` setzt `aria-pressed`                                                                                                                                                                                         |
| `Spinner`                                    | `size`                                                                                                                                                                                                                                    | dekorativ                                                                                                                                                                                                              |
| `Card` / `Panel`                             | `level` 1–3, `padding`, `glass`, `glow`; Panel: `title`, `eyebrow`, `description`, `actions`, `footer`, `headingLevel`                                                                                                                    | Panel mit `title` = benannte Region                                                                                                                                                                                    |
| `Divider`, `Kbd`                             | `orientation`, `label`, `decorative`; `keys={['Strg','K']}`                                                                                                                                                                               |                                                                                                                                                                                                                        |
| `StatusRing`                                 | `state` (`ok`/`warn`/`danger`/`off`/`unavailable`/`scanning`), `label`, `sublabel`, `stateLabel`, `icon`, `size`, `layout`, `hideText`                                                                                                    | Zustand immer als Text; `hideText` → `role="img"`                                                                                                                                                                      |
| `ScoreGauge`                                 | `value: number \| null`, `label`, `size`, `unavailableText`, `unavailableHint`, `bandLabels`, `glow`, `showLabel`                                                                                                                         | `null` = neutral „–“ mit Erklärung, nie geschätzt; sonst `role="meter"`; Bereiche < 50 / < 80 / ≥ 80                                                                                                                   |
| `CountUp`                                    | `value`, `from`, `duration`, `decimals`, `locale`, `format`, `live`                                                                                                                                                                       | rAF, `tabular-nums`; Screenreader hören nur den Endwert                                                                                                                                                                |
| `RiskBadge`                                  | `level`, `size`, `label`, `showIcon`                                                                                                                                                                                                      | Text + eigenes Icon je Stufe                                                                                                                                                                                           |
| `Toggle`                                     | `checked`/`defaultChecked`/`onCheckedChange`, `label`, `description`, `size`, `labelPosition`                                                                                                                                             | `role="switch"`; in Kontrastdesigns (`forced-colors`) Knopf in Systemfarben (an = Highlight, aus = ButtonText)                                                                                                         |
| `SegmentedControl`                           | `label` (Pflicht), `options`, `value`/`defaultValue`/`onValueChange`, `size`, `fullWidth`, `disabled`                                                                                                                                     | Radiogruppe, Pfeiltasten, ein Tab-Stopp                                                                                                                                                                                |
| `Tabs`, `TabList`, `Tab`, `TabPanel`         | `value`+`onValueChange` oder `defaultValue`, `orientation`, `activation`                                                                                                                                                                  | WAI-ARIA-Tabs; schmale Fenster scrollen waagerecht                                                                                                                                                                     |
| `Tooltip`                                    | `content`, `children` (ein fokussierbares Element), `placement`, `delay`, `disabled`                                                                                                                                                      | Hover verzögert, Fokus sofort, Escape schließt, überfahrbar (WCAG 1.4.13); nur Ergänzungen, nie Wesentliches                                                                                                           |
| `ToastProvider` + `useToast()`               | `show({ tone, title, description, actions, duration })`, `dismiss`, `clear`; Provider: `bottomOffset` (Abstand unten, z. B. über einer Statusleiste)                                                                                      | höflich (`status`), `danger` dringlich (`alert`); Pause bei Hover/Fokus/Fenster im Hintergrund; **mit `actions` nie automatisch weg**, `danger` bleibt standardmäßig                                                   |
| `Dialog`                                     | `open`, `onClose(reason)`, `title`, `description`, `describedBy`, `eyebrow`, `headerAside`, `footer`, `role`, `size`, `placement`, `tone`, `initialFocusRef`, `closeOnBackdrop`, `showCloseButton`, `glass`, `padded`, `onStackTopChange` | Portal, Fokusfalle, Hintergrund `inert`, Scroll-Sperre, Fokus zurück; stapelbar (nur der oberste ist bedienbar, `inert` zentral aus dem Stapel); `[data-autofocus]`; Escape gilt auch, wenn der Fokus auf `body` liegt |
| `ConsentDialog`                              | siehe unten                                                                                                                                                                                                                               | Freigabe-Dialog der Goldenen Regel                                                                                                                                                                                     |
| `PermanentDeleteConfirmDialog`               | siehe unten                                                                                                                                                                                                                               | zweite Bestätigung                                                                                                                                                                                                     |
| `CommandPalette`                             | `open`, `onClose(reason)`, `items: CommandItem[]`, `labels`                                                                                                                                                                               | Combobox + gruppierte Listbox; `onSelect` läuft erst nach dem Schließen                                                                                                                                                |
| `SafeText`                                   | `value`, `maxLength`, `mono`, `breakAll`, `describeInvisible`                                                                                                                                                                             | fremde Texte sicher: ⟨U+202E⟩-Marken, Bidi-Isolation, Leerzeichenfolgen bleiben erhalten, Kürzung in der Mitte                                                                                                         |
| `EmptyState`, `ComingSoon`, `PhaseBadge`     | `icon`, `title`, `description`, `phase`, `note`, `actions`                                                                                                                                                                                | „Folgt in P3“ statt Fantasiewerten                                                                                                                                                                                     |
| `PageTransition`, `Skeleton`, `SkeletonText` | `transitionKey`; `width`/`height`/`radius`; `lines`                                                                                                                                                                                       | Übergang opacity + 6 px; Skeletons dekorativ (Container setzt `aria-busy`)                                                                                                                                             |

`CommandItem`: `{ id, label, group, keywords?, shortcut?, icon?, hint?, disabled?, onSelect }`.
Die Suche faltet Akzente und ß („uberspringen“ findet „Überspringen“), bewertet Anfang >
Wortanfang > Teilwort > Abkürzung („qw“ → „Quarantäne-Wiederherstellung“) > Teilfolge.

### Freigabe-Dialog (`ConsentDialog`)

```tsx
<ConsentDialog
  open={open}
  plan={{
    id,
    digest,
    kindLabel,
    severity,
    targets,
    what,
    why,
    consequence,
    undo,
    expiresAt,
    parameters,
  }}
  onDecision={(decision, meta) => send(decision, meta.planId, meta.digest)} // 'execute' | 'decline' | 'ignore' | 'trust'
  onDismiss={() => setOpen(false)} // nur nach Ablauf: es wurde nichts getan
  allowIgnore
  allowTrust
/>
```

`plan` spiegelt `aegis_core::plan::ActionPlan` (+ `ProposalTicket.expires_at`): `targets` und
`undo` haben genau die serde-Form des Kerns (`{ type: 'file', path }`, `{ type: 'process', pid,
image_path }`, `{ type: 'registry_value', key, name }`, `{ type: 'setting', id }`,
`{ type: 'other', description }`; `{ type: 'reversible', how }` / `{ type: 'irreversible',
warning }`), die Antworten die Kennungen von `Decision`. `severity` ist die UI-Stufe (aus dem
Kern per `riskLevelFromCoreId`), `kindLabel` z. B. `ActionKind::label_de`, `expiresAt` als Date,
Epoch-ms oder RFC-3339-Text (außerhalb des Date-Bereichs = ungültig). `digest` (optional) ist
der Plan-Digest bzw. die Vorschlags-Nonce aus dem Dienst; `onDecision` bekommt als zweites
Argument `meta = { planId, digest, plan }` – genau die Fassung, die beim Klick sichtbar war. Die
UI prüft nichts selbst – Digest, Frist und Einmaligkeit erzwingt der Dienst (`ConsentGate`); der
Dialog sorgt dafür, dass niemand versehentlich „Ja“ sagt:

- Startfokus auf „Nein“, nie auf „Ja, ausführen“.
- „Ja, ausführen“ ist `guardMs` (Standard 600, mindestens 300) gesperrt – nach dem Öffnen,
  nach **jeder** Änderung am angezeigten Plan (auch bei gleicher ID; Hinweis „Plan geändert“),
  sobald ein darüberliegender Dialog schließt und sobald das Fenster wieder sichtbar bzw. im
  Vordergrund ist. Die Sperrzeit läuft nur, solange der Dialog wirklich vorn liegt (oberster
  Dialog, Seite sichtbar, Fenster fokussiert). Ein Mausklick zählt nur, wenn auch der Druck erst
  nach der Sperrzeit begann. „Vertrauen“ und „Ignorieren“ haben ebenfalls bleibende Folgen und
  sind genauso lange gesperrt – nur „Nein“ geht sofort. Gehaltene Tasten (Autorepeat) zählen
  auf keinem Antwort-Knopf.
- Escape = `onDecision('decline')` – auch wenn der Fokus auf `body` gefallen ist. Klick neben
  den Dialog tut nichts (und nimmt ihm nicht den Fokus), es gibt kein „X“.
- Enter im Dialog löst nie „Ja“ aus (kein Formular, kein Standard-Button).
- Höchstens eine Antwort je Öffnen und Fassung; danach sind alle Knöpfe gesperrt und der Dialog
  zeigt „Antwort „…“ gesendet“ (die Frist zählt dann nicht mehr).
- Frist läuft sichtbar mit („Verfällt in 9:41“; vorgelesen wird die Uhrzeit, an einem anderen
  Tag mit Datum); bei Ablauf ohne Antwort (oder ungültiger Frist) „Abgelaufen – es wurde nichts
  getan“, alles gesperrt, Fokus auf „Schließen“ (`onDismiss`), `onExpire` einmal. Eine Antwort
  im Moment des Ablaufs wird zusätzlich anhand der aktuellen Zeit verworfen.
- Nicht umkehrbar oder „Gefährlich“ → deutliche Warnung oben, auf die der Dialog und „Ja,
  ausführen“ per `aria-describedby` verweisen; **rot** ist „Ja, ausführen“ nur bei nicht
  umkehrbaren Plänen.
- Ziele über `SafeText`: Pfade in JetBrains Mono, unsichtbare/Bidi-Zeichen als `⟨U+202E⟩` mit
  Hinweis, Rechts-nach-links-Schrift mit Hinweis, lange Pfade in der Mitte gekürzt
  („Ganz anzeigen“, voller Text immer für Screenreader). Registrierungswerte zeigen Schlüssel
  und Wertname getrennt (Wertnamen dürfen `\` enthalten).
- Auch „Was genau?“, „Warum?“, „Was passiert dann?“, „Rückgängig“ und Parameter erscheinen
  über `SafeText` (Dateinamen darin können Bidi-Zeichen enthalten).
- Mehrere Freigabe-Rückfragen gleichzeitig sind möglich (nur die oberste ist bedienbar und
  arm), besser zeigt die App aber immer nur eine an (Warteschlange).

### Zweite Bestätigung (`PermanentDeleteConfirmDialog`)

`targets`, `challengeId`, `notBefore` / `expiresAt` (aus `SecondConfirmationChallenge`),
`delayMs` (Standard 1500, mindestens 1000), `onConfirm(meta)` (= `Decision::Execute`, `meta =
{ challengeId, targets }` der angezeigten Rückfrage), `onCancel` (Abbrechen/Escape),
`onDismiss` (nach Ablauf). Titel „Endgültig löschen – kann nicht rückgängig gemacht werden“,
Countdown bis frühestens `max(notBefore, Öffnen + delayMs)`, dann ein expliziter roter Button;
Startfokus „Abbrechen“. Wie beim Freigabe-Dialog läuft die Wartezeit nur, solange der Dialog
vorn liegt, beginnt bei geänderten Zielen/Kennung/Zeiten neu, zählt ein Mausklick nur mit
einem Druck nach der Wartezeit, und nach der Antwort erscheint nie „Abgelaufen“. Bewusst **kein** Bestätigungswort zum Eintippen: Es bremst Tastatur- und
Screenreader-Nutzer, ohne mehr Schutz zu bieten als die getrennte zweite Rückfrage mit
Wartezeit, die der Dienst ohnehin erzwingt.

## Icons (`src/icons`)

Eigene Zeichnungen (keine übernommenen Icon-Sätze): 24-px-Raster, Strich 1,75, runde Enden,
`currentColor`. `IconDashboard`, `IconScan`, `IconShield`, `IconLab`, `IconNetwork`, `IconLock`,
`IconKey`, `IconTools`, `IconQuarantine`, `IconReport`, `IconSettings`, `IconInfo`,
`IconWarning`, `IconDanger`, `IconCheck`, `IconClose`, `IconMinus`, `IconPower`, `IconClock`,
`IconPanic`, `IconMinimize`, `IconMaximize`, `IconRestore`, `IconSearch`,
`IconChevronDown/Up/Left/Right`, `IconArrowRight`, `IconExternal`, `IconRefresh`, `IconUndo`,
`IconTrash`, `IconPlay`, `IconPause`, `IconSoundOn`, `IconSoundOff`, `IconSun`, `IconMoon`,
`IconGlobe`, `IconFile`, `IconProcess`, `IconSliders`, `IconTree`, `IconEye`, `IconGamepad` –
plus `icons` (Name → Komponente) und `createIcon`. Props: `size` (Standard 24), `strokeWidth`,
`title` (ohne Titel dekorativ/`aria-hidden`, mit Titel `role="img"`), `ref`.

## Hilfen

`cx`, `mergeRefs`, `getTabbableElements`, `focusElement`, `useControllableState`, `usePresence`,
`useNow`, `formatCountdown`, `formatSecondsShort`, `toEpochMs`, Text-Sicherheit
(`splitInvisibleCharacters`, `revealInvisibleCharacters`, `hasInvisibleCharacters`,
`containsRightToLeft`, `middleTruncateUnits`), Suche (`foldForSearch`, `scoreSearchable`).
`src/source-guard.test.ts` verhindert rohe Bidi-/Nullbreite-Zeichen im Quelltext
(„Trojan Source“) – in Tests und Beispielen stehen sie nur als Escape.

## Showcase

`showcase/` – deutsche Übersichtsseite mit Seitennavigation: Muster (Dashboard-Komposition mit
deutlich gekennzeichneten **Demo-Daten (Showcase)**, Freigabe-Dialog mit **Beispiel**-Plänen),
alle Komponenten, Icons und die Token-Abschnitte (Farben mit Live-Kontrast, Risikostufen,
Typografie, Bewegung, Logo, Klang). Strg+K / ⌘K öffnet die Befehlspalette. Prüf-Parameter:
`?theme=light`, `?boot=1` (Start-Animation beim Laden), `?bootScale=2.5`,
`?demo=palette|quarantine|terminate|delete|deadline` (Overlay beim Laden öffnen).
