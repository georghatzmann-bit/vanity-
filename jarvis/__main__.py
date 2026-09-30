"""Startet Jarvis.

    python -m jarvis               Arc-Reactor-Fenster + Sprachsteuerung (start.bat)
    python -m jarvis --konsole     nur Konsolenfenster, ohne Oberfläche
    python -m jarvis --text        Tippmodus zum Testen ohne Mikrofon
    python -m jarvis --silent      Antworten nur anzeigen, nicht vorlesen
    python -m jarvis --mic         Mikrofon auswählen und speichern (mikrofon.bat)
    python -m jarvis --mic-test    Mikrofone anzeigen und Pegel + Wake Word live testen
    python -m jarvis --claude-test prüfen, welches Claude-Modell antwortet
    python -m jarvis --selftest    alles prüfen (selbsttest.bat)
    python -m jarvis --autostart an|aus
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import threading
import time

from . import __version__
from .assistant import Assistant
from .brain import BrainError, ClaudeBrain
from .config import HOME_DIR, LOG_DIR, STATE_DIR, load_config
from .logsetup import setup_logging
from .mute import MuteSwitch, register_hotkey
from .persona import build_persona
from .reminders import ReminderStore
from .ui import ConsoleUi, MultiUi, Ui
from .voice import PRIVACY_HINT, Sounds, VoiceLoop

log = logging.getLogger("jarvis")


# ---------------------------------------------------------------------- Aufbau

def build_core(cfg: dict, ui: Ui, silent: bool = False) -> Assistant:
    mute = MuteSwitch()
    reminders = ReminderStore(STATE_DIR / "erinnerungen.json")
    try:
        persona = build_persona(HOME_DIR, STATE_DIR, cfg)
        brain = ClaudeBrain(cfg["brain"], HOME_DIR, STATE_DIR, persona=persona)
    except BrainError as exc:
        log.error("%s", exc)
        ui.toast(str(exc), "error")
        brain = None

    speaker = None
    assistant_ref: list[Assistant] = []
    if not silent:
        from .tts import Speaker, TextToSpeech

        speaker = Speaker(
            TextToSpeech(cfg["tts"]).synthesize,
            on_level=ui.level,
            on_speaking=lambda value: assistant_ref and assistant_ref[0].set_speaking(value),
        )
    assistant = Assistant(cfg, brain, speaker, ui, mute, reminders)
    assistant_ref.append(assistant)

    def on_mute(muted: bool) -> None:
        assistant.update_state()
        ui.config(muted=muted)

    mute.on_change(on_mute)
    return assistant


def start_services(cfg: dict, assistant: Assistant, ui: Ui, stopped: threading.Event) -> None:
    """Erinnerungen, Systemanzeige und (falls eingeschaltet) der Web-Eingang für Home Assistant."""

    def reminders() -> None:
        while not stopped.wait(5):
            try:
                assistant.check_reminders()
            except Exception as exc:
                log.debug("Erinnerungen: %s", exc)

    threading.Thread(target=reminders, name="jarvis-erinnerungen", daemon=True).start()

    try:
        import psutil

        def stats() -> None:
            psutil.cpu_percent(interval=None)
            while not stopped.wait(2):
                ui.stats(psutil.cpu_percent(interval=None), psutil.virtual_memory().percent)

        threading.Thread(target=stats, name="jarvis-stats", daemon=True).start()
    except ImportError:
        pass

    place = str(cfg.get("ich", {}).get("ort", "")).strip()
    if place:
        from .weather import Weather

        def weather() -> None:
            source = Weather(place)
            wait = 1.0
            while not stopped.wait(wait):
                try:
                    now = source.current()
                    parts = [f"{now['temp']}°" if now["temp"] is not None else "", now["text"], now["place"]]
                    ui.config(weather=" · ".join(p for p in parts if p))
                    wait = 30 * 60
                except LookupError as exc:
                    log.warning("Wetter: %s", exc)
                    ui.config(weather="")
                    return
                except Exception as exc:
                    log.debug("Wetter: %s", exc)
                    wait = 5 * 60

        threading.Thread(target=weather, name="jarvis-wetter", daemon=True).start()

    server_cfg = cfg.get("server", {})
    if server_cfg.get("enabled"):
        from .homeassistant import HomeAssistant
        from .server import CommandServer

        try:
            ha = HomeAssistant(cfg.get("homeassistant", {}))
            url = CommandServer(server_cfg, assistant, ha if ha.configured else None).start()
            ui.message("info", f"Web-Eingang für Home Assistant läuft: {url}")
        except Exception as exc:
            log.error("Web-Eingang startet nicht: %s", exc)
            ui.toast(f"Web-Eingang startet nicht: {exc}", "error")


def load_voice(cfg: dict, assistant: Assistant, ui: Ui, hotkey: str, hints) -> VoiceLoop | None:
    """Lädt Mikrofon, Wake Word und Spracherkennung. Bei Problemen None (Tippen geht trotzdem)."""
    from .audio import Microphone, WakeWord, friendly_device_error

    try:
        mic = Microphone(cfg["audio"]["input_device"])
    except Exception as exc:
        log.error("Mikrofon: %s", exc)
        ui.toast(f"Mikrofon-Problem: {friendly_device_error(exc)} Starte mikrofon.bat und wähle dein Mikrofon.", "error")
        return None
    ui.config(mic=mic.name)
    hints(f"Mikrofon: {mic.name}   (falsches Mikrofon? mikrofon.bat starten)")
    ui.message("info", "Lade Spracherkennung (beim ersten Start wird das Modell heruntergeladen) ...")
    try:
        from .stt import SpeechToText

        stt = SpeechToText(cfg["stt"]["model"], cfg["stt"]["language"], cfg["stt"]["device"])
        wake = WakeWord(cfg["wakeword"]["model"], cfg["wakeword"]["threshold"])
    except Exception as exc:
        log.exception("Spracherkennung lädt nicht")
        ui.toast(f"Spracherkennung lädt nicht: {exc}. selbsttest.bat zeigt mehr.", "error")
        return None
    return VoiceLoop(cfg, mic, wake, stt, assistant, assistant.mute, Sounds(), hotkey, hints)


def register_mute_hotkey(cfg: dict, assistant: Assistant) -> str:
    hotkey = cfg["mute"]["hotkey"]
    if hotkey and register_hotkey(hotkey, assistant.mute.toggle):
        return hotkey.upper()
    return "(kein Tastenkürzel)"


# ---------------------------------------------------------------------- Modi

def run_text(assistant: Assistant) -> None:
    if not has_console():
        tell("Jarvis hat weder Fenster noch Mikrofon. Starte selbsttest.bat, dort steht, was fehlt.")
        return
    print("Jarvis ist bereit. Tippe deinen Befehl ('exit' zum Beenden).")
    while True:
        try:
            text = input("\nDu: ").strip()
        except (EOFError, KeyboardInterrupt, RuntimeError):
            break
        if text.lower() in {"exit", "quit", "ende"}:
            break
        if text:
            assistant.handle(text)


def run_console_voice(cfg: dict, console: ConsoleUi, assistant: Assistant) -> None:
    hotkey = register_mute_hotkey(cfg, assistant)
    voice = load_voice(cfg, assistant, assistant.ui, hotkey, print)
    if voice is None:
        print("\nOhne Mikrofon geht es im Tippmodus weiter.")
        console.show_user = False
        run_text(assistant)
        return
    console.idle_hint = f'\nSag "Hey Jarvis" ...  ({hotkey} = stumm/laut, Strg+C = beenden)'
    assistant.say("Jarvis ist online, Sir.")
    try:
        voice.run()
    except Exception as exc:
        log.exception("Sprachschleife abgestürzt")
        print(f"\nDie Sprachsteuerung ist ausgefallen: {exc}\nDetails in logs\\jarvis.log. Es geht im Tippmodus weiter.")
        console.show_user = False
        run_text(assistant)
    finally:
        voice.stopped.set()


def run_gui(cfg: dict, args) -> int:
    from .gui.app import Api, GuiBridge, Window
    from .tray import Tray

    bridge = GuiBridge()
    console = ConsoleUi()
    ui = MultiUi(console, bridge)
    assistant = build_core(cfg, ui, args.silent)
    stopped = threading.Event()
    hotkey = register_mute_hotkey(cfg, assistant)
    ui.config(hotkey=hotkey, version=__version__, muted=False)
    window: Window
    tray_ref: list[Tray] = []
    voice_ref: list[VoiceLoop] = []

    def quit_all() -> None:
        stopped.set()
        window.destroy()

    def background() -> None:
        start_services(cfg, assistant, ui, stopped)
        gui_cfg = cfg.get("gui", {})
        if gui_cfg.get("tray", True):
            tray = Tray(window.show, assistant.mute.toggle, quit_all, lambda: assistant.mute.muted)
            if tray.start():
                tray_ref.append(tray)
                assistant.mute.on_change(tray.set_muted)
                window.allow_close = not gui_cfg.get("close_to_tray", False)
        if assistant.brain is None:
            ui.message("info", "Claude Code fehlt. selbsttest.bat sagt, was zu tun ist.")
        voice = load_voice(cfg, assistant, ui, hotkey, lambda _text: None)
        if voice is None:
            ui.message("info", "Die Sprachsteuerung ist aus. Du kannst Jarvis unten etwas schreiben.")
            assistant.update_state()
            return
        voice_ref.append(voice)
        console.idle_hint = f'Sag "Hey Jarvis" ...  ({hotkey} = stumm/laut)'
        ui.message("info", f'Bereit. Sag "Hey Jarvis" oder schreib unten. {hotkey} schaltet das Mikrofon stumm.')
        assistant.say("Jarvis ist online, Sir.")
        assistant.update_state()
        if stopped.is_set():
            return
        try:
            voice.run()
        except Exception as exc:
            log.exception("Sprachschleife abgestürzt")
            ui.toast(f"Sprachsteuerung gestoppt: {exc}", "error")

    def on_closed() -> None:
        stopped.set()
        for voice in voice_ref:
            voice.stopped.set()
        for tray in tray_ref:
            tray.stop()
        assistant.stop()

    window = Window(Api(bridge, assistant, assistant.mute), background, on_closed, cfg.get("gui", {}))
    print("Jarvis-Fenster wird geöffnet. Dieses Konsolenfenster zeigt nebenbei das Gespräch.")
    window.start()
    return 0


def run_claude_test(cfg: dict) -> int:
    try:
        brain = ClaudeBrain(cfg["brain"], HOME_DIR, STATE_DIR, persona=build_persona(HOME_DIR, STATE_DIR, cfg))
    except BrainError as exc:
        print(exc)
        return 1
    print('Teste, ob Claude auf "hi" antwortet. Das dauert etwa eine Minute ...\n')
    for model, mode, result in brain.diagnose("hi"):
        print(f"  {model:<8} {mode:<26} {result}")
    print(
        "\nKopier diese Tabelle und schick sie Claude im Jarvis-Projekt.\n"
        '"mit deinen Einstellungen" nutzt deine Skills, Plugins und CLAUDE.md-Dateien,\n'
        '"ohne Erweiterungen" ist so, wie Jarvis Claude normalerweise startet.'
    )
    return 0


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
                print("\n\n!! " + PRIVACY_HINT + "\n")
                warned = True


def run_autostart(value: str) -> int:
    from . import autostart

    try:
        if value in ("an", "ein", "on"):
            path = autostart.enable()
            print(f"Jarvis startet ab jetzt mit Windows. (Eintrag: {path})")
        else:
            removed = autostart.disable()
            print("Autostart ist aus." if removed else "Autostart war schon aus.")
        return 0
    except Exception as exc:
        print(f"Autostart ging nicht: {exc}")
        return 1


# ---------------------------------------------------------------------- Start

_instance_lock = None


def has_console() -> bool:
    """False beim Autostart (pythonw): dann sieht niemand print(), und input() geht nicht."""
    return sys.stdin is not None


def tell(text: str, error: bool = True, popup: bool = False) -> None:
    """Meldung ausgeben. Ohne Konsole (oder mit popup) als kleines Windows-Fenster,
    damit sie jemand sieht."""
    print(text)
    (log.warning if error else log.info)("%s", text)
    if (popup or not has_console()) and os.name == "nt":
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(None, text, "Jarvis", 0x10 if error else 0x40)
        except Exception:
            pass


def claim_single_instance() -> bool:
    """Nur ein Jarvis gleichzeitig, sonst antworten zwei auf "Hey Jarvis"
    (z. B. Autostart läuft schon und start.bat wird doppelt geklickt)."""
    global _instance_lock
    if os.name == "nt":
        try:
            import ctypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.CreateMutexW.restype = ctypes.c_void_p
            handle = kernel32.CreateMutexW(None, False, "Local\\JarvisSprachassistent")
            if handle and ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
                return False
            _instance_lock = handle
        except Exception as exc:
            log.debug("Mutex: %s", exc)
        return True
    try:
        import fcntl

        STATE_DIR.mkdir(parents=True, exist_ok=True)
        _instance_lock = open(STATE_DIR / "jarvis.lock", "w")
        fcntl.flock(_instance_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False
    except Exception as exc:
        log.debug("Sperrdatei: %s", exc)
        return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="jarvis", description="Dein persönlicher Jarvis.")
    parser.add_argument("--text", action="store_true", help="Tippen statt sprechen")
    parser.add_argument("--konsole", "--no-gui", action="store_true", help="ohne Fenster, nur Konsole")
    parser.add_argument("--silent", action="store_true", help="Antworten nicht vorlesen")
    parser.add_argument("--mic", action="store_true", help="Mikrofon auswählen und speichern")
    parser.add_argument("--mic-test", action="store_true", help="Mikrofon und Wake Word testen")
    parser.add_argument("--claude-test", action="store_true", help="Prüfen, welches Claude-Modell antwortet")
    parser.add_argument("--selftest", "--selbsttest", action="store_true", help="Alles prüfen")
    parser.add_argument("--schnell", action="store_true", help="Selbsttest ohne Töne und mit kurzem Mikrofontest")
    parser.add_argument("--autostart", choices=["an", "aus", "ein", "on", "off"], help="Mit Windows starten")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    log_file = setup_logging(LOG_DIR, args.verbose)
    log.info("Jarvis %s startet (%s)", __version__, " ".join(sys.argv[1:]) or "Standard")

    try:
        cfg = load_config()
    except Exception as exc:
        tell(
            f"config.toml ist fehlerhaft: {exc}\nTipp: Tippfehler korrigieren oder config.toml löschen, "
            "setup.bat legt sie neu an."
        )
        return 1

    if args.autostart:
        return run_autostart(args.autostart)

    if args.selftest:
        from . import selftest

        report = selftest.run(cfg, quick=args.schnell)
        return 1 if report.failed else 0

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

    if args.claude_test:
        return run_claude_test(cfg)

    if not claim_single_instance():
        # Als Fenster, weil sich start.bat danach sofort schließt.
        tell(
            "Jarvis läuft schon (Symbol unten rechts neben der Uhr). Ein zweiter Jarvis würde doppelt antworten.",
            error=False,
            popup=True,
        )
        return 0

    if not args.text and not args.konsole and cfg.get("gui", {}).get("enabled", True):
        from .gui.app import webview_available

        ok, reason = webview_available()
        if ok:
            try:
                code = run_gui(cfg, args)
            except Exception:
                log.exception("Oberfläche abgestürzt")
                print(f"Die Oberfläche ist abgestürzt. Details in {log_file}.")
                code = 1
            logging.shutdown()
            # Hintergrund-Threads (Mikrofon, Tray) sollen das Beenden nicht aufhalten.
            os._exit(code)
        if not has_console():
            tell(f"Das Jarvis-Fenster geht nicht ({reason}). Starte selbsttest.bat, dort steht, was fehlt.")
            return 1
        print(f"Oberfläche nicht verfügbar ({reason}), Jarvis läuft im Konsolenfenster.")

    console = ConsoleUi()
    assistant = build_core(cfg, console, args.silent)
    stopped = threading.Event()
    start_services(cfg, assistant, console, stopped)
    try:
        if args.text:
            console.show_user = False
            run_text(assistant)
        else:
            run_console_voice(cfg, console, assistant)
    except KeyboardInterrupt:
        pass
    finally:
        stopped.set()
        assistant.stop()
    print("\nJarvis verabschiedet sich.")
    time.sleep(0.2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
