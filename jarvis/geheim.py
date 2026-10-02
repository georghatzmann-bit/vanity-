"""Passwörter für iCloud und Mail sicher auf dem PC (daten/geheim.json).

Unter Windows verschlüsselt Jarvis sie mit DPAPI (CryptProtectData): Nur derselbe Windows-Benutzer
auf diesem PC kann sie wieder lesen. Ein anderer Benutzer oder ein kopierter Datenordner kommt nicht
heran. Auf anderen Systemen (Tests) stehen sie nur einfach kodiert da, mit einer Warnung im Protokoll.

Die Passwörter stehen nie in config.toml, nie im Protokoll und gehen nie an Claude.
"""

from __future__ import annotations

import base64
import ctypes
import json
import logging
import os
import threading
from pathlib import Path

log = logging.getLogger(__name__)

CRYPTPROTECT_UI_FORBIDDEN = 0x1  # nie ein Windows-Fenster zeigen
# Ein zusätzlicher Schlüsselteil: Andere Programme desselben Benutzers entschlüsseln nicht einfach mit.
ENTROPY = b"Jarvis-Geheimnisse-1"


class SecretError(RuntimeError):
    pass


_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(path: Path) -> threading.Lock:
    """Ein Schloss pro Datei: iPhone, Mail und Shop haben je einen eigenen Tresor auf dieselbe Datei.
    Speichern zwei gleichzeitig, darf keiner den Eintrag des anderen überschreiben."""
    key = os.path.normcase(os.path.abspath(path))
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.Lock())


class _Blob(ctypes.Structure):
    """DATA_BLOB aus der Windows-API: Länge und Zeiger auf die Bytes."""

    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes):
    """Ein DATA_BLOB für `data`. Der Puffer muss leben, solange Windows ihn liest: darum zurückgeben."""
    buffer = ctypes.create_string_buffer(data, len(data))
    return _Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char))), buffer


class Dpapi:
    """CryptProtectData/CryptUnprotectData über ctypes (crypt32.dll), nur für diesen Windows-Benutzer."""

    def __init__(self, crypt32=None, kernel32=None) -> None:
        if crypt32 is None:
            crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)  # type: ignore[attr-defined]
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
            blob = ctypes.POINTER(_Blob)
            crypt32.CryptProtectData.argtypes = [blob, ctypes.c_wchar_p, blob, ctypes.c_void_p, ctypes.c_void_p,
                                                 ctypes.c_uint32, blob]
            crypt32.CryptProtectData.restype = ctypes.c_int
            crypt32.CryptUnprotectData.argtypes = [blob, ctypes.c_void_p, blob, ctypes.c_void_p, ctypes.c_void_p,
                                                   ctypes.c_uint32, blob]
            crypt32.CryptUnprotectData.restype = ctypes.c_int
            kernel32.LocalFree.argtypes = [ctypes.c_void_p]
            kernel32.LocalFree.restype = ctypes.c_void_p
        self._crypt32 = crypt32
        self._kernel32 = kernel32

    def protect(self, data: bytes) -> bytes:
        source, _keep = _blob(data)
        entropy, _keep2 = _blob(ENTROPY)
        out = _Blob()
        if not self._crypt32.CryptProtectData(ctypes.byref(source), "Jarvis", ctypes.byref(entropy), None, None,
                                              CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out)):
            raise SecretError(f"Windows konnte das Passwort nicht verschlüsseln (Fehler {ctypes.get_last_error()}).")
        return self._take(out)

    def unprotect(self, data: bytes) -> bytes:
        source, _keep = _blob(data)
        entropy, _keep2 = _blob(ENTROPY)
        out = _Blob()
        if not self._crypt32.CryptUnprotectData(ctypes.byref(source), None, ctypes.byref(entropy), None, None,
                                                CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out)):
            raise SecretError("Das gespeicherte Passwort lässt sich nicht entschlüsseln (anderer Windows-Benutzer "
                              "oder anderer PC). Bitte neu verbinden.")
        return self._take(out)

    def _take(self, out: _Blob) -> bytes:
        """Kopiert das Ergebnis und gibt den Speicher an Windows zurück."""
        try:
            return ctypes.string_at(out.pbData, out.cbData)
        finally:
            self._kernel32.LocalFree(out.pbData)


class Secrets:
    """Ein kleiner Tresor: Schlüssel ("apple", "mail:gmail") -> Passwort.

    In der Datei steht je Eintrag, wie er geschützt ist ("dpapi" oder "einfach"). So liest ein
    Windows-PC auch einen alten einfachen Eintrag und schützt ihn beim nächsten Speichern richtig."""

    def __init__(self, path: Path, dpapi=None) -> None:
        self._path = Path(path)
        self._lock = _lock_for(self._path)
        self._dpapi = dpapi
        self._windows = dpapi is not None or os.name == "nt"
        self._warned = False

    def __repr__(self) -> str:
        return f"Secrets({self._path.name})"  # nie die Werte

    def _protector(self):
        if self._dpapi is None and self._windows:
            self._dpapi = Dpapi()
        return self._dpapi

    def _read(self) -> dict:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        values = data.get("werte") if isinstance(data, dict) else None
        return dict(values) if isinstance(values, dict) else {}

    def _write(self, values: dict) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temp = self._path.with_suffix(".tmp")
        temp.write_text(json.dumps({"version": 1, "werte": values}, indent=1), encoding="utf-8")
        if os.name != "nt":
            try:
                os.chmod(temp, 0o600)  # nur der eigene Benutzer
            except OSError:
                pass
        os.replace(temp, self._path)

    def _warn_plain(self) -> None:
        if not self._warned:
            self._warned = True
            log.warning("Ohne Windows kann Jarvis Passwörter nicht verschlüsseln: Sie stehen nur einfach kodiert in %s.",
                        self._path.name)

    def set(self, key: str, value: str) -> None:
        raw = str(value).encode("utf-8")
        protector = self._protector()
        if protector is not None:
            entry = {"art": "dpapi", "daten": base64.b64encode(protector.protect(raw)).decode("ascii")}
        else:
            self._warn_plain()
            entry = {"art": "einfach", "daten": base64.b64encode(raw).decode("ascii")}
        with self._lock:
            values = self._read()
            values[str(key)] = entry
            self._write(values)

    def get(self, key: str) -> str:
        """Das Passwort, "" wenn es keins gibt oder es sich nicht lesen lässt (Grund im Protokoll)."""
        with self._lock:
            entry = self._read().get(str(key))
        if not isinstance(entry, dict):
            return ""
        try:
            data = base64.b64decode(str(entry.get("daten", "")))
            if entry.get("art") == "dpapi":
                protector = self._protector()
                if protector is None:
                    log.warning("Das Passwort für %s ist mit Windows verschlüsselt und hier nicht lesbar.", key)
                    return ""
                data = protector.unprotect(data)
            else:
                if not self._windows:
                    self._warn_plain()
            return data.decode("utf-8")
        except (SecretError, ValueError, OSError) as exc:
            log.warning("Passwort für %s nicht lesbar: %s", key, exc)
            return ""

    def has(self, key: str) -> bool:
        with self._lock:
            return str(key) in self._read()

    def delete(self, key: str) -> bool:
        with self._lock:
            values = self._read()
            if str(key) not in values:
                return False
            del values[str(key)]
            self._write(values)
        return True

    def keys(self) -> list[str]:
        with self._lock:
            return sorted(self._read())
