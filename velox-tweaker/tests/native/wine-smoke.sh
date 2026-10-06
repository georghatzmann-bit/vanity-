#!/usr/bin/env bash
# Wine smoke test for the native layer: runs the REAL VeloxSetup.exe / VELOX.exe / Uninstall.exe under
# Wine + wine-mono (a CLR, WinForms, registry, COM, shell links, job objects) on a headless X server.
# It is NOT part of the default suites (Run-Tests.ps1, run-ui-tests.mjs): it needs Wine and takes ~3 min.
#
#   velox-tweaker/tests/native/wine-smoke.sh [--build] [--keep]
#
#   --build   build VeloxSetup.exe from the working tree into the work folder first (dist/ stays untouched);
#             default: test dist/VeloxSetup.exe as it is
#   --keep    keep the Wine prefix of this run (default: it is deleted at the next run)
#
# Environment:
#   VELOX_WINE_WORK       work folder (default ${TMPDIR:-/tmp}/velox-wine-smoke): base prefix, run prefix,
#                         screenshots (shots/), logs (logs/)
#   VELOX_WINE_MONO_MSI   a local wine-mono-*-x86.msi (otherwise downloaded once from dl.winehq.org)
#
# What runs (WebView2 does not exist under Wine, so every UI step takes the "WebView2 missing" path):
#   a) VeloxSetup.exe /S          exit code, installed files == payload (byte compare), Uninstall registry
#                                 key, shortcuts, %TEMP%\VeloxSetup.log; a second /S = update
#   b) VeloxSetup.exe (UI)        no crash, the "WebView2 fehlt" dialog, the native FallbackForm, an update
#                                 through it (Enter) that starts VELOX.exe, Schließen
#   c) VELOX.exe --test           fake powershell.exe (tests/native/wine/FakePowerShell.cs) in 5 modes:
#                                 exits at once / VELOX_ERROR (umlauts, OEM code page) / VELOX_READY / bad URL /
#                                 PowerShell refuses the script (execution policy) -> plain German explanation
#   d) VELOX.exe                  real mode (Wine runs everything as admin: the UAC relaunch is not exercised)
#   e) Uninstall.exe /uninstall /S   files, shortcuts, registry key gone; data folder kept
#   f) /S /D=<folder with space and umlaut>  -> "\VELOX" appended, VELOX.exe --test starts there, uninstall
#   g) /S /D=C:\Neuer Ordner\VELOX unquoted (NSIS style) + silent uninstall of it
#
# Wine limitations (not bugs, see the notes in each check): no WebView2 runtime, no real powershell.exe,
# Wine's SxS/manifest parser is lax (it would NOT have caught the "--" manifest bug - buildtool verify does),
# every process is elevated.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"

BUILD=0; KEEP=0
for a in "$@"; do
  case "$a" in
    --build) BUILD=1 ;;
    --keep) KEEP=1 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

skip() { echo "SKIP wine-smoke: $*"; exit 0; }

# ------------------------------------------------------------------ re-exec on a private X server
if [ -z "${VELOX_WINE_INNER:-}" ]; then
  command -v wine >/dev/null 2>&1 || skip "wine is not installed (Ubuntu: apt-get install -y wine64)"
  command -v xvfb-run >/dev/null 2>&1 || skip "xvfb-run is not installed (apt-get install -y xvfb)"
  command -v dotnet >/dev/null 2>&1 || skip "dotnet SDK 8 is not installed (needed for the fake powershell.exe)"
  export VELOX_WINE_INNER=1
  exec xvfb-run -a -s "-screen 0 1600x1000x24" bash "$0" "$@"
fi

