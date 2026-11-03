# VELOX-Website

Die offizielle Seite von VELOX: eine reine statische Website (HTML, CSS, JavaScript). Kein Build,
keine fremden Server, keine Cookies, kein Tracking. Läuft auf GitHub Pages, Netlify, Cloudflare Pages
oder jedem anderen Webspace.

## Was hier drin ist

| Datei | Inhalt |
|---|---|
| `index.html` | Startseite: Startanimation mit Ton-Knopf, Funktionen mit echten Screenshots, Vergleich „Selbst machen oder VELOX?“, Sicherheit, Download mit Installations-Schritten, FAQ, Changelog |
| `bios.html` | Die Handy-Checkliste zum BIOS-Optimierer (öffnet sich über den QR-Code in VELOX) |
| `impressum.html`, `datenschutz.html` | **Vorlagen** – müssen vor dem Veröffentlichen ausgefüllt werden (siehe unten) |
| `404.html` | Seite für falsche Links |
| `sw.js` | Offline-Speicher nur für die BIOS-Checkliste |
| `brand/` | Kopien aus `velox-tweaker/brand/` (Animation, Ton, Logo, Farben). **Nie hier ändern**, nur in `brand/` und dann neu kopieren |
| `assets/js/config.js` | **Version, Download-Link, Größe** – hier änderst du sie |
| `assets/css/`, `assets/js/` | Aussehen und Verhalten |
| `assets/img/` | Screenshots (WebP), Handy-Bild, Vorschaubild für Social Media (`og.png`) |
| `assets/data/bios/recommendations.json` | Kopie von `velox-tweaker/data/bios/recommendations.json` (Texte der BIOS-Checkliste) |
| `tests/` | Automatische Tests und Bild-Erzeugung (werden nicht gebraucht, um die Seite zu zeigen) |

## Bevor die Seite online geht – das musst du ausfüllen

1. **Impressum** (`impressum.html`): Name, Anschrift, E-Mail und ein zweiter Kontaktweg
   (Telefon oder Kontaktformular). In Deutschland Pflicht (§ 5 DDG). Alle gelb markierten
   `[Platzhalter]` ersetzen und danach den gelben Kasten oben löschen.
2. **Datenschutz** (`datenschutz.html`): Name, Anschrift, E-Mail, die zuständige
   Datenschutz-Aufsichtsbehörde, das Datum („Stand“). Beim Hosting nur den Absatz stehen lassen,
   den du wirklich nutzt (GitHub Pages, Netlify oder Cloudflare). Dann den gelben Kasten löschen.
3. Keine Rechtsberatung: Wenn du unsicher bist, lass beide Seiten kurz prüfen.

## Was du bei einem neuen Release änderst

1. **Version und Download-Link:** in `assets/js/config.js` (`version`, `download`, `size`).
   Die gleiche Versionsnummer steht als Rückfall (für Besucher ohne JavaScript) auch noch an drei
   Stellen in `index.html` – einfach mit „Suchen und Ersetzen“ `1.3.0` durch die neue Nummer ersetzen.
   Der Test (`tests/site-test.mjs`) meldet, wenn etwas nicht zusammenpasst – auch, wenn die Nummer
   nicht zu `velox-tweaker/VERSION` passt.
2. **Changelog:** in `index.html` im Abschnitt `id="changelog"` einen neuen Eintrag oben einfügen und
   `latest` vom alten zum neuen Eintrag verschieben.
3. **Download-Link:** Er zeigt im Moment auf den Branch `claude/new-session-apxmkj`. Wenn alles in
   `main` landet, wird daraus
   `https://github.com/georghatzmann-bit/vanity-/raw/main/velox-tweaker/dist/VeloxSetup.exe`
   (in `config.js` **und** in `index.html` ersetzen). Noch besser auf Dauer: eine GitHub-Release mit
   der `VeloxSetup.exe` als Anhang, dann den Release-Link nehmen.
4. **Zahlen** (472 Tweaks, 9 Presets, 636 Detweak-Stellen, 291/171/10 Risiko-Stufen, 37 Reinigungs­ziele,
   14 Reparatur-Werkzeuge) kommen aus `velox-tweaker/data/`. Ändert sich der Katalog, sagt dir der
   Test genau, welche Zahl auf der Seite nicht mehr stimmt (Elemente mit `data-count="…"` in
   `index.html`, die Balken-Anteile in `assets/css/site.css` bei `.riskbar-track`).
5. **BIOS-Texte geändert?** `velox-tweaker/data/bios/recommendations.json` wieder nach
   `assets/data/bios/recommendations.json` kopieren.
6. **Neue Screenshots?** Aus `velox-tweaker/tests/ui/screenshots/` (neu erzeugen mit
   `node tests/ui/run-ui-tests.mjs --mock`), zuschneiden, damit keine Meldungen unten rechts drauf
   sind, und als WebP speichern, zum Beispiel:
   `convert state-tweak-details.png -crop 1360x845+0+0 +repage -quality 82 assets/img/tweaks-1360.webp`
   und eine kleine Version mit `-resize 760x` als `tweaks-760.webp`.

## Die Adresse der Seite (Site-URL)

