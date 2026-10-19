//! CSV-Import des **eigenen** Exports (Chrome/Edge, Firefox, Bitwarden, eigene Spalten
//! `title,username,password,url,notes`). AEGIS liest nie Passwörter anderer Programme direkt –
//! nur die Datei, die der Nutzer selbst exportiert und ausgewählt hat.

use zeroize::Zeroizing;

use crate::entry::EntryInput;

/// Größte Importdatei (Bytes).
pub const MAX_IMPORT: usize = 16 * 1024 * 1024;

/// Liest CSV (RFC 4180: Anführungszeichen, verdoppelte `""`, Zeilenumbrüche in Feldern).
fn records(text: &str) -> Vec<Vec<Zeroizing<String>>> {
    let mut rows = Vec::new();
    let mut row: Vec<Zeroizing<String>> = Vec::new();
    let mut field = Zeroizing::new(String::new());
    let mut quoted = false;
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    field.push('"');
                }
                '"' => quoted = false,
                _ => field.push(c),
            }
        } else {
            match c {
                '"' if field.is_empty() => quoted = true,
                ',' => row.push(std::mem::replace(&mut field, Zeroizing::new(String::new()))),
                '\r' => {}
                '\n' => {
                    row.push(std::mem::replace(&mut field, Zeroizing::new(String::new())));
                    if row.iter().any(|f| !f.is_empty()) {
                        rows.push(std::mem::take(&mut row));
                    } else {
                        row.clear();
                    }
                }
                _ => field.push(c),
            }
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        if row.iter().any(|f| !f.is_empty()) {
            rows.push(row);
        }
    }
    rows
}

fn column(header: &[String], names: &[&str]) -> Option<usize> {
    header.iter().position(|h| names.contains(&h.as_str()))
}

/// Ergebnis des Imports.
#[derive(Debug)]
pub struct Imported {
    /// Einträge.
    pub entries: Vec<EntryInput>,
    /// Übersprungene Zeilen (ohne Titel/Adresse und ohne Passwort).
    pub skipped: usize,
}

/// Wertet einen CSV-Export aus.
///
/// # Errors
/// Zu groß, keine Kopfzeile oder unbekannte Spalten.
pub fn parse_csv(text: &str) -> Result<Imported, String> {
    if text.len() > MAX_IMPORT {
        return Err("Die Datei ist zu groß.".into());
    }
    let mut rows = records(text).into_iter();
    let header: Vec<String> = rows
        .next()
        .ok_or("Die Datei ist leer.")?
        .iter()
        .map(|h| h.trim().to_ascii_lowercase())
        .collect();
    let title = column(&header, &["name", "title"]);
    let url = column(&header, &["url", "login_uri", "website"]);
    let username = column(&header, &["username", "login_username", "user", "login"]);
    let password = column(&header, &["password", "login_password"])
        .ok_or("Keine Spalte „password“ gefunden – ist das ein Passwort-Export?")?;
    let notes = column(&header, &["note", "notes", "extra"]);
    let folder = column(&header, &["folder", "grouping"]);
    let favorite = column(&header, &["favorite", "fav"]);
    let get = |row: &[Zeroizing<String>], i: Option<usize>| -> String {
        i.and_then(|i| row.get(i))
            .map(|v| v.to_string())
            .unwrap_or_default()
    };
    let mut entries = Vec::new();
    let mut skipped = 0;
    for row in rows {
        let address = get(&row, url);
        let host = crate::url::origin_parts(&address).map(|(_, h)| h);
        let mut name = get(&row, title);
        if name.trim().is_empty() {
            name = host.clone().unwrap_or_default();
        }
        let input = EntryInput {
            title: name,
            username: get(&row, username),
            password: get(&row, Some(password)),
            urls: if address.is_empty() {
                Vec::new()
            } else {
                vec![address]
            },
            notes: get(&row, notes),
            folder: get(&row, folder),
            tags: Vec::new(),
            favorite: matches!(get(&row, favorite).trim(), "1" | "true" | "TRUE"),
        };
        match input.validated() {
            Ok(v) if !v.password.is_empty() => entries.push(v),
            _ => skipped += 1,
        }
    }
    Ok(Imported { entries, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrome_firefox_bitwarden() {
        let chrome = "name,url,username,password,note\r\nBank,https://bank.example/login,anna,\"ge,heim\"\"1\",\"Zeile 1\nZeile 2\"\r\n,https://shop.example,bob,pw2,\n,,,,\n";
        let r = parse_csv(chrome).unwrap();
        assert_eq!(r.entries.len(), 2);
        assert_eq!(r.entries[0].password, "ge,heim\"1");
        assert_eq!(r.entries[0].notes, "Zeile 1\nZeile 2");
        assert_eq!(r.entries[1].title, "shop.example");
        let firefox = "\u{feff}\"url\",\"username\",\"password\",\"httpRealm\",\"formActionOrigin\",\"guid\"\n\"https://mail.example\",\"anna\",\"pw\",,\"\",\"{x}\"\n";
        let r = parse_csv(firefox).unwrap();
        assert_eq!(r.entries[0].title, "mail.example");
        let bitwarden = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\nPrivat,1,login,Forum,,,0,https://forum.example,anna,pw3,\nPrivat,,note,Nur Notiz,text,,0,,,,\n";
        let r = parse_csv(bitwarden).unwrap();
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.skipped, 1);
        assert_eq!(r.entries[0].folder, "Privat");
        assert!(r.entries[0].favorite);
        assert!(parse_csv("a,b\n1,2\n").is_err());
        assert!(parse_csv("").is_err());
    }
}
