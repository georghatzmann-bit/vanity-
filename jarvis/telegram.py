"""Jarvis über Telegram: vom Handy schreiben, sprechen, Fotos und den Standort schicken, von überall, ohne Tailscale
und ohne App-Store. Jarvis schreibt auch von selbst: Erinnerungen, Hinweise und das Briefing, wenn Georg nicht am PC
sitzt, auf Wunsch als Sprachnachricht in seiner Stimme (wie ein kurzer Anruf).

So geht es (Verbinden > Telegram):
1. In Telegram den @BotFather öffnen, /newbot, einen Namen wählen. Er schickt einen Schlüssel (Token).
2. Den Schlüssel in Jarvis einfügen. Jarvis prüft ihn und zeigt einen Link mit einem Code.
3. Den Link auf dem Handy öffnen und "Starten" tippen. Ab dann gehört der Bot nur diesem Chat.

Danach:
- Text oder Sprachnachricht: Jarvis erledigt es wie am PC und antwortet mit Text, auf Sprachnachrichten auch mit
  einer Sprachnachricht. Fragt er zurück ("Soll ich es starten?"), stehen Knöpfe für Ja und Nein darunter.
- Foto (mit oder ohne Text dazu): geht an Claude, der es sich ansieht. Essen landet so im Ernährungs-Tagebuch.
- Standort: Jarvis sagt, wo der nächste Supermarkt ist und was auf der Einkaufsliste steht. Teilt Georg den
  Live-Standort, meldet sich Jarvis unterwegs von selbst, wenn er an einem Supermarkt vorbeikommt und etwas auf der
  Liste steht ("Ach, und wo Sie gerade eh unterwegs sind ...").

Jarvis fragt Telegram nur selbst ab (Long-Polling über HTTPS), es braucht keine offenen Ports und keinen
Router. Nachrichten anderer Chats ignoriert er. Die Texte laufen über die Server von Telegram, das steht
so auch im Fenster. Den Schlüssel schreibt Jarvis nie ins Protokoll.
"""

from __future__ import annotations

import datetime as dt
import http.client
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
from pathlib import Path
from typing import Callable

from .anrede import apply as anrede

log = logging.getLogger(__name__)

API = "https://api.telegram.org"
PAIR_MINUTES = 15
MAX_VOICE_BYTES = 20 * 1024 * 1024  # mehr liefert Telegram Bots ohnehin nicht aus
MAX_PHOTO_BYTES = 10 * 1024 * 1024
MAX_VIDEO_BYTES = 20 * 1024 * 1024  # mehr gibt Telegram einem Bot nicht heraus (getFile)
PHOTO_DAYS = 30  # so lange bleiben geschickte Fotos auf dem PC
VIDEO_DAYS = 14  # Videos sind größer: kürzer
VOICE_CHARS = 900  # so viel liest Jarvis in einer Sprachnachricht vor
TOKEN_FORMAT = re.compile(r"^\d{5,12}:[A-Za-z0-9_-]{30,50}$")
# Live-Standort: so selten fragt Jarvis nach Supermärkten, und so nah muss einer sein
CHECK_SECONDS = 120
CHECK_METERS = 150
NUDGE_METERS = 400
NUDGE_GAP = 30 * 60  # höchstens ein Hinweis pro halbe Stunde
SAME_SHOP_HOURS = 4
COMMANDS = [
    {"command": "einkauf", "description": "Einkaufsliste zeigen"},
    {"command": "briefing", "description": "Briefing für heute"},
    {"command": "standort", "description": "So findet Jarvis den nächsten Supermarkt"},
    {"command": "hilfe", "description": "Was Jarvis hier kann"},
]
HELP = ("Schreiben Sie mir, was ich tun soll, oder schicken Sie eine Sprachnachricht, Sir. Ich erledige es wie am PC. "
        "Fotos und Videos sehe ich mir an, auch einen TikTok- oder YouTube-Link (Essen trage ich ins "
        "Ernährungs-Tagebuch ein). Schicken Sie mir Ihren Standort, sage ich "
        "Ihnen, wo der nächste Supermarkt ist und was auf der Einkaufsliste steht. /einkauf zeigt die Liste, "
        "/briefing das Briefing für heute.")
