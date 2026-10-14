<!-- Entstanden im Design-Workflow (Oktober 2026): 4 unabhängige Entwürfe (Messgerät-Purist, Sonifikations-Designer, Bewegungs-Regisseur, Rendering-Ingenieur), 3 Juroren (Art Director, Auftrag/Wissenschaft, Technik), Punkte: Messgerät 127, Sonifikation 125, Rendering 123, Bewegung 112. Der Sieger ist das Rückgrat, die besten Ideen der anderen sind übernommen. Nach der Umsetzung hat ein strenger Prüfer in 2 Runden 68 Befunde beheben lassen – wo Code und dieses Dokument abweichen, gilt der Code. -->

# PULSAR Setup „Radioteleskop“ und Klang-Engine „Pulsar-Sonifikation“: verbindliche Umsetzungs-Spezifikation v1.0

**Gelesen und abgeglichen wurde:**
- `installer/src/App.tsx` (808 Zeilen), `api.ts`, `i18n.ts`, `i18n.test.ts`, `main.tsx`, `styles.css`, `components/*`
- `shared/sound/engine.ts` und alle 69 `sound.play`-Aufrufe in `app/src`, `shared/ui/*`
- `shared/design/tokens.css`, `base.css`, `motion.ts`
- `scripts/installer-tour.mjs`, `feature-shots.mjs`, `e2e-installer-linux.mjs`
- `installer/vite.config.ts`, `tauri.conf.json` (CSP `default-src 'self'`), `.github/workflows/windows.yml` (Screenshot nach 9 s)
- `installer/src-tauri/src/{download,install,uninstall,commands}.rs`: echte Prozentwerte sind Download 0–85, Prüfen bis 92, Installieren 92–96, Verknüpfungen 96–98, Eintragen 98–99,5, Fertig 100. Deinstallation: 5/20/40/60/75/85/100.
- `docs/API.md` (Vertrag „Hör dein Netz“), `docs/KREATIV-PLAN.md`
- Das latin-Subset von `@fontsource/ibm-plex-mono@5.3.0` wurde Glyphe für Glyphe geprüft.

**Verbindlichkeit:** Alles hier ist **Muss**, außer es steht ausdrücklich „optional“ daneben.

**Was nicht geändert wird:**
- Rust-Code, Befehle, Event-Namen und Payloads
- `shared/design/tokens.css` und `base.css`, die die App mitbenutzt
- die Namen von Knöpfen, auf die Tour und E2E klicken

---

## A. Leitidee und Abgrenzung

**Das Setup ist ein Empfänger.**
1. Ein Regler sucht im Rauschen die **Faltfrequenz** und rastet auf PSR B1919+21 ein, den ersten Pulsar (Bell Burnell und Hewish, 1967).
2. Zwei Pulse kommen in Echtzeit, 1337,3 ms auseinander. Danach zeichnet ein gekennzeichneter Zeitraffer das gestapelte Profil fertig.
3. Die Zeilen falten sich zum Zeichen: Jede Rotation wird ein Strahl, die Summe aller Rotationen wird der Ring.
4. Danach treibt der **echte** Installationsfortschritt den Stern an, von 1,337 s bis 5,757 ms. Aus Klicks wird Knattern, dann Schnarren, dann ein Ton.
5. Am Ende friert ein Stroboskop den Stern in Logo-Lage ein, und der Ton löst sich in seine eigenen Obertöne auf.
6. Beim Deinstallieren läuft alles rückwärts bis ins Rauschen.

Bild und Ton haben **eine** Takt-Quelle. Alles Erfundene ist beschriftet.

| Übliche Vorlage | Radioteleskop |
|---|---|
| Glas, Unschärfe, Farbverlauf-Blobs, Sternenfeld | Graphitfläche, 1-px-Haarlinien, kein `backdrop-filter`, kein Verlauf, kein `shadowBlur` |
| Bunte Akzente, Neon | **Eine** Signalfarbe (Kanal-1-Gelb wie bei Oszilloskopen), nur für Linien, Marken und kleine Flächen. Knöpfe sind knochenweiß. |
| Fortschrittsring oder -balken mit Glühen | Drehzahl auf einer logarithmischen Periodenskala mit 4 Katalog-Pulsaren. Daneben die *gemessene* Übertragung als Messwert mit Skala. |
| Erfolgs-Melodie, Glocken, Konfetti | Impulse, Rauschen, fallende Dispersions-Sweeps. Der einzige Akkord ist das Obertonspektrum des Endtons. |
| Album-Cover-Zitat (80 weiße Linien, zentriert) | 16 Zeilen in einem beschrifteten Messfenster mit Achse, Zeilennummern, Summenkurve Σ und „SIMULIERTES PROFIL“. Die Ridgeline ist ein Zwischenschritt. |
| HUD-Klischees (Fadenkreuz, Passermarken, Tippschrift, Phosphorgrün) | Keine. Nur Skalen und Beschriftungen mit Bedeutung. |

**Herkunft der übernommenen Ideen:**

| Bereich | Herkunft |
|---|---|
| Rückgrat, Graphit/Gelb, Inter + Plex Mono, Radius 2/0, Faltung mit √N, gestaffelte Seitenwechsel, Scheduler statt Worklet, Gewöhnungs-Absenkung | instrument |
| Belichtungskamera (Sanduhr), Stroboskop in Logo-Lage, f★-Harmonische, GEMESSEN/INSZENIERT, Plateaus, Pegelgesetz √(4/f), RFI-Fehler, „Hörbar als“, Ruhe nach dem Akkord | sound |
| Zeilen → Haarstrahlen (Zeichen „rays“), Himmelskarte (nur Intro + Statusleiste), Melodie-Test, `satisfies Record<SoundName, Recipe>`, `useSetupFlow` zuerst, Qualitätsstufen, `CanvasBoundary`, weißer Fokus | engineer |
| Bayer-Dither beim Deinstallieren mit fehlendem 4. Puls, reduzierte Bewegung mit zwei echten Pulsen, Schreibkopf synchron zum Klick | motion |

---

## B. Design-Tokens

### B.1 Farben (nur Installer)

Datei `installer/src/obs/obs.css`. Aktiv wird sie über `<html data-theme="pulsar" data-skin="obs">`; das Attribut wird direkt in `installer/index.html` gesetzt.

```css
:root[data-skin="obs"] {
  color-scheme: dark;
  --obs-bg: #0A0B0D;           /* Fenster */
  --obs-panel: #0E1013;        /* Eingabefeld, Dialog */
  --obs-raise: #14171B;        /* Hover-Fläche */
  --obs-sphere: #0C0E11;       /* Füllung Sternscheibe (flach, kein Verlauf) */
  --obs-rule: #1E2227;         /* Struktur-Haarlinie (Deko, 1,2:1) */
  --obs-rule-strong: #2C3138;  /* Rahmen, Skalen-Grundlinie (Deko, 1,5:1) */
  --obs-grid: rgb(230 233 238 / 0.045);       /* Gratikül, Himmelskarte */
  --obs-grid-axis: rgb(230 233 238 / 0.10);   /* Mittelachsen */
  --obs-control: #646B75;      /* Rand interaktiver Elemente: 3,66:1 auf bg, 3,34:1 auf raise */
  --obs-fg: #E6E8EB;           /* 16,0:1 */
  --obs-fg-2: #A8AEB8;         /* 8,8:1  Fließtext, erledigt */
  --obs-fg-3: #808792;         /* 5,4:1  Beschriftungen, Skalenzahlen (Untergrenze für Text) */
  --obs-fg-4: #4A5059;         /* nur deaktiviert und Skalen-Deko, nie lesepflichtiger Text */
  --obs-signal: #F2D53C;       /* DIE Akzentfarbe, 13,5:1 */
  --obs-signal-dim: rgb(242 213 60 / 0.16);
  --obs-signal-ink: #0A0B0D;
  --obs-warn: #FF8F3F;         /* 8,7:1 – nie ohne Symbol und Wort „HINWEIS“ */
  --obs-error: #FF5A64;        /* 6,5:1 – nie ohne Symbol und Wort „FEHLER“ */
  --obs-focus: #E6E8EB;        /* Fokus ist weiß, damit Fokus ≠ „aktiv“ (gelb) */
  --obs-sans: "Inter Variable", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  --obs-mono: "IBM Plex Mono", "Cascadia Mono", Consolas, ui-monospace, monospace;
}
```

**Regeln für Gelb:** Gelb bedeutet *Signal* und erscheint nur an diesen Stellen:
- Strahlen, Polkappen, Lichtscheibe
- aktuelle Ridgeline-Zeile, Σ-Kurve
- Nadeln und Marken auf Skalen, Schritt-Caret
- 2-px-Fortschrittslinie, Bedarf-Block der Laufwerksskala
- Schalter EIN, Haken-Fläche, Aktiv-Balken der Phasen
- „EINGERASTET“, Strahlen und Kern des Zeichens

Gelb wird **nie** als Knopffläche verwendet und nie als Fläche über 48×48 px.

Es gibt **kein Grün**: „Erledigt“ ist `fg-2` mit „OK“. Status-Farben erscheinen nur in Hinweisen und Fehlern.

### B.2 Zusammenspiel mit `shared/design/tokens.css`

`tokens.css` und `base.css` bleiben unverändert, die App behält Cyan, Glas und Sora. `obs.css` legt im Skin eine Brücke, die über der Spezifität `[data-theme]` liegt (0,2,0 gegen 0,1,0). Dadurch passen `shared/ui/WindowControls` und die Tailwind-Utilities ohne Änderung:

```css
:root[data-skin="obs"] {
  --nv-bg: var(--obs-bg); --nv-bg-elev: var(--obs-panel); --nv-surface: var(--obs-panel);
  --nv-surface-2: var(--obs-raise); --nv-surface-3: var(--obs-raise); --nv-surface-solid: var(--obs-panel);
  --nv-border: var(--obs-rule); --nv-border-strong: var(--obs-rule-strong); --nv-overlay: rgb(10 11 13 / 0.82);
  --nv-fg: var(--obs-fg); --nv-fg-soft: var(--obs-fg-2); --nv-muted: var(--obs-fg-2); --nv-faint: var(--obs-fg-3);
  --nv-accent: var(--obs-signal); --nv-accent-2: var(--obs-signal); --nv-accent-3: var(--obs-signal);
  --nv-accent-fg: var(--obs-signal-ink); --nv-danger: var(--obs-error); --nv-warning: var(--obs-warn); --nv-success: var(--obs-fg-2);
  --nv-font-sans: var(--obs-sans); --nv-font-display: var(--obs-sans); --nv-font-mono: var(--obs-mono);
  --nv-radius-xs: 2px; --nv-radius-sm: 2px; --nv-radius-md: 2px; --nv-radius-lg: 2px; --nv-radius-xl: 2px; --nv-radius-2xl: 2px;
  --nv-glass-blur: 0px; --nv-glow-strength: 0;
  font-feature-settings: "cv05", "cv08";          /* eindeutige l / I */
}
:root[data-skin="obs"] :focus-visible { outline: 2px solid var(--obs-focus); outline-offset: 2px; border-radius: 2px; }
:root[data-skin="obs"].nv-window-leave #root { filter: none; }   /* Fenster-Abschied ohne Unschärfe */
:root[data-skin="obs"] ::selection { background: rgb(242 213 60 / 0.30); }
@theme inline {  /* Utilities bg-obs-bg, text-obs-fg-3, border-obs-rule … */
  --color-obs-bg: var(--obs-bg); --color-obs-panel: var(--obs-panel); --color-obs-raise: var(--obs-raise);
  --color-obs-rule: var(--obs-rule); --color-obs-rule-strong: var(--obs-rule-strong); --color-obs-control: var(--obs-control);
  --color-obs-fg: var(--obs-fg); --color-obs-fg-2: var(--obs-fg-2); --color-obs-fg-3: var(--obs-fg-3); --color-obs-fg-4: var(--obs-fg-4);
  --color-obs-signal: var(--obs-signal); --color-obs-warn: var(--obs-warn); --color-obs-error: var(--obs-error);
  --font-obs-mono: var(--obs-mono);
}
```

Weitere Änderungen außerhalb von `obs.css`:
- `installer/index.html`: Inline-Hintergrund `#0A0B0D`.
- `tauri.conf.json`: `"backgroundColor": "#0A0B0D"`. Das ist nur Konfiguration; der Selbsttest ist nicht betroffen.

### B.3 Typografie

**Schriften:**
- **Inter Variable** mit Optik-Achse über `@fontsource-variable/inter/opsz.css`. Die Datei ist in 5.3.0 vorhanden. Gilt für den ganzen UI-Text, `font-optical-sizing: auto`.
- **IBM Plex Mono** über das neue Paket `@fontsource/ibm-plex-mono@^5.3.0`, importiert werden nur `latin-400.css` und `latin-500.css` (woff2 zusammen 29,6 KB). Plex Mono wird nur für Messwerte, Beschriftungen, Koordinaten und den Pfad verwendet.
  - Begründung: technische Konstruktion, klar getrennte 0/O und 1/l. JetBrains Mono würde nach Code-Editor aussehen, und Cascadia Code ist nicht überall installiert.
- **Sora entfällt im Installer:** Import und Abhängigkeit werden entfernt. Die App behält Sora.

| Rolle | Schrift | Größe / Zeile | Gewicht | Laufweite | Schreibung |
|---|---|---|---|---|---|
| Wortmarke „PULSAR“ (Titelleiste) | Inter | 12/16 | 600 | 0,32em | Text „PULSAR“ (wörtlich, DOM) |
| H1 Seite | Inter | 28/32 | 600 | −0,02em | Satz |
| H1 Installation / Entfernen | Inter | 22/28 | 600 | −0,015em | Satz |
| Intro „Signal erfasst.“ | Inter | 28/32 | 600 | −0,02em | Satz |
| Fließtext | Inter | 14/21 | 400 | 0 | Satz, max. 472 px |
| Zeilentitel (Option, Feature) | Inter | 13/18 bzw. 14/20 | 600 | 0 | Satz |
| Kleindruck, Lizenz, Tipps | Inter | 11/16 bzw. 12/18 | 400 | 0 | Satz |
| Knopf | Inter | 13/16 (lg 14/16) | 600 | 0,01em | Satz, **nie** `text-transform` |
| Label / Beschriftung | Plex Mono | 10/14 | 500 | 0,08em | VERSAL per CSS (nie auf Knöpfen) |
| Messwert XL (Prozent) | Plex Mono | 44/44 | 400 | −0,01em | `tabular-nums` |
| Messwert L (Periode) | Plex Mono | 22/26 | 400 | 0 | – |
| Messwert M (Frequenz, Countdown) | Plex Mono | 15/20 | 400 | 0 | – |
| Messwert S (Empfangen, Rate) | Plex Mono | 13/20 | 400 | 0 | – |
| Pfad im Eingabefeld | Plex Mono | 13/16 | 400 | 0 | – |
| Einheit | Plex Mono | wie Wert −2 px | 400 | 0,04em | wie gesetzt (`ms`, `Hz`, `MB/s`) |

**Zahlenformat:**
- de mit Komma, en mit Punkt.
- Zwischen Zahl und Einheit steht **U+00A0** (NBSP). U+202F und U+2009 fehlen in Plex Mono latin und dürfen nicht verwendet werden.
- Koordinaten-Sekunden haben in beiden Sprachen einen Punkt (astronomische Konvention).

### B.4 Glyphen-Regel (geprüft am latin-Subset von Plex Mono 5.3.0)

- **Vorhanden:** `× ° µ · ± − (U+2212) ′ ″ … – — „ “ ” ’ • ↑ ↓ €` und U+00A0.
- **Fehlen:** `→ ← ▲ ▼ ▸ ■ □ │ ⏎ ↵ ✓ ✕ ⚠ Σ Ω μ ʰ ᵐ ˢ` sowie U+202F und U+2009.

Daraus folgt:
1. Alle Marken (Dreiecke, Pfeile, Quadrate, Haken, Kreuze) sind **SVG** (Komponente `Glyph`) oder lucide-Icons.
2. „Σ“ wird in Inter gesetzt. Das greek-Subset lädt per `unicode-range`.
3. Koordinaten stehen als ASCII-`h m s` mit `° ′ ″`, südliche Deklination mit U+2212.

### B.5 Raster, Haarlinien, Skalen

**Grundraster 20 px.** Feste Kanten:

| Element | Lage |
|---|---|
| Titelleiste | y 0–40, Haarlinie `rule` bei y 40 |
| Statusleiste | y 600–640, Haarlinie bei y 600 |
| Trennlinie Schirm \| Bedienfeld | x 420 (`rule`), y 40–600 |
| Schirm-Inhalt | x 24–396 |
| Bedienfeld-Inhalt | x 468–940 |
| Fußleiste | Haarlinie bei y 536, Knöpfe y 548–588 |

**Haarlinien** sind 1 CSS-px, auf das Pixelraster ausgerichtet (+0,5). Statische Linien liegen als SVG mit `shape-rendering: crispEdges` vor oder werden einmal in einen Offscreen-Canvas gezeichnet.

**Gratikül** (nur im Schirm-Canvas):
- 10 × 8 Teilungen (38 × 40 px), Linien in `--obs-grid`.
- Mittelachsen in `--obs-grid-axis` mit Kleinteilung alle 7,6 px bzw. 8 px, Strich 4 px.
- Rahmen 1 px `rule-strong`.
- Das Bedienfeld hat **kein** Raster, nur waagerechte Haarlinien zwischen Blöcken.

**Skalen allgemein:**
- Grundlinie 1 px `rule-strong`.
- Hauptstrich 8 px, Zwischenstrich 4 px, bei Log-Skalen der „5er“ 6 px. Striche in `fg-3`, Zwischenstriche mit 60 % Deckkraft.
- Beschriftung Mono 10 in `fg-3`, 4 px vom Strich.
- Marke = SVG-Dreieck 7 × 5 px in `--obs-signal`, dazu 1 px Linie zur Grundlinie.
- Füllwert = **2 px** gelbe Linie *auf* der Grundlinie, kein Balken.
- Schraffur = SVG-`<pattern>` mit 45°-Linien (1 px `fg-4`, Abstand 4 px). Kein CSS-Verlauf.

### B.6 Koordinaten und Katalog (wörtlich)

| id | Bezeichnung | P | f | Text in der Statusleiste (nach `ZIEL `) |
|---|---|---|---|---|
| `b1919` | PSR B1919+21 (CP 1919) | 1,3373 s | 0,748 Hz | `PSR B1919+21 · RA 19h21m44.8s · DEC +21°53′02″ · J2000` |
| `vela` | PSR B0833−45 (Vela) | 89,33 ms | 11,19 Hz | `PSR B0833−45 · RA 08h35m20.6s · DEC −45°10′35″ · J2000` |
| `crab` | PSR B0531+21 (Krebsnebel / Crab) | 33,7 ms | 29,67 Hz | `PSR B0531+21 · RA 05h34m31.9s · DEC +22°00′52″ · J2000` |
| `j0437` | PSR J0437−4715 | 5,757 ms | 173,70 Hz (≈ F3 −9 ct) | `PSR J0437−4715 · RA 04h37m15.9s · DEC −47°15′09″ · J2000` |

