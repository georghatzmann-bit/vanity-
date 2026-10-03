"""Ein unsichtbarer Arbeitsplatz für die Werkstatt: ein eigener Windows-Desktop, den Georg nie sieht.

Die Werkstatt startet ihr Claude Code dort. Alles, was Claude zum Testen startet (das Spiel, das
Tool mit Fenster, ein Konsolenfenster), erbt diesen Desktop und öffnet seine Fenster dort statt
auf Georgs Bildschirm. Kein Aufpoppen, kein Fokus weg, während er zockt oder arbeitet.

Technisch: CreateDesktopW legt den Desktop an (bleibt, solange Jarvis läuft), CreateProcessW startet
den Prozess mit STARTUPINFO.lpDesktop auf ihm, mit eigenen Leitungen für stdin, stdout und stderr
und nur diesen drei vererbten Handles. Ohne Windows oder wenn etwas davon nicht geht: ganz normal
mit subprocess.Popen (dann eben sichtbar).

Erst "Starte es" (Werkstatt.run_last) startet das fertige Programm auf Georgs Bildschirm.
"""

from __future__ import annotations

import io
import logging
import os
import subprocess
import threading

log = logging.getLogger(__name__)

DESKTOP = "JarvisWerkstatt"

_lock = threading.Lock()
_desktop_handle = None
_failed = False


def available() -> bool:
    """Gibt es den unsichtbaren Arbeitsplatz (Windows, Desktop angelegt)?"""
    return os.name == "nt" and _ensure_desktop() is not None


def popen(cmd: list[str], cwd=None, env: dict | None = None, hidden: bool = True):
    """Wie subprocess.Popen(cmd, stdin/stdout/stderr=PIPE, text=True, encoding="utf-8", errors="replace"),
    aber auf dem unsichtbaren Desktop. Klappt das nicht, normal (und es steht im Protokoll)."""
    if hidden and os.name == "nt":
        try:
            desktop = _ensure_desktop()
            if desktop is not None:
                return _start_hidden(cmd, cwd, env)
        except Exception as exc:
            log.warning("Unsichtbarer Arbeitsplatz geht nicht (%s), die Werkstatt startet normal.", exc)
    return subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd, env=env, text=True,
        encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


# ---------------------------------------------------------------------- Windows

def _ensure_desktop():
    global _desktop_handle, _failed
    with _lock:
        if _desktop_handle is not None or _failed:
            return _desktop_handle
        try:
            import ctypes
            from ctypes import wintypes as w

            user32 = ctypes.WinDLL("user32", use_last_error=True)
            user32.CreateDesktopW.argtypes = [w.LPCWSTR, w.LPCWSTR, ctypes.c_void_p, w.DWORD, w.DWORD, ctypes.c_void_p]
            user32.CreateDesktopW.restype = w.HANDLE
            GENERIC_ALL = 0x10000000
            handle = user32.CreateDesktopW(DESKTOP, None, None, 0, GENERIC_ALL, None)
            if not handle:
                raise OSError(ctypes.get_last_error(), "CreateDesktopW")
            _desktop_handle = handle  # offen lassen: so lange gibt es den Desktop
            log.info("Unsichtbarer Arbeitsplatz für die Werkstatt bereit (Desktop %s).", DESKTOP)
        except Exception as exc:
            _failed = True
            log.warning("Unsichtbarer Arbeitsplatz lässt sich nicht anlegen: %s", exc)
        return _desktop_handle


