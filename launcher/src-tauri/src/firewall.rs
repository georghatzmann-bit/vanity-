//! "Can friends reach me?" – Windows Firewall check and the one-click fix (see
//! docs/02-architecture.md, "Playing with friends" → "Windows Firewall").
//!
//! - `status` only reads (PowerShell's NetSecurity cmdlets work without admin rights).
//! - `allow` / `remove` change the firewall, and ONLY when the user clicks the button: they run
//!   one elevated PowerShell (Windows asks with its UAC prompt). Nothing here runs by itself.
//!
//! "Allow friends to connect" adds, in the group "Rift":
//!   "Rift game server" – inbound UDP 7777 for the build's FortniteClient-Win64-Shipping.exe,
//!   "Rift host check"  – inbound TCP 7777 for Rift itself (the small host info answer),
//! both for Private and Public networks. Windows' own pop-up often allows only Private networks
//! and adds a BLOCK rule for Public ones (VPN adapters like Radmin are often "Public"); a block
//! rule beats every allow rule, so inbound block rules for exactly that game file are switched
//! off (not deleted) and remembered in `%LOCALAPPDATA%\Rift\firewall-rules.json`.
//! "Remove the rule" deletes the group "Rift" and switches those block rules back on.

use serde::{Deserialize, Serialize};

use niobium_core::friends::{FIREWALL_CHECK_RULE, FIREWALL_GAME_RULE, FIREWALL_GROUP};
use niobium_core::profiles::GAME_SERVER_PORT;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FirewallStatus {
    /// "allowed", "blocked", "notAllowed", "off", "unknown", "unsupported"
    pub state: String,
    /// Windows network type of the friends' address: "Private", "Public", "Domain" ("" = unknown)
    pub network: String,
    /// Rift's rules are there ("Remove the rule" is offered)
    pub rift_rules: bool,
    /// The "Rift host check" rule is there and on (the host info endpoint may listen)
    pub check_rule: bool,
    /// One plain sentence for the UI
    pub detail: String,
}

#[cfg(not(windows))]
impl FirewallStatus {
    fn unsupported() -> Self {
        Self {
            state: "unsupported".into(),
            detail: "Rift can only check Windows Firewall on Windows.".into(),
            ..Default::default()
        }
    }
}

/// A path goes into a single-quoted PowerShell string. PowerShell also treats the typographic
/// quotes as quotes, so paths with any quote or line break are refused instead of escaped wrongly.
fn ps_quote(path: &str) -> Result<String, String> {
    if path.is_empty() || path.chars().any(|c| matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' | '\n' | '\r' | '\0')) {
        return Err("The game's folder name has a character Rift can't hand to Windows Firewall (a quote). Move the build to a simpler folder.".into());
    }
    Ok(format!("'{path}'"))
}

fn status_script(exe: &str, ip: &str) -> Result<String, String> {
    Ok(format!(
        r#"$ErrorActionPreference = 'SilentlyContinue'
$exe = {exe}; $ip = {ip}; $port = '{port}'
$cat = 'Public'
$a = Get-NetIPAddress -IPAddress $ip | Select-Object -First 1
if ($a) {{ $cp = Get-NetConnectionProfile -InterfaceIndex $a.InterfaceIndex | Select-Object -First 1; if ($cp) {{ $cat = [string]$cp.NetworkCategory }} }}
$fw = if ($cat -eq 'DomainAuthenticated') {{ 'Domain' }} else {{ $cat }}
$prof = Get-NetFirewallProfile -Name $fw
$on = -not ($prof -and [string]$prof.Enabled -eq 'False')
$allow = 0; $block = 0
$rules = @(Get-NetFirewallApplicationFilter -Program $exe | Get-NetFirewallRule | Where-Object {{ [string]$_.Enabled -eq 'True' -and [string]$_.Direction -eq 'Inbound' }})
foreach ($r in $rules) {{
  $p = [string]$r.Profile
  if ($p -ne 'Any' -and $p -notmatch $fw) {{ continue }}
  $pf = $r | Get-NetFirewallPortFilter
  $proto = [string]$pf.Protocol
  if ($proto -ne 'Any' -and $proto -ne 'UDP' -and $proto -ne '17') {{ continue }}
  $lp = @($pf.LocalPort | ForEach-Object {{ [string]$_ }})
  if (-not ($lp -contains 'Any' -or $lp -contains $port)) {{ continue }}
  if ([string]$r.Action -eq 'Block') {{ $block++ }} else {{ $allow++ }}
}}
$ours = @(Get-NetFirewallRule -Group '{group}').Count
$check = @(Get-NetFirewallRule -DisplayName '{check}' | Where-Object {{ [string]$_.Enabled -eq 'True' }}).Count
[pscustomobject]@{{ network = $fw; on = $on; allow = $allow; block = $block; ours = $ours; check = $check }} | ConvertTo-Json -Compress
"#,
        exe = ps_quote(exe)?,
        ip = ps_quote(ip)?,
        port = GAME_SERVER_PORT,
        group = FIREWALL_GROUP,
        check = FIREWALL_CHECK_RULE,
    ))
}

