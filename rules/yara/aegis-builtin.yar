// AEGIS – eigene, defensive YARA-Regeln (Lizenz: wie das Projekt; Herkunft: AEGIS selbst).
// Metadaten: severity = dangerous | risky | game | suspicious | info
//            de / en  = kurze Begründung für die „Warum?“-Ansicht.

rule AEGIS_Test_Marker
{
    meta:
        severity = "dangerous"
        de = "Harmlose AEGIS-Prüfmarke für Tests (wie EICAR, nur für AEGIS)."
        en = "Harmless AEGIS test marker for tests (like EICAR, AEGIS only)."
    strings:
        $m = "AEGIS-HARMLESS-TEST-SIGNATURE-DANGEROUS-7c1e"
    condition:
        $m
}

rule AEGIS_PowerShell_Download_Cradle
{
    meta:
        severity = "suspicious"
        de = "Skript lädt Code aus dem Internet und führt ihn sofort aus (Download-Cradle)."
        en = "Script downloads code from the internet and runs it immediately (download cradle)."
    strings:
        $dl1 = "DownloadString" nocase
        $dl2 = "DownloadData" nocase
        $dl3 = "Invoke-WebRequest" nocase
        $dl4 = "iwr " nocase
        $ex1 = "Invoke-Expression" nocase
        $ex2 = "IEX" nocase fullword
    condition:
        filesize < 2MB and any of ($dl*) and any of ($ex*)
}

rule AEGIS_PowerShell_Encoded_Command
{
    meta:
        severity = "suspicious"
        de = "Startet PowerShell mit verschlüsseltem Befehl (-EncodedCommand) – verschleiert, was passiert."
        en = "Starts PowerShell with an encoded command (-EncodedCommand) – hides what happens."
    strings:
        $ps = "powershell" nocase
        $e1 = "-EncodedCommand" nocase
        $e2 = /-e(nc|ncodedcommand)?\s+[A-Za-z0-9+\/=]{40,}/ nocase
    condition:
        filesize < 2MB and $ps and any of ($e*)
}
