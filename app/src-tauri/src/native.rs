//! Windows-Integration: Tray-Symbol, Overlay-Fenster, globales Tastenkürzel, Schließen in den Tray.

use serde::Serialize;
use tauri::menu::{IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow, Window, WindowEvent, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::error::{CmdResult, LockExt};
use crate::models::{NativeSettings, TrayRecent};
use crate::state::{Core, Shared};

pub const TRAY_ID: &str = "pulsar-tray";
pub const OVERLAY_MARGIN: f64 = 24.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayLaunch {
    game_id: String,
}

#[derive(Debug, Clone, Serialize)]
struct TrayAction {
    action: &'static str,
}

#[derive(Debug, Clone, Serialize)]
struct Empty {}

struct Labels {
    open: &'static str,
    recent: &'static str,
    empty: &'static str,
    bigpicture: &'static str,
    dice: &'static str,
    overlay: &'static str,
    quit: &'static str,
}

fn labels(lang: &str) -> Labels {
    if lang.eq_ignore_ascii_case("en") {
        Labels {
            open: "Open Pulsar",
            recent: "Recently played",
            empty: "Nothing played yet",
            bigpicture: "Big Picture",
            dice: "Random game",
            overlay: "Overlay",
            quit: "Quit",
        }
    } else {
        Labels {
            open: "Pulsar öffnen",
            recent: "Zuletzt gespielt",
            empty: "Noch nichts gespielt",
            bigpicture: "Big Picture",
            dice: "Zufallsspiel",
            overlay: "Overlay",
            quit: "Beenden",
        }
    }
}

fn short(name: &str, max: usize) -> String {
    let n = name.trim();
    if n.chars().count() <= max {
        n.to_string()
    } else {
        format!("{}…", n.chars().take(max - 1).collect::<String>())
    }
}

// =============================================================================================
// Fenster
// =============================================================================================

/// Hauptfenster zeigen und in den Vordergrund holen.
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn position_overlay(app: &AppHandle, w: &WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| {
            app.get_webview_window("main")
                .and_then(|m| m.current_monitor().ok().flatten())
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(m) = monitor else { return };
    let scale = m.scale_factor();
    let area = m.work_area();
    let cur_scale = w.scale_factor().unwrap_or(1.0).max(0.1);
    let width_logical = w
        .outer_size()
        .map(|s| s.width as f64 / cur_scale)
        .unwrap_or(380.0);
    let width = (width_logical * scale).round() as i32;
    let margin = (OVERLAY_MARGIN * scale).round() as i32;
    let x = area.position.x + area.size.width as i32 - width - margin;
    let y = area.position.y + margin;
    let _ = w.set_position(PhysicalPosition::new(x.max(area.position.x), y));
}

/// Overlay ein-/ausblenden. Liefert `true`, wenn es jetzt sichtbar ist.
pub fn toggle_overlay(app: &AppHandle) -> CmdResult<bool> {
    let w = app
        .get_webview_window("overlay")
        .ok_or_else(|| "Das Overlay-Fenster ist nicht verfügbar.".to_string())?;
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
        return Ok(false);
    }
    position_overlay(app, &w);
    w.show().map_err(|e| format!("Das Overlay konnte nicht angezeigt werden ({e})."))?;
    // Nach einem Monitorwechsel mit anderer Skalierung passt sich die Größe an → neu ausrichten
    position_overlay(app, &w);
    let _ = w.set_always_on_top(true);
    let _ = w.set_focus();
    Ok(true)
}

/// Sauber beenden: Sitzungen speichern, Datenbank schließen, App beenden.
pub fn quit(app: &AppHandle, core: &Core) {
    finalize(core);
    app.exit(0);
}

/// Sitzungen abschließen und die Datenbank schließen (mehrfach aufrufbar).
pub fn finalize(core: &Core) {
    let first = {
        let mut n = core.native.lock_safe();
        let first = !n.quitting;
        n.quitting = true;
        first
    };
    if first {
        crate::opt::shutdown(core);
        core.tracker.shutdown(core);
        drop(core.db.replace(None));
    }
}

/// Fenster-Ereignisse: Overlay nie zerstören, Hauptfenster ggf. in den Tray.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else { return };
    let app = window.app_handle();
    match window.label() {
        "overlay" => {
            api.prevent_close();
            let _ = window.hide();
        }
        "main" => {
            let core = app.state::<Shared>();
            let (to_tray, quitting) = {
                let n = core.native.lock_safe();
                (n.settings.close_to_tray, n.quitting)
            };
            if quitting {
                return;
            }
            api.prevent_close();
            if to_tray {
                let _ = window.hide();
            } else {
                quit(app, &core);
            }
        }
        _ => {}
    }
}