PLACE_HELP = ("Tippen Sie unten auf die Büroklammer, dann auf Standort, Sir. „Live-Standort teilen“ heißt: Ich melde "
              "mich unterwegs, wenn Sie an einem Supermarkt vorbeikommen und etwas auf der Einkaufsliste steht. "
              "Ihren Standort speichere ich nicht. Außer Telegram sieht ihn nur die Supermarkt-Suche (OpenStreetMap), "
              "ohne Ihren Namen.")
_W_WORDS = re.compile(r"^(?:was|wie|wann|wo|wer|wen|wem|wessen|welche[rsnm]?|warum|wieso|weshalb|weswegen|wohin|"
                      r"woher|womit|wofür|worüber|wozu|wieviel|wie viel)\b", re.I)


class TelegramError(RuntimeError):
    pass


def valid_token(token: str) -> bool:
    return bool(TOKEN_FORMAT.match(str(token or "").strip()))


def is_question(text: str) -> bool:
    """Eine Ja/Nein-Frage am Ende ("Soll ich es starten?"), keine W-Frage ("Was machen wir heute?")."""
    text = str(text or "").strip()
    if not text.endswith("?"):
        return False
    last = re.split(r"(?<=[.!?])\s+", text)[-1].strip(" „“\"'")
    return bool(last) and not _W_WORDS.match(last)


