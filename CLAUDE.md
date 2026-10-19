# AEGIS Suite – Arbeitsregeln für Claude

Defensiver Virenschutz + Sicherheits- & Windows-Toolkit für Windows 10/11 x64.
Tauri 2 (Rust) + React + TypeScript + Vite. Monorepo (pnpm + Cargo-Workspace).
Fortschritt: `docs/PROGRESS.md` · Architektur: `docs/ARCHITECTURE.md` · Sicherheit: `docs/SECURITY.md`
· Entscheidungen: `docs/DECISIONS.md` · Fremdlizenzen: `docs/LICENSES.md`.

## GOLDENE REGEL (über allem)

Der Schutzbereich verändert, verschiebt, beendet oder löscht **nichts** ohne ausdrückliche
Bestätigung des Nutzers. Ohne „Ja“ nur: scannen, melden, erklären.

- Jede verändernde Funktion verlangt eine `aegis_core::consent::ExecutionPermit` **als Wert**
  und liest ihre Ziele nur aus `permit.plan()`. Die Erlaubnis entsteht nur über
  `approval.redeem(&plan, gate.clock())`; eine `Approval` nur in `ConsentGate::decide` aus der
  Nutzerentscheidung „Ja, ausführen“ für genau diesen Plan (Digest-gebunden, einmalig, läuft ab).
  Nach der Ausführung: `permit.complete(result)` → Audit-Ereignis.
- Vor jeder Aktion ein `ActionPlan`: Was genau? Warum? Was passiert dann? Rückgängig wie?
  Antworten: Ja, ausführen / Nein / Ignorieren / Vertrauen. Keine Reaktion = nichts tun.
- Endgültiges Löschen: zweite, getrennte Bestätigung (`PermanentDeleteApproval`).
  Kein automatisches Löschen, auch nicht nach Fristen – nur Erinnerungen.
- Gilt auch für „Gefährlich“, Echtzeit-Wächter, Panic-Button, Hintergrundprozesse.
- Verändernde std-APIs sind per `clippy.toml` (`disallowed-methods`) gesperrt (Windows-APIs
  werden ergänzt, sobald `windows`/`windows-sys` dazukommen). Ausnahme nur mit eng gesetztem
  `#[allow(clippy::disallowed_methods)]` + Markierung `// aegis-mutation: <kennung>` +
  Eintrag in `crates/core/mutation-allowlist.txt` (Test `mutation_guard` erzwingt das).
  Testcode legt Dateien nur über `aegis_core::testing` an (Feature `testing`, nur dev-deps).
- Tools (Modul J) handeln nur nach vom Nutzer angelegten und aktivierten Regeln –
  immer mit Vorschau, Protokoll, Rückgängig.

## Weitere harte Regeln

- Rein defensiv: keine Malware-Techniken, keine fremden Browser-Passwörter auslesen,
  keine Tricks gegen Windows-Schutzfunktionen (Manipulationsschutz nie umgehen).
- Tests NUR mit EICAR (zur Laufzeit erzeugt, nie als Datei eingecheckt), selbst erzeugten
  harmlosen Dummy-Dateien und harmlosen Simulatoren in Test-/Temp-Ordnern.
  Niemals echte Malware laden, erzeugen oder nachbauen.
- Keine Telemetrie. Netzwerk nur für Updates/Signaturen/optionale Dienste, alles abschaltbar.
  Keine CDNs zur Laufzeit (Schriften etc. werden lokal gebündelt).
- Admin-Rechte nur gezielt (Dienst, einzelne Aktionen mit UAC). Die App läuft als Nutzer.
- ClamAV ist GPL: nur als getrennter Prozess ansprechen, nie einlinken.
- Fremde Listen/Regeln/Modelle/Schriften: Lizenz + Herkunft in `docs/LICENSES.md`, vorher prüfen.
- Ehrlich in der UI: kein Kernel-Treiber → AEGIS erkennt, warnt, isoliert auf Wunsch;
  blockiert Programme nicht vor dem Start.

## Struktur

```
apps/desktop        Tauri-App (src/ = React, src-tauri/ = Rust)
apps/setup          AEGIS-Setup.exe Bootstrapper (P13)
apps/browser        Privacy-Browser (P12)
extensions/vault    MV3-Erweiterung Passwort-Tresor (P9)
extensions/webshield MV3-Erweiterung Web-Schutz (P7)
crates/core         Goldene Regel, Aktionspläne, Prüfprotokoll, Risikostufen
crates/engine|service|sandbox|hardening|netwatch|vault-core|tools|defender-switch
packages/ui         Design-System: Tokens, Logo, Start-Animation, Showcase
rules/              YARA, Whitelist, Kategorien (nur lizenziert)
tests/fixtures      nur harmlose Dateien
docs/               ARCHITECTURE, SECURITY, PROGRESS, DECISIONS, LICENSES
```

## Befehle

```bash
pnpm install                       # Abhängigkeiten
pnpm check                         # lint + typecheck + vitest + fmt + clippy + cargo test
pnpm lint | pnpm typecheck | pnpm test | pnpm build
pnpm test:e2e                      # Playwright (Chromium)
pnpm rust:check                    # cargo fmt --check, clippy -D warnings, cargo test
pnpm rust:check:windows            # clippy gegen x86_64-pc-windows-msvc (ohne Linken)
pnpm --filter @aegis/ui dev        # Design-System-Showcase
pnpm --filter @aegis/desktop tauri dev   # App starten (Windows bzw. Linux mit webkit2gtk)
cargo llvm-cov -p aegis-core       # Abdeckung (Ziel ≥ 80 % für kritische Module)
```

## Konventionen

- Code-Bezeichner Englisch; Kommentare, Docs, UI-Texte Deutsch (Englisch als 2. Sprache).
- Rust: Edition 2024, Workspace-Lints (`unsafe_code = deny`; Windows-FFI nur lokal erlaubt
  mit `// SAFETY:`), kein `unwrap/expect` außerhalb von Tests. Windows-Code hinter `cfg(windows)`.
- TypeScript strikt (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`).
- Design: Tokens aus `packages/ui/src/tokens` – keine hart codierten Farben in Komponenten.
  Animationen nur über `transform`/`opacity` (Ausnahme: SVG-Linien zeichnen), 60 fps,
  `prefers-reduced-motion` respektieren, alles per Tastatur bedienbar, Kontrast ≥ WCAG AA.
  Verboten: KI-Videos, Video-Hintergründe, Konfetti, Kitsch.
- Nach jeder Änderung: bauen, Linter, Tests. Fehler an der Ursache beheben, nie Tests abschalten.
- Ein Commit pro fertigem Schritt (deutsche Commit-Nachricht, Präfix `P<n>:`).
- Nach jedem Meilenstein `docs/PROGRESS.md` aktualisieren (erledigt / offen / nächster Schritt).
- Sicherheits-Code (consent, Quarantäne, Krypto, Dienst/Pipe, Sandbox) von separatem
  Review-Agenten prüfen lassen.

## Umgebung

Entwickelt wird oft in einem Linux-Container (kein WebView2/MSVC). Windows-spezifischer Code
wird dort mit `pnpm rust:check:windows` geprüft; echte Windows-Builds/Tests laufen in
GitHub Actions (`windows-latest`). Playwright ist auf 1.56.1 gepinnt (passt zum
vorinstallierten Chromium im Container).
