"""Probe im echten Jarvis-Fenster (WebView2, wie bei Georg): Lädt die Oberfläche ohne Skriptfehler?
Kommt die Zentrale mit Daten aus Python? Läuft die Energie-Kugel im Gespräch mit WebGL, leuchtet sie
und bewegt sie sich?

Jarvis muss mit WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=PORT laufen. Die Probe
spricht das DevTools-Protokoll über einen kleinen WebSocket (nur Standardbibliothek), schaut beide
Ansichten an, speichert Bilder nach PROBE_OUT und schreibt das Ergebnis als GitHub-Annotations
(::notice:: und ::error::), damit man es ohne die Bilder lesen kann.

    python probe_oberflaeche.py [PORT]
"""

from __future__ import annotations

import base64
import io
import json
import os
import select
import socket
import struct
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

PORT = int(os.environ.get("PROBE_PORT", "9229"))  # oder als erstes Argument
OUT = Path(os.environ.get("PROBE_OUT", "probe-bilder"))
failed: list[str] = []


def note(title: str, text: str, kind: str = "notice") -> None:
    text = " ".join(str(text).split())[:900]
    print(f"::{kind} title={title}::{text}", flush=True)


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'OK  ' if ok else 'FEHL'} {name} {detail}", flush=True)
    if not ok:
        failed.append(name)


# ---------------------------------------------------------------- WebSocket (RFC 6455, nur Client)


class WebSocket:
    def __init__(self, url: str, timeout: float = 10) -> None:
        parts = urllib.parse.urlparse(url)
        self.sock = socket.create_connection((parts.hostname, parts.port or 80), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        # Ohne Origin-Kopfzeile: dann nimmt Chromium die Verbindung ohne --remote-allow-origins an
        self.sock.sendall(
            (f"GET {parts.path} HTTP/1.1\r\nHost: {parts.hostname}:{parts.port}\r\nUpgrade: websocket\r\n"
             f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode()
        )
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("DevTools hat die Verbindung geschlossen")
            head += chunk
        status, _, rest = head.partition(b"\r\n\r\n")
        if b" 101 " not in status.split(b"\r\n", 1)[0]:
            raise ConnectionError(status.split(b"\r\n", 1)[0].decode("latin-1"))
        self.buf = bytearray(rest)

    def _send(self, payload: bytes, opcode: int) -> None:
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + mask + masked)

    def send(self, text: str) -> None:
        self._send(text.encode("utf-8"), 0x1)

    def _need(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(1 << 16)
            if not chunk:
                raise ConnectionError("DevTools hat die Verbindung geschlossen")
            self.buf += chunk
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out

    def ready(self, seconds: float) -> bool:
        if self.buf:
            return True
        readable, _, _ = select.select([self.sock], [], [], max(0.0, seconds))
        return bool(readable)

    def recv(self) -> str:
        message = bytearray()
        while True:
            b1, b2 = self._need(2)
            opcode, n = b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._need(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._need(8))[0]
            mask = self._need(4) if b2 & 0x80 else b""
            payload = self._need(n)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x9:  # Ping
                self._send(payload, 0xA)
                continue
            if opcode == 0xA:  # Pong
                continue
            if opcode == 0x8:
                raise ConnectionError("DevTools hat die Verbindung geschlossen")
            message += payload
            if b1 & 0x80:
                return message.decode("utf-8", errors="replace")

    def close(self) -> None:
        try:
            self._send(b"", 0x8)
        except OSError:
            pass
        self.sock.close()


# ---------------------------------------------------------------- DevTools-Protokoll


class DevTools:
    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.next_id = 0
        self.events: list[dict] = []

    def call(self, method: str, params: dict | None = None, timeout: float = 30) -> dict:
        self.next_id += 1
        mine = self.next_id
        self.ws.send(json.dumps({"id": mine, "method": method, "params": params or {}}))
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0 or not self.ws.ready(left):
                raise TimeoutError(f"{method}: keine Antwort")
            message = json.loads(self.ws.recv())
            if message.get("id") == mine:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error'].get('message')}")
                return message.get("result") or {}
            if "method" in message:
                self.events.append(message)

    def pump(self, seconds: float) -> None:
        """Ereignisse sammeln (Skriptfehler, Konsole), während die Seite arbeitet."""
        end = time.monotonic() + seconds
        while True:
            left = end - time.monotonic()
            if left <= 0 or not self.ws.ready(left):
                return
            message = json.loads(self.ws.recv())
            if "method" in message:
                self.events.append(message)

    def evaluate(self, expression: str):
        result = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
        if "exceptionDetails" in result:
            raise RuntimeError(describe(result["exceptionDetails"]))
        return (result.get("result") or {}).get("value")

    def screenshot(self, name: str):
        data = base64.b64decode(self.call("Page.captureScreenshot", {"format": "png"}, timeout=40)["data"])
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / name).write_bytes(data)
        from PIL import Image

        return Image.open(io.BytesIO(data)).convert("RGB")


def describe(details: dict) -> str:
    exc = details.get("exception") or {}
    text = (exc.get("description") or details.get("text") or "Fehler").split("\n    at ")[0]  # ohne Aufrufkette
    where = details.get("url") or ""
    if where:
        text += f" ({where.rsplit('/', 1)[-1]}:{(details.get('lineNumber') or 0) + 1})"
    return text


def errors(events: list[dict]) -> list[str]:
    found = []
    for event in events:
        if event.get("method") == "Runtime.exceptionThrown":
            found.append(describe(event["params"]["exceptionDetails"]))
    return found


def console_errors(events: list[dict]) -> list[str]:
    found = []
    for event in events:
        params = event.get("params") or {}
        if event.get("method") == "Runtime.consoleAPICalled" and params.get("type") in ("error", "assert"):
            args = [str(a.get("value", a.get("description", ""))) for a in params.get("args") or []]
            found.append(" ".join(args))
    return found


def page_target(seconds: float = 90) -> dict:
    """Die Seite des Jarvis-Fensters (index.html), sobald WebView2 sie zeigt."""
    deadline = time.monotonic() + seconds
    last = ""
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=3) as response:
                targets = json.loads(response.read().decode("utf-8"))
            pages = [t for t in targets if t.get("type") == "page" and "index.html" in (t.get("url") or "")]
            if pages:
                return pages[0]
            last = ", ".join(t.get("url", "") for t in targets) or "keine Seite"
        except OSError as exc:
            last = str(exc)
        time.sleep(1)
    raise TimeoutError(f"Keine Jarvis-Seite über DevTools (Port {PORT}): {last}")