fn allow_script(exe: &str, rift: &str, state_file: &str) -> Result<String, String> {
    Ok(format!(
        r#"$ErrorActionPreference = 'Stop'
try {{
  $exe = {exe}; $rift = {rift}; $state = {state}
  Get-NetFirewallRule -Group '{group}' -ErrorAction SilentlyContinue | Where-Object {{ $_.DisplayName -eq '{check}' -or (($_ | Get-NetFirewallApplicationFilter).Program -eq $exe) }} | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName '{game}' -Group '{group}' -Description 'Added by Rift (Allow friends to connect): friends can join the game server on this PC. Remove it in Rift or here.' -Direction Inbound -Action Allow -Protocol UDP -LocalPort {port} -Program $exe -Profile Private,Public | Out-Null
  New-NetFirewallRule -DisplayName '{check}' -Group '{group}' -Description 'Added by Rift: answers a friends check (version, players) while you host.' -Direction Inbound -Action Allow -Protocol TCP -LocalPort {port} -Program $rift -Profile Private,Public | Out-Null
  $off = @(Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {{ [string]$_.Direction -eq 'Inbound' -and [string]$_.Action -eq 'Block' -and [string]$_.Enabled -eq 'True' }})
  $names = @($off | ForEach-Object {{ $_.Name }})
  if ($off.Count -gt 0) {{ $off | Disable-NetFirewallRule }}
  $old = @(); if (Test-Path -LiteralPath $state) {{ try {{ $old = @(Get-Content -LiteralPath $state -Raw | ConvertFrom-Json) }} catch {{ }} }}
  $all = @(@($old) + $names | Where-Object {{ $_ }} | Select-Object -Unique)
  if ($all.Count -gt 0) {{ ConvertTo-Json -InputObject $all | Set-Content -LiteralPath $state -Encoding UTF8 }}
  exit 0
}} catch {{ exit 2 }}
"#,
        exe = ps_quote(exe)?,
        rift = ps_quote(rift)?,
        state = ps_quote(state_file)?,
        group = FIREWALL_GROUP,
        game = FIREWALL_GAME_RULE,
        check = FIREWALL_CHECK_RULE,
        port = GAME_SERVER_PORT,
    ))
}

fn remove_script(state_file: &str) -> Result<String, String> {
    Ok(format!(
        r#"$ErrorActionPreference = 'Stop'
try {{
  $state = {state}
  Get-NetFirewallRule -Group '{group}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  if (Test-Path -LiteralPath $state) {{
    $names = @(); try {{ $names = @(Get-Content -LiteralPath $state -Raw | ConvertFrom-Json) }} catch {{ }}
    foreach ($n in $names) {{ Enable-NetFirewallRule -Name $n -ErrorAction SilentlyContinue }}
    Remove-Item -LiteralPath $state -ErrorAction SilentlyContinue
  }}
  exit 0
}} catch {{ exit 2 }}
"#,
        state = ps_quote(state_file)?,
        group = FIREWALL_GROUP,
    ))
}

/// Base64 of the script as UTF-16LE, for `powershell -EncodedCommand` (no quoting at all).
fn encode_command(script: &str) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn state_file() -> String {
    niobium_core::profiles::local_dir().join("firewall-rules.json").to_string_lossy().into_owned()
}

#[cfg(windows)]
fn powershell(args: &[&str]) -> std::io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"])
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
}

