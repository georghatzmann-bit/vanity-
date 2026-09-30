"""Mikrofon per Nummer auswählen, kurz testen und in config.toml speichern."""

from __future__ import annotations

import time

from .audio import Microphone, input_devices, rms
from .config import save_setting

# Einträge, hinter denen sich nur "das Windows-Standardmikrofon" verbirgt.
_ALIASES = ("sound mapper", "soundmapper", "primärer soundaufnahmetreiber", "primary sound capture")


def choices(devices: list[dict]) -> list[dict]:
    """Jedes Mikrofon nur einmal: Windows listet dasselbe Gerät für mehrere Treiber auf.
    MME reicht und funktioniert am zuverlässigsten."""
    mme = [d for d in devices if d["hostapi"] == "MME"]
    pool = mme or devices
    seen = set()
    result = []
    for d in pool:
        name = d["name"].strip()
        if any(alias in name.lower() for alias in _ALIASES) or name in seen:
            continue
        seen.add(name)
        result.append(d)
    return result


def level_check(device_name: str | None, seconds: float = 4.0) -> float:
    """Zeigt ein paar Sekunden den Pegel an und gibt den lautesten Wert zurück."""
    mic = Microphone(device_name)
    loudest = 0.0
    end = time.monotonic() + seconds
    with mic:
        while time.monotonic() < end:
            level = rms(mic.read())
            loudest = max(loudest, level)
            bar = "#" * min(40, int(level / 100))
            print(f"\r  Pegel |{bar:<40}|", end="", flush=True)
    print()
    return 0.0 if mic.peak == 0 else loudest


def run() -> None:
    options = choices(input_devices())
    print("Welches Mikrofon soll Jarvis benutzen?\n")
    print("   0  Windows-Standardmikrofon")
    for number, d in enumerate(options, start=1):
        print(f"  {number:>2}  {d['name']}")

    while True:
        answer = input("\nNummer eingeben und Enter drücken: ").strip()
        if answer.isdigit() and 0 <= int(answer) <= len(options):
            break
        print("Bitte eine der Nummern aus der Liste eingeben.")

    number = int(answer)
    name = "" if number == 0 else options[number - 1]["name"].strip()
    print(f"\nSprich jetzt ein paar Sekunden in {'das Standardmikrofon' if not name else name} ...")
    loudest = level_check(name or None)

    if loudest == 0:
        print(
            "Von diesem Mikrofon kommt gar nichts. Entweder ist es das falsche,\n"
            "oder Windows blockiert es (Einstellungen > Datenschutz und Sicherheit > Mikrofon >\n"
            '"Desktop-Apps den Zugriff erlauben").'
        )
    elif loudest < 500:
        print("Das war sehr leise. Vielleicht ist es das falsche Mikrofon.")
    else:
        print("Gut, das Mikrofon hört dich.")

    keep = input("Dieses Mikrofon speichern? (J/n): ").strip().lower()
    if keep in ("", "j", "ja", "y", "yes"):
        save_setting("audio", "input_device", name)
        print("Gespeichert. Starte Jarvis jetzt mit Jarvis.bat.")
    else:
        print("Nichts geändert. Die Einrichtung (werkzeuge\\Einrichtung.bat) zeigt alle Mikrofone.")