# ---------------------------------------------------------------- Bilder auswerten


def orb_numbers(image, rect: dict, dpr: float) -> tuple[float, "object"]:
    """Anteil heller Pixel in der Kugel-Fläche und der Ausschnitt (zum Vergleich zweier Bilder)."""
    import numpy as np

    box = (int(rect["x"] * dpr), int(rect["y"] * dpr), int((rect["x"] + rect["w"]) * dpr), int((rect["y"] + rect["h"]) * dpr))
    crop = np.asarray(image.crop(box), dtype=np.int16)
    if crop.size == 0:
        return 0.0, crop
    bright = (crop.max(axis=2) > 90).mean()
    return float(bright), crop


ZENTRALE = r"""
(() => {
  const q = (s) => document.querySelector(s);
  const all = (s) => document.querySelectorAll(s).length;
  const text = (s) => ((q(s) || {}).textContent || '').trim();
  let webgl = false;
  try { webgl = !!document.createElement('canvas').getContext('webgl'); } catch (e) { webgl = false; }
  return {
    ansicht: document.body.dataset.view, start: document.body.dataset.home,
    verbindung: text('#linkText'),
    karten: all('#zt .zt-card'),
    spezialisten: all('#ztAgents .zt-agent'),
    kennzahlen: all('#ztKpis > *'),
    lage: text('#liveText'),
    schlagzeile: text('#ztNewsHeadline'),
    nachrichten: (() => {
      const v = q('#ztVideo');
      return { modus: (q('.zt-news') || { dataset: {} }).dataset.mode || '', zeit: v ? v.currentTime : 0,
               laeuft: !!(v && !v.paused), fehler: v && v.error ? v.error.code : 0, quelle: v ? (v.currentSrc || '').slice(0, 80) : '' };
    })(),
    ereignisse: text('#topEvents'),
    uhr: text('#topClock'),
    webgl,
    breite: innerWidth, hoehe: innerHeight, dpr: devicePixelRatio,
  };
})()
"""

