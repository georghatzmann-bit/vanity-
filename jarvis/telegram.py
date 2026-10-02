"""Jarvis über Telegram: vom Handy schreiben oder sprechen, von überall, ohne Tailscale und ohne App-Store.

So geht es (Verbinden > Telegram):
1. In Telegram den @BotFather öffnen, /newbot, einen Namen wählen. Er schickt einen Schlüssel (Token).
2. Den Schlüssel in Jarvis einfügen. Jarvis prüft ihn und zeigt einen Link mit einem Code.
3. Den Link auf dem Handy öffnen und "Starten" tippen. Ab dann gehört der Bot nur diesem Chat.

Danach: Textnachricht oder Sprachnachricht an den Bot, Jarvis erledigt es wie am PC und antwortet mit Text
und (wenn gewünscht) als Sprachnachricht in seiner eigenen Stimme. Erinnerungen und Hinweise kommen auch
dorthin, wenn Georg nicht am PC sitzt.

Jarvis fragt Telegram nur selbst ab (Long-Polling über HTTPS), es braucht keine offenen Ports und keinen
Router. Nachrichten anderer Chats ignoriert er. Die Texte laufen über die Server von Telegram, das steht
so auch im Fenster. Den Schlüssel schreibt Jarvis nie ins Protokoll.
"""

from __future__ import annotations

import io
import json
import logging
import random
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave
from typing import Callable

log = logging.getLogger(__name__)

API = "https://api.telegram.org"
PAIR_MINUTES = 15
MAX_VOICE_BYTES = 20 * 1024 * 1024  # mehr liefert Telegram Bots ohnehin nicht aus
TOKEN_FORMAT = re.compile(r"^\d{5,12}:[A-Za-z0-9_-]{30,50}$")


class TelegramError(RuntimeError):
    pass


def valid_token(token: str) -> bool:
    return bool(TOKEN_FORMAT.match(str(token or "").strip()))


def ogg_opus(wav_bytes: bytes) -> bytes:
    """WAV (Jarvis' Stimme) -> OGG/Opus, das Format für Sprachnachrichten in Telegram (PyAV)."""
    import av
    import numpy as np

    with wave.open(io.BytesIO(wav_bytes)) as src:
        rate = src.getframerate()
        pcm = np.frombuffer(src.readframes(src.getnframes()), np.int16)
    out = io.BytesIO()
    container = av.open(out, mode="w", format="ogg")
    stream = container.add_stream("libopus", rate=48000)
    stream.bit_rate = 32000
    stream.layout = "mono"
    resampler = av.AudioResampler(format="s16", layout="mono", rate=48000, frame_size=960)
    frame = av.AudioFrame.from_ndarray(pcm.reshape(1, -1), format="s16", layout="mono")
    frame.sample_rate = rate
    for chunk in resampler.resample(frame) + resampler.resample(None):
        for packet in stream.encode(chunk):
            container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)
    container.close()
    return out.getvalue()


