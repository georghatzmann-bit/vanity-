#!/usr/bin/env bash
# Builds dist/VeloxSetup.exe (one self-contained installer) on Linux/macOS with the .NET SDK (8+).
#
#   velox-tweaker/native/build.sh
#
# Steps: VELOX.exe (net472) -> payload.zip (app + VELOX.exe + WebView2 DLLs, fixed timestamps, sorted)
#        -> VeloxSetup.exe (net472, payload + setup-ui embedded) -> verify (manifests, resources, payload, size).
# Deterministic: the same sources give a byte-identical VeloxSetup.exe. Windows: native/Build.ps1.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
DIST="$APP/dist"
OBJ="$DIST/obj"
MAX_MB="${VELOX_MAX_MB:-3}"

export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1

if ! command -v dotnet >/dev/null 2>&1; then
  echo "FEHLER: dotnet (.NET SDK 8 oder neuer) wurde nicht gefunden. https://dotnet.microsoft.com/download" >&2
  exit 1
fi

step() { printf '\n== %s\n' "$*"; }
build() {   # quiet build; on failure the full log is shown
  local log="$OBJ/build-$1.log"; shift
  if ! dotnet build "$@" -c Release -nologo -v q -clp:ErrorsOnly >"$log" 2>&1; then
    cat "$log" >&2
    echo "FEHLER: Build fehlgeschlagen ($*)" >&2
    exit 1
  fi
}

rm -rf "$OBJ"
mkdir -p "$OBJ"
VERSION="$(tr -d ' \r\n' < "$APP/VERSION")"
echo "VELOX $VERSION"

step "VELOX.exe"
build host "$HERE/host/VeloxHost.csproj" -o "$OBJ/host"

step "Build-Werkzeug"
build tool "$HERE/buildtool/VeloxBuildTool.csproj" -o "$OBJ/buildtool"
TOOL=(dotnet "$OBJ/buildtool/VeloxBuildTool.dll")

step "payload.zip"
"${TOOL[@]}" pack --app "$APP" --host "$OBJ/host" --out "$OBJ/payload.zip"

step "VeloxSetup.exe"
build setup "$HERE/setup/VeloxSetup.csproj" -o "$OBJ/setup" "-p:VeloxPayload=$OBJ/payload.zip"
cp -f "$OBJ/setup/VeloxSetup.exe" "$DIST/VeloxSetup.exe"

step "Pruefen"
"${TOOL[@]}" verify --setup "$DIST/VeloxSetup.exe" --app "$APP" --max-mb "$MAX_MB"

SIZE=$(wc -c < "$DIST/VeloxSetup.exe" | tr -d ' ')
printf '\nFertig: %s  (%s Bytes, %s MB)\n' "$DIST/VeloxSetup.exe" "$SIZE" "$(awk "BEGIN { printf \"%.2f\", $SIZE / 1048576 }")"
