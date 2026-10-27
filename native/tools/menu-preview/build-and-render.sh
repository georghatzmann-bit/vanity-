#!/usr/bin/env bash
# Builds the Rift menu preview (the real F9 menu without the game) and renders every tab as PNG.
# Needs: clang-cl + lld-link (LLVM 18), MSVC/SDK headers + libs in /opt/xwin (xwin), Wine, Python with PIL.
# Usage: native/tools/menu-preview/build-and-render.sh <output folder>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
OUT="$(realpath -m "${1:-$HERE/out}")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
X=/opt/xwin; CL=/usr/lib/llvm-18/bin/clang-cl; LINK=/usr/lib/llvm-18/bin/lld-link
mkdir -p "$OUT"

# 1) Copy of the menu code; one header gets an access relaxation that only clang needs (MSVC doesn't).
cp -r "${CLIENT_SRC:-$ROOT/native/client}" "$WORK/client"
python3 - "$WORK/client/SDK/Containers.h" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text(encoding="utf-8", errors="surrogateescape")
old = "\t\tprivate:\n\t\t\tSetType Value;"
assert s.count(old) == 1, "Containers.h has changed"
p.write_text(s.replace(old, "\t\tpublic:\n\t\t\tSetType Value;"), encoding="utf-8", errors="surrogateescape")
PY
cat "$HERE/gui_preview_hooks.inc" >> "$WORK/client/ATLAS/Private/GUI.cpp"
mkdir -p "$WORK/ci" "$WORK/stubpch" "$WORK/libcase"
printf '#pragma once\n#include <cstddef>\n' > "$WORK/stubpch/pch.h"
ln -sf "$X/sdk/lib/um/x86_64/dbghelp.lib" "$WORK/libcase/Dbghelp.lib"
while IFS= read -r h; do b=$(basename "$h"); l=${b,,}; [ "$b" != "$l" ] && [ ! -e "$WORK/ci/$l" ] && ln -sf "$h" "$WORK/ci/$l"; done < <(find "$WORK/client" -maxdepth 3 -name '*.h')

INC="-imsvc $X/crt/include -imsvc $X/sdk/include/ucrt -imsvc $X/sdk/include/um -imsvc $X/sdk/include/shared -imsvc $X/sdk/include/winrt"
FL="--target=x86_64-pc-windows-msvc /std:c++latest /EHsc /MT /O2 -fms-compatibility -fms-extensions -fms-compatibility-version=19.40 -fdelayed-template-parsing -Wno-everything -D_ALLOW_COMPILER_AND_STL_VERSION_MISMATCH -DUNICODE -D_UNICODE -DNDEBUG -D_DISABLE_CONSTEXPR_MUTEX_CONSTRUCTOR $INC"
C="$WORK/client"
cd "$WORK"
echo "Compiling the real menu (GUI.cpp) ..."
$CL $FL -I ci -I "$C" -c "$C/ATLAS/Private/GUI.cpp" /Fogui.obj
# The Trickshot tab (its own file) is only included when it exists.
TS=0; EXTRA=""
if [ -f "$C/ATLAS/Private/NiobiumTrickshotTab.cpp" ]; then
  TS=1; EXTRA="tab.obj"
  $CL $FL /utf-8 -I stubpch -I "$C/ATLAS/ImGui" -I "$C" -I "$C/third_party" -c "$C/ATLAS/Private/NiobiumTrickshotTab.cpp" /Fotab.obj
fi
$CL $FL -I stubpch -I "$C/ATLAS/ImGui" -I "$C" -I "$HERE" -DNIOBIUM_PREVIEW_TRICKSHOT=$TS -c "$HERE/preview_main.cpp" /Fomain.obj
$CL $FL -I stubpch -I "$C/ATLAS/ImGui" -c "$HERE/softraster.cpp" /Foraster.obj
for f in imgui imgui_draw imgui_widgets imgui_tables imgui_stdlib; do
  $CL $FL -I stubpch -I "$C/ATLAS/ImGui" -c "$C/ATLAS/ImGui/$f.cpp" /Fo$f.obj
done
$LINK /nologo /out:menu-preview.exe /subsystem:console gui.obj $EXTRA main.obj raster.obj \
  imgui.obj imgui_draw.obj imgui_widgets.obj imgui_tables.obj imgui_stdlib.obj \
  /libpath:libcase /libpath:$X/crt/lib/x86_64 /libpath:$X/sdk/lib/um/x86_64 /libpath:$X/sdk/lib/ucrt/x86_64 \
  user32.lib shell32.lib ole32.lib gdi32.lib

# 2) Background (only suggested, no game image) and the parkour file (PARKOURS_JSON = another file)
python3 "$HERE/make_background.py" "$WORK/background.rgba" 1600 900
cp "${PARKOURS_JSON:-$ROOT/launcher/src/data/parkours.json}" "$WORK/parkours.json"

# 3) Render under Wine
export WINEDEBUG=-all WINEPREFIX="${WINEPREFIX:-$HOME/.wine-rift-preview}"
wine menu-preview.exe background.rgba . 2>&1 | grep -v "^wine:" || true

# 4) PPM -> PNG
python3 - "$WORK" "$OUT" <<'PY'
import sys, pathlib
from PIL import Image
src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
for p in sorted(src.glob("*.ppm")):
    Image.open(p).save(dst / (p.stem + ".png"), optimize=True)
    print("PNG:", dst / (p.stem + ".png"))
PY
