//! Getaktete Verbindung (`INetworkCostManager::GetCost`, COM, ohne Adminrechte). Vertrag:
//! `docs/API.md`, „Hauptverbindung, Netz und Verbindungsart“ (`net_metered`).
//!
//! Der COM-Aufruf läuft per `spawn_blocking` auf einem eigenen Thread mit eigenem
//! `CoInitializeEx` (Multithread-Apartment) und höchstens 3 s Wartezeit. Jeder Fehler (COM nicht
//! verfügbar, Dienst „Netzwerklisten“ aus, Zeitüberschreitung) ergibt `None` = „unbekannt“.

use std::time::Duration;

/// Höchste Wartezeit auf die Antwort des Netzwerklisten-Dienstes.
const TIMEOUT: Duration = Duration::from_secs(3);

// Werte aus `NLM_CONNECTION_COST` (netlistmgr.h). Unter Windows prüft `const _` unten beim Bauen,
// dass sie mit den Bindungen aus `windows` übereinstimmen; so bleibt die Auswertung überall testbar.
const COST_UNRESTRICTED: u32 = 0x1;
const COST_FIXED: u32 = 0x2;
const COST_VARIABLE: u32 = 0x4;
const COST_OVERDATALIMIT: u32 = 0x1_0000;
const COST_ROAMING: u32 = 0x4_0000;
const COST_APPROACHINGDATALIMIT: u32 = 0x8_0000;

#[cfg(windows)]
const _: () = {
    use windows::Win32::Networking::NetworkListManager as nlm;
    assert!(nlm::NLM_CONNECTION_COST_UNRESTRICTED.0 as u32 == COST_UNRESTRICTED);
    assert!(nlm::NLM_CONNECTION_COST_FIXED.0 as u32 == COST_FIXED);
    assert!(nlm::NLM_CONNECTION_COST_VARIABLE.0 as u32 == COST_VARIABLE);
    assert!(nlm::NLM_CONNECTION_COST_OVERDATALIMIT.0 as u32 == COST_OVERDATALIMIT);
    assert!(nlm::NLM_CONNECTION_COST_ROAMING.0 as u32 == COST_ROAMING);
    assert!(nlm::NLM_CONNECTION_COST_APPROACHINGDATALIMIT.0 as u32 == COST_APPROACHINGDATALIMIT);
};

/// Reine Auswertung des Kostenwerts: `true` bei fest/variabel oder gesetztem Roaming-/Limit-Bit,
/// `false` bei „unbegrenzt“, sonst (`UNKNOWN` = 0, nur „überlastet“) `None`.
pub fn classify(cost: u32) -> Option<bool> {
    let metered = COST_FIXED | COST_VARIABLE | COST_ROAMING | COST_OVERDATALIMIT | COST_APPROACHINGDATALIMIT;
    if cost & metered != 0 {
        Some(true)
    } else if cost & COST_UNRESTRICTED != 0 {
        Some(false)
    } else {
        None
    }
}

/// `true` = getaktet (fest/variabel, Roaming oder Limit), `false` = unbegrenzt, `None` = unbekannt
/// bzw. außerhalb von Windows.
pub async fn metered() -> Option<bool> {
    let task = tauri::async_runtime::spawn_blocking(read_cost);
    match tokio::time::timeout(TIMEOUT, task).await {
        Ok(Ok(cost)) => cost.and_then(classify),
        Ok(Err(e)) => {
            eprintln!("[pulsar] getaktete Verbindung: Aufgabe abgebrochen: {e}");
            None
        }
        Err(_) => {
            eprintln!("[pulsar] getaktete Verbindung: keine Antwort binnen 3 s");
            None
        }
    }
}

/// Kostenwert der Verbindung des Rechners (blockierend; `None` bei Fehler).
#[cfg(windows)]
fn read_cost() -> Option<u32> {
    win::read_cost()
}

#[cfg(not(windows))]
fn read_cost() -> Option<u32> {
    None
}

#[cfg(windows)]
mod win {
    use windows::Win32::Networking::NetworkListManager::{INetworkCostManager, NetworkListManager};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};

    /// COM für diesen Thread – nur freigeben, was hier selbst initialisiert wurde.
    struct ComGuard(bool);

    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    pub fn read_cost() -> Option<u32> {
        // S_OK/S_FALSE → später freigeben; RPC_E_CHANGED_MODE → der Thread ist schon anders
        // initialisiert, COM ist trotzdem nutzbar.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let _guard = ComGuard(hr.is_ok());
        let manager: INetworkCostManager = match unsafe { CoCreateInstance(&NetworkListManager, None, CLSCTX_ALL) } {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[pulsar] getaktete Verbindung: NetworkListManager nicht verfügbar: {e}");
                return None;
            }
        };
        let mut cost = 0u32;
        // Ohne Zieladresse: Kosten der Verbindung des ganzen Rechners. `manager` wird vor
        // `_guard` freigegeben (umgekehrte Reihenfolge der Deklaration).
        match unsafe { manager.GetCost(&mut cost, std::ptr::null()) } {
            Ok(()) => Some(cost),
            Err(e) => {
                eprintln!("[pulsar] getaktete Verbindung: GetCost fehlgeschlagen: {e}");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unrestricted_is_not_metered() {
        assert_eq!(classify(COST_UNRESTRICTED), Some(false));
    }

    #[test]
    fn fixed_and_variable_are_metered() {
        assert_eq!(classify(COST_FIXED), Some(true));
        assert_eq!(classify(COST_VARIABLE), Some(true));
    }

    #[test]
    fn roaming_or_limit_bits_win_over_unrestricted() {
        assert_eq!(classify(COST_UNRESTRICTED | COST_ROAMING), Some(true));
        assert_eq!(classify(COST_UNRESTRICTED | COST_OVERDATALIMIT), Some(true));
        assert_eq!(classify(COST_UNRESTRICTED | COST_APPROACHINGDATALIMIT), Some(true));
    }

    #[test]
    fn unknown_is_none() {
        assert_eq!(classify(0), None);
        // „überlastet“ allein sagt nichts über das Datenvolumen
        assert_eq!(classify(0x2_0000), None);
    }

    #[test]
    fn off_windows_is_unknown() {
        if cfg!(not(windows)) {
            assert_eq!(read_cost(), None);
        }
    }
}
