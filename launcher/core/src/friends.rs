//! Playing with friends (see docs/02-architecture.md, "Playing with friends"):
//! - the invite code the host copies (`RIFT1:<ip>:<port>:<version>:<cl>:<mode>`),
//! - which of the PC's addresses can be given to friends (VPN first, then the home network),
//! - whether a build in the Library is the exact Fortnite the host plays,
//! - the answer of the host's small "Rift host info" endpoint.
//!
//! No network and no Windows calls here, so all of it is tested on any system.

use serde::{Deserialize, Serialize};
use std::net::Ipv4Addr;

use crate::profiles::GAME_SERVER_PORT;
use crate::version::{parse_version_number, BuildInfo};

/// Start of the invite code. The digit is the format version: a newer Rift may write `RIFT2:`,
/// which this one refuses with a plain hint instead of guessing. `RIFT:` (no digit) is read as 1.
pub const INVITE_PREFIX: &str = "RIFT1";
/// Pipe key of "Together vs bots" (server: `FConfiguration::bHumansSameTeam`).
pub const HUMANS_SAME_TEAM_KEY: &str = "bHumansSameTeam";
/// Path of the host info endpoint (TCP, same port number as the game server: 7777).
pub const HOST_INFO_PATH: &str = "/rift-host";
/// TCP port of the host info endpoint (the game server uses UDP 7777; TCP 7777 is free).
pub const HOST_INFO_PORT: u16 = GAME_SERVER_PORT;
/// Largest host info answer the friend's Rift reads.
pub const HOST_INFO_MAX_BYTES: usize = 1024;
/// Windows Firewall rule names (group `FIREWALL_GROUP`), added only by "Allow friends to connect".
pub const FIREWALL_GROUP: &str = "Rift";
pub const FIREWALL_GAME_RULE: &str = "Rift game server";
pub const FIREWALL_CHECK_RULE: &str = "Rift host check";

// ---- Addresses ------------------------------------------------------------------------------

/// Kind of network an address belongs to. Order = preference for the invite.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NetKind {
    Tailscale,
    Radmin,
    ZeroTier,
    Hamachi,
    /// Home network (192.168.x, 10.x, 172.16–31.x): only for friends in the same house.
    Lan,
}

impl NetKind {
    pub fn label(self) -> &'static str {
        match self {
            NetKind::Tailscale => "Tailscale",
            NetKind::Radmin => "Radmin VPN",
            NetKind::ZeroTier => "ZeroTier",
            NetKind::Hamachi => "Hamachi",
            NetKind::Lan => "Home network",
        }
    }

    pub fn is_vpn(self) -> bool {
        self != NetKind::Lan
    }
}

/// One address the host can give to friends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareAddress {
    pub kind: NetKind,
    /// "Tailscale", "Radmin VPN", …
    pub label: String,
    pub ip: String,
    /// Name of the network adapter (as Windows shows it)
    pub adapter: String,
}

/// Virtual adapters of virtual machines, WSL or Docker: their addresses never reach a friend.
fn is_virtual_adapter(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["vethernet", "virtualbox", "vmware", "hyper-v", "wsl", "docker", "loopback", "npcap", "vbox"]
        .iter()
        .any(|v| n.contains(v))
}

fn in_net(ip: Ipv4Addr, net: [u8; 4], prefix: u32) -> bool {
    let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
    (u32::from(ip) & mask) == (u32::from(Ipv4Addr::from(net)) & mask)
}

/// Is this a private home-network address (10/8, 172.16/12, 192.168/16)?
pub fn is_lan(ip: Ipv4Addr) -> bool {
    ip.is_private()
}

/// Which network an address of this PC belongs to – `None` = never give it to friends and never
/// listen on it (loopback, link-local, public internet addresses, virtual machine adapters).
/// Tailscale uses 100.64.0.0/10 (not all of 100.x – the rest is the public internet), Radmin VPN
/// 26.0.0.0/8, Hamachi 25.0.0.0/8; ZeroTier picks home-network-like ranges, so it is told by the
/// adapter name.
pub fn classify(ip: Ipv4Addr, adapter: &str) -> Option<NetKind> {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_link_local() || ip.is_multicast() || ip.is_broadcast() {
        return None;
    }
    let name = adapter.to_ascii_lowercase();
    let private_like = is_lan(ip) || in_net(ip, [100, 64, 0, 0], 10);
    if name.contains("tailscale") && in_net(ip, [100, 64, 0, 0], 10) {
        return Some(NetKind::Tailscale);
    }
    if name.contains("zerotier") && private_like {
        return Some(NetKind::ZeroTier);
    }
    if in_net(ip, [26, 0, 0, 0], 8) {
        return Some(NetKind::Radmin);
    }
    if in_net(ip, [25, 0, 0, 0], 8) {
        return Some(NetKind::Hamachi);
    }
    if in_net(ip, [100, 64, 0, 0], 10) {
        return Some(NetKind::Tailscale);
    }
    if is_lan(ip) && !is_virtual_adapter(adapter) {
        return Some(NetKind::Lan);
    }
    None
}

