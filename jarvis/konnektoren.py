"""Georgs Konnektoren: Gmail, Google Kalender, Shopify, Spotify, Canva und was er sonst auf claude.ai
verbunden hat. Claude Code lädt sie selbst (als "claude.ai Gmail" usw.), sobald er mit seinem
Claude-Konto angemeldet ist. Jarvis braucht dafür keine eigenen Anbindungen und keine Passwörter.

Damit Claude sie im Hintergrund benutzen darf, beantwortet Jarvis die Rückfragen von Claude Code
("Darf ich mcp__claude_ai_Gmail__search_threads benutzen?", Steuerleitung can_use_tool) selbst. Die kommen
nur mit --permission-prompt-tool stdio bei Jarvis an (brain.live_flags), sonst lehnt Claude Code jeden
Konnektor still ab ("you haven't granted it yet"). Jarvis antwortet so:
Konnektoren ja, außer wenn das Werkzeug löscht, kauft, bezahlt, veröffentlicht oder Ähnliches.
Das macht Georg selbst in der App. Senden, Antworten, Weiterleiten und Shop-Änderungen nur direkt nach
Georgs "Ja" (needs_yes). Alles andere, das nicht freigegeben ist, bleibt gesperrt.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import threading
import time

log = logging.getLogger(__name__)

# Werkzeuge mit diesen Wörtern im Namen laufen nie über Jarvis: zu leicht falsch verstanden und
# nicht rückgängig zu machen (gesprochen wird schnell mal etwas anderes erkannt).
BLOCKED_WORDS = {
    "delete", "trash", "destroy", "drop", "purge", "wipe", "erase",
    "buy", "purchase", "pay", "checkout", "refund", "transfer",
    "publish", "unpublish", "cancel", "merge", "mutation",
}

# Werkzeuge, die etwas nach außen schicken (Mail senden, antworten, weiterleiten, einladen) oder im Shop
# etwas ändern: nur direkt nach Georgs "Ja". Claude fragt vorher ("Soll ich sie so abschicken?"). Sonst
# könnte eine präparierte Mail oder Webseite Claude dazu bringen, etwas zu verschicken oder zu ändern.
CONFIRM_WORDS = {"send", "reply", "forward", "share", "invite", "post", "comment", "respond"}
SHOP_SERVERS = re.compile(r"shopify|woocommerce|stripe|paypal|ebay|etsy|amazon|gemini|coinbase", re.I)
SHOP_WRITE_WORDS = {"create", "update", "set", "add", "bulk", "upload", "import", "remove", "edit", "modify", "order"}
CONFIRM_MESSAGE = (
    "Das schickt oder ändert etwas nach außen. Das geht nur direkt nach Georgs Ja: Sag ihm in einem Satz, "
    "was genau du tun willst (an wen, was), frag ihn, und warte auf seine Antwort."
)

BLOCKED_MESSAGE = (
    "Jarvis lässt Löschen, Kaufen, Bezahlen, Veröffentlichen und Ähnliches über Konnektoren nicht zu. "
    "Sag Georg kurz, dass er das selbst in der App oder auf der Webseite erledigt."
)
NOT_ALLOWED_MESSAGE = "Dieses Werkzeug ist für Jarvis nicht freigegeben."

# Was Claude Code an Servern meldet (Name -> Zustand), zuletzt gesehen beim Start einer Frage
_seen: dict[str, str] = {}
_seen_at = 0.0
_logged = ""
_lock = threading.Lock()


def split(tool: str) -> tuple[str, str]:
    """"mcp__claude_ai_Gmail__search_threads" -> ("claude_ai_Gmail", "search_threads")."""
    if not str(tool).startswith("mcp__"):
        return "", ""
    rest = str(tool)[len("mcp__"):]
    server, _, name = rest.partition("__")
    return server, name


def display_name(server: str) -> str:
    """Name zum Anzeigen und Sagen: "claude_ai_Google_Calendar" oder "claude.ai Google Calendar" ->
    "Google Calendar"."""
    name = re.sub(r"^claude[._ ]ai[_ ]", "", str(server or ""), flags=re.I)
    return re.sub(r"[_\s]+", " ", name).strip() or str(server or "")


def kind_for(server: str) -> str:
    """Welche Bewegung die Kugel dazu zeigt (orb.js): Post kreist, Termine ticken, Musik springt."""
    name = display_name(server).lower()
    if re.search(r"mail|outlook|slack|discord|telegram|whatsapp", name):
        return "message"
    if re.search(r"calendar|kalender", name):
        return "calendar"
    if re.search(r"spotify|music|musik|sonos", name):
        return "music"
    if re.search(r"canva|figma|gamma|moda|higgsfield|vercel|supabase|github", name):
        return "build"
    return "web"


def needs_yes(tool: str) -> bool:
    """Schickt dieses Werkzeug etwas nach außen oder ändert es etwas im Shop?"""
    server, name = split(tool)
    words = set(re.split(r"[^a-z]+", name.lower()))
    return bool(words & CONFIRM_WORDS) or bool(SHOP_SERVERS.search(server) and words & SHOP_WRITE_WORDS)


def may_use(tool: str, connectors: bool = True, said: str | None = None) -> tuple[bool, str]:
    """Darf Claude dieses Werkzeug benutzen? (ja/nein, Begründung für Claude bei nein)
    said: was Georg zuletzt gesagt hat. Senden und Shop-Änderungen nur, wenn das ein klares "Ja" war."""
    server, name = split(tool)
    if not server or not connectors:
        return False, NOT_ALLOWED_MESSAGE
    words = set(re.split(r"[^a-z]+", name.lower()))
    if words & BLOCKED_WORDS:
        return False, BLOCKED_MESSAGE
    if needs_yes(tool):
        from .tool import confirmed

        if not confirmed(said or ""):
            return False, CONFIRM_MESSAGE
    return True, ""


def permission_reply(line: str, connectors: bool = True, said: str | None = None) -> dict | None:
    """Die Antwort auf eine Rückfrage von Claude Code (control_request can_use_tool), oder None,
    wenn die Zeile keine solche Rückfrage ist."""
    if '"can_use_tool"' not in line:
        return None
    try:
        event = json.loads(line)
    except ValueError:
        return None
    if not isinstance(event, dict) or event.get("type") != "control_request":
        return None
    request = event.get("request") or {}
    if not isinstance(request, dict) or request.get("subtype") != "can_use_tool":
        return None
    tool = str(request.get("tool_name") or "")
    allowed, why = may_use(tool, connectors, said)
    if allowed:
        data = request.get("input")
        answer = {"behavior": "allow", "updatedInput": data if isinstance(data, dict) else {}}
    else:
        answer = {"behavior": "deny", "message": why}
    log.info("Werkzeug %s: %s", tool, "erlaubt" if allowed else "abgelehnt")
    return {"type": "control_response",
            "response": {"subtype": "success", "request_id": event.get("request_id"), "response": answer}}


def answer(proc, line: str, connectors: bool = True, said: str | None = None) -> bool:
    """Beantwortet eine Rückfrage über stdin des Claude-Prozesses. True, wenn die Zeile eine war
    (dann gehört sie nicht in die Antwort)."""
    reply = permission_reply(line, connectors, said)
    if reply is None:
        return False
    try:
        proc.stdin.write(json.dumps(reply, ensure_ascii=False) + "\n")
        proc.stdin.flush()
    except (OSError, ValueError, AttributeError) as exc:
        log.debug("Rückfrage nicht beantwortet: %s", exc)
    return True


def note(servers, mode: str = "") -> None:
    """Merkt sich, welche Server Claude Code beim Start einer Frage meldet (system/init, mcp_servers).
    mode: der Rechte-Modus von Claude Code (permissionMode). Beides kommt einmal ins Protokoll, wenn es sich
    ändert: Geht ein Konnektor nicht, sieht man dort, ob er fehlt, eine Anmeldung braucht oder abgelehnt wird."""
    global _seen_at, _logged
    if not isinstance(servers, list):
        return
    found = {}
    for item in servers:
        if isinstance(item, dict) and item.get("name"):
            found[str(item["name"])] = str(item.get("status") or "")
    summary = ", ".join(f"{display_name(name)} ({status or '?'})" for name, status in sorted(found.items()))
    line = f"{summary or 'keine'}; Rechte-Modus von Claude Code: {mode or '?'}"
    with _lock:
        _seen.clear()
        _seen.update(found)
        _seen_at = time.time()
        changed, _logged = line != _logged, line
    if changed:
        log.info("Konnektoren: %s", line)


def seen() -> list[dict]:
    """Die zuletzt gemeldeten Konnektoren für die Anzeige: [{"name": "Gmail", "ok": True}, ...]."""
    with _lock:
        items = dict(_seen)
    return [{"name": display_name(name), "ok": status.lower() in ("connected", "ok", "")}
            for name, status in sorted(items.items(), key=lambda kv: display_name(kv[0]).lower())]


_LIST_LINE = re.compile(r"^(?P<name>[^:]+):\s.*?\s-\s(?P<status>.+)$")


def parse_list(text: str) -> list[dict]:
    """Wertet `claude mcp list` aus: "claude.ai Gmail: https://... - ✓ Connected"."""
    found = []
    for line in str(text or "").splitlines():
        hit = _LIST_LINE.match(line.strip())
        if not hit:
            continue
        status = hit.group("status")
        lower = status.lower()
        ok = "✓" in status or ("connected" in lower and "not" not in lower and "fail" not in lower)
        found.append({"name": display_name(hit.group("name")), "ok": ok})
    return found


def listed(claude: str, env: dict | None = None, timeout: float = 40.0) -> list[dict] | None:
    """Fragt Claude Code nach allen Konnektoren (`claude mcp list`, prüft jeden kurz). None = ging nicht."""
    from .brain import NO_WINDOW

    try:
        done = subprocess.run([claude, "mcp", "list"], capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout, env=env, creationflags=NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.info("Konnektoren-Liste: %s", exc)
        return None
    return parse_list(done.stdout)
