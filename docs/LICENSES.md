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