/// The addresses to show, best first (VPNs before the home network; same kind: adapter order).
pub fn share_list(interfaces: &[(String, Ipv4Addr)]) -> Vec<ShareAddress> {
    let mut out: Vec<ShareAddress> = interfaces
        .iter()
        .filter_map(|(adapter, ip)| {
            classify(*ip, adapter).map(|kind| ShareAddress {
                kind,
                label: kind.label().to_string(),
                ip: ip.to_string(),
                adapter: adapter.clone(),
            })
        })
        .collect();
    out.dedup_by(|a, b| a.ip == b.ip);
    out.sort_by_key(|a| a.kind);
    out
}

/// May the host info endpoint listen on this address? Only on addresses `classify` accepts
/// (VPN and home network) – never 0.0.0.0 or a public internet address.
pub fn may_listen_on(ip: Ipv4Addr, adapter: &str) -> bool {
    classify(ip, adapter).is_some()
}

// ---- Team mode ------------------------------------------------------------------------------

/// Team size of a playlist from its name: Squads 4, Trios 3, Duos 2, everything else 1.
pub fn team_size_for_playlist(playlist: &str) -> u8 {
    let p = playlist.to_ascii_lowercase();
    if p.contains("squad") {
        4
    } else if p.contains("trio") {
        3
    } else if p.contains("duo") {
        2
    } else {
        1
    }
}

/// Mode word of the invite: "vs" (Solo, against each other), "team2" … "team4" (Duo/Trio/Squad,
/// all friends in one team) or "fill2" … "fill4" (a team playlist with normal team picking –
/// profiles from before "Together" existed).
pub fn invite_mode(friends_together: bool, playlist: &str) -> String {
    match team_size_for_playlist(playlist) {
        1 => "vs".into(),
        n if friends_together => format!("team{n}"),
        n => format!("fill{n}"),
    }
}

/// Is "Together" in effect for this profile? Only in team playlists (Solo has no teams).
pub fn humans_same_team(friends_together: bool, playlist: &str) -> bool {
    friends_together && team_size_for_playlist(playlist) > 1
}

fn valid_mode(mode: &str) -> bool {
    matches!(mode, "vs" | "team2" | "team3" | "team4" | "fill2" | "fill3" | "fill4")
}

/// One line about the match, the same for the host's invite and the friend's check:
/// "Solo against each other · bots on · Lategame", "Squad together · no bots".
pub fn match_summary(mode: &str, bots: bool, lategame: bool) -> String {
    let base = match mode {
        "vs" => "Solo against each other",
        "team2" => "Duo together",
        "team3" => "Trio together",
        "team4" => "Squad together",
        "fill2" => "Duos",
        "fill3" => "Trios",
        "fill4" => "Squads",
        _ => "Match",
    };
    let mut out = format!("{base} · {}", if bots { "bots on" } else { "no bots" });
    if lategame {
        out.push_str(" · Lategame");
    }
    out
}

// ---- Invite code ----------------------------------------------------------------------------

/// What the host's invite says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub ip: String,
    pub port: u16,
    /// Fortnite version of the host's build, e.g. "19.10"
    pub version: String,
    /// Build number (CL) of the host's build, if known
    pub cl: Option<u32>,
    /// "vs", "team2" … "team4", "fill2" … "fill4" (None = an invite without it, see `invite_mode`)
    pub mode: Option<String>,
    /// AI bots are on in the host's profile (and the build has them)
    #[serde(default)]
    pub bots: bool,
    #[serde(default)]
    pub lategame: bool,
}

