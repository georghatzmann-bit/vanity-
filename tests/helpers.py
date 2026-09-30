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


# Tut so, als wäre es Claude Code mit --output-format stream-json.
FAKE_CLAUDE = textwrap.dedent(
    """
    import json, os, sys, time, uuid
    prompt = sys.stdin.read()
    args = sys.argv[1:]

    def arg(name):
        return args[args.index(name) + 1] if name in args else ""

    model = arg("--model")
    with open("calls.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({"args": args, "prompt": prompt, "said": os.environ.get("JARVIS_USER_SAID"),
                            "pythonpath": os.environ.get("PYTHONPATH", "")}) + "\\n")
    for flag in os.environ.get("FAKE_UNKNOWN", "").split(","):
        if flag and "--" + flag in args:
            print("error: unknown option '--" + flag + "'", file=sys.stderr)
            sys.exit(1)
    if "--resume" in args and arg("--resume") == "weg":
        print("No conversation found with session ID: weg", file=sys.stderr)
        sys.exit(1)
    session = arg("--session-id") or arg("--resume") or str(uuid.uuid4())
    partial = "--include-partial-messages" in args

    def out(obj):
        print(json.dumps(obj), flush=True)

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

    out({"type": "system", "subtype": "init", "model": "claude-" + model + "-test", "session_id": session})
    refused = prompt == "abgelehnt" or (prompt.startswith("nur-haiku") and model != "haiku") \\
        or (prompt.startswith("nur-einfach") and "--append-system-prompt" not in args)
    if refused:
        msg = ("API Error: Claude Code is unable to respond to this request, which appears to violate our "
               "Usage Policy. Sonnet 5.5's safeguards flagged this session. Claude Code can't respond to "
               "your last message. Details: `[cyber]`")
        out({"type": "assistant", "message": {"model": "<synthetic>", "content": [{"type": "text", "text": msg}]}})
        result(msg, error=True)
        sys.exit(1)
    if prompt == "limit":
        result("Claude AI usage limit reached|1759248000", error=True)
        sys.exit(1)
    if prompt == "login":
        result("Invalid API key · Please run /login", error=True)
        sys.exit(1)
    if prompt == "absturz":
        print("Traceback: irgendwas", file=sys.stderr)
        sys.exit(2)
    if prompt == "langsam":
        time.sleep(5)
    if prompt == "werkzeug":
        say("Einen Moment, ich schaue nach.")
        out({"type": "assistant", "message": {"model": "claude-" + model + "-test",
             "content": [{"type": "tool_use", "name": "Bash", "input": {"command": "date"}}]}})
        say("Heute ist Mittwoch, Sir.")
        result("Einen Moment, ich schaue nach.\\n\\nHeute ist Mittwoch, Sir.")
        sys.exit(0)
    text = "Sehr wohl, Sir. " + prompt
    say(text)
    result(text)
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

    def config(self, **values):
        self.events.append(("config", values))

    def stats(self, cpu, ram):
        pass

    def of(self, kind):
        return [e for e in self.events if e[0] == kind]

    def states(self):
        return [e[1] for e in self.of("state")]