Hinweise zum Katalog:
- Die Crab-Rektaszension liegt je nach Quelle bei 31.94 s (VLBI) oder 31.97 s (Timing). Angezeigt wird 31.9 s. Vor dem Einbau ist sie gegen ATNF und SIMBAD zu prüfen.
- Die Crab-Periode ist der heutige Näherungswert laut Auftrag.

**Himmelskarte (nur im Intro).** Tangentialebene um CP 1919, Mittelpunkt bei Fensterpunkt (490, 250).
- Maßstab **1′ = 100 px** in beiden Richtungen, also unverzerrt.
- 1 s Rektaszension = 15″ · cos(21,8839°) = 13,919″ = **23,198 px**. RA steigt nach links.

| Element | Lage | Beschriftung (Mono 10, `fg-3`) |
|---|---|---|
| Senkrechte Linien | x 137,4 / 253,4 / 369,4 / 485,4 / 601,4 / 717,3 / 833,3 | y 46, 4 px rechts der Linie: `19h22m00s`, `21m55s`, `21m50s`, `21m45s`, `21m40s`, `21m35s`, `21m30s` |
| Waagerechte Linien | y 153,3 / 253,3 / 353,3 / 453,3 / 553,3 | x 24, 4 px über der Linie: `+21°54′`, `+21°53′`, `+21°52′`, `+21°51′`, `+21°50′` |
| Maßstabsbalken | x 24–124 bei y 576, Endstriche 4 px | `1′` |

### B.7 Bedienelemente (ohne Glas)

Allgemein: Radius **2 px**, Panels 0 px. Kein Ripple, kein Glühen, kein Federn, kein Skalieren. Farbübergänge 120 ms `cubic-bezier(.2,0,0,1)`.

| Element | Spezifikation |
|---|---|
| **Primär** | h 40 (lg 44, sm 32), px 20 (sm 12). Fläche `--obs-fg`, Text `--obs-bg`. Hover `#FFFFFF`, gedrückt `translateY(1px)`, deaktiviert Deckkraft 0,38. Icon lucide 16 px, Strich 1,5. Fokus-Offset 3 px. |
| **Sekundär** | transparent, 1 px `--obs-control`, Text `fg`. Hover: Rand `fg-2`, Fläche `raise`. |
| **Ghost** | Text `fg-2`. Hover: `fg` mit 1 px Unterstreichung (Abstand 3 px). |
| **Gefahr (Rand)** | 1 px `error`, Text `error`, Hover Fläche `rgb(255 90 100 / .08)` |
| **Gefahr voll** | Fläche `error`, Text `#0A0B0D`, Hover `#FF7078` (nur „Deinstallieren“ bestätigen) |
| **Klänge** | Hover → `sound.play("hover")`, Klick → `sound.play("click")`, außer bei `silent` |
| **Schalter** | Gehäuse 36 × 18, 1 px `control`. Knopf 12 × 12, Radius 1, Einzug 2. AUS: links in `fg-3`. EIN: rechts in `signal`, Fläche `signal-dim`, Rand `signal`. Daneben `AN`/`AUS` (Mono 10, `aria-hidden`). 120 ms, bei reduzierter Bewegung sofort. |
| **Optionszeile** | Ganze Breite, 64 px, Haarlinie unten. Inhalt: Index `01` (Mono 11, `fg-3`), Titel 14/600, Beschreibung 13 `fg-2`, Schalter rechts. **Die Zeile selbst** ist `role="switch"` + `aria-checked`; Leertaste und Enter schalten. Innen gibt es kein zweites Bedienelement. Hover: Fläche `raise`. Klang `toggleOn`/`toggleOff`. |
| **Kontrollkästchen** | 16 × 16, 1 px `control`. Angehakt: Fläche `signal`, SVG-Haken 1,75 px in `signal-ink`, gezeichnet in 120 ms (`pathLength`). |
| **Eingabefeld (Pfad)** | h 40, ganze Breite 472, Fläche `panel`, 1 px `control`, Plex Mono 13, Innenabstand 12. Fokus: Rand `signal` + `box-shadow: inset 0 0 0 1px var(--obs-signal)`, kein Halo. Darüber das Label `ZIELORDNER`. |
| **Hinweis (Notice)** | Links 2 px Balken in Ton-Farbe, Fläche Ton-Farbe 6 %. Symbol 16 px (lucide `AlertTriangle` / `OctagonX` / `Info`), Wort `HINWEIS` / `FEHLER` (Mono 10, Ton-Farbe), Titel 13/600 `fg`, Text 13/20 `fg-2`. Kein Ring, kein Radius. |
| **Dialog** | Overlay `rgb(10 11 13 / .82)` **ohne** Unschärfe. Kasten 420 breit, `panel`, 1 px `rule-strong`, Padding 24. Fokusfalle, Esc = Abbrechen des Dialogs. |
| **Tag** | Mono 10/14, 500, VERSAL, Padding 1/5, 1 px `rule-strong`, Radius 2, Farbe `fg-3` (`INSZENIERT`, `GEMESSEN`, `SIMULIERT`) |

### B.8 Bewegung

**Seitenwechsel im Bedienfeld:**
- Die Blöcke kommen **gestaffelt im Abstand von 24 ms von oben nach unten**, als sichtbares Gegenstück zum Dispersions-Zwitschern (hoch zuerst, tief zuletzt).
- Pro Block: Deckkraft 0→1 und y 6→0 in 180 ms `cubic-bezier(.2,0,0,1)`. Ausblenden: Deckkraft in 120 ms.
- `AnimatePresence mode="wait"`. **Kein** `filter: blur`, **kein** `layoutId`.
- Der Schirm bleibt beim Seitenwechsel bestehen (er liegt außerhalb von `AnimatePresence`).

**Reduzierte Bewegung:** nur Deckkraft, 120 ms, ohne Staffelung.

---

## C. Bildschirme bei 980 × 640

Symbole in den Skizzen (◆ Zeichen, ◖ Lautsprecher, ▲ ▼ → ✓ ✕ ▨) sind SVG und nie Schriftzeichen. Maßstab: 1 Zeichen ≈ 10 px.

### C.0 Gemeinsamer Rahmen

```
  0 ┌─────────────────────────────────────────┬─────────────────────────────────────────────────────┐
    │ ◆ PULSAR  SETUP                                                DE|EN    ◖ TON AN    —     ✕  │ 0–40
 40 ├─────────────────────────────────────────┼─────────────────────────────────────────────────────┤
    │ SCHIRM (bleibt beim Seitenwechsel)       │ BEDIENFELD                                           │
    │ x 0–420, Inhalt 24–396                   │ x 421–980, Inhalt 468–940                            │
536 │                                          ├─────────────────────────────────────────────────────┤
548 │                                          │ links: Zurück / Status          rechts: Primärknopf  │
600 ├─────────────────────────────────────────┴─────────────────────────────────────────────────────┤
    │ ZIEL PSR B1919+21 · RA 19h21m44.8s · DEC +21°53′02″ · J2000                      SETUP 1.0.0 │ 600–640
640 └───────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Titelleiste** (`data-tauri-drag-region`), immer sichtbar, auch im Intro:
- x 16: PulsarMark `solid` 18 px (`aria-hidden`).
- x 42: Text **„PULSAR“** (die E2E prüft ihn nach 1,2 s).
- x 140: `SETUP` (Mono 10, `fg-3`).
- Rechts: `LangSwitch` (zwei Knöpfe 32 × 40, `aria-pressed`, Gruppe `aria-label="Sprache"`), `SoundSwitch`, `WindowControls maximizable={false}`.

**SoundSwitch:** `role="switch"`, `aria-checked={!muted}`, zugänglicher Name aus dem Inhalt „Ton“. Er besteht aus Icon `Volume2`/`VolumeX` 14 px (`aria-hidden`), dem Wort `TON` und dem Zustandswort `AN`/`AUS` (`aria-hidden`, Mono 10).

**Statusleiste:**
- Links: `ZIEL ` + Koordinatenzeile der aktuellen Referenz (B.6), Mono 10, Label in `fg-3`, Wert in `fg-2`.
- Rechts: `SETUP {setupVersion}` sowie ` · UPDATE` / ` · DEINSTALLATION` / ` · WARTUNG`.

### C.1 Intro (ganze Fläche y 40–600, ohne Trennlinie)

```
 40 ├───────────────────────────────────────────────────────────────────────────────────────────────┤
 46 │           19h22m00s   21m55s      21m50s      21m45s      21m40s      21m35s      21m30s       │ RA-Labels
    │ ┄┄┄┄┄┄┄┄┄┄┄┄┊┄┄┄┄┄┄┄┄┄┄┄┊┄┄┄┄┄┄┄┄┄┄┄┊┄┄┄┄┄┄┄┄┄┄┄┊┄┄┄┄┄┄┄┄┄┄┄┊┄┄┄┄┄┄┄┄┄┄┄┊┄┄┄┄┄┄┄┄  (Karte 4,5 %)│
 88 │                     ┌──────────────────────────────────────────────────────┐                  │
 96 │ +21°54′             │ SIMULIERTES PROFIL                         ×1 ECHTZEIT │                  │
128 │                  01 │ ~~~~~~~~~~~~~~~~~~~~~~~~~~/\~~~~~~~~~~~~~~~~~~~~~~~~~~ │ Zeile k: 128+14(k−1)
    │                     │ ~~~~~~~~~~~~~~~~~~~~~~~~_/  \_/\~~~~~~~~~~~~~~~~~~~~~~ │                  │
    │                  04 │ ~~~~~~~~~~~~~~~~~~~~~~~/\_/\  \~~~~~~~~~~~~~~~~~~~~~~~ │ ältere fg-2      │
    │ +21°53′          08 │ ━━━━━━━━━━━━━━━━━━━━━━/    \━━━━━━━━━━━━━━━━━━━━━━━━━ │ aktuell gelb     │
    │                  12 │ ░░░░░░░░░░ (noch Rauschen, flimmert 12 fps) ░░░░░░░░░ │                  │
338 │                  16 │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │                  │
378 │                   Σ │ ______________________/\______________________   07 │ Σ = Mittel, gelb │
386 │                     │ ┴─────────┴─────────┴────────┴─────────┴──────────┴  │                  │
396 │                     │ −80       −40        0       +40       +80 ms PULSPHASE│                  │
412 │ +21°52′             └──────────────────────────────────────────────────────┘                  │
428 │          PSR B1919+21 · CP 1919 · ENTDECKT 1967 VON JOCELYN BELL BURNELL UND ANTONY HEWISH      │
452 │                   FALTFREQUENZ                      EINGERASTET f 0,7478 Hz · P 1,3373 s        │
466 │                                         ▼                                                     │
484 │                   ├┴┴┴┼┴┴┴┼┴┴┴┼┴┴┴┼┴┴┴┼┴┴┴┼┴┴┴┼┴┴┴┼┴┴┴┼┴┴┴┼┴┴┴┼┴┴┴┼┴┴┴┼┴┴┴┼┴┴┴┼┴┴┴┤          │
490 │                   0,25             0,5            1              2              4 Hz          │
548 │                                                               KLICK ODER TASTE  [Überspringen]│
576 │ ├────1′───┤                                                                                     │
600 ├───────────────────────────────────────────────────────────────────────────────────────────────┤
```

**Maße:**

| Element | Lage |
|---|---|
| Panel | x 210–770, y 88–412, deckend `--obs-bg`, 1 px `rule-strong` |
| Plotfeld | x 250–730 (−80…+80 ms, 3 px/ms) |
| Zeilenlabels 01/04/08/12/16 | x 222 |
| „Σ“ | Inter 11/600 bei x 222; Zähler `07` (Mono 10, `fg-3`) bei x 736 |
| Tuner | log2 von 0,25–4 Hz auf x 200–780 (145 px pro Oktave); Hauptstriche bei 0,25/0,5/1/2/4; Zwischenstriche alle ¼ Oktave |
| Tuner-Nadel | `fg-2` beim Suchen, `signal` eingerastet |
| Tuner-Ablesung | rechtsbündig x 780: `SUCHE f 0,412 Hz · P 2,427 s` (20 Hz aktualisiert) bzw. `EINGERASTET f 0,7478 Hz · P 1,3373 s` (gelb) |

**Endzustand** (D.2 ab 4500 ms):
- Panel, Achsen und Tuner sind ausgeblendet.
- PulsarMark `rays`, 200 px, bei (490, 250), also genau auf der Position von CP 1919 in der Karte.
- „Signal erfasst.“ bei y 372–404 (Inter 28/32, mittig).
- Objektzeile bei y 428.
- `GEFALTET AUS 16 ROTATIONEN · P 1,3373 s · SIMULIERTES PROFIL` bei y 448 (Mono 10, `fg-3`).
- „Überspringen“ wird ab dem Endzustand ausgeblendet.

### C.2 Schirm (links, für alle Seiten außer dem Intro)

```
 52   BLICK VON DER ERDE                          SCHEMA · NICHT MASSSTÄBLICH
 72  ┌──────────────────────────────────────────────┐  Canvas x 20–400, y 72–392 (380×320)
 84  │ [Zustands-Tag]          ┊                    │  Sternmitte (210, 232), R★ 58 px
     │                         ┊        ╱ Strahl    │
     │              ╭──────────┊────╮ ╱  (Kegel 9°) │
     │ ┄┄┄┄┄┄┄┄┄┄┄┄┄│ Kappe ●  ┊    │┄┄┄┄┄┄┄┄┄┄┄┄┄ │  Gratikül 10×8
     │              ╰──────────┊────╯               │
     │        ╱ Feldlinien (Dipol, grau)            │
372  │ BELICHTUNG 1/60 s       ┊                    │
392  └──────────────────────────────────────────────┘
408   PERIODE                 FREQUENZ               [INSZENIERT]
422   1,3373 s                0,748 Hz
456   HÖRBAR ALS · EINZELKLICKS
482   TON       J0437       KREBS VELA                B1919
498   ▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨┊            ┊    ┊            ▼  ┊
510   ├┴┴┴┴┴┴┴┴┼┴┴┴┴┴┴┴┴┼┴┴┴┴┴┴┴┴┼┴┴┴┴┴┴┴┴┼┴┴┴┴┴┴┴┴┤
522   1 ms      10 ms     100 ms    1 s       10 s
560   REF PSR B1919+21 · ERSTER PULSAR (1967)       DREHZAHL = FORTSCHRITT
```

**Log-Skala** (x 24–396, 4 Dekaden):
- x(P) = 24 + 93·log10(P / 1 ms).
- Katalogmarken: J0437 bei x 94,7, Krebs 166,1, Vela 205,4, B1919 314,7. Strich 10 px in `fg-3`, die nächstliegende Referenz in `fg`.
- Tonbereich P < 50 ms (f > 20 Hz): Schraffur y 502–508 von x 24 bis 182, Label `TON` bei x 24.
- Nadel: gelbes Dreieck mit Linie bei der aktuellen Periode.

**Messwerte:**
- PERIODE (Mono 22) bei x 24, FREQUENZ (Mono 15) bei x 196, Tag `INSZENIERT` rechtsbündig bei x 396.
- `data-testid="obs-period"` mit `data-value` in Sekunden.

**Zustands-Tag oben links im Canvas** (Mono 10):

| Zustand | Tag |
|---|---|
| Fehler | `KEIN SIGNAL · NETWORK` (Code in VERSAL, `error`) |
| Abgebrochen | `EMPFANG ANGEHALTEN` (`fg-2`) |
| Fortsetzen | `RASTET EIN …` (`signal`) |
| nach der Deinstallation | `SIGNAL VERLOREN` (`fg-2`) |

**Kamera-Label unten links** (`fg-3`): `BELICHTUNG 1/60 s` / `BELICHTUNG 0,12 s` / `BELICHTUNG 2 · P` / `STROBO 173,7 Hz · PHASE 180°` / `STANDBILD` (bei reduzierter Bewegung).

**Zeile „Hörbar als“:** `HÖRBAR ALS · {EINZELKLICKS|KNATTERN|SCHNARREN|TON|AKKORD}`. Ohne Stimme steht dort `LEERLAUF · LAUTLOS` bzw. `LAUTLOS`. Bei Ton aus wird ` · TON AUS` angehängt.

**Rechte Seite der Referenzzeile:** `LEERLAUF` / `DREHZAHL = FORTSCHRITT` / `DREHZAHL SINKT MIT DEM FORTSCHRITT` / `INSTALLIERT` / `SIGNAL VERLOREN`.

**Schirm je Schritt:**

| Schritt | Stern | Ton |
|---|---|---|
| welcome / folder / options | Leerlauf, dreht mit 1,3373 s, scharfe Strahlen, Lichtscheibe blitzt 0,748-mal pro Sekunde, Referenz B1919 | lautlos |
| maintenance / un-confirm | „installiert“: statisches SVG-Zeichen `rays` 220 px bei (210, 232), Werte J0437, rechts `INSTALLIERT` | lautlos |
| install | folgt dem Fortschritt (F) | Stimme |
| done | Stroboskop rastet ein, dann Wandlung zum Zeichen (G.1) | Akkord |
| un-run | Zeichen → Stern, Stroboskop löst sich, Stern wird langsamer | Stimme rückwärts |
| un-done | Zerfall per Bayer-Dither ins Rauschen | 3 Pulse, Lücke, Rauschen |

### C.3 Bedienfeld: Willkommen

```
 56   01            02            03            04            05
 76   ┼─────────────┼─────────────┼─────────────┼─────────────┼        Ticks x 468+118·i
 84   ▲ (gelb)
 90   WILLKOMMEN    SPEICHERORT   OPTIONEN    INSTALLATION    FERTIG
120   PULSAR 1.0.0 · GAME BOOSTER FÜR WINDOWS                          Mono 10 fg-3
136   Willkommen bei PULSAR                                            H1 28/32
184   Pulsar misst deine Verbindung live, macht deinen PC mit einem    14/21 fg-2
      Klick bereit zum Spielen … (welcome.text, ≤ 5 Zeilen)
300   ──────────────────────────────────────────────────────────────
      01  Live-Ping mit Note                                           13/600
          A+ bis F – zu echten Spielservern                            12/18 fg-2
352   ──────────────────────────────────────────────────────────────
      02  Boost per Klick  ·  Energieplan, Priorität, DNS – mit Rückgängig
404   ──────────────────────────────────────────────────────────────
      03  Netzwerk-Werkzeuge  ·  Route, DNS-Vergleich, Speedtest, WLAN
