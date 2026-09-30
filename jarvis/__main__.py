"""Startet Jarvis.

    python -m jarvis               Jarvis-Fenster + Sprachsteuerung (Jarvis.bat),
                                   beim allerersten Start vorher die Einrichtung
    python -m jarvis --einrichten  Einrichtung mit Mikrofon, Stimme, Wohnort, Claude
    python -m jarvis --konsole     nur Konsolenfenster, ohne Oberfläche
    python -m jarvis --text        Tippmodus zum Testen ohne Mikrofon
    python -m jarvis --silent      Antworten nur anzeigen, nicht vorlesen
    python -m jarvis --mic         Mikrofon in der Konsole auswählen
    python -m jarvis --mic-test    Mikrofone anzeigen und Pegel + Wake Word live testen
    python -m jarvis --claude-test prüfen, welches Claude-Modell antwortet
    python -m jarvis --selftest    alles prüfen (werkzeuge\\Selbsttest.bat)
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
from .config import HOME_DIR, LOG_DIR, STATE_DIR, load_config, upgrade_config
from .logsetup import setup_logging
from .mute import MuteSwitch, hotkey_label, register_hotkey
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

        tts = TextToSpeech(cfg["tts"], STATE_DIR / "stimmen", on_problem=lambda text: ui.toast(text, "error"))
        speaker = Speaker(
            tts.synthesize,
            on_level=ui.level,
            on_speaking=lambda value: assistant_ref and assistant_ref[0].set_speaking(value),
        )
        from .assistant import FILLERS

        # Die festen Sätze schon mal vorbereiten, dann kommen sie später ohne Verzögerung.
        threading.Thread(
            target=tts.prepare, args=(["Jarvis ist online, Sir.", *FILLERS],), name="jarvis-stimmen", daemon=True
        ).start()

        def offline_voice() -> None:
            # Die Offline-Ersatzstimme einmalig im Hintergrund holen (63 MB), wenn der Start durch ist.
            time.sleep(30)
            from .tts import ensure_piper_model

            ensure_piper_model()

        threading.Thread(target=offline_voice, name="jarvis-offline-stimme", daemon=True).start()
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
            retry = 30.0
            while not stopped.wait(wait):
                try:
                    now = source.current()
                    parts = [f"{now['temp']}°" if now["temp"] is not None else "", now["text"], now["place"]]
                    ui.config(weather=" · ".join(p for p in parts if p))
                    wait, retry = 30 * 60, 30.0
                except LookupError as exc:
                    log.warning("Wetter: %s", exc)
                    ui.config(weather="")
                    return
                except Exception as exc:
                    # Kein Netz (z. B. gleich nach dem Anmelden): bald nochmal, dann seltener.
                    log.debug("Wetter: %s", exc)
                    wait, retry = retry, min(retry * 2, 5 * 60)

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


def load_voice(
    cfg: dict, assistant: Assistant, ui: Ui, hotkey: str, hints, wait_for_mic: threading.Event | None = None
) -> VoiceLoop | None:
    """Lädt Mikrofon, Wake Word und Spracherkennung. Bei Problemen None (Tippen geht trotzdem).
    Mit `wait_for_mic` wartet es, bis ein Mikrofon da ist (alle 10 Sekunden ein Versuch),
    bis dieses Ereignis gesetzt wird."""
    from .audio import Microphone, WakeWord, friendly_device_error, refresh_devices

    try:
        mic = Microphone(cfg["audio"]["input_device"], fallback=True)
    except Exception as exc:
        log.error("Mikrofon: %s", exc)
        ui.toast(f"Mikrofon-Problem: {friendly_device_error(exc)} Ein anderes wählst du in den Einstellungen (oben rechts im Jarvis-Fenster).", "error")
        if wait_for_mic is None:
            return None
        # Gar kein Mikrofon da (z. B. nur ein USB-Headset, das noch nicht steckt): warten.
        ui.message("info", "Kein Mikrofon da. Sobald eins angeschlossen ist, hört Jarvis zu. Schreiben geht schon.")
        while True:
            if wait_for_mic.wait(10):
                return None
            try:
                refresh_devices()
                mic = Microphone(cfg["audio"]["input_device"], fallback=True)
                break
            except Exception as retry_exc:
                log.debug("Mikrofon noch nicht da: %s", retry_exc)
    if mic.missing:
        # Lieber mit dem Standardmikrofon weiter als gar nicht zuhören, aber deutlich sagen.
        ui.toast(
            f'Dein Mikrofon „{mic.missing}“ ist nicht angeschlossen. Ich höre vorerst über '
            f'„{mic.name}“. Anderes Mikrofon: Einstellungen oben rechts im Jarvis-Fenster.',
            "error",
        )
    ui.config(mic=mic.name)
    hints(f"Mikrofon: {mic.name}   (falsches Mikrofon? werkzeuge\\Einrichtung.bat)")
    # Nur wenn es dauert (beim ersten Start wird das Modell heruntergeladen), Bescheid sagen.
    slow = threading.Timer(
        6.0, lambda: ui.message("info", "Lade die Spracherkennung. Beim ersten Start dauert das ein paar Minuten ...")
    )
    slow.daemon = True
    slow.start()
    try:
        from .stt import SpeechToText

        stt = SpeechToText(
            cfg["stt"]["model"], cfg["stt"]["language"], cfg["stt"]["device"], cfg["stt"].get("beam_size", 1)
        )
        wake = WakeWord(cfg["wakeword"]["model"], cfg["wakeword"]["threshold"])
    except Exception as exc:
        log.exception("Spracherkennung lädt nicht")
        ui.toast(f"Spracherkennung lädt nicht: {exc}. werkzeuge\\Selbsttest.bat zeigt mehr.", "error")
        return None
    finally:
        slow.cancel()
    return VoiceLoop(cfg, mic, wake, stt, assistant, assistant.mute, Sounds(), hotkey, hints)


def register_mute_hotkey(cfg: dict, assistant: Assistant) -> str:
    hotkey = cfg["mute"]["hotkey"]
    if hotkey and register_hotkey(hotkey, assistant.mute.toggle):
        assistant.hotkey = hotkey
        return hotkey_label(hotkey)
    return "(kein Tastenkürzel)"


# ---------------------------------------------------------------------- Modi

def run_text(assistant: Assistant) -> None:
    if not has_console():
        tell("Jarvis hat weder Fenster noch Mikrofon. Starte werkzeuge\\Selbsttest.bat, dort steht, was fehlt.")
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
            ui.message("info", "Claude Code fehlt. Die Einstellungen (oben rechts) helfen beim Einrichten.")
        voice = load_voice(cfg, assistant, ui, hotkey, lambda _text: None, wait_for_mic=stopped)
        if voice is None:
            ui.config(voice=False)
            ui.message("info", "Die Sprachsteuerung ist aus. Du kannst Jarvis rechts eine Nachricht schreiben.")
            assistant.update_state()
            return
        ui.config(voice=True)
        voice_ref.append(voice)
        console.idle_hint = f'Sag "Hey Jarvis" ...  ({hotkey} = stumm/laut)'
        console.message("info", f'Bereit. Sag "Hey Jarvis" oder schreib. {hotkey} schaltet das Mikrofon stumm.')
        from datetime import datetime

        from .greeting import build_greeting, current_weather

        now = datetime.now()
        upcoming = assistant.reminders.upcoming(now) if assistant.reminders is not None else []
        hello = build_greeting(now, current_weather(str(cfg.get("ich", {}).get("ort", "")).strip()), upcoming)
        ui.message("jarvis", hello, id="begruessung")
        assistant.say(hello)
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

    def open_setup() -> None:
        from .setup_wizard import launch

        launch("--einrichten")
        # Kurz warten, damit die Seite noch "Einrichtung öffnet sich" zeigen kann.
        threading.Timer(0.6, quit_all).start()

    def listen_now() -> bool:
        return bool(voice_ref) and voice_ref[0].listen_now()

    window = Window(
        Api(bridge, assistant, assistant.mute, open_setup, listen_now), background, on_closed, cfg.get("gui", {})
    )
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
    print("\nEin anderes Mikrofon wählst du am einfachsten in der Einrichtung (werkzeuge\\Einrichtung.bat).\n")

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


def _first_run() -> bool:
    from .gui.app import WEB_DIR
    from .setup_wizard import setup_done

    return not setup_done() and (WEB_DIR / "setup.html").exists()


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


def claim_single_instance(name: str = "JarvisSprachassistent", wait: float = 0.0) -> bool:
    """Nur ein Jarvis gleichzeitig, sonst antworten zwei auf "Hey Jarvis"
    (z. B. Autostart läuft schon und Jarvis.bat wird doppelt geklickt).
    `wait`: so lange warten, falls der alte Jarvis gerade beendet wird (nach der Einrichtung)."""
    end = time.monotonic() + wait
    while True:
        claimed = _try_claim(name)
        if claimed or time.monotonic() >= end:
            return claimed
        time.sleep(0.25)


def _try_claim(name: str) -> bool:
    global _instance_lock
    if os.name == "nt":
        try:
            import ctypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.CreateMutexW.restype = ctypes.c_void_p
            kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
            handle = kernel32.CreateMutexW(None, False, "Local\\" + name)
            if handle and ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
                # Eigenen Griff wieder abgeben, sonst bliebe die Sperre auch nach dem
                # Ende des anderen Jarvis bestehen.
                kernel32.CloseHandle(handle)
                return False
            _instance_lock = handle
        except Exception as exc:
            log.debug("Mutex: %s", exc)
        return True
    try:
        import fcntl

        STATE_DIR.mkdir(parents=True, exist_ok=True)
        lock = open(STATE_DIR / f"{name.lower()}.lock", "w")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close()
            return False
        _instance_lock = lock
        return True
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
    parser.add_argument("--einrichten", "--setup", action="store_true", help="Einrichtung öffnen")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    log_file = setup_logging(LOG_DIR, args.verbose)
    log.info("Jarvis %s startet (%s)", __version__, " ".join(sys.argv[1:]) or "Standard")

    try:
        for change in upgrade_config():
            log.info("config.toml angepasst: %s", change)
        cfg = load_config()
    except Exception as exc:
        tell(
            f"config.toml ist fehlerhaft: {exc}\nTipp: Tippfehler korrigieren oder config.toml löschen, "
            "Jarvis legt sie beim nächsten Start neu an."
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

    gui_wanted = not args.text and not args.konsole and cfg.get("gui", {}).get("enabled", True)
    if args.einrichten or (gui_wanted and not args.silent and _first_run()):
        from .setup_wizard import run_setup

        if not claim_single_instance("JarvisEinrichtung"):
            tell("Die Einrichtung ist schon offen.", error=False, popup=True)
            return 0
        return run_setup(cfg)

    # Nach der Einrichtung startet Jarvis neu, der alte braucht evtl. noch einen Moment.
    if not claim_single_instance(wait=6.0 if not has_console() else 0.0):
        # Als Fenster, weil sich Jarvis.bat danach sofort schließt.
        tell(
            "Jarvis läuft schon (Symbol unten rechts neben der Uhr). Ein zweiter Jarvis würde doppelt antworten.",
            error=False,
            popup=True,
        )
        return 0

    if gui_wanted:
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
            tell(f"Das Jarvis-Fenster geht nicht ({reason}). Starte werkzeuge\\Selbsttest.bat, dort steht, was fehlt.")
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
