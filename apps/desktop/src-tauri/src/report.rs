//! Bericht als HTML-Datei: Der Verlauf kommt vom Dienst, die Seite wird **hier** erzeugt (alle
//! Texte maskiert, keine Skripte, keine externen Quellen) und an einen Ort gespeichert, den der
//! Nutzer im Speichern-Dialog von Windows wählt. Die Oberfläche kann weder Inhalt noch Pfad
//! vorgeben – sie löst nur den Export aus.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Maskiert Text für HTML.
#[must_use]
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            // Steuer- und Richtungszeichen sichtbar machen statt sie wirken zu lassen.
            c if c.is_control() && c != '\n' => {
                out.push_str(&format!("\\u{{{:04x}}}", u32::from(c)))
            }
            '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{200e}' | '\u{200f}' => {
                out.push_str(&format!("\\u{{{:04x}}}", u32::from(c)));
            }
            c => out.push(c),
        }
    }
    out
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn kind_label(kind: &str, en: bool) -> &'static str {
    match (kind, en) {
        ("scan", false) => "Scan",
        ("scan", true) => "Scan",
        ("action", false) => "Aktion",
        ("action", true) => "Action",
        ("decision", false) => "Entscheidung",
        ("decision", true) => "Decision",
        ("watch", false) => "Wächter",
        ("watch", true) => "Guard",
        ("schedule", false) => "Geplanter Scan",
        ("schedule", true) => "Scheduled scan",
        ("update", false) => "Update",
        ("update", true) => "Update",
        (_, false) => "Ereignis",
        (_, true) => "Event",
    }
}

fn risk_label(risk: &str, en: bool) -> &'static str {
    match (risk, en) {
        ("dangerous", false) => "Gefährlich",
        ("dangerous", true) => "Dangerous",
        ("suspicious", false) => "Verdächtig",
        ("suspicious", true) => "Suspicious",
        ("risky_tool", false) => "Tool mit Risiko",
        ("risky_tool", true) => "Risky tool",
        ("game_tool", false) => "Spiel-Tool",
        ("game_tool", true) => "Game tool",
        ("info", false) => "Info",
        ("info", true) => "Info",
        ("clean", false) => "Sauber",
        ("clean", true) => "Clean",
        _ => "",
    }
}