impl Invite {
    /// `RIFT1:100.101.12.7:7777:19.10:18675304:team4+bots+late` (unknown CL = "-").
    pub fn to_code(&self) -> String {
        let cl = self.cl.map(|c| c.to_string()).unwrap_or_else(|| "-".into());
        let mut code = format!("{INVITE_PREFIX}:{}:{}:{}:{cl}", self.ip, self.port, self.version);
        if let Some(mode) = &self.mode {
            code.push(':');
            code.push_str(mode);
            if self.bots {
                code.push_str("+bots");
            }
            if self.lategame {
                code.push_str("+late");
            }
        }
        code
    }

    /// "Squad together · bots on · Lategame" (empty for an invite without a mode)
    pub fn summary(&self) -> String {
        self.mode.as_deref().map(|m| match_summary(m, self.bots, self.lategame)).unwrap_or_default()
    }

    /// What "Copy invite" puts on the clipboard: one line, the summary and the code. The friend can
    /// paste all of it (Rift and F9 find the code inside).
    pub fn share_text(&self) -> String {
        match self.summary() {
            s if s.is_empty() => format!("Fortnite {} · {}", self.version, self.to_code()),
            s => format!("{s} · Fortnite {} · {}", self.version, self.to_code()),
        }
    }
}

/// What the friend pasted: a whole invite, or only an address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum JoinTarget {
    Invite(Invite),
    Address { ip: String, port: u16 },
}

impl JoinTarget {
    pub fn ip(&self) -> &str {
        match self {
            JoinTarget::Invite(i) => &i.ip,
            JoinTarget::Address { ip, .. } => ip,
        }
    }
    pub fn port(&self) -> u16 {
        match self {
            JoinTarget::Invite(i) => i.port,
            JoinTarget::Address { port, .. } => *port,
        }
    }
}

pub const ERR_EMPTY: &str = "Paste your friend's invite code (or their IP address) first.";
pub const ERR_NOT_RECOGNIZED: &str =
    "That isn't an invite code or an IP address. Paste the whole invite your friend copied in Rift (it starts with RIFT1:), or an IP like 100.101.12.7.";
pub const ERR_BROKEN_INVITE: &str =
    "This invite code is incomplete or broken. Ask your friend to press \"Copy invite\" again and paste all of it.";
pub const ERR_NEWER_INVITE: &str = "This invite comes from a newer Rift. Update Rift, then paste it again.";
pub const ERR_BAD_PORT: &str = "The port must be a number from 1 to 65535 (normally 7777).";

fn parse_ipv4(text: &str) -> Option<Ipv4Addr> {
    // Ipv4Addr's parser refuses leading zeros etc. – exactly what we want
    text.parse::<Ipv4Addr>().ok()
}

fn parse_port(text: &str) -> Option<u16> {
    if text.is_empty() || text.len() > 5 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<u16>().ok().filter(|p| *p > 0)
}

fn valid_version(v: &str) -> bool {
    !v.is_empty() && v.len() <= 16 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
}

/// Finds an invite inside pasted text ("Join me in Rift: RIFT1:…" from a chat works too).
/// Returns the code itself (up to the next space or quote).
fn find_invite(text: &str) -> Option<&str> {
    let upper = text.to_ascii_uppercase();
    let start = upper.find("RIFT")?;
    let rest = &text[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '`' | ')' | ']'))
        .unwrap_or(rest.len());
    Some(rest[..end].trim_end_matches(['.', ',', ';']))
}

/// Reads what the friend pasted: an invite code (also inside other text) or `ip[:port]`.
pub fn parse_join_input(text: &str) -> Result<JoinTarget, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err(ERR_EMPTY.into());
    }
    if let Some(code) = find_invite(text) {
        return parse_invite(code).map(JoinTarget::Invite);
    }
    let (ip_text, port) = match text.rsplit_once(':') {
        Some((ip, port)) => (ip, parse_port(port).ok_or_else(|| ERR_BAD_PORT.to_string())?),
        None => (text, GAME_SERVER_PORT),
    };
    let ip = parse_ipv4(ip_text).ok_or_else(|| ERR_NOT_RECOGNIZED.to_string())?;
    if ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() {
        return Err(ERR_NOT_RECOGNIZED.into());
    }
    Ok(JoinTarget::Address { ip: ip.to_string(), port })
}

