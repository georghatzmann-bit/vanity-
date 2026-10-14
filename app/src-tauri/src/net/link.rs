//! Hauptverbindung, Netz-Kennung und VPN (Vertrag: `docs/API.md`, „Hauptverbindung, Netz und
//! Verbindungsart“). Zwischengespeichert in `NetState.link`, damit der Monitor-Takt nie
//! `GetAdaptersAddresses` aufruft.
//!
//! Gerüst (Phase 0a): Typen und Signaturen stehen fest; `refresh` liefert unter Windows noch `None`
//! (Umsetzung: Lag-Detektiv, F1). Außerhalb von Windows gilt der Ersatzweg aus dem Vertrag.
#![allow(dead_code)]

use std::net::Ipv4Addr;

use serde::{Deserialize, Serialize};

use super::adapters::RawAdapter;
use super::hist_types::ConnectionKind;

/// Art der Hauptverbindung (ohne VPN – das ist ein eigenes Merkmal).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    Wifi,
    Ethernet,
    /// USB-Tethering, LTE-Stick, unbekannte Adapter
    Other,
}

impl LinkKind {
    /// Aus dem Adaptertyp (`IfType` 6 = Ethernet, 71 = WLAN).
    pub fn from_if_type(if_type: u32) -> Self {
        match if_type {
            6 => LinkKind::Ethernet,
            71 => LinkKind::Wifi,
            _ => LinkKind::Other,
        }
    }
}

/// Die Hauptverbindung zum Zeitpunkt `at`.
#[derive(Debug, Clone, PartialEq)]
pub struct PrimaryLink {
    /// `NET_LUID` (für `GetIfEntry2`)
    pub luid: u64,
    pub if_index: u32,
    /// Adapter-GUID (`AdapterInfo.id`)
    pub adapter_id: String,
    /// Anzeigename des Adapters (für `IfCounters.adapter`)
    pub adapter: String,
    pub kind: LinkKind,
    /// Nur IPv4 (ein reines IPv6-Gateway gilt als „kein Gateway“)
    pub gateway: Option<Ipv4Addr>,
    /// Kennung des Netzes (12 Hex-Zeichen, `""` = unbekannt)
    pub net_id: String,
    /// Verkehr läuft vermutlich über ein VPN
    pub vpn: bool,
    /// Zeitpunkt der Ermittlung (ms)
    pub at: i64,
}

/// Die Teile der Hauptverbindung, die der Recorder je Takt braucht (billig zu kopieren).
#[derive(Debug, Clone, PartialEq)]
pub struct PrimaryLinkLite {
    pub luid: u64,
    pub if_index: u32,
    pub kind: LinkKind,
    pub gateway: Option<Ipv4Addr>,
    pub net_id: String,
    pub vpn: bool,
    pub at: i64,
}

impl PrimaryLink {
    pub fn lite(&self) -> PrimaryLinkLite {
        PrimaryLinkLite {
            luid: self.luid,
            if_index: self.if_index,
            kind: self.kind,
            gateway: self.gateway,
            net_id: self.net_id.clone(),
            vpn: self.vpn,
            at: self.at,
        }
    }
}

impl PrimaryLinkLite {
    /// Verbindungsart für `ping_hourly`/`net_events` (`vpn` hat Vorrang).
    pub fn connection(&self) -> ConnectionKind {
        if self.vpn {
            return ConnectionKind::Vpn;
        }
        match self.kind {
            LinkKind::Wifi => ConnectionKind::Wifi,
            LinkKind::Ethernet => ConnectionKind::Ethernet,
            LinkKind::Other => ConnectionKind::Other,
        }
    }
}

/// Mindestabstand zwischen zwei Ermittlungen (vom Monitor-Hook ausgelöst).
pub const REFRESH_EVERY_MS: i64 = 30_000;

/// Hauptverbindung neu ermitteln (blockierend – nur in `spawn_blocking` aufrufen). `target` = IPv4
/// des Messziels für die VPN-Erkennung (ohne Ziel: `1.1.1.1`).
pub fn refresh(target: Option<Ipv4Addr>, now: i64) -> Option<PrimaryLink> {
    #[cfg(windows)]
    {
        let _ = (target, now);
        None
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Some(PrimaryLink {
            luid: 0,
            if_index: 0,
            adapter_id: String::new(),
            adapter: String::new(),
            kind: LinkKind::Other,
            gateway: None,
            net_id: String::new(),
            vpn: false,
            at: now,
        })
    }
}

/// VPN-Erkennung (rein): anderer Schnittstellen-Index für das Ziel als die Hauptverbindung, oder ein
/// aktiver Tunnel-Adapter mit Standard-Gateway.
pub fn vpn_from(best_index: Option<u32>, primary_index: u32, adapters: &[RawAdapter]) -> bool {
    let _ = (best_index, primary_index, adapters);
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_prefers_vpn() {
        let mut l = PrimaryLink {
            luid: 1,
            if_index: 2,
            adapter_id: "{a}".into(),
            adapter: "WLAN".into(),
            kind: LinkKind::Wifi,
            gateway: Some(Ipv4Addr::new(192, 168, 178, 1)),
            net_id: "abc".into(),
            vpn: false,
            at: 5,
        }
        .lite();
        assert_eq!(l.connection(), ConnectionKind::Wifi);
        l.vpn = true;
        assert_eq!(l.connection(), ConnectionKind::Vpn);
        assert_eq!(LinkKind::from_if_type(6), LinkKind::Ethernet);
        assert_eq!(LinkKind::from_if_type(71), LinkKind::Wifi);
        assert_eq!(LinkKind::from_if_type(243), LinkKind::Other);
        assert_eq!(serde_json::to_value(LinkKind::Ethernet).unwrap(), "ethernet");
    }

    #[cfg(not(windows))]
    #[test]
    fn fallback_outside_windows() {
        let l = refresh(None, 9).unwrap();
        assert_eq!(l.kind, LinkKind::Other);
        assert_eq!(l.gateway, None);
        assert_eq!(l.net_id, "");
        assert!(!l.vpn);
    }
}
