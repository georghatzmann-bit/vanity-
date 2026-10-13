//! Echte Spielserver: Valve-Relays (CS2, Dota 2, Deadlock) aus der öffentlichen SDR-Konfiguration
//! und die bekannten Riot-Ping-Adressen für League of Legends. Die Valve-Liste wird eine Stunde im
//! Speicher gehalten.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;

use super::types::{PingMethod, PingTarget, Region};
use crate::error::net_err;

/// So lange bleibt eine geladene Liste gültig.
pub const CACHE_TTL: Duration = Duration::from_secs(60 * 60);
/// Zeitlimit für den Abruf bei Valve.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(8);

/// Steam-AppID zu einem Spiel-Schlüssel.
pub fn steam_app_id(game: &str) -> Option<u32> {
    match game {
        "cs2" => Some(730),
        "dota2" => Some(570),
        "deadlock" => Some(1_422_450),
        _ => None,
    }
}

/// URL der SDR-Konfiguration eines Spiels.
pub fn sdr_url(app_id: u32) -> String {
    format!("https://api.steampowered.com/ISteamApps/GetSDRConfig/v1?appid={app_id}")
}

/// Zwischenspeicher für geladene Serverlisten (je Spiel).
#[derive(Default)]
pub struct ServerCache {
    entries: Mutex<HashMap<String, (Instant, Vec<Region>)>>,
}

impl ServerCache {
    /// Gültige Liste holen (None, wenn nicht vorhanden oder abgelaufen).
    pub fn get(&self, game: &str) -> Option<Vec<Region>> {
        let map = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        map.get(game)
            .filter(|(at, _)| at.elapsed() < CACHE_TTL)
            .map(|(_, list)| list.clone())
    }

    pub fn put(&self, game: &str, list: Vec<Region>) {
        let mut map = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(game.to_string(), (Instant::now(), list));
    }
}

// ---------------------------------------------------------------------------------------------
// Valve SDR
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct SdrConfig {
    #[serde(default)]
    pops: HashMap<String, SdrPop>,
}

#[derive(Debug, Deserialize)]
struct SdrPop {
    #[serde(default)]
    desc: Option<String>,
    #[serde(default)]
    relays: Vec<SdrRelay>,
}

#[derive(Debug, Deserialize)]
struct SdrRelay {
    #[serde(default)]
    ipv4: Option<String>,
}

