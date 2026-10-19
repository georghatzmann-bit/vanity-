//! Hauptfenster: nach vorn holen und Verhalten beim Schließen.
//!
//! Das Fenster ist rahmenlos; Titelleiste und Fensterknöpfe zeichnet die Oberfläche selbst.
//! **Schließen entscheidet die Oberfläche, Verstecken Rust:** Mit der Einstellung „Beim
//! Schließen in den Infobereich“ (Standard: an) ruft sie den App-Befehl `hide_to_tray` auf.
//! Der versteckt das Fenster nur, wenn es ein Symbol im Infobereich gibt
//! ([`close_to_tray_available`]) – sonst bliebe ein unsichtbarer Prozess ohne Rückweg. Ohne
//! Symbol meldet er `noTray`, und die Oberfläche beendet AEGIS mit `close()`. Das Recht, das
//! Fenster direkt zu verstecken (`core:window:allow-hide`), hat die Oberfläche nicht.
//!
//! Damit kein unsichtbarer Prozess übrig bleibt, beendet jede Schließ-Anforderung des
//! Hauptfensters die ganze App – auch das Tray-Symbol hält sie dann nicht am Leben. Das gilt
//! ebenso für Alt+F4 und „Fenster schließen“ in der Taskleiste: Diese Wege laufen am
//! Frontend vorbei und beenden AEGIS deshalb immer.

use serde::Serialize;
use tauri::window::Color;
use tauri::{AppHandle, Manager, Runtime, Theme, WebviewWindow, Window, WindowEvent};

use crate::tray;

/// Kennung des Hauptfensters (wie in `tauri.conf.json` und `capabilities/default.json`).
pub const MAIN_WINDOW_LABEL: &str = "main";

/// Fensterhintergrund bis zum ersten Zeichnen der Oberfläche: `--aegis-bg` des dunklen Themes
/// (`packages/ui/src/tokens/tokens.css`) – auch `backgroundColor` in `tauri.conf.json`.
pub const BACKGROUND_DARK: Color = Color(0x07, 0x09, 0x0c, 0xff);
/// `--aegis-bg` des hellen Themes.
pub const BACKGROUND_LIGHT: Color = Color(0xf5, 0xf7, 0xfa, 0xff);

/// Hintergrund passend zum Farbschema des Systems. Die Oberfläche folgt mit „System“
/// (Standard) demselben Schema (`prefers-color-scheme`); unbekannt = dunkel wie die Oberfläche.
pub fn background_for(theme: Theme) -> Color {
    match theme {
        Theme::Light => BACKGROUND_LIGHT,
        _ => BACKGROUND_DARK,
    }
}

/// Stellt den Fensterhintergrund vor dem ersten Zeichnen auf das Farbschema des Systems ein.
///
/// Ohne das zeigt das Fenster bei hellem System (unter Windows der Standard für Apps) beim
/// Start kurz die feste dunkle Farbe aus `tauri.conf.json`, bevor die helle Oberfläche
/// erscheint. Läuft im Setup – das Fenster existiert dann, gezeichnet ist noch nichts.
/// Fehler sind nicht fatal (es bleibt die dunkle Farbe) und werden nur gemeldet.
pub fn match_system_background<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let result = window
        .theme()
        .and_then(|theme| window.set_background_color(Some(background_for(theme))));
    if let Err(error) = result {
        eprintln!("AEGIS: Fensterhintergrund nicht an das Farbschema angepasst: {error}");
    }
}

/// Was bei einer Schließ-Anforderung eines Fensters geschieht.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Hauptfenster: die ganze App beenden (inklusive Tray-Symbol).
    ExitApp,
    /// Andere Fenster: Standardverhalten von Tauri.
    Default,
}

/// Entscheidet rein anhand der Fensterkennung, was beim Schließen passiert.
pub fn close_action(label: &str) -> CloseAction {
    if label == MAIN_WINDOW_LABEL {
        CloseAction::ExitApp
    } else {
        CloseAction::Default
    }
}

/// Lässt sich das Fenster ehrlich „in den Infobereich“ verstecken? Nur, wenn das Symbol
/// angelegt wurde – und nur unter Windows (und macOS), wo es eine Taskleiste bzw. Menüleiste
/// gibt, die es anzeigt. Unter Linux lässt sich nicht feststellen, ob überhaupt ein
/// Infobereich das Symbol zeigt (GNOME etwa hat ohne Erweiterung keinen; angelegt wird es
/// trotzdem fehlerfrei) – dort verspricht AEGIS das Weiterlaufen im Infobereich nicht.
/// Grenze: Unter Windows meldet `tray-icon` ein gescheitertes `Shell_NotifyIcon` nicht; das
/// Symbol erscheint aber, sobald Explorer (wieder) läuft (`TaskbarCreated`).
pub fn close_to_tray_available(tray_created: bool) -> bool {
    tray_created && cfg!(any(windows, target_os = "macos"))
}

