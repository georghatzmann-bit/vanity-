#!/usr/bin/env python3
"""Setzt TweakWerk aus src/ zusammen und packt Gratis- und Pro-Version.

Aufruf:  python3 build.py
Ergebnis: dist/TweakWerk-Free.zip und dist/TweakWerk-Pro.zip
          (jeweils Ordner "TweakWerk" mit TweakWerk.ps1, Start.bat, LIES-MICH.txt)
"""
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
DIST = ROOT / "dist"

# Link zur Verkaufsseite der Pro-Version (z. B. Gumroad oder Lemon Squeezy). Leer = "bald verfuegbar".
PRO_URL = ""

PARTS = ["00-header.ps1", "10-core.ps1", "20-tweaks.ps1", "30-tools.ps1"]
PRO_PARTS = ["pro/40-pro-tweaks.ps1", "pro/41-startup.ps1"]
UI_PARTS = ["60-ui.ps1", "99-main.ps1"]

START_BAT = """@echo off
rem Startet TweakWerk. Windows fragt einmal nach Administratorrechten.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0TweakWerk.ps1"
"""

README = """TweakWerk {version} ({edition})
==============================

STARTEN
1. ZIP-Datei mit Rechtsklick -> Eigenschaften -> unten "Zulassen" anhaken -> OK.
   (Sonst warnt Windows beim Start, weil die Datei aus dem Internet kommt.)
2. ZIP entpacken (Rechtsklick -> Alle extrahieren).
3. Doppelklick auf "Start.bat" und bei der Windows-Abfrage "Ja" klicken.

Falls "Der Computer wurde durch Windows geschuetzt" erscheint:
"Weitere Informationen" -> "Trotzdem ausfuehren".
Das passiert bei allen neuen Programmen ohne teures Signatur-Zertifikat.
Der komplette Code steht lesbar in TweakWerk.ps1. Du kannst ihn mit dem Editor oeffnen.

SICHERHEIT
- Vor der ersten Aenderung bietet TweakWerk einen Wiederherstellungspunkt an. Nimm ihn!
- Jede Aenderung wird gesichert und kann im Bereich "Sicherung" rueckgaengig gemacht werden.
- Sicherung und Protokoll liegen in: %LOCALAPPDATA%\\TweakWerk

SYSTEM
Windows 10 oder 11, 64 Bit. Benoetigt nichts extra (nutzt das eingebaute Windows PowerShell).
"""


def read(rel: str) -> str:
    return (SRC / rel).read_text(encoding="utf-8")


def version() -> str:
    for line in read("00-header.ps1").splitlines():
        if line.startswith("$script:AppVersion"):
            return line.split("'")[1]
    raise SystemExit("AppVersion nicht gefunden")


def bundle(edition: str) -> str:
    parts = PARTS + (PRO_PARTS if edition == "Pro" else [])
    xaml = read("50-ui.xaml")
    if "\n'@" in xaml:
        raise SystemExit("XAML darf keine Zeile enthalten, die mit '@ beginnt")
    chunks = [read(p) for p in parts]
    chunks.append("# ------------------------------------------------------------------ Oberflaeche (XAML)\n"
                  "$script:Xaml = @'\n" + xaml.rstrip("\n") + "\n'@\n")
    chunks += [read(p) for p in UI_PARTS]
    text = "\n".join(chunks)
    text = text.replace("__EDITION__", edition).replace("__PRO_URL__", PRO_URL)
    return text


def crlf(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\n", "\r\n")


def main() -> None:
    ver = version()
    DIST.mkdir(exist_ok=True)
    for edition in ("Free", "Pro"):
        folder = DIST / f"TweakWerk-{edition}"
        folder.mkdir(exist_ok=True)
        files = {
            # UTF-8 MIT BOM: sonst liest Windows PowerShell 5.1 die Umlaute falsch
            "TweakWerk.ps1": crlf(bundle(edition)).encode("utf-8-sig"),
            "Start.bat": crlf(START_BAT).encode("ascii"),
            "LIES-MICH.txt": crlf(README.format(version=ver, edition=edition)).encode("utf-8-sig"),
        }
        for name, data in files.items():
            (folder / name).write_bytes(data)
        zip_path = DIST / f"TweakWerk-{edition}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for name, data in files.items():
                zf.writestr(f"TweakWerk/{name}", data)
        print(f"{zip_path.relative_to(ROOT)}  ({zip_path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