/// SDR-JSON in Regionen umwandeln: eine je POP mit mindestens einem Relay, sortiert nach Name.
pub fn parse_sdr(game: &str, json: &str) -> Result<Vec<Region>, String> {
    let cfg: SdrConfig = serde_json::from_str(json)
        .map_err(|_| "Die Antwort von Steam hat ein unerwartetes Format.".to_string())?;
    let mut out: Vec<Region> = cfg
        .pops
        .into_iter()
        .filter_map(|(code, pop)| {
            let host = pop
                .relays
                .iter()
                .filter_map(|r| r.ipv4.as_deref())
                .map(str::trim)
                .find(|ip| ip.parse::<std::net::Ipv4Addr>().is_ok())?
                .to_string();
            let code = code.trim().to_ascii_lowercase();
            if code.is_empty() {
                return None;
            }
            let (country, area) = pop_location(&code);
            let name = pop
                .desc
                .map(|d| d.trim().to_string())
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| code.to_ascii_uppercase());
            let id = format!("valve-{game}-{code}");
            Some(Region {
                id: id.clone(),
                name: name.clone(),
                country: country.into(),
                area: area.into(),
                provider: "Valve".into(),
                target: PingTarget { id, label: name, host, port: None, method: PingMethod::Icmp },
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    Ok(out)
}

/// Land und Weltregion zu einem Valve-POP-Code (bestmöglich; unbekannt → leeres Land, Weltregion
/// nach Faustregel).
pub fn pop_location(code: &str) -> (&'static str, &'static str) {
    match code {
        // Europa
        "fra" | "fra2" | "fra3" => ("DE", "eu"),
        "ams" | "ams2" => ("NL", "eu"),
        "lhr" | "lhr2" | "lon" => ("GB", "eu"),
        "par" | "cdg" => ("FR", "eu"),
        "sto" | "sto2" | "sto3" | "arn" => ("SE", "eu"),
        "vie" | "vie2" => ("AT", "eu"),
        "mad" => ("ES", "eu"),
        "mil" | "mxp" => ("IT", "eu"),
        "waw" => ("PL", "eu"),
        "hel" => ("FI", "eu"),
        "osl" => ("NO", "eu"),
        "cph" => ("DK", "eu"),
        "dub" => ("IE", "eu"),
        "zrh" => ("CH", "eu"),
        "bru" => ("BE", "eu"),
        "prg" => ("CZ", "eu"),
        "bud" => ("HU", "eu"),
        "lis" => ("PT", "eu"),
        "ath" => ("GR", "eu"),
        "buh" | "otp" => ("RO", "eu"),
        "sof" => ("BG", "eu"),
        "mos" | "svo" => ("RU", "eu"),
        "led" => ("RU", "eu"),
        "ist" => ("TR", "eu"),
        "kyi" | "iev" => ("UA", "eu"),
        // Nordamerika
        "iad" | "iad2" | "iad3" | "was" => ("US", "na"),
        "ord" | "ord2" | "chi" => ("US", "na"),
        "atl" | "atl2" => ("US", "na"),
        "dfw" | "dfw2" | "dal" => ("US", "na"),
        "lax" | "lax2" => ("US", "na"),
        "sea" | "sea2" => ("US", "na"),
        "sjc" | "sfo" => ("US", "na"),
        "den" => ("US", "na"),
        "mia" => ("US", "na"),
        "jfk" | "ewr" | "nyc" | "lga" => ("US", "na"),
        "okc" => ("US", "na"),
        "slc" => ("US", "na"),
        "phx" => ("US", "na"),
        "yyz" | "tor" => ("CA", "na"),
        "yvr" => ("CA", "na"),
        "ymq" | "yul" => ("CA", "na"),
        "mex" | "qro" => ("MX", "na"),
        // Südamerika
        "gru" | "gru2" | "sao" => ("BR", "sa"),
        "gig" | "rio" => ("BR", "sa"),
        "for" => ("BR", "sa"),
        "eze" | "bue" => ("AR", "sa"),
        "scl" => ("CL", "sa"),
        "lim" => ("PE", "sa"),
        "bog" => ("CO", "sa"),
        // Asien
        "sgp" | "sin" => ("SG", "asia"),
        "tyo" | "tyo1" | "tyo2" | "nrt" | "hnd" => ("JP", "asia"),
        "osa" | "kix" => ("JP", "asia"),
        "seo" | "icn" | "sel" => ("KR", "asia"),
        "hkg" => ("HK", "asia"),
        "tpe" | "tsn" => ("TW", "asia"),
        "bom" | "maa" | "del" | "hyd" => ("IN", "asia"),
        "sha" | "pek" | "can" | "pwg" | "pwj" | "pwu" | "pww" | "pwz" | "ctu" | "tsnc" => ("CN", "asia"),
        "man" | "kul" => ("MY", "asia"),
        "jkt" | "cgk" => ("ID", "asia"),
        "bkk" => ("TH", "asia"),
        "mnl" => ("PH", "asia"),
        "hcm" | "sgn" | "han" => ("VN", "asia"),
        // Ozeanien
        "syd" | "syd2" => ("AU", "oce"),
        "mel" => ("AU", "oce"),
        "per" => ("AU", "oce"),
        "bne" => ("AU", "oce"),
        "akl" => ("NZ", "oce"),
        // Naher Osten
        "dxb" => ("AE", "me"),
        "bah" => ("BH", "me"),
        "doh" => ("QA", "me"),
        "tlv" => ("IL", "me"),
        "ruh" | "jed" => ("SA", "me"),
        // Afrika
        "jnb" | "jhb" => ("ZA", "af"),
        "cpt" => ("ZA", "af"),
        "lag" | "los" => ("NG", "af"),
        "nbo" => ("KE", "af"),
        "cai" => ("EG", "af"),
        _ => ("", area_heuristic(code)),
    }
}

/// Faustregel für unbekannte POP-Codes: Valve-Codes für Nordamerika sind meist Flughafen-Codes
/// aus den USA; alles Unbekannte landet ehrlich in „na“ nur, wenn der Code so aussieht, sonst
/// „eu“ als häufigste Spielergegend. (Die Tabelle oben deckt die realen POPs ab.)
fn area_heuristic(code: &str) -> &'static str {
    if code.starts_with("pw") {
        "asia"
    } else if code.starts_with('y') {
        "na"
    } else {
        "eu"
    }
}

/// Liste für ein Valve-Spiel laden (ohne Zwischenspeicher).
pub async fn fetch_valve(client: &reqwest::Client, game: &str, app_id: u32) -> Result<Vec<Region>, String> {
    let resp = client
        .get(sdr_url(app_id))
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Die Serverliste konnte nicht geladen werden: {}", net_err(&e)))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Die Serverliste konnte nicht geladen werden: {}",
            crate::error::http_status_err(resp.status().as_u16())
        ));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Die Serverliste konnte nicht geladen werden: {}", net_err(&e)))?;
    let list = parse_sdr(game, &text).map_err(|e| format!("Die Serverliste konnte nicht geladen werden: {e}"))?;
    if list.is_empty() {
        return Err("Die Serverliste konnte nicht geladen werden: Steam hat keine Server gemeldet.".into());
    }
    Ok(list)
}

