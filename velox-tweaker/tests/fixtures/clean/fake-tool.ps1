<#
  Fake DISM / SFC for the tool-runner tests: writes raw bytes like the real tools do.
    dism   : OEM/UTF-8 text, progress bar redrawn with a bare \r, exit code -ExitCode
    sfc    : UTF-16LE (as sfc.exe writes into a pipe), German "Überprüfung n % abgeschlossen."
    sfc-en : UTF-16LE, English "Verification n% complete."
    hang   : prints one bar and then sleeps (timeout / Abbrechen / Überspringen); starts a child
             process that sleeps too, so killing the whole tree can be checked (-PidFile)
#>
param([string]$Mode = 'dism', [int]$ExitCode = 0, [int]$DelayMs = 40, [string]$PidFile = '')
$out = [Console]::OpenStandardOutput()
function Send([byte[]]$b) { $out.Write($b, 0, $b.Length); $out.Flush(); if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs } }
$utf8 = New-Object System.Text.UTF8Encoding($false)
$uni = New-Object System.Text.UnicodeEncoding($false, $false)
switch ($Mode) {
    'dism' {
        Send ($utf8.GetBytes("`r`nDeployment Image Servicing and Management tool`r`nVersion: 10.0.22621.1`r`n`r`nImage Version: 10.0.22631.4317`r`n`r`n"))
        foreach ($p in @('0.0', '12.5', '40.0', '62.3', '100.0')) {
            # the number split across two writes, like a pipe read can split it
            $bar = "`r[==========================$p%========================]"
            $half = [int]($bar.Length / 2)
            Send ($utf8.GetBytes($bar.Substring(0, $half)))
            Send ($utf8.GetBytes($bar.Substring($half)))
        }
        if ($ExitCode -eq 0) { Send ($utf8.GetBytes("`r`nThe restore operation completed successfully.`r`nThe operation completed successfully.`r`n")) }
        else { Send ($utf8.GetBytes("`r`n`r`nError: 0x800f081f`r`n`r`nThe source files could not be found.`r`nThe DISM log file can be found at C:\Windows\Logs\DISM\dism.log`r`n")) }
    }
    'sfc' {
        Send ($uni.GetBytes("`r`nSystemüberprüfung wird gestartet.`r`n`r`n"))
        foreach ($p in @(0, 7, 33, 58, 100)) {
            $b = $uni.GetBytes("`rÜberprüfung $p % abgeschlossen.")
            # odd split: half a UTF-16 code unit at the end of a read
            Send ($b[0..10]); Send ($b[11..($b.Length - 1)])
        }
        Send ($uni.GetBytes("`r`n`r`nDer Windows-Ressourcenschutz hat beschädigte Dateien gefunden, konnte jedoch einige davon nicht reparieren.`r`n"))
    }
    'sfc-en' {
        Send ($uni.GetBytes("`r`nBeginning system scan.  This process will take some time.`r`n`r`n"))
        foreach ($p in @(1, 45, 100)) { Send ($uni.GetBytes("`rVerification $p% complete.")) }
        Send ($uni.GetBytes("`r`n`r`nWindows Resource Protection did not find any integrity violations.`r`n"))
    }
    'hang' {
        $child = Start-Process -FilePath ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 120') -PassThru
        if ($PidFile) { [IO.File]::WriteAllText($PidFile, [string]$child.Id) }
        Send ($utf8.GetBytes("`r[=====      10.0%          ]"))
        Start-Sleep -Seconds 120
    }
}
exit $ExitCode