def voice_text(text: str, limit: int = VOICE_CHARS) -> str:
    """Für eine Sprachnachricht: ganze Sätze bis etwa `limit` Zeichen (nicht mitten im Wort abschneiden)."""
    text = " ".join(str(text or "").split())
    if len(text) <= limit:
        return text
    out = ""
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if out and len(out) + 1 + len(sentence) > limit:
            break
        out = f"{out} {sentence}".strip()
    return out if out else text[:limit].rsplit(" ", 1)[0]


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
                 api: str = API, poll_timeout: int = 50, folder: Path | None = None, nearby=None) -> None:
        section = cfg.get("telegram", {}) or {}
        self.token = str(section.get("token") or "").strip()
        try:
            self.chat_id = int(section.get("chat_id") or 0)
        except (TypeError, ValueError):
            self.chat_id = 0
        self.voice = bool(section.get("sprache", True))  # Antworten auf Sprachnachrichten auch als Sprachnachricht
        self.voice_notes = bool(section.get("sprache_hinweise", True))  # Hinweise "wie ein Anruf"
        self.places = bool(section.get("standort", True))  # Standort: Supermärkte und Einkaufsliste
        self.enabled = bool(section.get("aktiv", False)) and bool(self.token)
        self.username = str(section.get("name") or "")
        self.on_paired: Callable[[str], None] | None = None  # das Fenster zeigt "Verbunden"
        self.photo_hint = ""  # wo das Ernährungs-Tagebuch steht (Claude-Plugin Körper), siehe __main__
        self._assistant = assistant
        self._save = save
        self._api = api.rstrip("/")
        self._poll_timeout = poll_timeout
        self._folder = Path(folder) if folder else None
        self._nearby = nearby
        self._offset = 0
        self._pair_code = ""
        self._pair_until = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._strangers: set[int] = set()
        self._menu_for = ""  # für welchen Bot das Befehlsmenü schon gesetzt ist
        self.where: dict | None = None  # der letzte Standort {lat, lon, zeit, live}
        self._last_check: tuple[float, tuple[float, float] | None] = (0.0, None)
        self._last_nudge = float("-inf")
        self._nudged: dict[str, float] = {}
        self._place_lock = threading.Lock()
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
        except (OSError, ValueError, http.client.HTTPException):
            # Der Schlüssel steht in der Adresse: nie die Ausnahme selbst weitergeben
            raise TelegramError("Telegram ist gerade nicht erreichbar.") from None
        if not isinstance(reply, dict) or not reply.get("ok"):
            text = str((reply or {}).get("description") or "unbekannter Fehler") if isinstance(reply, dict) else "?"
            raise TelegramError(f"Telegram: {text}")
        return reply.get("result")

    def _download(self, file_id: str, limit: int) -> bytes:
        """Eine Datei, die Georg geschickt hat (Sprachnachricht, Foto). Höchstens `limit` Bytes."""
        info = self._call("getFile", {"file_id": file_id}, timeout=20)
        path = str((info or {}).get("file_path") or "") if isinstance(info, dict) else ""
        if not path:
            raise TelegramError("Datei fehlt")
        try:
            with urllib.request.urlopen(f"{self._api}/file/bot{self.token}/{path}", timeout=60) as response:
                data = response.read(limit + 1)
        except (OSError, ValueError, http.client.HTTPException):
            raise TelegramError("Die Datei ließ sich nicht laden.") from None  # ohne Adresse (Schlüssel)
        if len(data) > limit:
            raise TelegramError("Die Datei ist zu groß.")
        return data

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

    def send(self, text: str, voice: bool = False, ask: bool | None = None) -> bool:
        """Eine Nachricht an Georg, auf Wunsch zusätzlich als Sprachnachricht in Jarvis' Stimme. Ist es eine
        Ja/Nein-Frage (ask=None: von selbst erkannt), stehen Knöpfe für Ja und Nein darunter."""
        text = anrede(str(text or "")).strip()
        if not (self.token and self.chat_id and text):
            return False
        ok = True
        params: dict = {"chat_id": self.chat_id, "text": text[:4000]}
        if is_question(text) if ask is None else ask:
            params["reply_markup"] = {"inline_keyboard": [[{"text": "Ja", "callback_data": "ja"},
                                                           {"text": "Nein", "callback_data": "nein"}]]}
        try:
            self._call("sendMessage", params)
        except TelegramError as exc:
            log.info("Telegram, Nachricht: %s", exc)
            ok = False
        if voice:
            self.send_voice(text)
        return ok

    def send_voice(self, text: str) -> bool:
        if not (self.token and self.chat_id and text):
            return False
        try:
            audio = ogg_opus(self._speech(voice_text(text)))
            self._call("sendVoice", {"chat_id": self.chat_id}, files={"voice": ("jarvis.ogg", audio, "audio/ogg")},
                       timeout=60)
            return True
        except Exception as exc:
            log.info("Telegram, Sprachnachricht: %s", type(exc).__name__ if not isinstance(exc, TelegramError) else exc)
            return False

    def _speech(self, text: str) -> bytes:
        try:
            return self._assistant.speech_wav(text, limit=VOICE_CHARS + 50)
        except TypeError:  # ältere Fassung ohne limit
            return self._assistant.speech_wav(text)

    def notify(self, text: str) -> bool:
        """Hinweise, Erinnerungen und das Briefing, wenn Georg nicht am PC sitzt (wie die Benachrichtigungen über
        ntfy). Auf Wunsch auch als Sprachnachricht, wie ein kurzer Anruf von Jarvis."""
        if not self.enabled or not self.chat_id:
            return False
        return self.send(text, voice=self.voice_notes)

    # ------------------------------------------------------------------ Koppeln

    def pairing(self) -> dict:
        """Ein neuer Code (gilt 15 Minuten) und der Link, der den Chat mit Jarvis verbindet."""
        self._pair_code = f"{secrets.randbelow(1_000_000):06d}"
        self._pair_until = time.monotonic() + PAIR_MINUTES * 60
        link = f"https://t.me/{self.username}?start={self._pair_code}" if self.username else ""
        return {"code": self._pair_code, "link": link, "name": self.username}

    def use_token(self, token: str, name: str) -> None:
        """Ein anderer Bot: gehört noch niemandem, und seine Nachrichten fangen bei null an."""
        restart = token != self.token and self.running
        if token != self.token:
            self._offset = 0
            self._strangers.clear()
            self._menu_for = ""
            self.unpair()
        self.token = token
        self.username = name
        if restart:  # nicht noch bis zu 50 s auf den alten Bot warten
            self.stop()
            self.start()

    def unpair(self) -> None:
        self.chat_id = 0
        self.where = None
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
            self._reply(chat, "Verbunden, Sir. Schreiben Sie mir, schicken Sie eine Sprachnachricht, ein Foto oder "
                              "Ihren Standort. Ich erledige es wie am PC.")
            self._menu()
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
            self._call("sendMessage", {"chat_id": chat, "text": anrede(text)})
        except TelegramError as exc:
            log.info("Telegram: %s", exc)

    def _menu(self) -> None:
        """Das Befehlsmenü in Telegram (/einkauf, /briefing ...), einmal pro Bot."""
        if not self.token or self._menu_for == self.token:
            return
        try:
            self._call("setMyCommands", {"commands": COMMANDS}, timeout=15)
            self._menu_for = self.token
        except TelegramError as exc:
            log.debug("Telegram, Befehlsmenü: %s", exc)

    # ------------------------------------------------------------------ Nachrichten

    def start(self) -> bool:
        if not self.enabled or self.running:
            return False
        # Jede Runde hat ihr eigenes Stopp-Signal: Eine gerade gestoppte Runde wartet vielleicht noch auf
        # Telegram (bis zu 50 s) und hört danach auf, ohne etwas zu erledigen. Die neue fragt sofort.
        self._stop.set()
        self._stop = stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, args=(stop,), name="jarvis-telegram", daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stop.set()

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive() and not self._stop.is_set()

    def _loop(self, stop: threading.Event) -> None:
        pause = 2.0
        while not stop.is_set():
            try:
                if not self.username:
                    self.check()
                if self.chat_id:
                    self._menu()
                updates = self._call("getUpdates", {"offset": self._offset, "timeout": self._poll_timeout,
                                                    "allowed_updates": ["message", "edited_message", "callback_query"]},
                                     timeout=self._poll_timeout + 15)
            except Exception as exc:
                if stop.is_set():  # abgelöst (Telegram meldet dann "Conflict"): kein Fehler fürs Fenster
                    return
                self.last_error = str(exc) if isinstance(exc, TelegramError) else "Telegram ist gerade nicht erreichbar."
                log.info("Telegram: %s (nächster Versuch in %.0f s)", self.last_error, pause)
                if stop.wait(pause):
                    return
                pause = min(120.0, pause * 2)
                continue
            if stop.is_set():  # ausgeschaltet oder anderer Bot: die nächste Runde holt die Nachrichten selbst
                return
            pause = 2.0
            self.last_error = ""
            for update in updates or []:
                if not isinstance(update, dict):
                    continue
                self._offset = max(self._offset, int(update.get("update_id", 0)) + 1)
                try:
                    if isinstance(update.get("message"), dict):
                        self.handle(update["message"])
                    elif isinstance(update.get("edited_message"), dict):
                        self.handle(update["edited_message"], edited=True)  # Live-Standort bewegt sich
                    elif isinstance(update.get("callback_query"), dict):
                        self.button(update["callback_query"])
                except Exception:
                    log.exception("Telegram-Nachricht")

    def _owner(self, chat: int) -> bool:
        """Nur Georgs Chat. Fremde bekommen ein einziges Mal eine Antwort, getan wird nie etwas."""
        if chat == self.chat_id:
            return True
        if chat not in self._strangers:
            self._strangers.add(chat)
            self._reply(chat, "Dieser Jarvis gehört jemand anderem.")
        log.info("Telegram: Nachricht aus einem fremden Chat ignoriert.")
        return False

    def handle(self, message: dict, edited: bool = False) -> None:
        chat = int((message.get("chat") or {}).get("id") or 0)
        sender = message.get("from") or {}
        who = str(sender.get("first_name") or sender.get("username") or "")
        text = str(message.get("text") or "").strip()
        location = message.get("location")
        if not chat:
            return
        if edited:  # bearbeitete Nachrichten: nur der Live-Standort zählt
            if self.chat_id and chat == self.chat_id and isinstance(location, dict):
                self._spawn(self.place, location, True, "jarvis-telegram-standort")
            return
        if not self.chat_id:
            self._try_pair(chat, text, who)
            return
        if not self._owner(chat):
            return
        voice = message.get("voice") or message.get("audio")
        if isinstance(voice, dict) and voice.get("file_id"):
            self._spawn(self._voice, voice, None, "jarvis-telegram-sprache")
            return
        photo = _photo_file(message)
        if photo is not None:
            caption = str(message.get("caption") or "").strip()
            self._spawn(self._photo, photo, caption, "jarvis-telegram-foto")
            return
        clip = _video_file(message)
        if clip is not None:
            caption = str(message.get("caption") or "").strip()
            self._spawn(self._video, clip, caption, "jarvis-telegram-video")
            return
        if isinstance(location, dict) and "latitude" in location:
            self._spawn(self.place, location, False, "jarvis-telegram-standort")
            return
        command = text.split("@", 1)[0].lower() if text.startswith("/") else ""
        if command in ("/start", "/hilfe", "/help"):
            self._reply(chat, HELP)
            return
        if command == "/standort":
            self._reply(chat, PLACE_HELP)
            return
        if command == "/einkauf":
            text = "Was steht auf der Einkaufsliste?"
        elif command == "/briefing":
            text = "Briefing"
        if text:
            self._spawn(self._answer, text, False, "jarvis-telegram-befehl")

    @staticmethod
    def _spawn(target, first, second, name: str) -> None:
        args = (first,) if second is None else (first, second)
        threading.Thread(target=target, args=args, name=name, daemon=True).start()

    def button(self, query: dict) -> None:
        """Ein Knopf unter einer Frage ("Ja" / "Nein"): gilt wie die getippte Antwort, danach sind die Knöpfe weg."""
        message = query.get("message") or {}
        chat = int((message.get("chat") or {}).get("id") or 0)
        try:
            self._call("answerCallbackQuery", {"callback_query_id": str(query.get("id") or "")}, timeout=10)
        except TelegramError:
            pass
        if not self.chat_id or not chat or not self._owner(chat):
            return
        try:
            self._call("editMessageReplyMarkup", {"chat_id": chat, "message_id": message.get("message_id"),
                                                  "reply_markup": {"inline_keyboard": []}}, timeout=10)
        except TelegramError:
            pass
        said = {"ja": "Ja", "nein": "Nein"}.get(str(query.get("data") or ""))
        if said:
            self._spawn(self._answer, said, False, "jarvis-telegram-knopf")

    def _typing(self) -> None:
        try:
            self._call("sendChatAction", {"chat_id": self.chat_id, "action": "typing"}, timeout=10)
        except TelegramError:
            pass

    def _answer(self, text: str, spoken: bool, extra: str = "") -> None:
        log.info("Telegram: %s", text)
        self._typing()
        try:
            if extra:
                answer = self._assistant.handle(text, speak=False, extra=extra)
            else:
                answer = self._assistant.handle(text, speak=False)
        except Exception as exc:
            log.warning("Telegram, Befehl: %s", exc)
            answer = "Das hat leider nicht geklappt, Sir."
        self.send(answer or "Erledigt, Sir.", voice=spoken and self.voice)

    def _voice(self, voice: dict) -> None:
        """Eine Sprachnachricht: laden, erkennen, erledigen, mit Stimme antworten."""
        try:
            if int(voice.get("file_size") or 0) > MAX_VOICE_BYTES:
                self.send("Die Sprachnachricht ist mir zu lang, Sir.")
                return
            text = self._assistant.hear(self._download(voice["file_id"], MAX_VOICE_BYTES))
        except Exception as exc:
            log.info("Telegram, Sprachnachricht: %s", type(exc).__name__)
            self.send("Die Sprachnachricht konnte ich leider nicht anhören, Sir.")
            return
        if not text:
            self.send(random.choice(["Das habe ich nicht verstanden, Sir.", "Verzeihung, Sir, da war nichts zu verstehen."]))
            return
        self._answer(text, spoken=True)

    # ------------------------------------------------------------------ Fotos

    def _photo(self, photo: dict, caption: str) -> None:
        """Ein Foto: auf dem PC ablegen und Claude ansehen lassen (mit dem Text, den Georg dazu geschrieben hat)."""
        if self._folder is None:
            self.send("Fotos kann ich hier gerade nicht ansehen, Sir.")
            return
        try:
            if int(photo.get("file_size") or 0) > MAX_PHOTO_BYTES:
                self.send("Das Foto ist mir zu groß, Sir. Bitte als normales Foto schicken, nicht als Datei.")
                return
            data = self._download(photo["file_id"], MAX_PHOTO_BYTES)
            path = self._keep_photo(data, photo.get("suffix") or ".jpg")
        except Exception as exc:
            log.info("Telegram, Foto: %s", type(exc).__name__)
            self.send("Das Foto konnte ich leider nicht laden, Sir.")
            return
        note = (f"(Dazu hat Georg dir über Telegram ein Foto geschickt. Sieh es dir zuerst mit dem Read-Werkzeug an: "
                f"{path}. Antworte kurz wie in einem Chat.{(' ' + self.photo_hint) if self.photo_hint else ''})")
        self._answer(caption or "Was sagst du zu dem Foto?", False, extra=note)

    def _video(self, clip: dict, caption: str) -> None:
        """Ein Video (auch eine runde Videonachricht): ablegen, dann sieht Claude es sich mit jarvis.video an."""
        if self._folder is None:
            self.send("Videos kann ich hier gerade nicht ansehen, Sir.")
            return
        try:
            if int(clip.get("file_size") or 0) > MAX_VIDEO_BYTES:
                self.send("Das Video ist mir zu groß, Sir (Telegram gibt mir höchstens 20 MB). Schicken Sie mir "
                          "lieber den Link, zum Beispiel aus TikTok über Teilen.")
                return
            data = self._download(clip["file_id"], MAX_VIDEO_BYTES)
            path = self._keep_photo(data, clip.get("suffix") or ".mp4", "videos")
        except Exception as exc:
            log.info("Telegram, Video: %s", type(exc).__name__)
            self.send("Das Video konnte ich leider nicht laden, Sir.")
            return
        note = (f'(Dazu hat Georg dir über Telegram ein Video geschickt: {path}. Sieh es dir mit `python -m jarvis.tool '
                f'video "{path}"` an (timeout 600000), dann die Übersichtsbilder mit dem Read-Werkzeug. Antworte kurz '
                f"wie in einem Chat.)")
        self._answer(caption or "Was passiert in dem Video?", False, extra=note)

    def _keep_photo(self, data: bytes, suffix: str, kind: str = "fotos") -> Path:
        folder = self._folder / kind
        folder.mkdir(parents=True, exist_ok=True)
        cutoff = time.time() - (VIDEO_DAYS if kind == "videos" else PHOTO_DAYS) * 86400
        for old in folder.glob("*"):
            try:
                if old.is_file() and old.stat().st_mtime < cutoff:
                    old.unlink()
            except OSError:
                pass
        stamp = dt.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        allowed = r"\.(?:mp4|mov|webm|mkv|m4v|3gp)" if kind == "videos" else r"\.(?:jpe?g|png|webp|gif|heic)"
        suffix = suffix if re.fullmatch(allowed, suffix.lower()) else (".mp4" if kind == "videos" else ".jpg")
        path = folder / f"{stamp}_{secrets.token_hex(2)}{suffix.lower()}"
        path.write_bytes(data)
        return path

    # ------------------------------------------------------------------ Standort

    def _shopping(self) -> list[str]:
        memory = getattr(self._assistant, "memory", None)
        try:
            return list(memory.shopping()) if memory is not None else []
        except Exception:
            return []

    def _places(self):
        if self._nearby is None:
            from .naehe import Nearby

            self._nearby = Nearby()
        return self._nearby

    def place(self, location: dict, update: bool) -> None:
        """Ein Standort: der nächste Supermarkt und die Einkaufsliste. Beim Live-Standort (update=True: Telegram
        meldet, dass Georg sich bewegt hat) meldet sich Jarvis nur, wenn er an einem Supermarkt vorbeikommt."""
        try:
            lat, lon = float(location["latitude"]), float(location["longitude"])
        except (KeyError, TypeError, ValueError):
            return
        live = update or bool(location.get("live_period"))
        self.where = {"lat": lat, "lon": lon, "zeit": dt.datetime.now().isoformat(timespec="minutes"), "live": live}
        if not self.places:
            if not update:
                self.send("Danke, Sir. Mit dem Standort mache ich gerade nichts, das ist unter Verbinden > Telegram aus.")
            return
        if update:
            self._nudge(lat, lon)
            return
        from .einkauf import join
        from .naehe import RADIUS, spoken_distance, walk_minutes

        listed = self._shopping()
        shop = self._places().nearest(lat, lon)
        with self._place_lock:
            self._last_check = (time.monotonic(), (lat, lon))
            if shop is not None:
                self._nudged[shop["id"]] = time.monotonic()  # gerade erst gesagt: nicht gleich noch einmal
        wish = f" Auf Ihrer Einkaufsliste: {join(listed)}." if listed else " Ihre Einkaufsliste ist leer, Sir."
        if shop is None:
            if getattr(self._places(), "failed", False):
                self.send("Die Supermarkt-Suche von OpenStreetMap antwortet gerade nicht. Schicken Sie mir den Standort "
                          "später noch einmal." + wish)
            else:
                self.send(f"Im Umkreis von {spoken_distance(RADIUS)}n finde ich keinen Supermarkt." + wish)
            return
        later = (" Solange Sie den Live-Standort teilen, sage ich Bescheid, wenn Sie an einem Supermarkt vorbeikommen."
                 if live and listed else "")
        self.send(f"Der nächste Supermarkt ist {shop['name']}, {spoken_distance(shop['meter'])} entfernt, etwa "
                  f"{walk_minutes(shop['meter'])} Minuten zu Fuß.{wish}{later}", ask=False)
        self._venue(shop)

    def _nudge(self, lat: float, lon: float) -> None:
        from .einkauf import join
        from .naehe import distance, spoken_distance, walk_minutes

        listed = self._shopping()
        if not listed:
            return
        now = time.monotonic()
        with self._place_lock:
            last_at, last_pos = self._last_check
            if last_pos is not None and now - last_at < CHECK_SECONDS and distance(*last_pos, lat, lon) < CHECK_METERS:
                return
            self._last_check = (now, (lat, lon))
            if now - self._last_nudge < NUDGE_GAP:
                return
        shops = [s for s in self._places().supermarkets(lat, lon) if s["meter"] <= NUDGE_METERS]
        with self._place_lock:
            fresh = [s for s in shops if now - self._nudged.get(s["id"], float("-inf")) > SAME_SHOP_HOURS * 3600]
            if not fresh or now - self._last_nudge < NUDGE_GAP:
                return
            shop = fresh[0]
            self._nudged[shop["id"]] = now
            self._last_nudge = now
        far = spoken_distance(shop["meter"])
        text = random.choice([
            f"Ach, und wo Sie gerade eh unterwegs sind, Sir: {shop['name']} ist nur {far} entfernt. "
            f"Auf Ihrer Einkaufsliste steht {join(listed)}.",
            f"Kleiner Hinweis, Sir: Sie kommen gerade an {shop['name']} vorbei, etwa {walk_minutes(shop['meter'])} "
            f"Minuten zu Fuß. Auf der Liste: {join(listed)}.",
        ])
        self.send(text, voice=self.voice_notes, ask=False)
        self._venue(shop)

    def _venue(self, shop: dict) -> None:
        """Der Supermarkt als Ort in Telegram: Tippen öffnet die Karte mit Route."""
        try:
            self._call("sendVenue", {"chat_id": self.chat_id, "latitude": shop["lat"], "longitude": shop["lon"],
                                     "title": shop["name"], "address": shop.get("adresse") or "Supermarkt"}, timeout=15)
        except TelegramError as exc:
            log.info("Telegram, Ort: %s", exc)


