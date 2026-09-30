"""Startet Jarvis.

    python -m jarvis             Sprachmodus: "Hey Jarvis" sagen, dann den Befehl
    python -m jarvis --text      Tippmodus zum Testen ohne Mikrofon
    python -m jarvis --silent    Antworten nur anzeigen, nicht vorlesen
    python -m jarvis --mic       Mikrofon auswählen und speichern (mikrofon.bat)
    python -m jarvis --mic-test  Mikrofone anzeigen und Pegel + Wake Word live testen
"""

from __future__ import annotations

import argparse
import logging
import re
import sys
import time
import warnings

from .brain import BrainError, ClaudeBrain, RefusalError
from .config import HOME_DIR, load_config
from .mute import MUTE_PHRASES, MuteSwitch, register_hotkey

log = logging.getLogger("jarvis")

RESET_PHRASES = re.compile(r"\b(neue unterhaltung|neues gespräch|vergiss alles)\b", re.I)

# Ab diesem Wert zeigt Jarvis "fast erkannt" an, damit man die Schwelle einstellen kann.
NEAR_MISS = 0.2

PRIVACY_HINT = (
    "\n!! Vom Mikrofon kommt absolute Stille. Meist blockiert Windows den Zugriff:\n"
    "   Einstellungen > Datenschutz und Sicherheit > Mikrofon >\n"
    '   "Desktop-Apps den Zugriff auf das Mikrofon erlauben" einschalten.\n'
    "   Oder es ist das falsche Mikrofon: mikrofon.bat starten und das richtige wählen.\n"
)


def handle(text: str, brain: ClaudeBrain) -> str:
    if RESET_PHRASES.search(text):
        brain.new_conversation()
        return "Sehr wohl, Sir. Wir fangen von vorne an."
    try:
        return brain.ask(text)
    except RefusalError as exc:
        log.warning("Claude hat die Anfrage abgelehnt: %s", exc)
        return "Verzeihung, Sir, darauf darf ich so nicht antworten. Versuchen Sie es bitte mit anderen Worten."
    except BrainError as exc:
        log.error("%s", exc)
        return "Verzeihung, Sir, da ist etwas schiefgelaufen. Details stehen im Fenster."