WORK="${VELOX_WINE_WORK:-${TMPDIR:-/tmp}/velox-wine-smoke}"
OUT="$WORK/out"
SHOTS="$OUT/shots"
LOGS="$OUT/logs"
mkdir -p "$WORK" "$SHOTS" "$LOGS"
rm -f "$SHOTS"/*.png "$LOGS"/*

export WINEDEBUG="${WINEDEBUG:--all}"
# Wine converts argv / paths with the Unix locale: without UTF-8 "Ü" in /D= arrives mangled
export LC_ALL=C.UTF-8 LANG=C.UTF-8
export WINEARCH=win64
# winemenubuilder would turn the installer's shortcuts into ~/.local/share/applications entries;
# mshtml would ask for wine-gecko
export WINEDLLOVERRIDES="winemenubuilder.exe=d;mshtml=d"

FAILS=0; PASSES=0
ok()   { PASSES=$((PASSES + 1)); echo "  ok    $*"; }
fail() { FAILS=$((FAILS + 1)); echo "  FAIL  $*"; }
check() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else fail "$what"; fi; }
step() { printf '\n== %s\n' "$*"; }
shot() { import -window root "$SHOTS/$1.png" 2>/dev/null && echo "  shot  $SHOTS/$1.png"; }
die()  { echo "FEHLER: $*" >&2; exit 1; }

# ------------------------------------------------------------------ the exe under test
SETUP="$APP/dist/VeloxSetup.exe"
if [ "$BUILD" = 1 ]; then
  step "build (copy of the working tree -> $WORK/src)"
  rm -rf "$WORK/src"; mkdir -p "$WORK/src"
  (cd "$APP" && tar --exclude=./dist --exclude='./native/*/obj' --exclude='./native/*/bin' --exclude=./node_modules -cf - .) | (cd "$WORK/src" && tar -xf -)
  bash "$WORK/src/native/build.sh" > "$LOGS/build.log" 2>&1 || { tail -30 "$LOGS/build.log"; die "build failed"; }
  SETUP="$WORK/src/dist/VeloxSetup.exe"
fi
[ -f "$SETUP" ] || die "$SETUP fehlt - erst native/build.sh laufen lassen (oder --build)"
echo "testing $SETUP ($(wc -c < "$SETUP") bytes)"
python3 -I "$HERE/wine/extract-payload.py" "$SETUP" "$WORK/payload.zip" || die "payload.zip not found in $SETUP"
rm -rf "$WORK/payload"; mkdir -p "$WORK/payload"; (cd "$WORK/payload" && unzip -q "$WORK/payload.zip")
VERSION="$(tr -d ' \r\n' < "$WORK/payload/VERSION")"

# ------------------------------------------------------------------ fake powershell.exe
step "fake powershell.exe"
FAKE="$WORK/fakeps/powershell.exe"
if [ ! -f "$FAKE" ] || [ "$HERE/wine/FakePowerShell.cs" -nt "$FAKE" ]; then
  rm -rf "$WORK/fakeps-src" "$WORK/fakeps"; mkdir -p "$WORK/fakeps-src"
  cp "$HERE/wine/FakePowerShell.cs" "$HERE/wine/FakePowerShell.csproj" "$WORK/fakeps-src/"
  DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 dotnet build "$WORK/fakeps-src/FakePowerShell.csproj" -c Release -nologo -v q \
    -o "$WORK/fakeps" > "$LOGS/fakeps-build.log" 2>&1 || { cat "$LOGS/fakeps-build.log"; die "fake powershell build failed"; }
fi
ok "built $FAKE"

# ------------------------------------------------------------------ Wine prefix with wine-mono (cached)
BASE="$WORK/base-prefix"
if [ ! -d "$BASE/drive_c/windows/mono" ]; then
  step "Wine prefix + wine-mono (once)"
  rm -rf "$BASE"
  WINEPREFIX="$BASE" wineboot -i > "$LOGS/wineboot.log" 2>&1; WINEPREFIX="$BASE" wineserver -w
  MSI="${VELOX_WINE_MONO_MSI:-}"
  if [ -z "$MSI" ]; then
    case "$(wine --version 2>/dev/null)" in
      wine-9.*) MONO=8.1.0 ;; wine-8.*) MONO=7.4.0 ;; *) MONO=9.3.0 ;;
    esac
    MSI="$WORK/wine-mono-$MONO-x86.msi"
    [ -f "$MSI" ] || curl -fsSL --retry 3 -o "$MSI.part" "https://dl.winehq.org/wine/wine-mono/$MONO/wine-mono-$MONO-x86.msi" && mv -f "$MSI.part" "$MSI" 2>/dev/null
    [ -f "$MSI" ] || die "wine-mono download failed (set VELOX_WINE_MONO_MSI)"
  fi
  WINEPREFIX="$BASE" wine msiexec /i "$MSI" /qn > "$LOGS/wine-mono.log" 2>&1; WINEPREFIX="$BASE" wineserver -w
  [ -d "$BASE/drive_c/windows/mono" ] || die "wine-mono did not install (see $LOGS/wine-mono.log)"
fi

export WINEPREFIX="$WORK/prefix"
wineserver -k 2>/dev/null; rm -rf "$WINEPREFIX"
cp -a "$BASE" "$WINEPREFIX"
C="$WINEPREFIX/drive_c"
U="$C/users/$(whoami)"
PSDIR="$C/windows/system32/WindowsPowerShell/v1.0"
mkdir -p "$PSDIR"
cp -f "$FAKE" "$PSDIR/powershell.exe"
[ -f "$WORK/fakeps/powershell.exe.config" ] && cp -f "$WORK/fakeps/powershell.exe.config" "$PSDIR/"
FAKELOG="$LOGS/fakeps-calls.log"
: > "$FAKELOG"
export VELOX_FAKE_PS_LOG="$(winepath -w "$FAKELOG" 2>/dev/null)"   # a Windows path (Z:\...) for the fake

WTEMP="$(wine cmd /c echo %TEMP% 2>/dev/null | tr -d '\r')"
SETUPLOG="$(winepath -u "$WTEMP" 2>/dev/null)/VeloxSetup.log"   # Wine 9: C:\users\<user>\Temp
HOSTLOG="$U/AppData/Local/Velox/logs/host.log"
INST="$C/Program Files/VELOX"
REGKEY='HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\VELOX'

cp "$SETUP" "$C/VeloxSetup.exe"

run() {   # run <name> <timeout s> <wine args...>: foreground, output -> logs/<name>.{out,err}, sets RC
  local name="$1" t="$2"; shift 2
  timeout "$t" wine "$@" > "$LOGS/$name.out" 2> "$LOGS/$name.err"; RC=$?
  echo "  ran   wine $* -> exit $RC"
}
bg() {    # bg <name> <wine args...>: background, sets BGPID
  local name="$1"; shift
  wine "$@" > "$LOGS/$name.out" 2> "$LOGS/$name.err" & BGPID=$!
}
killall_wine() { wineserver -k 2>/dev/null; sleep 1; wineserver -w 2>/dev/null; }
alive() { pgrep -f "$1" >/dev/null 2>&1; }
no_clr_crash() {   # no unhandled .NET exception and no Wine page fault in a run's stderr/stdout
  ! grep -a -q -E 'Unhandled Exception|Unhandled page fault|System\.[A-Za-z.]*Exception: ' "$LOGS/$1.err" "$LOGS/$1.out"
}
log_clean() {      # the app's own log: no unhandled/UI errors
  ! grep -a -q -E '\[error\] (Unbehandelter|UI-Fehler|Abbruch)' "$1"
}
reg_val() { wine reg query "$REGKEY" /v "$1" /reg:64 2>/dev/null | iconv -f CP850 -t UTF-8 | tr -d '\r' | awk -v n="$1" '$1==n { $1=""; $2=""; sub(/^  /, ""); print }'; }
window() { xdotool search --onlyvisible --name "$1" 2>/dev/null | head -1; }
wait_window() { local i; for i in $(seq 1 "$2"); do [ -n "$(window "$1")" ] && return 0; sleep 1; done; return 1; }
lnk() { find "$C" -iname "$1" -path "*$2*" 2>/dev/null | head -1; }

# ================================================================== a) silent install
step "a) VeloxSetup.exe /S"
run setup-silent 180 'C:\VeloxSetup.exe' /S
check "exit code 0 (was $RC)" test "$RC" = 0
check "no unhandled exception" no_clr_crash setup-silent
cp -f "$SETUPLOG" "$LOGS/VeloxSetup-a.log" 2>/dev/null
check "%TEMP%\\VeloxSetup.log written" test -s "$SETUPLOG"
check "setup log ends with 'Ende (Code 0)'" grep -a -q 'Ende (Code 0)' "$SETUPLOG"
check "setup checked the .NET Framework version ($(grep -a -o '\.NET Framework Release [^ ]*' "$SETUPLOG" | head -1))" grep -a -q '\.NET Framework Release' "$SETUPLOG"
check "setup log has no [error]" bash -c "! grep -a -q '\[error\]' '$SETUPLOG'"
check "installed to C:\\Program Files\\VELOX" test -f "$INST/VELOX.exe"
missing=0; differ=0
while IFS= read -r f; do
  [ -f "$WORK/payload/$f" ] || continue
  if [ ! -f "$INST/$f" ]; then missing=$((missing + 1)); echo "        missing: $f"
  elif ! cmp -s "$WORK/payload/$f" "$INST/$f"; then differ=$((differ + 1)); echo "        differs: $f"; fi
done < <(cd "$WORK/payload" && find . -type f | sed 's|^\./||' | sort)
check "every payload file installed byte-identical ($missing missing, $differ different)" test $((missing + differ)) = 0
extra="$(cd "$INST" && find . -type f | sed 's|^\./||' | sort | while IFS= read -r f; do [ -f "$WORK/payload/$f" ] || echo "$f"; done | tr '\n' ' ')"
check "only Uninstall.exe and .velox-files besides the payload (extra: $extra)" test "$extra" = "Uninstall.exe .velox-files " -o "$extra" = ".velox-files Uninstall.exe "
check "Uninstall.exe == VeloxSetup.exe" cmp -s "$SETUP" "$INST/Uninstall.exe"
check "registry DisplayName = VELOX" test "$(reg_val DisplayName)" = "VELOX"
check "registry DisplayVersion = $VERSION" test "$(reg_val DisplayVersion)" = "$VERSION"
check "registry UninstallString" test "$(reg_val UninstallString)" = '"C:\Program Files\VELOX\Uninstall.exe" /uninstall'
check "registry QuietUninstallString" test "$(reg_val QuietUninstallString)" = '"C:\Program Files\VELOX\Uninstall.exe" /uninstall /S'
check "registry InstallLocation" test "$(reg_val InstallLocation)" = 'C:\Program Files\VELOX'
check "registry DisplayIcon" test "$(reg_val DisplayIcon)" = 'C:\Program Files\VELOX\VELOX.exe,0'
wine reg query "$REGKEY" /reg:64 > "$LOGS/registry-a.txt" 2>&1
SM_LNK="$(lnk 'VELOX.lnk' 'Start Menu/Programs')"; SM_TEST="$(lnk 'VELOX Testmodus.lnk' 'Start Menu/Programs')"; DESK_LNK="$(lnk 'VELOX.lnk' 'Public/Desktop')"
if grep -a -q 'Verknüpfung nicht angelegt.*not implemented' "$SETUPLOG"; then
  # wine-mono implements no late-bound COM (Type.InvokeMember on a __ComObject throws NotImplementedException);
  # Wine's WScript.Shell itself works (cscript can create the same .lnk). .NET Framework 4.8 on Windows does this.
  echo "  skip  shortcuts: wine-mono has no IDispatch late binding (Wine limitation, not a VELOX bug)"
else
  check "Start menu VELOX.lnk ($SM_LNK)" test -n "$SM_LNK"
  check "Start menu VELOX Testmodus.lnk" test -n "$SM_TEST"
  check "Desktop VELOX.lnk ($DESK_LNK)" test -n "$DESK_LNK"
  if [ -n "$SM_TEST" ]; then
    check "Testmodus shortcut carries --test and points to VELOX.exe" bash -c "strings -a -el '$SM_TEST' | grep -q -- '--test' && strings -a -el '$SM_TEST' | grep -qi 'VELOX.exe'"
  fi
fi

step "a2) VeloxSetup.exe /S again (= update over the existing install)"
run setup-update 180 'C:\VeloxSetup.exe' /S
check "exit code 0 (was $RC)" test "$RC" = 0
check "both runs completed in the log" test "$(grep -a -c 'Installation abgeschlossen' "$SETUPLOG")" = 2
check "VELOX.exe still installed and identical" cmp -s "$WORK/payload/VELOX.exe" "$INST/VELOX.exe"
cp -f "$SETUPLOG" "$LOGS/VeloxSetup-a2.log" 2>/dev/null
killall_wine

# ================================================================== b) setup UI (WebView2 missing)
step "b) VeloxSetup.exe without /S (WebView2 missing -> dialog -> FallbackForm)"
rm -f "$SETUPLOG"
VELOX_FAKE_PS=ready bg setup-ui 'C:\VeloxSetup.exe'   # the VELOX.exe it starts at the end gets a backend that comes up
if wait_window 'Baustein|VELOX|Setup' 40; then ok "a window appeared"; else fail "no window within 40 s"; fi
sleep 3; shot b1-setup-webview2-missing
xdotool search --onlyvisible --name '.' getwindowname %@ 2>/dev/null | sed 's/^/        window: /' | head -8
check "setup still running (no crash)" kill -0 "$BGPID"
check "log says WebView2 is missing" grep -a -q 'WebView2 nicht verfügbar' "$SETUPLOG"
# "Ohne weiter" = the first button; Escape / closing the dialog takes the same branch
W="$(xdotool search --onlyvisible --name '.' 2>/dev/null | tail -1)"
[ -n "$W" ] && { xdotool windowactivate "$W" 2>/dev/null; xdotool key Escape 2>/dev/null; }
sleep 6; shot b2-setup-fallbackform
xdotool search --onlyvisible --name '.' getwindowname %@ 2>/dev/null | sed 's/^/        window: /' | head -8
check "setup still running after the dialog (FallbackForm)" kill -0 "$BGPID"
# Enter = "Aktualisieren" (all options on, incl. "VELOX nach der Installation starten")
rm -f "$HOSTLOG"
W="$(window 'VELOX Setup')"; [ -n "$W" ] && { xdotool windowactivate "$W" 2>/dev/null; xdotool key Return; }
sleep 20; shot b3-setup-fallbackform-done
check "update from the native form completed" grep -a -q 'Installation abgeschlossen' "$SETUPLOG"
check "setup started VELOX.exe afterwards" grep -a -q 'VELOX gestartet' "$SETUPLOG"
check "that VELOX.exe reached Main (host.log)" grep -a -q 'VELOX.exe .* startet' "$HOSTLOG"
W="$(window 'VELOX Setup')"; [ -n "$W" ] && { xdotool windowactivate "$W" 2>/dev/null; xdotool key Return; }
sleep 6
check "setup closed with exit 0 after 'Schließen'" bash -c "! kill -0 $BGPID 2>/dev/null && tail -1 '$SETUPLOG' | grep -q 'Ende (Code 0)'"
check "no unhandled exception" no_clr_crash setup-ui
check "setup log clean" log_clean "$SETUPLOG"
cp -f "$SETUPLOG" "$LOGS/VeloxSetup-b.log" 2>/dev/null
killall_wine

# ================================================================== c) VELOX.exe --test
host_case() {   # host_case <name> <fake mode> <args...>
  local name="$1" mode="$2"; shift 2
  rm -f "$HOSTLOG"
  VELOX_FAKE_PS="$mode" bg "$name" 'C:\Program Files\VELOX\VELOX.exe' "$@"
  sleep 12
  shot "$name"
  xdotool search --onlyvisible --name '.' getwindowname %@ 2>/dev/null | sed 's/^/        window: /' | head -6
}
step "c1) VELOX.exe --test, powershell exits at once (like Wine's own stub)"
host_case c1-host-test-exit0 exit0 --test
check "VELOX.exe still running (error screen, no crash)" kill -0 "$BGPID"
check "host.log written" test -s "$HOSTLOG"
check "host.log: Testmodus, WebView2 missing -> fallback" grep -a -q 'WebView2 nicht verfügbar' "$HOSTLOG"
check "host.log: backend started with -Simulate and -HostPid" grep -a -q -E 'Starte Backend: .*powershell\.exe" .*-File "C:\\Program Files\\VELOX\\Velox\.ps1" .*-HostPid [0-9]+ -Simulate' "$HOSTLOG"
check "error screen window visible" test -n "$(window 'VELOX')"
check "no unhandled exception" no_clr_crash c1-host-test-exit0
check "host.log clean" log_clean "$HOSTLOG"
cp -f "$HOSTLOG" "$LOGS/host-c1.log"; killall_wine

step "c2) VELOX.exe --test, backend reports VELOX_ERROR (umlauts in the OEM code page)"
host_case c2-host-test-error error --test
check "VELOX.exe still running (error screen)" kill -0 "$BGPID"
check "German error text decoded correctly (äöüß)" grep -a -q 'Größe übersteigt das Maß (Testtext äöüß)' "$HOSTLOG"
check "no unhandled exception" no_clr_crash c2-host-test-error
check "host.log clean" log_clean "$HOSTLOG"
cp -f "$HOSTLOG" "$LOGS/host-c2.log"; killall_wine

step "c3) VELOX.exe --test, backend VELOX_READY (fallback: start window hides, VELOX.exe stays as job owner)"
: > "$FAKELOG"
host_case c3-host-test-ready ready --test
check "VELOX.exe alive while the backend runs" kill -0 "$BGPID"
check "backend reported ready" grep -a -q 'VELOX_READY http://127.0.0.1:' "$HOSTLOG"
check "start window hidden after ready" test -z "$(window 'VELOX')"
check "fallback mode starts the backend WITHOUT -NoBrowser" bash -c "! grep -a -q -- '-NoBrowser' '$FAKELOG'"
check "no unhandled exception" no_clr_crash c3-host-test-ready
# second start: single instance -> the first one is activated, the second exits 0
run c3b-second-instance 30 'C:\Program Files\VELOX\VELOX.exe' --test
check "second VELOX.exe --test exits 0 (was $RC)" test "$RC" = 0
check "second start logged 'Läuft schon'" grep -a -q 'Läuft schon' "$HOSTLOG"
# the host goes away -> the backend (job object / HostPid watcher) must not outlive it
pkill -9 -f 'Program Files.VELOX.VELOX\.exe' 2>/dev/null; sleep 5
check "backend gone a few seconds after VELOX.exe was killed" bash -c "! pgrep -f 'v1.0.powershell\.exe' >/dev/null"
cp -f "$HOSTLOG" "$LOGS/host-c3.log"; killall_wine

step "c5) VELOX.exe --test, PowerShell refuses to run Velox.ps1 (execution policy by Group Policy)"
host_case c5-host-test-blocked blocked --test
check "VELOX.exe still running (error screen)" kill -0 "$BGPID"
check "plain German explanation instead of 'Code 1'" grep -a -q 'Windows erlaubt auf diesem PC keine PowerShell-Skripte' "$HOSTLOG"
check "no unhandled exception" no_clr_crash c5-host-test-blocked
cp -f "$HOSTLOG" "$LOGS/host-c5.log"; killall_wine

step "c4) VELOX.exe --test, backend prints a non-local VELOX_READY URL (must be refused)"
host_case c4-host-test-badurl badurl --test
check "no ready on https://example.com" bash -c "! grep -a -q 'Fenster bereit\|ready.*example' '$HOSTLOG'"
check "VELOX.exe still running (error screen)" kill -0 "$BGPID"
check "no unhandled exception" no_clr_crash c4-host-test-badurl
cp -f "$HOSTLOG" "$LOGS/host-c4.log"; killall_wine

# ================================================================== d) VELOX.exe real mode
step "d) VELOX.exe (real mode; under Wine every process is admin, so no UAC relaunch)"
: > "$FAKELOG"
host_case d1-host-real-ready ready
check "host.log: echter Modus, Admin: True" grep -a -q 'echter Modus, Admin: True' "$HOSTLOG"
check "real mode starts the backend without -Simulate" bash -c "grep -a -q 'Velox.ps1' '$FAKELOG' && ! grep -a -q -- '-Simulate' '$FAKELOG'"
check "VELOX.exe alive while the backend runs" kill -0 "$BGPID"
check "no unhandled exception" no_clr_crash d1-host-real-ready
check "host.log clean" log_clean "$HOSTLOG"
cp -f "$HOSTLOG" "$LOGS/host-d1.log"; killall_wine

host_case d2-host-real-exit0 exit0
check "error screen offers the Testmodus (VELOX.exe alive)" kill -0 "$BGPID"
check "no unhandled exception" no_clr_crash d2-host-real-exit0
cp -f "$HOSTLOG" "$LOGS/host-d2.log"; killall_wine

# ================================================================== e) silent uninstall
step "e) Uninstall.exe /uninstall /S"
rm -f "$SETUPLOG"
run uninstall-silent 120 'C:\Program Files\VELOX\Uninstall.exe' /uninstall /S
check "exit code 0 (was $RC)" test "$RC" = 0
check "no unhandled exception" no_clr_crash uninstall-silent
# the launcher exits as soon as its temp copy reports the result; the copy then deletes Uninstall.exe + folder
for i in $(seq 1 20); do [ -d "$INST" ] || break; sleep 0.5; done
left="$( [ -d "$INST" ] && (cd "$INST" && find . -type f | sed 's|^\./||' | tr '\n' ' '))"
check "install folder gone right away (left: ${left:-nothing})" test ! -d "$INST"
check "registry key gone" bash -c "! wine reg query '$REGKEY' /reg:64 >/dev/null 2>&1"
check "Start menu shortcuts gone" test -z "$(lnk 'VELOX*.lnk' 'Start Menu/Programs')"
check "Desktop shortcut gone" test -z "$(lnk 'VELOX.lnk' 'Public/Desktop')"
check "data folder kept (settings, backups, logs)" test -d "$U/AppData/Local/Velox"
check "uninstall (temp copy) logged 'Ende (Code 0)'" grep -a -q 'Ende (Code 0)' "$SETUPLOG"
check "the last log line (the launcher) also says 'Ende (Code 0)' (was: $(tail -1 "$SETUPLOG" | cut -c25-))" bash -c "tail -1 '$SETUPLOG' | grep -q 'Ende (Code 0)'"
check "uninstall log clean" bash -c "! grep -a -q '\[error\]' '$SETUPLOG'"
cp -f "$SETUPLOG" "$LOGS/VeloxSetup-e.log" 2>/dev/null
killall_wine
# what is still locked (with /S the launching Uninstall.exe waits for its temp copy, so its own image is
# in use) is registered with MoveFileEx(DELAY_UNTIL_REBOOT); "wineboot -r" plays the restart
wineboot -r >/dev/null 2>&1; wineserver -w
left="$( [ -d "$INST" ] && (cd "$INST" && find . | sed 's|^\./||' | tr '\n' ' '))"
check "after a restart nothing is left of C:\\Program Files\\VELOX (left: ${left:-nothing})" test ! -d "$INST"

# ================================================================== f) other folder
step "f) /S /D=C:\\Mein Ordner Ü (space + umlaut; folder not named VELOX -> \\VELOX appended)"
rm -f "$SETUPLOG"
run setup-customdir 180 'C:\VeloxSetup.exe' /S '/D=C:\Mein Ordner Ü' /nodesktop /nostartmenu
CUST="$C/Mein Ordner Ü/VELOX"
check "exit code 0 (was $RC)" test "$RC" = 0
check "installed to C:\\Mein Ordner Ü\\VELOX" test -f "$CUST/VELOX.exe"
check "no desktop shortcut with /nodesktop" test -z "$(lnk 'VELOX.lnk' 'Public/Desktop')"
check "no Start menu shortcut with /nostartmenu" test -z "$(lnk 'VELOX*.lnk' 'Start Menu/Programs')"
check "InstallLocation" test "$(reg_val InstallLocation)" = 'C:\Mein Ordner Ü\VELOX'
cp -f "$SETUPLOG" "$LOGS/VeloxSetup-f.log" 2>/dev/null
rm -f "$HOSTLOG"; : > "$FAKELOG"
VELOX_FAKE_PS=ready bg f2-host-customdir 'C:\Mein Ordner Ü\VELOX\VELOX.exe' --test
sleep 12; shot f2-host-customdir
check "backend got the quoted path with space + umlaut" grep -a -q -F -- '-File "C:\Mein Ordner Ü\VELOX\Velox.ps1"' "$FAKELOG"
check "backend reported ready" grep -a -q 'VELOX_READY http://127.0.0.1:' "$HOSTLOG"
check "no unhandled exception" no_clr_crash f2-host-customdir
killall_wine
# uninstall through the UI this time (no /S: the launcher exits at once, the temp copy shows the native form)
rm -f "$SETUPLOG"
run uninstall-customdir-ui 30 'C:\Mein Ordner Ü\VELOX\Uninstall.exe' /uninstall
check "launcher exit 0 (was $RC)" test "$RC" = 0
wait_window '.' 30; sleep 3
W="$(xdotool search --onlyvisible --name '.' 2>/dev/null | tail -1)"; [ -n "$W" ] && { xdotool windowactivate "$W" 2>/dev/null; xdotool key Escape; }
sleep 6; shot f3-uninstall-fallbackform
W="$(window 'VELOX')"; [ -n "$W" ] && { xdotool windowactivate "$W" 2>/dev/null; xdotool key Return; }
sleep 12; shot f4-uninstall-done
check "uninstall through the form completed" grep -a -q 'Deinstallation abgeschlossen' "$SETUPLOG"
check "folder gone right away" test ! -d "$CUST"
check "registry key gone" bash -c "! wine reg query '$REGKEY' /reg:64 >/dev/null 2>&1"
W="$(window 'VELOX')"; [ -n "$W" ] && { xdotool windowactivate "$W" 2>/dev/null; xdotool key Return; }
sleep 5
check "no unhandled exception" no_clr_crash uninstall-customdir-ui
check "uninstall log clean" log_clean "$SETUPLOG"
cp -f "$SETUPLOG" "$LOGS/VeloxSetup-f.log" 2>/dev/null
killall_wine

# ================================================================== g) NSIS-style /D=
step "g) /S /D=C:\\Neuer Ordner\\VELOX unquoted, as NSIS installers take it (path with a space, last argument)"
rm -f "$SETUPLOG"
# two argv entries -> Wine builds the command line '... /D=C:\Neuer Ordner\VELOX' without quotes
run setup-nsisdir 180 'C:\VeloxSetup.exe' /S /nodesktop /nostartmenu '/D=C:\Neuer' 'Ordner\VELOX'
NSIS="$C/Neuer Ordner/VELOX"
check "exit code 0 (was $RC)" test "$RC" = 0
check "installed to C:\\Neuer Ordner\\VELOX (not C:\\Neuer\\VELOX)" test -f "$NSIS/VELOX.exe"
check "nothing in C:\\Neuer" test ! -d "$C/Neuer"
check "InstallLocation" test "$(reg_val InstallLocation)" = 'C:\Neuer Ordner\VELOX'
cp -f "$SETUPLOG" "$LOGS/VeloxSetup-g.log" 2>/dev/null
killall_wine
rm -f "$SETUPLOG"
run uninstall-nsisdir 120 'C:\Neuer Ordner\VELOX\Uninstall.exe' /uninstall /S
check "silent uninstall exit 0 (was $RC)" test "$RC" = 0
for i in $(seq 1 20); do [ -d "$NSIS" ] || break; sleep 0.5; done
check "folder gone right away" test ! -d "$NSIS"
check "registry key gone" bash -c "! wine reg query '$REGKEY' /reg:64 >/dev/null 2>&1"
check "every 'Ende' line says Code 0" bash -c "! grep -a 'Ende (Code' '$SETUPLOG' | grep -v -q 'Code 0'"
cp -f "$SETUPLOG" "$LOGS/VeloxSetup-g2.log" 2>/dev/null
killall_wine

# ------------------------------------------------------------------ summary
step "summary"
echo "  screenshots: $SHOTS"
echo "  logs:        $LOGS"
[ "$KEEP" = 1 ] && echo "  prefix kept: $WINEPREFIX" || { wineserver -k 2>/dev/null; rm -rf "$WINEPREFIX"; }
echo "  $PASSES passed, $FAILS failed"
[ "$FAILS" = 0 ]
