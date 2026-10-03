"""Claude-Plugins: Marktplatz aus dem Jarvis-Ordner anmelden, die eigenen Plugins mit Notizbuch-Ordner installieren,
GitHub-Plugins nur mit Git, einmal von selbst, Sprachbefehle, und der Marktplatz im Repo ist vollständig."""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis import claude_plugins
from jarvis.claude_plugins import EXTRAS, MARKETPLACE, OWN, Plugins, match_command

ROOT = Path(__file__).resolve().parent.parent


class FakeCli:
    """Statt `claude plugin ...`: merkt sich die Aufrufe und antwortet wie Claude Code mit --json."""

    def __init__(self, installed=(), markets=(), fail=()):
        self.calls = []
        self.installed = set(installed)
        self.markets = set(markets)
        self.fail = set(fail)

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd[2:-1])  # ohne claude, "plugin" und "--json"
        args = cmd[2:-1]
        out, code = {"outcome": "ok"}, 0
        if args[:2] == ["marketplace", "add"]:
            self.markets.add(MARKETPLACE if Path(args[2]).exists() else "claude-plugins-official")
        elif args[:2] == ["marketplace", "list"]:
            return subprocess.CompletedProcess(cmd, 0, json.dumps([{"name": m} for m in sorted(self.markets)]), "")
        elif args[0] == "list":
            return subprocess.CompletedProcess(cmd, 0, json.dumps([{"id": p, "enabled": True} for p in sorted(self.installed)]), "")
        elif args[0] == "install":
            plugin = args[1]
            if plugin.split("@")[0] in self.fail:
                out, code = {"outcome": "failed", "message": "kaputt"}, 1
            else:
                self.installed.add(plugin)
        return subprocess.CompletedProcess(cmd, code, "Fortschritt …\n" + json.dumps(out), "")


class PluginsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg = {"brain": {}, "notizbuch": {"ordner": str(self.tmp / "Notizbuch")}}

    def plugins(self, cli, git=True, root=ROOT):
        return Plugins(self.cfg, state_dir=self.tmp / "daten", claude="claude", root=root, runner=cli, git=git)

    def test_setup_installs_everything_with_folders(self):
        cli = FakeCli()
        result = self.plugins(cli).setup()
        self.assertTrue(result["ok"])
        self.assertEqual(cli.calls[0], ["marketplace", "add", str(ROOT)])
        installs = [c for c in cli.calls if c[0] == "install"]
        self.assertEqual([c[1] for c in installs][:len(OWN)], [f"{p}@{MARKETPLACE}" for p in OWN])
        koerper = next(c for c in installs if c[1].startswith("koerper@"))
        self.assertEqual(koerper[-2:], ["--config", f"ordner={self.tmp / 'Notizbuch' / 'Körper'}"])
        self.assertIn("--scope", koerper)
        self.assertNotIn("--config", next(c for c in installs if c[1].startswith("gedaechtnis@")))
        video = next(c for c in installs if c[1].startswith("video@"))
        self.assertEqual(video[-4:], ["--config", f"python={claude_plugins.jarvis_python()}", "--config",
                                      f"jarvis={ROOT}"], "das Video-Plugin nimmt Jarvis' Python und Ordner")
        self.assertIn(["marketplace", "add", "anthropics/claude-plugins-official"], cli.calls)
        self.assertIn("claude-code-setup@claude-plugins-official", cli.installed)
        self.assertEqual(result["text"], "Claude hat jetzt Gedächtnis, Lernen, Assistent, Körper, Geld und Video. "
                                         "Dazu Claude Code Setup.")

    def test_without_git_only_the_own_plugins(self):
        cli = FakeCli()
        result = self.plugins(cli, git=False).setup(extras=("ecc",))
        self.assertTrue(result["ok"])
        self.assertNotIn(["marketplace", "add", "anthropics/claude-plugins-official"], cli.calls)
        self.assertEqual(result["ohne_git"], ["claude-code-setup", "ecc"])
        self.assertIn("Claude Code Setup und Everything Claude Code brauchen Git", result["text"])
        self.assertIn("Sagen Sie „Installiere Git“, dann kommt das gleich hinterher.", result["text"])
        self.assertIn("Claude Code Setup braucht Git", self.plugins(FakeCli(), git=False).setup()["text"])

    def test_git_right_after_installing_it(self):
        program_files = self.tmp / "Programme"
        (program_files / "Git" / "cmd").mkdir(parents=True)
        (program_files / "Git" / "cmd" / "git.exe").write_bytes(b"")
        with mock.patch.dict(claude_plugins.os.environ, {"ProgramFiles": str(program_files), "PATH": str(self.tmp)}), \
                mock.patch.object(claude_plugins.shutil, "which", return_value=None):
            self.assertEqual(claude_plugins.find_git(), str(program_files / "Git" / "cmd" / "git.exe"))
            self.assertTrue(Plugins(self.cfg, state_dir=self.tmp, claude="claude", runner=FakeCli()).git)
            path = claude_plugins._environment()["PATH"]
        self.assertTrue(path.startswith(str(program_files / "Git" / "cmd")), "Claude Code findet Git auch")

    def test_extras_only_on_request(self):
        cli = FakeCli(markets={"claude-plugins-official"})
        self.plugins(cli).setup()
        self.assertFalse([p for p in cli.installed if p.split("@")[0] in EXTRAS])
        cli = FakeCli(markets={"claude-plugins-official"})
        self.plugins(cli).setup(extras=("ecc", "nicht-da"))
        self.assertIn(f"ecc@{MARKETPLACE}", cli.installed)
        self.assertNotIn(["marketplace", "add", "anthropics/claude-plugins-official"], cli.calls, "schon da")

    def test_failures_are_reported(self):
        result = self.plugins(FakeCli(fail={"koerper"})).setup()
        self.assertFalse(result["ok"])
        self.assertIn("Nicht geklappt: Körper.", result["text"])

    def test_auto_runs_once_and_again_after_a_move(self):
        cli = FakeCli()
        plugins = self.plugins(cli)
        self.assertIsNotNone(plugins.auto())
        count = len(cli.calls)
        self.assertIsNone(plugins.auto(), "schon eingerichtet")
        self.assertEqual(len(cli.calls), count)
        moved = self.tmp / "Jarvis-neu"
        shutil.copytree(ROOT / ".claude-plugin", moved / ".claude-plugin")
        self.assertIsNotNone(self.plugins(cli, root=moved).auto(), "Jarvis liegt jetzt woanders")
        state = json.loads((self.tmp / "daten" / "claude-plugins.json").read_text(encoding="utf-8"))
        self.assertEqual(state["root"], str(moved))

    def test_nothing_without_claude_or_marketplace(self):
        plugins = Plugins(self.cfg, state_dir=self.tmp, claude="", root=ROOT, runner=FakeCli(), git=True)
        self.assertIsNone(plugins.auto())
        self.assertIn("nicht installiert", plugins.setup()["text"])
        empty = self.plugins(FakeCli(), root=self.tmp)
        self.assertIsNone(empty.auto())
        self.assertIn("fehlen im Jarvis-Ordner", empty.setup()["text"])

    def test_status_and_broken_cli(self):
        cli = FakeCli(installed={f"gedaechtnis@{MARKETPLACE}", "claude-code-setup@claude-plugins-official"})
        status = self.plugins(cli).status()
        self.assertEqual([p["installiert"] for p in status["plugins"]], [True] + [False] * (len(OWN) - 1))
        self.assertTrue(status["offiziell"][0]["installiert"])

        def broken(cmd, **kwargs):
            raise FileNotFoundError("claude")

        self.assertEqual(self.plugins(broken).installed(), {})
        self.assertIn("nicht angenommen", self.plugins(broken).setup()["text"])

    def test_commands(self):
        self.assertEqual(match_command("Jarvis, richte die Claude-Plugins ein"), ())
        self.assertEqual(match_command("Claude Plugins aktualisieren"), ())
        self.assertEqual(match_command("Installiere Everything Claude Code"), ("ecc",))
        self.assertEqual(match_command("Installiere alle Plugins aus den Videos"), EXTRAS)
        for other in ("Installiere Spotify", "Öffne Claude", "Was sind Plugins?"):
            self.assertIsNone(match_command(other), other)

    def test_photo_hint_uses_the_tool_and_the_plugin_tables(self):
        hint = claude_plugins.photo_hint(self.cfg, ROOT)
        self.assertIn(str(ROOT / "claude-plugins" / "koerper" / "skills" / "ernaehrung" / "naehrwerte.md"), hint)
        self.assertIn(str(ROOT / "claude-plugins" / "koerper" / "skills" / "ernaehrung" / "portionen.md"), hint)
        self.assertIn('python -m jarvis.tool essen "<Lebensmittel>" <Gramm>', hint)
        without = claude_plugins.photo_hint(self.cfg, self.tmp)
        self.assertIn("jarvis.tool essen", without, "eintragen geht auch ohne die Plugin-Dateien")
        self.assertNotIn("naehrwerte.md", without)

    def test_spoken_setup_runs_in_the_background(self):
        from tests.test_assistant import FakeBrain, make

        assistant, ui, speaker, _ = make(FakeBrain())
        with mock.patch.object(claude_plugins.Plugins, "setup", return_value={"text": "Claude hat jetzt Gedächtnis."}) as setup:
            answer = assistant.handle("Richte die Claude-Plugins ein", speak=False)
            for _ in range(100):
                if any(e[0] == "message" and e[2] == "Claude hat jetzt Gedächtnis." for e in ui.events):
                    break
                __import__("time").sleep(0.02)
        self.assertIn("Ich richte die Plugins für Claude ein", answer)
        setup.assert_called_once_with(extras=())
        self.assertTrue(any(e[0] == "message" and e[2] == "Claude hat jetzt Gedächtnis." for e in ui.events))

    def test_after_installing_git_the_waiting_plugins_follow(self):
        from tests.test_assistant import FakeBrain, make

        assistant, ui, speaker, _ = make(FakeBrain())
        waiting = ["claude-code-setup", "ecc"]
        with mock.patch.object(claude_plugins.Plugins, "waiting_for_git", return_value=waiting), \
                mock.patch.object(claude_plugins.Plugins, "setup", return_value={"text": "Dazu Claude Code Setup."}) as setup, \
                mock.patch("jarvis.apps.install", return_value="Git ist installiert."), \
                mock.patch("jarvis.apps.open_app", side_effect=RuntimeError("kein Fenster")):
            assistant._install(__import__("jarvis.apps", fromlist=["find_known"]).find_known("git"))
        setup.assert_called_once_with(extras=("ecc",))
        said = [e[2] for e in ui.events if e[0] == "message"]
        self.assertEqual(said[-2:], ["Git ist installiert, Sir.", "Dazu Claude Code Setup."])

    def test_two_setups_at_once_run_one_after_the_other(self):
        import threading

        running, overlap = [], []

        def slow(cmd, **kwargs):
            running.append(1)
            if len(running) > 1:
                overlap.append(cmd)
            __import__("time").sleep(0.002)
            running.pop()
            return FakeCli()(cmd, **kwargs)

        jobs = [threading.Thread(target=self.plugins(slow).setup) for _ in range(2)]
        for job in jobs:
            job.start()
        for job in jobs:
            job.join(10)
        self.assertEqual(overlap, [], "nie zwei claude-plugin-Aufrufe gleichzeitig")

    def test_waiting_for_git_comes_from_the_last_setup(self):
        plugins = self.plugins(FakeCli(), git=False)
        self.assertEqual(plugins.waiting_for_git(), [])
        plugins.setup(extras=("task-observer",))
        self.assertEqual(plugins.waiting_for_git(), ["claude-code-setup", "task-observer"])
        self.plugins(FakeCli(), git=True).setup()
        self.assertEqual(plugins.waiting_for_git(), [])


