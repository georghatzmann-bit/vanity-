import json
import sys
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from tests.helpers import make_fake_claude
from jarvis.brain import (
    SIMPLE_PERSONA,
    Attempt,
    BrainError,
    Cancelled,
    ClaudeBrain,
    LimitError,
    LoginError,
    RefusalError,
    TooSlowError,
    classify,
)
from jarvis.config import ROOT, load_config

posix_only = unittest.skipIf(sys.platform == "win32", "Test-Launcher ist ein Shell-Skript")


def arg(call, name):
    args = call["args"]
    return args[args.index(name) + 1] if name in args else None


@posix_only
class ClaudeBrainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.state = self.home / "daten"
        self.cfg = load_config()["brain"]
        self.cfg["claude_path"] = str(make_fake_claude(self.home))
        (self.home / "CLAUDE.md").write_text("# Jarvis", encoding="utf-8")
        self.brain = ClaudeBrain(self.cfg, self.home, self.state)

    def tearDown(self):
        self.tmp.cleanup()

    def calls(self):
        lines = (self.home / "calls.jsonl").read_text(encoding="utf-8").splitlines()
        return [json.loads(line) for line in lines]

    def test_started_program_does_not_block_the_answer(self):
        started = time.monotonic()
        answer = self.brain.ask("programm")
        self.assertEqual(answer.text, "Sehr wohl, Sir. programm")
        self.assertLess(time.monotonic() - started, 5)

    def test_prompt_goes_via_stdin_and_streams(self):
        tricky = 'öffne "Notepad" & del C:\\ ; rm -rf /'
        chunks = []
        answer = self.brain.ask(tricky, on_text=chunks.append)
        self.assertEqual(answer.text, "Sehr wohl, Sir. " + tricky)
        self.assertEqual("".join(chunks), answer.text)
        self.assertGreater(len(chunks), 3)
        self.assertEqual(answer.model, "claude-sonnet-test")

        call = self.calls()[0]
        self.assertEqual(call["prompt"], tricky)
        self.assertNotIn(tricky, call["args"])
        for flag in ("--safe-mode", "--include-partial-messages", "--verbose"):
            self.assertIn(flag, call["args"])
        self.assertEqual(arg(call, "--output-format"), "stream-json")
        self.assertEqual(arg(call, "--model"), "sonnet")
        self.assertTrue(arg(call, "--system-prompt-file").endswith("CLAUDE.md"))
        self.assertIn("Bash(rm:*)", call["args"])
        self.assertIn("PowerShell", call["args"])
        self.assertEqual(call["said"], tricky)
        self.assertIn(str(ROOT), call["pythonpath"])

    def test_conversation_continues_with_same_session(self):
        self.brain.ask("hallo")
        self.brain.ask("und jetzt?")
        first, second = self.calls()
        session = arg(first, "--session-id")
        self.assertTrue(session)
        self.assertIsNone(arg(first, "--resume"))
        self.assertEqual(arg(second, "--resume"), session)

    def test_new_conversation_starts_fresh_session(self):
        self.brain.ask("hallo")
        self.brain.new_conversation()
        self.brain.ask("neu")
        first, second = self.calls()
        self.assertIsNone(arg(second, "--resume"))
        self.assertNotEqual(arg(second, "--session-id"), arg(first, "--session-id"))

    def test_lost_session_starts_over(self):
        self.brain._session = "weg"
        answer = self.brain.ask("hallo")
        self.assertEqual(answer.text, "Sehr wohl, Sir. hallo")
        self.assertEqual(arg(self.calls()[-1], "--session-id") is not None, True)

    def test_refusal_falls_back_to_next_model_and_stays_there(self):
        notes = []
        self.brain.notice = notes.append
        self.brain.ask("hallo")
        answer = self.brain.ask("nur-haiku bitte")
        self.assertEqual(answer.model, "claude-haiku-test")
        sonnet_try, haiku_try = self.calls()[1:]
        self.assertIsNotNone(arg(sonnet_try, "--resume"))
        self.assertIsNone(arg(haiku_try, "--resume"))
        self.assertIn("Sonnet hat abgelehnt, versuche Haiku", notes[0])
        self.brain.ask("nur-haiku weiter")
        last = self.calls()[-1]
        self.assertEqual(arg(last, "--model"), "haiku")
        self.assertIsNotNone(arg(last, "--resume"))

        # Ein neu gestarteter Jarvis fängt gleich mit Haiku an.
        again = ClaudeBrain(self.cfg, self.home, self.state)
        self.assertEqual(again.attempt, Attempt("haiku", "jarvis"))

    def test_remembered_model_expires(self):
        self.brain.ask("nur-haiku")
        data = json.loads((self.state / "gehirn.json").read_text(encoding="utf-8"))
        data["zeit"] -= ClaudeBrain.REMEMBER_SECONDS + 10
        (self.state / "gehirn.json").write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(ClaudeBrain(self.cfg, self.home, self.state).model, "sonnet")

    def test_simple_persona_is_the_last_resort(self):
        answer = self.brain.ask("nur-einfach")
        self.assertEqual(answer.model, "claude-sonnet-test")
        calls = self.calls()
        self.assertEqual([arg(c, "--model") for c in calls], ["sonnet", "haiku", "opus", "sonnet"])
        self.assertEqual(arg(calls[-1], "--append-system-prompt"), SIMPLE_PERSONA)
        self.assertIsNone(arg(calls[-1], "--system-prompt-file"))
        self.assertEqual(self.brain.attempt.label(), "Sonnet, einfacher Modus")

    def test_refusal_from_everything_raises_and_resets(self):
        chunks = []
        with self.assertRaises(RefusalError) as ctx:
            self.brain.ask("abgelehnt", on_text=chunks.append)
        # 3 Modelle x 2 Persönlichkeiten, dann noch "nur Unterhaltung" ohne Werkzeuge
        self.assertEqual(len(self.calls()), 7)
        self.assertEqual(arg(self.calls()[-1], "--tools"), "")
        self.assertEqual(chunks, [], "Fehlertexte von Claude Code dürfen nie vorgelesen werden")
        self.assertIn("Sir", ctx.exception.spoken)
        self.assertEqual(self.brain.attempt, Attempt("sonnet", "jarvis"))

    def test_new_refusal_wording_is_recognised(self):
        # "Claude can't help with this." enthält weder "safeguards" noch "Usage Policy".
        answer = self.brain.ask("wort-abgelehnt")
        self.assertEqual(answer.model, "claude-haiku-test")
        self.assertEqual([arg(c, "--model") for c in self.calls()], ["sonnet", "haiku"])

    def test_refusal_is_recognised_by_stop_reason_alone(self):
        answer = self.brain.ask("still-abgelehnt")
        self.assertEqual(answer.model, "claude-haiku-test")

    def test_refusal_is_recognised_by_system_event(self):
        answer = self.brain.ask("system-abgelehnt")
        self.assertEqual(answer.model, "claude-haiku-test")

    def test_unavailable_model_moves_on(self):
        notes = []
        self.brain.notice = notes.append
        answer = self.brain.ask("modell-weg")
        self.assertEqual(answer.model, "claude-haiku-test")
        self.assertIn("Sonnet ist nicht verfügbar, versuche Haiku", notes[0])

    def test_unknown_error_tries_talking_without_tools(self):
        notes = []
        self.brain.notice = notes.append
        with self.assertLogs("jarvis.brain", "WARNING") as logs:
            answer = self.brain.ask("interner-fehler")
        self.assertIn("PowerShell-Werkzeug startet nicht", "\n".join(logs.output))
        self.assertIn("Sehr wohl", answer.text)
        last = self.calls()[-1]
        self.assertEqual(arg(last, "--tools"), "")
        self.assertNotIn("--allowedTools", last["args"])
        self.assertEqual(self.brain.attempt.profile, "reden")
        self.assertIn("meldet einen Fehler", notes[0])

    def test_rescue_that_fails_too_keeps_the_normal_setup(self):
        with self.assertRaises(BrainError) as ctx:
            self.brain.ask("immer-kaputt")
        self.assertIn("Alles kaputt", str(ctx.exception))
        self.assertEqual(len(self.calls()), 2)
        self.assertEqual(self.brain.attempt, Attempt("sonnet", "jarvis"))

    def test_api_key_is_left_out_when_it_blocks_the_subscription(self):
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-alt"}):
            answer = self.brain.ask("guthaben")
        self.assertIn("Sehr wohl", answer.text)
        self.assertEqual([c["apikey"] for c in self.calls()], [True, False])

    def test_account_problem_is_not_retried(self):
        with self.assertRaises(BrainError) as ctx:
            self.brain.ask("konto")
        self.assertEqual(ctx.exception.kind, "account")
        self.assertIn("on hold", str(ctx.exception))
        self.assertEqual(len(self.calls()), 1)

    def test_old_claude_without_safe_mode_still_works(self):
        with mock.patch.dict("os.environ", {"FAKE_UNKNOWN": "safe-mode"}), self.assertLogs("jarvis.brain", "WARNING"):
            answer = self.brain.ask("hallo")
        self.assertEqual(answer.text, "Sehr wohl, Sir. hallo")
        self.assertNotIn("--safe-mode", self.calls()[-1]["args"])
        self.assertFalse(self.brain.isolated)

    def test_old_claude_without_partial_messages_still_streams_whole_blocks(self):
        chunks = []
        with mock.patch.dict("os.environ", {"FAKE_UNKNOWN": "include-partial-messages"}), self.assertLogs("jarvis.brain", "WARNING"):
            answer = self.brain.ask("werkzeug", on_text=chunks.append)
        self.assertEqual(chunks, ["Einen Moment, ich schaue nach.", "\n\n", "Heute ist Mittwoch, Sir."])
        self.assertIn("Mittwoch", answer.text)

    def test_text_before_and_after_a_tool_is_separated(self):
        chunks = []
        self.brain.ask("werkzeug", on_text=chunks.append)
        text = "".join(chunks)
        self.assertEqual(text, "Einen Moment, ich schaue nach.\n\nHeute ist Mittwoch, Sir.")

    def test_limit_and_login_errors_are_recognised(self):
        with self.assertRaises(LimitError) as ctx:
            self.brain.ask("limit")
        self.assertIn("Kontingent", ctx.exception.spoken)
        with self.assertRaises(LoginError) as ctx:
            self.brain.ask("login")
        self.assertIn("angemeldet", ctx.exception.spoken)
        # Kein Modellwechsel bei solchen Fehlern.
        self.assertEqual(self.brain.model, "sonnet")

    def test_crash_without_output_shows_stderr(self):
        with self.assertRaisesRegex(BrainError, "Traceback: irgendwas"):
            self.brain.ask("absturz")
        self.assertEqual(self.brain.attempt, Attempt("sonnet", "jarvis"))

    def test_timeout(self):
        self.cfg["timeout_seconds"] = 1
        brain = ClaudeBrain(self.cfg, self.home)
        started = time.monotonic()
        with self.assertRaises(TooSlowError):
            brain.ask("langsam")
        self.assertLess(time.monotonic() - started, 4)

    def test_cancel_stops_a_running_answer(self):
        errors = []

        def run():
            try:
                self.brain.ask("langsam")
            except BrainError as exc:
                errors.append(exc)

        thread = threading.Thread(target=run)
        thread.start()
        time.sleep(0.5)
        self.brain.cancel()
        thread.join(timeout=4)
        self.assertFalse(thread.is_alive())
        self.assertIsInstance(errors[0], Cancelled)

    def test_diagnose_reports_each_model_and_mode(self):
        rows = self.brain.diagnose("nur-haiku")
        self.assertEqual(len(rows), 6)
        self.assertEqual(rows[0], ("sonnet", "mit deinen Einstellungen", "ABGELEHNT"))
        self.assertEqual(rows[3], ("haiku", "ohne Erweiterungen", "OK (claude-haiku-test)"))
        calls = self.calls()
        self.assertNotIn("--safe-mode", calls[0]["args"])
        self.assertIn("--safe-mode", calls[1]["args"])
        self.assertIsNone(arg(calls[0], "--session-id"))

    def test_missing_claude_is_explained(self):
        cfg = dict(self.cfg, claude_path="")
        with mock.patch("shutil.which", return_value=None), self.assertRaises(BrainError) as ctx:
            ClaudeBrain(cfg, self.home)
        self.assertEqual(ctx.exception.kind, "missing")


class ClassifyTest(unittest.TestCase):
    def test_messages(self):
        self.assertIs(classify("Sonnet 5.5's safeguards flagged this session. Details: `[cyber]`"), RefusalError)
        self.assertIs(classify("5-hour limit reached ∙ resets 3pm"), LimitError)
        self.assertIs(classify("OAuth token has expired. Please run /login"), LoginError)
        self.assertEqual(classify("API Error: Connection error.").kind, "network")
        self.assertEqual(classify("API Error: 529 Overloaded").kind, "overloaded")
        self.assertIs(classify("req_0114019 irgendwas"), BrainError)
        self.assertIs(classify("API Error: Claude can’t help with this. Start a new session to continue."), RefusalError)
        self.assertIs(classify("Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup)."), RefusalError)
        self.assertEqual(classify("There's an issue with the selected model (x). It may not exist").kind, "model")
        self.assertEqual(classify("Credit balance is too low").kind, "billing")


if __name__ == "__main__":
    unittest.main()