GESPRAECH = r"""
(() => {
  const r = document.getElementById('core').getBoundingClientRect();
  const whip = document.getElementById('whipBtn');
  return {
    start: document.body.dataset.home, kugel: document.body.dataset.kugel || '',
    rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    peitsche: !!(whip && whip.offsetParent),
    dpr: devicePixelRatio,
  };
})()
"""


TRAILER = r"""
(() => {
  const box = document.getElementById('trailer');
  const v = document.getElementById('trailerVideo');
  return {
    offen: !!(box && !box.hidden), titel: ((document.getElementById('trailerTitle') || {}).textContent || '').trim(),
    zeit: v ? v.currentTime : 0, bereit: v ? v.readyState : 0, breite: v ? v.videoWidth : 0,
    pausiert: v ? v.paused : true, stumm: v ? v.muted : false, fehler: v && v.error ? v.error.code : 0,
    quelle: v ? (v.currentSrc || '').slice(0, 80) : '',
  };
})()
"""

TRAILER_SENTENCE = "Zeig mir den Trailer von Cyberpunk 2077"


def trailer_check(tools: DevTools) -> None:
    """Wie per Stimme: Python fragt Steam, das Fenster spielt den Trailer (HLS über hls.js)."""
    sent = tools.evaluate(
        "window.pywebview && window.pywebview.api && window.pywebview.api.send_text ? "
        f"(window.pywebview.api.send_text({json.dumps(TRAILER_SENTENCE)}), true) : false"
    )
    if not sent:
        check("Trailer per Befehl", False, "keine Verbindung zu Python")
        return
    t: dict = {}
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        tools.pump(1)
        t = tools.evaluate(TRAILER) or {}
        if t.get("offen") and (t.get("zeit") or 0) > 2 or t.get("fehler"):
            break
    print("Trailer:", json.dumps(t, ensure_ascii=False), flush=True)
    if t.get("offen"):
        tools.screenshot("oberflaeche-trailer.png")
    check("Trailer öffnet sich im Fenster", bool(t.get("offen")), t.get("titel", ""))
    check("Trailer läuft", (t.get("zeit") or 0) > 2, f"{(t.get('zeit') or 0):.1f} s, Bild {t.get('breite')} Pixel breit")
    note("Trailer in WebView2",
         f"{t.get('titel') or 'kein Trailer'}: {(t.get('zeit') or 0):.1f} s gespielt, "
         f"{'ohne Ton (Autoplay)' if t.get('stumm') else 'mit Ton'}, Bild {t.get('breite')} breit, "
         f"Fehler {t.get('fehler') or 'keiner'}, {t.get('quelle') or '-'}",
         "notice" if (t.get("zeit") or 0) > 2 else "warning")
    tools.evaluate("document.getElementById('trailerClose') && document.getElementById('trailerClose').click(), true")


