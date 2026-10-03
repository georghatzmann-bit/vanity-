"""Jarvis' Spezialisten: Recherche, Texte, Technik als Helfer für Claude (--agents)."""

import json
import tomllib
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from jarvis.brain import Attempt, ClaudeBrain
from jarvis.config import EXAMPLE_PATH, load_config, upgrade_config
from jarvis.helfer import AGENTS, agents_json
from tests.helpers import make_fake_claude


class HelferTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        cfg = load_config()["brain"]
        cfg["claude_path"] = str(make_fake_claude(self.home))
        self.cfg = cfg

    def brain(self, **changes):
        cfg = dict(self.cfg, **changes)
        brain = ClaudeBrain(cfg, self.home, self.home / "daten")
        self.addCleanup(brain.close)
        return brain

    def test_agents_are_safe_and_valid_json(self):
        data = json.loads(agents_json())
        self.assertEqual(set(data), {"recherche", "texte", "technik"})
        for name, agent in data.items():
            with self.subTest(agent=name):
                self.assertTrue(agent["description"] and agent["prompt"])
                self.assertFalse(set(agent["tools"]) & {"Write", "Edit"} - ({"Write"} if name == "recherche" else set()))
                self.assertFalse(any(t.startswith("mcp__") for t in agent["tools"]), "keine Konnektoren")
                for text in (agent["description"], agent["prompt"]):
                    self.assertFalse(set(text) & set("&|<>^%"), "keine Zeichen, die cmd umdeutet")
        self.assertNotIn("Edit", AGENTS["technik"]["tools"])

    def test_only_the_jarvis_profile_gets_helpers(self):
        brain = self.brain()
        cmd = brain.command(Attempt("sonnet", "jarvis"))
        self.assertIn("--agents", cmd)
        self.assertEqual(json.loads(cmd[cmd.index("--agents") + 1]), json.loads(agents_json()))
        self.assertIn("Agent", cmd[cmd.index("--tools") + 1:cmd.index("--allowedTools")])
        self.assertNotIn("--agents", brain.command(Attempt("haiku", "reden")))
        self.assertNotIn("--agents", brain.command(Attempt("sonnet", "einfach")))
        self.assertNotIn("--agents", self.brain(spezialisten=False).command(Attempt("sonnet", "jarvis")))

    def test_old_config_gets_the_agent_tool(self):
        with TemporaryDirectory() as folder:
            path = Path(folder) / "config.toml"
            text = EXAMPLE_PATH.read_text(encoding="utf-8").split("[intern]")[0]
            old = '"WebSearch", "WebFetch", "Agent", "ToolSearch"]'
            self.assertIn(old, text)
            text = text.replace(old, '"WebSearch", "WebFetch"]', 1)
            path.write_text(text + "\n[intern]\nconfig_version = 7\n", encoding="utf-8")
            self.assertNotIn("Agent", load_config(path)["brain"]["tools"])
            self.assertIn("brain.tools: mit Agent, ToolSearch", upgrade_config(path))
            data = tomllib.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(data["brain"]["tools"][-2:], ["Agent", "ToolSearch"])
            self.assertEqual(upgrade_config(path), [], "nur einmal")

    def test_tool_search_keeps_requests_small(self):
        """Ohne ToolSearch schickt Claude Code alle Konnektor-Werkzeuge bei jeder Frage mit."""
        cmd = self.brain().command(Attempt("sonnet", "jarvis"))
        tools = cmd[cmd.index("--tools") + 1:cmd.index("--allowedTools")]
        self.assertIn("ToolSearch", tools)
        allowed = cmd[cmd.index("--allowedTools") + 1:]
        self.assertIn("ToolSearch", allowed[:allowed.index("--disallowedTools")] if "--disallowedTools" in allowed else allowed)

    def test_persona_mentions_the_helpers(self):
        from jarvis.persona import build_persona

        cfg = load_config()
        root = Path(__file__).resolve().parent.parent
        text = build_persona(root / "jarvis_home", self.home / "daten", cfg).read_text(encoding="utf-8")
        self.assertIn("## Deine Spezialisten", text)
        cfg["brain"]["spezialisten"] = False
        text = build_persona(root / "jarvis_home", self.home / "daten2", cfg).read_text(encoding="utf-8")
        self.assertNotIn("## Deine Spezialisten", text)


if __name__ == "__main__":
    unittest.main()