def run_text(brain: ClaudeBrain, speak) -> None:
    print("Jarvis ist bereit. Tippe deinen Befehl ('exit' zum Beenden).")
    while True:
        try:
            text = input("\nDu: ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if text.lower() in {"exit", "quit"}:
            break
        if not text:
            continue
        answer = handle(text, brain)
        print(f"Jarvis: {answer}")
        speak(answer)


def voice_loop(cfg, mic, wake, stt, brain, speak, mute: MuteSwitch, sounds, hotkey: str) -> None:
    """Die Hauptschleife im Sprachmodus. Läuft, bis Strg+C gedrückt wird."""
    from .audio import record_command

    prompt = f'\nSag "Hey Jarvis" ...  ({hotkey} = stumm/laut, Strg+C = beenden)'
    print(prompt)
    mic.start()
    warned_silence = False
    last_hint = 0.0
    while True:
        if mute.muted:
            mic.stop()
            sounds.muted()
            print(f"\n[STUMM] Mikrofon ist aus. {hotkey} drücken, um es wieder einzuschalten.")
            while not mute.wait_until_unmuted(timeout=0.5):
                pass
            sounds.unmuted()
            print("[LAUT] Ich höre wieder zu.")
            mic.start()
            wake.reset()
            print(prompt)
            continue

        frame = mic.read()
        if not warned_silence and mic.dead_silent:
            print(PRIVACY_HINT)
            warned_silence = True

        score = wake.score(frame)
        if score < wake.threshold:
            now = time.monotonic()
            if score >= NEAR_MISS and now - last_hint > 2:
                print(f"  (fast erkannt: {score:.2f}, nötig sind {wake.threshold:.2f})")
                last_hint = now
            continue

        sounds.listening()
        print("Ich höre ...")
        audio = record_command(mic, cfg["listen"])
        if audio is None:
            print("Nichts gehört. Sprich direkt nach dem Ton.")
        else:
            text = stt.transcribe(audio)
            if not text:
                print("Nichts verstanden.")
            elif MUTE_PHRASES.search(text):
                print(f"\nDu: {text}")
                speak(f"Sehr wohl, Sir. Mit {hotkey} hole ich Sie wieder zurück.")
                mute.mute()
            else:
                print(f"\nDu: {text}")
                answer = handle(text, brain)
                print(f"Jarvis: {answer}")
                speak(answer)
        wake.reset()
        mic.drain()
        if not mute.muted:
            print(prompt)


class Sounds:
    def listening(self) -> None:
        from .tts import chime

        chime((880, 1320))

    def muted(self) -> None:
        from .tts import chime

        chime((660, 440))

    def unmuted(self) -> None:
        from .tts import chime

        chime((440, 660, 880))


def run_voice(cfg: dict, brain: ClaudeBrain, speak) -> None:
    from .audio import Microphone, WakeWord
    from .stt import SpeechToText

    mic = Microphone(cfg["audio"]["input_device"])
    print(f"Mikrofon: {mic.name}   (falsches Mikrofon? mikrofon.bat starten)")
    print("Lade Spracherkennung (beim ersten Start wird das Modell heruntergeladen) ...")
    stt = SpeechToText(cfg["stt"]["model"], cfg["stt"]["language"], cfg["stt"]["device"])
    wake = WakeWord(cfg["wakeword"]["model"], cfg["wakeword"]["threshold"])

    mute = MuteSwitch()
    hotkey = cfg["mute"]["hotkey"]
    if not register_hotkey(hotkey, mute.toggle):
        hotkey = "(kein Tastenkürzel)"

    speak("Jarvis ist online, Sir.")
    try:
        voice_loop(cfg, mic, wake, stt, brain, speak, mute, Sounds(), hotkey.upper())
    finally:
        mic.stop()


def run_mic_test(cfg: dict) -> None:
    from .audio import Microphone, WakeWord, input_devices, rms

    print("Gefundene Mikrofone (Nummer, Name, Treiber):")
    for d in input_devices():
        mark = "  <- Windows-Standard" if d["default"] else ""
        print(f"  {d['index']:>3}  {d['name']}  [{d['hostapi']}]{mark}")
    print("\nEin anderes Mikrofon wählst du am einfachsten mit mikrofon.bat.\n")

    mic = Microphone(cfg["audio"]["input_device"])
    wake = WakeWord(cfg["wakeword"]["model"], cfg["wakeword"]["threshold"])
    print(f"Teste: {mic.name} ({mic.rate} Hz)")
    print('Sprich etwas und sag "Hey Jarvis". Strg+C beendet den Test.\n')
    best = 0.0
    warned = False
    with mic:
        while True:
            frame = mic.read()
            level = rms(frame)
            score = wake.score(frame)
            best = max(best, score)
            bar = "#" * min(40, int(level / 100))
            status = "ERKANNT!" if score >= wake.threshold else ""
            print(
                f"\rPegel {level:6.0f} |{bar:<40}| Hey-Jarvis {score:.2f} (bester {best:.2f}) {status:8}",
                end="",
                flush=True,
            )
            if not warned and mic.dead_silent:
                print("\n" + PRIVACY_HINT)
                warned = True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="jarvis", description="Dein persönlicher Jarvis.")
    parser.add_argument("--text", action="store_true", help="Tippen statt sprechen")
    parser.add_argument("--silent", action="store_true", help="Antworten nicht vorlesen")
    parser.add_argument("--mic", action="store_true", help="Mikrofon auswählen und speichern")
    parser.add_argument("--mic-test", action="store_true", help="Mikrofon und Wake Word testen")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
    )
    if not args.verbose:
        # Die Download-Meldungen von Hugging Face sind nur Lärm.
        for name in ("httpx", "huggingface_hub", "urllib3", "filelock"):
            logging.getLogger(name).setLevel(logging.ERROR)
        warnings.filterwarnings("ignore", message=".*unauthenticated requests.*")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    cfg = load_config()

    if args.mic:
        from . import mic_setup

        try:
            mic_setup.run()
        except (KeyboardInterrupt, EOFError):
            print()
        return 0

    if args.mic_test:
        try:
            run_mic_test(cfg)
        except KeyboardInterrupt:
            print()
        return 0

    try:
        brain = ClaudeBrain(cfg["brain"], HOME_DIR)
    except BrainError as exc:
        print(exc)
        return 1

    if args.silent:
        def speak(_text: str) -> None:
            pass
    else:
        from .tts import TextToSpeech

        speak = TextToSpeech(cfg["tts"]).say

    try:
        if args.text:
            run_text(brain, speak)
        else:
            run_voice(cfg, brain, speak)
    except KeyboardInterrupt:
        pass
    print("\nJarvis verabschiedet sich.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
