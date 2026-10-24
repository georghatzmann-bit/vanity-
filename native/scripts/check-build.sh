#!/usr/bin/env bash
# Probe-Kompilieren der Spiel-DLLs unter Linux mit clang-cl und den MSVC-Headern aus /opt/xwin.
# Das ist nur eine Syntax-/Typ-Prüfung ohne echten Build – der richtige Build läuft mit
# Visual Studio (MSBuild) auf Windows. clang ist strenger als MSVC; echte MSVC-Eigenheiten
# werden hier mit Flags abgefedert, nicht durch Codeänderungen.
#
# Nutzung:  native/scripts/check-build.sh <minhook|redirect|server|client|all>
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # native/
CLANGCL="/usr/lib/llvm-18/bin/clang-cl"
XWIN="/opt/xwin"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

if [ ! -x "$CLANGCL" ] || [ ! -d "$XWIN" ]; then
  echo "clang-cl oder /opt/xwin fehlt – Prüfung wird übersprungen (im CI baut MSVC)."
  exit 0
fi

INC="-imsvc $XWIN/crt/include -imsvc $XWIN/sdk/include/ucrt -imsvc $XWIN/sdk/include/um -imsvc $XWIN/sdk/include/shared -imsvc $XWIN/sdk/include/winrt"
# gemeinsame Flags: C++ neuste, Ausnahmen, statische Laufzeit, MSVC-Kompatibilität, nur prüfen
COMMON="--target=x86_64-pc-windows-msvc /std:c++latest /EHsc /MT -fms-compatibility -fms-extensions -fms-compatibility-version=19.40 -Wno-everything -D_ALLOW_COMPILER_AND_STL_VERSION_MISMATCH -DUNICODE -D_UNICODE -D_WINDOWS -D_USRDLL -DNDEBUG -DWIN32_LEAN_AND_MEAN $INC"

check_one() {
  local name="$1"; shift
  local dir="$1"; shift
  local extra_inc="$1"; shift
  local files=("$@")
  echo "== $name"
  local fail=0
  # Windows findet Header unabhaengig von Gross-/Kleinschreibung; unter Linux legen wir
  # dafuer Kleinschreib-Verweise in einem Hilfsordner an.
  local ci="$OUT/ci-$name"; mkdir -p "$ci"
  while IFS= read -r h; do
    local base; base="$(basename "$h")"; local low="${base,,}"
    [ "$base" != "$low" ] && [ ! -e "$ci/$low" ] && ln -sf "$h" "$ci/$low"
  done < <(find "$dir" -maxdepth 3 -name '*.h' 2>/dev/null)
  extra_inc="-I $ci $extra_inc"
  for f in "${files[@]}"; do
    if [ ! -f "$dir/$f" ]; then
      echo "   FEHLT: $f"; fail=1; continue
    fi
    if $CLANGCL $COMMON $extra_inc /I "$dir" -c "$dir/$f" /Fo"$OUT/x.obj" 2> "$OUT/err.txt"; then
      echo "   ok   $f"
    else
      echo "   FEHLER $f:"; sed 's/^/      /' "$OUT/err.txt" | head -15; fail=1
    fi
  done
  return $fail
}

run_minhook() {
  # C-Dateien, kein C++
  local d="$HERE/third_party/minhook"
  echo "== minhook"
  for f in src/buffer.c src/hook.c src/trampoline.c src/hde/hde32.c src/hde/hde64.c; do
    if $CLANGCL --target=x86_64-pc-windows-msvc /MT -Wno-everything -D_ALLOW_COMPILER_AND_STL_VERSION_MISMATCH $INC -I "$d/include" -c "$d/$f" /Fo"$OUT/x.obj" 2>"$OUT/err.txt"; then
      echo "   ok   $f"
    else
      echo "   FEHLER $f:"; sed 's/^/      /' "$OUT/err.txt" | head -15; return 1
    fi
  done
}

run_redirect() {
  check_one redirect "$HERE/redirect" "" pch.cpp Patchfinder.cpp Redirection.cpp Unreal.cpp Hooks.cpp dllmain.cpp
}

run_server() {
  local d="$HERE/server"
  local inc="-I $d -I $HERE -I $HERE/third_party/minhook/include"
  # alle .cpp unter server/, ohne Tests
  mapfile -t files < <(cd "$d" && find . -name '*.cpp' -not -path './Tests/*' | sed 's|^\./||')
  check_one server "$d" "$inc" "${files[@]}"
}

run_client() {
  local d="$HERE/client"
  # Includes laufen relativ ("../Public/…") und ueber den Projektordner (pch.h, SDK/…).
  local inc="-I $d -I $HERE/third_party/minhook/include"
  mapfile -t files < <(cd "$d" && find . -name '*.cpp' | sed 's|^\./||')
  check_one client "$d" "$inc" "${files[@]}"
}

case "${1:-all}" in
  minhook) run_minhook ;;
  redirect) run_redirect ;;
  server) run_server ;;
  client) run_client ;;
  all) run_minhook; run_redirect; run_server; run_client ;;
  *) echo "Unbekannt: $1 (minhook|redirect|server|client|all)"; exit 2 ;;
esac
