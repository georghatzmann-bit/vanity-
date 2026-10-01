"""Den Bildschirm schnell lesen und Fenster ohne Maus bedienen.

- capture(): Bildschirmfoto (oder nur das vordere Fenster) als kleines JPEG: Claude liest
  es in einem Bruchteil der Zeit eines großen PNG.
- read_text(): Texterkennung direkt auf dem PC (Windows-OCR), in ein bis zwei Sekunden,
  mit Position jeder Zeile. Ohne Claude, ohne Internet.
- windows(), elements(), click(), type_into(): Fenster und ihre Knöpfe und Felder über die
  Windows-Bedienungshilfen (UI Automation). Ein Knopf wird "gedrückt", ohne dass sich die Maus
  bewegt, ein Feld bekommt seinen Text, ohne Tastatur. So stört Jarvis Georg nicht beim Zocken.

Alle Windows-Teile laufen über Windows PowerShell 5.1 (ist auf jedem Windows 10/11 dabei),
die Eingaben gehen über Umgebungsvariablen hinein, nie in den Skripttext.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
from pathlib import Path

log = logging.getLogger(__name__)

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class ScreenError(RuntimeError):
    """Etwas ging nicht. Der Text ist für Georg (bzw. das Gehirn) gedacht."""


def _powershell(script: str, env: dict | None = None, timeout: float = 30) -> str:
    if os.name != "nt":
        raise ScreenError("Das geht nur unter Windows.")
    full_env = dict(os.environ)
    # Startet Jarvis aus PowerShell 7, erbt Windows PowerShell sonst dessen Module.
    full_env.pop("PSModulePath", None)
    full_env.update(env or {})
    head = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$ErrorActionPreference = 'Stop'\n"
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", head + script],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
            env=full_env, creationflags=NO_WINDOW,
        )
    except subprocess.TimeoutExpired as exc:
        raise ScreenError("Windows hat zu lange gebraucht.") from exc
    if result.returncode != 0:
        raise ScreenError((result.stderr or result.stdout or "Fehler").strip().splitlines()[-1][:300])
    return result.stdout


# ---------------------------------------------------------------------- Bildschirmfoto


def foreground_rect() -> tuple[int, int, int, int] | None:
    """Rechteck des vorderen Fensters (links, oben, rechts, unten), sonst None."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        rect = wintypes.RECT()
        if not hwnd or not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return None
        if rect.right - rect.left < 50 or rect.bottom - rect.top < 50:
            return None
        return rect.left, rect.top, rect.right, rect.bottom
    except Exception:
        return None


def capture(path: Path | None = None, window: bool = False, max_side: int = 1600, quality: int = 72) -> Path:
    """Bildschirmfoto als JPEG (klein und schnell zu lesen). window=True: nur das vordere Fenster."""
    from PIL import ImageGrab

    path = Path(path or Path(tempfile.gettempdir()) / "jarvis-bildschirm.jpg")
    path.parent.mkdir(parents=True, exist_ok=True)
    box = foreground_rect() if window else None
    image = ImageGrab.grab(bbox=box, all_screens=box is None)
    image.thumbnail((max_side, max_side))
    image.convert("RGB").save(path, "JPEG", quality=quality, optimize=True)
    return path


# ---------------------------------------------------------------------- Texterkennung (Windows-OCR)

OCR_SCRIPT = r"""
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:JARVIS_OCR_FILE)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US'))
}
if ($null -eq $engine) { throw 'Keine Texterkennung fuer diese Sprache installiert.' }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = foreach ($line in $result.Lines) {
  $words = @($line.Words)
  if ($words.Count -eq 0) { continue }
  $x = ($words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
  $y = ($words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
  $r = ($words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
  $b = ($words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
  [pscustomobject]@{ t = $line.Text; x = [int]$x; y = [int]$y; w = [int]($r - $x); h = [int]($b - $y) }
}
$stream.Dispose()
ConvertTo-Json -InputObject @($lines) -Compress
"""


