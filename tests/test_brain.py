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
    """Ein Claude-Prozess pro Frage (so wie früher, und als Rückfall für alte Versionen)."""

    live = False

    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.state = self.home / "daten"
        self.cfg = load_config()["brain"]
        self.cfg["claude_path"] = str(make_fake_claude(self.home))
        self.cfg["live"] = self.live
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
        for flag in ("--disable-slash-commands", "--include-partial-messages", "--verbose"):
            self.assertIn(flag, call["args"])
        # Abgeschottet von Georgs Einstellungen, aber nicht mit --safe-mode: das schaltet seine Konnektoren ab
        self.assertNotIn("--safe-mode", call["args"])
        self.assertEqual(arg(call, "--setting-sources"), "project")
        self.assertEqual(call["no_claude_md"], "1")
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
        self.cfg["konnektoren"] = False
        self.brain = ClaudeBrain(self.cfg, self.home, self.state)
        with mock.patch.dict("os.environ", {"FAKE_UNKNOWN": "safe-mode"}), self.assertLogs("jarvis.brain", "WARNING"):
            answer = self.brain.ask("hallo")
        self.assertEqual(answer.text, "Sehr wohl, Sir. hallo")
        self.assertNotIn("--safe-mode", self.calls()[-1]["args"])
        self.assertFalse(self.brain.isolated)

    def test_without_connectors_claude_runs_in_safe_mode(self):
        self.cfg["konnektoren"] = False
        self.brain = ClaudeBrain(self.cfg, self.home, self.state)
        self.brain.ask("hallo")
        call = self.calls()[-1]
        self.assertIn("--safe-mode", call["args"])
        self.assertNotIn("--setting-sources", call["args"])
        self.assertEqual(call["no_claude_md"], "")

    def test_blueprint_claude_is_shielded_from_personal_settings(self):
        """Die Blaupause (stream_oneshot) läuft wie oneshot abgeschottet: ohne Georgs eigene Hooks, Plugins
        und Skills, ohne Werkzeuge und Konnektoren."""
        system = self.home / "blaupause.md"
        system.write_text("Zeichne.", encoding="utf-8")
        text = self.brain.stream_oneshot("hallo", system)
        self.assertIn("hallo", text)
        call = self.calls()[-1]
        self.assertIn("--safe-mode", call["args"])
        self.assertEqual(arg(call, "--tools"), "")
        self.assertEqual(arg(call, "--system-prompt-file"), str(system))
        with mock.patch.dict("os.environ", {"FAKE_UNKNOWN": "safe-mode"}):
            self.assertIn("hallo", self.brain.stream_oneshot("hallo", system))
        self.assertNotIn("--safe-mode", self.calls()[-1]["args"], "alte Claude-Versionen gehen weiter")

    def test_old_claude_without_setting_sources_still_works(self):
        with mock.patch.dict("os.environ", {"FAKE_UNKNOWN": "setting-sources"}), self.assertLogs("jarvis.brain", "WARNING"):
            answer = self.brain.ask("hallo")
        self.assertEqual(answer.text, "Sehr wohl, Sir. hallo")
        self.assertNotIn("--setting-sources", self.calls()[-1]["args"])
        self.assertIn("--disable-slash-commands", self.calls()[-1]["args"])
        self.assertTrue(self.brain.isolated, "die Persönlichkeit kommt weiter als Systemprompt")

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
        self.assertNotIn("--disable-slash-commands", calls[0]["args"])
        self.assertIn("--disable-slash-commands", calls[1]["args"])
        self.assertIsNone(arg(calls[0], "--session-id"))

    def test_missing_claude_is_explained(self):
        cfg = dict(self.cfg, claude_path="")
        with mock.patch("shutil.which", return_value=None), self.assertRaises(BrainError) as ctx:
            ClaudeBrain(cfg, self.home)
        self.assertEqual(ctx.exception.kind, "missing")