/// Ergebnis des Befehls `hide_to_tray` (JSON: `"hidden"` / `"noTray"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HideOutcome {
    /// Fenster versteckt – AEGIS bleibt über das Symbol im Infobereich erreichbar.
    Hidden,
    /// Kein (verlässliches) Symbol im Infobereich: nichts versteckt.
    NoTray,
}

/// Versteckt das Fenster (`hide`) nur, wenn es in den Infobereich gehen kann.
///
/// # Errors
/// Wenn das Verstecken selbst scheitert.
pub fn hide_if_tray<E>(
    available: bool,
    hide: impl FnOnce() -> Result<(), E>,
) -> Result<HideOutcome, E> {
    if !available {
        return Ok(HideOutcome::NoTray);
    }
    hide()?;
    Ok(HideOutcome::Hidden)
}

/// App-Befehl `hide_to_tray`: Schließen-Knopf mit „Beim Schließen in den Infobereich“.
/// Versteckt das aufrufende Fenster nur, wenn es ein Symbol im Infobereich gibt; sonst
/// `noTray` (die Oberfläche beendet AEGIS dann). Verändert nichts außer der Sichtbarkeit.
///
/// # Errors
/// Wenn das Fenster sich nicht verstecken lässt (Meldung als Text).
#[tauri::command]
pub fn hide_to_tray<R: Runtime>(window: WebviewWindow<R>) -> Result<HideOutcome, String> {
    let available =
        close_to_tray_available(window.app_handle().tray_by_id(tray::TRAY_ID).is_some());
    hide_if_tray(available, || window.hide()).map_err(|error| error.to_string())
}

/// Fenster-Ereignisse aller Fenster (`Builder::on_window_event`).
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { .. } = event
        && close_action(window.label()) == CloseAction::ExitApp
    {
        // Nicht verhindern: Das Fenster schließt, und die App endet geordnet
        // (Tray-Symbol und Einzelinstanz-Sperre werden dabei freigegeben).
        window.app_handle().exit(0);
    }
}

/// Holt das Hauptfenster nach vorn: zeigen, aus der Taskleiste holen, Fokus setzen.
///
/// Aufgerufen vom Tray-Menü, vom Linksklick auf das Tray-Symbol und beim zweiten Start.
/// Fehler sind nicht fatal (das Fenster bleibt dann, wo es ist) und werden nur gemeldet.
/// `true`, wenn das Fenster gefunden wurde und jeder Schritt gelang.
pub fn reveal_main<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        eprintln!("AEGIS: Hauptfenster nicht gefunden – nichts zu zeigen");
        return false;
    };
    let mut revealed = true;
    for (step, result) in [
        ("zeigen", window.show()),
        ("wiederherstellen", window.unminimize()),
        ("fokussieren", window.set_focus()),
    ] {
        if let Err(error) = result {
            eprintln!("AEGIS: Hauptfenster {step} fehlgeschlagen: {error}");
            revealed = false;
        }
    }
    revealed
}

#[cfg(test)]
mod tests {
    use tauri::RunEvent;
    use tauri::test::MockRuntime;

    use super::*;
    use crate::test_support;

    /// Lässt die Test-Laufzeit laufen und schließt nach dem Start das Fenster `label` („main“
    /// legt Tauri dabei selbst aus `tauri.conf.json` an). Dessen Schließ-Ereignis geht an
    /// [`on_window_event`] (die Test-Laufzeit meldet es nur an die Ereignisschleife, nicht an
    /// `Builder::on_window_event`); danach schließt der Test die übrigen Fenster ungeprüft,
    /// damit die Schleife endet. `AppHandle::exit` ist in der Test-Laufzeit nicht umgesetzt und
    /// endet in einer Panic „not implemented“ – so wird sichtbar, ob die App beendet würde.
    fn close_and_run(label: &'static str) -> i32 {
        let app = test_support::app();
        if label != MAIN_WINDOW_LABEL {
            test_support::window(&app, label);
        }
        app.run_return(move |handle: &AppHandle<MockRuntime>, event| match event {
            RunEvent::Ready => handle.get_webview_window(label).unwrap().close().unwrap(),
            RunEvent::WindowEvent {
                label: closed,
                event,
                ..
            } if closed == label => {
                if let Some(window) = handle.get_webview_window(&closed) {
                    on_window_event(&window.as_ref().window(), &event);
                }
                for (other, window) in handle.webview_windows() {
                    if other != label {
                        window.close().unwrap();
                    }
                }
            }
            _ => {}
        })
    }

