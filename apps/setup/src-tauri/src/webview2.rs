//! WebView2-Laufzeit: Das Setup-Fenster braucht sie (Windows 11 hat sie immer, Windows 10
//! fast immer). Fehlt sie, fragt das Setup in einem einfachen Windows-Dialog, ob es die
//! offizielle Microsoft-Seite zum Herunterladen öffnen soll – geladen und installiert wird nur
//! nach „Ja“, und zwar vom Nutzer selbst über seinen Browser.

/// Kennung der WebView2-Laufzeit (Evergreen) in den EdgeUpdate-Schlüsseln.
#[cfg(windows)]
const RUNTIME: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
/// Offizieller Download (Evergreen-Bootstrapper) von Microsoft.
#[cfg(windows)]
const DOWNLOAD: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

/// Gilt eine Versionsangabe als installiert? (leer oder `0.0.0.0` = nein)
#[cfg_attr(not(windows), allow(dead_code))]
fn installed_version(pv: &str) -> bool {
    let pv = pv.trim();
    !pv.is_empty() && pv != "0.0.0.0" && pv.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Ist die WebView2-Laufzeit installiert (für den Rechner oder dieses Konto)?
#[must_use]
pub fn ready() -> bool {
    #[cfg(windows)]
    {
        use aegis_winffi::inspect::{Hive, read_values};
        let machine = format!(r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{RUNTIME}");
        let user = format!(r"Software\Microsoft\EdgeUpdate\Clients\{RUNTIME}");
        [(Hive::LocalMachine, machine), (Hive::CurrentUser, user)]
            .iter()
            .any(|(hive, key)| {
                read_values(hive, key)
                    .iter()
                    .any(|v| v.name.eq_ignore_ascii_case("pv") && installed_version(&v.data))
            })
    }
    #[cfg(not(windows))]
    {
        true
    }
}

/// Fragt, ob die Download-Seite von Microsoft geöffnet werden soll.
pub fn offer_download() {
    #[cfg(windows)]
    {
        let answer = rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Info)
            .set_title("AEGIS-Setup")
            .set_description(
                "Für das Setup fehlt die Microsoft-WebView2-Laufzeit (Teil von Windows 11, \
                 unter Windows 10 meist vorhanden).\n\nSoll die offizielle Download-Seite von \
                 Microsoft im Browser geöffnet werden? Danach das Setup erneut starten.",
            )
            .set_buttons(rfd::MessageButtons::YesNo)
            .show();
        if answer == rfd::MessageDialogResult::Yes {
            let _ = aegis_winffi::shell::launch(std::path::Path::new(DOWNLOAD), "");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versionen() {
        assert!(installed_version("131.0.2903.70"));
        assert!(!installed_version(""));
        assert!(!installed_version("0.0.0.0"));
        assert!(!installed_version("abc"));
        assert!(ready() || cfg!(windows));
    }
}