/// Erzeugt die Berichtsseite aus der Antwort `history` des Dienstes.
#[must_use]
pub fn render(history: &Value, en: bool, created: &str) -> String {
    let entries = history
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let (title, intro, when, kind, risk, what, none) = if en {
        (
            "AEGIS report",
            "History of scans, guard notices, scheduled scans and your decisions. Nothing was changed without your yes.",
            "Time (UTC)",
            "Type",
            "Risk",
            "What",
            "No entries.",
        )
    } else {
        (
            "AEGIS-Bericht",
            "Verlauf von Scans, Wächter-Meldungen, geplanten Scans und deinen Entscheidungen. Ohne dein Ja wurde nichts verändert.",
            "Zeit (UTC)",
            "Art",
            "Stufe",
            "Was",
            "Keine Einträge.",
        )
    };
    let mut rows = String::new();
    for e in &entries {
        let paths = e
            .get("paths")
            .and_then(Value::as_array)
            .map(|p| {
                p.iter()
                    .filter_map(Value::as_str)
                    .map(|s| format!("<li><code>{}</code></li>", escape(s)))
                    .collect::<String>()
            })
            .unwrap_or_default();
        let detail = str_of(e, "detail");
        rows.push_str(&format!(
            "<tr><td>{}</td><td>{}</td><td class=\"r-{}\">{}</td><td><strong>{}</strong>{}{}</td></tr>\n",
            escape(&str_of(e, "at").replace('T', " ").replace('Z', "")),
            kind_label(str_of(e, "kind"), en),
            escape(str_of(e, "risk")),
            risk_label(str_of(e, "risk"), en),
            escape(str_of(e, "title")),
            if detail.is_empty() {
                String::new()
            } else {
                format!("<pre>{}</pre>", escape(detail))
            },
            if paths.is_empty() {
                String::new()
            } else {
                format!("<ul>{paths}</ul>")
            },
        ));
    }
    if entries.is_empty() {
        rows = format!("<tr><td colspan=\"4\">{none}</td></tr>");
    }
    format!(
        r#"<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>{title}</title>
<style>
body{{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#111;background:#fff}}
h1{{font-size:22px;margin:0 0 4px}}
p{{color:#444;margin:0 0 16px}}
table{{border-collapse:collapse;width:100%}}
th,td{{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}}
th{{background:#f4f4f5}}
pre{{white-space:pre-wrap;margin:4px 0 0;font:12px/1.4 ui-monospace,monospace;color:#333}}
ul{{margin:4px 0 0;padding-left:18px}}
code{{font:12px ui-monospace,monospace;word-break:break-all}}
.r-dangerous{{color:#b91c1c;font-weight:600}}
.r-suspicious{{color:#a16207;font-weight:600}}
</style>
</head>
<body>
<h1>{title}</h1>
<p>{intro}</p>
<p>{created}</p>
<table>
<thead><tr><th>{when}</th><th>{kind}</th><th>{risk}</th><th>{what}</th></tr></thead>
<tbody>
{rows}</tbody>
</table>
</body>
</html>
"#,
        lang = if en { "en" } else { "de" },
        created = escape(created),
    )
}

/// Ergänzt `.html`, falls der Nutzer keine Endung gewählt hat.
#[must_use]
pub fn with_html_extension(path: PathBuf) -> PathBuf {
    let has = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"));
    if has {
        path
    } else {
        path.with_extension("html")
    }
}

/// Schreibt den Bericht an den vom Nutzer im Speichern-Dialog gewählten Ort.
fn write_report(path: &Path, html: &str) -> std::io::Result<()> {
    // Der Nutzer hat Ort und Namen im Speichern-Dialog selbst gewählt (Windows fragt vor dem
    // Überschreiben nach); geschrieben wird nur die erzeugte Berichtsseite.
    // aegis-mutation: desktop-report-write
    #[allow(clippy::disallowed_methods)]
    let mut file = std::fs::File::create(path)?;
    file.write_all(html.as_bytes())?;
    file.sync_all()
}

/// Exportiert den Verlauf als HTML-Bericht. `None` = im Dialog abgebrochen.
#[tauri::command]
pub async fn export_report<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    english: bool,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let history = crate::service::history().await?;
    if history.get("type").and_then(Value::as_str) != Some("history") {
        return Err(str_of(&history, "message").to_owned());
    }
    let created = time_now_text(english);
    let html = render(&history, english, &created);
    let name = if english {
        "AEGIS-report.html"
    } else {
        "AEGIS-Bericht.html"
    };
    tauri::async_runtime::spawn_blocking(move || {
        let Some(chosen) = app
            .dialog()
            .file()
            .add_filter("HTML", &["html", "htm"])
            .set_file_name(name)
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = with_html_extension(chosen.into_path().map_err(|e| e.to_string())?);
        write_report(&path, &html).map_err(|e| format!("Bericht nicht gespeichert: {e}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn time_now_text(english: bool) -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let label = if english { "Created" } else { "Erstellt" };
    format!("{label}: {} (Unix-Zeit {secs})", unix_to_utc(secs))
}

/// Unix-Sekunden → `JJJJ-MM-TT hh:mm UTC` (ohne Zeit-Bibliothek).
fn unix_to_utc(secs: u64) -> String {
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rem = secs % 86_400;
    // Algorithmus „civil_from_days“ (H. Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02} UTC",
        rem / 3600,
        (rem % 3600) / 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bericht_maskiert_alles_und_laedt_nichts() {
        let history = json!({
            "type": "history",
            "entries": [{
                "seq": 1, "at": "2026-10-19T10:00:00Z", "kind": "scan", "risk": "dangerous",
                "title": "<script>alert(1)</script>", "detail": "a & b",
                "paths": ["C:\\Users\\x\\<img src=x onerror=alert(1)>.exe\u{202e}gpj"]
            }]
        });
        let html = render(&history, false, "Erstellt: jetzt");
        assert!(!html.contains("<script>"));
        assert!(!html.contains("<img"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("a &amp; b"));
        assert!(html.contains("\\u{202e}"), "Richtungszeichen sichtbar");
        assert!(html.contains("Gefährlich"));
        assert!(html.contains("default-src 'none'"));
        assert!(!html.contains("http://") && !html.contains("https://"));
        let empty = render(&json!({"type": "history", "entries": []}), true, "x");
        assert!(empty.contains("No entries."));
        assert!(empty.contains("lang=\"en\""));
    }

    #[test]
    fn endung_und_datum() {
        assert_eq!(
            with_html_extension(PathBuf::from("/x/bericht")),
            PathBuf::from("/x/bericht.html")
        );
        assert_eq!(
            with_html_extension(PathBuf::from("/x/b.HTML")),
            PathBuf::from("/x/b.HTML")
        );
        assert_eq!(unix_to_utc(0), "1970-01-01 00:00 UTC");
        assert_eq!(unix_to_utc(1_792_407_600), "2026-10-19 11:00 UTC");
    }
}
