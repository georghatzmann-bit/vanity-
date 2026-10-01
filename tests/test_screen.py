"""Bildschirm schnell lesen (Windows-OCR) und Fenster ohne Maus bedienen (UI Automation)."""

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis import screen


class ScreenTest(unittest.TestCase):
    def test_capture_is_a_small_jpeg(self):
        from PIL import Image

        big = Image.new("RGB", (3840, 2160), "navy")
        with tempfile.TemporaryDirectory() as folder, mock.patch("PIL.ImageGrab.grab", return_value=big):
            path = screen.capture(Path(folder) / "shot.jpg")
            with Image.open(path) as image:
                self.assertEqual(image.format, "JPEG")
                self.assertLessEqual(max(image.size), 1600)

    def test_ocr_lines_with_positions(self):
        raw = json.dumps([{"t": "Speichern", "x": 400, "y": 12, "w": 80, "h": 14},
                          {"t": "Datei", "x": 10, "y": 10, "w": 40, "h": 14},
                          {"t": "  ", "x": 1, "y": 1, "w": 1, "h": 1}])
        from PIL import Image

        with mock.patch.object(screen, "_powershell", return_value=raw) as ps, \
                mock.patch("PIL.ImageGrab.grab", return_value=Image.new("RGB", (100, 50))):
            lines = screen.read_text()
        self.assertEqual([l["t"] for l in lines], ["Speichern", "Datei"])
        self.assertEqual(screen.as_text(lines), "[10,10] Datei\n[400,12] Speichern")
        self.assertIn("JARVIS_OCR_FILE", ps.call_args.args[1], "der Pfad geht über die Umgebung, nicht in den Skripttext")
        with mock.patch.object(screen, "_powershell", return_value='{"t": "Nur eine Zeile", "x": 1, "y": 2, "w": 3, "h": 4}'):
            self.assertEqual(len(screen.read_text(image=Path("x.png"))), 1)

    def test_ui_automation_passes_names_safely(self):
        tricky = 'Speichern"; Remove-Item C:\\ -Recurse; "'
        with mock.patch.object(screen, "_powershell", return_value="OK Speichern\n") as ps:
            self.assertEqual(screen.click("Editor", tricky), "OK Speichern")
        script, env = ps.call_args.args
        self.assertNotIn(tricky, script)
        self.assertEqual(env["JARVIS_UI_NAME"], tricky)
        with mock.patch.object(screen, "_powershell", return_value=json.dumps([{"titel": "Discord", "programm": "Discord"}])):
            self.assertEqual(screen.windows(), [{"titel": "Discord", "programm": "Discord"}])
        with mock.patch.object(screen, "_powershell", return_value="OK Text Editor\n") as ps:
            screen.type_into("Notepad", "", "Hallo")
        self.assertEqual(ps.call_args.args[1]["JARVIS_UI_TEXT"], "Hallo")

    def test_typing_also_reaches_multiline_fields(self):
        # Der Editor hat ein mehrzeiliges Feld ohne ValuePattern; das bekommt den Text als WM_SETTEXT
        script = screen.TYPE_SCRIPT
        self.assertIn("ValuePattern", script)
        self.assertIn("'^(Edit|RichEdit)'", script)
        self.assertIn("0x000C, [IntPtr]::Zero, $env:JARVIS_UI_TEXT", script)
        self.assertLess(script.index("ValuePattern]::Pattern).SetValue"), script.index("SendMessageW($hwnd"),
                        "einzeilige Felder zuerst, wie bisher")

    def test_errors_come_back_as_plain_text(self):
        import subprocess

        failed = subprocess.CompletedProcess([], 1, stdout="", stderr="Kein Element gefunden: Senden\r\n")
        with mock.patch.object(screen.os, "name", "nt"), \
                mock.patch.object(screen.subprocess, "run", return_value=failed) as run:
            with self.assertRaises(screen.ScreenError) as caught:
                screen.click("Discord", "Senden")
        self.assertEqual(str(caught.exception), "Kein Element gefunden: Senden")
        script = run.call_args.args[0][-1]
        self.assertIn("trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }", script)
        self.assertLess(script.index("trap"), script.index("Add-Type"), "der Fehlerfang steht vor dem Skript")

    def test_only_on_windows(self):
        with mock.patch.object(screen.os, "name", "posix"):
            with self.assertRaises(screen.ScreenError):
                screen._powershell("Get-Date")

    def test_tool_commands(self):
        from jarvis import tool

        out = io.StringIO()
        with mock.patch.object(screen, "read_text", return_value=[{"t": "Hallo", "x": 1, "y": 2}]), \
                mock.patch("sys.stdout", out):
            self.assertEqual(tool.main(["bildschirm-text"]), 0)
        self.assertIn("[1,2] Hallo", out.getvalue())
        out = io.StringIO()
        with mock.patch.object(screen, "click", return_value="OK Senden") as click, mock.patch("sys.stdout", out):
            self.assertEqual(tool.main(["ui-klick", "Discord", "Senden"]), 0)
        click.assert_called_once_with("Discord", "Senden")


if __name__ == "__main__":
    unittest.main()