@posix_only
class LiveBrainTest(ClaudeBrainTest):
    """Dieselben Prüfungen mit dem dauerhaft laufenden Claude-Prozess, dazu dessen Besonderheiten."""

    live = True

    def tearDown(self):
        self.brain.close()
        super().tearDown()

    def test_conversation_continues_with_same_session(self):
        self.brain.ask("hallo")
        self.brain.ask("und jetzt?")
        first, second = self.calls()
        self.assertEqual(first["pid"], second["pid"], "dieselbe Unterhaltung im selben Prozess")
        self.assertTrue(first["live"])
        self.assertTrue(arg(first, "--session-id"))
        self.assertEqual(arg(first, "--input-format"), "stream-json")
        self.assertEqual(second["prompt"], "und jetzt?")

    def test_refusal_falls_back_to_next_model_and_stays_there(self):
        notes = []
        self.brain.notice = notes.append
        self.brain.ask("hallo")
        answer = self.brain.ask("nur-haiku bitte")
        self.assertEqual(answer.model, "claude-haiku-test")
        first, sonnet_try, haiku_try = self.calls()
        self.assertEqual(sonnet_try["pid"], first["pid"])
        self.assertNotEqual(haiku_try["pid"], first["pid"], "neuer Prozess für das neue Modell")
        self.assertEqual(arg(haiku_try, "--model"), "haiku")
        self.assertIsNone(arg(haiku_try, "--resume"))
        self.assertIn("Sonnet hat abgelehnt, versuche Haiku", notes[0])
        self.brain.ask("nur-haiku weiter")
        last = self.calls()[-1]
        self.assertEqual(last["pid"], haiku_try["pid"])
        again = ClaudeBrain(self.cfg, self.home, self.state)
        self.assertEqual(again.attempt, Attempt("haiku", "jarvis"))

    def test_each_question_sees_what_georg_just_said(self):
        self.brain.ask("lösch die alte Datei")
        self.brain.ask("ja")
        first, second = self.calls()
        self.assertEqual(first["pid"], second["pid"])
        self.assertEqual((first["said"], second["said"]), ("lösch die alte Datei", "ja"))

    def test_prewarm_starts_claude_before_the_first_question(self):
        self.brain.prewarm()
        for _ in range(50):
            if self.brain._live is not None:
                break
            time.sleep(0.05)
        self.assertIsNotNone(self.brain._live)
        warm_pid = self.brain._live.proc.pid
        self.brain.ask("hallo")
        self.assertEqual(self.calls()[0]["pid"], warm_pid)

    def test_cancel_keeps_the_conversation_for_the_next_question(self):
        self.brain.ask("hallo")
        session = arg(self.calls()[0], "--session-id")
        thread = threading.Thread(target=lambda: self.assertRaises(Cancelled, self.brain.ask, "langsam"))
        thread.start()
        time.sleep(0.6)
        self.brain.cancel()
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.brain.ask("weiter")
        last = self.calls()[-1]
        self.assertEqual(arg(last, "--resume"), session, "neuer Prozess, gleiche Unterhaltung")

    def test_old_claude_without_live_mode_asks_one_process_per_question(self):
        with mock.patch.dict("os.environ", {"FAKE_UNKNOWN": "input-format"}), self.assertLogs("jarvis.brain", "WARNING"):
            answer = self.brain.ask("hallo")
        self.assertEqual(answer.text, "Sehr wohl, Sir. hallo")
        self.assertFalse(self.brain.live_enabled)
        self.assertFalse(self.calls()[-1]["live"])

    def test_long_pause_starts_a_new_conversation(self):
        self.brain.ask("hallo")
        self.brain._last_turn_at -= self.brain._new_after + 1
        self.brain.ask("guten Morgen")
        first, second = self.calls()
        self.assertNotEqual(first["pid"], second["pid"])
        self.assertNotEqual(arg(second, "--session-id"), arg(first, "--session-id"))
        self.assertIsNone(arg(second, "--resume"))