def _video_file(message: dict) -> dict | None:
    """Ein Video, eine runde Videonachricht oder ein Video als Datei."""
    for key in ("video", "video_note", "animation"):
        item = message.get(key)
        if isinstance(item, dict) and item.get("file_id"):
            name = str(item.get("file_name") or "")
            return {**item, "suffix": ("." + name.rsplit(".", 1)[-1]) if "." in name else ".mp4"}
    document = message.get("document")
    if isinstance(document, dict) and str(document.get("mime_type") or "").startswith("video/") and document.get("file_id"):
        name = str(document.get("file_name") or "")
        return {**document, "suffix": ("." + name.rsplit(".", 1)[-1]) if "." in name else ".mp4"}
    return None


def _photo_file(message: dict) -> dict | None:
    """Das größte Foto einer Nachricht (Telegram schickt mehrere Größen) oder ein Bild als Datei."""
    sizes = [p for p in message.get("photo") or [] if isinstance(p, dict) and p.get("file_id")]
    if sizes:
        fitting = [p for p in sizes if int(p.get("file_size") or 0) <= MAX_PHOTO_BYTES] or sizes[:1]
        best = max(fitting, key=lambda p: int(p.get("width") or 0) * int(p.get("height") or 0) or int(p.get("file_size") or 0))
        return {**best, "suffix": ".jpg"}
    document = message.get("document")
    if isinstance(document, dict) and str(document.get("mime_type") or "").startswith("image/") and document.get("file_id"):
        name = str(document.get("file_name") or "")
        suffix = ("." + name.rsplit(".", 1)[-1]) if "." in name else ".jpg"
        return {**document, "suffix": suffix}
    return None
