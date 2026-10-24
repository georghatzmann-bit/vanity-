# ⚡ TweakWerk: ehrlicher Gaming-Optimizer für Windows

*(Arbeitstitel, vor dem Verkauf Namen prüfen, siehe unten)*

**Die Idee:** Ein FPS- und Ping-Optimizer für junge Gamer, aber **ehrlich**. Keine „+200 FPS“-Lügen, kein Abschalten von Virenschutz, und jede Änderung lässt sich mit einem Klick rückgängig machen.
Genau das unterscheidet uns von den vielen dubiosen Tweakern auf TikTok und Discord. Es ist gleichzeitig unser bestes Verkaufsargument.

**Modell:** Gratis-Version (für Reichweite) + Pro-Version für **4,99 € einmalig**.

---

## 🧪 DEIN JOB JETZT: Testen auf Windows 11 (ca. 15 Minuten)

Ich kann hier nur Linux ausführen. Die Logik ist mit 49 automatischen Tests geprüft und die Kompatibilität mit Windows PowerShell 5.1 ist bestätigt. **Die echte Oberfläche auf Windows hat aber noch niemand gesehen.** Du bist der erste Tester.

1. **Pro-Version herunterladen** (enthält alles):
   https://github.com/georghatzmann-bit/vanity-/raw/claude/loving-hopper-krzr0l/tweaker/dist/TweakWerk-Pro.zip
2. ZIP mit Rechtsklick → **Eigenschaften** → unten **„Zulassen“** anhaken → OK. Dann entpacken.
3. **`Start.bat`** doppelklicken → Windows fragt nach Adminrechten → **Ja**.
   (Falls „Der Computer wurde durch Windows geschützt“ kommt: „Weitere Informationen“ → „Trotzdem ausführen“.)

**Dann diese Liste abhaken:**

- [ ] Fenster öffnet sich, Übersicht zeigt deine echte CPU, GPU und RAM
- [ ] **Wiederherstellungspunkt erstellen** → im Protokoll unten steht ✔
- [ ] **Gaming:** jeden Schalter einmal **an** und wieder **aus**. Im Protokoll darf kein ✖ stehen.
      Beim Energieplan prüfen: Windows-Einstellungen → System → Energie zeigt „TweakWerk Gaming“
- [ ] **Netzwerk:** „Ping testen“ zeigt Werte für Frankfurt, Irland usw.
- [ ] **Aufräumen:** „Jetzt aufräumen“ zeigt freigegebene MB
- [ ] **Autostart:** Liste ähnelt der im Task-Manager (Strg+Umschalt+Esc → Autostart). Einen Eintrag ausschalten → Task-Manager zeigt „Deaktiviert“ → wieder einschalten
- [ ] **Spiel hinzufügen:** eine Spiel-.exe auswählen → Windows-Einstellungen → System → Anzeige → Grafik zeigt sie mit „Hohe Leistung“
- [ ] **Sicherung → „Alle Änderungen rückgängig machen“** → alle Schalter gehen zurück

**Schick mir danach:**
- Screenshots von 2–3 Bereichen (die brauchen wir auch für die Werbung!)
- Falls etwas nicht geht: den Inhalt von `%LOCALAPPDATA%\TweakWerk\log.txt` (in die Explorer-Adressleiste eintippen)

Dann fixe ich alles, bevor wir auch nur einen Euro verlangen.

---

## ✅ Was drin ist

| Bereich | Gratis | Pro |
|---|:---:|:---:|
| System-Übersicht (CPU, GPU, RAM, Laufwerk) | ✔ | ✔ |
| Wiederherstellungspunkt + „Alles rückgängig“ | ✔ | ✔ |
| Energieplan „Ultimative Leistung“ | ✔ | ✔ |
| Windows-Spielmodus | ✔ | ✔ |
| Xbox-Hintergrundaufnahme aus | ✔ | ✔ |
| Mausbeschleunigung aus (sofort aktiv, ohne Neustart) | ✔ | ✔ |
| Ping-Test zu EU/US-Rechenzentren (mit Jitter & Paketverlust) | ✔ | ✔ |
| Temp-Dateien aufräumen (nur älter als 24 h, mit Sicherheitsnetz) | ✔ | ✔ |
| „Empfohlene Einstellungen“ mit 1 Klick | ✔ | ✔ (mehr Tweaks) |
| Autostart-Manager | | ✔ |
| Spiele auf der starken Grafikkarte (Laptops mit 2 GPUs) | | ✔ |
| Hardware-beschleunigte GPU-Planung (für DLSS Frame Gen) | | ✔ |
| Update-Upload an fremde PCs aus | | ✔ |
| Schneller DNS (Cloudflare) | | ✔ |

In der Gratis-Version sind die Pro-Funktionen als gesperrte Vorschau mit „Pro freischalten“-Knopf sichtbar. Der Pro-Code ist dort gar nicht erst enthalten, man kann ihn also nicht einfach freischalten.

**Bewusst NICHT drin** (Placebo oder gefährlich): Defender, Firewall oder Updates abschalten, Prefetch löschen, „Nagle-Tweaks“ (bringen bei modernen Spielen nichts), Spectre-Schutz aus.

---

## 💰 Das Business