@posix_only
class ConnectorTest(unittest.TestCase):
    """Georgs Konnektoren: Claude fragt über die Steuerleitung, ob es ein Werkzeug benutzen darf."""

    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.cfg = load_config()["brain"]
        self.cfg["claude_path"] = str(make_fake_claude(self.home))
        self.cfg["live"] = True
        (self.home / "CLAUDE.md").write_text("# Jarvis", encoding="utf-8")
        self.brain = ClaudeBrain(self.cfg, self.home, self.home / "daten")

    def tearDown(self):
        self.brain.close()
        self.tmp.cleanup()

    def replies(self):
        lines = (self.home / "permissions.jsonl").read_text(encoding="utf-8").splitlines()
        return [json.loads(line)["response"]["response"] for line in lines]

    def test_connector_is_allowed(self):
        steps = []
        answer = self.brain.ask("konnektor:mcp__claude_ai_Gmail__search_threads", on_step=steps.append)
        self.assertEqual(answer.text, "Erlaubt: mcp__claude_ai_Gmail__search_threads")
        self.assertEqual(self.replies()[0], {"behavior": "allow", "updatedInput": {"q": "neu"}})
        self.assertEqual(steps[0].label, "Nutzt Gmail")
        self.assertEqual(steps[0].kind, "message")

    def test_live_process_hands_the_questions_to_jarvis(self):
        # Ohne --permission-prompt-tool stdio lehnt das echte Claude Code jeden Konnektor still ab
        # (so ging bei Georg kein einziger), mit kommen die Rückfragen bei Jarvis an.
        self.assertEqual(self.brain.live_flags(), ["--input-format", "stream-json", "--permission-prompt-tool", "stdio"])

    def test_old_claude_without_permission_prompts_still_answers(self):
        with mock.patch.dict("os.environ", {"FAKE_UNKNOWN": "permission-prompt-tool"}), \
                self.assertLogs("jarvis.brain", "WARNING"):
            answer = self.brain.ask("hallo")
        self.assertEqual(answer.text, "Sehr wohl, Sir. hallo")
        self.assertEqual(self.brain.live_flags(), ["--input-format", "stream-json"])
        self.assertTrue(self.brain.live_enabled, "der dauerhafte Prozess bleibt")

    def test_deleting_buying_and_publishing_are_refused(self):
        for tool in ("mcp__claude_ai_Gmail__trash_message", "mcp__claude_ai_Vercel__buy_domain",
                     "mcp__claude_ai_Shopify__graphql_mutation"):
            answer = self.brain.ask("konnektor:" + tool)
            self.assertTrue(answer.text.startswith("Abgelehnt: Jarvis lässt Löschen"), answer.text)
        self.assertEqual({r["behavior"] for r in self.replies()}, {"deny"})

    def test_sending_needs_georgs_yes(self):
        answer = self.brain.ask("konnektor:mcp__claude_ai_Gmail__send_message")
        self.assertTrue(answer.text.startswith("Abgelehnt: Das schickt oder ändert etwas nach außen"), answer.text)
        self.assertEqual(self.replies()[-1]["behavior"], "deny")

    def test_which_tools_need_a_yes(self):
        from jarvis.konnektoren import may_use

        for tool in ("mcp__claude_ai_Gmail__send_message", "mcp__claude_ai_Gmail__reply", "mcp__claude_ai_Gmail__forward",
                     "mcp__claude_ai_Shopify__update-product", "mcp__claude_ai_Shopify__create-discount",
                     "mcp__claude_ai_Shopify__set-inventory", "mcp__claude_ai_Google_Calendar__respond_to_event",
                     "mcp__claude_ai_Windsor_ai__execute_action"):
            with self.subTest(tool=tool):
                self.assertFalse(may_use(tool, True, "Schick Max eine Mail, dass ich später komme")[0])
                self.assertFalse(may_use(tool, True, None)[0], "ohne Gesagtes: nein")
                self.assertTrue(may_use(tool, True, "Ja, mach das")[0])
                self.assertFalse(may_use(tool, True, "Ja? Wer ist das?")[0])
        for tool in ("mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__create_draft",
                     "mcp__claude_ai_Google_Calendar__create_event", "mcp__claude_ai_Shopify__list-orders",
                     "mcp__claude_ai_Canva__create-design", "mcp__claude_ai_Windsor_ai__get_data"):
            with self.subTest(tool=tool):
                self.assertTrue(may_use(tool, True, "Trag morgen um 18 Uhr Training ein")[0])
        self.assertFalse(may_use("mcp__claude_ai_Gmail__trash_message", True, "Ja")[0], "Löschen nie, auch nicht mit Ja")

    def test_other_tools_stay_locked(self):
        answer = self.brain.ask("konnektor:Agent")
        self.assertEqual(answer.text, "Abgelehnt: Dieses Werkzeug ist für Jarvis nicht freigegeben.")

    def test_connectors_can_be_switched_off(self):
        self.brain.close()
        self.cfg["konnektoren"] = False
        self.brain = ClaudeBrain(self.cfg, self.home, self.home / "daten")
        answer = self.brain.ask("konnektor:mcp__claude_ai_Gmail__search_threads")
        self.assertTrue(answer.text.startswith("Abgelehnt"))

    def test_jarvis_remembers_which_connectors_claude_has(self):
        from jarvis import konnektoren

        with mock.patch.dict("os.environ", {"FAKE_MCP": "claude.ai Gmail,claude.ai Google Calendar"}):
            self.brain.ask("hallo")
        self.assertEqual([c["name"] for c in konnektoren.seen()], ["Gmail", "Google Calendar"])
        self.assertTrue(all(c["ok"] for c in konnektoren.seen()))

    def test_connectors_and_permission_mode_go_into_the_log_once(self):
        from jarvis import konnektoren

        konnektoren._logged = ""
        servers = [{"name": "claude.ai Shopify", "status": "needs-auth"}, {"name": "claude.ai Gmail", "status": "connected"}]
        with self.assertLogs("jarvis.konnektoren", "INFO") as logs:
            konnektoren.note(servers, "auto")
            konnektoren.note(servers, "auto")
        self.assertEqual(logs.output, ["INFO:jarvis.konnektoren:Konnektoren: Gmail (connected), Shopify (needs-auth); "
                                       "Rechte-Modus von Claude Code: auto"])

    def test_mcp_list_is_understood(self):
        from jarvis.konnektoren import parse_list

        text = ("Checking MCP server health...\n\n"
                "claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ✓ Connected\n"
                "claude.ai Shopify: https://shopify.example/mcp - ! Needs authentication\n"
                "github: npx -y @modelcontextprotocol/server-github - ✗ Failed to connect\n")
        self.assertEqual(parse_list(text), [{"name": "Gmail", "ok": True}, {"name": "Shopify", "ok": False},
                                            {"name": "github", "ok": False}])


