//! Fester Katalog von Rechenzentren (AWS-Regionen), gemessen per TCP:443 auf den regionalen
//! DynamoDB-Endpunkt – der antwortet überall gleich schnell und braucht keine Anmeldung.

use futures_util::stream::{self, StreamExt};

use super::ping;
use super::types::{PingMethod, PingTarget, Region, RegionPing};

/// Höchstens so viele Regionen gleichzeitig messen.
pub const MAX_PARALLEL: usize = 8;

/// Gültige Werte für `Region::area` (Prüfliste für Tests).
#[cfg_attr(not(test), allow(dead_code))]
pub const AREAS: [&str; 7] = ["eu", "na", "sa", "asia", "oce", "me", "af"];

/// (AWS-Regionscode, Anzeigename, Land, Weltregion)
const AWS: &[(&str, &str, &str, &str)] = &[
    // Europa
    ("eu-central-1", "Frankfurt", "DE", "eu"),
    ("eu-west-3", "Paris", "FR", "eu"),
    ("eu-west-2", "London", "GB", "eu"),
    ("eu-north-1", "Stockholm", "SE", "eu"),
    ("eu-south-1", "Mailand", "IT", "eu"),
    ("eu-west-1", "Irland", "IE", "eu"),
    ("eu-south-2", "Spanien", "ES", "eu"),
    ("eu-central-2", "Zürich", "CH", "eu"),
    // Nordamerika
    ("us-east-1", "US-Ost (Virginia)", "US", "na"),
    ("us-east-2", "US-Ost (Ohio)", "US", "na"),
    ("us-west-1", "US-West (Kalifornien)", "US", "na"),
    ("us-west-2", "US-West (Oregon)", "US", "na"),
    ("ca-central-1", "Kanada", "CA", "na"),
    ("ca-west-1", "Kanada West (Calgary)", "CA", "na"),
    // Südamerika
    ("sa-east-1", "São Paulo", "BR", "sa"),
    // Asien
    ("ap-southeast-1", "Singapur", "SG", "asia"),
    ("ap-northeast-1", "Tokio", "JP", "asia"),
    ("ap-northeast-3", "Osaka", "JP", "asia"),
    ("ap-northeast-2", "Seoul", "KR", "asia"),
    ("ap-south-1", "Mumbai", "IN", "asia"),
    ("ap-south-2", "Hyderabad", "IN", "asia"),
    ("ap-east-1", "Hongkong", "HK", "asia"),
    ("ap-southeast-3", "Jakarta", "ID", "asia"),
    // Ozeanien
    ("ap-southeast-2", "Sydney", "AU", "oce"),
    ("ap-southeast-4", "Melbourne", "AU", "oce"),
    // Naher Osten
    ("me-south-1", "Bahrain", "BH", "me"),
    ("me-central-1", "VAE (Dubai)", "AE", "me"),
    ("il-central-1", "Tel Aviv", "IL", "me"),
    // Afrika
    ("af-south-1", "Kapstadt", "ZA", "af"),
];

/// Alle Regionen (stabile IDs wie `aws-eu-central-1`).
pub fn all() -> Vec<Region> {
    AWS.iter()
        .map(|(code, name, country, area)| {
            let id = format!("aws-{code}");
            Region {
                id: id.clone(),
                name: (*name).into(),
                country: (*country).into(),
                area: (*area).into(),
                provider: "AWS".into(),
                target: PingTarget {
                    id,
                    label: (*name).into(),
                    host: format!("dynamodb.{code}.amazonaws.com"),
                    port: Some(ping::DEFAULT_TCP_PORT),
                    method: PingMethod::Tcp,
                },
            }
        })
        .collect()
}

/// Auswahl: `ids` leer/None → alle; unbekannte IDs werden ignoriert. Reihenfolge wie im Katalog.
pub fn select(ids: Option<&[String]>) -> Vec<Region> {
    let regions = all();
    match ids {
        Some(ids) if !ids.is_empty() => regions.into_iter().filter(|r| ids.iter().any(|i| i == &r.id)).collect(),
        _ => regions,
    }
}