/// Reads one invite code: `RIFT1:<ip>:<port>:<version>:<cl or ->[:<mode>]` (`RIFT:` = version 1).
pub fn parse_invite(code: &str) -> Result<Invite, String> {
    let parts: Vec<&str> = code.trim().split(':').collect();
    let prefix = parts.first().map(|p| p.to_ascii_uppercase()).unwrap_or_default();
    match prefix.as_str() {
        "RIFT" | "RIFT1" => {}
        p if p.len() > 4 && p[4..].bytes().all(|b| b.is_ascii_digit()) => return Err(ERR_NEWER_INVITE.into()),
        _ => return Err(ERR_BROKEN_INVITE.into()),
    }
    if parts.len() < 4 || parts.len() > 6 {
        return Err(ERR_BROKEN_INVITE.into());
    }
    let ip = parse_ipv4(parts[1]).ok_or_else(|| ERR_BROKEN_INVITE.to_string())?;
    if ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() {
        return Err(ERR_BROKEN_INVITE.into());
    }
    let port = parse_port(parts[2]).ok_or_else(|| ERR_BROKEN_INVITE.to_string())?;
    let version = parts[3].to_string();
    if !valid_version(&version) {
        return Err(ERR_BROKEN_INVITE.into());
    }
    let cl = match parts.get(4).copied().unwrap_or("-") {
        "" | "-" | "0" => None,
        c => Some(c.parse::<u32>().map_err(|_| ERR_BROKEN_INVITE.to_string())?),
    };
    // "team4+bots+late". An unknown mode word (from a newer Rift) is left out instead of refusing
    // the invite; unknown extra words are ignored.
    let words: Vec<String> = parts.get(5).map(|m| m.to_ascii_lowercase()).unwrap_or_default().split('+').map(String::from).collect();
    let mode = words.first().cloned().filter(|m| valid_mode(m));
    let bots = mode.is_some() && words.iter().any(|w| w == "bots");
    let lategame = mode.is_some() && words.iter().any(|w| w == "late");
    Ok(Invite { ip: ip.to_string(), port, version, cl, mode, bots, lategame })
}

// ---- Version matching -----------------------------------------------------------------------

/// "19.1" and "19.10" are the same Fortnite; "1.7.2" and "1.7.1" are not.
pub fn same_version(a: &str, b: &str) -> bool {
    let key = |v: &str| {
        let v = v.trim();
        parse_version_number(v).map(|n| (n, v.split('.').skip(2).collect::<Vec<_>>().join(".")))
    };
    match (key(a), key(b)) {
        (Some(x), Some(y)) => x == y,
        _ => a.trim().eq_ignore_ascii_case(b.trim()),
    }
}

/// Does the friend have the host's Fortnite in the Library?
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum VersionMatch {
    /// Same version and same CL (or one of the CLs is unknown – then it can't be told apart).
    Same { build_id: String, cl_checked: bool },
    /// Same version, but another build (CL): the game refuses to connect.
    OtherCl { build_id: String, have_cl: Option<u32> },
    /// Not in the Library.
    Missing,
}

/// Picks the build to join with: exact CL first, then a build without a known CL, then reports
/// a same-version build with another CL.
pub fn match_build(builds: &[BuildInfo], version: &str, cl: Option<u32>) -> VersionMatch {
    let same: Vec<&BuildInfo> = builds.iter().filter(|b| same_version(&b.version, version)).collect();
    if same.is_empty() {
        return VersionMatch::Missing;
    }
    if let Some(cl) = cl {
        if let Some(b) = same.iter().find(|b| b.changelist == Some(cl)) {
            return VersionMatch::Same { build_id: b.id.clone(), cl_checked: true };
        }
        if let Some(b) = same.iter().find(|b| b.changelist.is_none()) {
            return VersionMatch::Same { build_id: b.id.clone(), cl_checked: false };
        }
        let b = same[0];
        return VersionMatch::OtherCl { build_id: b.id.clone(), have_cl: b.changelist };
    }
    VersionMatch::Same { build_id: same[0].id.clone(), cl_checked: false }
}

/// Catalog key of the host's build when Rift can download it ("19.10-CL-18675304").
pub fn download_key_for(catalog: &crate::epic::catalog::Catalog, version: &str, cl: Option<u32>) -> Option<String> {
    let cl = cl?;
    catalog
        .chapters
        .iter()
        .flat_map(|c| c.seasons.iter())
        .flat_map(|s| s.builds.iter())
        .find(|b| b.cl == cl && same_version(&b.version, version))
        .map(|b| b.key.clone())
}