class TelegramBot:
    """Ein Telegram-Bot, der nur Georg gehört. start() fragt im Hintergrund nach neuen Nachrichten."""

    def __init__(self, cfg: dict, assistant, save: Callable[[str, str, object], None] | None = None,
                 api: str = API, poll_timeout: int = 50) -> None:
        section = cfg.get("telegram", {}) or {}
        self.token = str(section.get("token") or "").strip()
        try:
            self.chat_id = int(section.get("chat_id") or 0)
        except (TypeError, ValueError):
            self.chat_id = 0
        self.voice = bool(section.get("sprache", True))
        self.enabled = bool(section.get("aktiv", False)) and bool(self.token)
        self.username = str(section.get("name") or "")
        self.on_paired: Callable[[str], None] | None = None  # das Fenster zeigt "Verbunden"
        self._assistant = assistant
        self._save = save
        self._api = api.rstrip("/")
        self._poll_timeout = poll_timeout
        self._offset = 0
        self._pair_code = ""
        self._pair_until = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._strangers: set[int] = set()
        self.last_error = ""

    # ------------------------------------------------------------------ Telegram-API

    def _call(self, method: str, params: dict | None = None, files: dict | None = None, timeout: float = 30,
              token: str | None = None) -> object:
        token = token or self.token
        if not token:
            raise TelegramError("Kein Bot-Schlüssel eingetragen.")
        url = f"{self._api}/bot{token}/{method}"
        if files:
            boundary = uuid.uuid4().hex
            body = io.BytesIO()
            for key, value in (params or {}).items():
                body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode())
            for key, (name, data, kind) in files.items():
                body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"; filename=\"{name}\"\r\n"
                           f"Content-Type: {kind}\r\n\r\n".encode())
                body.write(data)
                body.write(b"\r\n")
            body.write(f"--{boundary}--\r\n".encode())
            request = urllib.request.Request(url, data=body.getvalue(), method="POST",
                                             headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        else:
            data = json.dumps(params or {}).encode("utf-8")
            request = urllib.request.Request(url, data=data, method="POST",
                                             headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                reply = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            try:
                reply = json.loads(exc.read().decode("utf-8"))
            except (ValueError, OSError):
                raise TelegramError(f"Telegram antwortet mit Fehler {exc.code}.") from None
        except (OSError, ValueError):
            # Der Schlüssel steht in der Adresse: nie die Ausnahme selbst weitergeben
            raise TelegramError("Telegram ist gerade nicht erreichbar.") from None
        if not isinstance(reply, dict) or not reply.get("ok"):
            text = str((reply or {}).get("description") or "unbekannter Fehler") if isinstance(reply, dict) else "?"
            raise TelegramError(f"Telegram: {text}")
        return reply.get("result")

    def check(self, token: str | None = None) -> dict:
        """Prüft einen Schlüssel (getMe), ohne ihn schon zu übernehmen. {"ok", "name", "error"}"""
        mine = token is None
        token = self.token if mine else str(token).strip()
        if not valid_token(token):
            return {"ok": False, "name": "", "error": "Das sieht nicht wie ein Bot-Schlüssel aus (Zahl, Doppelpunkt, langer Text)."}
        try:
            me = self._call("getMe", timeout=15, token=token)
        except TelegramError as exc:
            text = str(exc)
            if "unauthorized" in text.lower() or "not found" in text.lower():
                text = "Diesen Schlüssel kennt Telegram nicht. Bitte noch einmal beim @BotFather kopieren."
            return {"ok": False, "name": "", "error": text}
        name = str((me or {}).get("username") or "") if isinstance(me, dict) else ""
        if mine:
            self.username = name
        return {"ok": True, "name": name, "error": ""}

    def send(self, text: str, voice: bool = False) -> bool:
        """Eine Nachricht an Georg (und auf Wunsch als Sprachnachricht in Jarvis' Stimme)."""
        if not (self.token and self.chat_id and text):
            return False
        ok = True
        try:
            self._call("sendMessage", {"chat_id": self.chat_id, "text": str(text)[:4000]})
        except TelegramError as exc:
            log.info("Telegram, Nachricht: %s", exc)
            ok = False
        if voice and self.voice:
            try:
                audio = ogg_opus(self._assistant.speech_wav(text))
                self._call("sendVoice", {"chat_id": self.chat_id}, files={"voice": ("jarvis.ogg", audio, "audio/ogg")},
                           timeout=60)
            except Exception as exc:
                log.info("Telegram, Sprachnachricht: %s", exc)
        return ok

    def notify(self, text: str) -> bool:
        """Hinweise und Erinnerungen, wenn Georg nicht am PC sitzt (wie die Benachrichtigungen über ntfy)."""
        if not self.enabled or not self.chat_id:
            return False
        return self.send(text)

    # ------------------------------------------------------------------ Koppeln

    def pairing(self) -> dict:
        """Ein neuer Code (gilt 15 Minuten) und der Link, der den Chat mit Jarvis verbindet."""
        self._pair_code = f"{secrets.randbelow(1_000_000):06d}"
        self._pair_until = time.monotonic() + PAIR_MINUTES * 60
        link = f"https://t.me/{self.username}?start={self._pair_code}" if self.username else ""
        return {"code": self._pair_code, "link": link, "name": self.username}

    def use_token(self, token: str, name: str) -> None:
        """Ein anderer Bot: gehört noch niemandem, und seine Nachrichten fangen bei null an."""
        if token != self.token:
            self._offset = 0
            self._strangers.clear()
            self.unpair()
        self.token = token
        self.username = name

    def unpair(self) -> None:
        self.chat_id = 0
        if self._save is not None:
            self._save("telegram", "chat_id", 0)

    def _try_pair(self, chat: int, text: str, who: str) -> None:
        found = re.match(r"^/start(?:\s+(\d{6}))?\s*$|^(\d{6})$", text.strip())
        code = (found.group(1) or found.group(2)) if found else ""
        if code and self._pair_code and secrets.compare_digest(code, self._pair_code) and time.monotonic() < self._pair_until:
            self.chat_id = chat
            self._pair_code = ""
            if self._save is not None:
                self._save("telegram", "chat_id", chat)
            log.info("Telegram verbunden mit %s.", who or "einem Chat")
            self._reply(chat, "Verbunden, Sir. Schreiben Sie mir oder schicken Sie eine Sprachnachricht. "
                              "Ich erledige es wie am PC.")
            if self.on_paired is not None:
                try:
                    self.on_paired(who)
                except Exception:
                    pass
            return
        self._reply(chat, "Guten Tag. Zum Verbinden bitte den Link oder Code aus dem Jarvis-Fenster nehmen "
                          "(Verbinden > Telegram).")

    def _reply(self, chat: int, text: str) -> None:
        try:
            self._call("sendMessage", {"chat_id": chat, "text": text})
        except TelegramError as exc:
            log.info("Telegram: %s", exc)

    # ------------------------------------------------------------------ Nachrichten

    def start(self) -> bool:
        if not self.enabled or (self._thread is not None and self._thread.is_alive()):
            return False
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="jarvis-telegram", daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stop.set()

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive() and not self._stop.is_set()

    def _loop(self) -> None:
        if not self.username:
            self.check()
        pause = 2.0
        while not self._stop.is_set():
            try:
                updates = self._call("getUpdates", {"offset": self._offset, "timeout": self._poll_timeout,
                                                    "allowed_updates": ["message"]}, timeout=self._poll_timeout + 15)
                pause = 2.0
                self.last_error = ""
            except TelegramError as exc:
                self.last_error = str(exc)
                log.info("Telegram: %s (nächster Versuch in %.0f s)", exc, pause)
                if self._stop.wait(pause):
                    return
                pause = min(120.0, pause * 2)
                continue
            for update in updates or []:
                if not isinstance(update, dict):
                    continue
                self._offset = max(self._offset, int(update.get("update_id", 0)) + 1)
                message = update.get("message")
                if isinstance(message, dict):
                    try:
                        self.handle(message)
                    except Exception:
                        log.exception("Telegram-Nachricht")

    def handle(self, message: dict) -> None:
        chat = int((message.get("chat") or {}).get("id") or 0)
        sender = message.get("from") or {}
        who = str(sender.get("first_name") or sender.get("username") or "")
        text = str(message.get("text") or "").strip()
        if not chat:
            return
        if not self.chat_id:
            self._try_pair(chat, text, who)
            return
        if chat != self.chat_id:
            if chat not in self._strangers:  # nur einmal antworten, nie etwas tun
                self._strangers.add(chat)
                self._reply(chat, "Dieser Jarvis gehört jemand anderem.")
            log.info("Telegram: Nachricht aus einem fremden Chat ignoriert.")
            return
        voice = message.get("voice") or message.get("audio")
        if isinstance(voice, dict) and voice.get("file_id"):
            threading.Thread(target=self._voice, args=(voice,), name="jarvis-telegram-sprache", daemon=True).start()
            return
        if text in ("/start", "/hilfe", "/help"):
            self._reply(chat, "Schreiben Sie mir, was ich tun soll, oder schicken Sie eine Sprachnachricht, Sir.")
            return
        if text:
            threading.Thread(target=self._answer, args=(text, False), name="jarvis-telegram-befehl", daemon=True).start()

    def _typing(self) -> None:
        try:
            self._call("sendChatAction", {"chat_id": self.chat_id, "action": "typing"}, timeout=10)
        except TelegramError:
            pass

    def _answer(self, text: str, spoken: bool) -> None:
        log.info("Telegram: %s", text)
        self._typing()
        try:
            answer = self._assistant.handle(text, speak=False)
        except Exception as exc:
            log.warning("Telegram, Befehl: %s", exc)
            answer = "Das hat leider nicht geklappt, Sir."
        self.send(answer or "Erledigt, Sir.", voice=spoken)

    def _voice(self, voice: dict) -> None:
        """Eine Sprachnachricht: laden, erkennen, erledigen, mit Stimme antworten."""
        try:
            if int(voice.get("file_size") or 0) > MAX_VOICE_BYTES:
                self.send("Die Sprachnachricht ist mir zu lang, Sir.")
                return
            info = self._call("getFile", {"file_id": voice["file_id"]}, timeout=20)
            path = str((info or {}).get("file_path") or "")
            if not path:
                raise TelegramError("Datei fehlt")
            with urllib.request.urlopen(f"{self._api}/file/bot{self.token}/{path}", timeout=60) as response:
                data = response.read(MAX_VOICE_BYTES + 1)
            text = self._assistant.hear(data)
        except Exception as exc:
            log.info("Telegram, Sprachnachricht: %s", type(exc).__name__)
            self.send("Die Sprachnachricht konnte ich leider nicht anhören, Sir.")
            return
        if not text:
            self.send(random.choice(["Das habe ich nicht verstanden, Sir.", "Verzeihung, Sir, da war nichts zu verstehen."]))
            return
        self._answer(text, spoken=True)