class StepsAndPatienceTest(unittest.TestCase):
    """Arbeitsschritte kommen live an, und lange Arbeit ist kein Grund zum Abbrechen."""

    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.cfg = load_config()["brain"]
        self.cfg["claude_path"] = str(make_fake_claude(self.home))
        (self.home / "CLAUDE.md").write_text("# Jarvis", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def brain(self, **cfg):
        brain = ClaudeBrain(dict(self.cfg, **cfg), self.home, self.home / "daten")
        self.addCleanup(brain.close)
        return brain

    def test_steps_are_reported_with_start_and_end(self):
        for live in (False, True):
            with self.subTest(live=live):
                seen = []
                self.brain(live=live).ask("werkzeug", on_step=lambda step: seen.append((step.label, step.state)))
                self.assertEqual(seen, [("Führt einen Befehl aus", "running"), ("Führt einen Befehl aus", "done")])

    def test_quiet_tool_is_not_cut_off(self):
        for live in (False, True):
            with self.subTest(live=live):
                steps = []
                brain = self.brain(live=live, timeout_seconds=1, tool_timeout_seconds=20)
                answer = brain.ask("lange-arbeit", on_step=steps.append)
                self.assertIn("installiert", answer.text)
                self.assertEqual(steps[0].label, "Installiert Spotify")
                self.assertEqual(steps[-1].state, "done")

    def test_silence_without_a_tool_still_ends(self):
        for live in (False, True):
            with self.subTest(live=live):
                started = time.monotonic()
                with self.assertRaises(TooSlowError):
                    self.brain(live=live, timeout_seconds=1).ask("langsam")
                self.assertLess(time.monotonic() - started, 4)


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