def read_text(window: bool = False, image: Path | None = None) -> list[dict]:
    """Texterkennung auf dem PC: [{"t": Text, "x", "y", "w", "h"}] in Bildschirmpunkten (bei
    window=True innerhalb des Fensters). Dauert ein bis zwei Sekunden."""
    from PIL import ImageGrab

    temp = None
    if image is None:
        box = foreground_rect() if window else None
        shot = ImageGrab.grab(bbox=box, all_screens=box is None)
        if max(shot.size) > 4000:  # die Erkennung nimmt höchstens 10000 Punkte, Text bleibt so lesbar
            shot.thumbnail((4000, 4000))
        temp = Path(tempfile.gettempdir()) / f"jarvis-ocr-{os.getpid()}.png"
        shot.save(temp)
        image = temp
    try:
        raw = _powershell(OCR_SCRIPT, {"JARVIS_OCR_FILE": str(Path(image).resolve())}, timeout=40).strip()
    finally:
        if temp is not None:
            try:
                temp.unlink()
            except OSError:
                pass
    try:
        lines = json.loads(raw) if raw else []
    except ValueError as exc:
        raise ScreenError(f"Die Texterkennung lieferte nichts Lesbares: {raw[:200]}") from exc
    if isinstance(lines, dict):
        lines = [lines]
    return [line for line in lines if isinstance(line, dict) and str(line.get("t") or "").strip()]