/// Read-only check for the game file `exe` on the network of `ip` (the address in the invite).
#[cfg(windows)]
pub fn status(exe: &str, ip: &str) -> FirewallStatus {
    let script = match status_script(exe, ip) {
        Ok(s) => s,
        Err(e) => return FirewallStatus { state: "unknown".into(), detail: e, ..Default::default() },
    };
    let out = powershell(&["-EncodedCommand", &encode_command(&script)]);
    let parsed = out.ok().and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok());
    let Some(v) = parsed else {
        return FirewallStatus {
            state: "unknown".into(),
            detail: "Rift couldn't read the Windows Firewall settings. If friends can't join, press \"Allow friends to connect\".".into(),
            ..Default::default()
        };
    };
    let num = |k: &str| v.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let network = v.get("network").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let on = v.get("on").and_then(|x| x.as_bool()).unwrap_or(true);
    let (state, detail) = if !on {
        ("off", format!("Windows Firewall is off for this {network} network – friends can connect."))
    } else if num("block") > 0 {
        ("blocked", format!("Windows Firewall blocks this Fortnite on {network} networks (often from the Windows pop-up). Friends can't join yet."))
    } else if num("allow") > 0 {
        ("allowed", format!("Windows Firewall lets friends reach your game on this {network} network."))
    } else {
        ("notAllowed", format!("Windows Firewall hasn't allowed this Fortnite on {network} networks yet. Windows may ask when you host – or press the button below."))
    };
    FirewallStatus { state: state.into(), network, rift_rules: num("ours") > 0, check_rule: num("check") > 0, detail }
}

#[cfg(not(windows))]
pub fn status(_exe: &str, _ip: &str) -> FirewallStatus {
    FirewallStatus::unsupported()
}

/// Runs a script elevated (Windows shows its UAC prompt) and waits. Ok = it worked.
#[cfg(windows)]
fn run_elevated(script: &str) -> Result<(), String> {
    let inner = encode_command(script);
    // The outer, normal PowerShell only starts the elevated one; 1223 = the user said No.
    let outer = format!(
        "try {{ $p = Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','{inner}'; exit $p.ExitCode }} catch {{ exit 1223 }}"
    );
    let out = powershell(&["-EncodedCommand", &encode_command(&outer)]).map_err(|e| format!("Couldn't start PowerShell: {e}"))?;
    match out.status.code() {
        Some(0) => Ok(()),
        Some(1223) => Err("You said No to the Windows prompt – nothing was changed.".into()),
        _ => Err("Windows Firewall didn't take the change. Nothing was changed. Try again, or add the rule by hand (see the Rift docs).".into()),
    }
}

/// "Allow friends to connect" (only on the user's click).
#[cfg(windows)]
pub fn allow(exe: &str) -> Result<(), String> {
    let rift = std::env::current_exe().map_err(|e| e.to_string())?;
    run_elevated(&allow_script(exe, &rift.to_string_lossy(), &state_file())?)
}

/// "Remove the rule" (only on the user's click).
#[cfg(windows)]
pub fn remove() -> Result<(), String> {
    run_elevated(&remove_script(&state_file())?)
}

#[cfg(not(windows))]
pub fn allow(_exe: &str) -> Result<(), String> {
    Err(FirewallStatus::unsupported().detail)
}

#[cfg(not(windows))]
pub fn remove() -> Result<(), String> {
    Err(FirewallStatus::unsupported().detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_utf16() {
        // "ab" as UTF-16LE = 61 00 62 00 → "YQBiAA=="
        assert_eq!(encode_command("ab"), "YQBiAA==");
        assert_eq!(encode_command("a"), "YQA=");
        assert_eq!(encode_command(""), "");
    }

    #[test]
    fn quoting_refuses_quotes() {
        assert_eq!(ps_quote(r"C:\Games\19.10\FortniteClient-Win64-Shipping.exe").unwrap(), r"'C:\Games\19.10\FortniteClient-Win64-Shipping.exe'");
        assert!(ps_quote(r"C:\Bob's\x.exe").is_err());
        assert!(ps_quote("C:\\a\u{2019}b\\x.exe").is_err());
        assert!(ps_quote("").is_err());
    }

    #[test]
    fn scripts_name_only_rifts_rules() {
        let a = allow_script(r"C:\G\FortniteClient-Win64-Shipping.exe", r"C:\R\Rift.exe", r"C:\L\firewall-rules.json").unwrap();
        assert!(a.contains("-DisplayName 'Rift game server' -Group 'Rift'"));
        assert!(a.contains("-Protocol UDP -LocalPort 7777 -Program $exe -Profile Private,Public"));
        assert!(a.contains("-Protocol TCP -LocalPort 7777 -Program $rift"));
        let r = remove_script(r"C:\L\firewall-rules.json").unwrap();
        assert!(r.contains("Get-NetFirewallRule -Group 'Rift'"));
        assert!(!r.contains("New-NetFirewallRule"));
        let s = status_script(r"C:\G\FortniteClient-Win64-Shipping.exe", "26.1.2.3").unwrap();
        assert!(!s.contains("New-NetFirewallRule") && !s.contains("Remove-") && !s.contains("Disable-") && !s.contains("Set-"));
    }
}
