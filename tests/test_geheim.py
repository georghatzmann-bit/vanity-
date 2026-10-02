"""Passwörter im Tresor: unter Windows mit DPAPI (hier mit nachgebautem crypt32 über ctypes),
sonst einfach kodiert mit Warnung. Nie im Klartext in der Datei, nie im Protokoll."""

import base64
import ctypes
import json
import logging
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis import geheim
from jarvis.geheim import CRYPTPROTECT_UI_FORBIDDEN, ENTROPY, Dpapi, Secrets, SecretError

SECRET = "abcd-efgh-ijkl-mnop"


class FakeCrypt32:
    """Wie crypt32.dll: liest die DATA_BLOBs über ctypes, schreibt das Ergebnis in einen neuen Puffer."""

    def __init__(self, user="georg"):
        self.user = user.encode()
        self.calls = []
        self._buffers = []

    def _read(self, ref):
        blob = ref._obj  # ctypes.byref(...) gibt das Objekt so weiter
        return ctypes.string_at(blob.pbData, blob.cbData)

    def _give(self, ref, data):
        buffer = ctypes.create_string_buffer(data, len(data))
        self._buffers.append(buffer)
        ref._obj.cbData = len(data)
        ref._obj.pbData = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char))

    def CryptProtectData(self, data_in, description, entropy, reserved, prompt, flags, data_out):
        self.calls.append(("protect", description, self._read(entropy), flags))
        plain = self._read(data_in)
        self._give(data_out, b"DPAPI|" + self.user + b"|" + bytes(b ^ 0x5A for b in plain))
        return 1

    def CryptUnprotectData(self, data_in, description, entropy, reserved, prompt, flags, data_out):
        self.calls.append(("unprotect", description, self._read(entropy), flags))
        blob = self._read(data_in)
        head = b"DPAPI|" + self.user + b"|"
        if not blob.startswith(head) or self._read(entropy) != ENTROPY:
            return 0  # anderer Windows-Benutzer
        self._give(data_out, bytes(b ^ 0x5A for b in blob[len(head):]))
        return 1


class FakeKernel32:
    def __init__(self):
        self.freed = 0

    def LocalFree(self, pointer):
        self.freed += 1


class DpapiTest(unittest.TestCase):
    def test_round_trip_through_ctypes(self):
        crypt32, kernel32 = FakeCrypt32(), FakeKernel32()
        dpapi = Dpapi(crypt32, kernel32)
        sealed = dpapi.protect(SECRET.encode())
        self.assertNotIn(SECRET.encode(), sealed)
        self.assertEqual(dpapi.unprotect(sealed), SECRET.encode())
        self.assertEqual([c[0] for c in crypt32.calls], ["protect", "unprotect"])
        self.assertEqual({c[2] for c in crypt32.calls}, {ENTROPY}, "mit eigenem Schlüsselteil")
        self.assertEqual({c[3] for c in crypt32.calls}, {CRYPTPROTECT_UI_FORBIDDEN}, "nie ein Windows-Fenster")
        self.assertEqual(kernel32.freed, 2, "Speicher an Windows zurück")

    def test_other_windows_user_cannot_read_it(self):
        sealed = Dpapi(FakeCrypt32("georg"), FakeKernel32()).protect(SECRET.encode())
        with self.assertRaisesRegex(SecretError, "anderer Windows-Benutzer"):
            Dpapi(FakeCrypt32("fremd"), FakeKernel32()).unprotect(sealed)


class SecretsTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.path = Path(self.folder.name) / "geheim.json"

    def tearDown(self):
        self.folder.cleanup()

    def test_windows_keeps_passwords_encrypted(self):
        secrets = Secrets(self.path, dpapi=Dpapi(FakeCrypt32(), FakeKernel32()))
        with self.assertNoLogs("jarvis.geheim", level="WARNING"):
            secrets.set("apple", SECRET)
        raw = self.path.read_text(encoding="utf-8")
        self.assertNotIn(SECRET, raw)
        self.assertNotIn(base64.b64encode(SECRET.encode()).decode(), raw)
        self.assertEqual(json.loads(raw)["werte"]["apple"]["art"], "dpapi")
        again = Secrets(self.path, dpapi=Dpapi(FakeCrypt32(), FakeKernel32()))
        self.assertEqual(again.get("apple"), SECRET)
        self.assertTrue(again.has("apple"))
        self.assertEqual(again.keys(), ["apple"])
        self.assertNotIn(SECRET, repr(again))

    def test_two_vaults_on_one_file_keep_each_others_entries(self):
        # iPhone, Mail und Shop speichern über eigene Tresore in dieselbe Datei, auch gleichzeitig
        import threading

        vaults = [Secrets(self.path, dpapi=Dpapi(FakeCrypt32(), FakeKernel32())) for _ in range(4)]
        self.assertIs(vaults[0]._lock, vaults[1]._lock)

        def save(i):
            for n in range(10):
                vaults[i % 4].set(f"konto{i}-{n}", SECRET)

        workers = [threading.Thread(target=save, args=(i,)) for i in range(8)]
        for w in workers:
            w.start()
        for w in workers:
            w.join()
        self.assertEqual(len(Secrets(self.path, dpapi=Dpapi(FakeCrypt32(), FakeKernel32())).keys()), 80)

    def test_another_windows_user_gets_nothing_and_no_secret_in_the_log(self):
        Secrets(self.path, dpapi=Dpapi(FakeCrypt32("georg"), FakeKernel32())).set("apple", SECRET)
        other = Secrets(self.path, dpapi=Dpapi(FakeCrypt32("fremd"), FakeKernel32()))
        with self.assertLogs("jarvis.geheim", level="WARNING") as logs:
            self.assertEqual(other.get("apple"), "")
        self.assertIn("neu verbinden", "\n".join(logs.output))
        self.assertNotIn(SECRET, "\n".join(logs.output))

    def test_without_windows_only_encoded_with_a_warning(self):
        with mock.patch.object(geheim.os, "name", "posix"):
            secrets = Secrets(self.path)
            with self.assertLogs("jarvis.geheim", level="WARNING") as logs:
                secrets.set("mail:gmail", SECRET)
                secrets.set("apple", "zweites-passwort")
            self.assertEqual(len(logs.output), 1, "nur einmal warnen")
            self.assertIn("nicht verschlüsseln", logs.output[0])
            self.assertNotIn(SECRET, logs.output[0])
            raw = self.path.read_text(encoding="utf-8")
            self.assertNotIn(SECRET, raw)
            self.assertEqual(json.loads(raw)["werte"]["mail:gmail"]["art"], "einfach")
            self.assertEqual(Secrets(self.path).get("mail:gmail"), SECRET)

    def test_encrypted_entry_on_another_system_and_delete(self):
        Secrets(self.path, dpapi=Dpapi(FakeCrypt32(), FakeKernel32())).set("apple", SECRET)
        with mock.patch.object(geheim.os, "name", "posix"):
            plain = Secrets(self.path)
            with self.assertLogs("jarvis.geheim", level="WARNING"):
                self.assertEqual(plain.get("apple"), "")
            self.assertTrue(plain.delete("apple"))
            self.assertFalse(plain.delete("apple"))
            self.assertFalse(plain.has("apple"))
            self.assertEqual(plain.get("gibt-es-nicht"), "")


if __name__ == "__main__":
    unittest.main()
