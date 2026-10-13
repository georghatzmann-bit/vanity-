//! Wetter-Widget über Open-Meteo (kein API-Schlüssel nötig).

use serde_json::Value;
use tauri::State;

use crate::error::{http_status_err, net_err, CmdResult};
use crate::models::{GeoPlace, WeatherNow};
use crate::state::Shared;

const FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";
const GEOCODING_URL: &str = "https://geocoding-api.open-meteo.com/v1/search";

async fn get_json(http: &reqwest::Client, url: reqwest::Url) -> CmdResult<Value> {
    let resp = http.get(url).send().await.map_err(|e| net_err(&e))?;
    if !resp.status().is_success() {
        return Err(format!("Wetterdienst: {}", http_status_err(resp.status().as_u16())));
    }
    resp.json::<Value>().await.map_err(|e| net_err(&e))
}

/// Antwort der Forecast-API auswerten.
pub fn parse_forecast(v: &Value, place: &str) -> CmdResult<WeatherNow> {
    let cur = v
        .get("current")
        .ok_or_else(|| "Der Wetterdienst hat keine aktuellen Daten geliefert.".to_string())?;
    let num = |o: &Value, k: &str| o.get(k).and_then(|x| x.as_f64());
    let first = |k: &str| {
        v.get("daily")
            .and_then(|d| d.get(k))
            .and_then(|a| a.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.as_f64())
    };
    let temperature = num(cur, "temperature_2m")
        .ok_or_else(|| "Der Wetterdienst hat keine Temperatur geliefert.".to_string())?;
    Ok(WeatherNow {
        temperature,
        apparent: num(cur, "apparent_temperature").unwrap_or(temperature),
        code: cur.get("weather_code").and_then(|x| x.as_f64()).unwrap_or(0.0) as i64,
        is_day: num(cur, "is_day").map(|d| d >= 1.0).unwrap_or(true),
        wind: num(cur, "wind_speed_10m").unwrap_or(0.0),
        high: first("temperature_2m_max").unwrap_or(temperature),
        low: first("temperature_2m_min").unwrap_or(temperature),
        place: place.to_string(),
    })
}

/// Antwort der Geocoding-API auswerten.
pub fn parse_geocode(v: &Value) -> Vec<GeoPlace> {
    v.get("results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let s = |k: &str| {
                        r.get(k)
                            .and_then(|x| x.as_str())
                            .map(|x| x.to_string())
                            .filter(|x| !x.is_empty())
                    };
                    Some(GeoPlace {
                        name: s("name")?,
                        country: s("country"),
                        admin: s("admin1"),
                        lat: r.get("latitude")?.as_f64()?,
                        lon: r.get("longitude")?.as_f64()?,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn weather(state: State<'_, Shared>, lat: f64, lon: f64, place: String) -> CmdResult<WeatherNow> {
    if !lat.is_finite() || !lon.is_finite() || lat.abs() > 90.0 || lon.abs() > 180.0 {
        return Err("Ungültiger Ort.".into());
    }
    let url = reqwest::Url::parse_with_params(
        FORECAST_URL,
        &[
            ("latitude", format!("{lat:.4}")),
            ("longitude", format!("{lon:.4}")),
            (
                "current",
                "temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m".into(),
            ),
            ("daily", "temperature_2m_max,temperature_2m_min".into()),
            ("timezone", "auto".into()),
            ("forecast_days", "1".into()),
        ],
    )
    .map_err(|e| e.to_string())?;
    let v = get_json(&state.http, url).await?;
    parse_forecast(&v, &place)
}

#[tauri::command]
pub async fn geocode(state: State<'_, Shared>, query: String, lang: Option<String>) -> CmdResult<Vec<GeoPlace>> {
    let q = query.trim();
    if q.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let lang = lang
        .map(|l| l.trim().to_lowercase())
        .filter(|l| l.len() == 2 && l.chars().all(|c| c.is_ascii_alphabetic()))
        .unwrap_or_else(|| "de".into());
    let url = reqwest::Url::parse_with_params(
        GEOCODING_URL,
        &[
            ("name", q.to_string()),
            ("count", "6".into()),
            ("language", lang),
            ("format", "json".into()),
        ],
    )
    .map_err(|e| e.to_string())?;
    let v = get_json(&state.http, url).await?;
    Ok(parse_geocode(&v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn forecast_parsing() {
        let v = json!({
            "current": {"temperature_2m": 12.3, "apparent_temperature": 10.1, "weather_code": 3, "is_day": 1, "wind_speed_10m": 14.2},
            "daily": {"temperature_2m_max": [15.0], "temperature_2m_min": [6.5]}
        });
        let w = parse_forecast(&v, "Wien").unwrap();
        assert_eq!(w.temperature, 12.3);
        assert_eq!(w.code, 3);
        assert!(w.is_day);
        assert_eq!(w.high, 15.0);
        assert_eq!(w.low, 6.5);
        assert_eq!(w.place, "Wien");
        assert!(parse_forecast(&json!({}), "x").is_err());
    }

    #[test]
    fn geocode_parsing() {
        let v = json!({"results": [
            {"name": "Berlin", "country": "Deutschland", "admin1": "Berlin", "latitude": 52.52, "longitude": 13.41},
            {"name": "Kaputt"}
        ]});
        let r = parse_geocode(&v);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].admin.as_deref(), Some("Berlin"));
        assert!(parse_geocode(&json!({"generationtime_ms": 0.1})).is_empty());
    }
}
