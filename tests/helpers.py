"""Gemeinsame Hilfen für die Tests: ein falsches `claude` und kleine Attrappen."""

import sys
import textwrap
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from jarvis.audio import FRAME_SAMPLES  # noqa: E402


def frame(level: int) -> np.ndarray:
    return np.full(FRAME_SAMPLES, level, dtype=np.int16)


# Tut so, als wäre es Claude Code mit --output-format stream-json. Mit
# --input-format stream-json läuft es weiter und beantwortet eine JSON-Zeile nach der anderen.
FAKE_CLAUDE = textwrap.dedent(
    """
    import json, os, re, sys, time, uuid
    args = sys.argv[1:]

    def arg(name):
        return args[args.index(name) + 1] if name in args else ""

    model = arg("--model")
    effort = arg("--effort")
    live = arg("--input-format") == "stream-json"
    for flag in os.environ.get("FAKE_UNKNOWN", "").split(","):
        if flag and "--" + flag in args:
            print("error: unknown option '--" + flag + "'", file=sys.stderr)
            sys.exit(1)
    if "--resume" in args and arg("--resume") == "weg":
        print("No conversation found with session ID: weg", file=sys.stderr)
        sys.exit(1)
    session = arg("--session-id") or arg("--resume") or str(uuid.uuid4())
    partial = "--include-partial-messages" in args
    no_tools = "--tools" in args and arg("--tools") == ""


    class Done(Exception):
        def __init__(self, code):
            self.code = code


    def out(obj):
        print(json.dumps(obj), flush=True)


    def said():
        path = os.environ.get("JARVIS_SAID_FILE", "")
        if path and os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                return f.read()
        return os.environ.get("JARVIS_USER_SAID")


    def say(text):
        if partial:
            out({"type": "stream_event", "event": {"type": "content_block_start", "index": 0,
                 "content_block": {"type": "text", "text": ""}}})
            for i in range(0, len(text), 7):
                out({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
                     "delta": {"type": "text_delta", "text": text[i:i + 7]}}})
        out({"type": "assistant", "message": {"model": "claude-" + model + "-test",
             "content": [{"type": "text", "text": text}]}})


    def result(text, error=False):
        usage = {} if error else {"claude-" + model + "-test": {}}
        out({"type": "result", "subtype": "success", "is_error": error, "result": text,
             "session_id": session, "modelUsage": usage})


    def tool(tool_id, name, data, output="ok", error=False, pause=0.0):
        out({"type": "assistant", "message": {"model": "claude-" + model + "-test",
             "content": [{"type": "tool_use", "id": tool_id, "name": name, "input": data}]}})
        time.sleep(pause)
        out({"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tool_id, "content": output, "is_error": error}]}})


    def api_error(text, kind="", stop="stop_sequence", subtype="success", errors=None, show=True):
        event = {"type": "assistant", "message": {"model": "<synthetic>", "stop_reason": stop,
                 "content": [{"type": "text", "text": text}]}}
        if kind:
            event["error"] = kind
        if show:
            out(event)
        final = {"type": "result", "subtype": subtype, "is_error": True, "session_id": session, "modelUsage": {}}
        if subtype == "success":
            final["result"] = text
        if errors:
            final["errors"] = errors
        out(final)
        raise Done(1)


    def turn(raw):
        # Jarvis schreibt Datum und Uhrzeit in Klammern vor die Nachricht.
        stamp = re.match(r"\\(([^()]*\\d{1,2}:\\d{2} Uhr)\\)\\n", raw)
        prompt = raw[stamp.end():] if stamp else raw
        with open("calls.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"args": args, "prompt": prompt, "raw": raw, "stamp": stamp.group(1) if stamp else "",
                                "said": said(), "pid": os.getpid(), "live": live, "cwd": os.getcwd(),
                                "pythonpath": os.environ.get("PYTHONPATH", ""), "model": model, "effort": effort,
                                "apikey": bool(os.environ.get("ANTHROPIC_API_KEY"))}) + "\\n")
        out({"type": "system", "subtype": "init", "model": "claude-" + model + "-test", "session_id": session})
        refused = prompt == "abgelehnt" or (prompt.startswith("nur-haiku") and model != "haiku") \\
            or model in os.environ.get("FAKE_REFUSE", "").split(",") \\
            or (prompt.startswith("nur-einfach") and "--append-system-prompt" not in args)
        if refused:
            msg = ("API Error: Claude Code is unable to respond to this request, which appears to violate our "
                   "Usage Policy. Sonnet 5.5's safeguards flagged this session. Claude Code can't respond to "
                   "your last message. Details: `[cyber]`")
            out({"type": "assistant", "message": {"model": "<synthetic>", "content": [{"type": "text", "text": msg}]}})
            result(msg, error=True)
            raise Done(1)
        if prompt.startswith("wort-abgelehnt") and model != "haiku":
            # Neuere Wortwahl ohne "safeguards" oder "Usage Policy" im Satz.
            api_error("API Error: Claude can't help with this. Start a new session to continue.  "
                      "Learn more: https://www.anthropic.com/legal/aup")
        if prompt.startswith("still-abgelehnt") and model != "haiku":
            # Nur am stop_reason erkennbar.
            api_error("Das geht leider nicht.", stop="refusal")
        if prompt.startswith("system-abgelehnt") and model != "haiku":
            out({"type": "system", "subtype": "model_refusal_no_fallback", "original_model": model,
                 "content": "Diese Anfrage wurde blockiert.", "session_id": session})
            api_error("", show=False)
        if prompt.startswith("modell-weg") and model != "haiku":
            api_error("There's an issue with the selected model (" + model + "). It may not exist or you "
                      "may not have access to it.", kind="model_not_found")
        if model in os.environ.get("FAKE_NO_MODEL", "").split(","):
            api_error("There's an issue with the selected model (" + model + "). It may not exist or you "
                      "may not have access to it.", kind="model_not_found")
        if model in os.environ.get("FAKE_LIMIT_MODEL", "").split(","):
            result("Claude AI usage limit reached|" + str(int(time.time()) + 7200), error=True)
            raise Done(1)
        if prompt.startswith("interner-fehler") and not no_tools:
            api_error("", subtype="error_during_execution", errors=["PowerShell-Werkzeug startet nicht"], show=False)
        if prompt.startswith("guthaben") and os.environ.get("ANTHROPIC_API_KEY"):
            api_error("Credit balance is too low", kind="billing_error")
        if prompt.startswith("konto"):
            api_error("Your account is on hold. Visit claude.ai for details.", kind="account_on_hold")
        if prompt.startswith("immer-kaputt"):
            api_error("", subtype="error_during_execution", errors=["Alles kaputt"], show=False)
        if prompt == "limit":
            result("Claude AI usage limit reached|1759248000", error=True)
            raise Done(1)
        if prompt == "login":
            result("Invalid API key · Please run /login", error=True)
            raise Done(1)
        if prompt == "absturz":
            print("Traceback: irgendwas", file=sys.stderr, flush=True)
            raise Done(2)
        if prompt == "langsam":
            time.sleep(5)
        if prompt == "programm":
            # Wie "start notepad": ein Programm läuft weiter und erbt stdout und stderr.
            import subprocess
            subprocess.Popen([sys.executable, "-c", "import time; time.sleep(8)"], close_fds=False)
        if prompt == "werkzeug":
            say("Einen Moment, ich schaue nach.")
            tool("toolu_1", "Bash", {"command": "date"}, output="Mi 1. Okt")
            say("Heute ist Mittwoch, Sir.")
            result("Einen Moment, ich schaue nach.\\n\\nHeute ist Mittwoch, Sir.")
            raise Done(0)
        if prompt.startswith("Bau mir"):
            # Die Werkstatt: Plan, Datei, Test, Zusammenfassung
            tool("toolu_t", "TodoWrite", {"todos": [
                {"content": "Ordner anlegen", "status": "completed"},
                {"content": "Bot schreiben", "status": "in_progress"},
                {"content": "Testen", "status": "pending"}]})
            tool("toolu_w", "Write", {"file_path": "bot.py", "content": "print('Hallo')"})
            if "langsam" in prompt:
                time.sleep(8)
            tool("toolu_b", "Bash", {"command": "python bot.py"}, output="Hallo")
            text = "Der Bot ist fertig, Sir. Er liegt im Werkstatt-Ordner. Starten Sie ihn mit python bot.py."
            if "Token" in prompt:
                text = "Der Bot ist fast fertig, Sir. Wie lautet Ihr Bot-Token?"
            say(text)
            result(text)
            raise Done(0)
        if prompt == "lange-arbeit":
            # Ein Werkzeug, das eine Weile still arbeitet (z. B. eine Installation).
            tool("toolu_2", "Bash", {"command": "winget install --id Spotify.Spotify -e"}, pause=2.5)
            say("Spotify ist installiert, Sir.")
            result("Spotify ist installiert, Sir.")
            raise Done(0)
        text = "Sehr wohl, Sir. " + prompt
        say(text)
        result(text)


    if live:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            data = json.loads(line)
            if data.get("type") == "control_request":
                # Modell und Nachdenken im laufenden Prozess umstellen (wie Claude Code 2.1)
                request = data["request"]
                with open("controls.jsonl", "a", encoding="utf-8") as f:
                    f.write(json.dumps({"pid": os.getpid(), "request": request}) + "\\n")
                if os.environ.get("FAKE_NO_CONTROL") or request.get("subtype") != "apply_flag_settings":
                    out({"type": "control_response", "response": {"subtype": "error", "request_id": data["request_id"],
                         "error": "Unsupported control request subtype: " + str(request.get("subtype"))}})
                    continue
                settings = request.get("settings") or {}
                if "model" in settings:
                    model = settings["model"] or ""
                if "effortLevel" in settings:
                    effort = settings["effortLevel"] or ""
                out({"type": "autocompact_state", "value": {"enabled": True}})
                out({"type": "control_response", "response": {"subtype": "success", "request_id": data["request_id"]}})
                continue
            content = data["message"]["content"]
            raw = content if isinstance(content, str) else "".join(b.get("text", "") for b in content)
            try:
                turn(raw)
            except Done as done:
                if done.code == 2:
                    sys.exit(2)  # Absturz: der Prozess ist weg
                # Andere Fehler: wie das echte Claude Code weiterlaufen (das Ergebnis kam schon).
    else:
        try:
            turn(sys.stdin.read())
        except Done as done:
            sys.exit(done.code)
    """
)


def make_fake_claude(folder: Path) -> Path:
    script = folder / "fake_claude.py"
    script.write_text(FAKE_CLAUDE, encoding="utf-8")
    launcher = folder / "claude"
    launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n')
    launcher.chmod(0o755)
    return launcher


class RecordingUi:
    """Merkt sich alles, was an die Anzeige ging."""

    def __init__(self):
        self.events = []

    def state(self, value):
        self.events.append(("state", value))

    def message(self, role, text, id=None, model="", final=True):
        self.events.append(("message", role, text, id, model, final))

    def level(self, value):
        pass

    def toast(self, text, kind="info"):
        self.events.append(("toast", text, kind))

    def suggestion(self, offer):
        self.events.append(("suggestion", offer))

    def config(self, **values):
        self.events.append(("config", values))

    def stats(self, cpu, ram, gpu=None):
        pass

    def progress(self, step):
        self.events.append(("progress", dict(step)))

    def workshop(self, event):
        self.events.append(("workshop", dict(event)))

    def of(self, kind):
        return [e for e in self.events if e[0] == kind]

    def states(self):
        return [e[1] for e in self.of("state")]