def main() -> int:
    target = page_target()
    print("Seite:", target.get("url"), flush=True)
    ws = WebSocket(target["webSocketDebuggerUrl"])
    tools = DevTools(ws)
    try:
        # Runtime.enable meldet auch die Fehler, die schon beim Laden passiert sind
        tools.call("Runtime.enable")
        tools.pump(8)  # Zentrale-Daten aus Python, Nachrichten, Uhr
        z = tools.evaluate(ZENTRALE)
        print("Zentrale:", json.dumps(z, ensure_ascii=False), flush=True)
        check("Mit Python verbunden", z.get("verbindung") in ("Online", "Verbunden"), z.get("verbindung", ""))
        check("Zentrale ist die Startansicht", z.get("start") == "zentrale", z.get("start", ""))
        check("Zentrale hat ihre Karten", (z.get("karten") or 0) >= 8, str(z.get("karten")))
        check("Spezialisten aus Python", (z.get("spezialisten") or 0) >= 5, str(z.get("spezialisten")))
        note("Zentrale in WebView2",
             f"{z.get('karten')} Karten, {z.get('spezialisten')} Spezialisten, Lagebild: {z.get('lage') or '-'}, "
             f"Schlagzeile: {z.get('schlagzeile') or '-'}, WebGL: {'ja' if z.get('webgl') else 'nein'}, "
             f"Fenster {z.get('breite')}x{z.get('hoehe')} bei {z.get('dpr')}x")
        n = z.get("nachrichten") or {}
        note("Nachrichten-Kachel in WebView2",
             f"Modus {n.get('modus') or '-'}, {'läuft' if n.get('laeuft') else 'steht'} bei {(n.get('zeit') or 0):.1f} s, "
             f"Fehler {n.get('fehler') or 'keiner'}, {n.get('quelle') or '-'}")
        tools.screenshot("oberflaeche-zentrale.png")

        tools.evaluate("document.getElementById('tabTalk').click(), true")
        tools.pump(3)
        g = tools.evaluate(GESPRAECH)
        print("Gespräch:", json.dumps(g, ensure_ascii=False), flush=True)
        dpr = float(g.get("dpr") or 1)
        first = tools.screenshot("oberflaeche-gespraech.png")
        bright, a = orb_numbers(first, g["rect"], dpr)
        tools.pump(0.7)
        second = tools.screenshot("oberflaeche-gespraech-2.png")
        _, b = orb_numbers(second, g["rect"], dpr)
        moved = float((abs(a - b).max(axis=2) > 12).mean()) if a.shape == b.shape and a.size else 0.0
        check("Gespräch ist offen", g.get("start") == "gespraech", g.get("start", ""))
        if z.get("webgl"):
            check("Energie-Kugel mit WebGL", g.get("kugel") == "plasma", g.get("kugel") or "keine")
        else:
            # Ohne Grafikchip (wie auf GitHub) gibt WebView2 oft kein WebGL: dann ist die Linien-Kugel richtig
            check("Ohne WebGL die Linien-Kugel", g.get("kugel") == "linien", g.get("kugel") or "keine")
            note("Energie-Kugel in WebView2", "Dieser Rechner hat kein WebGL (kein Grafikchip), deshalb die Linien-Kugel.",
                 "warning")
        check("Kugel leuchtet", bright > 0.04, f"{bright:.0%} hell")
        check("Kugel bewegt sich", moved > 0.01, f"{moved:.0%} anders nach 0,7 s")
        check("Peitsche da", bool(g.get("peitsche")))
        note("Energie-Kugel in WebView2",
             f"Art: {g.get('kugel') or 'keine'}, {bright:.0%} der Fläche hell, {moved:.0%} bewegt sich in 0,7 s")
        tools.evaluate("document.getElementById('tabZentrale').click(), true")
        tools.pump(1)
        trailer_check(tools)
    finally:
        found = errors(tools.events)
        for text in found[:8]:
            note("Skriptfehler im Fenster", text, "error")
        console = console_errors(tools.events)
        for text in console[:5]:
            note("Konsole (Fehler)", text, "warning")
        check("Keine Skriptfehler", not found, f"{len(found)} Fehler")
        ws.close()
    if failed:
        note("Fenster-Probe", "Nicht in Ordnung: " + ", ".join(failed), "error")
    else:
        note("Fenster-Probe", "Alles in Ordnung: Zentrale, Kugel, keine Skriptfehler")
    return 1 if failed else 0


if __name__ == "__main__":
    if len(sys.argv) > 1:
        PORT = int(sys.argv[1])
    try:
        sys.exit(main())
    except Exception as exc:  # die Probe selbst ging nicht (kein DevTools-Port o. ä.)
        note("Fenster-Probe", f"Probe ging nicht: {type(exc).__name__}: {exc}", "warning")
        sys.exit(2)