def as_text(lines: list[dict], positions: bool = True) -> str:
    """Die erkannten Zeilen von oben nach unten, auf Wunsch mit Position."""
    ordered = sorted(lines, key=lambda l: (int(l.get("y", 0)) // 12, int(l.get("x", 0))))
    if not positions:
        return "\n".join(str(l["t"]) for l in ordered)
    return "\n".join(f"[{l.get('x', 0)},{l.get('y', 0)}] {l['t']}" for l in ordered)


# ---------------------------------------------------------------------- Fenster ohne Maus (UI Automation)

UIA_HEAD = r"""
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$True_ = [System.Windows.Automation.Condition]::TrueCondition
function Find-Window($title) {
  $wins = $A::RootElement.FindAll($Scope::Children, $True_)
  $exact = $wins | Where-Object { $_.Current.Name -eq $title } | Select-Object -First 1
  if ($exact) { return $exact }
  $hit = $wins | Where-Object { $_.Current.Name -like "*$title*" } | Select-Object -First 1
  if ($hit) { return $hit }
  foreach ($w in $wins) {
    try { $p = Get-Process -Id $w.Current.ProcessId -ErrorAction Stop; if ($p.ProcessName -like "*$title*") { return $w } } catch {}
  }
  throw "Kein Fenster gefunden: $title"
}
function Walk($root, $limit) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@($root, 0))
  $found = New-Object System.Collections.ArrayList
  while ($queue.Count -gt 0 -and $found.Count -lt $limit) {
    $item = $queue.Dequeue(); $node = $item[0]; $depth = $item[1]
    if ($depth -gt 0) { [void]$found.Add($node) }
    if ($depth -ge 14) { continue }
    $child = $walker.GetFirstChild($node)
    while ($child -ne $null) { $queue.Enqueue(@($child, $depth + 1)); $child = $walker.GetNextSibling($child) }
  }
  return $found
}
"""

WINDOWS_SCRIPT = UIA_HEAD + r"""
$rows = foreach ($w in $A::RootElement.FindAll($Scope::Children, $True_)) {
  $name = $w.Current.Name
  if (-not $name) { continue }
  $proc = ''
  try { $proc = (Get-Process -Id $w.Current.ProcessId -ErrorAction Stop).ProcessName } catch {}
  [pscustomobject]@{ titel = $name; programm = $proc }
}
ConvertTo-Json -InputObject @($rows) -Compress
"""

ELEMENTS_SCRIPT = UIA_HEAD + r"""
$win = Find-Window $env:JARVIS_UI_WINDOW
$rows = foreach ($e in (Walk $win ([int]$env:JARVIS_UI_LIMIT))) {
  $c = $e.Current
  $name = $c.Name
  $type = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  if (-not $name -and $type -notin @('Edit', 'Document', 'ComboBox')) { continue }
  [pscustomobject]@{ art = $type; name = $name; an = $c.IsEnabled }
}
ConvertTo-Json -InputObject @($rows) -Compress
"""

CLICK_SCRIPT = UIA_HEAD + r"""
$win = Find-Window $env:JARVIS_UI_WINDOW
$want = $env:JARVIS_UI_NAME
$all = Walk $win 2500
$target = $all | Where-Object { $_.Current.Name -eq $want -and $_.Current.IsEnabled } | Select-Object -First 1
if (-not $target) { $target = $all | Where-Object { $_.Current.Name -like "*$want*" -and $_.Current.IsEnabled } | Select-Object -First 1 }
if (-not $target) { throw "Kein Element gefunden: $want" }
$done = $false
foreach ($pattern in @(
    [System.Windows.Automation.InvokePattern]::Pattern,
    [System.Windows.Automation.TogglePattern]::Pattern,
    [System.Windows.Automation.SelectionItemPattern]::Pattern,
    [System.Windows.Automation.ExpandCollapsePattern]::Pattern)) {
  $p = $null
  if ($target.TryGetCurrentPattern($pattern, [ref]$p)) {
    switch ($pattern.ProgrammaticName) {
      'InvokePatternIdentifiers.Pattern' { $p.Invoke() }
      'TogglePatternIdentifiers.Pattern' { $p.Toggle() }
      'SelectionItemPatternIdentifiers.Pattern' { $p.Select() }
      'ExpandCollapsePatternIdentifiers.Pattern' { $p.Expand() }
    }
    $done = $true
    break
  }
}
if (-not $done) { throw "Das Element kann man nicht ohne Maus bedienen: $want" }
"OK " + $target.Current.Name
"""

TYPE_SCRIPT = UIA_HEAD + r"""
$win = Find-Window $env:JARVIS_UI_WINDOW
$want = $env:JARVIS_UI_NAME
$all = Walk $win 2500
function Pick($items) {
  if ($want) { $items | Where-Object { $_.Current.Name -like "*$want*" } | Select-Object -First 1 }
  else { $items | Select-Object -First 1 }
}
$target = Pick @($all | Where-Object {
  $p = $null; $_.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p) -and -not $p.Current.IsReadOnly })
if ($target) {
  $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($env:JARVIS_UI_TEXT)
} else {
  # Mehrzeilige Felder (Editor, WordPad) haben kein ValuePattern, sie bekommen den Text als Fensternachricht
  $target = Pick @($all | Where-Object { $_.Current.NativeWindowHandle -ne 0 -and $_.Current.ClassName -match '^(Edit|RichEdit)' })
  if (-not $target) { throw "Kein Eingabefeld gefunden: $want" }
  Add-Type -Namespace JarvisUi -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr hWnd, int msg, IntPtr wParam, string lParam);'
  $hwnd = [IntPtr]$target.Current.NativeWindowHandle
  if ([JarvisUi.Native]::SendMessageW($hwnd, 0x000C, [IntPtr]::Zero, $env:JARVIS_UI_TEXT) -eq [IntPtr]::Zero) {
    throw "Das Feld nimmt keinen Text an: $want"
  }
  [void][JarvisUi.Native]::SendMessageW($hwnd, 0x00B9, [IntPtr]1, $null)
}
"OK " + $target.Current.Name
"""


def _json_rows(raw: str) -> list[dict]:
    raw = raw.strip()
    if not raw:
        return []
    data = json.loads(raw)
    return [data] if isinstance(data, dict) else [row for row in data if isinstance(row, dict)]


def windows() -> list[dict]:
    """Alle offenen Fenster: [{"titel", "programm"}]."""
    return _json_rows(_powershell(WINDOWS_SCRIPT))


def elements(window: str, limit: int = 250) -> list[dict]:
    """Knöpfe, Felder, Menüs eines Fensters: [{"art", "name", "an"}]."""
    return _json_rows(_powershell(ELEMENTS_SCRIPT, {"JARVIS_UI_WINDOW": window, "JARVIS_UI_LIMIT": str(int(limit))}))


def click(window: str, name: str) -> str:
    """Drückt einen Knopf (oder hakt an, wählt aus, klappt auf), ohne die Maus zu bewegen."""
    return _powershell(CLICK_SCRIPT, {"JARVIS_UI_WINDOW": window, "JARVIS_UI_NAME": name}).strip().splitlines()[-1]


def type_into(window: str, field: str, text: str) -> str:
    """Schreibt Text in ein Feld, ohne Tastatur (das Feld bekommt den ganzen Text)."""
    return _powershell(TYPE_SCRIPT, {"JARVIS_UI_WINDOW": window, "JARVIS_UI_NAME": field,
                                     "JARVIS_UI_TEXT": text}).strip().splitlines()[-1]