def _start_hidden(cmd: list[str], cwd, env: dict | None):
    import ctypes
    import msvcrt
    from ctypes import wintypes as w

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class SECURITY_ATTRIBUTES(ctypes.Structure):
        _fields_ = [("nLength", w.DWORD), ("lpSecurityDescriptor", ctypes.c_void_p), ("bInheritHandle", w.BOOL)]

    class STARTUPINFOW(ctypes.Structure):
        _fields_ = [("cb", w.DWORD), ("lpReserved", w.LPWSTR), ("lpDesktop", w.LPWSTR), ("lpTitle", w.LPWSTR),
                    ("dwX", w.DWORD), ("dwY", w.DWORD), ("dwXSize", w.DWORD), ("dwYSize", w.DWORD),
                    ("dwXCountChars", w.DWORD), ("dwYCountChars", w.DWORD), ("dwFillAttribute", w.DWORD),
                    ("dwFlags", w.DWORD), ("wShowWindow", w.WORD), ("cbReserved2", w.WORD),
                    ("lpReserved2", ctypes.c_void_p), ("hStdInput", w.HANDLE), ("hStdOutput", w.HANDLE),
                    ("hStdError", w.HANDLE)]

    class STARTUPINFOEXW(ctypes.Structure):
        _fields_ = [("StartupInfo", STARTUPINFOW), ("lpAttributeList", ctypes.c_void_p)]

    class PROCESS_INFORMATION(ctypes.Structure):
        _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE), ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]

    kernel32.CreatePipe.argtypes = [ctypes.POINTER(w.HANDLE), ctypes.POINTER(w.HANDLE),
                                    ctypes.POINTER(SECURITY_ATTRIBUTES), w.DWORD]
    kernel32.SetHandleInformation.argtypes = [w.HANDLE, w.DWORD, w.DWORD]
    kernel32.CloseHandle.argtypes = [w.HANDLE]
    kernel32.TerminateProcess.argtypes = [w.HANDLE, ctypes.c_uint]
    kernel32.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, w.DWORD, w.DWORD,
                                                           ctypes.POINTER(ctypes.c_size_t)]
    kernel32.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, w.DWORD, ctypes.c_size_t, ctypes.c_void_p,
                                                   ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
    kernel32.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
    kernel32.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL, w.DWORD,
                                        ctypes.c_void_p, w.LPCWSTR, ctypes.c_void_p,
                                        ctypes.POINTER(PROCESS_INFORMATION)]

    HANDLE_FLAG_INHERIT = 0x1
    STARTF_USESTDHANDLES = 0x100
    STARTF_USESHOWWINDOW = 0x1
    SW_HIDE = 0
    CREATE_UNICODE_ENVIRONMENT = 0x400
    CREATE_NO_WINDOW = 0x08000000
    EXTENDED_STARTUPINFO_PRESENT = 0x00080000
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002

    def pipe(child_reads: bool):
        sa = SECURITY_ATTRIBUTES(ctypes.sizeof(SECURITY_ATTRIBUTES), None, True)
        read, write = w.HANDLE(), w.HANDLE()
        if not kernel32.CreatePipe(ctypes.byref(read), ctypes.byref(write), ctypes.byref(sa), 0):
            raise OSError(ctypes.get_last_error(), "CreatePipe")
        parent = write if child_reads else read
        if not kernel32.SetHandleInformation(parent, HANDLE_FLAG_INHERIT, 0):
            raise OSError(ctypes.get_last_error(), "SetHandleInformation")
        return (read, write) if child_reads else (write, read)  # (Ende fürs Kind, Ende für Jarvis)

    opened = []
    try:
        child_in, parent_in = pipe(child_reads=True)
        opened += [child_in, parent_in]
        child_out, parent_out = pipe(child_reads=False)
        opened += [child_out, parent_out]
        child_err, parent_err = pipe(child_reads=False)
        opened += [child_err, parent_err]

        # Nur diese drei Handles erbt das Kind, keine anderen offenen von Jarvis.
        size = ctypes.c_size_t(0)
        kernel32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
        attributes = (ctypes.c_byte * size.value)()
        if not kernel32.InitializeProcThreadAttributeList(attributes, 1, 0, ctypes.byref(size)):
            raise OSError(ctypes.get_last_error(), "InitializeProcThreadAttributeList")
        inherit = (w.HANDLE * 3)(child_in, child_out, child_err)
        try:
            if not kernel32.UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit,
                                                      ctypes.sizeof(inherit), None, None):
                raise OSError(ctypes.get_last_error(), "UpdateProcThreadAttribute")
            info = STARTUPINFOEXW()
            info.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEXW)
            desktop = ctypes.create_unicode_buffer("WinSta0\\" + DESKTOP)
            info.StartupInfo.lpDesktop = ctypes.cast(desktop, w.LPWSTR)
            info.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
            info.StartupInfo.wShowWindow = SW_HIDE
            info.StartupInfo.hStdInput, info.StartupInfo.hStdOutput, info.StartupInfo.hStdError = (
                child_in, child_out, child_err)
            info.lpAttributeList = ctypes.cast(attributes, ctypes.c_void_p)

            line = ctypes.create_unicode_buffer(subprocess.list2cmdline([str(c) for c in cmd]))
            block = None
            if env is not None:
                text = "".join(f"{k}={v}\0" for k, v in sorted(env.items(), key=lambda kv: kv[0].upper())) + "\0"
                block = ctypes.create_unicode_buffer(text)  # Größe selbst bestimmen lassen (Emojis brauchen zwei)
            process = PROCESS_INFORMATION()
            flags = CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT
            if not kernel32.CreateProcessW(None, line, None, None, True, flags,
                                           ctypes.cast(block, ctypes.c_void_p) if block is not None else None,
                                           str(cwd) if cwd else None, ctypes.byref(info), ctypes.byref(process)):
                raise OSError(ctypes.get_last_error(), "CreateProcessW")
        finally:
            kernel32.DeleteProcThreadAttributeList(attributes)
        kernel32.CloseHandle(process.hThread)
        # Die Enden des Kindes braucht Jarvis nicht: zu, sonst kommt nie das Ende der Ausgabe an.
        for handle in (child_in, child_out, child_err):
            kernel32.CloseHandle(handle)
            opened.remove(handle)

        def wrap(handle, mode: str):
            fd = msvcrt.open_osfhandle(handle.value, os.O_WRONLY if mode == "w" else os.O_RDONLY)
            opened.remove(handle)  # gehört jetzt dem Dateiobjekt
            raw = io.open(fd, mode + "b", -1)
            if mode == "w":
                return io.TextIOWrapper(raw, encoding="utf-8", errors="replace", write_through=True)
            return io.TextIOWrapper(raw, encoding="utf-8", errors="replace")

        try:
            stdin, stdout, stderr = wrap(parent_in, "w"), wrap(parent_out, "r"), wrap(parent_err, "r")
        except Exception:
            kernel32.TerminateProcess(process.hProcess, 1)  # sonst liefe er unsichtbar weiter
            kernel32.CloseHandle(process.hProcess)
            raise
        log.info("Werkstatt läuft auf dem unsichtbaren Arbeitsplatz (PID %s).", process.dwProcessId)
        return HiddenProcess(process.hProcess, process.dwProcessId, cmd, stdin, stdout, stderr)
    except Exception:
        for handle in opened:
            try:
                kernel32.CloseHandle(handle)
            except Exception:
                pass
        raise