### Verkaufsweg
1. **Gratis-Version** auf **Gumroad** für „0 € oder was du willst“. Wer sie lädt, hinterlässt seine E-Mail, und du baust dir eine Liste von Gamern auf.
2. **Pro-Version** für **4,99 €** auf Gumroad oder **Lemon Squeezy**. Beide liefern die Datei automatisch aus und kümmern sich um Zahlung und EU-Umsatzsteuer. Aktuelle Gebühren vor dem Start auf der jeweiligen Seite prüfen.
3. Den Shop-Link trägst du in `build.py` bei `PRO_URL` ein (oder sagst ihn mir), dann führt der „Pro freischalten“-Knopf direkt dorthin.

### Werbung (TikTok / YouTube Shorts / Discord)
Unser Winkel ist **Ehrlichkeit**. Der fällt auf, weil alle anderen übertreiben:
- „Ich hab die 10 bekanntesten FPS-Tweaks getestet. Nur 4 bringen wirklich was.“
- „Dieser ‚FPS-Booster‘ schaltet heimlich deinen Virenschutz aus 😬“ (Aufklärung → unser Tool als sichere Alternative)
- „Laptop-Gamer: Dein Spiel läuft vielleicht auf der falschen Grafikkarte“ (Pro-Feature)
- „Ping-Test: So siehst du in 10 Sekunden, ob dein WLAN schuld ist“
- Vorher/Nachher-Videos **nur mit echten Messwerten**, z. B. mit dem FPS-Overlay von Nvidia, AMD oder Steam.

**Wichtig:** Keine FPS-Zahlen versprechen, die du nicht selbst gemessen hast. Das ist in Deutschland irreführende Werbung (UWG), und es bringt Rückbuchungen und schlechte Bewertungen.

### Ehrliche Erwartung
- Die Konkurrenz ist groß und teils gratis (z. B. Chris Titus' WinUtil, Hone). Wir gewinnen über **Vertrauen, einfache Bedienung und deutsche Sprache**, nicht über Wunder.
- Realistisch: Die ersten Wochen bringen eher Downloads der Gratis-Version als Verkäufe. Bei 1.000 Gratis-Downloads und 3 % Kaufquote wären das 30 Verkäufe, also ca. 130 € nach Gebühren.
- Der Hebel ist Reichweite. Ein viraler TikTok kann 10.000+ Downloads bringen.

### Bevor du Geld verlangst (Checkliste)
- [ ] Test oben bestanden, alle Fehler gefixt
- [ ] **Name prüfen:** „TweakWerk“ beim DPMA (register.dpma.de) und EUIPO suchen. Ich ändere den Namen dann mit einem Befehl überall.
- [ ] **Unter 18?** Gumroad, Lemon Squeezy und das Gewerbe laufen dann über deine Eltern
- [ ] **Gewerbe anmelden** (siehe `business/README.md`, gleiche Schritte wie beim Finanzplaner)
- [ ] **Repo auf privat stellen** (siehe unten!)
- [ ] Später, wenn es läuft: **Code-Signing-Zertifikat** (ca. 200–400 €/Jahr). Dann verschwindet die Windows-Warnung beim Start.

### ⚠️ Repo ist öffentlich
Dieses GitHub-Repo ist **öffentlich**. Jeder kann die Pro-Version (und den Finanzplaner) gratis herunterladen.
**Fix (1 Minute):** GitHub → Repo `vanity-` → **Settings** → ganz unten **„Change visibility“** → **Private**.
Das versteckt auch alles, was schon hochgeladen wurde.

---

## 🛣️ Nächste Ausbaustufen (sag „Boss, weiter mit TweakWerk“)
1. **Fixes aus deinem Test**
2. **Lizenzschlüssel** für Pro (über die Gumroad- oder Lemon-Squeezy-Lizenz-API), damit die Pro-Datei nicht einfach weitergegeben werden kann
3. **Eingebauter FPS-Benchmark vorher/nachher** (über PresentMon von Intel, Open Source). Damit hätten wir echte Zahlen statt Versprechen, und das hat sonst kaum ein Tweaker.
4. **Spiel-Profile:** Vor dem Zocken Launcher und Browser automatisch schließen
5. **Englische Version** → 10× größerer Markt
6. **Landingpage** (wie beim Finanzplaner, diesmal im Gamer-Design)

---

## 🛠️ Technik

```
tweaker/
├── src/                  ← Quellcode in Teilen (PowerShell + WPF-Oberfläche)
│   ├── 10-core.ps1       ← Registry, Sicherung, Rückgängig-Engine
│   ├── 20-tweaks.ps1     ← Gratis-Tweaks
│   ├── 30-tools.ps1      ← System-Info, Wiederherstellungspunkt, Aufräumen, Ping
│   ├── pro/              ← Pro-Funktionen (nur in der Pro-Version enthalten)
│   ├── 50-ui.xaml        ← Oberfläche
│   └── 60-ui.ps1         ← Oberflächen-Logik
├── tests/                ← 49 automatische Tests (Pester)
├── build.py              ← baut dist/TweakWerk-Free.zip und dist/TweakWerk-Pro.zip
└── dist/                 ← fertige ZIPs
```

```bash
python3 build.py                              # beide Versionen bauen
pwsh -c "Invoke-Pester ./tests"               # Tests
```

Warum PowerShell statt .exe? Der Code bleibt lesbar (jeder kann reinschauen, ob er sauber ist), läuft auf jedem Windows 10/11 ohne Installation, und Virenscanner schlagen seltener an als bei unsignierten .exe-Dateien.
