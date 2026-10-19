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
| AEGIS-eigene YARA-Regeln `rules/yara/aegis-builtin.yar` | AEGIS | wie das Projekt | eingebaute Regeln (inkl. Spiel-Tool- und Merkmals-Regeln, P3) | 2026-10-19 |
| YARA-X-Module vba/olecf/zip (codepage, encoding_rs, tinyzip) | VirusTotal/yara-x u. a. | BSD-3-Clause; MIT/Apache-2.0; encoding_rs zusätzlich BSD-3-Clause (WHATWG-Daten) | Office-Makros lesen (P3) | 2026-10-19 |
| zip 9.0 (nur Deflate/Deflate64) | zip-rs | MIT | Archive prüfen (P3) | 2026-10-19 |
| sevenz-rust2 0.24 (ohne Verschlüsselung/Packen) + lzma-rust2 | hasenbanck | Apache-2.0 | 7z prüfen (P3) | 2026-10-19 |
| cab 0.6 + lzxd | mdsteele / jbit | MIT; MIT/Apache-2.0 | CAB prüfen (P3) | 2026-10-19 |
| flate2, miniz_oxide, tar | rust-lang / Frommi / alexcrichton | MIT/Apache-2.0 (miniz_oxide auch Zlib) | GZIP/TAR, PDF-Datenströme (P3) | 2026-10-19 |
| notify 8.2 (+ notify-types) | notify-rs | CC0-1.0; MIT/Apache-2.0 | Echtzeit-Wächter: Dateiänderungen (P3) | 2026-10-19 |
| ferrisetw 1.2 (+ windows 0.62) | n4r1b / Microsoft | MIT/Apache-2.0 | Echtzeit-Wächter: Programmstarts über ETW (P3) | 2026-10-19 |
| argon2 0.6 (+ blake2, password-hash) | RustCrypto | MIT/Apache-2.0 | Datei-Safe: Schlüssel aus dem Passwort (Argon2id, P5) | 2026-10-19 |
| wmi 0.18 (+ futures 0.3) | ohadravid / rust-lang | MIT/Apache-2.0 | Härtung: WMI-Abfragen nur lesend (BitLocker, TPM, Defender, Sicherheitscenter, Updates; P6) | 2026-10-19 |
| axe-core / @axe-core/playwright 4.14 | Deque | MPL-2.0 | nur Tests, nicht ausgeliefert | 2026-10-19 |
| Block List Project – ransomware, scam (P7.3) | github.com/blocklistproject/Lists | Unlicense (Repository-Lizenz; die Kopfzeilen der Listen nennen MIT – beides frei, Herkunft wird genannt) | gebündelt als `extensions/webshield/public/rules/bundled.json` (Skript `update-webshield-lists.mjs`) | 2026-10-19 |
| Block List Project – phishing, fraud (P7.3) | github.com/blocklistproject/Lists | Unlicense / MIT (wie oben) | von der Erweiterung zur Laufzeit geladen (abschaltbar) | 2026-10-19 |
| Phishing.Database (P7.3) | github.com/Phishing-Database/Phishing.Database | MIT | `phishing-domains-ACTIVE.txt`, von der Erweiterung zur Laufzeit geladen (abschaltbar) | 2026-10-19 |
| @types/chrome 0.3 | DefinitelyTyped | MIT | nur Typen beim Bau der Erweiterung | 2026-10-19 |
| Have I Been Pwned – Pwned Passwords (P7.5) | haveibeenpwned.com (Troy Hunt) | CC BY 4.0 (Namensnennung in der App) | Range-API mit k-Anonymität, nur auf Knopfdruck, nichts gebündelt | 2026-10-19 |
| Have I Been Pwned – API v3 breachedaccount (P7.5) | haveibeenpwned.com | API-Nutzungsbedingungen, eigener kostenpflichtiger Schlüssel des Nutzers, Namensnennung | E-Mail-Prüfung nur mit Nutzer-Schlüssel, nicht gespeichert | 2026-10-19 |

Rust- und npm-Abhängigkeiten werden ab P13 automatisch inventarisiert (`cargo about` /
Lizenz-Report) und hier zusammengefasst.

## Geplant – vor Nutzung zu prüfen

| Komponente | Lizenz (zu prüfen) | Hinweis |
| --- | --- | --- |
| ClamAV + freshclam (P2) | GPL-2.0 | Nur als getrennter Prozess, nie eingelinkt; Signaturen: Cisco-Talos-Bedingungen |
| abuse.ch MalwareBazaar / URLhaus / ThreatFox (P2/P7) | CC0 / Nutzungsbedingungen, API-Key nötig | Bedingungen + Rate-Limits prüfen |
| YARA-Regelsätze (P2) | je Satz verschieden (z. B. DRL, GPL, MIT) | nur Sätze mit passender Lizenz |
| YARA-X (P2) | BSD-3-Clause | Rust-Crate |
| iptoasn.com ip2country (P7.1) | Public Domain (PDDL v1.0, geprüft 2026-10-19) | Länderzuordnung von IP-Bereichen → `rules/geo/ip-country.bin` (Skript `scripts/update-geoip.mjs`, zusammengefasst, IPv6 auf 64 Bit) |
| LOLDrivers (P6.4) | Apache-2.0 (geprüft 2026-10-19, keine NOTICE-Datei) | Nur Prüfsummen + Kurzangaben aus `loldrivers.io/api/drivers.json` → `rules/drivers/loldrivers.tsv` (Skript `scripts/update-loldrivers.mjs`), Lizenztext in `rules/drivers/LICENSE-LOLDrivers.txt`; keine Treiberdateien |
| EasyList / EasyPrivacy (P12) | GPL-3.0 / CC BY-SA 3.0 | Listen getrennt laden |
| URLhaus (abuse.ch) für P7.3 | Konto + kommerzielle Bedingungen | **abgelehnt** (2026-10-19): Download nur mit Anmeldung, Bedingungen für Weitergabe unklar |
| VirusTotal API (P2) | VT-Nutzungsbedingungen | eigener API-Key, 4/Min & 500/Tag |
| ONNX-Modell (P14) | je Modell | nur öffentliche, lizenzierte Modelle |
| Arti (Tor, P12) | MIT / Apache-2.0 | optional |
