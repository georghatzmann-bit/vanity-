//! Symbol im Infobereich (Tray) mit Menü.
//!
//! Das Menü verändert nichts am System: Es zeigt das Fenster, springt zu einer Seite oder
//! beendet AEGIS selbst. Die Zuordnung Menüeintrag → Aktion ist eine reine Funktion
//! ([`action_for_menu_id`]) und ohne Anzeige testbar.
//!
//! Plattform: Unter Linux braucht das Symbol `libayatana-appindicator3` (bzw.
//! `libappindicator3`); Klick-Ereignisse auf das Symbol gibt es dort nicht, nur das Menü.

use serde::Serialize;
use tauri::menu::{Menu, MenuBuilder, MenuEvent};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Runtime};

use crate::window::{self, MAIN_WINDOW_LABEL};

/// Kennung des Tray-Symbols.
pub const TRAY_ID: &str = "aegis-tray";
/// Tooltip des Tray-Symbols.
pub const TOOLTIP: &str = "AEGIS Suite";

/// Menü-Kennungen (stabil, nicht übersetzt).
pub const MENU_OPEN: &str = "aegis-tray-open";
pub const MENU_DASHBOARD: &str = "aegis-tray-dashboard";
pub const MENU_SETTINGS: &str = "aegis-tray-settings";
pub const MENU_QUIT: &str = "aegis-tray-quit";

/// Ereignis an die Oberfläche: „zu dieser Seite wechseln“ (Nutzdaten: [`NavigatePayload`]).
pub const NAVIGATE_EVENT: &str = "aegis://navigate";

/// Seiten, die das Tray-Menü direkt öffnen kann.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Page {
    Dashboard,
    Settings,
}

/// Nutzdaten von [`NAVIGATE_EVENT`]: `{ "page": "dashboard" | "settings" }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct NavigatePayload {
    pub page: Page,
}

/// Was ein Menüeintrag bzw. ein Klick auf das Symbol auslöst.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    /// Hauptfenster zeigen, wiederherstellen, fokussieren.
    ShowMain,
    /// Hauptfenster zeigen und zur Seite wechseln.
    Navigate(Page),
    /// AEGIS beenden.
    Quit,
}

/// Ein Eintrag des Tray-Menüs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuEntry {
    Item {
        id: &'static str,
        label: &'static str,
    },
    Separator,
}

/// Das Tray-Menü in Anzeigereihenfolge (Beschriftungen Deutsch).
pub const MENU: [MenuEntry; 5] = [
    MenuEntry::Item {
        id: MENU_OPEN,
        label: "AEGIS öffnen",
    },
    MenuEntry::Item {
        id: MENU_DASHBOARD,
        label: "Dashboard",
    },
    MenuEntry::Item {
        id: MENU_SETTINGS,
        label: "Einstellungen",
    },
    MenuEntry::Separator,
    MenuEntry::Item {
        id: MENU_QUIT,
        label: "Beenden",
    },
];

/// Menü-Kennung → Aktion. Unbekannte Kennungen (etwa aus anderen Menüs) lösen nichts aus.
pub fn action_for_menu_id(id: &str) -> Option<TrayAction> {
    match id {
        MENU_OPEN => Some(TrayAction::ShowMain),
        MENU_DASHBOARD => Some(TrayAction::Navigate(Page::Dashboard)),
        MENU_SETTINGS => Some(TrayAction::Navigate(Page::Settings)),
        MENU_QUIT => Some(TrayAction::Quit),
        _ => None,
    }
}

/// Klick auf das Symbol → Aktion: Nur das Loslassen der linken Taste zeigt das Fenster
/// (die rechte Taste öffnet das Menü, das erledigt das System).
pub fn action_for_click(button: MouseButton, state: MouseButtonState) -> Option<TrayAction> {
    match (button, state) {
        (MouseButton::Left, MouseButtonState::Up) => Some(TrayAction::ShowMain),
        _ => None,
    }
}

