"""Das Jarvis-Fenster. Python legt Ereignisse in eine Warteschlange, die Seite holt
sie alle 80 ms mit `poll()` ab. So gibt es keine Probleme mit Threads."""

from __future__ import annotations

import collections
import logging
import os
import threading
from pathlib import Path

from ..ui import Ui

log = logging.getLogger(__name__)

WEB_DIR = Path(__file__).resolve().parent / "web"


class GuiBridge(Ui):
    """Sammelt alles, was die Oberfläche anzeigen soll."""

    MAX_EVENTS = 500

    def __init__(self) -> None:
        self._events: collections.deque = collections.deque(maxlen=self.MAX_EVENTS)
        self._level: float | None = None
        self._lock = threading.Lock()
        self.info: dict = {"hotkey": "", "mic": "", "model": "", "muted": False, "version": "", "weather": ""}

    def _push(self, event: dict) -> None:
        with self._lock:
            self._events.append(event)

    def drain(self) -> list[dict]:
        with self._lock:
            events = list(self._events)
            self._events.clear()
            if self._level is not None:
                events.append({"type": "level", "value": round(self._level, 3)})
                self._level = None
        return events

    def state(self, value: str) -> None:
        self._push({"type": "state", "value": value})

    def message(self, role: str, text: str, id: str | None = None, model: str = "", final: bool = True) -> None:
        event = {"type": "message", "role": role, "text": text, "final": final}
        if id:
            event["id"] = id
        if model:
            event["model"] = model
        self._push(event)

    def level(self, value: float) -> None:
        # Nur der neueste Pegel zählt, sonst läuft die Warteschlange voll.
        with self._lock:
            self._level = max(0.0, min(1.0, float(value)))

    def toast(self, text: str, kind: str = "info") -> None:
        self._push({"type": "toast", "text": text, "kind": kind})

    def config(self, **values) -> None:
        self.info.update({k: v for k, v in values.items() if v is not None})
        self._push({"type": "config", **values})

    def progress(self, step: dict) -> None:
        self._push({"type": "progress", "step": dict(step)})

    def workshop(self, event: dict) -> None:
        # Laufender Text kommt oft: nur der neueste zählt, sonst läuft die Warteschlange voll.
        if event.get("state") == "text":
            with self._lock:
                for old in [e for e in self._events if e.get("type") == "workshop" and e.get("state") == "text"]:
                    self._events.remove(old)
        self._push({"type": "workshop", **event})

    def stats(self, cpu: float, ram: float) -> None:
        self._push({"type": "stats", "cpu": round(cpu, 1), "ram": round(ram, 1)})

    def suggestion(self, offer: dict | None) -> None:
        self._push({"type": "suggestion", "offer": offer})


