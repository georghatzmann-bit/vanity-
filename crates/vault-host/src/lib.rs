//! Native-Messaging-Host der Tresor-Erweiterung (P9.3), reine Teile: Nachrichtenrahmen
//! (4 Byte Länge, Little Endian, dann JSON) und die Prüfung, dass nur **unsere** Erweiterung
//! den Host starten darf. Der Host speichert nichts und kennt keine Schlüssel – er leitet nur
//! einzelne, geprüfte Anfragen an die laufende AEGIS-App weiter.
#![forbid(unsafe_code)]

use std::io::{self, Read, Write};

/// ID der Erweiterung „AEGIS Tresor“ (aus dem öffentlichen Schlüssel im Manifest).
pub const EXTENSION_ID: &str = "mfhpbiifllddbcddpanidjedgmbglhon";
/// Name des Hosts (Registrierung unter `NativeMessagingHosts`).
pub const HOST_NAME: &str = "com.aegis.vault";
/// Größte Nachricht der Erweiterung an den Host.
pub const MAX_IN: usize = 64 * 1024;
/// Größte Nachricht des Hosts an die Erweiterung (Browser-Grenze 1 MiB).
pub const MAX_OUT: usize = 1024 * 1024;

/// Stammt der Aufruf von unserer Erweiterung? Der Browser übergibt deren Adresse als
/// erstes Argument (`chrome-extension://<id>/`).
#[must_use]
pub fn caller_allowed(args: &[String]) -> bool {
    args.first()
        .is_some_and(|origin| origin == &format!("chrome-extension://{EXTENSION_ID}/"))
}

/// Liest eine Nachricht; `None` am Ende des Eingabestroms.
///
/// # Errors
/// Abgebrochene oder zu große Nachricht.
pub fn read_message(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match reader.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = usize::try_from(u32::from_le_bytes(len)).unwrap_or(usize::MAX);
    if len > MAX_IN {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Nachricht zu groß",
        ));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

/// Schreibt eine Nachricht.
///
/// # Errors
/// Zu groß oder Schreibfehler.
pub fn write_message(writer: &mut impl Write, body: &[u8]) -> io::Result<()> {
    if body.len() > MAX_OUT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Antwort zu groß",
        ));
    }
    let len = u32::try_from(body.len()).map_err(|_| io::Error::other("Antwort zu groß"))?;
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(body)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rahmen_und_aufrufer() {
        let mut out = Vec::new();
        write_message(&mut out, br#"{"type":"status"}"#).unwrap();
        let mut input = &out[..];
        assert_eq!(
            read_message(&mut input).unwrap().unwrap(),
            br#"{"type":"status"}"#
        );
        assert!(read_message(&mut input).unwrap().is_none());
        let mut big = (u32::try_from(MAX_IN).unwrap() + 1).to_le_bytes().to_vec();
        big.extend(vec![0; 8]);
        assert!(read_message(&mut &big[..]).is_err());
        assert!(caller_allowed(&[format!(
            "chrome-extension://{EXTENSION_ID}/"
        )]));
        assert!(!caller_allowed(&["chrome-extension://andere/".into()]));
        assert!(!caller_allowed(&[]));
    }
}