// ---------------------------------------------------------------------------------------------
// Riot (League of Legends)
// ---------------------------------------------------------------------------------------------

/// Öffentlich bekannte Ping-Adressen der Riot-Regionen (Riot veröffentlicht sie zum Testen der
/// Verbindung). Antwortet eine nicht mehr, zeigt die Messung ehrlich 100 % Verlust.
const RIOT: &[(&str, &str, &str, &str, &str)] = &[
    // (Kürzel, Name, Land, Weltregion, IP)
    ("euw", "EUW (Westeuropa)", "NL", "eu", "104.160.141.3"),
    ("eune", "EUNE (Nordosteuropa)", "DE", "eu", "104.160.142.3"),
    ("na", "NA (Nordamerika)", "US", "na", "104.160.131.3"),
    ("lan", "LAN (Lateinamerika Nord)", "US", "na", "104.160.136.3"),
    ("br", "BR (Brasilien)", "BR", "sa", "104.160.152.3"),
    ("oce", "OCE (Ozeanien)", "AU", "oce", "104.160.156.1"),
];

/// Statische Riot-Liste.
pub fn riot_regions() -> Vec<Region> {
    RIOT.iter()
        .map(|(code, name, country, area, ip)| {
            let id = format!("riot-{code}");
            Region {
                id: id.clone(),
                name: (*name).into(),
                country: (*country).into(),
                area: (*area).into(),
                provider: "Riot".into(),
                target: PingTarget { id, label: (*name).into(), host: (*ip).into(), port: None, method: PingMethod::Icmp },
            }
        })
        .collect()
}

