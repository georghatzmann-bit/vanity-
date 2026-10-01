"""Probe: Hat der laufende Jarvis (PID als Argument, samt Kindprozessen) ein sichtbares Fenster mit dem Titel "Jarvis"?"""

import ctypes
import sys
from ctypes import wintypes

pid = int(sys.argv[1])
user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
found = []
EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


def process_tree(root: int) -> set[int]:
    """root und alle Kindprozesse. pythonw.exe aus der venv ist nur ein Starter: Jarvis
    selbst (und damit das Fenster) läuft in einem Kindprozess mit eigener PID."""
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    snap = kernel32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    parents = {}
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(entry)
    ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
    while ok:
        parents[entry.th32ProcessID] = entry.th32ParentProcessID
        ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    kernel32.CloseHandle(snap)
    tree = {root}
    grew = True
    while grew:
        grew = False
        for child, parent in parents.items():
            if parent in tree and child not in tree:
                tree.add(child)
                grew = True
    return tree


pids = process_tree(pid)
print("Prozesse von Jarvis:", sorted(pids))


def visit(hwnd, _):
    owner = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
    if owner.value in pids:
        length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        found.append((title.value, bool(user32.IsWindowVisible(hwnd))))
    return True


user32.EnumWindows(EnumProc(visit), 0)
print("Fenster von Jarvis:", [f for f in found if f[0]])
visible = any(title == "Jarvis" and shown for title, shown in found)
print("Jarvis-Fenster sichtbar:", visible)
sys.exit(0 if visible else 1)