Voreingestellt ist `https://georghatzmann-bit.github.io/vanity-/` (GitHub Pages, siehe Weg A unten).
Nimmst du eine andere Adresse, ändere sie hier:

- `index.html` oben: `canonical`, `og:url` und `og:image` (Suchen und Ersetzen der alten Adresse).
- `404.html`: `<base href="/vanity-/">` – das ist der Ordner der Seite auf dem Server. Bei einer
  eigenen Domain oder Netlify/Cloudflare wird daraus `<base href="/">`.
- **In der App:** Der QR-Code des BIOS-Optimierers muss auf `<deine Adresse>/bios.html` zeigen.
  Das ist die Konstante `VELOX_SITE` in `velox-tweaker/ui/js/pages/bios.js`
  (zum Beispiel `https://georghatzmann-bit.github.io/vanity-/bios.html`).

## Veröffentlichen

**Wichtig:** GitHub Pages kann eine Seite nur aus dem **obersten Ordner** (`/`) oder aus dem Ordner
**`/docs`** eines Branches zeigen. `velox-tweaker/website` direkt auszuwählen geht nicht. Kostenlos
geht GitHub Pages nur bei einem **öffentlichen** Repository. Du hast diese Möglichkeiten:

### Weg A: eigener Branch `gh-pages` (empfohlen bei GitHub)

Der Inhalt von `velox-tweaker/website` wird in einen eigenen Branch kopiert, in dem er ganz oben liegt.
Im Ordner `vanity-` in der Kommandozeile:

```
git subtree split --prefix velox-tweaker/website -b gh-pages
git push -f origin gh-pages
git branch -D gh-pages
```

Dann auf GitHub: **Settings → Pages → Build and deployment → Source: „Deploy from a branch“ →
Branch: `gh-pages`, Ordner `/ (root)` → Save.** Nach ein bis zwei Minuten ist die Seite unter
`https://georghatzmann-bit.github.io/vanity-/` erreichbar. Bei jeder Änderung die drei Befehle
wiederholen.

### Weg B: in den Ordner `/docs` kopieren

Den **Inhalt** von `velox-tweaker/website` (nicht den Ordner selbst) in einen Ordner `docs` ganz oben
im Repository kopieren, committen und pushen. Dann **Settings → Pages → Branch `main`, Ordner
`/docs` → Save.** Nachteil: Die Seite liegt dann doppelt im Repository, und du musst nach jeder
Änderung wieder kopieren.

### Weg C: Netlify oder Cloudflare Pages (Drag & Drop, ohne Git)

- **Netlify:** auf <https://app.netlify.com/drop> den Ordner `website` ins Browserfenster ziehen.
- **Cloudflare Pages:** Workers & Pages → Erstellen → Pages → „Direct Upload“ → Ordner hochladen.

Danach in `404.html` `<base href="/">` setzen und die Site-URL wie oben beschrieben anpassen. Eine
eigene Domain (zum Beispiel `velox-tweaker.de`) kannst du bei allen drei Anbietern in den
Einstellungen verbinden.

### Für Fortgeschrittene: GitHub Actions

Unter **Settings → Pages → Source: „GitHub Actions“** kann ein kleiner Workflow den Ordner bei jedem
Push automatisch veröffentlichen. Datei `.github/workflows/pages.yml`:

```yaml
name: Website
on:
  push:
    branches: [main]
    paths: ['velox-tweaker/website/**']
permissions: { contents: read, pages: write, id-token: write }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: '${{ steps.d.outputs.page_url }}' }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-pages-artifact@v3
        with: { path: velox-tweaker/website }
      - id: d
        uses: actions/deploy-pages@v4
```

(Den Ordner `tests/` lädt das mit hoch; er ist harmlos, weil er nur Test-Skripte enthält.)

## Selbst ansehen und testen

Die Seite braucht einen kleinen Webserver – per Doppelklick auf `index.html` startet die Animation
nicht (der Browser verbietet dort Module) und die BIOS-Checkliste lädt ihre Texte nicht. So geht es:

```
cd velox-tweaker/website
python -m http.server 8000        # dann http://localhost:8000/ öffnen
```

Tests (Playwright mit Chromium; prüft alle Seiten hell/dunkel auf PC und Handy, Links, Zahlen,
Version, BIOS-Checkliste inkl. Offline-Betrieb, und speichert Screenshots in `tests/screenshots/`):

```
node velox-tweaker/website/tests/site-test.mjs
node velox-tweaker/website/tests/make-assets.mjs   # Handy-Bild und og.png neu erzeugen
node velox-tweaker/brand/tools/check-copies.mjs    # brand/-Kopien noch identisch?
```

## Regeln, damit die Seite sicher und schnell bleibt

- Keine fremden Schriften, Skripte oder Bilder von anderen Servern, keine Statistik-Dienste.
- Kein JavaScript oder CSS direkt im HTML (die Seiten haben eine strenge Content-Security-Policy).
- Keine erfundenen Bewertungen, Nutzerzahlen, Siegel oder FPS-Versprechen.
- Orange (`#FF5A1F`) nur für die Haupt-Knöpfe, den Fokus-Rahmen und die kleinen „Schnitt“-Striche.