/// Spiel-Schlüssel aus der Oberfläche normalisieren (`CS2`, ` dota2 ` …).
pub fn normalize_game(game: &str) -> String {
    game.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    const FIXTURE: &str = r#"{
        "revision": 2401,
        "pops": {
            "fra": { "desc": "Frankfurt", "geo": [8.68, 50.11], "partners": 3,
                     "relays": [ { "ipv4": "155.133.248.34", "port_range": [27015, 27050] },
                                 { "ipv4": "155.133.248.35", "port_range": [27015, 27050] } ] },
            "iad": { "desc": "Virginia", "relays": [ { "ipv4": " 162.254.192.72 ", "port_range": [27015, 27050] } ] },
            "sto": { "relays": [ { "ipv4": "155.133.252.5" } ] },
            "ord": { "desc": "Chicago" },
            "xyz": { "desc": "Nirgendwo", "relays": [ { "ipv4": "not-an-ip" } ] },
            "pwg": { "desc": "Guangzhou (Perfect World)", "relays": [ { "ipv4": "1.2.3.4" } ] }
        },
        "certs": [], "revoked_keys": [], "p2p_share_ip": {}
    }"#;

    #[test]
    fn sdr_fixture_parses_into_regions() {
        let regions = parse_sdr("cs2", FIXTURE).expect("parse");
        let ids: Vec<&str> = regions.iter().map(|r| r.id.as_str()).collect();
        // sortiert nach Name; POPs ohne gültiges Relay fehlen
        assert_eq!(ids, vec!["valve-cs2-fra", "valve-cs2-pwg", "valve-cs2-sto", "valve-cs2-iad"]);
        let fra = &regions[0];
        assert_eq!(fra.name, "Frankfurt");
        assert_eq!(fra.country, "DE");
        assert_eq!(fra.area, "eu");
        assert_eq!(fra.provider, "Valve");
        assert_eq!(fra.target.host, "155.133.248.34", "erstes Relay");
        assert_eq!(fra.target.method, PingMethod::Icmp);
        assert_eq!(fra.target.id, fra.id);
        let sto = regions.iter().find(|r| r.id == "valve-cs2-sto").unwrap();
        assert_eq!(sto.name, "STO", "ohne desc: Code in Großbuchstaben");
        assert_eq!(sto.country, "SE");
        let iad = regions.iter().find(|r| r.id == "valve-cs2-iad").unwrap();
        assert_eq!(iad.target.host, "162.254.192.72", "Leerzeichen entfernt");
        assert_eq!(iad.area, "na");
        let pwg = regions.iter().find(|r| r.id == "valve-cs2-pwg").unwrap();
        assert_eq!((pwg.country.as_str(), pwg.area.as_str()), ("CN", "asia"));
    }

    #[test]
    fn sdr_rejects_garbage_and_tolerates_empty() {
        assert!(parse_sdr("cs2", "nicht json").is_err());
        assert!(parse_sdr("cs2", "{}").unwrap().is_empty());
        assert!(parse_sdr("cs2", r#"{"pops":{}}"#).unwrap().is_empty());
    }

    #[test]
    fn pop_location_table_and_heuristic() {
        assert_eq!(pop_location("ams"), ("NL", "eu"));
        assert_eq!(pop_location("syd"), ("AU", "oce"));
        assert_eq!(pop_location("dxb"), ("AE", "me"));
        assert_eq!(pop_location("jnb"), ("ZA", "af"));
        assert_eq!(pop_location("gru"), ("BR", "sa"));
        let (country, area) = pop_location("qqq");
        assert_eq!(country, "", "unbekannt → kein erfundenes Land");
        assert!(super::super::regions::AREAS.contains(&area));
        assert_eq!(pop_location("pwx").1, "asia");
    }

    #[test]
    fn riot_list_is_consistent() {
        let r = riot_regions();
        assert!(r.len() >= 3);
        let ids: HashSet<&str> = r.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids.len(), r.len());
        assert!(ids.contains("riot-euw") && ids.contains("riot-eune") && ids.contains("riot-na"));
        for x in &r {
            assert_eq!(x.provider, "Riot");
            assert_eq!(x.target.method, PingMethod::Icmp);
            assert!(x.target.host.parse::<std::net::Ipv4Addr>().is_ok(), "{}", x.target.host);
            assert!(super::super::regions::AREAS.contains(&x.area.as_str()));
        }
    }

    #[test]
    fn app_ids_and_cache() {
        assert_eq!(steam_app_id("cs2"), Some(730));
        assert_eq!(steam_app_id("dota2"), Some(570));
        assert_eq!(steam_app_id("deadlock"), Some(1_422_450));
        assert_eq!(steam_app_id("lol"), None);
        assert_eq!(normalize_game("  CS2 "), "cs2");
        assert!(sdr_url(730).ends_with("appid=730"));

        let cache = ServerCache::default();
        assert!(cache.get("cs2").is_none());
        cache.put("cs2", riot_regions());
        assert_eq!(cache.get("cs2").map(|l| l.len()), Some(riot_regions().len()));
        assert!(cache.get("dota2").is_none());
    }
}