// =============================================================================================
// Tray
// =============================================================================================

fn build_menu(app: &AppHandle, lang: &str, recent: &[TrayRecent]) -> tauri::Result<Menu<Wry>> {
    let l = labels(lang);
    let open = MenuItem::with_id(app, "open", l.open, true, None::<&str>)?;
    let mut recent_items: Vec<MenuItem<Wry>> = Vec::new();
    for r in recent.iter().filter(|r| !r.id.trim().is_empty()).take(10) {
        recent_items.push(MenuItem::with_id(
            app,
            format!("recent:{}", r.id),
            short(&r.name, 48),
            true,
            None::<&str>,
        )?);
    }
    if recent_items.is_empty() {
        recent_items.push(MenuItem::with_id(app, "recent-empty", l.empty, false, None::<&str>)?);
    }
    let refs: Vec<&dyn IsMenuItem<Wry>> = recent_items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
    let sub = Submenu::with_items(app, l.recent, true, &refs)?;
    let bigpicture = MenuItem::with_id(app, "bigpicture", l.bigpicture, true, None::<&str>)?;
    let dice = MenuItem::with_id(app, "dice", l.dice, true, None::<&str>)?;
    let overlay = MenuItem::with_id(app, "overlay", l.overlay, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", l.quit, true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(app, &[&open, &sub, &sep1, &bigpicture, &dice, &overlay, &sep2, &quit])
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref().to_string();
    match id.as_str() {
        "open" => show_main(app),
        "bigpicture" => {
            show_main(app);
            let _ = app.emit("tray://action", TrayAction { action: "bigpicture" });
        }
        "dice" => {
            show_main(app);
            let _ = app.emit("tray://action", TrayAction { action: "dice" });
        }
        "overlay" => {
            let _ = toggle_overlay(app);
        }
        "quit" => {
            let core = app.state::<Shared>();
            quit(app, &core);
        }
        other => {
            if let Some(game_id) = other.strip_prefix("recent:") {
                let _ = app.emit("tray://launch", TrayLaunch { game_id: game_id.to_string() });
            }
        }
    }
}

/// Tray-Symbol anlegen (beim Start).
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let (lang, recent) = {
        let core = app.state::<Shared>();
        let n = core.native.lock_safe();
        (n.settings.language.clone(), n.recent.clone())
    };
    let menu = build_menu(app, &lang, &recent)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Pulsar")
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main(tray.app_handle()),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn refresh_tray(app: &AppHandle, core: &Core) -> CmdResult<()> {
    let (lang, recent) = {
        let n = core.native.lock_safe();
        (n.settings.language.clone(), n.recent.clone())
    };
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return Ok(()) };
    let menu = build_menu(app, &lang, &recent).map_err(|e| format!("Tray-Menü: {e}"))?;
    tray.set_menu(Some(menu)).map_err(|e| format!("Tray-Menü: {e}"))
}

// =============================================================================================
// Tastenkürzel
// =============================================================================================

/// Handler für das globale Overlay-Kürzel.
pub fn on_shortcut(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state == ShortcutState::Pressed {
        let _ = toggle_overlay(app);
    }
}

