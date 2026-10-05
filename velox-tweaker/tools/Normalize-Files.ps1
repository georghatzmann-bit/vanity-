<#
.SYNOPSIS
  Normalizes file encodings for VELOX (see docs/ARCHITECTURE.md, section 2, rule 9):
    *.ps1            -> UTF-8 WITH BOM (Windows PowerShell 5.1 reads BOM-less files as ANSI)
    *.bat / *.cmd    -> ASCII, CRLF line endings
    *.json/html/css/js/mjs/md -> UTF-8 WITHOUT BOM
  Run after writing files:  pwsh tools/Normalize-Files.ps1
  With -Check it only reports problems and exits 1 if any were found.
#>
param([switch]$Check)

$root = Split-Path -Parent $PSScriptRoot
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$problems = 0

function Test-Bom([byte[]]$b) { return ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) }

Get-ChildItem -Path $root -Recurse -File | Where-Object { $_.FullName -notmatch '[\\/](node_modules|\.git)[\\/]' } | ForEach-Object {
    $f = $_
    $ext = $f.Extension.ToLowerInvariant()
    $bytes = [IO.File]::ReadAllBytes($f.FullName)
    $rel = $f.FullName.Substring($root.Length + 1)
    switch ($ext) {
        '.ps1' {
            if (-not (Test-Bom $bytes)) {
                $problems++
                if ($Check) { Write-Host "missing UTF-8 BOM: $rel" -ForegroundColor Red }
                else {
                    $text = $utf8NoBom.GetString($bytes)
                    [IO.File]::WriteAllText($f.FullName, $text, $utf8Bom)
                    Write-Host "added BOM: $rel"
                }
            }
        }
        { $_ -eq '.bat' -or $_ -eq '.cmd' } {
            $text = [Text.Encoding]::ASCII.GetString($bytes)
            $nonAscii = $false
            foreach ($b in $bytes) { if ($b -gt 127) { $nonAscii = $true; break } }
            $normalized = ($text -replace "`r`n", "`n") -replace "`n", "`r`n"
            if ($nonAscii -or $normalized -ne $text) {
                $problems++
                if ($Check) { Write-Host "batch file must be ASCII with CRLF: $rel" -ForegroundColor Red }
                elseif ($nonAscii) { Write-Host "NON-ASCII in batch file, fix by hand: $rel" -ForegroundColor Red }
                else {
                    [IO.File]::WriteAllBytes($f.FullName, [Text.Encoding]::ASCII.GetBytes($normalized))
                    Write-Host "CRLF: $rel"
                }
            }
        }
        { @('.json','.html','.css','.js','.mjs','.md') -contains $_ } {
            if (Test-Bom $bytes) {
                $problems++
                if ($Check) { Write-Host "unexpected BOM: $rel" -ForegroundColor Red }
                else {
                    [IO.File]::WriteAllBytes($f.FullName, $bytes[3..($bytes.Length - 1)])
                    Write-Host "removed BOM: $rel"
                }
            }
        }
    }
}

if ($Check -and $problems -gt 0) { Write-Host "$problems encoding problem(s). Run: pwsh tools/Normalize-Files.ps1" -ForegroundColor Red; exit 1 }
if ($Check) { Write-Host 'Encodings OK' }
exit 0
