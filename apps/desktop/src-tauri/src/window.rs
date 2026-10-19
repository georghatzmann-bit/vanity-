//! Hauptfenster: nach vorn holen und Verhalten beim Schließen.
//!
//! Das Fenster ist rahmenlos; Titelleiste und Fensterknöpfe zeichnet die Oberfläche selbst.
//! **Schließen entscheidet die Oberfläche:** Mit der Einstellung „Beim Schließen in den
//! Infobereich“ (Standard: an) ruft sie `hide()` auf – AEGIS läuft im Infobereich weiter.
//! Ruft sie `close()` auf, endet die App vollständig.
//!
//! Damit kein unsichtbarer Prozess übrig bleibt, beendet jede Schließ-Anforderung des
//! Hauptfensters die ganze App – auch das Tray-Symbol hält sie dann nicht am Leben. Das gilt
//! ebenso für Alt+F4 und „Fenster schließen“ in der Taskleiste: Diese Wege laufen am
//! Frontend vorbei und beenden AEGIS deshalb immer.

use tauri::window::Color;
use tauri::{AppHandle, Manager, Runtime, Theme, Window, WindowEvent};

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
pub fn reveal_main<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        eprintln!("AEGIS: Hauptfenster nicht gefunden – nichts zu zeigen");
        return;
    };
    for (step, result) in [
        ("zeigen", window.show()),
        ("wiederherstellen", window.unminimize()),
        ("fokussieren", window.set_focus()),
    ] {
        if let Err(error) = result {
            eprintln!("AEGIS: Hauptfenster {step} fehlgeschlagen: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
