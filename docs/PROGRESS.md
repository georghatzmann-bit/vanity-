# AEGIS Suite – Fortschritt

Stand: 2026-10-19 · aktuelle Phase: **P0 – Fundament, Design-Tokens, Logo, Start-Animation**

## Werkzeug-Check (Entwicklungs-Container)

| Werkzeug | Gefunden | Bewertung |
| --- | --- | --- |
| Rust / Cargo | 1.97.0 (stable) + Ziel `x86_64-pc-windows-msvc` | ok – Windows-Code wird per `cargo clippy --target …` geprüft (ohne Linken) |
| Node / pnpm | 22.22.0 / 10.28.0 | ok |
| Tauri CLI | 2.12.3 (npm `@tauri-apps/cli`) | ok |
| WebKitGTK (Tauri unter Linux) | 2.52.6 nachinstalliert | ok – nur zum Bauen/Testen im Container |
| WebView2 | **nicht vorhanden** (Linux-Container) | Windows-Teil → GitHub Actions `windows-latest`; Installer lädt WebView2 bei Bedarf nach |
| MSVC Build Tools / Windows SDK | **nicht vorhanden** | bewusst nicht per `xwin` geladen (Microsoft-Lizenz – deine Entscheidung) → CI |
| NSIS | nicht vorhanden | Tauri lädt NSIS beim Windows-Build selbst |
| Chromium (Playwright) | 1194 (= Playwright 1.56.1) | ok – Playwright gepinnt |
| ClamAV / YARA | nicht installiert | erst ab P2 nötig |

## Phasen-Übersicht

| Phase | Inhalt | Status |
| --- | --- | --- |
| P0 | Fundament, Design-Tokens, Logo, Start-Animation | **in Arbeit** |
| P1 | Shell, Dashboard, Design-System | offen |
| P2 | Dienst + Pipe + Engine-Kern (ClamAV, Hashes, YARA-X, statische Analyse), Quarantäne | offen |
| P3 | Echtzeit-Wächter, Heuristik, Cheat-Logik, Whitelist, Dokument/Skript/Archiv, Berichte | offen |
| P4 | Sandbox Stufe 1+2 + Verhaltensbericht | offen |
| P5 | Panic-Button, Speicher-Scan, Ransomware-Schutz, Datei-Safe | offen |
| P6 | Härtung, Persistenz, Treiber-Check, Kamera/Mikro/Zwischenablage/USB-Wächter | offen |
| P7 | Netzwerk, Firewall-Übersicht, Web-Schutz, Heimnetz, Leck-Check | offen |
| P8 | Defender-Schalter | offen |
| P9 | Tresor + Erweiterung | offen |
| P10 | Tools 1–11 | offen |
| P11 | Tools 12–22 + Animations-Feinschliff | offen |
| P12 | Privacy-Browser | offen |
| P13 | Setup-Bootstrapper, Uninstaller, Updater, Abschlusstests, deutsches README | offen |
| P14 | optional: ML-Modell, AMSI-Beobachter, Browser-Sandbox | offen |

## P0 – Plan

1. [x] Werkzeuge prüfen, Linux-Abhängigkeiten für Tauri nachinstallieren
2. [x] Monorepo: pnpm-Workspace, Cargo-Workspace (Edition 2024, strikte Lints), Ordnerstruktur
3. [x] Tauri-2-Grundgerüst `apps/desktop` (strikte CSP, minimale Capabilities, NSIS currentUser)
4. [x] CLAUDE.md, PROGRESS.md, ARCHITECTURE.md, SECURITY.md, DECISIONS.md, LICENSES.md
5. [ ] `crates/core`: Goldene Regel als Typ (`ActionPlan`, `ConsentGate`, `Approval`,
       Doppel-Bestätigung, Ablauf = nichts tun), Prüfprotokoll mit Hash-Kette, Risikostufen,
       Zustands-Schnappschuss für „Nichts ohne Ja“-Tests, Mutations-Sperre (clippy + Allowlist-Test)
6. [ ] `packages/ui`: Design-Tokens (dunkel/hell, Risikostufen, Motion), Kontrast-Tests,
       eigenes SVG-Logo, Start-Animation (~1,5 s, überspringbar, reduzierte Bewegung),
       dezenter UI-Sound (abschaltbar), Showcase-Seite
7. [ ] `apps/desktop`: Start-Animation einbinden, App-Icons aus dem Logo, Vitest + Playwright
       (inkl. „keine Konsolenfehler“ und CSP wie in Tauri)
8. [x] CI (GitHub Actions): Linux (lint, typecheck, vitest, e2e, clippy, tests) + Windows
       (clippy, cargo test, Tauri-NSIS-Build)
9. [ ] Security-Review (separater Agent) für `crates/core` + Tauri-Konfiguration
10. [ ] Definition of Done P0 prüfen, PROGRESS aktualisieren, Commit + Push

## Offene Fragen an dich (Richtungsentscheidungen)

- **Projektlizenz** (z. B. proprietär, MIT, GPL-3.0)? Bis dahin: keine Lizenzangabe, `publish = false`.
- **Code-Signing-Zertifikat** (kostet Geld) – wird vorbereitet, nicht vorausgesetzt (P13).
- Hinweis: Das Repo ist öffentlich → GitHub Actions (auch `windows-latest`) ist kostenlos. Die CI läuft bei jedem Push auf `main` und `claude/**`.

## Nächster Schritt

Umsetzung P0 Schritte 5–10.