/// Overlay-Kürzel (neu) registrieren. Bei einem Fehler bleibt das alte Kürzel aktiv.
pub fn apply_shortcut(app: &AppHandle, core: &Core, wanted: &str) -> CmdResult<()> {
    let wanted = wanted.trim();
    let current = core.native.lock_safe().registered_shortcut.clone();
    let gs = app.global_shortcut();
    if wanted.is_empty() {
        if let Some(c) = current {
            let _ = gs.unregister(c.as_str());
        }
        core.native.lock_safe().registered_shortcut = None;
        return Ok(());
    }
    let parsed: Shortcut = wanted
        .parse()
        .map_err(|_| format!("Ungültiges Tastenkürzel: „{wanted}“ (Beispiel: Alt+Shift+N)"))?;
    let current_parsed = current.as_deref().and_then(|c| c.parse::<Shortcut>().ok());
    if current_parsed == Some(parsed) {
        return Ok(());
    }
    if let Some(c) = current_parsed {
        let _ = gs.unregister(c);
    }
    match gs.register(parsed) {
        Ok(()) => {
            core.native.lock_safe().registered_shortcut = Some(wanted.to_string());
            Ok(())
        }
        Err(_) => {
            if let Some(c) = current_parsed {
                let _ = gs.register(c);
            }
            Err(format!(
                "Das Tastenkürzel „{wanted}“ ist bereits von einem anderen Programm belegt. Bitte wähle ein anderes."
            ))
        }
    }
}

// =============================================================================================
// Befehle
// =============================================================================================

#[tauri::command]
pub async fn apply_native_settings(
    app: AppHandle,
    state: State<'_, Shared>,
    settings: NativeSettings,
) -> CmdResult<()> {
    let core = state.inner().clone();
    let mut settings = settings;
    settings.language = if settings.language.eq_ignore_ascii_case("en") { "en".into() } else { "de".into() };
    let lang_changed = {
        let mut n = core.native.lock_safe();
        let changed = n.settings.language != settings.language;
        n.settings.close_to_tray = settings.close_to_tray;
        n.settings.minimize_on_launch = settings.minimize_on_launch;
        n.settings.language = settings.language.clone();
        changed
    };
    if lang_changed {
        let _ = refresh_tray(&app, &core);
    }
    let result = apply_shortcut(&app, &core, &settings.overlay_shortcut);
    if result.is_ok() {
        core.native.lock_safe().settings.overlay_shortcut = settings.overlay_shortcut.trim().to_string();
    }
    result
}

#[tauri::command]
pub async fn overlay_toggle(app: AppHandle) -> CmdResult<bool> {
    toggle_overlay(&app)
}

#[tauri::command]
pub async fn tray_set_recent(app: AppHandle, state: State<'_, Shared>, items: Vec<TrayRecent>) -> CmdResult<()> {
    let core = state.inner().clone();
    core.native.lock_safe().recent = items.into_iter().take(10).collect();
    refresh_tray(&app, &core)
}

#[tauri::command]
pub async fn quit_app(app: AppHandle, state: State<'_, Shared>) -> CmdResult<()> {
    let core = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        // Antwort zuerst zurückgeben
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        quit(&app, &core);
    });
    Ok(())
}

/// Wird vom Single-Instance-Plugin aufgerufen, wenn Pulsar ein zweites Mal gestartet wird.
pub fn on_second_instance(app: &AppHandle) {
    show_main(app);
    let _ = app.emit("app://second-instance", Empty {});
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_shortening() {
        assert_eq!(labels("en").quit, "Quit");
        assert_eq!(labels("de").recent, "Zuletzt gespielt");
        assert_eq!(labels("fr").open, "Pulsar öffnen");
        assert_eq!(short("Kurz", 10), "Kurz");
        assert_eq!(short("Ein sehr langer Spielname", 10).chars().count(), 10);
    }

    #[test]
    fn shortcut_parsing() {
        assert!("Alt+Shift+N".parse::<Shortcut>().is_ok());
        assert!("CommandOrControl+Shift+O".parse::<Shortcut>().is_ok());
        assert!("Alt+Shift+Unsinn".parse::<Shortcut>().is_err());
    }
}
