# Nur für die automatische Prüfung auf GitHub: Bildschirmfoto (oder vorhandenes Bild) verkleinern
# und als Base64 ins Protokoll schreiben, damit man es ohne Artefakt-Download ansehen kann.
#   pwsh scripts/ci-shot.ps1 -Name setup-intro            # ganzer Bildschirm
#   pwsh scripts/ci-shot.ps1 -Name cockpit -File a.png    # vorhandene Datei
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$File,
  [int]$Width = 720,
  [long]$Quality = 72
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if ($File) {
  $src = [System.Drawing.Image]::FromFile((Resolve-Path $File).Path)
} else {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $src = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($src)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $g.Dispose()
}
$h = [int]($src.Height * $Width / $src.Width)
$small = New-Object System.Drawing.Bitmap $Width, $h
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($src, 0, 0, $Width, $h)
$g2.Dispose()
$src.Dispose()

$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), $Quality
$ms = New-Object System.IO.MemoryStream
$small.Save($ms, $codec, $ep)
New-Item -ItemType Directory -Force test-results\shots | Out-Null
[System.IO.File]::WriteAllBytes((Join-Path (Resolve-Path test-results\shots) "$Name.jpg"), $ms.ToArray())
$b64 = [Convert]::ToBase64String($ms.ToArray())
"===SHOT $Name BEGIN==="
for ($i = 0; $i -lt $b64.Length; $i += 160) { $b64.Substring($i, [Math]::Min(160, $b64.Length - $i)) }
"===SHOT $Name END==="
