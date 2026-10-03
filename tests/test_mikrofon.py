"""Wer hat das Mikrofon gerade offen? Gelesen wie Windows es führt (Datenschutz > Mikrofon), mit einer
nachgebauten Registrierung."""

import time
import unittest

import tests.helpers  # noqa: F401
from jarvis import mikrofon


def filetime(unix: float) -> int:
    return int((unix + 11_644_473_600) * 10_000_000)


class FakeKey:
    def __init__(self, children=None, values=None):
        self.children = children or {}
        self.values = values or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeWinreg:
    HKEY_CURRENT_USER = "HKCU"

    def __init__(self, tree):
        self.root = FakeKey(tree)

    def OpenKey(self, parent, name):
        if parent == self.HKEY_CURRENT_USER:
            if name != mikrofon.KEY:
                raise OSError(name)
            return self.root
        if name not in parent.children:
            raise OSError(name)
        return parent.children[name]

    def EnumKey(self, key, index):
        names = list(key.children)
        if index >= len(names):
            raise OSError("keine weiteren")
        return names[index]

    def QueryValueEx(self, key, name):
        if name not in key.values:
            raise OSError(name)
        return key.values[name], 11


NOW = time.time()


def program(start_ago: float, stop: int | None = None):
    return FakeKey(values={"LastUsedTimeStart": filetime(NOW - start_ago),
                           "LastUsedTimeStop": 0 if stop is None else stop})


class MicTest(unittest.TestCase):
    def tree(self):
        done = filetime(NOW - 30)
        return {
            "NonPackaged": FakeKey({
                r"C:#Users#Georg#AppData#Local#Discord#app-1.0.9200#Discord.exe": program(600),
                r"C:#Users#Georg#AppData#Local#Jarvis#python#pythonw.exe": program(3600),
                r"C:#Program Files#OBS#bin#64bit#obs64.exe": program(900, stop=done),
                r"C:#Games#Absturz#Spiel.exe": program(120),
                r"C:#Program Files#NVIDIA Corporation#NVIDIA Broadcast#NVIDIA Broadcast.exe": program(7200),
            }),
            "Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe": program(60, stop=done),
            "5319275A.WhatsAppDesktop_cv1g1gvanyjgm": program(3 * 86400),
        }

    def test_discord_counts_jarvis_and_closed_programs_do_not(self):
        raw = mikrofon.entries(FakeWinreg(self.tree()))
        self.assertEqual(len(raw), 7)
        running = {"discord.exe", "pythonw.exe", "obs64.exe", "nvidia broadcast.exe"}
        self.assertEqual(mikrofon.others(raw, running, now=NOW), ["Discord"],
                         "Jarvis selbst, OBS (wieder frei), ein abgestürztes Spiel, WhatsApp seit Tagen, der Rauschfilter: nicht")

    def test_without_a_process_list_old_entries_do_not_count(self):
        raw = mikrofon.entries(FakeWinreg(self.tree()))
        self.assertEqual(mikrofon.others(raw, None, now=NOW), ["Discord", "Spiel"])

    def test_names_for_the_message(self):
        self.assertEqual(mikrofon.label(r"C:\Program Files\TeamSpeak 3 Client\ts3client_win64.exe"), "TeamSpeak")
        self.assertEqual(mikrofon.label(r"D:\Tools\Voicemeeter.exe"), "Voicemeeter")
        self.assertEqual(mikrofon.label("5319275A.WhatsAppDesktop_cv1g1gvanyjgm", packaged=True), "WhatsApp")
        self.assertEqual(mikrofon.label("Contoso.Funk_abc123", packaged=True), "Funk")

    def test_nothing_there_or_not_windows(self):
        self.assertEqual(mikrofon.entries(FakeWinreg({})), [])

        class Missing(FakeWinreg):
            def OpenKey(self, parent, name):
                raise OSError("fehlt")

        self.assertEqual(mikrofon.entries(Missing({})), [])
        if mikrofon.os.name != "nt":
            self.assertEqual(mikrofon.in_use_by_others(), [])


if __name__ == "__main__":
    unittest.main()
