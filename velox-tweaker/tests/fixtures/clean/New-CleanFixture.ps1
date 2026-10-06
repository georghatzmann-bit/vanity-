<#
.SYNOPSIS
  Builds a throw-away fake PC for the Reinigung tests (VELOX_CLEAN_FIXTURE / $VxCtx.CleanFixture):
  <Root>\C\Users\Max\AppData\..., <Root>\C\Windows\..., caches of browsers and launchers, a file
  outside every allowed folder, running.txt (apps that "run") and locked.txt (files "in use").
  Deletes really happen in this folder - never point it at anything else.
.EXAMPLE
  pwsh tests/fixtures/clean/New-CleanFixture.ps1 -Root /tmp/vx-clean
#>
param([Parameter(Mandatory = $true)][string]$Root, [string[]]$Running = @('chrome'))

function New-FxFile([string]$Rel, [int]$Bytes) {
    $p = Join-Path $Root ($Rel.Replace('\', [IO.Path]::DirectorySeparatorChar))
    $d = Split-Path -Parent $p
    if (-not [IO.Directory]::Exists($d)) { [void][IO.Directory]::CreateDirectory($d) }
    [IO.File]::WriteAllBytes($p, (New-Object byte[] $Bytes))
}

$u = 'C\Users\Max'
$files = @(
    @("$u\AppData\Local\Temp\setup-1234\a.tmp", 4000), @("$u\AppData\Local\Temp\b.log", 1000), @("$u\AppData\Local\Temp\in-use.tmp", 500),
    @('C\Windows\Temp\cab_1.tmp', 3000),
    @("$u\AppData\Local\Microsoft\Windows\INetCache\IE\x.dat", 700),
    @("$u\AppData\Local\Microsoft\Windows\INetCache\Content.Outlook\AB12CD34\Angebot.docx", 999),
    @("$u\AppData\Local\Microsoft\Windows\Explorer\thumbcache_256.db", 2048),
    @('C\Windows\SoftwareDistribution\Download\abc\update.cab', 9000),
    @('C\Windows\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache\f1', 5000),
    @("$u\AppData\Local\Microsoft\Edge\User Data\Default\Cache\Cache_Data\data_0", 1200),
    @("$u\AppData\Local\Microsoft\Edge\User Data\Profile 1\Code Cache\js\index", 300),
    @("$u\AppData\Local\Microsoft\Edge\User Data\Default\Cookies", 999),
    @("$u\AppData\Local\Microsoft\Edge\User Data\Default\History", 999),
    @("$u\AppData\Local\Microsoft\Edge\User Data\ShaderCache\s.bin", 100),
    @("$u\AppData\Local\Google\Chrome\User Data\Default\Cache\Cache_Data\data_1", 2500),
    @("$u\AppData\Local\Mozilla\Firefox\Profiles\abcd.default-release\cache2\entries\E1", 800),
    @("$u\AppData\Roaming\discord\Cache\Cache_Data\f_000001", 600),
    @("$u\AppData\Roaming\discord\Local Storage\leveldb\000003.log", 999),
    @("$u\AppData\Local\Spotify\Data\0a\track", 4000),
    @('C\Program Files (x86)\Steam\appcache\httpcache\0f\x', 450), @('C\Program Files (x86)\Steam\logs\content_log.txt', 120),
    @('C\Program Files (x86)\Steam\steamapps\shadercache\730\fozpipelinesv6\steam_pipeline_cache.foz', 6000),
    @('C\Program Files (x86)\Steam\steamapps\common\Game\game.exe', 999),
    @("$u\AppData\Local\CrashDumps\app.exe.123.dmp", 3300), @('C\Windows\Minidump\100526-01.dmp', 400),
    @('C\Windows\MEMORY.DMP', 16000),
    @('C\Windows\LiveKernelReports\WATCHDOG\w.dmp', 7000),
    @('C\ProgramData\Microsoft\Windows\WER\ReportArchive\r1\Report.wer', 200),
    @('C\Windows\Logs\CBS\CbsPersist_20260101.cab', 1500), @('C\Windows\Logs\CBS\CBS.log', 999),
    @('C\NVIDIA\DisplayDriver\560.94\setup.exe', 8000),
    @("$u\AppData\Local\D3DSCache\a\b.idx", 900),
    @("$u\AppData\LocalLow\NVIDIA\PerDriverVersion\DXCache\x.nvph", 1100),
    @("$u\AppData\Local\FiveM\FiveM.app\data\cache\priv\c.bin", 1000), @("$u\AppData\Local\FiveM\FiveM.app\data\cache\game\keep.rpf", 999),
    @("$u\AppData\Local\FiveM\FiveM.app\logs\CitizenFX.log", 250),
    @('C\$Recycle.Bin\S-1-5-21-0-0-0-1001\$IABC.txt', 100), @('C\$Recycle.Bin\S-1-5-21-0-0-0-1001\$RABC.txt', 5000), @('C\$Recycle.Bin\S-1-5-21-0-0-0-1001\desktop.ini', 129),
    @('C\Users\Lena\AppData\Local\Temp\other.tmp', 2200),
    @('C\Windows.old\Windows\System32\old.dll', 12000),
    @('C\Windows\System32\drivers\keep.sys', 999),
    @("$u\Documents\wichtig.docx", 999)
)
foreach ($f in $files) { New-FxFile $f[0] $f[1] }
# everything above is three days old (Temp items have minAgeHours = 24) ...
$old = [DateTime]::UtcNow.AddDays(-3)
foreach ($e in @(Get-ChildItem -LiteralPath $Root -Recurse -Force)) { try { $e.LastWriteTimeUtc = $old } catch { $null = $_ } }
# ... these are new: an installer that is still running / waits for the reboot needs them
New-FxFile "$u\AppData\Local\Temp\fresh.tmp" 300
New-FxFile "$u\AppData\Local\Temp\setup-new\product.msi" 700
[IO.File]::WriteAllLines((Join-Path $Root 'running.txt'), [string[]]@($Running))
[IO.File]::WriteAllLines((Join-Path $Root 'locked.txt'), [string[]]@(("$u\AppData\Local\Temp\in-use.tmp").Replace('\', '/')))
Write-Output $Root