    #[test]
    #[should_panic(expected = "not implemented")]
    fn schliessen_des_hauptfensters_beendet_die_app() {
        close_and_run(MAIN_WINDOW_LABEL);
    }

    #[test]
    fn schliessen_eines_anderen_fensters_beendet_die_app_nicht() {
        assert_eq!(close_and_run("fremd"), 0);
    }

    #[test]
    fn verstecken_nur_mit_symbol_im_infobereich() {
        let mut hidden = 0;
        assert_eq!(
            hide_if_tray::<()>(false, || {
                hidden += 1;
                Ok(())
            }),
            Ok(HideOutcome::NoTray)
        );
        assert_eq!(hidden, 0, "ohne Symbol wird nichts versteckt");
        assert_eq!(
            hide_if_tray::<()>(true, || {
                hidden += 1;
                Ok(())
            }),
            Ok(HideOutcome::Hidden)
        );
        assert_eq!(hidden, 1);
        assert_eq!(hide_if_tray(true, || Err("kaputt")), Err("kaputt"));
    }

    #[test]
    fn infobereich_nur_mit_symbol_und_nicht_unter_linux() {
        assert!(!close_to_tray_available(false));
        assert_eq!(
            close_to_tray_available(true),
            cfg!(any(windows, target_os = "macos"))
        );
        if cfg!(target_os = "linux") {
            assert!(!close_to_tray_available(true), "Linux: Anzeige nicht feststellbar");
        }
    }

    #[test]
    fn ergebnis_von_hide_to_tray_als_json() {
        assert_eq!(
            serde_json::to_value(HideOutcome::Hidden).unwrap(),
            serde_json::json!("hidden")
        );
        assert_eq!(
            serde_json::to_value(HideOutcome::NoTray).unwrap(),
            serde_json::json!("noTray")
        );
    }

    #[test]
    fn hauptfenster_nach_vorn_holen() {
        let app = test_support::app();
        assert!(!reveal_main(app.handle()), "ohne Hauptfenster nichts zu zeigen");
        test_support::window(&app, MAIN_WINDOW_LABEL);
        assert!(reveal_main(app.handle()));
    }

    #[test]
    fn hauptfenster_schliessen_beendet_die_app() {
        assert_eq!(close_action(MAIN_WINDOW_LABEL), CloseAction::ExitApp);
    }

    #[test]
    fn andere_fenster_behalten_das_standardverhalten() {
        for label in ["", "Main", "main ", "settings", "mainx"] {
            assert_eq!(close_action(label), CloseAction::Default, "{label:?}");
        }
    }

    #[test]
    fn kennung_passt_zur_konfiguration() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 1, "genau ein Fenster");
        assert_eq!(windows[0]["label"], MAIN_WINDOW_LABEL);
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(
            capability["windows"],
            serde_json::json!([MAIN_WINDOW_LABEL])
        );
    }

    /// `--aegis-bg` im Block nach `selector` aus den Design-Tokens.
    fn token_background(selector: &str) -> Color {
        let css = include_str!("../../../../packages/ui/src/tokens/tokens.css");
        let block = &css[css.find(selector).unwrap()..];
        let value = block
            .split_once("--aegis-bg:")
            .unwrap()
            .1
            .split_once(';')
            .unwrap()
            .0
            .trim();
        let hex = value.strip_prefix('#').unwrap();
        assert_eq!(hex.len(), 6, "{value}");
        let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap();
        Color(channel(0), channel(2), channel(4), 0xff)
    }

    #[test]
    fn hintergrund_wie_die_design_tokens() {
        assert_eq!(BACKGROUND_DARK, token_background("[data-theme='dark'] {"));
        assert_eq!(BACKGROUND_LIGHT, token_background("[data-theme='light'] {"));
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["app"]["windows"][0]["backgroundColor"]
                .as_str()
                .unwrap()
                .to_ascii_lowercase(),
            "#07090c",
            "Standard vor dem Setup = dunkles Theme"
        );
    }

    #[test]
    fn hintergrund_folgt_dem_farbschema_des_systems() {
        assert_eq!(background_for(Theme::Light), BACKGROUND_LIGHT);
        assert_eq!(background_for(Theme::Dark), BACKGROUND_DARK);
    }

    #[test]
    fn hauptfenster_ist_rahmenlos_mit_schatten_und_mindestgroesse() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = &config["app"]["windows"][0];
        assert_eq!(main["decorations"], false, "eigene Titelleiste");
        // Unter Windows: 1-px-Rand, Schatten und (Windows 11) runde Ecken trotz Rahmenlosigkeit.
        assert_eq!(main["shadow"], true);
        assert_eq!(main["resizable"], true);
        assert!(main["minWidth"].as_u64().is_some_and(|w| w >= 1024));
        assert!(main["minHeight"].as_u64().is_some_and(|h| h >= 680));
    }
}
