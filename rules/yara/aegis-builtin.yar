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

// ---------------------------------------------------------------------------------------
// P3: Spiel-Tools (Cheats) und Werkzeuge mit Risiko. Nur Einordnung, keine Malware-Urteile.
// ---------------------------------------------------------------------------------------

rule AEGIS_GameTool_CheatEngine
{
    meta:
        severity = "game"
        de = "Cheat Engine oder ein daraus erzeugter Trainer (Speicher-Editor für Spiele)."
        en = "Cheat Engine or a trainer built with it (memory editor for games)."
    strings:
        $a = "Cheat Engine" ascii wide nocase
        $b = "cheatengine-" ascii wide nocase
        $c = "CETRAINER" ascii wide
    condition:
        any of them
}

rule AEGIS_GameTool_Cheat_Features
{
    meta:
        severity = "game"
        de = "Enthält typische Cheat-Funktionen (z. B. Aimbot, Wallhack, Mod-Menü, Trainer)."
        en = "Contains typical cheat features (e.g. aimbot, wallhack, mod menu, trainer)."
    strings:
        $f1 = "aimbot" ascii wide nocase
        $f2 = "wallhack" ascii wide nocase
        $f3 = "triggerbot" ascii wide nocase
        $f4 = "mod menu" ascii wide nocase
        $f5 = "no recoil" ascii wide nocase
        $f6 = "speedhack" ascii wide nocase
        $f7 = "god mode" ascii wide nocase
        $f8 = "infinite ammo" ascii wide nocase
        $f9 = "unlimited health" ascii wide nocase
        $f10 = "+ trainer" ascii wide nocase
        $f11 = "esp box" ascii wide nocase
        $f12 = "dll injector" ascii wide nocase
    condition:
        2 of them
}

rule AEGIS_RiskyTool_Credential_Dumper
{
    meta:
        severity = "risky"
        de = "Werkzeug zum Auslesen von Windows-Anmeldedaten (z. B. Mimikatz) – auch von Angreifern genutzt."
        en = "Tool for extracting Windows credentials (e.g. Mimikatz) – also used by attackers."
    strings:
        $a = "sekurlsa::" ascii wide nocase
        $b = "lsadump::" ascii wide nocase
        $c = "mimikatz" ascii wide nocase
    condition:
        2 of them
}

// ---------------------------------------------------------------------------------------
// P3: Malware-Merkmale (severity = "trait", Metadatum `trait` = Kategorie). Ein einzelnes
// Merkmal ergibt nur Punkte; erst mehrere verschiedene Kategorien zusammen ergeben
// „Gefährlich“ (siehe crates/engine/src/traits.rs).
// ---------------------------------------------------------------------------------------

rule AEGIS_Trait_Credential_Theft
{
    meta:
        severity = "trait"
        trait = "credentials"
        de = "Greift auf gespeicherte Passwörter, Cookies oder Tokens von Browsern/Apps zu."
        en = "Accesses stored passwords, cookies or tokens of browsers/apps."
    strings:
        $a = "\\User Data\\Default\\Login Data" ascii wide nocase
        $b = "\\Local State" ascii wide nocase
        $c = "\\Network\\Cookies" ascii wide nocase
        $d = "logins.json" ascii wide nocase
        $e = "key4.db" ascii wide nocase
        $f = "\\discord\\Local Storage\\leveldb" ascii wide nocase
        $g = "wallet.dat" ascii wide nocase
        $h = "os_crypt" ascii wide nocase
    condition:
        2 of them
}

rule AEGIS_Trait_Disable_Antivirus
{
    meta:
        severity = "trait"
        trait = "av_disable"
        de = "Versucht, den Virenschutz abzuschalten oder Ausnahmen einzutragen."
        en = "Tries to disable antivirus protection or add exclusions."
    strings:
        $a = "DisableRealtimeMonitoring" ascii wide nocase
        $b = "DisableAntiSpyware" ascii wide nocase
        $c = "Add-MpPreference -ExclusionPath" ascii wide nocase
        $d = "sc stop WinDefend" ascii wide nocase
        $e = "DisableBehaviorMonitoring" ascii wide nocase
    condition:
        any of them
}

rule AEGIS_Trait_Hidden_Autostart
{
    meta:
        severity = "trait"
        trait = "hidden_autostart"
        de = "Richtet einen Autostart ein und versteckt sich dabei."
        en = "Sets up autostart while hiding itself."
    strings:
        $run1 = "\\CurrentVersion\\Run" ascii wide nocase
        $run2 = "schtasks /create" ascii wide nocase
        $run3 = "\\Start Menu\\Programs\\Startup" ascii wide nocase
        $run4 = "sc create" ascii wide nocase
        $hide1 = "attrib +h" ascii wide nocase
        $hide2 = "-WindowStyle Hidden" ascii wide nocase
        $hide3 = "/rl highest" ascii wide nocase
    condition:
        any of ($run*) and any of ($hide*)
}

rule AEGIS_Trait_Dropper
{
    meta:
        severity = "trait"
        trait = "dropper"
        de = "Lädt weitere Programme aus dem Internet und startet sie."
        en = "Downloads further programs from the internet and starts them."
    strings:
        $dl1 = "URLDownloadToFile" ascii wide nocase
        $dl2 = ".DownloadFile(" ascii wide nocase
        $dl3 = "certutil -urlcache" ascii wide nocase
        $dl4 = "bitsadmin /transfer" ascii wide nocase
        $ex1 = "ShellExecute" ascii wide nocase
        $ex2 = "WinExec" ascii wide nocase
        $ex3 = "Start-Process" ascii wide nocase
        $ex4 = "CreateProcess" ascii wide nocase
    condition:
        any of ($dl*) and any of ($ex*)
}

rule AEGIS_Trait_Ransomware
{
    meta:
        severity = "trait"
        trait = "ransomware"
        de = "Löscht Sicherungskopien von Windows oder enthält einen Erpresser-Text."
        en = "Deletes Windows backup copies or contains a ransom note."
    strings:
        $a = "vssadmin delete shadows" ascii wide nocase
        $b = "wbadmin delete catalog" ascii wide nocase
        $c = "recoveryenabled no" ascii wide nocase
        $d = "your files have been encrypted" ascii wide nocase
        $e = "to decrypt your files" ascii wide nocase
    condition:
        any of them
}

rule AEGIS_Trait_Covert_Channel
{
    meta:
        severity = "trait"
        trait = "covert_network"
        de = "Nutzt verdeckte Kanäle zum Ausleiten von Daten (z. B. Tor, Telegram-Bot, Discord-Webhook)."
        en = "Uses covert channels for data exfiltration (e.g. Tor, Telegram bot, Discord webhook)."
    strings:
        $a = /[a-z2-7]{56}\.onion/ ascii wide nocase
        $b = "api.telegram.org/bot" ascii wide nocase
        $c = "discord.com/api/webhooks/" ascii wide nocase
        $d = "pastebin.com/raw/" ascii wide nocase
    condition:
        any of them
}
