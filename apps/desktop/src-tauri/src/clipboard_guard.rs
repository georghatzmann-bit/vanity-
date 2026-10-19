//! Zwischenablage-Wächter (P6.6, opt-in): „Clipboard-Hijacker“ tauschen eine kopierte
//! Krypto-Adresse blitzschnell gegen die des Angreifers. Die App liest dafür – nur wenn der
//! Nutzer es eingeschaltet hat – nach jeder Änderung den Text der Zwischenablage und meldet,
//! wenn eine Krypto-Adresse innerhalb von drei Sekunden durch eine andere desselben Typs
//! ersetzt wird. Die Zwischenablage wird nie verändert; Inhalte werden nicht gespeichert und
//! verlassen den Rechner nie (nur gekürzte Adressen in der Meldung).

use serde::Serialize;

/// Zeitfenster für einen Austausch (Millisekunden).
pub const SWAP_WINDOW_MS: u64 = 3000;
/// Name des Ereignisses an das Hauptfenster.
pub const SWAP_EVENT: &str = "aegis://clipboard-swap";

/// Art einer Krypto-Adresse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CryptoKind {
    /// Bitcoin.
    Bitcoin,
    /// Ethereum (und kompatible Ketten).
    Ethereum,
    /// Litecoin.
    Litecoin,
    /// Dogecoin.
    Dogecoin,
    /// Tron.
    Tron,
    /// Monero.
    Monero,
}

const BASE58: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BECH32: &str = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

fn base58(s: &str) -> bool {
    s.chars().all(|c| BASE58.contains(c))
}

fn bech32(s: &str, prefix: &str) -> bool {
    s.strip_prefix(prefix)
        .is_some_and(|rest| rest.chars().all(|c| BECH32.contains(c)))
}

/// Erkennt eine einzelne Krypto-Adresse (ganzer Text, ohne Leerzeichen).
#[must_use]
pub fn classify(text: &str) -> Option<CryptoKind> {
    let t = text.trim();
    if t.is_empty() || t.len() > 120 || t.chars().any(char::is_whitespace) {
        return None;
    }
    let len = t.len();
    if let Some(hex) = t.strip_prefix("0x") {
        return (hex.len() == 40 && hex.chars().all(|c| c.is_ascii_hexdigit()))
            .then_some(CryptoKind::Ethereum);
    }
    if (14..=74).contains(&len) && bech32(t, "bc1") {
        return Some(CryptoKind::Bitcoin);
    }
    if (14..=74).contains(&len) && bech32(t, "ltc1") {
        return Some(CryptoKind::Litecoin);
    }
    if !base58(t) {
        return None;
    }
    match (t.as_bytes()[0], len) {
        (b'4' | b'8', 95) => Some(CryptoKind::Monero),
        (b'T', 34) => Some(CryptoKind::Tron),
        (b'D', 34) => Some(CryptoKind::Dogecoin),
        (b'L' | b'M', 26..=34) => Some(CryptoKind::Litecoin),
        (b'1' | b'3', 26..=35) => Some(CryptoKind::Bitcoin),
        _ => None,
    }
}

/// Gekürzte Anzeige (`bc1qxy…0wlh`).
#[must_use]
pub fn shorten(address: &str) -> String {
    let chars: Vec<char> = address.chars().collect();
    if chars.len() <= 12 {
        return address.to_owned();
    }
    let head: String = chars[..6].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

/// Ein erkannter Austausch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Swap {
    /// Art.
    pub kind: CryptoKind,
    /// Vorher (gekürzt).
    pub before: String,
    /// Nachher (gekürzt).
    pub after: String,
    /// Programm, dem die Zwischenablage danach gehört (falls ermittelbar).
    pub owner: Option<String>,
}

/// Erkennung über aufeinanderfolgende Inhalte (rein – testbar).
#[derive(Debug, Default)]
pub struct Detector {
    last: Option<(u64, CryptoKind, String)>,
}

impl Detector {
    /// Neuer Inhalt zur Zeit `now_ms` (`None`: kein Text).
    pub fn observe(&mut self, now_ms: u64, text: Option<&str>) -> Option<Swap> {
        let Some((text, kind)) = text.and_then(|t| classify(t).map(|k| (t.trim(), k))) else {
            self.last = None;
            return None;
        };
        let swap = match &self.last {
            Some((at, last_kind, last))
                if *last_kind == kind
                    && last != text
                    && now_ms.saturating_sub(*at) <= SWAP_WINDOW_MS =>
            {
                Some(Swap {
                    kind,
                    before: shorten(last),
                    after: shorten(text),
                    owner: None,
                })
            }
            _ => None,
        };
        self.last = Some((now_ms, kind, text.to_owned()));
        swap
    }
}

