//! Leck-Check (P7.5): Abfragen bei Have I Been Pwned – nur auf Knopfdruck.
//!
//! - `leak_password_range` bekommt nur die ersten fünf Zeichen des SHA-1-Werts (k-Anonymität);
//!   das Passwort selbst und der vollständige Hash bleiben in der Oberfläche.
//! - `leak_email_check` fragt mit dem eigenen API-Schlüssel des Nutzers; der Schlüssel wird
//!   nicht gespeichert.

use aegis_netwatch::leak::{EmailResult, RangeEntry, valid_api_key, valid_email, valid_prefix};

/// Range-Abfrage (mit Füll-Einträgen, damit die Antwortgröße nichts verrät).
#[tauri::command]
pub async fn leak_password_range(prefix: String) -> Result<Vec<RangeEntry>, String> {
    if !valid_prefix(&prefix) {
        return Err("invalid_input".to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || range(&prefix))
        .await
        .map_err(|e| e.to_string())?
}

/// Abfrage einer E-Mail-Adresse mit eigenem Schlüssel.
#[tauri::command]
pub async fn leak_email_check(email: String, api_key: String) -> Result<EmailResult, String> {
    let email = email.trim().to_owned();
    let api_key = api_key.trim().to_owned();
    if !valid_email(&email) || !valid_api_key(&api_key) {
        return Err("invalid_input".to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || breaches(&email, &api_key))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn range(prefix: &str) -> Result<Vec<RangeEntry>, String> {
    use aegis_netwatch::leak::{MAX_RESPONSE, RANGE_HOST, parse_range};
    let response = aegis_winffi::http::https_get(
        RANGE_HOST,
        &format!("/range/{prefix}"),
        &[("Add-Padding", "true")],
        MAX_RESPONSE,
        15_000,
    )
    .map_err(|_| "unavailable".to_owned())?;
    if response.status != 200 {
        return Err("unavailable".to_owned());
    }
    Ok(parse_range(&String::from_utf8_lossy(&response.body)))
}

#[cfg(windows)]
fn breaches(email: &str, api_key: &str) -> Result<EmailResult, String> {
    use aegis_netwatch::leak::{API_HOST, MAX_RESPONSE, breach_path, email_result};
    let response = aegis_winffi::http::https_get(
        API_HOST,
        &breach_path(email),
        &[("hibp-api-key", api_key)],
        MAX_RESPONSE,
        15_000,
    )
    .map_err(|_| "unavailable".to_owned())?;
    Ok(email_result(response.status, &response.body))
}

#[cfg(not(windows))]
fn range(_prefix: &str) -> Result<Vec<RangeEntry>, String> {
    Err("windows_only".to_owned())
}

#[cfg(not(windows))]
fn breaches(_email: &str, _api_key: &str) -> Result<EmailResult, String> {
    Err("windows_only".to_owned())
}
