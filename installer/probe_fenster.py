"""Probe: Hat der laufende Jarvis (PID als Argument, samt Kindprozessen) ein sichtbares Fenster
mit dem Titel "Jarvis", und passt es ganz auf den Bildschirm (über der Taskleiste)?"""

import ctypes
import sys
from ctypes import wintypes

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
dwmapi = ctypes.windll.dwmapi
EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

try:
    # Echte Pixel sehen, egal wie Jarvis selbst rechnet.
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    pass


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]


user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
user32.MonitorFromWindow.restype = wintypes.HMONITOR
user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(MONITORINFO)]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
dwmapi.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]


def frame(hwnd) -> wintypes.RECT:
    """Das sichtbare Fenster, ohne die unsichtbaren Ränder, die Windows 10/11 um jedes Fenster legt."""
    rect = wintypes.RECT()
    if dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect)) != 0:  # DWMWA_EXTENDED_FRAME_BOUNDS
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return rect


def work_area(hwnd) -> wintypes.RECT:
    """Der freie Bereich des Bildschirms, auf dem das Fenster steht (ohne Taskleiste)."""
    info = MONITORINFO()
    info.cbSize = ctypes.sizeof(info)
    user32.GetMonitorInfoW(user32.MonitorFromWindow(hwnd, 2), ctypes.byref(info))  # MONITOR_DEFAULTTONEAREST
    return info.rcWork


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


pids = process_tree(int(sys.argv[1]))
print("Prozesse von Jarvis:", sorted(pids))
found = []


def visit(hwnd, _):
    owner = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
    if owner.value in pids:
        length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        found.append((hwnd, title.value, bool(user32.IsWindowVisible(hwnd))))
    return True


user32.EnumWindows(EnumProc(visit), 0)
print("Fenster von Jarvis:", [(title, shown) for _, title, shown in found if title])
shown = [hwnd for hwnd, title, visible in found if title == "Jarvis" and visible]
print("Jarvis-Fenster sichtbar:", bool(shown))
fits = bool(shown)
for hwnd in shown:
    r, w = frame(hwnd), work_area(hwnd)
    inside = r.left >= w.left - 2 and r.top >= w.top - 2 and r.right <= w.right + 2 and r.bottom <= w.bottom + 2
    print(
        f"Fenster {r.left},{r.top} bis {r.right},{r.bottom}, frei ist {w.left},{w.top} bis {w.right},{w.bottom}:",
        "passt" if inside else "ragt über den Rand",
    )
    fits = fits and inside
sys.exit(0 if fits else 1)
