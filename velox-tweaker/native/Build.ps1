<#
.SYNOPSIS
    Builds dist\VeloxSetup.exe (one self-contained installer) on Windows with the .NET SDK (8 or newer).
.DESCRIPTION
    Same steps as native/build.sh: VELOX.exe (net472) -> payload.zip (app + VELOX.exe + WebView2 DLLs)
    -> VeloxSetup.exe (net472, payload + setup-ui embedded) -> verify (manifests, resources, payload, size).
    Runs on Windows PowerShell 5.1 and PowerShell 7. Deterministic: same sources, byte-identical exe.
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File velox-tweaker\native\Build.ps1
#>
[CmdletBinding()]
param(
    [double]$MaxMB = 3
)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Split-Path -Parent $here
$dist = Join-Path $app 'dist'
$obj = Join-Path $dist 'obj'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Host 'FEHLER: dotnet (.NET SDK 8 oder neuer) wurde nicht gefunden. https://dotnet.microsoft.com/download' -ForegroundColor Red
    exit 1
}

function Write-Step([string]$Text) { Write-Host ''; Write-Host ('== ' + $Text) -ForegroundColor Cyan }

function Invoke-Dotnet([string]$Name, [string[]]$Arguments) {
    $log = Join-Path $obj ('build-' + $Name + '.log')
    $out = & dotnet @Arguments 2>&1
    $code = $LASTEXITCODE
    $out | Out-File -FilePath $log -Encoding utf8
    if ($code -ne 0) {
        $out | ForEach-Object { Write-Host $_ }
        Write-Host ('FEHLER: ' + $Name + ' fehlgeschlagen (Exit ' + $code + ')') -ForegroundColor Red
        exit 1
    }
    return $out
}

try {
    if (Test-Path -LiteralPath $obj) { Remove-Item -LiteralPath $obj -Recurse -Force -ErrorAction Stop }
    $null = New-Item -ItemType Directory -Path $obj -Force -ErrorAction Stop
} catch {
    Write-Host ('FEHLER: ' + $obj + ' nicht beschreibbar: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
$version = ([IO.File]::ReadAllText((Join-Path $app 'VERSION'))).Trim()
Write-Host ('VELOX ' + $version)

$common = @('-c', 'Release', '-nologo', '-v', 'q', '-clp:ErrorsOnly')

Write-Step 'Markenkit (brand/ -> Kopien)'
# VELOX.exe and the setup embed byte-identical copies of brand/; buildtool verify checks them again in the exes
$nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($nodeCmd) {
    & $nodeCmd.Path (Join-Path (Join-Path (Join-Path $app 'brand') 'tools') 'check-copies.mjs')
    if ($LASTEXITCODE -ne 0) { Write-Host 'FEHLER: Kopien von brand/ weichen ab - node tools/sync-brand.mjs ausfuehren' -ForegroundColor Red; exit 1 }
} else { Write-Host '(node fehlt - Kopien werden erst von buildtool verify geprueft)' }

Write-Step 'VELOX.exe'
$null = Invoke-Dotnet 'host' (@('build', (Join-Path (Join-Path $here 'host') 'VeloxHost.csproj'), '-o', (Join-Path $obj 'host')) + $common)

Write-Step 'Build-Werkzeug'
$null = Invoke-Dotnet 'tool' (@('build', (Join-Path (Join-Path $here 'buildtool') 'VeloxBuildTool.csproj'), '-o', (Join-Path $obj 'buildtool')) + $common)
$tool = Join-Path (Join-Path $obj 'buildtool') 'VeloxBuildTool.dll'

Write-Step 'payload.zip'
$payload = Join-Path $obj 'payload.zip'
Invoke-Dotnet 'pack' @($tool, 'pack', '--app', $app, '--host', (Join-Path $obj 'host'), '--out', $payload) | ForEach-Object { Write-Host $_ }

Write-Step 'VeloxSetup.exe'
$null = Invoke-Dotnet 'setup' (@('build', (Join-Path (Join-Path $here 'setup') 'VeloxSetup.csproj'), '-o', (Join-Path $obj 'setup'), ('-p:VeloxPayload=' + $payload)) + $common)
$setup = Join-Path $dist 'VeloxSetup.exe'
try { Copy-Item -LiteralPath (Join-Path (Join-Path $obj 'setup') 'VeloxSetup.exe') -Destination $setup -Force -ErrorAction Stop }
catch { Write-Host ('FEHLER: ' + $setup + ' nicht geschrieben (noch geoeffnet?): ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }

Write-Step 'Pruefen'
Invoke-Dotnet 'verify' @($tool, 'verify', '--setup', $setup, '--app', $app, '--max-mb', $MaxMB.ToString([Globalization.CultureInfo]::InvariantCulture)) | ForEach-Object { Write-Host $_ }

$size = (Get-Item -LiteralPath $setup).Length
Write-Host ''
Write-Host ('Fertig: {0}  ({1} Bytes, {2:N2} MB)' -f $setup, $size, ($size / 1MB)) -ForegroundColor Green