class HiddenProcess:
    """Das Nötigste von subprocess.Popen für einen Prozess auf dem unsichtbaren Desktop."""

    def __init__(self, handle, pid: int, args, stdin, stdout, stderr) -> None:
        import ctypes
        from ctypes import wintypes as w

        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._kernel32.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
        self._kernel32.WaitForSingleObject.restype = w.DWORD
        self._kernel32.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
        self._kernel32.TerminateProcess.argtypes = [w.HANDLE, ctypes.c_uint]
        self._kernel32.CloseHandle.argtypes = [w.HANDLE]
        # Das Handle bleibt offen, bis das Objekt weg ist: poll() und wait() kommen aus mehreren
        # Threads, ein zu frühes CloseHandle träfe sonst eine laufende Wartezeit oder ein fremdes
        # Handle von Jarvis mit derselben Nummer.
        self._handle = handle
        self._lock = threading.Lock()
        self.pid = int(pid)
        self.args = args
        self.stdin, self.stdout, self.stderr = stdin, stdout, stderr
        self.returncode: int | None = None

    def poll(self) -> int | None:
        if self.returncode is None and self._kernel32.WaitForSingleObject(self._handle, 0) == 0:
            self._collect()
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        if self.returncode is None:
            millis = 0xFFFFFFFF if timeout is None else max(0, int(timeout * 1000))
            if self._kernel32.WaitForSingleObject(self._handle, millis) != 0:
                raise subprocess.TimeoutExpired(self.args, timeout)
            self._collect()
        return self.returncode

    def kill(self) -> None:
        if self.returncode is None:
            self._kernel32.TerminateProcess(self._handle, 1)

    terminate = kill

    def _collect(self) -> None:
        import ctypes
        from ctypes import wintypes as w

        with self._lock:
            if self.returncode is None:
                code = w.DWORD(0)
                self._kernel32.GetExitCodeProcess(self._handle, ctypes.byref(code))
                self.returncode = int(code.value)

    def __del__(self) -> None:
        try:
            handle, self._handle = self._handle, None
            if handle:
                self._kernel32.CloseHandle(handle)
        except Exception:
            pass