#[cfg(windows)]
mod watcher {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use tauri::{AppHandle, Emitter, Runtime};

    use super::{Detector, SWAP_EVENT};

    static ENABLED: AtomicBool = AtomicBool::new(false);
    static STARTED: OnceLock<()> = OnceLock::new();
    /// Meldet einen Austausch an das Hauptfenster.
    type Emit = Box<dyn Fn(super::Swap) + Send>;
    static APP: Mutex<Option<Emit>> = Mutex::new(None);

    pub(super) fn set<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
        ENABLED.store(enabled, Ordering::SeqCst);
        if !enabled {
            return;
        }
        let handle = app.clone();
        if let Ok(mut slot) = APP.lock() {
            *slot = Some(Box::new(move |swap| {
                let _ = handle.emit_to(crate::window::MAIN_WINDOW_LABEL, SWAP_EVENT, swap);
            }));
        }
        STARTED.get_or_init(|| {
            std::thread::spawn(run);
        });
    }

    fn run() {
        let start = Instant::now();
        let mut detector = Detector::default();
        let mut seen = aegis_winffi::clipboard::sequence_number();
        loop {
            std::thread::sleep(Duration::from_millis(250));
            if !ENABLED.load(Ordering::SeqCst) {
                detector = Detector::default();
                continue;
            }
            let now = aegis_winffi::clipboard::sequence_number();
            if now == seen {
                continue;
            }
            seen = now;
            // Ein anderes Programm kann die Zwischenablage kurz geöffnet halten.
            let text = aegis_winffi::clipboard::read_text(200).or_else(|_| {
                std::thread::sleep(Duration::from_millis(50));
                aegis_winffi::clipboard::read_text(200)
            });
            let at = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
            if let Some(mut swap) = detector.observe(at, text.ok().flatten().as_deref()) {
                swap.owner = aegis_winffi::clipboard::owner_process()
                    .and_then(|pid| aegis_winffi::system::process_image_path(pid).ok())
                    .map(|p| p.display().to_string());
                if let Ok(slot) = APP.lock()
                    && let Some(emit) = slot.as_ref()
                {
                    emit(swap);
                }
            }
        }
    }
}

/// Schaltet den Wächter ein oder aus. Liefert, ob er auf diesem System verfügbar ist.
#[tauri::command]
pub fn clipboard_guard<R: tauri::Runtime>(app: tauri::AppHandle<R>, enabled: bool) -> bool {
    #[cfg(windows)]
    {
        watcher::set(&app, enabled);
        true
    }
    #[cfg(not(windows))]
    {
        let _ = (app, enabled);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adressen_erkennen() {
        assert_eq!(
            classify("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"),
            Some(CryptoKind::Bitcoin)
        );
        assert_eq!(
            classify("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"),
            Some(CryptoKind::Bitcoin)
        );
        assert_eq!(
            classify(" 0x52908400098527886E0F7030069857D2E4169EE7 "),
            Some(CryptoKind::Ethereum)
        );
        assert_eq!(
            classify("TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW"),
            Some(CryptoKind::Tron)
        );
        assert_eq!(
            classify("LdP8Qox1VAhCzLJNqrr74YovaWYyNBUWvL"),
            Some(CryptoKind::Litecoin)
        );
        assert_eq!(classify("hallo welt"), None);
        assert_eq!(classify("0x1234"), None);
        assert_eq!(
            classify("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN0"),
            None,
            "0 ist kein Base58"
        );
        assert_eq!(classify(""), None);
    }

    #[test]
    fn austausch_nur_schnell_und_gleicher_typ() {
        let a = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
        let b = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
        let mut d = Detector::default();
        assert_eq!(d.observe(0, Some(a)), None);
        let swap = d.observe(400, Some(b)).unwrap();
        assert_eq!(swap.kind, CryptoKind::Bitcoin);
        assert_eq!(swap.before, "bc1qxy…0wlh");
        assert_eq!(swap.after, shorten(b));
        // Langsam (Nutzer kopiert selbst neu): nichts.
        assert_eq!(d.observe(10_000, Some(a)), None);
        // Gleiche Adresse erneut: nichts.
        assert_eq!(d.observe(10_100, Some(a)), None);
        // Dazwischen anderer Text: Kette reißt ab.
        assert_eq!(d.observe(10_200, Some("Notiz")), None);
        assert_eq!(d.observe(10_300, Some(b)), None);
        // Anderer Typ: nichts.
        assert_eq!(
            d.observe(10_400, Some("0x52908400098527886E0F7030069857D2E4169EE7")),
            None
        );
    }
}
