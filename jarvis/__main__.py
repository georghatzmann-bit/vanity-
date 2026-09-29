"""Startet Jarvis.

    python -m jarvis           Sprachmodus: "Hey Jarvis" sagen, dann den Befehl
    python -m jarvis --text    Tippmodus zum Testen ohne Mikrofon
    python -m jarvis --silent  Antworten nur anzeigen, nicht vorlesen
"""

from __future__ import annotations

import argparse
import logging
import re
import sys

from .brain import BrainError, ClaudeBrain
from .config import HOME_DIR, load_config

log = logging.getLogger("jarvis")

RESET_PHRASES = re.compile(r"\b(neue unterhaltung|neues gespräch|vergiss alles)\b", re.I)


def handle(text: str, brain: ClaudeBrain) -> str:
    if RESET_PHRASES.search(text):
        brain.new_conversation()
        return "Sehr wohl, Sir. Wir fangen von vorne an."
    try:
        return brain.ask(text)
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


def run_voice(cfg: dict, brain: ClaudeBrain, speak) -> None:
    from .audio import Microphone, WakeWord, record_command
    from .stt import SpeechToText
    from .tts import chime

    print("Lade Spracherkennung (beim ersten Start wird das Modell heruntergeladen) ...")
    stt = SpeechToText(cfg["stt"]["model"], cfg["stt"]["language"], cfg["stt"]["device"])
    wake = WakeWord(cfg["wakeword"]["model"], cfg["wakeword"]["threshold"])

    speak("Jarvis ist online, Sir.")
    print('Sag "Hey Jarvis" ... (Strg+C zum Beenden)')
    with Microphone() as mic:
        while True:
            if not wake.detected(mic.read()):
                continue
            chime()
            print("Ich höre ...")
            audio = record_command(mic, cfg["listen"])
            if audio is None:
                print("Nichts gehört.")
            else:
                text = stt.transcribe(audio)
                if text:
                    print(f"\nDu: {text}")
                    answer = handle(text, brain)
                    print(f"Jarvis: {answer}")
                    speak(answer)
            wake.reset()
            mic.drain()
            print('\nSag "Hey Jarvis" ...')


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="jarvis", description="Dein persönlicher Jarvis.")
    parser.add_argument("--text", action="store_true", help="Tippen statt sprechen")
    parser.add_argument("--silent", action="store_true", help="Antworten nicht vorlesen")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
    )
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    cfg = load_config()
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