/// Mehrere Ziele gleichzeitig messen (höchstens [`MAX_PARALLEL`] parallel). Ein nicht auflösbares
/// Ziel erscheint ehrlich als 100 % Verlust statt als Fehler für alle.
pub async fn ping_many(regions: &[Region], count: u32) -> Vec<RegionPing> {
    // Eigene Kopien je Ziel: so braucht der Strom keine Lebensdauer-Bindung an `regions`
    // (sonst kann der Befehl nicht als `Send`-Future gebaut werden).
    let owned: Vec<(usize, PingTarget, String)> =
        regions.iter().enumerate().map(|(i, r)| (i, r.target.clone(), r.id.clone())).collect();
    let mut results: Vec<(usize, RegionPing)> = stream::iter(owned)
        .map(|(i, target, id)| async move {
            let stats = match ping::ping_series(&target, count).await {
                Ok(s) => s,
                Err(_) => ping::all_lost(&target.id, count),
            };
            (i, RegionPing { id, stats })
        })
        .buffer_unordered(MAX_PARALLEL)
        .collect()
        .await;
    results.sort_by_key(|(i, _)| *i);
    results.into_iter().map(|(_, r)| r).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn catalogue_is_sane() {
        let regions = all();
        assert!(regions.len() >= 25, "{}", regions.len());
        let ids: HashSet<&str> = regions.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids.len(), regions.len(), "IDs müssen eindeutig sein");
        for area in AREAS {
            assert!(regions.iter().any(|r| r.area == area), "Weltregion {area} fehlt");
        }
        for r in &regions {
            assert!(r.id.starts_with("aws-"));
            assert_eq!(r.target.id, r.id);
            assert_eq!(r.target.method, PingMethod::Tcp);
            assert_eq!(r.target.port, Some(443));
            assert!(r.target.host.starts_with("dynamodb.") && r.target.host.ends_with(".amazonaws.com"), "{}", r.target.host);
            assert_eq!(r.country.len(), 2, "ISO-Code: {}", r.country);
            assert!(AREAS.contains(&r.area.as_str()));
            assert_eq!(r.provider, "AWS");
        }
    }

    #[test]
    fn catalogue_contains_the_documented_minimum() {
        let regions = all();
        for id in [
            "aws-eu-central-1", "aws-eu-west-3", "aws-eu-west-2", "aws-eu-north-1", "aws-eu-south-1", "aws-eu-west-1",
            "aws-eu-south-2", "aws-eu-central-2", "aws-us-east-1", "aws-us-east-2", "aws-us-west-2", "aws-ca-central-1",
            "aws-sa-east-1", "aws-ap-southeast-1", "aws-ap-northeast-1", "aws-ap-northeast-2", "aws-ap-south-1",
            "aws-ap-southeast-2", "aws-me-south-1", "aws-af-south-1",
        ] {
            assert!(regions.iter().any(|r| r.id == id), "{id} fehlt");
        }
    }

    #[test]
    fn select_filters_and_ignores_unknown_ids() {
        assert_eq!(select(None).len(), all().len());
        assert_eq!(select(Some(&[])).len(), all().len());
        let picked = select(Some(&["aws-eu-west-3".to_string(), "gibt-es-nicht".to_string(), "aws-eu-central-1".to_string()]));
        let ids: Vec<&str> = picked.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["aws-eu-central-1", "aws-eu-west-3"], "Katalog-Reihenfolge bleibt");
    }

    #[tokio::test]
    async fn ping_many_keeps_order_and_marks_unresolvable_as_lost() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let mk = |id: &str, host: &str| Region {
            id: id.into(),
            name: id.into(),
            country: "DE".into(),
            area: "eu".into(),
            provider: "Test".into(),
            target: PingTarget { id: id.into(), label: id.into(), host: host.into(), port: Some(port), method: PingMethod::Tcp },
        };
        let regions = vec![mk("ok", "127.0.0.1"), mk("bad", "host.invalid"), mk("ok2", "127.0.0.1")];
        let res = ping_many(&regions, 1).await;
        assert_eq!(res.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["ok", "bad", "ok2"]);
        assert_eq!(res[0].stats.loss, 0.0);
        assert_eq!(res[1].stats.loss, 1.0);
        assert_eq!(res[1].stats.samples, 1);
    }
}