472   VERSION 1.0.0 · DOWNLOAD: 11,3 MB · SHA-256 HINTERLEGT           Mono 10
536   ──────────────────────────────────────────────────────────────
548   Mit der Installation stimmst du zu, …      [ Los geht's  → ]     Lizenz 11/16 fg-3, max 300 px
```

**Schrittskala:**
- Ziffern y 56 (aktuell `fg`, sonst `fg-3`).
- Grundlinie y 76: von 468 bis zum aktuellen Tick in `fg-2`, danach `rule-strong`.
- Caret gelb bei y 82–87.
- Namen y 90: aktuell `fg`, erledigt `fg-2`, offen `fg-3`. Der erste Name linksbündig, der letzte rechtsbündig, die übrigen mittig unter dem Tick.

**Manifest-Zeile:**
- Lädt noch: `VERSION — · DOWNLOAD —` in `fg-3`, ohne Skeleton.
- Fehler: Notice `warn`, `role="status"`, mit `welcome.manifestError`.
- `SHA-256 HINTERLEGT` erscheint nur, wenn `manifest.app.sha256` gesetzt ist.

### C.4 Speicherort

| y | Inhalt |
|---|---|
| 136 / 184 | H1 „Wohin soll Pulsar?“, darunter `folder.text` |
| 224 / 240–280 | Label `ZIELORDNER`, Eingabefeld (ganze Breite) |
| 292–324 | rechtsbündig: [Vorschlag] (Ghost sm, nur wenn ≠ `defaultDir`) [Ändern] (Sekundär sm) |
| 352 | `LAUFWERK C:\` |
| 368–378 | Balken 472 × 10: belegt = Schraffur, Bedarf = gelb (≥ 3 px), frei = leer mit 1 px `rule-strong` |
| 378–402 | Striche und Labels in 1-2-5-Schritten (`formatBytes`) |
| 418 | `BENÖTIGT 13,0 MB · FREI 169,9 GB · GESAMT 476,8 GB` (Mono 13, Label in `fg-3`) |
| 448–512 | Notice: `needsAdmin` → warn, `role="status"`; ungültig oder zu wenig Platz → error, `role="alert"` (bisherige Logik) |
| Fuß | [← Zurück] (Ghost), [Weiter →] (Primär, deaktiviert wenn `!requiredOk \|\| !dir.trim()`) |

### C.5 Optionen

- H1 „Fast geschafft“ bei y 136, Text bei y 184.
- Vier Optionszeilen y 224–480 mit Haarlinien bei 224, 288, 352, 416 und 480. Indizes 01–04, Texte aus `options.*`.
- Fuß: [← Zurück], [↓ Installieren] (Icon `Download`).

### C.6 Installation

**Normalfall:**

```
124   Pulsar wird installiert                         H1 22/28 (Update: „Update auf Version 1.0.0“)
168   ÜBERTRAGUNG  [GEMESSEN]
188   43,0 %                  EMPFANGEN   4,9 / 11,3 MB     Prozent Mono 44; rechts Label x 700, Wert x 790
                              RATE        4,4 MB/s          (Mono 13), Zeilen y 190/210/230
                              REST        2 Sek.
252   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────────────────────────────    2 px gelb auf der Grundlinie
      ┴────┴────┴────┴────┴────┴────┴────┴────┴────┴    Haupt 10 %, Zwischen 2 %
262   0               25               50               75          100
290   PHASEN
308   01  Verbinden                                      OK · 0,4 s     26 px Zeilen
    ▌ 02  Herunterladen                                  ▶ 43 %         aktiv: 2 px gelber Balken bei x 452
      03  Sicherheit prüfen (SHA-256)                    —
      04  Installieren                                   —
      05  Verknüpfungen anlegen                          —
464   06  In Windows eintragen                           —
480   NOTIZ  Strg + B startet den Boost – auch mitten im Spiel.   Tipp alle 8 s (Deckkraft 200 ms)
536   ──────────────────────────────────────────────────────────────
548   PHASE 2/6 · HERUNTERLADEN                              [ Abbrechen ]   Status Mono 10 fg-2
```

**Prozentwert:**
- `data-testid="obs-percent"` mit `data-value` = rohe Prozentzahl.
- Außerhalb des Downloads stehen RATE und REST auf „—“. Bei eta = 0 im Download steht `install.calculating`.
- Der Prozentwert hat eine Nachkommastelle.

**Phasenstatus:**
- erledigt: `OK · {Dauer}`. Die Dauer ist **im Client gemessen**: Zeit zwischen den Phasenwechseln.
- aktiv: SVG-Dreieck + `43 %` beim Download (gelb), sonst `LÄUFT`.
- offen: `—` in `fg-3`.

**Fehler** (`error.code ≠ cancelled`):
- Überschrift der Gruppe: `ÜBERTRAGUNG · ZULETZT GEMESSEN`. Die Werte sind in `fg-3` eingefroren, RATE und REST stehen auf „—“.
- Die Phasenliste schrumpft auf die abgebrochene Zeile mit Status `ABBRUCH` (`error`).
- Darunter Notice `error`, `role="alert"`, bei y 344–520:
  - Titel `errors.{code}`
  - `error.message` in Mono 12, `break-words`, höchstens 3 Zeilen
  - bei `network` zusätzlich `errors.resumeHint`
  - Aktionen [↻ Erneut versuchen] (Primär; bei `running` heißt er „Pulsar schließen und weiter“) und [Zurück] (Ghost; nicht im Update-Modus; Ziel wie bisher Speicherort bei `disk`/`permission`, sonst Optionen)
- Die Fußleiste ist leer.

**Abgebrochen:** Notice `neutral` mit Titel `errors.cancelled`, Text `install.cancelledText` und den Aktionen [↻ Erneut versuchen] und [Schließen] (`api.quit`).

**Fortgesetzt:** Kommt nach „Erneut versuchen“ das erste `download`-Event mit `downloaded > 0`, ersetzt 8 s lang `FORTGESETZT BEI {formatBytes(downloaded)}` (Mono 10, `fg-2`) die NOTIZ-Zeile. Der Wert ist gemessen.

**Abbruch-Dialog:**
- Titel `install.cancelTitle`, Text `install.cancelConfirm`.
- Knöpfe [Weiter installieren] (Sekundär, `autoFocus`) und [Installation abbrechen] (Gefahr-Rand).
- Die Namen unterscheiden sich bewusst vom Fußknopf „Abbrechen“.

### C.7 Fertig

| y | Inhalt |
|---|---|
| 136 | H1 **„Signal steht.“** |
| 184 | `done.installed` („Pulsar 1.0.0 ist installiert. Viel Spaß beim Spielen.“) |
| 240 | `PRÜFSUMME SHA-256 GEPRÜFT [GEMESSEN]`. Bei `!done.verified` stattdessen Notice warn mit `done.unverified`. |
| 320 / 348–354 | `AUTOSTART IN 4 s` (Mono 15); 5 Segmente à 88 × 6 px, Abstand 8. Verbleibende Segmente `fg-2`, abgelaufene `rule-strong`, das laufende Segment schrumpft in 1 s linear. Ohne Ton. |
| Fuß | links [Nicht starten] (Sekundär, stoppt den Countdown) bzw. ohne `launchAfter` [Schließen]; rechts [Pulsar jetzt starten] (Primär, `autoFocus`) |

**Update-Modus:**
- Schrittskala mit 2 Stufen (`steps.install`, `steps.done`).
- Darüber `UPDATE · v0.9.0 → v1.0.0`, Pfeil als SVG.
- Fertig: H1 „Signal steht.“, Text `done.updated`, `NEUSTART IN 2,6 s` mit einem einzelnen Balken 472 × 6, der in 2,6 s abläuft. Keine Knöpfe.

### C.8 Wartung

- Statt der Schrittskala eine Kopfzeile `WARTUNG · INSTALLIERT v0.9.0` (Mono 10) mit Grundlinie bei y 76.
- H1 `maintenance.title` bei y 136, Text `maintenance.text` bei y 184.
- Zwei Knopfzeilen à 72 px, y 248–392, mit Haarlinien:
  - `A` Aktualisieren oder reparieren
  - `B` Deinstallieren (Index `B` in `error`)
  - Inhalt: Titel 14/600, Beschreibung 13 `fg-2`, rechts `ArrowRight` 16 px.
  - Hover: Fläche `raise` und 2 px Balken links (A in `fg-2`, B in `error`).

### C.9 Deinstallieren

**Bestätigen:**
- Schrittskala mit 3 Stufen (`steps.unConfirm`, `unRun`, `unDone`), aktuell Stufe 0.
- H1 `uninstall.title`, Text `uninstall.text` (4 Zeilen).
- Kontrollkästchen-Block bei y 300–356 (Haarlinie bei 288): `uninstall.keepData` und `keepDataDesc`.
- Fuß: [Abbrechen] (Ghost, `api.quit`), [🗑 Deinstallieren] (Gefahr voll).

**Lauf:**
- H1 22/28 `uninstall.running`.
- `SCHRITTE`: 5 Zeilen à 26 px (y 184–314) mit `OK` / ▶ / `—`. Die Zeile `data` hat bei `keepData` den Status `BEHALTEN` in `fg-3`; es gibt kein Durchstreichen.
- Prozentskala bei y 340.
- Bei `uninstall://error`: Notice error (`role="alert"`).
- Fuß: Statuszeile `SCHRITT 2/5 · VERKNÜPFUNGEN ENTFERNEN`.

**Fertig:**
- H1 **„Signal verloren.“**, Text `uninstall.doneText`.
- Bei `revertOk === false`: Notice warn, `role="alert"`, bei y 228–420 mit `revertFailed` (Titel), `revertFailedKept`/`revertFailedForced` (je nach `keepData`, wie bisher) und `revertFailedHow`. Der Fokus geht auf „Schließen“.
- Fuß: [Schließen] (Primär).

---

## D. Intro

### D.1 1,337 s gegen ein kurzes Intro

16 Zeilen in Echtzeit würden 21 s dauern. Die Lösung ist ehrlich:
- **Zwei Pulse kommen in Echtzeit, genau 1337,3 ms auseinander.** So ist der historische Takt einmal hörbar.
- Die übrigen 14 Zeilen kommen im gekennzeichneten **Zeitraffer** mit geometrisch fallenden Abständen d_i = 150·r^(i−1) ms, r = (1/3)^(1/13) = 0,918964 (150 → 50 ms, Summe 1284,0 ms). Das Label läuft von `×9 ZEITRAFFER` bis `×27 ZEITRAFFER`, denn Faktor = 1337,3/d_i, also 8,92 → 26,75. Der Zeitraffer kündigt hörbar das spätere Hochdrehen an.
- Die Summenkurve Σ unter dem Stapel zeigt live, wie das Rauschen um √k sinkt. Das ist echte Faltung.

**Gesamtdauer:** Die Willkommenseite steht nach **5650 ms**. Mit 1,5–3 s Kaltstart von WebView2 liegt der CI-Screenshot nach 9 s auf der Willkommenseite.

### D.2 Zeitachse der Vollfassung (`install` und `maintenance` ohne Preset)

t = erstes Bild nach dem Mount. Bild und Ton lesen dieselbe reine Tabelle `introEvents("full")` und `introStateAt(t)`.

| t (ms) | Bild | Ton |
|---|---|---|
| 0–300 | Karte, Panelrahmen und Achsen blenden ein (Deckkraft linear). 16 Rauschzeilen (σ 0,10, Deckkraft 0,35, `fg-3`) und Bildrauschen im Panel (4 Kacheln 128² mit Deckkraft 0,06, 12 fps, Seed fest). | Rauschbett −∞ → −34 dBFS RMS, Bandpass Q 4 auf fc(Nadel) |
| 300–1150 | **Regler sucht.** Nadel-Keyframes in Hz: 300: 0,40 → 560: 2,60 → 780: 0,52 → 940: 1,05 → 1060: 0,66 → 1150: **0,7478**, je Segment `cubic-bezier(.45,0,.2,1)` in log f, kein Überschwingen. Zeile 01 zeigt die Probefaltung: Rauschen + c(f)·Profil, c = exp(−(ln(f/f₀)/0,05)²). | Bandpass-Mitte fc = 300·8^(log(f/0,25)/log 16) Hz als `follow()`-Kurve (48 Punkte, dieselbe Funktion) |
| **1150** | **Einrasten:** Nadel und Ablesung werden gelb (`EINGERASTET …`), das Bildrauschen blendet in 300 ms aus. Zeile 01 wird zwischen 1070 und 1230 von links nach rechts geschrieben; der gelbe Schreibkopf (1 px) erreicht die Mitte genau bei 1150. | **Puls 1** (−14 dBFS) + Rastklick `tick` (−42). Rauschbett → −44 dBFS, Q 0,7, fc 1042,21 Hz in 200 ms. |
| 1230–2407 | Label `×1 ECHTZEIT`. Die Zeilen 02–16 flimmern weiter als Rauschen. | – |
| **2487,3** | Zeile 02, geschrieben 2407,3–2567,3, Peak bei 2487,3. Zeile 01 wird `fg-2`. | **Puls 2**, genau 1337,3 ms nach Puls 1 |
| 2637,3–3771,3 | Zeilen 03–16 an den Pulszeiten t₃ = 2637,3 … t₁₆ = 3771,3. Zeichendauer pro Zeile 160/Faktor ms. Label wie D.1. Σ und Zähler aktualisieren sich. | 14 Pulse mit −14 + 20·log10(a(1000/d)) dBFS: −16,2 → −21,0 dBFS |
| 3771–3900 | Halten | – |
| 3900–4500 | **Faltung** (D.4): Panelrahmen, Achsen, Labels, Tuner und Rauschzeilen blenden 3900–4100 aus. Die Zeilen werden zu 16 Haarstrahlen, Σ wird zum Ring, der Kern erscheint 4350–4500. | Rauschbett `stop({fadeS: 0.6})` |
| **4500** | Canvas → SVG-Zeichen mit identischer Geometrie (120 ms Überblendung). „**Signal erfasst.**“ (Deckkraft und y 6 → 0 in 240 ms, `role="status"`). Bei 4620 erscheint die Zeile `GEFALTET AUS …`. | **Schlusspuls:** `sound.pulse({timbre:"radio", gainDb:-18})` + Teiltöne 2 und 4 (347,40 / 694,81 Hz, −30/−32 dBFS, Anstieg 4 ms, τ 140 ms) |
| 4500–5300 | Halten (≥ 800 ms lesbar) | – |
| **5300** | **Ausgang:** Die Intro-Ebene blendet in 300 ms aus (Zeichen skaliert dabei auf 0,96). `flow.introFinished()` → `go(…)`; Schirm und Bedienfeld kommen gestaffelt. `body[data-intro-done="1"]`. | Sweep vorwärts kommt aus `go()` (E.7) |
| 5650 | Willkommen steht | – |

`data-testid="intro"` trägt `data-variant` und `data-phase`: `search` (< 1150), `realtime` (< 2637), `timelapse` (< 3900), `fold` (< 4500), `acquired` (< 5300), `exit`.

### D.3 Ridgeline-Modell (rein, Seed 1919, beschriftet „SIMULIERTES PROFIL“)

**Abtastung:** 161 Punkte, x_j = −80 + j ms. Plot-x = 250 + 3·j.

**Profil der Zeile k:**
- s_k(x) = A_k·[exp(−(x−c_k)²/18) + 0,7·exp(−(x−c_k−9)²/12,5)]
- A_k = 0,6 + 0,4·u_k
- c_k = −6 + ((k−1)·3,7 mod 12) ms (driftende Subpulse, stilisiert)
- normiert, sodass max s ≤ 1

**Rauschen:** y_k = s_k + n_k, mit n_k = Gaußrauschen σ 0,06, geglättet über 3 Punkte.

**Darstellung:**
- Pixelhöhe 34·y nach oben ab der Grundlinie 128 + 14(k−1).
- Gezeichnet wird von hinten (k = 1) nach vorn. Jede Zeile füllt ihr Polygon mit `--obs-bg` (Verdeckung) und wird dann gestrichelt: ältere Zeilen `fg-2` 1 px, die aktuelle `signal` 1,25 px.
- Σ_k(x) = (1/k)·Σ_{i≤k} y_i(x), Grundlinie y 378, Höhe 26·Σ, 1,5 px `signal`.

### D.4 Faltung zum Zeichen (genau festgelegt, kein freies Morphing)

**`MARK_GEOMETRY`** (exportiert aus `shared/ui/PulsarMark.tsx`, viewBox 512, Mitte 256):

| Größe | Wert |
|---|---|
| `RING_R` | 168 |
| `CORE_R` | 44 |
| `RAY_IN` | 56 |
| `RAY_OUT(k)` | 246 − 44·((k − 3,5)/3,5)², k = 0…7 |
| `RAY_SPREAD` | 1,6° |
| `BEAM_ANGLES` | [35°, 215°] (im Uhrzeigersinn ab senkrecht) |
| Ringstrich | `rays` max(8, 1,5·512/size), `solid` max(14, 1,5·512/size) |
| Strahlstrich | max(3,2, 512/size) |

Skalierung s = 200/512; Bildpunkt = C + s·(P − 256), mit C = (490, 250).

**Zeilen → Strahlen:**
- Zeile i (1…16) gehört zu Strahl b = 0 für i ≤ 8, sonst b = 1; k = (i−1) mod 8.
- Winkel θ = BEAM_ANGLES[b] + (k − 3,5)·1,6°, Richtung d = (sin θ, −cos θ).
- Punkt j: Ziel T = C + s·(RAY_IN + (j/160)·(RAY_OUT(k) − RAY_IN))·d.
- Der Startpunkt S ist der aktuelle Zeilenpunkt.
- P = S + e·(T − S) mit e = easeInOutCubic(clamp((t − 3900 − 10·(i−1))/450, 0, 1)).
- Farbe `fg-2` → `signal`, Breite 1 → Strahlstrich.

**Σ → Ring:**
- Punkt j: Ziel T = C + s·RING_R·(sin ψ_j, −cos ψ_j), ψ_j = 360°·j/160.
- e = easeInOutCubic(clamp((t − 3950)/550, 0, 1)).
- Farbe `signal` → `fg`, Breite 1,5 → Ringstrich.

**Kern:** Radius 0 → CORE_R·s, Deckkraft 0 → 1 bei 4350–4500, gelb.

### D.5 Kurzfassung (`update`, `uninstall`, Preset): 1350 ms

| t (ms) | Ereignis |
|---|---|
| 0–300 | Wie Vollfassung (Karte und Rauschen). Die Nadel gleitet gedämpft 50–300 von 0,5 auf 0,7478 Hz, ohne Suche. |
| 300 | Einrasten mit einem Puls (−14) und Rastklick. 16 statische Zeilen und das fertige Σ erscheinen. |
| 350–750 | Faltung wie D.4, zeitlich auf 400 ms gestaucht |
| 750 | Schlusspuls, „Signal erfasst.“ |
| 1050 | Ausgang (300 ms) |
| 1350 | Ende |

**Wahl der Variante:** Die ersten 250 ms sind in allen Varianten gleich. Bis dahin wird auf `setupInfo` gewartet, dann gilt:

| Bedingung | Variante |
|---|---|
| reduzierte Bewegung | `reduced` |
| `mode` ∈ {`update`, `uninstall`} oder `preset` gesetzt | `short` |
| sonst, oder keine Info nach 250 ms | `full` |

### D.6 Reduzierte Bewegung

| t (ms) | Ereignis |
|---|---|
| 0 | Statisches Bild: Karte, 16 fertige Zeilen, Σ, Nadel eingerastet. Kein Flimmern. |
| 300 | **Puls 1** (Ton bleibt; Hören ist keine Bewegung) |
| 900 | Überblendung (Deckkraft 200 ms) zu Zeichen + „Signal erfasst.“ |
| 1637,3 | **Puls 2 = Schlusspuls**, also zwei echte Pulse 1337,3 ms auseinander |
| 1800 | Ausgang (Deckkraft 200 ms) |
| 2000 | Ende |

Für Update, Deinstallation und Preset gilt: 0 statisches Endbild, 200 Puls, 800 Ausgang, 1000 Ende.

### D.7 Überspringen

- **Auslöser:** `pointerdown` auf der Intro-Fläche (nicht auf der Titelleiste) oder `keydown` mit Esc, Enter, Leertaste oder jeder druckbaren Taste.
- Ausgenommen sind Tab, reine Modifier und **M** (Ton).
- `preventDefault` verhindert, dass die Taste später einen Knopf auslöst.
- Tab fokussiert den sichtbaren Knopf „Überspringen“.

**Ablauf beim Überspringen:**
1. `score.cancel({fadeS: 0.04})`, das stoppt alle geplanten Quellen.
2. `noiseBed().stop({fadeS: 0.08})`.
3. Ein Quittungspuls (−24 dBFS).
4. Das Bild springt in 150 ms auf den Endzustand.
5. Nach 350 ms beginnt der Ausgang.
6. aria-live meldet `a11y.skipped`.
7. Nach dem Seitenwechsel geht der Fokus auf die H1 (`tabIndex=-1`, ohne sichtbaren Ring).

### D.8 Übergabe an den Ablauf

- Das Intro ruft beim Ausgang `flow.introFinished()` auf. Das ersetzt den bisherigen 3300-ms-Timer.
- `useSetupFlow` verknüpft das wie bisher mit `loaded` und ruft `next(si)` auf, dessen Logik unverändert bleibt:

| Modus | Ziel |
|---|---|
| `uninstall` | `un-confirm` |
| `update` | sofort `startInstall` (dir aus `installed`) |
| Preset | `startInstall(preset)` |
| `maintenance` | `maintenance` |
| sonst | `welcome` |

- Bei `startInstall` gibt es keinen Sweep; der erste Puls ist der Übergang.
- **Fehlt `setupInfo` beim Ausgang**, hält der Endzustand: alle 1337,3 ms ein Puls (−30 dBFS), und der Kern blinkt (Deckkraft 0,8 → 1, 80 ms), bis die Info da ist. Es gibt kein Timeout (`setup_info` ist lokal und schnell, wie heute).

---

## E. Klang-Engine „Pulsar-Sonifikation“

### E.1 Grundsätze

1. **Nur Web Audio**, keine Dateien, **kein AudioWorklet** (CSP-, Inline- und Async-Risiko). Der Hauptweg ist ein Lookahead-Scheduler.
2. **Ein Grundton:** F_STAR = 1/0,005757 = **173,7016 Hz**. Alles mit Tonhöhe ist n·F_STAR, n ≤ 18:

   | n | Hz |
   |---|---|
   | 1 | 173,70 |
   | 2 | 347,40 |
   | 3 | 521,10 |
   | 4 | 694,81 |
   | 5 | 868,51 |
   | 6 | 1042,21 |
   | 8 | 1389,61 |
   | 12 | 2084,42 |
   | 16 | 2779,23 |
   | 18 | 3126,63 |

3. **Keine Melodien:**
   - Tonhöhenänderungen gibt es nur als stetiges Gleiten (Sweep, Hochdrehen) oder als *gleichzeitiges* Einschwingen von Teiltönen.
   - Alle tonalen Sweeps **fallen**, wie Dispersion.
   - Keine Verstimmung, keine Subharmonische.
4. **Leise:** Der Installer setzt `setVolume(0.5)`, also Master −12 dB. Vor dem Master liegt jede Spitze ≤ −12 dBFS.
5. **Audio blockiert nie:** Jede Methode steckt in try/catch. Ohne Kontext gibt es stumme Objekte mit identischer API.

### E.2 Knotengraph

```
 PulseVoice(s) ─► voiceBus ─┐
 Einzelklänge (pulse/play) ─► uiBus ──┤        ┌─► send −18 dB ─► Convolver „Kuppel“ ─┐
 Rauschbett ─► bedBus ──────┼─► sum ◄─┴────────┘   (IR 0,8 s, selbst erzeugt)          │
 Akkord-Teiltöne ─► chordBus┘   │ ◄─────────────────────────────────────────────────────┘
                                ▼
                      HP 30 Hz (Q −3,01 dB)
                                ▼
                      master = muted ? 0 : v²   (setTargetAtTime τ 0,03 s)
                                ▼
                      Limiter: DynamicsCompressor threshold −3 dB, knee 0, ratio 20,
                               attack 1 ms, release 80 ms   ─►  destination
 Je Stimme: input ─► [BP body ∥ BP core ∥ BP gloss ∥ LP transient] ─► norm ─► Glätter LP c(f) ─► level ─► pan ─► voiceBus
           Klicks (BufferSource+Gain) ─► input          Tonschicht (Oscillator+PeriodicWave ─► Gain) ─► input
```

- **Hall:** nur für Akkord, Sweep, Schlusspuls und `notify`. Alles andere bleibt trocken.
- **Impulsantwort:** Stereo, 12 ms Vorverzögerung, Abklingen e^(−t/0,16 s), schon bei der Erzeugung gefiltert (HP 250 Hz, LP 5 kHz einpolig).
- **Filter-Konvention (Web-Audio-Spezifikation):**
  - Bandpass: Q linear, α = sin ω₀/(2Q).
  - **Tief- und Hochpass: Q in dB**, α = sin ω₀/(2·10^(Q/20)). Q = **−3,01 dB entspricht Butterworth.**

### E.3 Uhr und Synchronisation

- **Modellzeit** = `performance.now()/1000`. Sie ist der Takt-Master für Bild *und* Ton und springt nie.
- Audio wird abgebildet:

```ts
// shared/sound/clock.ts
ctxTimeFor(T) = T + offset
// offset aus getOutputTimestamp(): contextTime − performanceTime/1000
// (die Ausgabelatenz ist damit enthalten)
// Ersatz: currentTime − now − (outputLatency || baseLatency || 0)
// Glättung: EMA α 0,1 pro Scheduler-Takt, Änderung ≤ 0,5 ms pro Takt; Sprung > 50 ms → neu verankern
```

- **Wachhund:** 250 ms nach `ensure()` und danach jede Sekunde. `healthy` ist wahr, wenn `ctx.state === "running"` und `currentTime` um ≥ 0,1 s pro 0,25 s wächst. Ohne `healthy` wird nichts geplant. Das Bild läuft unverändert, weil es nie auf Audio wartet.
- **Bild:** Jedes Frame zeichnet `model.phaseAt(rafTime/1000 + 0,0167)`. Ein Klick, der für die Modellzeit T geplant ist, ist bei T hörbar, und der Strahl zeigt bei T zur Erde.
- **Phasengleichheit Klick ↔ Tonschicht per Konstruktion:**
  - Das `SpinModel` erzeugt eine stückweise lineare Frequenzkurve (Knoten alle 20 ms).
  - Die Tonschicht bekommt dieselben Knoten per `frequency.linearRampToValueAtTime`.
  - Sie startet mit `osc.start()` genau an einem Pulszeitpunkt (Kosinus-Phase 0 = Impuls).
  - Beide integrieren dieselbe Kurve.
  - Die einzige Restabweichung ist die Offset-Glättung (≤ 0,5 ms pro Takt); relevant ist sie nur in der Überblendung 24–48 Hz.

### E.4 Scheduler

- Ein gemeinsames `setInterval(tick, 25 ms)`, Lookahead **0,12 s**.
- Es läuft nur, solange aktive Stimmen oder Partituren existieren, und pausiert bei `document.hidden`.
- Stimmen blenden dabei in 300 ms auf 0. Beim Zurückkehren wird ab jetzt geplant; es gibt keinen Nachhol-Burst.

```ts
tick(now) {
  for (const v of voices) {
    if (!v.active || !clock.healthy || muted || document.hidden) { v.scheduledUntil = now; continue; }
    const horizon = now + 0.12;
    if (v.model) {
      v.model.advance(horizon + 0.02);
      for (const k of v.model.knotsSince(v.knotCursor)) v.tone?.ramp(k);       // Tonschicht + Gain
      for (const p of v.model.pulsesBetween(v.scheduledUntil, horizon)) v.click(p);   // nur f < 48 Hz
    } else for (const p of planPulses(v.plan, now, horizon)) v.click(p);      // eigener Takt (Hör dein Netz)
    v.scheduledUntil = horizon;
  }
  for (const s of scores) s.runDue(now + 0.12);        // Intro-Partitur
}
```

- **Klick:** `BufferSource(exc)` → `Gain` (a(f)·w_c(f)·Akzent) → Stimmeingang, `start(ctxTimeFor(t))`.
- Liegt die geplante Zeit früher als `currentTime + 5 ms`, wird auf diesen Wert geklemmt; ab mehr als 50 ms Verspätung wird der Klick verworfen.
- **Last:** unter 48 Hz höchstens 48 Klicks pro Sekunde; darüber ein einziger Oszillator.
- Im stummen Zustand werden keine Knoten erzeugt.

### E.5 Bausteine

**Anregung** (`dsp.makeExcitation(sr, noise, rng)`, 4 ms):
- e[0] = 1, danach Gaußrauschen σ = `noise` · e^(−n/(0,00035·sr)).
- Drei Varianten mit noise 0,30 / 0,15 / 0,05; `excA` = nur Impuls.
- **Rauschanteil nach Frequenz:** noise(f) = 0,30 für f ≤ 10 Hz, 0,05 für f ≥ 100 Hz, dazwischen log-interpoliert. Verwendet wird die nächstliegende Variante.

**Klangfarben** (Resonatoren je Stimme dauerhaft, parallel summiert):

| Timbre | Zweige | danach |
|---|---|---|
| `radio` (Standard) | BP 347,40 Hz Q 2,8 (−6 dB) · BP 1042,21 Hz Q 7 (0 dB) · BP 2084,42 Hz Q 9 (−10 dB) · LP 5000 Hz Q −3,01 (−16 dB) | Glätter LP c(f), Q −3,01 |
| `glass` | BP 2084,42 Q 9 (0 dB) · BP 2779,23 Q 12 (−4 dB) | LP 9000 Hz, Q −3,01 |
| `soft` | BP 347,40 Q 2,5 (0 dB) · BP 694,81 Q 4 (−8 dB) | LP 1200 Hz, Q −3,01 |

- **Glätter:** c(f) = 6000 Hz für f ≤ 20 Hz, 2200 Hz für f ≥ 174 Hz, dazwischen log-interpoliert. Er wird je Knoten nachgeführt.
- **Stufe** (`setStep`, für „Hör dein Netz“): Die Frequenz des Kern-BP wird F_STAR·[2, 3, 4, 6, 8, 12][stufe], Q 7. Stufe 0 klingt dunkel, Stufe 5 hell.
- **Normierung:** Beim `warmup()` simuliert reines TS-DSP (`dsp.renderResponse`, dieselben Biquad-Formeln wie in E.2) die Antwort auf `exc0.30`. Daraus folgt `norm = 1/Spitze`. Das läuft synchron, testbar und ohne `OfflineAudioContext`.
- **Einzelklang-Puffer** (synchron per TS-DSP vorgerendert, auf Spitze 1 normiert, ≤ 2048 Samples):
  - `hover`: `excA` → BP 2779,23 Q 12
  - `tick`: `excA` → BP 3126,63 Q 16
  - `click`: `exc0.30` → BP 1042,21 Q 6 + BP 347,40 Q 2,5 (−4 dB)
  - `pulse-radio`, `pulse-glass`, `pulse-soft`
  - `progress-q3`, `-q6`, `-q9`, `-q12`
- **Rauschbett:** 4 s rosa Rauschen (Paul-Kellet-Filter wie bisher, normiert auf RMS 0,25, Schleife mit zufälligem Start). Zweig 1: BP (Mitte und Q steuerbar), Anteil 0,7. Zweig 2: LP 900 Hz (Q −3,01), Anteil 0,3. Danach Pegel in dBFS RMS.

### E.6 Pegelgesetz, Rhythmus → Ton

**Pegel je Puls:**
- a(f) = **min(1, √(4/f))**. Oberhalb von 4 Hz bleibt die mittlere Leistung (f·a²) konstant; wahrgenommen gibt es keinen Lautheitssprung.
- Werte: a(11,19) = 0,598 (−4,5 dB), a(29,67) = 0,367, a(173,70) = 0,152 (−16,4 dB).

**Überblendung** (gleiche Leistung):
- x = clamp(log2(f/24), 0, 1); w_c = cos(πx/2), w_t = sin(πx/2).
- Unter 24 Hz klingen nur Klicks, über 48 Hz nur der Ton.

**Tonschicht:**
- `OscillatorNode` mit `PeriodicWave`: `real[n] = 1` für n = 1…256, `imag = 0`, **`disableNormalization: true`**.
- Gain g_t(f) = **2·a(f)·(f/sr)·k_e·w_t(f)**, mit k_e = √(Σ exc²) der verwendeten Anregung (≈ 1,31 bei noise 0,30). Er wird je Knoten mit `linearRamp` gesetzt.
- Die Formel ist nachgerechnet: Gegen den simulierten Klickzug bei 36 Hz weicht der RMS hinter den Resonatoren um +0,11 dB (1042 Hz), +0,57 dB (347 Hz) und −0,28 dB (2084 Hz) ab.
- Die Tonschicht läuft durch **dieselben** Resonatoren wie die Klicks, damit die Klangfarbe stetig bleibt.

**„Hörbar als“** (`heardAs(f)`):

| Bereich | Wort |
|---|---|
| f < 8 Hz | Einzelklicks |
| 8–20 Hz | Knattern |
| 20–40 Hz | Schnarren |
| ≥ 40 Hz | Ton |

**Gewöhnung** (nur Installation): 20 s ohne Phasenwechsel senken den Pegel in 3 s auf 0,40 (−8 dB). Ein Phasenwechsel hebt ihn in 0,5 s wieder auf 1.

### E.7 Dispersions-Sweep

Physik: Die Ankunftszeit hängt von der Frequenz ab, Δt ∝ f⁻²:

```
K = D / (f_lo⁻² − f_hi⁻²),    f(t) = (f_hi⁻² + t/K)^(−1/2),   0 ≤ t ≤ D
```

**Synthese:**
- Sinus-Oszillator mit `setValueCurveAtTime` (64 Punkte).
- Parallel Rauschen → BP Q 18 auf derselben Kurve (−6 dB relativ, bzw. Anteil laut `noiseShare`).
- Hüllkurve: Anstieg 2 ms, Pegel ∝ √(f/f_hi) als Kurve, Ausklang in den letzten 25 ms.
- Hall-Send −18 dB.
- `sweep()` wirft einen `RangeError`, wenn `fHi ≤ fLo`.

| Variante | f_hi → f_lo | D | K | Stichproben | Pegel |
|---|---|---|---|---|---|
| Seitenwechsel vorwärts (Installer) | 3200 → 400 Hz | 220 ms | 35 759 s·Hz² | t 5/20/50/100 ms → 2052/1234/818/588 Hz | −24 dBFS |
| Zurück und `un-run` (tiefer, kürzer, **fallend**) | 1800 → 300 Hz | 160 ms | 14 811 s·Hz² | t 20/80 ms → 776/419 Hz | −27 dBFS |
| `switch` (App) | 2400 → 700 Hz | 180 ms | – | t 90 ms → 950 Hz | −28 dBFS |
| `whoosh` | 3200 → 400 Hz | 320 ms | – | Rauschanteil 0,7 | −28 dBFS |
| `close` | 2084,42 → 694,81 Hz | 120 ms | – | – | −32 dBFS |

### E.8 Abschluss-Akkord (Obertöne, keine Melodie)

Ein periodischer Pulszug besteht spektral genau aus n·f₀. Der Akkord **ist** das Spektrum des Endtons:
- Teiltöne n ∈ {1, 2, 3, 4, 5, 6, 8}, also F3 F4 C5 F5 A5 C6 F6, F-Dur in reiner Stimmung.
- Ohne 7. Harmonische, ohne Verstimmung, ohne Subharmonische.
- Alle setzen **gleichzeitig** ein; nur die Anstiegszeit unterscheidet sich (spektrale Öffnung, kein Arpeggio).

| n | 1 | 2 | 3 | 4 | 5 | 6 | 8 |
|---|---|---|---|---|---|---|---|
| Hz | 173,70 | 347,40 | 521,10 | 694,81 | 868,51 | 1042,21 | 1389,61 |
| Spitze (dBFS) | −42 | −36 | −39 | −41 | −44 | −45 | −50 |
| Anstieg (ms) | 300 | 300 | 600 | 600 | 900 | 900 | 1200 |

- Umsetzung: Sinus je Teilton, `setTargetAtTime(Ziel, t, Anstieg/3)`. Bus: LP 3 kHz (Q −3,01), Hall −12 dB.
- Halten bis 2,4 s, dann Ausklang τ 0,7 s (unhörbar ab ≈ 5,6 s).
- Summe: RMS ≈ −35,2 dBFS, kohärente Spitze ≈ −24,6 dBFS. Der Endton liegt bei ≈ −40 dBFS RMS; der Akkord ist also etwa +5 dB lauter, ohne Sprung.

### E.9 Pegelübersicht (Ziel; wird im Klanglabor eingemessen)

| Klang | vor Master | Ausgang bei 0,5 |
|---|---|---|
| Puls-Klick B1919 (Installer-Stimme) | −14 dBFS Spitze | −26 |
| Endton 173,7 Hz | ≈ −40 dBFS RMS | ≈ −52 |
| Akkord | ≈ −35 RMS / −25 Spitze | −47 / −37 |
| Rauschbett Suche / unter Pulsen | −34 / −44 RMS | −46 / −56 |
| Klick-Puls (UI) / Hover / Tick | −22 / −34 / −30 | −34 / −46 / −42 |
| Sweep Seitenwechsel / Fehler (RFI) | −24 / −24 | −36 / −36 |

### E.10 Öffentliche API (`shared/sound/engine.ts`, Fassade)

```ts
export type SoundName = "startup" | "click" | "hover" | "switch" | "success" | "error" | "launch" | "achievement"
  | "toggleOn" | "toggleOff" | "open" | "close" | "tick" | "notify" | "whoosh" | "progress" | "jingle" | "farewell" | "dice"; // unverändert
export interface PlayOptions { value?: number; gain?: number; at?: number /* NEU: Modellzeit s; fehlt = sofort */ }
export const F_STAR: number;                       // 173.7016
export type Timbre = "radio" | "glass" | "soft";
export interface SweepOptions { fHi: number; fLo: number; durS: number; gainDb: number; noiseShare?: number; reverb?: boolean; at?: number }
export interface ChordOptions { partials?: number[]; levelsDb?: number[]; attacksS?: number[]; holdS?: number; releaseTauS?: number; gainDb?: number; reverb?: boolean; at?: number }
export interface ChordHandle { release(o?: { tauS?: number; at?: number }): void }
export interface NoiseBed {
  set(o: { levelDb: number; centerHz?: number; q?: number; glideS?: number; at?: number }): void;
  follow(centerHz: Float32Array, o: { at: number; durS: number }): void;   // Kurve für die Bandpass-Mitte
  stop(o?: { fadeS?: number }): void;
}
export interface ScoreEvent { at: number /* s relativ */; run: (atModel: number) => void }
export interface ScoreHandle { cancel(o?: { fadeS?: number }): void }  // stoppt alle in run() erzeugten Quellen
export interface AudioClock { now(): number; readonly healthy: boolean; ctxTimeFor(t: number): number | null; modelTimeFor(t: number): number | null }

export class SoundEngine {
  // bestehend, Signaturen unverändert
  get volume(): number; get muted(): boolean; get hoverEnabled(): boolean;
  setVolume(v: number): void; setMuted(m: boolean): void; setHoverEnabled(h: boolean): void;
  warmup(): void; play(name: SoundName, opts?: PlayOptions): void;
  // neu (rein additiv)
  readonly clock: AudioClock;
  get available(): boolean;
  onAvailabilityChange(cb: (available: boolean) => void): () => void;
  pulse(o?: { timbre?: Timbre; gainDb?: number; at?: number; pan?: number }): void;   // Einzelpuls (vorgerendert)
  createVoice(o?: PulseVoiceOptions): PulseVoice;      // höchstens 4; danach stumme Stimme + console.warn
  noiseBed(): NoiseBed;                                 // eine gemeinsame Instanz
  sweep(o: SweepOptions): void;
  chord(o?: ChordOptions): ChordHandle;                 // Standard = Abschluss-Akkord (E.8)
  alertTone(level: number, o?: { at?: number; whileHidden?: boolean }): void;  // „Einzelton“: 694,81 Hz + 1389,61 Hz (−12 dB), Anstieg 15 ms, τ 120 ms; Pegel = level × −20 dBFS; whileHidden = auch bei document.hidden (Warnton im Spiel)
  score(events: ScoreEvent[], t0Model: number): ScoreHandle;
}
export const sound: SoundEngine;
```

- Master: `muted ? 0 : v²`. Der bisherige Faktor 0,9 und der Kompressor entfallen; der Limiter dient nur der Sicherheit.
- Die Unlock-Hörer (`pointerdown`/`keydown`) bleiben. Der Kontext wird lazy in `ensure()` erzeugt, nie beim Import.

### E.11 PulseVoice (Installer und „Hör dein Netz“)

```ts
export interface PulseVoiceOptions {
  periodS?: number;        // 0.004 … 10, Standard 1.3373
  jitter?: number;         // 0..1: Versatz bis ±35 % der Periode (Dreiecksverteilung, begrenzt)
  dropout?: number;        // 0..1: Ausfallwahrscheinlichkeit pro Puls
  level?: number;          // 0..1 linear, Standard 1
  gainDb?: number;         // Grundpegel bei level 1, a=1; Standard −14
  timbre?: Timbre;         // Standard "radio"
  step?: number | null;    // 0..5 Resonanz-Stufe (E.5), null = Timbre-Standard
  tone?: boolean;          // Tonschicht über 24 Hz erlauben (Standard true)
  loudnessComp?: boolean;  // a(f) anwenden (Standard true)
  pan?: number; seed?: number;
}
export interface PulseEvent { atModel: number; index: number; dropped: boolean; level: number }
export interface PulseVoice {
  readonly active: boolean;            // erzeugt hörbare Knoten
  readonly periodS: number;
  start(o?: { atModel?: number; fadeS?: number }): void;   // fadeS ≤ 0.15
  stop(o?: { fadeS?: number }): void;                      // gibt die Knoten nach dem Ausblenden frei
  setPeriod(periodS: number, o?: { glideS?: number }): void;  // glide 0 = ab dem nächsten noch nicht geplanten Puls
  setJitter(j: number): void;
  setDropout(p: number, o?: { rampS?: number }): void;
  skipNext(): void;                    // nächster Puls fällt aus (Stille)
  accentNext(factor?: number): void;   // Standard 1.5, Pegel höchstens 1
  setLevel(level: number, o?: { rampS?: number }): void;   // rampS ≥ 0.02 erzwungen
  setStep(step: number | null): void;
  pulse(o?: { atModel?: number; level?: number }): void;   // Ereignis-Modus, unabhängig vom Takt
  follow(model: SpinModel | null): void;                    // Installer: rendert die Pulse des Modells
  onPulse(cb: (e: PulseEvent) => void): () => void;
  dispose(): void;
}
```

**Eigener Takt** (reine Funktion `planPulses`):
- Der Nennzeitpunkt t_{k+1} = t_k + P akkumuliert keinen Versatz.
- Ist-Zeit = Nenn + j·0,35·P·tri(rng).
- Geplant wird, sobald Nenn − 0,35·P den Horizont erreicht.
- `setPeriod` wirkt ab dem nächsten noch nicht geplanten Puls.

**Abbildung des Vertrags „Hör dein Netz“** (`docs/API.md`):

| Vertrag | Engine |
|---|---|
| Puls-Stimme, höchstens eine | `sound.createVoice({ timbre: "radio", tone: false, loudnessComp: false, gainDb: -20 })` |
| Periode 250–10 000 ms, ab nächstem Puls | `setPeriod(ms/1000)` |
| Zittern 0–1 (±35 %) | `setJitter(j)` |
| Aussetzer | `skipNext()` |
| Pegel 0–1, Rampe ≥ 20 ms; Betonen | `setLevel(l, { rampS: 0.03 })`, `accentNext(1.5)` |
| Tonhöhe/Stufe (optional) | `setStep(0…5)` = Harmonische von f★ |
| start/stop ≤ 150 ms, Knoten freigeben | `start({ fadeS: 0.1 })`, `stop({ fadeS: 0.1 })`, `dispose()` |
| Einzelton für den Warnton | `sound.alertTone(level, { whileHidden: true })` (auch wenn Pulsar im Hintergrund liegt) |
| globale Lautstärke, Stummschaltung, gemeinsamer Kontext, Autoplay | über den Master; vor dem Unlock ist `active = false` |

Zur Stufe: Die Klangwelt ist nicht mehr pentatonisch. Die Formulierung in `docs/API.md` wird beim Einbau auf „Stufen = Harmonische von 173,7 Hz“ angepasst; das stimmt Teil 2 ab.

### E.12 Alle SoundNames im neuen Vokabular

Alle Aufrufe in `app/src` bleiben gültig und kompilieren ohne Änderung. `recipes.ts` deklariert die Rezepte als Daten mit `satisfies Record<SoundName, Recipe>`.

| SoundName | Rezept | Spitze / Dauer |
|---|---|---|
| `hover` | Puffer `hover` (2779,23 Hz Q 12), ±1,5 dB zufällig, gesperrt 50 ms, aus bei `!hoverEnabled` | −34 · 10 ms |
| `click` | Puffer `click`; Zwischenpuls 13 ms später (Crab-Interpuls ≈ 0,40·33,7 ms) bei −34; gesperrt 30 ms | −22 · 30 ms |
| `tick` | Puffer `tick` (3126,63 Hz Q 16), gesperrt 18 ms | −30 · 10 ms |
| `switch` | Sweep 2400 → 700 Hz, 180 ms, gesperrt 60 ms | −28 |
| `whoosh` | Sweep 3200 → 400 Hz, 320 ms, Rauschanteil 0,7 | −28 |
| `open` | Puls `radio` −26 + Rauschstoß BP 1042,21 Hz, Q 6 → 1 in 140 ms (das Band öffnet sich, die Mitte bleibt fest) | −26 · 160 ms |
| `close` | Sweep 2084,42 → 694,81 Hz, 120 ms | −32 |
| `toggleOn` | Puls `glass` −24 + Zwischenpuls 13 ms bei −34 (hell) | −24 |
| `toggleOff` | einzelner Puls `soft` (dumpf). Der Unterschied liegt in der Klangfarbe, nicht in der Tonhöhe. | −26 |
| `success` | Puls `radio` −24, ab +30 ms gleichzeitig Teiltöne 2/3/4 (−34/−36/−38, Anstieg 120/200/280 ms, Halten 200 ms, τ 0,25 s) | ≈ 0,9 s |
| `error` | RFI: Sägezahn 50 Hz → BP 300 Hz Q 1,2 → LP 900 Hz (Q −3,01); Stöße 0–90 und 140–230 ms (Anstieg 6, Ausklang 25 ms); dazu Puls `soft` bei +180 ms (−28) | −24 · 260 ms |
| `notify` | zwei Pulse `radio` im Vela-Abstand 89,33 ms, Hall −18 dB | −24 |
| `progress` | Puls `radio`, Kern-Q aus `value` (Puffer q3/q6/q9/q12, nächster Wert). Das ist Klangfarbe, keine Tonleiter. Gesperrt 90 ms. | −28 |
| `startup` | Rauschbett 0–600 ms (−34 RMS, Suchfilter); bei 500 Rastklick (−40) und Puls (−20); Puls 2 bei **1837,3** (−20); Rauschen klingt aus bis 2,2 s | 2,2 s (App-Intro dauert 2,3 s) |
| `launch` | Hochdrehen mit temporärer Stimme: P 120 ms → 5,757 ms in 0,9 s, P(u) = P₀·(P₁/P₀)^(u^1,6); 250 ms Ton; ab 1,15 s gleichzeitig Teiltöne 1–4 (−30/−28/−31/−33, Anstieg 200 ms, Halten 600 ms, τ 0,4) | −22 · 2,4 s |
| `achievement` | Hochdrehen 500 ms (89,33 → 5,757 ms) + Akkord E.8 mit −3 dB, Halten 0,8 s, τ 0,7 | 3,3 s |
| `jingle` | Akkord E.8 allein (Halten 1,2 s) | 4 s |
| `farewell` | 6 Pulse `radio`, Abstände 89,3 · 130,4 · 190,4 · 278,0 · 405,9 ms; Puls 4 und 6 fallen aus (fest); Pegel −24 → −30; danach 1,2 s Rauschen (−38 RMS), klingt aus | ≈ 2,5 s |
| `dice` | 16 Pulse `glass`, Abstand 35 ms·1,16ⁿ, je −0,3 dB | −28 · ≈ 2,3 s |

---

## F. Installation

### F.1 Fortschritt → Periode (Inszenierung mit Rastplateaus)

**Eingang:**

| Schritt | Antrieb |
|---|---|
| `install` | x = clamp(percent/100, 0, 1); `phase === "done"` ergibt 1; `connect` ergibt 0 |
| `un-run` | x = 1 − percent/100 |
| `done` | 1 |
| Wartung, Bestätigen | 1 (Zeichen, lautlos) |
| übrige Schritte | 0 |

Es gibt **keine** künstliche Monotonie: Startet das Backend neu, sinkt die Drehzahl ehrlich mit.

```ts
// installer/src/obs/drive.ts
const L = [Math.log(1.3373), Math.log(0.08933), Math.log(0.0337), Math.log(0.005757)];
const SEG: [number, number, number, number][] = [[0, .06, 0, 0], [.06, .40, 0, 1], [.40, .48, 1, 1],
  [.48, .62, 1, 2], [.62, .70, 2, 2], [.70, .94, 2, 3], [.94, 1, 3, 3]];
export function periodForProgress(x: number): number {
  x = Math.min(1, Math.max(0, x));
  const [a, b, i, j] = SEG.find(([, e]) => x <= e) ?? SEG[SEG.length - 1];
  const u = b > a ? (x - a) / (b - a) : 0, s = u * u * (3 - 2 * u);
  return Math.exp(L[i] + (L[j] - L[i]) * s);
}
```

| x | P | f | Bedeutung (echte Backend-Prozente) |
|---|---|---|---|
| 0–0,06 | 1,3373 s | 0,748 Hz | B1919, Verbinden und Download-Anlauf |
| 0,2178 | 399,7 ms | 2,50 Hz | ab hier Belichtung 2·P (Sanduhr) |
| 0,23 | 345,6 ms | 2,89 Hz | Referenzwechsel B1919 → Vela |
| 0,40–0,48 | 89,33 ms | 11,19 Hz | Vela-Plateau, Knattern |
| 0,55 | 54,87 ms | 18,23 Hz | Wechsel Vela → Krebs |
| 0,578 | 41,6 ms | 24,0 Hz | Überblendung beginnt |
| 0,62–0,70 | 33,70 ms | 29,67 Hz | Krebs-Plateau, Schnarren |
| 0,7823 | 20,84 ms | 48,0 Hz | nur noch Ton |
| 0,82 | 13,93 ms | 71,8 Hz | Wechsel Krebs → J0437 |
| 0,85 | 10,07 ms | 99,3 Hz | Download fertig |
| 0,92 | 5,961 ms | 167,8 Hz | Prüfen fertig |
| 0,94–1 | 5,757 ms | 173,70 Hz | J0437: Installieren, Verknüpfungen, Eintragen |

- **Referenz** = nächster Katalog-Pulsar im log-Abstand. Die Grenzen liegen bei den geometrischen Mitteln 0,3456 s, 0,05487 s und 0,013929 s. Die Koordinaten in der Statusleiste wechseln mit.
- **Rauschbett in der Installation:** −46 dBFS bei x = 0, linear in dB bis zum Aus bei x ≥ 0,25. Das Signal tritt aus dem Rauschen.

### F.2 SpinModel (`shared/sound/spin.ts`, rein)

```ts
export interface SpinKnot { t: number; f: number; phi: number }
export class SpinModel {
  constructor(o: { t0: number; f0: number; phi0?: number; dt?: number /* 0.02 */ });
  setTarget(o: { f: number; tauS?: number /* 0.6 */; maxOctPerS?: number /* 2 */ }): void;
  advance(until: number): SpinKnot[];   // erzeugt Knoten bis until (bereits erzeugte sind unveränderlich)
  freqAt(t: number): number;            // linear zwischen Knoten
  phaseAt(t: number): number;           // Trapez-Integral, exakt für lineare f
  pulsesBetween(t0: number, t1: number): { t: number; index: number; f: number }[];  // ganzzahlige Phase, quadratisch gelöst
  knotsSince(t: number): SpinKnot[];
  prune(before: number): void;
}
```

- **Regelgesetz** je Knoten (dt 20 ms): ΔlnF = (lnF_Ziel − lnF)·(1 − e^(−dt/τ)), begrenzt auf |ΔlnF| ≤ ln2·maxOctPerS·dt.
- **Phase:** φ_{k+1} = φ_k + (f_k + f_{k+1})/2·dt.
- **Pulse:** Lösung von φ_k + f_k·s + (f_{k+1} − f_k)/(2dt)·s² = n.

| Situation | τ | maxOctPerS |
|---|---|---|
| Installation, Deinstallation | 0,6 s | 2 |
| Fertig | 0,15 s | 3 |
| Abbruch → B1919 | 0,5 s | 5 |
| Rückkehr in den Leerlauf | 0,6 s | 3 |

### F.3 Neutronenstern (Canvas 2D, `obs/star.ts`, rein)

**Projektion und Achsen:**
- Orthografisch: x nach rechts, y nach oben, z zum Betrachter. **Der Betrachter ist die Erde**, die Sichtlinie ist +z.
- Bildschirmpunkt = (210, 232) + 58·(x, −y).

**Geometrie** (nachgerechnet):
- Vor der Bilddrehung: Ω̂₀ = (0, sin ζ, cos ζ), ê₁₀ = (−1, 0, 0), ê₂₀ = (0, −cos ζ, sin ζ), mit ζ = 50°.
- Danach R_z(−35°) auf alle drei Vektoren:
  - Ω̂ = (0,43939, 0,62751, 0,64279)
  - ê₁ = (−0,81915, 0,57358, 0)
  - ê₂ = (−0,36869, −0,52654, 0,76604)
- Magnetachse: m(ψ) = cos α·Ω̂ + sin α·(cos ψ·ê₁ + sin ψ·ê₂), α = 45°.
- Drehphase φ (Umdrehungen): **ψ = 2π·φ + π/2**.
  - φ ganzzahlig: m liegt **5,0°** von der Sichtlinie entfernt. Das ist der **Puls**, gleichzeitig mit dem hörbaren Klick.
  - φ = 0,5 (**Logo-Phase**): m = (0,5714, 0,8160, −0,0872). Projiziert sind das **35,0°** ab senkrecht, praktisch in der Bildebene.
  - Der Gegenstrahl −m kommt der Sichtlinie nie näher als **85°**: physikalisch ein Puls pro Umdrehung.

**Zeichenreihenfolge** (nach z):

| Schritt | Inhalt |
|---|---|
| 1 | Hintere Feldlinien `fg-2` 8 % |
| 2 | Hintere Belichtungsebene (Strahl-Samples mit m_z < 0) |
| 3 | Sternscheibe: Fläche `--obs-sphere`, Rand 1 px `fg` 35 %. **Kein Verlauf.** |
| 4 | Gradnetz um Ω̂: Breiten 0°, ±30°, ±60° immer; Meridiane alle 30° mit Deckkraft × w(n); 48 Punkte je Linie, nur z > 0, `fg` 18 % |
| 5 | Polkappen: projizierter Kreis mit 8° Winkelradius um ±m, gelb mit Deckkraft 0,7·max(0, ±m_z) |
| 6 | Vordere Feldlinien `fg-2` 22 % × w(n) |
| 7 | Vordere Belichtungsebene |
| 8 | Lichtscheibe |

**Strahlen:**
- Kegel mit halbem Öffnungswinkel ρ = 9°, von der Oberfläche (r = 1) bis 2,5 R★, als Viereck mit Endellipse.
- Fläche gelb 0,16, Kanten 1 px gelb 0,6. **Kein Verlauf, kein `lighter`, kein Glühen.**

**Dipol-Feldlinien:**
- Im Magnetsystem r(θ) = L·sin²θ für L ∈ {1,6; 2,2; 3,0} und Azimut χ ∈ {0°, 90°, 180°, 270°}, also 12 Linien.
- θ läuft von asin(1/√L) bis π − asin(1/√L) mit 40 Punkten.
- Punkte mit z < 0 innerhalb der Scheibe entfallen. Basis u₁ = norm(Ω̂ × m), u₂ = m × u₁.

**Virtuelle Kamera (Belichtung)** statt Zeitlupe:
- Belichtete Umdrehungen n(f): n = f/60 für f ≤ 0,75 Hz (T = 1/60 s); n = 2 für f ≥ 2,5 Hz (T = 2/f); dazwischen ln n per smoothstep in ln f.
- Beispiele: n(1,0) = 0,026, n(1,37) = 0,159, n(2,0) = 1,26.
- **Umsetzung (billig):**
  - Die Strahl- und Kappen-Samples über den belichteten Bogen [φ − n, φ] haben einen Abstand von ≤ 6°: N = min(⌈360·n/6⌉, 60/30/12 je Qualitätsstufe).
  - Sie werden **mit voller Deckkraft** in zwei Offscreen-Canvases gezeichnet (hinten und vorn) und als **Vereinigungsmenge** mit Deckkraft A(n) eingesetzt.
  - A(n) = 0,16 → 0,10 linear für n < 1; für n ≥ 1 gilt A = 0,10 + 0,10·clamp(ln(f/2,5)/ln(173,7/2,5), 0, 1).
  - Bei n < 1 bekommt der *aktuelle* Strahl scharfe Kanten (Lichtspur).
  - Bei n ≥ 1 entsteht die physikalisch korrekte **Sanduhr** aus zwei hohlen Kegeln. Die Kappen werden zu Breitenringen um Ω̂ in Kolatitude α bzw. 180° − α (Strich 2·sin 8°·R, Deckkraft 0,5·A).
  - Meridiane und Feldlinien verwischen: w(n) = 1/(1 + 2n). Breitenkreise bleiben scharf, weil sie drehinvariant sind.

**Lichtscheibe (Puls):**
- Ist der Winkel γ zwischen m und Sichtlinie < 12°, wird der Kegelquerschnitt als flache Ellipse gezeichnet (Durchmesser ≤ 2·2,5R·tan 9° = 46 px), gelb mit 0,45·exp(−(γ/6°)²), Rand 1 px.
- **Blitzschutz:** Blitzen nur bei f ≤ 2,5 Hz (`flashAllowed`, ≤ 3 Blitze pro Sekunde). Darüber steht eine ruhige Scheibe mit 0,18. Das Bildrauschen ändert die Helligkeit um weniger als 10 %.

**Stroboskop** (Fertig, G.1): Das Belichtungsfenster ist um φ_L = ⌊φ⌋ + 0,5 zentriert. Seine Breite schrumpft in 800 ms von 2 auf 0 (easeOutCubic). Die Sanduhr zieht sich so zu zwei scharfen Strahlen in Logo-Lage zusammen. Label `STROBO 173,7 Hz · PHASE 180°`.

**Wandlung Stern → Zeichen** (`markMorph(t)`, t 0→1; umgekehrt bei `un-run`):
- Der Rand (58 px, 1 px, `fg` 35 %) wird zum Ring (72,2 px, Strich 3,4 px, `fg` 100 %).
- Gradnetz und Feldlinien blenden aus.
- Der Kern (18,9 px, gelb) wächst.
- Jeder Strahl teilt sich in 8 Haarstrahlen (±5,6°) mit RAY_IN…RAY_OUT(k), Zeichen 220 px bei (210, 232).
- Danach Überblendung (120 ms) auf das SVG `PulsarMark rays`.

**Zerfall** (`un-done`): Die Stern-Ebene wird per **Bayer 4×4** in 1500 ms ins Rauschen gelöst.
- 16 Muster-Canvases (4 × 4), `globalCompositeOperation = "destination-out"` mit dem Muster der aktuellen Schwelle, darunter eine Rauschkachel mit dem inversen Muster.
- Ergebnis: eine eingefrorene Rauschtextur mit Deckkraft 0,08, kein Dauerflimmern.

**Zustände des Schirms:**

| Zustand | Darstellung |
|---|---|
| Fehler | Strahlen als gestrichelte Umrisse [3, 3] mit Deckkraft 0,4, ohne Fläche; Belichtungsebene × 0,3; Feldlinien × 0,3; keine Kappen, keine Lichtscheibe. Der Stern dreht weiter mit der eingefrorenen Periode. |
| Angehalten | Strahlen mit Deckkraft 0,5 |

### F.4 Messgerät-Anzeigen

- **INSZENIERT** (Schirm): Periode, Frequenz, Referenz, Log-Skala, „Hörbar als“. Werte aus `model.freqAt(now)`; das DOM wird höchstens 10-mal pro Sekunde per Ref und `textContent` aktualisiert.
- **GEMESSEN** (Bedienfeld): Prozent, `formatBytes(downloaded)/formatBytes(total)`, `formatBytes(speed)/s`, `formatEta`, Phasendauern, „Fortgesetzt bei“. Alles stammt nur aus Events bzw. Client-Zeitmessung.
- **Formate:**

| Größe | Regel | Beispiele (de) |
|---|---|---|
| `formatPeriod(P)` | ≥ 1 s: 4 Nachkommastellen; 100 ms–1 s: 1; 10–100 ms: 2; < 10 ms: 3 | „1,3373 s“, „345,6 ms“, „89,33 ms“, „33,70 ms“, „5,757 ms“ |
| `formatHz(f)` | < 1: 3 Nachkommastellen; < 100: 2; sonst 1 | „0,748 Hz“, „11,19 Hz“, „173,7 Hz“ |
| `formatPercent` | eine Nachkommastelle | „43,0 %“ (de), „43.0%“ (en) |

### F.5 Fehler, Abbruch, Fortsetzen

| Zustand | Bild | Ton |
|---|---|---|
| **Fehler** (`install://error`, nicht abgebrochen) | wie F.3 Fehler, Tag `KEIN SIGNAL · {CODE}`, Werte eingefroren (`ZULETZT GEMESSEN`) | `play("error")`; `setDropout(1, {rampS: 0.3})`; nach 0,4 s `voice.stop({fadeS: 0.1})`; Rauschbett −38 dBFS (0,1 s), dann `stop({fadeS: 2.5})`. Kein Dauerrauschen. |
| **Abgebrochen** | Ziel B1919 (maxOct 5, ≈ 1,6 s), Strahlen 0,5, Tag `EMPFANG ANGEHALTEN` | Stimme gleitet mit; nach 2,4 s `stop({fadeS: 0.6})`. Kein Fehlerklang. |
| **Fortsetzen** (`retry`) | 300 ms Tag `RASTET EIN …`, dann folgt der Stern dem Modell ab dem aktuellen Wert | Rauschbett −40 dBFS mit `follow` 1800 → 1042 Hz (0,3 s); danach Puls −16, Rauschbett aus, `voice.start({fadeS: 0.1})` |
| **`running`** | wie Fehler, Knopf `errors.closeApp` | wie Fehler |

---

## G. Fertig und Deinstallieren rückwärts

### G.1 Fertig (t = `install://done`)

| t (ms) | Bild | Ton |
|---|---|---|
| 0 | 100,0 %, letzte Phase `OK`; Modellziel f★ | Akkord startet (spektrale Öffnung E.8) |
| 0–800 | **Stroboskop rastet ein** (F.3), Label `STROBO 173,7 Hz · PHASE 180°` | – |
| 400–1300 | – | Der Ton löst sich in den Akkord auf: `voice.setLevel(0, {rampS: 0.9})`, bei 1300 `stop()` |
| 650 | `go("done", 1, { silent: true })`, ohne Sweep. Die Staffelung des Bedienfelds startet mit **450 ms Verzögerung**. | – |
| 800–1300 | `markMorph` 0 → 1; bei 1300 SVG-Zeichen. Schirm: J0437, „AKKORD“, `INSTALLIERT`. | – |
| ≈ 1100 | H1 „Signal steht.“ (`aria-live`) | – |
| 1600 | Countdown-Block blendet ein (die Logik bleibt: 5 s ab dem Schritt `done`) | – |
| 2400 | – | `chord.release({tauS: 0.7})`, danach **Ruhe**: keine Countdown-Ticks |
| 5650 / Klick | `finish(true)` (unverändert) | kein `launch`-Klang; nur der normale Klick des Knopfs |

**Update-Modus:** Ablauf identisch, aber `chord.release` bei 1200 ms mit τ 0,4. Der automatische Neustart folgt 2600 ms nach dem Schritt `done`, wie bisher.

### G.2 Deinstallieren (t = Klick auf „Deinstallieren“)

| Abschnitt | Bild | Ton |
|---|---|---|
| 0 | `go("un-run")`; `markMorph` 1 → 0 (500 ms), danach löst sich das Stroboskop (Belichtung 0 → 2 in 600 ms) | Sweep zurück (−27); `voice.start({fadeS: 0.3})` als Ton bei f★ (folgt dem Modell) |
| `uninstall://progress` | x = 1 − percent/100: Stern wird langsamer, ab f < 2,5 Hz wieder einzelne scharfe Strahlen; Feldlinien-Deckkraft × (0,4 + 0,6·x); Referenz J0437 → Krebs → Vela → B1919; rechts `DREHZAHL SINKT MIT DEM FORTSCHRITT` | Ton → Schnarren → Knattern → Einzelklicks |
| t_d = `uninstall://done` | Ziel f 0,02 Hz (τ 1,2 s): Rotation bremst über ≈ 3 s; Strahlen-Deckkraft 1 → 0,6 → 0,3 → 0 mit jedem Puls | Stimme `stop({fadeS: 0.05})`; Pulse bei **t_d, +1337,3, +2674,6** ms: `radio` −14, `radio` −20, `soft` −28 |
| t_d + 500 | `go("un-done")` (bestehender Timer, still); Bayer-Zerfall bis t_d + 2000 | – |
| t_d + 2674,6 … 3400 | – | Rauschbett −44 → −34 dBFS (fc 1042,21, Q 0,7); bei 3400 `stop({fadeS: 2.1})` |
| t_d + 4011,9 | – | **Der erwartete 4. Puls bleibt aus (hörbare Lücke)** |
| ≈ t_d + 6000 | Rauschtextur 0,08 eingefroren, Tag `SIGNAL VERLOREN` | Stille |
| `revertOk === false` | Hinweis (`role="alert"`) erscheint mit der H1 bei t_d + 500 | nur 2 Pulse (t_d, +1337,3), kein Rauschanstieg, Ausklang ab 1600; bei t_d + 500 `play("notify", {gain: 0.5})` |

---

## H. Barrierefreiheit, reduzierte Bewegung, Ton aus, Leistung

**Barrierefreiheit:**
- **Kontraste:** Text ≥ 4,5:1 (`fg-3` 5,4:1), Ränder von Bedienelementen ≥ 3:1 (`control` 3,66 bzw. 3,34). `fg-4` nur für Deaktiviertes.
- **Fokus:** weiß, 2 px, Abstand 2 (Primär 3), nur bei `:focus-visible`. Reihenfolge: Titelleiste → Inhalt → Fuß, der Primärknopf zuletzt. Nach jedem Seitenwechsel geht der Fokus auf die H1; auf der Fertig-Seite hat der Primärknopf `autoFocus`.
- **Ansagen:**
  - `LiveRegion` (polite, sr-only) meldet Phasenwechsel und 10-%-Schritte (`a11y.progress`), „Signal erfasst.“, „Signal steht.“, „Signal verloren.“ und `a11y.skipped`.
  - Fehler und `revertOk` kommen als `role="alert"`.
  - Die Kopfzeile der Installation hat `role="progressbar"` mit `aria-valuenow` und `aria-valuetext` („43 %, 4,9 von 11,3 MB“).
- **Canvas:** immer `aria-hidden`. Daneben steht sr-only `a11y.star` (wird nur beim Referenzwechsel aktualisiert). Die Periode hat `aria-describedby` → `obs.stagedNote`.
- **Tastatur:** Esc, Enter, Leertaste und druckbare Tasten überspringen das Intro; **M** schaltet den Ton, außer der Fokus liegt im Eingabefeld; Esc schließt den Dialog.
- Trefferflächen sind ≥ 32 px hoch, Optionszeilen 64 px.

**Reduzierte Bewegung:**
- Quelle: `useReducedMotion()` (matchMedia mit Listener, live) und `?motion=reduced`.
- `MotionConfig reducedMotion={force ? "always" : "user"}`.

| Bereich | Verhalten |
|---|---|
| Intro | D.6 |
| Stern | steht in Logo-Phase, keine Belichtung, kein Blitzen, Label `STANDBILD` |
| Stroboskop und Wandlung | sofort als Endbild |
| Zerfall | statisches Endbild |
| Rauschen | Standbild |
| Seitenwechsel | nur Deckkraft, 120 ms |
| Skalen und Nadeln | springen |
| Countdown | Segmente schalten pro Sekunde, ohne Breitenanimation |
| Messwerte | laufen weiter (Information) |
| **Ton** | bleibt unverändert |

**Ton aus:**
- `SoundSwitch` und die Taste M; gespeichert unter `pulsar-setup-muted` (try/catch, wie bisher).
- Stumm heißt: Master in 30 ms auf 0, der Scheduler erzeugt **keine** Knoten, Modell und Bild laufen weiter.
- Beim Einschalten setzt der Ton phasenrichtig ab „jetzt“ ein.

**Leistung:**
- **Ein gemeinsamer rAF** (`useFrameLoop`). Er läuft nur mit Abonnenten und stoppt bei `document.hidden`, ebenso der Audio-Scheduler.
- **Qualitätsstufen** (`useQuality`):

| Stufe | Bildrate | DPR (Schirm / Intro) | Samples | Feldlinien | Gradnetz-Punkte | Rauschkacheln |
|---|---|---|---|---|---|---|
| L2 | 60 fps | min(dpr, 2) / min(dpr, 1,25) | 60 | 12 | 48 | ja |
| L1 | 30 fps | 1,5 / 1 | 30 | 6 | 24 | ja |
| L0 | 15 fps | 1 / 1 | 12 | nur vorn | nur Breiten | Standbild |

  - Automatisch eine Stufe tiefer, wenn das p95 der Zeichenzeit über 60 Frames > 8 ms liegt oder das p95 des rAF-Abstands > 34 ms. Automatisch wird nie hochgestuft.
  - Start in L1 bei `hardwareConcurrency ≤ 2`. `?quality=0|1|2` überschreibt.
- **Budget:** ≤ 4 ms JS + ≤ 2 ms Rasterung pro Frame bei 4-facher CPU-Drosselung in DevTools.
- **Statische Ebenen** (Gratikül, Himmelskarte, Skalen, fertige Ridgeline-Zeilen) werden einmal offscreen bzw. als SVG gezeichnet.
- **Texte stehen im DOM, nie im Canvas.**
- **Verboten:** `shadowBlur`, `ctx.filter`, CSS `filter`/`backdrop-filter`, Verläufe (CSS und Canvas), `globalCompositeOperation = "lighter"`.
- **React:** Canvas-Werte liegen in Refs; es gibt kein State-Update pro Frame. StrictMode: Intro-Partitur, Stimme und Rauschbett sind idempotent, und das Aufräumen stoppt alle Quellen (ein Test prüft, dass Doppel-Mount keine Doppel-Pulse erzeugt).

**Ohne GPU, Audio oder Fonts:**
- Canvas 2D läuft im Software-Raster.
- `CanvasBoundary` (Error Boundary) zeigt bei Ausfall bzw. `getContext("2d") === null` ein statisches SVG (`PulsarMark rays` + Texte) und meldet per `console.warn`.
- Ohne `AudioContext` laufen stumme Objekte; der Wachhund setzt ohne Gerät `healthy = false`. Kein Ablauf wartet auf Audio.
- Fonts mit `font-display: swap`.
- Der CI-Screenshot nach 9 s kann nicht abstürzen. Der Rust-Selbsttest ist unberührt.

---

## I. Dateiplan

### I.1 Reihenfolge (gegen Regressionen)

Nach jedem Schritt sind `npm run typecheck`, `npm test` und die Tour grün.
1. Ablauf-Logik **1:1** aus `App.tsx` nach `flow/useSetupFlow.ts` lösen; die alte Oberfläche bleibt.
2. Klang-Engine neu (dsp, spin, clock, voice, recipes, engine) samt Tests. Die App klingt sofort neu, ohne Codeänderung.
3. Reine `obs/*`-Module samt Tests.
4. Tokens, Fonts, `Frame` und Bedienelemente; Seiten Willkommen, Speicherort, Optionen, Wartung, Bestätigen (Schirm zunächst als SVG-Ersatz).
5. `StarCanvas` und Schirm im Leerlauf.
6. Intro.
7. Installation mit Sonifikation, Fehler, Abbruch, Fortsetzen.
8. Fertig und Deinstallation.
9. Tour, feature-shots, E2E, Doku, Leistungsprüfung auf einer Windows-VM ohne GPU (Qualitätsstufe protokollieren).

### I.2 Neu in `shared/`

| Datei | Inhalt |
|---|---|
| `shared/sound/engine.ts` (neu geschrieben) | Fassade E.10, Unlock, Wachhund, Scheduler-Besitz |
| `shared/sound/graph.ts` | Kontext, Busse, Master, Limiter, Impulsantwort, Rauschbett |
| `shared/sound/dsp.ts` | rein: `F_STAR`, `harmonic`, `dbToGain`, `biquadCoeffs` (Spec-Formeln), `renderResponse`, `makeExcitation`, `pulseAmp`, `crossfade`, `toneGain`, `smootherCutoff`, `noiseShare`, `heardAs`, `dispersionCurve`, `dispersionAt`, `mulberry32`, `triangular`, `pinkNoise` |
| `shared/sound/spin.ts` | rein: `SpinModel` (F.2) |
| `shared/sound/voicePlan.ts` | rein: `planPulses(state, now, horizon)` |
| `shared/sound/voice.ts` | `ScheduledPulseVoice` + `SilentPulseVoice` (gleiche API, keine Knoten) |
| `shared/sound/clock.ts` | `AudioClock` (E.3) |
| `shared/sound/recipes.ts` | `RECIPES` (E.12) als Daten + Renderer, `satisfies Record<SoundName, Recipe>` |
| `shared/ui/PulsarMark.tsx` | flaches Zeichen: `{ size: number; variant?: "solid" \| "rays"; ring?: number; beams?: number; core?: number; tone?: "signal" \| "mono"; decorative?: boolean }`, exportiert `MARK_GEOMETRY` (D.4). Kein Verlauf. `solid`: Strahl-Pfad `M256 256 L236 92 Q256 10 276 92 Z` bei 35° und 215°, gelb. |

`PulsarLogo.tsx`, `Starfield.tsx`, `Button.tsx`, `Checkbox.tsx`, `Toggle.tsx` und `AnimatedCheck.tsx` bleiben für die App.

### I.3 Neu in `installer/src/`

| Datei | Zweck / Props |
|---|---|
| `flow/useSetupFlow.ts` | Zustand, Events, `startInstall`, `retry`, `finish`, Countdown, Update-Neustart, Tipps (Intervall **8000 ms**). Neu: `go(step, dir, {silent})`, `introFinished()`, `phaseDurations`, `resumedAt`, `onEvent`-Rückruf; reine Helfer `nextStepAfterIntro(info)` und `errorBackTarget(code)` |
| `obs/obs.css` | B.1 und B.2, Klassen `.obs-label`, `.obs-value`, `.obs-h1`, `.obs-h1-sm`, `.obs-body`, `.obs-small`, `.obs-tag` |
| `obs/catalog.ts` | `REFERENCES` (B.6), `nearestReference(P)`, `coordLine(ref)` |
| `obs/drive.ts` | `periodForProgress`, `driveFor(step, flow)` |
| `obs/format.ts` | `formatPeriod`, `formatHz`, `formatPercent`, `formatDuration` („0,4 s“, „12 s“, „1:05“), `formatExposure` |
| `obs/star.ts` | Konstanten (ζ 50°, α 45°, Bilddrehung −35°, ρ 9°, κ 8°, Strahllänge 2,5, L-Werte), `basis`, `magneticAxis`, `psiForPhase`, `project`, `dipolePoints`, `beamQuad`, `capEllipse`, `exposureTurns`, `sampleCount`, `strobeWindow`, `markMorph`, `flashAllowed`, `LOGO_PHASE = 0.5` |
| `obs/ridgeline.ts` | `makeRows(seed)`, `noiseRow(seed, frame, sigma)`, `foldMean`, `rowToRay`, `sumToRing` |
| `obs/introTimeline.ts` | `introEvents(variant)`, `introStateAt(t, variant)`, `skipState()`, `PULSE_MS = 1337.3` |
| `obs/dither.ts` | `BAYER4`, `bayerMask(level)` |
| `hooks/useReducedMotion.ts`, `hooks/useFrameLoop.ts`, `hooks/useQuality.ts` | H |
| `hooks/useObservatory.ts` | `(flow, reduced) => ObsState { model; mode: "idle"\|"installing"\|"error"\|"halted"\|"relock"\|"strobe"\|"installed"\|"release"\|"uninstalling"\|"decay"\|"lost"; modeSince; reference; heard: HeardAs\|"chord"\|null; showMark: boolean; errorCode? }`. Besitzt Stimme, Rauschbett, Akkord und Gewöhnung und reagiert auf `flow.onEvent` (F.5, G). |
| `components/Frame.tsx` | `{ lang; onLang(l); muted; onMute(m); onClose(); status: { left: string; right: string }; children }`, Taste M |
| `components/StepScale.tsx` | `{ steps: string[]; current: number }` bzw. `{ label: string }` (Kopfzeilen-Modus) |
| `components/Schirm.tsx` | `{ obs: ObsState; reduced: boolean; quality: Quality }`, Aufbau C.2 |
| `components/StarCanvas.tsx` | `{ model: SpinModel; mode: ObsMode; modeSince: number; reduced: boolean; quality: Quality }` |
| `components/LogScale.tsx` | `{ periodRef: RefObject<number>; nearest: RefId }` |
| `components/LinearScale.tsx` | `{ value: number; frozen?: boolean; labels?: string[] }` |
| `components/Readout.tsx` | `{ label; value; unit?; size: "xl"\|"lg"\|"md"\|"sm"; tone?: "fg"\|"signal"\|"muted"\|"error"; valueRef?; testId?; dataValue? }` |
| `components/PhaseList.tsx` | `{ items: { id; index; label; state: "done"\|"active"\|"todo"\|"failed"\|"kept"; status?: string }[] }` |
| `components/ObsButton.tsx` | `{ variant: "primary"\|"secondary"\|"ghost"\|"danger"\|"danger-solid"; size?: "sm"\|"md"\|"lg"; icon?; iconRight?; silent? } & ButtonHTMLAttributes` |
| `components/OptionRow.tsx`, `ObsCheckbox.tsx`, `PathField.tsx`, `DiskScale.tsx` | B.7 und C.4 |
| `components/Notice.tsx` | `{ tone: "warn"\|"error"\|"neutral"; title?; role?: "alert"\|"status"; children; actions? }` |
| `components/ConfirmDialog.tsx` | `{ open; title; text; confirmLabel; cancelLabel; onConfirm(); onCancel() }` |
| `components/Countdown.tsx` | `{ label; seconds: number \| null; total: number; mode: "segments"\|"bar"; durationMs? }` |
| `components/SoundSwitch.tsx`, `LangSwitch.tsx`, `Glyph.tsx` (`"tri-down"\|"tri-up"\|"tri-right"\|"arrow-right"\|"check"\|"cross"`), `CanvasBoundary.tsx`, `LiveRegion.tsx` | – |
| `intro/IntroScreen.tsx` | `{ info: SetupInfo \| null; reduced; quality; onExit() }`, Partitur via `sound.score` |
| `intro/IntroCanvas.tsx`, `intro/SkyGrid.tsx` (statisches SVG), `intro/Tuner.tsx` (SVG, Nadel per Ref) | – |
| `pages/Welcome.tsx`, `Maintenance.tsx`, `Folder.tsx`, `Options.tsx`, `Install.tsx`, `Done.tsx`, `UnConfirm.tsx`, `UnRun.tsx`, `UnDone.tsx` | Props `{ flow: SetupFlow; obs: ObsState }`, nur Darstellung |
| `lab/SoundLab.tsx` (optional, empfohlen) | nur bei `import.meta.env.DEV && ?lab`: alle SoundNames, Periodenschieber, Intro-Partitur, Spitzen- und RMS-Anzeige per `AnalyserNode` |

### I.4 Geänderte Dateien

| Datei | Änderung |
|---|---|
| `installer/src/App.tsx` | nur noch Komposition: `Frame`, Intro oder Schirm + `AnimatePresence`-Seiten, `ConfirmDialog`, `LiveRegion`. Entfernt: Backdrop, Bursts, `glass-strong`, `LayoutGroup`/`layoutId`, `SignalText`, `sound.play("progress"\|"startup"\|"tick"\|"jingle"\|"farewell"\|"whoosh")` |
| `installer/src/main.tsx` | Importe `@fontsource-variable/inter/opsz.css`, `@fontsource/ibm-plex-mono/latin-400.css`, `@fontsource/ibm-plex-mono/latin-500.css` (Sora raus); `sound.setVolume(0.5); sound.warmup();`; `MotionConfig reducedMotion={force ? "always" : "user"}` |
| `installer/src/styles.css` | `@import "./obs/obs.css"`; `.input` und `nv-aurora` entfernen |
| `installer/index.html` | `data-skin="obs"`, Hintergrund `#0A0B0D` |
| `installer/package.json` | `+ "@fontsource/ibm-plex-mono": "^5.3.0"`, `− "@fontsource-variable/sora"` (dann `npm install`, `package-lock.json`) |
| `installer/src-tauri/tauri.conf.json` | nur `"backgroundColor": "#0A0B0D"` |
| `installer/src/api.ts` (nur Demo) | `?lang=en` → `systemLang`; `?slow` = Download viermal langsamer (Tick 360 ms); nach `network`-Fehler oder Abbruch setzt der Demo-Download bei den bisherigen Bytes fort (wie das echte Backend); `?revertfail` bleibt |
| `installer/src/i18n.ts` | Schlüssel I.9; `export const dictionaries = { de, en }` |
| `installer/src/i18n.test.ts` | I.8 |
| `scripts/installer-tour.mjs`, `scripts/feature-shots.mjs`, `scripts/e2e-installer-linux.mjs` | I.10, I.11 |
| `docs/KREATIV-PLAN.md` | Abschnitte „Der Installer“ und „Sound“ neu (Radioteleskop, Pulsar-Sonifikation, keine Melodien) |
| `docs/INSTALLER.md` | kurzer Abschnitt „Oberfläche“: Prozent → Periode ist Inszenierung; Events unverändert |
| `docs/TESTBERICHT.md` | „Nicht geprüft: Klang wird in der CI nicht gehört; Rezepte und Zeitachsen werden rechnerisch geprüft“ |

### I.5 Gelöschte Dateien

`installer/src/components/Backdrop.tsx`, `WaveRing.tsx`, `StepRail.tsx`, `OptionCard.tsx`.

### I.6 Reine Funktionen und vitest-Tests

Alle Tests liegen in `installer/src/__tests__/` (Vitest-Standard-`include`, `@shared`-Alias aus `vite.config.ts`, Umgebung node). Es ist kein Vitest-Umbau nötig.

| Datei | Prüft |
|---|---|
| `sound/dsp.test.ts` | F_STAR = 173,7016 ±1e-3; `harmonic(6)` = 1042,21 ±0,01. `dispersionCurve(3200,400,0.22,64)`: Endpunkte, streng fallend, `dispersionAt(…,0.02)` = 1234 ±1 %, 1/f² linear in t (R² > 0,9999), `RangeError` bei fHi ≤ fLo. `pulseAmp`: 1 bei 0,748 und 4; 0,598 ±0,002 bei 11,19; 0,1518 ±0,001 bei 173,7; f·a² = 4 für f ≥ 4. `crossfade`: w_c² + w_t² = 1, (24) = (1,0), (48) = (0,1), (33,94) = (0,707, 0,707). **Tonschicht-Gain:** simulierter Klickzug gegen Harmonischen-Summe bei 36 Hz, 0,25 s, 48 kHz durch BP 1042,21 Q 7: RMS ±1 dB. Bandpass-Spitze bei f₀ = 0 dB ±0,05. `renderResponse` normiert auf Spitze 1 und ≤ 2048 Samples. `heardAs` an 7,99/8/19,99/20/39,99/40. `smootherCutoff(20)` = 6000, `(174)` = 2200, monoton. `mulberry32` deterministisch, `triangular` ∈ [−1, 1], Mittel ≈ 0. |
| `sound/spin.test.ts` | konstantes f: Phase linear (±1e-9); lineare Rampe exakt; f₀ 0,74778 mit φ₀ 0,5 bei t 0 → Pulse bei 0,66865 und 2,00595 in [0; 2,7) (±1e-4); Pulse bei ganzzahliger Phase (< 1e-9); Rate: Ziel 173,7 ab 0,748 mit maxOct 2 → nach 1 s f ≤ 2,992; kein Überschwingen; `prune` erhält die Stetigkeit |
| `sound/voicePlan.test.ts` | jitter 0: exakte Vielfache; `setPeriod` erst ab dem nächsten ungeplanten Puls; jitter 1: Versatz ∈ [−0,35P; +0,35P], Mittel ±2 % P (10 000, Seed); `skipNext` genau einmal; `accentNext` = min(1, 1,5·Basis) einmal; dropout 0,25 → 25 % ±3 %; nie früher als now + 5 ms |
| `sound/recipes.test.ts` | 19 Schlüssel. **Regel A:** jede Tonhöhe (Resonatoren, Teiltöne) ∈ {n·F_STAR, 1 ≤ n ≤ 18} ±0,05 Hz (ausgenommen `sweep`, `noise`, `rfi`, `spin`). **Regel B (keine Melodie):** Teilton-Ereignisse, deren Einsätze > 5 ms auseinanderliegen, haben gleiche Frequenz. **Regel C:** jeder Sweep hat fHi > fLo. **Regel D:** Ereignis-Spitze ≤ −14 dBFS, kohärente Summe gleichzeitiger Teiltöne ≤ −12 dBFS. **Regel E:** Dauern laut E.12. `startup`: Pulsabstand 1337,3 ms. |
| `sound/engine.test.ts` (mit `fakeAudio.ts`) | ohne `window`: `play`(alle) wirft nicht, `createVoice().active === false`. Mit Fake-Kontext: `play`(alle) wirft nie; stumm → 0 Knoten; `hoverEnabled=false` → 0 Knoten; `setVolume(0.5)` → Master-Ziel 0,25; `voice.follow(model)` plant Klicks zu `ctxTimeFor(t)`, keine Klicks bei f ≥ 48 Hz, Tonschicht startet zu einer Pulszeit; `stop()` trennt Knoten; 5. Stimme → stumm; Doppel-Mount-Simulation → keine Doppel-Pulse (Zählung über `onPulse`) |
| `obs/drive.test.ts` | Tabelle F.1 (±0,5 %), Plateaus exakt, monoton nicht steigend, Begrenzung außerhalb [0, 1]; `driveFor`: `connect` → 0, `done` → 1, un-run 20 % → 0,80 |
| `obs/catalog.test.ts` | Grenzen 0,3456 / 0,05487 / 0,013929 s; Koordinatenzeilen wörtlich wie in B.6 |
| `obs/format.test.ts` | de: „1,3373 s“, „345,6 ms“, „89,33 ms“, „33,70 ms“, „5,757 ms“, „0,748 Hz“, „11,19 Hz“, „173,7 Hz“, „43,0 %“; en mit Punkt; NBSP vor der Einheit |
| `obs/star.test.ts` | Winkel m(ψ=90°) zur Sichtlinie 5,0° ±0,05; Gegenstrahl ≥ 84,9° für alle ψ; m(270°) projiziert 35,0° ±0,1, z = −0,087 ±0,002; `psiForPhase(0)` = 90°, `(0.5)` = 270°; Feldlinie r = L·sin²θ, Endpunkte r = 1; `exposureTurns(0.748)` = 0,0125, `(2.5)` = 2, `(11.19)` = 2; `flashAllowed(2.5)` wahr, `(2.6)` falsch; `markMorph(0)`/`(1)` = Stern- bzw. Zeichen-Parameter |
| `obs/ridgeline.test.ts` | Seed deterministisch; Peak jeder Zeile innerhalb ±6 ms; σ des Rauschens von Σ₁₆ außerhalb ±30 ms ≤ σ_Zeile/3; `rowToRay(t=1)` liegt auf dem Strahl (Abstand < 1e-6), Endpunkte RAY_IN/RAY_OUT(k); `sumToRing(t=1)` auf RING_R·s |
| `obs/introTimeline.test.ts` | full: 16 Zeilen-Pulse; Puls 2 − Puls 1 = 1337,3 ±0,01; Faktoren steigend von 8,92 auf 26,75 ±0,05; t₁₆ = 3771,3 ±0,5; Ausgang 5300; Ende ≤ 5700. short: Einrasten 300, Ausgang 1050, Ende ≤ 1400. reduced: Pulse 300 und 1637,3, Ende ≤ 2000. `introStateAt` monoton (die Zahl integrierter Zeilen sinkt nie); `skipState` = Endzustand |
| `obs/dither.test.ts` | `BAYER4` enthält 0…15 je einmal; Anteil von `bayerMask(l)` = l/16 |
| `flow.test.ts` | `nextStepAfterIntro`: uninstall → un-confirm, update → install (Start), preset → install (Start), maintenance → maintenance, sonst welcome; `errorBackTarget`: disk/permission → folder, sonst options |
| `i18n.test.ts` (erweitert) | bestehende Tests bleiben; identische Schlüsselbäume de/en (rekursiv); gleiche Platzhaltermenge je Schlüssel; kein leerer Text. Knopfnamen unverändert: `welcome.start` = „Los geht's“, `common.next` = „Weiter“, `options.install` = „Installieren“, `errors.retry` = „Erneut versuchen“, `uninstall.confirm` = „Deinstallieren“, `install.cancel` = „Abbrechen“, `common.close` = „Schließen“, `done.launch` = „Pulsar jetzt starten“. Titel: `done.title` = „Signal steht.“/„Signal locked.“, `uninstall.doneTitle` = „Signal verloren.“/„Signal lost.“, `intro.acquired` = „Signal erfasst.“/„Signal acquired.“ |

### I.7 i18n: neue und geänderte Schlüssel (wörtlich)

Der `Dict`-Typ trägt 3 Ebenen; `obs.heard.*` und `obs.ref.*` passen.

| Schlüssel | de | en |
|---|---|---|
| `intro.profile` | Simuliertes Profil | Simulated profile |
| `intro.realtime` | ×1 Echtzeit | ×1 real time |
| `intro.timelapse` | ×{n} Zeitraffer | ×{n} time-lapse |
| `intro.object` | PSR B1919+21 · CP 1919 · entdeckt 1967 von Jocelyn Bell Burnell und Antony Hewish | PSR B1919+21 · CP 1919 · discovered in 1967 by Jocelyn Bell Burnell and Antony Hewish |
| `intro.folding` | Faltfrequenz | Folding frequency |
| `intro.search` | Suche | Searching |
| `intro.locked` | Eingerastet | Locked |
| `intro.phase` | Pulsphase | Pulse phase |
| `intro.acquired` | Signal erfasst. | Signal acquired. |
| `intro.folded` | Gefaltet aus {n} Rotationen · P {p} · simuliertes Profil | Folded from {n} rotations · P {p} · simulated profile |
| `intro.skip` | Überspringen | Skip |
| `intro.skipHint` | Klick oder Taste | Click or any key |
| `intro.aria` | Signalsuche: Pulsar B1919+21 wird erfasst | Signal search: acquiring pulsar B1919+21 |
| `steps.unConfirm` / `unRun` / `unDone` | Bestätigen / Entfernen / Fertig | Confirm / Remove / Done |
| `obs.view` | Blick von der Erde | View from Earth |
| `obs.schematic` | Schema · nicht maßstäblich | Schematic · not to scale |
| `obs.exposure` | Belichtung {t} | Exposure {t} |
| `obs.strobe` | Strobo {f} · Phase 180° | Strobe {f} · phase 180° |
| `obs.still` | Standbild | Still image |
| `obs.period` | Periode | Period |
| `obs.frequency` | Frequenz | Frequency |
| `obs.staged` | Inszeniert | Staged |
| `obs.measured` | Gemessen | Measured |
| `obs.heardAs` | Hörbar als | Heard as |
| `obs.silent` | lautlos | silent |
| `obs.soundOff` | Ton aus | sound off |
| `obs.idle` | Leerlauf | Idle |
| `obs.toneZone` | Ton | Tone |
| `obs.target` | Ziel | Target |
| `obs.drive` | Drehzahl = Fortschritt | Spin rate = progress |
| `obs.driveDown` | Drehzahl sinkt mit dem Fortschritt | Spin rate falls with progress |
| `obs.installed` | Installiert | Installed |
| `obs.noSignal` | Kein Signal | No signal |
| `obs.halted` | Empfang angehalten | Reception halted |
| `obs.relock` | Rastet ein … | Re-locking … |
| `obs.lost` | Signal verloren | Signal lost |
| `obs.stagedNote` | Die Drehung ist eine Inszenierung: Sie folgt dem Fortschritt und zitiert echte Pulsare aus dem Katalog. Bytes, Rate und Restzeit sind gemessen. | The rotation is staged: it follows the progress and quotes real pulsars from the catalogue. Bytes, rate and time left are measured. |
| `obs.setup` | Setup {v} | Setup {v} |
| `obs.modeUpdate` / `modeUninstall` / `modeMaintenance` | Update / Deinstallation / Wartung | Update / Uninstall / Maintenance |
| `obs.heard.clicks` / `rattle` / `buzz` / `tone` / `chord` | Einzelklicks / Knattern / Schnarren / Ton / Akkord | Single clicks / Rattle / Buzz / Tone / Chord |
| `obs.ref.b1919` / `vela` / `crab` / `j0437` | Erster Pulsar (1967) / Vela / Krebsnebel / Millisekunden-Pulsar | First pulsar (1967) / Vela / Crab / Millisecond pulsar |
| `obs.mark.vela` / `obs.mark.crab` | Vela / Krebs | Vela / Crab |
| `obs.on` / `obs.off` | An / Aus | On / Off |
| `obs.hint` / `obs.error` | Hinweis / Fehler | Note / Error |
| `welcome.eyebrow` | Game Booster für Windows | Game booster for Windows |
| `welcome.sha` | SHA-256 hinterlegt | SHA-256 provided |
| `folder.label` | Zielordner | Target folder |
| `folder.drive` | Laufwerk {d} | Drive {d} |
| `folder.total` | Gesamt | Total |
| `install.transfer` | Übertragung | Transfer |
| `install.lastMeasured` | zuletzt gemessen | last measured |
| `install.received` | Empfangen | Received |
| `install.rate` | Rate | Rate |
| `install.rest` | Rest | Remaining |
| `install.phasesLabel` | Phasen | Phases |
| `install.note` | Notiz | Note |
| `install.running` | läuft | running |
| `install.failed` | Abbruch | Failed |
| `install.ok` | OK | OK |
| `install.resumedAt` | Fortgesetzt bei {size} | Resumed at {size} |
| `install.cancelTitle` | Installation abbrechen? | Cancel installation? |
| `install.cancelKeep` | Weiter installieren | Keep installing |
| `install.cancelConfirmBtn` | Installation abbrechen | Cancel installation |
| `install.cancelledText` | Bereits geladene Daten bleiben für einen späteren Versuch erhalten. | Downloaded data is kept for a later attempt. |
| `install.phaseStatus` | Phase {n}/{total} · {phase} | Phase {n}/{total} · {phase} |
| `done.title` (**geändert**) | Signal steht. | Signal locked. |
| `done.installed` | Pulsar {v} ist installiert. Viel Spaß beim Spielen. | Pulsar {v} is installed. Have fun playing. |
| `done.verified` | Prüfsumme SHA-256 geprüft | SHA-256 checksum verified |
| `done.autoLaunchShort` | Autostart in {n} s | Auto-start in {n} s |
| `done.restartIn` | Neustart in {n} s | Restart in {n} s |
| `maintenance.eyebrow` | Installiert · v{v} | Installed · v{v} |
| `uninstall.eyebrow` | Deinstallation | Uninstall |
| `uninstall.kept` | Behalten | Kept |
| `uninstall.stepStatus` | Schritt {n}/{total} · {step} | Step {n}/{total} · {step} |
| `uninstall.doneTitle` (**geändert**) | Signal verloren. | Signal lost. |
| `common.sound` | Ton | Sound |
| `common.language` | Sprache | Language |
| `a11y.progress` | {phase}: {percent} Prozent | {phase}: {percent} percent |
| `a11y.uninstallProgress` | {step}: {percent} Prozent | {step}: {percent} percent |
| `a11y.star` | Grafik: rotierender Neutronenstern, Periode {p} (inszeniert). | Graphic: rotating neutron star, period {p} (staged). |
| `a11y.skipped` | Intro übersprungen | Intro skipped |

- **Entfallen:** `intro.connecting`, `intro.ready`, `done.text`, `done.autoLaunch`.
- **Bleiben wörtlich:** alle übrigen Schlüssel, besonders `welcome.text`, `install.tips.*`, `errors.*`, `uninstall.revertFailed*` und alle Knopfnamen.

### I.8 `scripts/installer-tour.mjs` (neu, wartet auf Zustände statt auf feste Zeiten)

```js
// Hilfen: shot(p, name, wait=0); click(p, name) = getByRole("button",{name}).first().click();
// waitBtn(p, name, ms=8000) = getByRole("button",{name}).first().waitFor({timeout: ms})
await run("?slow", async (p) => {
  await shot(p, "01a-intro-search", 700);  await shot(p, "01b-intro-realtime", 1200);
  await shot(p, "01c-intro-timelapse", 1400); await shot(p, "01d-intro-acquired", 1600);
  await waitBtn(p, /Los geht/); await shot(p, "02-welcome", 300);
  await click(p, /Los geht/); await shot(p, "03-folder", 700);
  await click(p, /^Weiter/);  await shot(p, "04-options", 700);
  await click(p, /Installieren/); await shot(p, "05a-install-b1919", 600);
  await waitPercent(p, 42); await shot(p, "05b-install-vela");    // data-testid="obs-percent" data-value
  await waitPercent(p, 66); await shot(p, "05c-install-crab");
  await waitPercent(p, 88); await shot(p, "05d-install-tone");
  await p.getByRole("heading", { name: /Signal steht/ }).waitFor({ timeout: 30000 });
  await shot(p, "06a-done", 800); await shot(p, "06b-done-countdown", 1200);
});
await run("", async (p) => {            // Überspringen per Taste
  await p.waitForTimeout(800); await p.keyboard.press("Space");
  await waitBtn(p, /Los geht/, 1200);    // sonst process.exitCode = 1
  await shot(p, "07-intro-skipped", 200);
});
await run("?fail=1", async (p) => { await skip(p); /* Los geht's → Weiter → Installieren */
  await waitBtn(p, /Erneut versuchen/, 15000); await shot(p, "08-error", 400);
  await click(p, /Erneut versuchen/); await p.getByText(/FORTGESETZT BEI/i).waitFor(); await shot(p, "09-resumed", 300);
});
await run("?slow", async (p) => { await skip(p); /* … */ await click(p, /Installieren/); await p.waitForTimeout(2000);
  await p.getByRole("button", { name: "Abbrechen", exact: true }).click(); await shot(p, "10a-cancel-dialog", 300);
  await click(p, "Installation abbrechen"); await shot(p, "10b-cancelled", 1600);
  await click(p, /Erneut versuchen/); await shot(p, "10c-resumed", 1500);
});
await run("?mode=update", async (p) => { await shot(p, "11a-update-intro", 600); await shot(p, "11b-update-install", 2000);
  await p.getByRole("heading", { name: /Signal steht/ }).waitFor({ timeout: 30000 }); await shot(p, "11c-update-done", 500); });
await run("?mode=maintenance", async (p) => { await waitBtn(p, /Aktualisieren oder reparieren/); await shot(p, "12-maintenance", 300); });
await run("?mode=uninstall", async (p) => { await p.getByRole("heading", { name: /deinstallieren\?/ }).waitFor();
  await shot(p, "13a-uninstall", 300); await click(p, /^Deinstallieren/); await shot(p, "13b-uninstall-run", 1800);
  await p.getByRole("heading", { name: /Signal verloren/ }).waitFor(); await shot(p, "13c-uninstall-done", 1500);
  await shot(p, "13d-uninstall-dissolved", 3000); });
await run("?mode=uninstall&revertfail", async (p) => { /* … */ await p.getByRole("alert").waitFor(); await shot(p, "14-uninstall-revertfail", 600); });
await runWith({ reducedMotion: "reduce" }, "", async (p) => { await shot(p, "15a-reduced-intro", 500);
  await waitBtn(p, /Los geht/, 3000); await shot(p, "15b-reduced-welcome"); /* → Installieren */ await shot(p, "15c-reduced-install", 2000); });
await run("?lang=en", async (p) => { await shot(p, "16a-en-intro", 2000); await skip(p); await shot(p, "16b-en-welcome", 300);
  await click(p, /Let's go/); await shot(p, "16c-en-folder", 700); /* Next → Install */ await shot(p, "16d-en-install", 2000); });
await run("", async (p) => { await skip(p); await p.getByRole("switch", { name: "Ton" }).click();
  if (await p.evaluate(() => localStorage.getItem("pulsar-setup-muted")) !== "1") fail("Ton aus nicht gespeichert");
  await p.screenshot({ path: `${out}/17-muted-titlebar.png`, clip: { x: 0, y: 0, width: 980, height: 40 } }); });
// Konsole: pageerror und console.error sammeln (Autoplay-Warnungen sind nur Warnungen); bei Fehlern process.exitCode = 1
```

`skip(p)` drückt nach 400 ms Escape und wartet auf „Los geht's“.

### I.9 `feature-shots.mjs` und `e2e-installer-linux.mjs`

**`feature-shots.mjs`** (Installer-Teil, die Namen 40–48 bleiben):
- `40-setup-intro` bei 2400 ms.
- `41-setup-willkommen` nach `waitBtn(/Los geht/)`.
- Im Lauf `?fail=1` wird `waitForTimeout(3600)` durch `skip(p)` ersetzt.
- Die übrigen Klicks bleiben.

**`e2e-installer-linux.mjs`:**
1. Nach `01-intro` und der Prüfung auf „PULSAR“ wird das Intro übersprungen: `js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")`.
2. Danach wird bis zu 10 s auf einen Knopf mit „Los geht“ gewartet.
3. Der Options-Selektor wird `[role=switch]` mit Text „danach starten“ bzw. „afterwards“.
4. Das Fertig-Muster wird `/Signal steht|Signal locked/`.

### I.10 Was sich in der App ändert

- **Keine Codeänderung nötig.** `SoundName`, `PlayOptions` (nur additiv `at`) und die Methoden bleiben gleich. Die App-Typprüfung muss grün sein.
- Alle 19 Klänge werden ohne Melodien neu vertont (E.12). Der Master folgt jetzt v² ohne 0,9 und ohne Kompressor.
- `startup` rastet in 2,2 s mit zwei Pulsen im B1919-Abstand ein und passt damit ins 2,3-s-Intro der App.
- Die Hover-Sperre beträgt 50 ms (statt 45).
- Die Testknöpfe in `Settings.tsx` (`TEST_SOUNDS`) dienen als manuelle Abnahme.
- Optional später: die eigenen `tick`-Aufrufe im App-Intro entfernen.
- „Hör dein Netz“ (Teil 2) nutzt E.11.

### I.11 Risiken und Gegenmittel

1. **Kein Audiogerät oder Autoplay-Sperre:** Wachhund, Modellzeit auf der Performance-Uhr, stumme Objekte. Im Tauri-Build ist `--autoplay-policy=no-user-gesture-required` schon gesetzt.
2. **Software-Rasterung auf der VM:** Qualitätsstufen, Vereinigungsmenge statt K-facher Vollzeichnung, keine Filter, DPR-Grenzen, `CanvasBoundary`.
3. **`PeriodicWave` und Frequenz-Automation auf älterer WebView2:** einmal auf Windows 10 hören. Ersatz: `tone: false`, dann laufen die Klicks bis 173,7 Hz (≤ 174 Knoten pro Sekunde, tragbar).
4. **Glyphen:** Die Regel aus B.4 ist geprüft; im Zweifel SVG.
5. **Fakten:** Die Crab-RA ist vor dem Einbau gegen ATNF und SIMBAD zu prüfen. Ridgeline, Sternbild und Perioden-Zuordnung sind beschriftet (SIMULIERT, SCHEMA, INSZENIERT).
6. **StrictMode:** Alle Effekte sind idempotent; ein Test prüft Doppel-Pulse.
7. **Späteres AudioWorklet** (nicht Teil dieses Auftrags): Dann ist eine Ausnahme in `build.assetsInlineLimit` für `*.worklet.js` Pflicht, wegen CSP `default-src 'self'`.

---

## J. Abnahmekriterien

### J.1 Funktion und CI

- [ ] `npm run typecheck` (App und Installer), `npm test` (alle Tests aus I.6) und `npm run test:rust` sind grün. `--selftest` ist unverändert grün.
- [ ] Die Tour (I.8) läuft ohne Konsolenfehler. Überspringen mit Leertaste bei 800 ms führt in ≤ 1200 ms zu „Los geht's“.
- [ ] Ohne Überspringen steht das Willkommen nach ≤ 5,7 s (`body[data-intro-done]` bei ≤ 5,3 s).
- [ ] Alle Abläufe verhalten sich wie vorher (gleiche Befehle und Events):
  - Installation, Fehler mit Fortsetzen („FORTGESETZT BEI …“), Abbruch mit Fortsetzen
  - Update (Kurz-Intro → Installation → Fertig → Neustart nach 2,6 s)
  - Wartung, Preset (Kurz-Intro → Installation)
  - Deinstallation mit `revertOk` true und false, `uninstall://error`
- [ ] Knopfnamen sind unverändert. `feature-shots.mjs` und `e2e-installer-linux.mjs` sind angepasst und laufen.
- [ ] Der CI-Screenshot nach 9 s zeigt keinen Absturz. Es gibt keine Rust-Änderung außer `backgroundColor` in `tauri.conf.json`.

### J.2 Ehrlichkeit und Fakten

- [ ] Jede Zahl ist entweder an Event-Daten oder Client-Messung gebunden oder sichtbar als INSZENIERT, SIMULIERT oder SCHEMA gekennzeichnet. Es gibt keinen erfundenen Messwert.
- [ ] Perioden 1,3373 s / 89,33 ms / 33,7 ms / 5,757 ms, Koordinaten und Entdeckungs-Credit stehen wörtlich wie in B.6 und I.7. Die Himmelskarte hat den unverzerrten Maßstab 1′ = 100 px mit Maßstabsbalken.
- [ ] Die zwei Intro-Pulse liegen 1337,3 ms auseinander (Test und DEV-Log).

### J.3 Klang

- [ ] Der Melodie-Test (Regeln A–E) ist grün:
  - Alle tonalen Sweeps fallen.
  - Akkord-Teiltöne sind n·f★ (n ∈ {1, 2, 3, 4, 5, 6, 8}), ohne Verstimmung und ohne Subharmonische.
  - Keine Pentatonik-Reste im Code (`grep -n "pentatonic\|PENTA" shared/sound` ist leer).
- [ ] Spitzen vor dem Master ≤ −12 dBFS. Der Installer startet mit Lautstärke 0,5.
- [ ] Im Klanglabor eingemessen: Endton ≈ −40 dBFS RMS, B1919-Klick −14 dBFS Spitze, Akkord ≈ −35 RMS.
- [ ] Ton aus (Schalter und M) bleibt gespeichert. Im stummen Zustand erzeugt der Scheduler keine Knoten (Test).
- [ ] Die API für „Hör dein Netz“ ist vollständig und getestet (E.11): `setPeriod`, `setJitter`, `skipNext`, `accentNext`, `setLevel` (≥ 20 ms), `setStep`, `start`/`stop` (≤ 150 ms), `dispose`, `alertTone`.
- [ ] Manuelle Hörprobe auf Windows:
  - B1919-Takt im Intro hörbar
  - Rhythmus wird über Knattern und Schnarren stetig zum Ton, ohne Doppelschlag in 24–48 Hz
  - Akkord ohne Schweben, danach Ruhe
  - Deinstallieren endet mit hörbarer Lücke und Rauschen

### J.4 Barrierefreiheit und Leistung

- [ ] Text ≥ 4,5:1, Ränder von Bedienelementen ≥ 3:1. Der weiße Fokusring ist auf allen Bedienelementen sichtbar. Alle Optionen sind `role="switch"` ohne verschachtelte Bedienelemente.
- [ ] Reduzierte Bewegung: keine Rotation, kein Morphing, kein Flimmern; Seitenwechsel nur über Deckkraft; der Ton bleibt.
- [ ] Höchstens 3 Blitze pro Sekunde (Test `flashAllowed`). Keine Fläche über 46 px blitzt.
- [ ] Bei 4-facher CPU-Drosselung ≤ 4 ms JS pro Frame in L2. Auf der Windows-VM ohne GPU werden die Stufen automatisch gewählt und protokolliert. `document.hidden` stoppt rAF und Scheduler.

### J.5 „Wirkt nicht generisch“ (für den strengen Screenshot-Prüfer)

- [ ] **G1 Verbote** (in `installer/src` und `installer/index.html` per grep leer): `backdrop-filter`, `blur(`, `glass`, `radial-gradient`, `linear-gradient` (außer keiner), `box-shadow` (außer Fokus- und Inset-Rändern), `Starfield`, `PulsarLogo`, `bg-gradient-accent`, `shadow-glow`, `text-gradient`, `shadowBlur`, `"lighter"`, `layoutId`.
- [ ] **G2 Eine Akzentfarbe:** Die einzige gesättigte Farbe außerhalb von Hinweisen und Fehlern ist `#F2D53C`. Knöpfe sind nie gelb. Kein Grün, kein Cyan im Installer.
- [ ] **G3 Instrument statt Vorlage:** Jeder Hauptscreenshot (01a–d, 02, 05a–d, 06a, 13c–d) enthält mindestens eine semantische Messgerät-Komponente: beschriftete Skala, Koordinaten oder Messwert mit Einheit. Es gibt keine Karten mit Schatten, Radien > 2 px, Emojis, Partikel, Konfetti oder Druckwellen.
- [ ] **G4 Typografie:** Sichtbar sind nur Inter und IBM Plex Mono. Zahlen und Labels stehen in Mono, Überschriften in Satzschreibung. Keine Ersatz-Glyphen bei Marken (alle SVG).
- [ ] **G5 Ridgeline:**
  - 01c zeigt 16 Zeilen in einem beschrifteten Panel (Achse in ms, Zeilennummern, Σ, `×n ZEITRAFFER`, „SIMULIERTES PROFIL“), kein zentriertes Weiß-auf-Schwarz-Quadrat.
  - 01d zeigt das Zeichen als Linienzeichnung auf einer Haarlinien-Himmelskarte mit RA/Dec-Beschriftung.
- [ ] **G6 Ehrlichkeits-Labels sichtbar:** `INSZENIERT`, `GEMESSEN`, `SIMULIERTES PROFIL`, `SCHEMA · NICHT MASSSTÄBLICH` erscheinen in den passenden Screenshots.
- [ ] **G7 Raster:** Haarlinien bei x 420, y 40 und y 600. Linke Inhaltskanten bei x 24 (Schirm) und x 468 (Bedienfeld). Fußleiste bei y 536.
- [ ] **G8 Ruhe statt HUD:** Der Schirm hat ≤ 12 Textlabels, jede Gruppe im Bedienfeld höchstens 1 Tag. Keine Fadenkreuze, Passermarken, Eckenlabels, Uhr oder Kanal-Leiste.
- [ ] **G9 Bewegungsbilder:**
  - 05b zeigt einen Stern mit Belichtungs-Fächer bzw. Sanduhr und der Marke „VELA“ hervorgehoben.
  - 05d zeigt die Sanduhr und „HÖRBAR ALS · TON“.
  - 06a zeigt das Zeichen im Schirm und „Signal steht.“.
  - 13d zeigt eine eingefrorene Rauschtextur mit „Signal verloren.“.