/// Führt eine Aktion aus.
pub fn perform<R: Runtime>(app: &AppHandle<R>, action: TrayAction) {
    match action {
        TrayAction::ShowMain => {
            window::reveal_main(app);
        }
        TrayAction::Navigate(page) => {
            // Erst die Seite wechseln, dann zeigen – so erscheint gleich die richtige Seite.
            if let Err(error) =
                app.emit_to(MAIN_WINDOW_LABEL, NAVIGATE_EVENT, NavigatePayload { page })
            {
                eprintln!("AEGIS: Seitenwechsel aus dem Tray fehlgeschlagen: {error}");
            }
            window::reveal_main(app);
        }
        TrayAction::Quit => app.exit(0),
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    MENU.iter()
        .fold(MenuBuilder::new(app), |builder, entry| match *entry {
            MenuEntry::Item { id, label } => builder.text(id, label),
            MenuEntry::Separator => builder.separator(),
        })
        .build()
}

/// Legt das Tray-Symbol an (Symbol = App-Symbol, Tooltip, Menü, Klick-Verhalten).
///
/// # Errors
/// Wenn das App-Symbol fehlt oder das System das Symbol nicht anlegen kann.
pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<TrayIcon<R>> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("App-Symbol für den Infobereich".into()))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(TOOLTIP)
        .menu(&build_menu(app)?)
        // Linksklick zeigt das Fenster, nicht das Menü (Windows; unter Linux ohne Wirkung).
        .show_menu_on_left_click(false)
        .on_menu_event(|app: &AppHandle<R>, event: MenuEvent| {
            if let Some(action) = action_for_menu_id(event.id().as_ref()) {
                perform(app, action);
            }
        })
        .on_tray_icon_event(|tray: &TrayIcon<R>, event: TrayIconEvent| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
                && let Some(action) = action_for_click(button, button_state)
            {
                perform(tray.app_handle(), action);
            }
        })
        .build(app)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    fn items() -> Vec<(&'static str, &'static str)> {
        MENU.iter()
            .filter_map(|entry| match *entry {
                MenuEntry::Item { id, label } => Some((id, label)),
                MenuEntry::Separator => None,
            })
            .collect()
    }

    #[test]
    fn menue_kennungen_werden_den_aktionen_zugeordnet() {
        assert_eq!(action_for_menu_id(MENU_OPEN), Some(TrayAction::ShowMain));
        assert_eq!(
            action_for_menu_id(MENU_DASHBOARD),
            Some(TrayAction::Navigate(Page::Dashboard))
        );
        assert_eq!(
            action_for_menu_id(MENU_SETTINGS),
            Some(TrayAction::Navigate(Page::Settings))
        );
        assert_eq!(action_for_menu_id(MENU_QUIT), Some(TrayAction::Quit));
    }

    #[test]
    fn unbekannte_kennungen_loesen_nichts_aus() {
        for id in [
            "",
            "quit",
            "AEGIS-TRAY-QUIT",
            "aegis-tray-quit ",
            "aegis-tray",
            "aegis-tray-delete",
        ] {
            assert_eq!(action_for_menu_id(id), None, "{id:?}");
        }
    }

    #[test]
    fn menue_reihenfolge_und_deutsche_beschriftungen() {
        assert_eq!(
            items(),
            [
                (MENU_OPEN, "AEGIS öffnen"),
                (MENU_DASHBOARD, "Dashboard"),
                (MENU_SETTINGS, "Einstellungen"),
                (MENU_QUIT, "Beenden"),
            ]
        );
        // Trenner direkt vor „Beenden“ – nie am Anfang/Ende, nie doppelt.
        assert_eq!(MENU[3], MenuEntry::Separator);
        assert_eq!(
            MENU.iter()
                .filter(|e| matches!(e, MenuEntry::Separator))
                .count(),
            1
        );
    }

    #[test]
    fn jeder_menueeintrag_hat_eine_eigene_kennung_und_eine_aktion() {
        let ids: BTreeSet<_> = items().iter().map(|(id, _)| *id).collect();
        assert_eq!(ids.len(), items().len(), "Kennungen eindeutig");
        for (id, label) in items() {
            assert!(action_for_menu_id(id).is_some(), "{label} ohne Aktion");
            assert!(!label.trim().is_empty());
            assert_ne!(id, TRAY_ID, "Menü- und Symbol-Kennung getrennt");
        }
    }

    #[test]
    fn nur_linksklick_beim_loslassen_zeigt_das_fenster() {
        assert_eq!(
            action_for_click(MouseButton::Left, MouseButtonState::Up),
            Some(TrayAction::ShowMain)
        );
        for (button, state) in [
            (MouseButton::Left, MouseButtonState::Down),
            (MouseButton::Right, MouseButtonState::Up),
            (MouseButton::Right, MouseButtonState::Down),
            (MouseButton::Middle, MouseButtonState::Up),
        ] {
            assert_eq!(
                action_for_click(button, state),
                None,
                "{button:?} {state:?}"
            );
        }
    }

    #[test]
    fn navigations_nutzdaten_wie_vereinbart() {
        assert_eq!(
            serde_json::to_value(NavigatePayload {
                page: Page::Dashboard
            })
            .unwrap(),
            serde_json::json!({ "page": "dashboard" })
        );
        assert_eq!(
            serde_json::to_value(NavigatePayload {
                page: Page::Settings
            })
            .unwrap(),
            serde_json::json!({ "page": "settings" })
        );
    }

    /// Empfängt `aegis://navigate` (Name aus dem IPC-Vertrag, nicht aus der Konstante) im
    /// Fenster `label` und liefert die Nutzdaten als JSON.
    fn navigate_receiver(
        app: &tauri::App<tauri::test::MockRuntime>,
        label: &str,
    ) -> std::sync::mpsc::Receiver<serde_json::Value> {
        use tauri::Listener as _;
        let (tx, rx) = std::sync::mpsc::channel();
        crate::test_support::window(app, label).listen("aegis://navigate", move |event| {
            let _ = tx.send(serde_json::from_str(event.payload()).unwrap());
        });
        rx
    }

    /// „Dashboard“/„Einstellungen“ erreichen genau das Hauptfenster mit den vereinbarten
    /// Nutzdaten – geprüft mit Tauris eigener Ereignis-Verarbeitung (ein ungültiger Name ließe
    /// `emit_to` scheitern, ein falsches Ziel käme im Hauptfenster nicht an).
    #[test]
    fn tray_seitenwechsel_erreicht_nur_das_hauptfenster() {
        let app = crate::test_support::app();
        let main = navigate_receiver(&app, MAIN_WINDOW_LABEL);
        let other = navigate_receiver(&app, "fremd");
        perform(app.handle(), TrayAction::Navigate(Page::Dashboard));
        perform(app.handle(), TrayAction::Navigate(Page::Settings));
        assert_eq!(
            main.try_iter().collect::<Vec<_>>(),
            [
                serde_json::json!({ "page": "dashboard" }),
                serde_json::json!({ "page": "settings" })
            ]
        );
        assert_eq!(other.try_iter().count(), 0, "nur an das Hauptfenster");
        // „AEGIS öffnen“ wechselt keine Seite.
        perform(app.handle(), TrayAction::ShowMain);
        assert_eq!(main.try_iter().count(), 0);
        // Eigener Namensraum, nicht der reservierte „tauri://“.
        assert!(!NAVIGATE_EVENT.starts_with("tauri"));
    }

    #[test]
    #[should_panic(expected = "not implemented")]
    fn beenden_beendet_die_app() {
        // `AppHandle::exit` ist in der Test-Laufzeit nicht umgesetzt (Panic) – genau der Aufruf.
        let app = crate::test_support::app();
        perform(app.handle(), TrayAction::Quit);
    }

    #[test]
    fn tooltip_ist_der_produktname() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["productName"], TOOLTIP);
    }
}
