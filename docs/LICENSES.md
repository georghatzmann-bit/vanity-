# Fremdlizenzen & Herkunft

Jede fremde Liste, Regel, Datenquelle, Schrift, jedes Modell und jede gebündelte Komponente
wird hier **vor** der Nutzung eingetragen (Name, Herkunft, Lizenz, Nutzungsart, Prüfdatum).

## Gebündelt / eingebunden

| Komponente | Herkunft | Lizenz | Nutzung | Geprüft |
| --- | --- | --- | --- | --- |
| Inter Variable | rsms/inter via `@fontsource-variable/inter` 5.3.0 | SIL OFL 1.1 | UI-Schrift, lokal gebündelt | 2026-10-19 |
| JetBrains Mono | JetBrains via `@fontsource-variable/jetbrains-mono` 5.3.0 | SIL OFL 1.1 | Monospace (Hashes, Pfade) | 2026-10-19 |
| Tauri 2 | tauri-apps | MIT / Apache-2.0 | App-Rahmen | 2026-10-19 |
| React 19, Motion, Vite, Tailwind CSS | npm | MIT | UI | 2026-10-19 |
| tauri-plugin-single-instance 2.5.4 | tauri-apps | MIT / Apache-2.0 | nur eine laufende Instanz | 2026-10-19 |
| rfd 0.17 | PolyMeilex/rfd | MIT | Fehlerdialog bei Startfehlern (Windows) | 2026-10-19 |
| YARA-X 1.21 (nur ausgewählte Module) | VirusTotal/yara-x | BSD-3-Clause | Regel-Engine (P2) | 2026-10-19 |
| goblin 0.10 (nur PE) | m4b/goblin | MIT | PE-Analyse (P2) | 2026-10-19 |
| wasmtime 45 / cranelift (über yara-x) | Bytecode Alliance | Apache-2.0 WITH LLVM-exception | Regel-Ausführung in YARA-X | 2026-10-19 |
| AEGIS-eigene YARA-Regeln `rules/yara/aegis-builtin.yar` | AEGIS | wie das Projekt | eingebaute Regeln | 2026-10-19 |
| axe-core / @axe-core/playwright 4.14 | Deque | MPL-2.0 | nur Tests, nicht ausgeliefert | 2026-10-19 |

Rust- und npm-Abhängigkeiten werden ab P13 automatisch inventarisiert (`cargo about` /
Lizenz-Report) und hier zusammengefasst.

## Geplant – vor Nutzung zu prüfen

| Komponente | Lizenz (zu prüfen) | Hinweis |
| --- | --- | --- |
| ClamAV + freshclam (P2) | GPL-2.0 | Nur als getrennter Prozess, nie eingelinkt; Signaturen: Cisco-Talos-Bedingungen |
| abuse.ch MalwareBazaar / URLhaus / ThreatFox (P2/P7) | CC0 / Nutzungsbedingungen, API-Key nötig | Bedingungen + Rate-Limits prüfen |
| YARA-Regelsätze (P2) | je Satz verschieden (z. B. DRL, GPL, MIT) | nur Sätze mit passender Lizenz |
| YARA-X (P2) | BSD-3-Clause | Rust-Crate |
| LOLDrivers (P6) | Apache-2.0 (zu bestätigen) | Treiberliste |
| EasyList / EasyPrivacy (P12) | GPL-3.0 / CC BY-SA 3.0 | Listen getrennt laden |
| Phishing-/Malware-Domainlisten (P7) | je Liste | z. B. URLhaus, Phishing.Database |
| Have I Been Pwned Range-API (P7/P9) | API-Bedingungen | k-Anonymität, nur Hash-Präfix |
| VirusTotal API (P2) | VT-Nutzungsbedingungen | eigener API-Key, 4/Min & 500/Tag |
| ONNX-Modell (P14) | je Modell | nur öffentliche, lizenzierte Modelle |
| Arti (Tor, P12) | MIT / Apache-2.0 | optional |