// ---- Host info ------------------------------------------------------------------------------

/// The host info endpoint's whole answer (`GET /rift-host` on TCP 7777 of the host's VPN/LAN
/// address). Nothing else is ever sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    /// Always "rift"
    pub app: String,
    pub version: String,
    pub cl: Option<u32>,
    /// "starting" (server Fortnite is loading), "waiting" (lobby open, match not started),
    /// "started" (match running), "ended"
    pub phase: String,
    pub players: u32,
    /// UDP port of the game server
    pub port: u16,
}

/// The phase word of the host info from the server's pipe status (`notReady`, `ready`,
/// `joinable`, `started`, `ended`) – `None` while the server hasn't reported yet.
pub fn host_phase(server_phase: Option<&str>) -> &'static str {
    match server_phase {
        Some("started") => "started",
        Some("ended") => "ended",
        Some("joinable") | Some("ready") | Some("notReady") => "waiting",
        _ => "starting",
    }
}

/// Reads and checks the answer (only a small JSON object from Rift counts).
pub fn parse_host_info(body: &str) -> Option<HostInfo> {
    if body.len() > HOST_INFO_MAX_BYTES {
        return None;
    }
    let info: HostInfo = serde_json::from_str(body).ok()?;
    let phase_ok = matches!(info.phase.as_str(), "starting" | "waiting" | "started" | "ended");
    (info.app == "rift" && valid_version(&info.version) && phase_ok && info.port > 0 && info.players <= 1000).then_some(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::version::Support;

    fn build(id: &str, version: &str, cl: Option<u32>) -> BuildInfo {
        BuildInfo {
            id: id.into(),
            version: version.into(),
            changelist: cl,
            season: String::new(),
            engine: String::new(),
            path: String::new(),
            binaries: String::new(),
            support: Support::Supported,
            support_note: String::new(),
            launch_args: String::new(),
        }
    }

    fn ip(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }

    #[test]
    fn invite_round_trip() {
        let inv = Invite {
            ip: "100.101.12.7".into(),
            port: 7777,
            version: "19.10".into(),
            cl: Some(18675304),
            mode: Some("team4".into()),
            bots: true,
            lategame: true,
        };
        let code = inv.to_code();
        assert_eq!(code, "RIFT1:100.101.12.7:7777:19.10:18675304:team4+bots+late");
        assert_eq!(parse_invite(&code).unwrap(), inv);
        assert_eq!(parse_join_input(&code).unwrap(), JoinTarget::Invite(inv.clone()));
        assert_eq!(inv.summary(), "Squad together · bots on · Lategame");
        assert_eq!(
            inv.share_text(),
            "Squad together · bots on · Lategame · Fortnite 19.10 · RIFT1:100.101.12.7:7777:19.10:18675304:team4+bots+late"
        );
        // the whole copied line pasted back gives the same invite
        assert_eq!(parse_join_input(&inv.share_text()).unwrap(), JoinTarget::Invite(inv.clone()));
        // unknown CL and no mode
        let plain = Invite { cl: None, mode: None, bots: false, lategame: false, ..inv };
        assert_eq!(plain.to_code(), "RIFT1:100.101.12.7:7777:19.10:-");
        assert_eq!(parse_invite(&plain.to_code()).unwrap(), plain);
    }

    #[test]
    fn invite_found_inside_chat_text_and_old_prefix() {
        let t = parse_join_input("  Join me! rift1:26.12.0.9:7777:19.10:18675304:vs.  ").unwrap();
        let JoinTarget::Invite(i) = t else { panic!() };
        assert_eq!((i.ip.as_str(), i.port, i.cl, i.mode.as_deref()), ("26.12.0.9", 7777, Some(18675304), Some("vs")));
        // the owner's first example without the format digit
        let i = parse_invite("RIFT:100.101.12.7:7777:19.10:18675304").unwrap();
        assert_eq!((i.version.as_str(), i.mode), ("19.10", None));
        // an unknown mode word from a newer Rift is ignored, not an error
        assert_eq!(parse_invite("RIFT1:10.0.0.2:7777:19.10:-:party+bots").unwrap().mode, None);
        let i = parse_invite("RIFT1:10.0.0.2:7777:19.10:-:vs+late+confetti").unwrap();
        assert_eq!((i.mode.as_deref(), i.bots, i.lategame), (Some("vs"), false, true));
        assert_eq!(i.summary(), "Solo against each other · no bots · Lategame");
    }

    #[test]
    fn broken_invites_have_plain_errors() {
        assert_eq!(parse_join_input("   ").unwrap_err(), ERR_EMPTY);
        assert_eq!(parse_join_input("RIFT2:1.2.3.4:7777:19.10:1").unwrap_err(), ERR_NEWER_INVITE);
        for bad in [
            "RIFT1:100.101.12:7777:19.10:1",
            "RIFT1:100.101.12.7:0:19.10:1",
            "RIFT1:100.101.12.7:99999:19.10:1",
            "RIFT1:100.101.12.7:7777",
            "RIFT1:100.101.12.7:7777:19_10:1",
            "RIFT1:100.101.12.7:7777:19.10:abc",
            "RIFT1:0.0.0.0:7777:19.10:1",
            "RIFTX:1.2.3.4:7777:19.10:1",
        ] {
            assert_eq!(parse_join_input(bad).unwrap_err(), ERR_BROKEN_INVITE, "{bad}");
        }
        assert_eq!(parse_join_input("hello").unwrap_err(), ERR_NOT_RECOGNIZED);
        assert_eq!(parse_join_input("300.1.1.1").unwrap_err(), ERR_NOT_RECOGNIZED);
        assert_eq!(parse_join_input("1.2.3.4:port").unwrap_err(), ERR_BAD_PORT);
    }

    #[test]
    fn plain_addresses() {
        assert_eq!(
            parse_join_input("100.101.12.7").unwrap(),
            JoinTarget::Address { ip: "100.101.12.7".into(), port: 7777 }
        );
        let t = parse_join_input(" 26.1.2.3:7778 ").unwrap();
        assert_eq!((t.ip(), t.port()), ("26.1.2.3", 7778));
        assert_eq!(parse_join_input("127.0.0.1").unwrap().ip(), "127.0.0.1");
    }

    #[test]
    fn address_kinds() {
        assert_eq!(classify(ip("100.101.12.7"), "Tailscale"), Some(NetKind::Tailscale));
        assert_eq!(classify(ip("100.64.0.1"), "Ethernet 3"), Some(NetKind::Tailscale));
        // 100.x outside 100.64.0.0/10 is the public internet, not Tailscale
        assert_eq!(classify(ip("100.20.1.1"), "Ethernet"), None);
        assert_eq!(classify(ip("100.130.1.1"), "Ethernet"), None);
        assert_eq!(classify(ip("26.120.7.55"), "Radmin VPN"), Some(NetKind::Radmin));
        assert_eq!(classify(ip("25.4.5.6"), "Hamachi"), Some(NetKind::Hamachi));
        assert_eq!(classify(ip("10.147.17.3"), "ZeroTier One [8056c2e21c000001]"), Some(NetKind::ZeroTier));
        assert_eq!(classify(ip("192.168.178.20"), "WLAN"), Some(NetKind::Lan));
        assert_eq!(classify(ip("172.20.0.1"), "vEthernet (WSL)"), None);
        assert_eq!(classify(ip("192.168.56.1"), "VirtualBox Host-Only Network"), None);
        assert_eq!(classify(ip("127.0.0.1"), "Loopback"), None);
        assert_eq!(classify(ip("169.254.3.4"), "Ethernet"), None);
        assert_eq!(classify(ip("8.8.8.8"), "Ethernet"), None);
        assert_eq!(classify(ip("0.0.0.0"), "Ethernet"), None);
    }

    #[test]
    fn share_list_puts_vpn_first_and_drops_private_nothing_else() {
        let list = share_list(&[
            ("WLAN".into(), ip("192.168.1.20")),
            ("Loopback Pseudo-Interface 1".into(), ip("127.0.0.1")),
            ("Ethernet".into(), ip("84.12.3.4")),
            ("Radmin VPN".into(), ip("26.1.2.3")),
            ("Tailscale".into(), ip("100.101.12.7")),
        ]);
        let ips: Vec<&str> = list.iter().map(|a| a.ip.as_str()).collect();
        assert_eq!(ips, ["100.101.12.7", "26.1.2.3", "192.168.1.20"]);
        assert_eq!(list[0].label, "Tailscale");
        assert!(list[0].kind.is_vpn() && !list[2].kind.is_vpn());
        // the host info endpoint never listens on public or loopback addresses
        assert!(may_listen_on(ip("100.101.12.7"), "Tailscale"));
        assert!(may_listen_on(ip("192.168.1.20"), "WLAN"));
        assert!(!may_listen_on(ip("84.12.3.4"), "Ethernet"));
        assert!(!may_listen_on(ip("0.0.0.0"), ""));
        assert!(!may_listen_on(ip("127.0.0.1"), "Loopback"));
    }

    #[test]
    fn versions_match() {
        assert!(same_version("19.10", "19.1"));
        assert!(same_version("19.10", "19.10"));
        assert!(!same_version("19.10", "19.01"));
        assert!(!same_version("19.10", "19.20"));
        assert!(!same_version("1.7.2", "1.7.1"));
        assert!(same_version("4.5", "4.5"));
        assert!(same_version("Cert", "cert"));

        let lib = [build("a", "18.30", Some(17882303)), build("b", "19.10", Some(18640491)), build("c", "19.10", Some(18675304))];
        assert_eq!(match_build(&lib, "19.1", Some(18675304)), VersionMatch::Same { build_id: "c".into(), cl_checked: true });
        assert_eq!(match_build(&lib, "19.10", None), VersionMatch::Same { build_id: "b".into(), cl_checked: false });
        assert_eq!(match_build(&lib, "19.10", Some(1)), VersionMatch::OtherCl { build_id: "b".into(), have_cl: Some(18640491) });
        assert_eq!(match_build(&lib, "12.41", Some(1)), VersionMatch::Missing);
        let unknown = [build("u", "19.10", None)];
        assert_eq!(match_build(&unknown, "19.10", Some(18675304)), VersionMatch::Same { build_id: "u".into(), cl_checked: false });
    }

    #[test]
    fn download_key_from_the_builtin_catalog() {
        let cat = crate::epic::catalog::catalog();
        let first = cat.chapters.iter().flat_map(|c| c.seasons.iter()).flat_map(|s| s.builds.iter()).next().cloned();
        if let Some(b) = first {
            assert_eq!(download_key_for(&cat, &b.version, Some(b.cl)), Some(b.key.clone()));
            assert_eq!(download_key_for(&cat, &b.version, None), None);
        }
        assert_eq!(download_key_for(&cat, "19.10", Some(1)), None);
    }

    #[test]
    fn team_modes() {
        assert_eq!(team_size_for_playlist("Playlist_DefaultSolo"), 1);
        assert_eq!(team_size_for_playlist("Playlist_DefaultDuo"), 2);
        assert_eq!(team_size_for_playlist("Playlist_Trios"), 3);
        assert_eq!(team_size_for_playlist("Playlist_NoBuildBR_Squad"), 4);
        assert_eq!(invite_mode(true, "Playlist_DefaultSquad"), "team4");
        assert_eq!(invite_mode(true, "Playlist_DefaultSolo"), "vs");
        assert_eq!(invite_mode(false, "Playlist_DefaultSolo"), "vs");
        assert_eq!(invite_mode(false, "Playlist_DefaultDuo"), "fill2");
        assert!(humans_same_team(true, "Playlist_Trios"));
        assert!(!humans_same_team(true, "Playlist_DefaultSolo"));
        assert!(!humans_same_team(false, "Playlist_DefaultSquad"));
        assert_eq!(match_summary("vs", true, true), "Solo against each other · bots on · Lategame");
        assert_eq!(match_summary("team2", false, false), "Duo together · no bots");
        assert_eq!(match_summary("fill4", true, false), "Squads · bots on");
    }

    #[test]
    fn host_info_answer() {
        let info = HostInfo {
            app: "rift".into(),
            version: "19.10".into(),
            cl: Some(18675304),
            phase: host_phase(Some("joinable")).into(),
            players: 1,
            port: 7777,
        };
        let body = serde_json::to_string(&info).unwrap();
        assert_eq!(body, r#"{"app":"rift","version":"19.10","cl":18675304,"phase":"waiting","players":1,"port":7777}"#);
        assert_eq!(parse_host_info(&body), Some(info));
        assert_eq!(parse_host_info(r#"{"app":"other","version":"19.10","cl":null,"phase":"waiting","players":1,"port":7777}"#), None);
        assert_eq!(parse_host_info("<html>"), None);
        assert_eq!(parse_host_info(&"x".repeat(5000)), None);
        assert_eq!(host_phase(None), "starting");
        assert_eq!(host_phase(Some("started")), "started");
    }
}