class MarketplaceTest(unittest.TestCase):
    """Der Marktplatz im Repo: jede Quelle da, Namen passen, keine Plugin-Tests im Installer."""

    def test_entries_match_folders_and_manifests(self):
        market = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8"))
        self.assertEqual(market["name"], MARKETPLACE)
        local = [p for p in market["plugins"] if isinstance(p["source"], str)]
        self.assertEqual([p["name"] for p in local], list(OWN))
        for entry in local:
            manifest = json.loads((ROOT / entry["source"] / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["name"], entry["name"])
            self.assertFalse(manifest["name"].startswith("claude-"))
        remote = {p["name"]: p for p in market["plugins"] if not isinstance(p["source"], str)}
        self.assertEqual(set(remote), set(EXTRAS))
        for entry in remote.values():
            self.assertRegex(entry["source"]["sha"], r"^[0-9a-f]{40}$", "fremde Plugins auf den geprüften Stand festgelegt")
            self.assertFalse(entry.get("defaultEnabled", True))

    def test_skills_use_the_configured_folder(self):
        for plugin in ("assistent", "koerper", "geld"):
            manifest = json.loads((ROOT / "claude-plugins" / plugin / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
            self.assertIn("ordner", manifest["userConfig"])
            texts = [p.read_text(encoding="utf-8") for p in (ROOT / "claude-plugins" / plugin / "skills").glob("*/SKILL.md")]
            self.assertTrue(texts)
            self.assertTrue(any("${user_config.ordner}" in t for t in texts), plugin)

    def test_video_skill_runs_jarvis_own_python(self):
        manifest = json.loads((ROOT / "claude-plugins" / "video" / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(set(manifest["userConfig"]), {"python", "jarvis"})
        skill = (ROOT / "claude-plugins" / "video" / "skills" / "ansehen" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn('& "${user_config.python}" -m jarvis.video', skill, "PowerShell")
        self.assertIn('(cd "${user_config.jarvis}" && "${user_config.python}" -m jarvis.video', skill, "Bash")
        self.assertIn('Push-Location "${user_config.jarvis}"', skill, "zurück in den alten Ordner danach")
        self.assertIn("timeout 600000", skill)
        self.assertTrue((ROOT / "jarvis" / "video.py").is_file())

    def test_python_for_the_plugin_is_never_pythonw(self):
        folder = self.tmp_scripts()
        with mock.patch.object(claude_plugins.sys, "executable", str(folder / "pythonw.exe")):
            self.assertEqual(claude_plugins.jarvis_python(), str(folder / "python.exe"))
        with mock.patch.object(claude_plugins.sys, "executable", str(folder / "python.exe")):
            self.assertEqual(claude_plugins.jarvis_python(), str(folder / "python.exe"))

    def tmp_scripts(self):
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder, True)
        for name in ("python.exe", "pythonw.exe"):
            (folder / name).write_bytes(b"")
        return folder

    def test_installer_ships_the_plugins_without_tests(self):
        iss = (ROOT / "installer" / "jarvis.iss").read_text(encoding="utf-8")
        self.assertIn('Source: "..\\.claude-plugin\\*"', iss)
        self.assertIn('Source: "..\\claude-plugins\\*"; DestDir: "{app}\\claude-plugins"; Excludes: "tests"', iss)


if __name__ == "__main__":
    unittest.main()