class Api:
    """Was die Seite in Python aufrufen darf (window.pywebview.api.*).
    Interne Dinge beginnen mit _, damit pywebview sie nicht an die Seite gibt."""

    def __init__(self, bridge: GuiBridge, assistant, mute, on_setup=None, on_listen=None) -> None:
        self._bridge = bridge
        self._assistant = assistant
        self._mute = mute
        self._on_setup = on_setup
        self._on_listen = on_listen
        self._on_touched = None  # setzt __main__ (Hintergrund-Modus)
        self._start_server = None  # setzt __main__: startet den Web-Eingang für die Handy-App
        self._start_alexa = None  # setzt __main__: startet die Alexa-Verbindung

    def hello(self) -> dict:
        info = dict(self._bridge.info)
        info["muted"] = bool(self._mute and self._mute.muted)
        return info

    def poll(self) -> list:
        return self._bridge.drain()

    def send_text(self, text) -> bool:
        text = str(text or "").strip()
        if not text:
            return False
        self._assistant.submit(text)
        return True

    def toggle_mute(self) -> bool:
        if self._mute is None:
            return False
        self._mute.toggle()
        return self._mute.muted

    def stop(self) -> None:
        self._assistant.stop()
        # Der Stopp-Knopf hält auch ein angekündigtes Herunterfahren auf.
        abort = getattr(self._assistant, "abort_power", None)
        if abort is not None and abort():
            self._assistant.announce("Abgebrochen, Sir. Der PC bleibt an.")

    def listen_now(self) -> dict:
        """Klick auf den Kreis im Fenster: sofort zuhören, ohne "Hey Jarvis"."""
        if self._mute is not None and self._mute.muted:
            return {"ok": False, "reason": "muted"}
        if self._on_listen is None or not self._on_listen():
            return {"ok": False, "reason": "novoice"}
        return {"ok": True, "reason": ""}

    def reminders(self) -> list:
        """Die nächsten Erinnerungen (heute und morgen) für die Spalte "Heute"."""
        import datetime as dt

        store = getattr(self._assistant, "reminders", None)
        if store is None:
            return []
        now = dt.datetime.now()
        rows = []
        for r in store.upcoming(now):
            try:
                when = dt.datetime.fromisoformat(r["zeit"])
            except (KeyError, ValueError):
                continue
            days = (when.date() - now.date()).days
            if days > 1:
                break
            rows.append({"uhr": when.strftime("%H:%M"), "text": str(r.get("text", "")),
                         "tag": "heute" if days == 0 else "morgen"})
        return rows[:8]

    # ------------------------------------------------------------------ Handy

    def phone_info(self) -> dict:
        """Alles für "Jarvis aufs Handy": an/aus, Adresse, QR-Code, MAC-Adresse fürs Einschalten."""
        from ..remote import app_url, local_ip, mac_address, qr_svg

        cfg = getattr(self._assistant, "_cfg", {}) or {}
        server_cfg = cfg.get("server", {}) or {}
        token = str(server_cfg.get("token") or "")
        enabled = bool(server_cfg.get("enabled")) and len(token) >= 12
        server = getattr(self._assistant, "server", None)
        running = bool(server is not None and server.running)
        ip = local_ip()
        port = server.port if running else int(server_cfg.get("port", 8765) or 8765)
        url = app_url(token, ip, port) if enabled else ""
        return {"enabled": enabled, "running": running, "url": url, "qr": qr_svg(url) if url else "",
                "ip": ip, "port": port, "mac": mac_address(ip)}

    def phone_enable(self, on) -> dict:
        """Handy-Verbindung an oder aus. Beim ersten Mal entsteht ein geheimer Schlüssel."""
        from ..config import save_setting
        from ..remote import new_token

        cfg = getattr(self._assistant, "_cfg", None)
        if cfg is None:
            return self.phone_info()
        server_cfg = cfg.setdefault("server", {})
        try:
            if on:
                if len(str(server_cfg.get("token") or "")) < 12:
                    server_cfg["token"] = new_token()
                    save_setting("server", "token", server_cfg["token"])
                server_cfg["enabled"] = True
                save_setting("server", "enabled", True)
                if self._start_server is not None:
                    self._start_server()
            else:
                server_cfg["enabled"] = False
                save_setting("server", "enabled", False)
                server = getattr(self._assistant, "server", None)
                if server is not None:
                    server.stop()
                    self._assistant.server = None
        except Exception as exc:
            log.warning("Handy-Verbindung: %s", exc)
            self._bridge.toast(f"Die Handy-Verbindung ließ sich nicht umstellen: {exc}", "error")
        return self.phone_info()

    def phone_new_key(self) -> dict:
        """Neu koppeln: neuer Schlüssel, alte Handys kommen nicht mehr hinein."""
        from ..config import save_setting
        from ..remote import new_token

        cfg = getattr(self._assistant, "_cfg", None)
        if cfg is None:
            return self.phone_info()
        server_cfg = cfg.setdefault("server", {})
        server_cfg["token"] = new_token()
        save_setting("server", "token", server_cfg["token"])
        server = getattr(self._assistant, "server", None)
        if server is not None:
            server.stop()
            self._assistant.server = None
        if server_cfg.get("enabled") and self._start_server is not None:
            self._start_server()
        return self.phone_info()

    def push_info(self) -> dict:
        """Benachrichtigungen aufs Handy (ntfy): an/aus und der Kanal zum Abonnieren."""
        from ..push import RELAY

        handy = ((getattr(self._assistant, "_cfg", {}) or {}).get("handy", {})) or {}
        topic = str(handy.get("push_kanal") or "")
        relay = str(handy.get("vermittlung") or RELAY).rstrip("/")
        return {"enabled": bool(handy.get("push")) and topic.startswith("jarvis-"), "topic": topic,
                "url": f"{relay}/{topic}" if topic else ""}

    def push_enable(self, on) -> dict:
        """Benachrichtigungen an oder aus. Beim ersten Mal entsteht ein geheimer Kanalname."""
        from ..config import save_setting
        from ..push import Push, new_topic

        cfg = getattr(self._assistant, "_cfg", None)
        if cfg is None:
            return self.push_info()
        handy = cfg.setdefault("handy", {})
        try:
            if on and not str(handy.get("push_kanal") or "").startswith("jarvis-"):
                handy["push_kanal"] = new_topic()
                save_setting("handy", "push_kanal", handy["push_kanal"])
            handy["push"] = bool(on)
            save_setting("handy", "push", bool(on))
            self._assistant.push = Push(cfg)
        except Exception as exc:
            log.warning("Benachrichtigungen: %s", exc)
            self._bridge.toast(f"Die Benachrichtigungen ließen sich nicht umstellen: {exc}", "error")
        return self.push_info()

    def push_test(self) -> dict:
        import datetime as dt

        push = getattr(self._assistant, "push", None)
        if push is None or not push.enabled:
            return {"ok": False, "error": "Die Benachrichtigungen sind aus."}
        ok = push.send(f"Guten Tag, Sir. Die Benachrichtigungen funktionieren ({dt.datetime.now():%H:%M:%S}).", wait=True)
        return {"ok": ok, "error": "" if ok else "ntfy.sh war gerade nicht erreichbar. Bitte gleich noch einmal."}

    def wol_prepare(self) -> dict:
        """PC fürs Einschalten per Netzwerk vorbereiten (Windows fragt nach Administratorrechten)."""
        from .. import pc

        try:
            text = pc.prepare_wake_on_lan().strip()
            return {"ok": text.startswith("Bereit"), "text": text or "Keine Antwort."}
        except Exception as exc:
            return {"ok": False, "text": f"Das ging nicht: {exc}"}

    # ------------------------------------------------------------------ Discord-Bot

    def connections(self) -> dict:
        """Was gerade verbunden ist, für die Punkte am Knopf "Verbinden" (ohne Netzwerkabfrage)."""
        cfg = getattr(self._assistant, "_cfg", {}) or {}
        server = getattr(self._assistant, "server", None)
        bridge = getattr(self._assistant, "alexa", None)
        token = str(((cfg.get("discord", {}) or {}).get("bot_token")) or "")
        return {"phone": bool(server is not None and server.running),
                "alexa": bool(bridge is not None and bridge.connected),
                "discord": len(token) > 50}

    def discord_info(self) -> dict:
        from ..discord_bot import DiscordBot, DiscordError

        token = str(((getattr(self._assistant, "_cfg", {}) or {}).get("discord", {}) or {}).get("bot_token") or "")
        if not token:
            return {"configured": False, "name": "", "guilds": [], "error": ""}
        bot = DiscordBot(token)
        try:
            me = bot.me()
            return {"configured": True, "name": str(me.get("username") or "Jarvis"),
                    "guilds": [str(g.get("name") or "") for g in bot.guilds()], "error": ""}
        except DiscordError as exc:
            return {"configured": True, "name": "", "guilds": [], "error": str(exc)}

    def discord_save(self, token) -> dict:
        """Bot-Token prüfen und speichern."""
        from ..config import save_setting
        from ..discord_bot import DiscordBot, DiscordError

        token = str(token or "").strip().strip('"')
        if token.lower().startswith("bot "):
            token = token[4:].strip()
        bot = DiscordBot(token)
        if not bot.configured:
            return {"configured": False, "name": "", "guilds": [], "error": "Das sieht nicht wie ein Bot-Token aus. Bitte den ganzen Token kopieren."}
        try:
            me = bot.me()
        except DiscordError as exc:
            return {"configured": False, "name": "", "guilds": [], "error": str(exc)}
        cfg = getattr(self._assistant, "_cfg", None)
        if cfg is not None:
            cfg.setdefault("discord", {})["bot_token"] = token
        save_setting("discord", "bot_token", token)
        return {"configured": True, "name": str(me.get("username") or "Jarvis"),
                "guilds": [str(g.get("name") or "") for g in bot.guilds()], "error": ""}

    def discord_invite(self) -> dict:
        """Öffnet den Link, mit dem Georg den Bot auf seinen Server holt."""
        from .. import pc
        from ..discord_bot import DiscordBot, DiscordError

        token = str(((getattr(self._assistant, "_cfg", {}) or {}).get("discord", {}) or {}).get("bot_token") or "")
        try:
            url = DiscordBot(token).invite_url()
            pc.open_uri(url)
            return {"ok": True, "url": url}
        except (DiscordError, OSError) as exc:
            return {"ok": False, "url": "", "error": str(exc)}

    def discord_portal(self) -> bool:
        from .. import pc

        try:
            pc.open_uri("https://discord.com/developers/applications")
            return True
        except OSError:
            return False

    # ------------------------------------------------------------------ Alexa

    def alexa_info(self) -> dict:
        from ..alexa import CONSOLE_URL

        cfg = getattr(self._assistant, "_cfg", {}) or {}
        alexa = cfg.get("alexa", {}) or {}
        bridge = getattr(self._assistant, "alexa", None)
        return {"enabled": bool(alexa.get("aktiv")) and bool(alexa.get("kanal")),
                "connected": bool(bridge is not None and bridge.connected), "console": CONSOLE_URL}

    def alexa_enable(self, on) -> dict:
        """Alexa-Verbindung an oder aus. Beim ersten Mal entstehen Kanal und Schlüssel."""
        from ..alexa import new_secrets
        from ..config import save_setting

        cfg = getattr(self._assistant, "_cfg", None)
        if cfg is None:
            return self.alexa_info()
        alexa = cfg.setdefault("alexa", {})
        try:
            if on and (not str(alexa.get("kanal") or "").startswith("jarvis-") or len(str(alexa.get("schluessel") or "")) != 64):
                fresh = new_secrets()
                alexa.update(fresh)
                save_setting("alexa", "kanal", fresh["kanal"])
                save_setting("alexa", "schluessel", fresh["schluessel"])
            alexa["aktiv"] = bool(on)
            save_setting("alexa", "aktiv", bool(on))
            if on and self._start_alexa is not None:
                self._start_alexa()
            if not on and getattr(self._assistant, "alexa", None) is not None:
                self._assistant.alexa.stop()
                self._assistant.alexa = None
        except Exception as exc:
            log.warning("Alexa-Verbindung: %s", exc)
            self._bridge.toast(f"Die Alexa-Verbindung ließ sich nicht umstellen: {exc}", "error")
        return self.alexa_info()

    def alexa_copy(self, which) -> dict:
        """"modell" (Sprachmodell als JSON) oder "code" (lambda_function.py) in die Zwischenablage."""
        import json

        from .. import pc
        from ..alexa import RELAY, interaction_model, skill_code

        alexa = (getattr(self._assistant, "_cfg", {}) or {}).get("alexa", {}) or {}
        if which == "modell":
            text = json.dumps(interaction_model(), ensure_ascii=False, indent=2)
        elif which == "code" and alexa.get("kanal") and alexa.get("schluessel"):
            text = skill_code(alexa["kanal"], alexa["schluessel"], str(alexa.get("vermittlung") or RELAY))
        else:
            return {"ok": False, "text": ""}
        try:
            copied = pc.copy_text(text)
        except Exception as exc:
            log.debug("Zwischenablage: %s", exc)
            copied = False
        return {"ok": copied, "text": text}

    def alexa_console(self) -> bool:
        from .. import pc
        from ..alexa import CONSOLE_URL

        try:
            pc.open_uri(CONSOLE_URL)
            return True
        except Exception as exc:
            log.info("Alexa-Konsole: %s", exc)
            return False

    def alexa_test(self) -> dict:
        """Ein Befehl auf demselben Weg wie vom Echo: kommt eine Antwort zurück?"""
        bridge = getattr(self._assistant, "alexa", None)
        if bridge is None:
            return {"ok": False, "error": "Die Alexa-Verbindung ist aus."}
        try:
            return {"ok": True, "answer": bridge.self_test()}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    # ------------------------------------------------------------------ Gedächtnis

    def memory_state(self) -> dict:
        """Was Jarvis über Georg weiß: Fakten, Kontakte, Gewohnheiten (für die Gedächtnis-Ansicht)."""
        memory = getattr(self._assistant, "memory", None)
        if memory is None:
            return {"facts": [], "contacts": [], "routines": [], "birthdays": []}
        try:
            return {
                "facts": [{"text": f.get("text", ""), "source": f.get("quelle", ""), "since": f.get("seit", "")}
                          for f in reversed(memory.facts())][:60],
                "contacts": [{"name": c.get("name", ""), "app": c.get("app", ""), "count": c.get("anzahl", 0)}
                             for c in memory.contacts()[:12]],
                "routines": [r.as_dict() for r in memory.routines()][:10],
                "birthdays": [{"shown": b["shown"], "date": b["datum"], "days": b["in_tagen"], "own": b["own"]}
                              for b in memory.upcoming_birthdays(days=366)][:12],
            }
        except Exception as exc:
            log.debug("Gedächtnis-Stand: %s", exc)
            return {"facts": [], "contacts": [], "routines": [], "birthdays": []}

    def remember(self, text) -> bool:
        from ..memory import match_memory

        memory = getattr(self._assistant, "memory", None)
        text = " ".join(str(text or "").split())
        if memory is None or not text:
            return False
        # Wie gesprochen: "Merk dir, dass ich Pizza mag" -> "Georg sagt: Ich mag Pizza"
        found = match_memory(text)
        if not found or found[0] != "remember":
            found = match_memory("Merk dir " + text)
        return bool(memory.remember(found[1] if found and found[0] == "remember" else text))

    def forget(self, text) -> bool:
        memory = getattr(self._assistant, "memory", None)
        return bool(memory is not None and str(text or "").strip() and memory.remove(str(text)))

    def answer_suggestion(self, answer) -> bool:
        """Knöpfe am Vorschlag: "Ja", "Nein" oder "Nie wieder"."""
        answer = {"ja": "Ja", "nein": "Nein", "nie": "Nie wieder"}.get(str(answer), "")
        if not answer:
            return False
        self._assistant.submit(answer)
        return True

    def toggle_gaming(self) -> bool:
        """Schalter in der Spalte links: Gaming-Modus an oder aus."""
        self._assistant.toggle_gaming()
        return not bool(getattr(self._assistant, "gaming", False))

    def touched(self) -> None:
        """Die Seite meldet: Georg hat ins Fenster geklickt. Dann verschwindet es nicht von selbst."""
        if self._on_touched is not None:
            self._on_touched()

    # ------------------------------------------------------------------ Werkstatt

    def workshop_state(self) -> dict | None:
        """Der aktuelle Werkstatt-Auftrag (oder None), damit die Ansicht nach einem Neuladen stimmt."""
        shop = getattr(self._assistant, "workshop", None)
        if shop is None:
            return None
        try:
            return shop.snapshot()
        except Exception as exc:
            log.debug("Werkstatt-Stand: %s", exc)
            return None

    def workshop_projects(self) -> list:
        """Alle Werkstatt-Projekte für die Projektliste."""
        shop = getattr(self._assistant, "workshop", None)
        if shop is None:
            return []
        try:
            return shop.projects()[:60]
        except Exception as exc:
            log.debug("Werkstatt-Projekte: %s", exc)
            return []

    def workshop_new(self, text) -> bool:
        """Neuer Auftrag aus der Projektliste."""
        shop = getattr(self._assistant, "workshop", None)
        text = str(text or "").strip()
        if shop is None or not text or shop.busy:
            return False

        def work() -> None:
            self._assistant.announce(shop.start(text))

        threading.Thread(target=work, name="jarvis-werkstatt-neu", daemon=True).start()
        return True

    def workshop_continue(self, folder, text) -> bool:
        """"Weiterarbeiten" an einem Projekt aus der Liste."""
        shop = getattr(self._assistant, "workshop", None)
        text = str(text or "").strip()
        if shop is None or not text:
            return False
        project = next((p for p in shop.projects() if p["folder"] == str(folder)), None)
        if project is None:
            return False

        def work() -> None:
            said = shop.follow_up(text, project)
            self._assistant.announce(said)

        threading.Thread(target=work, name="jarvis-werkstatt-weiter", daemon=True).start()
        return True

    def workshop_run(self, folder) -> bool:
        """"Starten": die start.bat eines Projekts."""
        shop = getattr(self._assistant, "workshop", None)
        if shop is None or not folder:
            return False
        try:
            target = Path(str(folder)).resolve()
            if Path(shop.base).resolve() not in target.parents or not (target / "start.bat").is_file():
                return False
            from ..workshop import _start_file

            _start_file(target / "start.bat", target)
            return True
        except OSError as exc:
            log.info("Projekt starten: %s", exc)
            return False

    def workshop_cancel(self) -> bool:
        """Stopp-Knopf in der Werkstatt."""
        shop = getattr(self._assistant, "workshop", None)
        return bool(shop is not None and shop.cancel())

    def open_folder(self, path) -> bool:
        """Öffnet einen Projektordner im Explorer. Nur Ordner in der Werkstatt, sonst nichts."""
        shop = getattr(self._assistant, "workshop", None)
        if shop is None or not path:
            return False
        try:
            target = Path(str(path)).resolve()
            base = Path(shop.base).resolve()
        except (OSError, ValueError):
            return False
        if base not in target.parents or not target.is_dir():
            return False
        try:
            if os.name == "nt":
                os.startfile(str(target))  # type: ignore[attr-defined]
            else:
                import subprocess

                subprocess.Popen(["xdg-open", str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as exc:
            log.info("Ordner öffnen: %s", exc)
            return False
        return True

    def new_conversation(self) -> None:
        # Erst die laufende Antwort stoppen, sonst landet sie im frisch geleerten Verlauf.
        self._assistant.stop()
        self._assistant.new_conversation()

    def open_setup(self) -> bool:
        """Zahnrad: Einrichtung öffnen. Jarvis schließt sich dafür und startet danach neu."""
        if self._on_setup is None:
            return False
        try:
            self._on_setup()
            return True
        except Exception as exc:
            log.warning("Einrichtung öffnen: %s", exc)
            self._bridge.toast(f"Die Einrichtung ließ sich nicht öffnen: {exc}", "error")
            return False


def webview_available() -> tuple[bool, str]:
    """Prüft, ob das Fenster gehen kann. Gibt (ok, Grund) zurück."""
    try:
        import webview  # noqa: F401
    except Exception as exc:
        return False, f"pywebview fehlt ({exc})"
    if not (WEB_DIR / "index.html").exists():
        return False, "gui/web/index.html fehlt"
    import os

    if os.name == "nt" and not webview2_installed():
        return False, "Microsoft Edge WebView2 fehlt"
    return True, ""


def webview2_installed() -> bool:
    """WebView2 ist bei Windows 11 dabei, bei Windows 10 manchmal nicht."""
    try:
        import winreg
    except ImportError:
        return True
    key = r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    alt = r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    for root, path in (
        (winreg.HKEY_LOCAL_MACHINE, key),
        (winreg.HKEY_LOCAL_MACHINE, alt),
        (winreg.HKEY_CURRENT_USER, alt),
    ):
        try:
            with winreg.OpenKey(root, path) as handle:
                version, _ = winreg.QueryValueEx(handle, "pv")
                if version and version != "0.0.0.0":
                    return True
        except OSError:
            continue
    return False


def place_on_screen(width: int, height: int) -> dict:
    """Größe und Lage für ein Fenster, in logischen Punkten (so rechnet pywebview).

    Das Fenster soll auf den Bildschirm passen, auch bei 150 % Skalierung auf Full HD (dann
    sind nur etwa 1280 x 680 Punkte frei), und mittig über der Taskleiste stehen. Die Lage
    geben wir selbst vor: pywebview 6 setzt die Mitte unter Windows zu spät, das Fenster
    landet sonst an der Standard-Stelle von Windows (nach rechts unten versetzt) und ragt auf
    kleinen Bildschirmen über den Rand."""
    place = {"width": width, "height": height, "x": None, "y": None}
    if os.name != "nt":
        return place
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        area = wintypes.RECT()
        user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(area), 0)  # SPI_GETWORKAREA
        left, top = area.left, area.top
        free_w, free_h = area.right - area.left, area.bottom - area.top
        aware = 0
        try:
            user32.GetThreadDpiAwarenessContext.restype = ctypes.c_void_p
            user32.GetAwarenessFromDpiAwarenessContext.argtypes = [ctypes.c_void_p]
            aware = user32.GetAwarenessFromDpiAwarenessContext(user32.GetThreadDpiAwarenessContext())
        except Exception:
            pass
        if aware:
            # Das Programm sieht echte Pixel, das Fenster wird aber in Punkten angegeben.
            scale = ctypes.windll.shcore.GetScaleFactorForDevice(0) / 100 or 1.0
            left, top = int(left / scale), int(top / scale)
            free_w, free_h = int(free_w / scale), int(free_h / scale)
        if free_w > 400 and free_h > 300:
            width = min(width, free_w - 40)
            height = min(height, free_h - 40)
            place.update(
                width=width,
                height=height,
                x=left + (free_w - width) // 2,
                y=top + (free_h - height) // 2,
            )
    except Exception as exc:
        log.debug("Bildschirmgröße unbekannt: %s", exc)
    return place


TITLE_BAR_COLOR = "#080b11"  # wie der Hintergrund des HUD (style.css --hud-bg)


class Window:
    """Öffnet das Fenster und hält es am Laufen. `start()` blockiert, bis es geschlossen wird.
    Mit `hidden` startet Jarvis unsichtbar (nur Tray-Symbol), das Fenster kommt später."""

    def __init__(self, api: Api, on_started, on_closed, cfg: dict, hidden: bool = False, icon: str | None = None) -> None:
        self._api = api
        self._on_started = on_started
        self._on_closed = on_closed
        self._cfg = cfg
        self._window = None
        self._hidden = hidden
        self._icon = icon
        self._closed_lock = threading.Lock()
        self._closed_done = False
        self.allow_close = True

    @property
    def hidden(self) -> bool:
        return self._hidden

    def start(self) -> None:
        import webview

        place = place_on_screen(int(self._cfg.get("width", 1280)), int(self._cfg.get("height", 800)))
        width, height = place["width"], place["height"]
        self._window = webview.create_window(
            "Jarvis",
            # Ein lokaler Pfad: pywebview liefert die Seite über einen kleinen lokalen Server aus.
            url=str(WEB_DIR / "index.html"),
            js_api=self._api,
            width=width,
            height=height,
            x=place["x"],
            y=place["y"],
            min_size=(min(800, width), min(600, height)),
            background_color="#05080d",
            text_select=True,
            hidden=self._hidden,
        )
        self._window.events.closing += self._closing
        self._window.events.closed += self._closed
        try:
            self._window.events.minimized += self._minimized
        except AttributeError:
            pass
        try:
            # Läuft im Fenster-Thread, bevor das Fenster zum ersten Mal erscheint.
            self._window.events.before_show += self._style_title_bar
        except AttributeError:
            pass  # ältere pywebview-Version: dann färbt show() die Leiste
        try:
            options = {"debug": bool(self._cfg.get("debug", False))}
            if self._icon:
                options["icon"] = self._icon
            try:
                webview.start(self._on_started, **options)
            except TypeError:
                # Ältere pywebview-Version ohne icon=
                options.pop("icon", None)
                webview.start(self._on_started, **options)
        finally:
            # Aufräumen, bevor das Programm endet (das closed-Ereignis läuft in einem
            # eigenen Thread und käme sonst evtl. zu spät).
            self._closed()

    def _closed(self) -> None:
        with self._closed_lock:
            if self._closed_done:
                return
            self._closed_done = True
            try:
                self._on_closed()
            except Exception:
                log.exception("Aufräumen nach dem Schließen")

    def _closing(self):
        if self.allow_close:
            return True
        # Ins Tray-Icon verstecken statt beenden.
        self.hide()
        return False

    def _minimized(self) -> None:
        # Hintergrund-Modus: Minimieren lässt Jarvis ganz verschwinden (auch aus der Taskleiste),
        # er hört weiter zu. Zurück kommt er mit "Hey Jarvis", Strg+Alt+J oder dem Tray-Symbol.
        if self._cfg.get("minimize_to_background", True) and self.allow_close is False:
            self.hide()

    def show_quiet(self) -> None:
        """Erscheint ganz vorn, ohne den Fokus zu nehmen (beim Weckwort)."""
        from .. import desktop

        hwnd = desktop.find_window("Jarvis") if self._window is not None else 0
        if not hwnd or not desktop.show_quietly(hwnd):
            self.show()
            return
        self._quiet = True
        self._hidden = False
        try:
            self._window.evaluate_js("window.jarvisShown && window.jarvisShown()")
        except Exception:
            pass

    def settle(self) -> None:
        """Georg hat das Fenster angefasst: ab jetzt ein ganz normales Fenster."""
        if getattr(self, "_quiet", False):
            from .. import desktop

            desktop.release_topmost(desktop.find_window("Jarvis"))
            self._quiet = False

    def _style_title_bar(self) -> None:
        """Dunkle Titelleiste in der Farbe des HUD, auch wenn Windows auf "hell" steht."""
        from ..desktop import style_title_bar

        style_title_bar("Jarvis", TITLE_BAR_COLOR)

    def show(self) -> None:
        if self._window is not None:
            self._style_title_bar()
            self._window.show()
            self._window.restore()
            self._hidden = False
            try:
                self._window.evaluate_js("window.jarvisShown && window.jarvisShown()")
            except Exception:
                pass

    def hide(self) -> None:
        if self._window is not None:
            self.settle()  # nicht als "immer oben" verstecken, sonst bleibt es beim nächsten Zeigen so
            self._window.hide()
            self._hidden = True

    def toggle(self) -> None:
        self.show() if self._hidden else self.hide()

    def destroy(self) -> None:
        self.allow_close = True
        if self._window is not None:
            self._window.destroy()
