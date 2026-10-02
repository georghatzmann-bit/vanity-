"""MultiUi reicht alles an jede Anzeige weiter, auch Felder, die wie seine eigenen Parameter heißen."""

import unittest

from jarvis.ui import MultiUi, Ui


class Recorder(Ui):
    def __init__(self):
        self.calls = []

    def config(self, **values):
        self.calls.append(("config", values))

    def message(self, role, text, id=None, model="", final=True):
        self.calls.append(("message", role, text, id, model, final))


class Broken(Ui):
    def config(self, **values):
        raise RuntimeError("Fenster weg")


class MultiUiTest(unittest.TestCase):
    def test_config_with_a_name_field(self):
        # So ruft der Start die Anzeigen auf; vorher stürzte das Fenster hier ab
        # ("_each() got multiple values for argument 'name'").
        first, second = Recorder(), Recorder()
        ui = MultiUi(first, second)
        ui.config(hotkey="ctrl+alt+m", version="2.0.0", muted=False, name="Georg")
        for rec in (first, second):
            self.assertEqual(rec.calls, [("config", {"hotkey": "ctrl+alt+m", "version": "2.0.0", "muted": False, "name": "Georg"})])

    def test_any_field_name_is_passed_through(self):
        rec = Recorder()
        MultiUi(rec).config(method="x", args=1, kwargs=2)
        self.assertEqual(rec.calls, [("config", {"method": "x", "args": 1, "kwargs": 2})])

    def test_one_broken_display_does_not_stop_the_others(self):
        rec = Recorder()
        MultiUi(Broken(), rec).config(name="Georg")
        self.assertEqual(rec.calls, [("config", {"name": "Georg"})])

    def test_message_is_forwarded(self):
        rec = Recorder()
        MultiUi(rec).message("jarvis", "Guten Morgen, Sir.", id="a1", model="lokal")
        self.assertEqual(rec.calls, [("message", "jarvis", "Guten Morgen, Sir.", "a1", "lokal", True)])


if __name__ == "__main__":
    unittest.main()
