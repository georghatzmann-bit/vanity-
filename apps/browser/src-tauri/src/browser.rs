//! Fenster, Tabs und Regeln der Navigation. Jedes Browser-Fenster hat eine Leiste (WebView
//! `chrome-<fenster>`, lokale App-Seite) und je Tab ein WebView `tab-<n>` darunter. Nur die
//! Leiste darf Befehle aufrufen (Capability); Webseiten bekommen keine Rechte.
//!
//! Kennungen von Fenstern und Tabs sind zufällig (keine Zähler, kein „ghost“ im Namen): Tauri
//! zeigt jedem WebView seine Kennung, Seiten sollen daraus weder Ghost-Modus noch Sitzung
//! ablesen können.

use std::collections::HashSet;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};
use std::time::{Duration, Instant};

use aegis_browser_core::address::{self, display_host, navigable, upgrade};
use aegis_browser_core::blocker::{Blocker, List, MAX_LIST};
use aegis_browser_core::bookmarks::{self, Bookmark};
use aegis_browser_core::settings::{self, Profile, Settings, USER_AGENT};
use serde::Serialize;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, Url, Webview,
    WebviewBuilder, WebviewUrl, WindowEvent,
};

use crate::store::Store;

/// Höhe der Leiste (Tabs + Adresszeile) in logischen Pixeln.
pub const CHROME_HEIGHT: f64 = 88.0;
/// Höchstzahl Tabs je Fenster.
const MAX_TABS: usize = 40;
/// Übliche Ports von Tor (Tor Browser 9150, Tor-/Arti-Dienst 9050).
const TOR_PORTS: [u16; 2] = [9150, 9050];
/// Pop-ups: höchstens so viele je Fenster im Zeitfenster [`POPUP_WINDOW`].
const POPUP_LIMIT: usize = 3;
const POPUP_WINDOW: Duration = Duration::from_secs(10);
/// Dieselbe HTTP-Adresse innerhalb dieser Zeit erneut → Umleitungsschleife, nicht anheben.
const UPGRADE_LOOP: Duration = Duration::from_secs(15);

/// Art eines Fensters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowKind {
    /// Normales Fenster (eigenes Profil im Datenordner).
    Normal,
    /// Ghost: InPrivate (kein Verlauf, keine Cookies, kein Cache bleiben), optional über einen
    /// SOCKS-Proxy (Tor/Arti).
    Ghost {
        /// Port des SOCKS-Proxys auf 127.0.0.1 (`None`: ohne Proxy).
        tor: Option<u16>,
    },
}

impl WindowKind {
    fn profile(self) -> Profile {
        match self {
            Self::Normal => Profile::Normal,
            Self::Ghost { tor: None } => Profile::Ghost,
            Self::Ghost { tor: Some(port) } => Profile::Tor(port),
        }
    }
}

#[derive(Debug, Clone)]
struct Tab {
    id: u32,
    window: String,
    url: String,
    title: String,
    loading: bool,
    /// Auf HTTPS angehobene Adresse, deren HTTP-Fassung der Nutzer erlauben könnte.
    insecure: Option<String>,
    /// Zuletzt angehobene HTTP-Adresse und wann (eine Seite, die gleich wieder auf HTTP
    /// umleitet – auch per Skript –, wird nicht endlos angehoben).
    upgraded: Option<(String, Instant)>,
    /// Blocker im WebView eingehängt (nur Windows).
    filtered: bool,
}

#[derive(Debug, Clone)]
struct WindowInfo {
    label: String,
    kind: WindowKind,
    active: Option<u32>,
    /// Inhalt verdeckt (Leiste zeigt ein Menü über die ganze Fläche).
    content_hidden: bool,
    /// Zeitpunkte der letzten Pop-ups.
    popups: Vec<Instant>,
}

#[derive(Debug, Default)]
struct Inner {
    windows: Vec<WindowInfo>,
    tabs: Vec<Tab>,
    settings: Settings,
    bookmarks: Vec<Bookmark>,
    /// `„<bereich>|<host>“`, für die der Nutzer in dieser Sitzung HTTP erlaubt hat. Bereich:
    /// `normal` für normale Fenster, sonst die Kennung des Ghost-Fensters.
    http_ok: HashSet<String>,
    /// Zeitpunkt der geladenen Listen (Unix-Sekunden).
    lists_updated: Option<i64>,
}

/// Zustand des Browsers.
pub struct Browser {
    inner: Mutex<Inner>,
    blocker: Arc<RwLock<Blocker>>,
    /// Blocker eingeschaltet (gilt sofort für alle Tabs).
    blocking: Arc<AtomicBool>,
    store: Store,
}

impl std::fmt::Debug for Browser {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Browser").finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
struct ListsMeta {
    updated: Option<i64>,
}

#[cfg(windows)]
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// Zufällige, noch freie Kennung (Zufall aus dem Hash-Schlüssel des Prozesses).
fn fresh_id(taken: impl Fn(u32) -> bool) -> u32 {
    let state = std::collections::hash_map::RandomState::new();
    let mut salt = 0u64;
    loop {
        let mut hasher = state.build_hasher();
        hasher.write_u64(salt);
        let id = u32::try_from(hasher.finish() & 0x7fff_ffff).unwrap_or(1);
        if id != 0 && !taken(id) {
            return id;
        }
        salt += 1;
    }
}

impl Browser {
    /// Lädt Einstellungen, Lesezeichen und Filterlisten aus dem Datenordner.
    ///
    /// # Errors
    /// Datenordner unbekannt.
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("Datenordner unbekannt: {e}"))?;
        let store = Store::new(dir);
        let settings: Settings = store.read_json::<Settings>("settings.json").cleaned();
        let bookmarks: Vec<Bookmark> = store
            .read_json::<Vec<Bookmark>>("bookmarks.json")
            .into_iter()
            .filter_map(|b| Bookmark::new(&b.title, &b.url).ok())
            .take(bookmarks::MAX_BOOKMARKS)
            .collect();
        let meta: ListsMeta = store.read_json("lists.json");
        let blocker = load_blocker(&store);
        Ok(Self {
            blocking: Arc::new(AtomicBool::new(settings.block_trackers)),
            inner: Mutex::new(Inner {
                settings,
                bookmarks,
                lists_updated: meta.updated,
                ..Inner::default()
            }),
            blocker: Arc::new(RwLock::new(blocker)),
            store,
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn rules(&self) -> usize {
        self.blocker.read().map_or(0, |b| b.rules())
    }
}

fn load_blocker(store: &Store) -> Blocker {
    let texts: Vec<String> = List::ALL
        .iter()
        .filter_map(|l| store.read_text(l.file_name(), MAX_LIST))
        .collect();
    let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
    Blocker::from_lists(&refs)
}

/// Bereich der HTTP-Ausnahmen eines Fensters (Ghost-Fenster teilen sie mit niemandem).
fn http_scope(inner: &Inner, window: &str) -> String {
    match inner
        .windows
        .iter()
        .find(|w| w.label == window)
        .map(|w| w.kind)
    {
        Some(WindowKind::Normal) => "normal".to_owned(),
        _ => window.to_owned(),
    }
}

fn http_allowed(inner: &Inner, window: &str, url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    inner
        .http_ok
        .contains(&format!("{}|{host}", http_scope(inner, window)))
}

/* ------------------------------------------------------------------ Ansicht */

/// Ein Tab für die Leiste.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabView {
    id: u32,
    url: String,
    host: String,
    title: String,
    loading: bool,
    secure: bool,
    insecure: Option<String>,
}

/// Zustand eines Fensters für die Leiste.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    window: String,
    ghost: bool,
    tor: bool,
    /// Port des SOCKS-Proxys im Tor-Modus.
    proxy_port: Option<u16>,
    tabs: Vec<TabView>,
    active: Option<u32>,
    settings: Settings,
    bookmarks: Vec<Bookmark>,
    rules: usize,
    lists_updated: Option<i64>,
    /// Blocker wirkt im aktiven Tab (nur Windows/WebView2, eingeschaltet, Listen geladen,
    /// im Tab eingehängt).
    filtering: bool,
}

fn view(browser: &Browser, inner: &Inner, window: &str) -> View {
    let info = inner.windows.iter().find(|w| w.label == window);
    let kind = info.map_or(WindowKind::Normal, |w| w.kind);
    let active = info.and_then(|w| w.active);
    let rules = browser.rules();
    View {
        window: window.to_owned(),
        ghost: matches!(kind, WindowKind::Ghost { .. }),
        tor: matches!(kind, WindowKind::Ghost { tor: Some(_) }),
        proxy_port: match kind {
            WindowKind::Ghost { tor } => tor,
            WindowKind::Normal => None,
        },
        tabs: inner
            .tabs
            .iter()
            .filter(|t| t.window == window)
            .map(|t| {
                let parsed = Url::parse(&t.url).ok();
                TabView {
                    id: t.id,
                    url: t.url.clone(),
                    host: parsed.as_ref().map(display_host).unwrap_or_default(),
                    title: t.title.clone(),
                    loading: t.loading,
                    secure: parsed.as_ref().is_some_and(|u| u.scheme() == "https"),
                    insecure: t.insecure.clone(),
                }
            })
            .collect(),
        active,
        settings: inner.settings.clone(),
        bookmarks: inner.bookmarks.clone(),
        rules,
        lists_updated: inner.lists_updated,
        filtering: cfg!(windows)
            && inner.settings.block_trackers
            && rules > 0
            && inner
                .tabs
                .iter()
                .any(|t| Some(t.id) == active && t.filtered),
    }
}

fn chrome_label(window: &str) -> String {
    format!("chrome-{window}")
}

fn tab_label(id: u32) -> String {
    format!("tab-{id}")
}

/// Schickt den Zustand an die Leiste eines Fensters.
fn publish<R: Runtime>(app: &AppHandle<R>, window: &str) {
    let browser = app.state::<Browser>();
    let snapshot = {
        let inner = browser.lock();
        view(&browser, &inner, window)
    };
    let _ = app.emit_to(chrome_label(window), "browser://state", snapshot);
}

fn notice<R: Runtime>(app: &AppHandle<R>, window: &str, text: &str) {
    let _ = app.emit_to(chrome_label(window), "browser://notice", text.to_owned());
}

/* ------------------------------------------------------------------ Fenster */

/// Öffnet ein Browser-Fenster mit Leiste und einem ersten Tab.
///
/// # Errors
/// Fenster lässt sich nicht anlegen.
pub fn open_window<R: Runtime>(app: &AppHandle<R>, kind: WindowKind) -> Result<String, String> {
    let browser = app.state::<Browser>();
    let label = {
        let mut inner = browser.lock();
        let id = fresh_id(|id| {
            let label = format!("win-{id:x}");
            inner.windows.iter().any(|w| w.label == label)
        });
        let label = format!("win-{id:x}");
        inner.windows.push(WindowInfo {
            label: label.clone(),
            kind,
            active: None,
            content_hidden: false,
            popups: Vec::new(),
        });
        label
    };
    let title = match kind {
        WindowKind::Normal => "AEGIS Browser",
        WindowKind::Ghost { tor: None } => "AEGIS Browser – Ghost",
        WindowKind::Ghost { tor: Some(_) } => "AEGIS Browser – Ghost über Tor-Proxy",
    };
    let window = tauri::window::WindowBuilder::new(app, &label)
        .title(title)
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .build()
        .map_err(|e| e.to_string())?;
    window
        .add_child(
            WebviewBuilder::new(chrome_label(&label), WebviewUrl::App("index.html".into())),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1280.0, CHROME_HEIGHT),
        )
        .map_err(|e| e.to_string())?;
    let handle = app.clone();
    let event_label = label.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
            layout(&handle, &event_label);
        }
        WindowEvent::Destroyed => {
            let browser = handle.state::<Browser>();
            let mut inner = browser.lock();
            inner.tabs.retain(|t| t.window != event_label);
            inner.windows.retain(|w| w.label != event_label);
            let scope = format!("{event_label}|");
            inner.http_ok.retain(|k| !k.starts_with(&scope));
        }
        _ => {}
    });
    let home = browser.lock().settings.home.clone();
    open_tab(app, &label, home.as_deref().unwrap_or("about:blank"), true)?;
    Ok(label)
}

/// Größe und Sichtbarkeit von Leiste und Tabs eines Fensters anpassen.
fn layout<R: Runtime>(app: &AppHandle<R>, window: &str) {
    let Some(win) = app.get_window(window) else {
        return;
    };
    let (Ok(size), Ok(scale)) = (win.inner_size(), win.scale_factor()) else {
        return;
    };
    let logical = size.to_logical::<f64>(scale);
    let (width, height) = (logical.width, logical.height);
    if let Some(chrome) = app.get_webview(&chrome_label(window)) {
        let _ = chrome.set_position(LogicalPosition::new(0.0, 0.0));
        let _ = chrome.set_size(LogicalSize::new(width, CHROME_HEIGHT));
    }
    let browser = app.state::<Browser>();
    let inner = browser.lock();
    let info = inner.windows.iter().find(|w| w.label == window);
    let active = info.and_then(|w| w.active);
    let hidden = info.is_some_and(|w| w.content_hidden);
    for tab in inner.tabs.iter().filter(|t| t.window == window) {
        let Some(webview) = app.get_webview(&tab_label(tab.id)) else {
            continue;
        };
        if Some(tab.id) == active && !hidden {
            let _ = webview.set_position(LogicalPosition::new(0.0, CHROME_HEIGHT));
            let _ = webview.set_size(LogicalSize::new(width, (height - CHROME_HEIGHT).max(1.0)));
            let _ = webview.show();
        } else {
            let _ = webview.hide();
        }
    }
}

/* ------------------------------------------------------------------ Tabs */

/// Antwortet auf `127.0.0.1:<port>` ein SOCKS5-Proxy (Begrüßung „ohne Anmeldung“)? Das ist
/// kein Beweis für Tor – die Oberfläche sagt das.
fn socks5_ready(port: u16) -> bool {
    use std::io::{Read, Write};
    let timeout = Duration::from_millis(400);
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        timeout,
    ) else {
        return false;
    };
    let mut answer = [0u8; 2];
    stream.set_read_timeout(Some(timeout)).is_ok()
        && stream.set_write_timeout(Some(timeout)).is_ok()
        && stream.write_all(&[5, 1, 0]).is_ok()
        && stream.read_exact(&mut answer).is_ok()
        && answer == [5, 0]
}

/// Pop-up erlaubt? Höchstens [`POPUP_LIMIT`] je Fenster in [`POPUP_WINDOW`].
fn popup_allowed(inner: &mut Inner, window: &str) -> bool {
    let Some(info) = inner.windows.iter_mut().find(|w| w.label == window) else {
        return false;
    };
    let now = Instant::now();
    info.popups
        .retain(|t| now.saturating_duration_since(*t) < POPUP_WINDOW);
    if info.popups.len() >= POPUP_LIMIT {
        return false;
    }
    info.popups.push(now);
    true
}

/// Öffnet einen Tab im Fenster `window` mit der Adresse `target` (bereits geprüft). Der Tab
/// startet leer; erst wenn Blocker und Prüfungen eingehängt sind, lädt er `target`.
/// `activate`: nach vorn holen (Pop-ups öffnen im Hintergrund).
fn open_tab<R: Runtime>(
    app: &AppHandle<R>,
    window: &str,
    target: &str,
    activate: bool,
) -> Result<u32, String> {
    let url = Url::parse(target).map_err(|e| e.to_string())?;
    if !navigable(&url) {
        return Err("Diese Adresse öffnet der Browser nicht.".into());
    }
    let browser = app.state::<Browser>();
    let (id, javascript, kind) = {
        let mut inner = browser.lock();
        if inner.tabs.iter().filter(|t| t.window == window).count() >= MAX_TABS {
            return Err("Zu viele Tabs in diesem Fenster.".into());
        }
        let kind = inner
            .windows
            .iter()
            .find(|w| w.label == window)
            .map(|w| w.kind)
            .ok_or("Fenster unbekannt.")?;
        let id = fresh_id(|id| inner.tabs.iter().any(|t| t.id == id));
        inner.tabs.push(Tab {
            id,
            window: window.to_owned(),
            url: "about:blank".to_owned(),
            title: String::new(),
            loading: true,
            insecure: None,
            upgraded: None,
            filtered: false,
        });
        (id, inner.settings.javascript, kind)
    };
    match create_tab(app, window, id, kind, javascript) {
        Ok(webview) => {
            prepare(app, &webview, window, id);
            if url.as_str() != "about:blank" {
                let _ = webview.navigate(url);
            }
        }
        Err(e) => {
            browser.lock().tabs.retain(|t| t.id != id);
            return Err(e);
        }
    }
    {
        let mut inner = browser.lock();
        if let Some(info) = inner.windows.iter_mut().find(|w| w.label == window)
            && (activate || info.active.is_none())
        {
            info.active = Some(id);
        }
    }
    layout(app, window);
    Ok(id)
}

/// Legt das WebView eines Tabs an (leere Seite, alle Regeln als Rückrufe).
fn create_tab<R: Runtime>(
    app: &AppHandle<R>,
    window: &str,
    id: u32,
    kind: WindowKind,
    javascript: bool,
) -> Result<Webview<R>, String> {
    let label = tab_label(id);
    let data = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let profile = kind.profile();
    // Je Profil ein eigener Datenordner mit festen Schaltern (auch der Proxy steht in den
    // Schaltern – wry setzt ihn nicht, sobald eigene Schalter da sind).
    let mut builder = WebviewBuilder::new(
        &label,
        WebviewUrl::External(Url::parse("about:blank").map_err(|e| e.to_string())?),
    )
    .user_agent(USER_AGENT)
    .additional_browser_args(&settings::browser_args(profile)?)
    .data_directory(data.join(profile.folder()));
    if matches!(kind, WindowKind::Ghost { .. }) {
        builder = builder.incognito(true);
    }
    if !javascript {
        builder = builder.disable_javascript();
    }
    let nav_app = app.clone();
    let nav_window = window.to_owned();
    builder = builder.on_navigation(move |url| allow_navigation(&nav_app, &nav_window, id, url));
    let load_app = app.clone();
    let load_window = window.to_owned();
    builder = builder.on_page_load(move |_, payload| {
        let browser = load_app.state::<Browser>();
        {
            let mut inner = browser.lock();
            if let Some(tab) = inner.tabs.iter_mut().find(|t| t.id == id) {
                tab.url = payload.url().to_string();
                tab.loading = payload.event() == PageLoadEvent::Started;
            }
        }
        publish(&load_app, &load_window);
    });
    let title_app = app.clone();
    let title_window = window.to_owned();
    builder = builder.on_document_title_changed(move |_, title| {
        let browser = title_app.state::<Browser>();
        {
            let mut inner = browser.lock();
            if let Some(tab) = inner.tabs.iter_mut().find(|t| t.id == id) {
                tab.title = title
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(200)
                    .collect();
            }
        }
        publish(&title_app, &title_window);
    });
    let popup_app = app.clone();
    let popup_window = window.to_owned();
    builder = builder.on_new_window(move |url, _| {
        // Pop-ups werden zu Tabs im selben Fenster (nie ein fremdes Fenster), im Hintergrund
        // und begrenzt – eine Seite kann so weder den Fokus stehlen noch Tabs fluten.
        if navigable(&url) {
            let allowed = popup_allowed(&mut popup_app.state::<Browser>().lock(), &popup_window);
            let app = popup_app.clone();
            let window = popup_window.clone();
            std::thread::spawn(move || {
                if !allowed {
                    notice(&app, &window, "Pop-up blockiert (zu viele in kurzer Zeit).");
                } else if open_tab(&app, &window, url.as_str(), false).is_ok() {
                    notice(&app, &window, "Pop-up als Tab im Hintergrund geöffnet.");
                    publish(&app, &window);
                }
            });
        }
        NewWindowResponse::Deny
    });
    let download_app = app.clone();
    let download_window = window.to_owned();
    builder = builder.on_download(move |_, event| {
        if let tauri::webview::DownloadEvent::Finished { success, .. } = event {
            notice(
                &download_app,
                &download_window,
                if success {
                    "Download gespeichert (bleibt auch nach Ghost-Fenstern im Download-Ordner). Ist der AEGIS-Echtzeit-Wächter an, prüft er die Datei."
                } else {
                    "Download nicht abgeschlossen."
                },
            );
        }
        true
    });
    let win = app.get_window(window).ok_or("Fenster unbekannt.")?;
    win.add_child(
        builder,
        LogicalPosition::new(0.0, CHROME_HEIGHT),
        LogicalSize::new(1280.0, 700.0),
    )
    .map_err(|e| e.to_string())
}

/// Blocker und Prüfungen in WebView2 einhängen (nur Windows). Läuft vor der ersten Seite:
/// WebView-Aufrufe werden der Reihe nach im UI-Faden ausgeführt, `navigate` folgt danach.
fn prepare<R: Runtime>(app: &AppHandle<R>, webview: &Webview<R>, window: &str, id: u32) {
    #[cfg(windows)]
    {
        let app = app.clone();
        let window = window.to_owned();
        let _ = webview.with_webview(move |platform| {
            let browser = app.state::<Browser>();
            let blocker = Arc::clone(&browser.blocker);
            let blocking = Arc::clone(&browser.blocking);
            let frame_app = app.clone();
            let frame_window = window.clone();
            let done_app = app.clone();
            let done_window = window.clone();
            let ext_app = app.clone();
            let ext_window = window.clone();
            let hooks = aegis_winffi::webview::Hooks {
                block: Box::new(move |url, source, kind| {
                    blocking.load(Ordering::Relaxed)
                        && blocker.read().is_ok_and(|b| {
                            b.blocks(
                                url,
                                source,
                                aegis_browser_core::blocker::Kind::from_name(kind),
                            )
                        })
                }),
                frame_allowed: Box::new(move |url| frame_allowed(&frame_app, &frame_window, url)),
                completed: Box::new(move |url, ok| {
                    completed(&done_app, &done_window, id, url, ok);
                }),
                external_refused: Box::new(move |scheme| {
                    notice(
                        &ext_app,
                        &ext_window,
                        &format!(
                            "Die Seite wollte ein Programm über „{}:“ starten – abgebrochen.",
                            scheme.chars().take(32).collect::<String>()
                        ),
                    );
                }),
            };
            let installed = aegis_winffi::webview::install(&platform.controller(), hooks).is_ok();
            if let Some(tab) = browser.lock().tabs.iter_mut().find(|t| t.id == id) {
                tab.filtered = installed;
            }
            publish(&app, &window);
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (app, webview, window, id);
    }
}

/// Eingebettete Seiten: nur Web- und Inhalts-Adressen; `http` nur ohne HTTPS-only oder mit
/// Ausnahme des Nutzers.
#[cfg(windows)]
fn frame_allowed<R: Runtime>(app: &AppHandle<R>, window: &str, url: &str) -> bool {
    let Ok(url) = Url::parse(url) else {
        return false;
    };
    if !address::frame_navigable(&url) {
        return false;
    }
    if url.scheme() != "http" {
        return true;
    }
    let browser = app.state::<Browser>();
    let inner = browser.lock();
    !inner.settings.https_only || http_allowed(&inner, window, &url)
}

/// Hauptnavigation beendet: Erfolg über HTTPS → kein „HTTP erlauben“ mehr anbieten.
#[cfg(windows)]
fn completed<R: Runtime>(app: &AppHandle<R>, window: &str, id: u32, url: &str, ok: bool) {
    let browser = app.state::<Browser>();
    {
        let mut inner = browser.lock();
        if let Some(tab) = inner.tabs.iter_mut().find(|t| t.id == id)
            && ok
            && url.starts_with("https://")
        {
            tab.insecure = None;
        }
    }
    publish(app, window);
}

/// Regeln der Navigation (Links, Umleitungen, Eingaben): nur http/https; HTTPS-only hebt an –
/// leitet die Seite danach wieder auf dieselbe HTTP-Adresse um, bleibt es beim Angebot
/// „über HTTP öffnen“ (keine Endlosschleife).
fn allow_navigation<R: Runtime>(app: &AppHandle<R>, window: &str, id: u32, url: &Url) -> bool {
    if !navigable(url) {
        return false;
    }
    if url.scheme() != "http" {
        return true;
    }
    let browser = app.state::<Browser>();
    let mut inner = browser.lock();
    if !inner.settings.https_only || http_allowed(&inner, window, url) {
        return true;
    }
    let Some(tab) = inner.tabs.iter_mut().find(|t| t.id == id) else {
        return false;
    };
    tab.insecure = Some(url.to_string());
    let now = Instant::now();
    let again = tab.upgraded.as_ref().is_some_and(|(last, at)| {
        last == url.as_str() && now.saturating_duration_since(*at) < UPGRADE_LOOP
    });
    tab.upgraded = Some((url.to_string(), now));
    drop(inner);
    let app = app.clone();
    let window = window.to_owned();
    let target = upgrade(url.clone());
    std::thread::spawn(move || {
        if again {
            notice(
                &app,
                &window,
                "Die Seite leitet von HTTPS zurück auf HTTP. Unverschlüsselt öffnet der Browser sie nur nach deinem Klick.",
            );
            publish(&app, &window);
        } else if let Some(webview) = app.get_webview(&tab_label(id)) {
            let _ = webview.navigate(target);
        }
    });
    false
}

/* ------------------------------------------------------------------ Befehle */

fn window_of<R: Runtime>(webview: &Webview<R>) -> String {
    webview.window().label().to_owned()
}

fn tab_in<R: Runtime>(app: &AppHandle<R>, window: &str, id: u32) -> Result<Webview<R>, String> {
    let browser = app.state::<Browser>();
    let known = browser
        .lock()
        .tabs
        .iter()
        .any(|t| t.id == id && t.window == window);
    if !known {
        return Err("Tab unbekannt.".into());
    }
    app.get_webview(&tab_label(id))
        .ok_or_else(|| "Tab unbekannt.".to_owned())
}

/// Zustand des eigenen Fensters.
#[tauri::command]
pub fn browser_state<R: Runtime>(app: AppHandle<R>, webview: Webview<R>) -> View {
    let browser = app.state::<Browser>();
    let inner = browser.lock();
    view(&browser, &inner, &window_of(&webview))
}

/// Neuer Tab (leere Seite oder Startseite).
#[tauri::command]
pub async fn tab_open<R: Runtime>(app: AppHandle<R>, webview: Webview<R>) -> Result<View, String> {
    let window = window_of(&webview);
    let home = app.state::<Browser>().lock().settings.home.clone();
    open_tab(
        &app,
        &window,
        home.as_deref().unwrap_or("about:blank"),
        true,
    )?;
    publish(&app, &window);
    Ok(browser_state(app, webview))
}

/// Tab schließen (letzter Tab: leere Seite bleibt).
#[tauri::command]
pub async fn tab_close<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    id: u32,
) -> Result<View, String> {
    let window = window_of(&webview);
    let tab = tab_in(&app, &window, id)?;
    let _ = tab.close();
    let browser = app.state::<Browser>();
    let last = {
        let mut inner = browser.lock();
        inner.tabs.retain(|t| t.id != id);
        let remaining: Vec<u32> = inner
            .tabs
            .iter()
            .filter(|t| t.window == window)
            .map(|t| t.id)
            .collect();
        if let Some(info) = inner.windows.iter_mut().find(|w| w.label == window)
            && info.active == Some(id)
        {
            info.active = remaining.last().copied();
        }
        remaining.is_empty()
    };
    if last {
        open_tab(&app, &window, "about:blank", true)?;
    }
    layout(&app, &window);
    publish(&app, &window);
    Ok(browser_state(app, webview))
}

/// Tab nach vorn holen.
#[tauri::command]
pub fn tab_select<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    id: u32,
) -> Result<View, String> {
    let window = window_of(&webview);
    tab_in(&app, &window, id)?;
    {
        let browser = app.state::<Browser>();
        let mut inner = browser.lock();
        if let Some(info) = inner.windows.iter_mut().find(|w| w.label == window) {
            info.active = Some(id);
        }
    }
    layout(&app, &window);
    Ok(browser_state(app, webview))
}

/// Eingabe der Adresszeile öffnen (Adresse oder Suche).
#[tauri::command]
pub fn tab_go<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    id: u32,
    input: String,
) -> Result<View, String> {
    let window = window_of(&webview);
    let tab = tab_in(&app, &window, id)?;
    let settings = app.state::<Browser>().lock().settings.clone();
    let url =
        address::resolve(&input, settings.search, settings.https_only).map_err(|e| match e {
            address::Refused::Scheme(s) => format!("„{s}:“-Adressen öffnet der Browser nicht."),
            address::Refused::TooLong => "Eingabe zu lang.".to_owned(),
            address::Refused::Empty | address::Refused::Invalid => "Keine Adresse.".to_owned(),
        })?;
    tab.navigate(url).map_err(|e| e.to_string())?;
    Ok(browser_state(app, webview))
}

/// Zurück/Vor über WebView2 selbst – nicht über `history` im Skript der Seite (die Seite
/// könnte es überschreiben und den Zurück-Knopf festhalten).
fn history<R: Runtime>(
    app: &AppHandle<R>,
    webview: &Webview<R>,
    id: u32,
    back: bool,
) -> Result<(), String> {
    let tab = tab_in(app, &window_of(webview), id)?;
    #[cfg(windows)]
    {
        tab.with_webview(move |platform| {
            let _ = aegis_winffi::webview::go(&platform.controller(), back);
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        // Entwicklung unter Linux (WebKitGTK): über die Seite.
        tab.eval(if back {
            "history.back()"
        } else {
            "history.forward()"
        })
        .map_err(|e| e.to_string())
    }
}

/// Zurück.
#[tauri::command]
pub fn tab_back<R: Runtime>(app: AppHandle<R>, webview: Webview<R>, id: u32) -> Result<(), String> {
    history(&app, &webview, id, true)
}

/// Vor.
#[tauri::command]
pub fn tab_forward<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    id: u32,
) -> Result<(), String> {
    history(&app, &webview, id, false)
}

/// Neu laden (gleiche Adresse, wieder mit allen Regeln).
#[tauri::command]
pub fn tab_reload<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    id: u32,
) -> Result<(), String> {
    let tab = tab_in(&app, &window_of(&webview), id)?;
    let url = tab.url().map_err(|e| e.to_string())?;
    tab.navigate(url).map_err(|e| e.to_string())
}

/// HTTP für den Host der angehobenen Adresse in dieser Sitzung erlauben (Nutzer hat
/// ausdrücklich „trotzdem über HTTP öffnen“ gewählt) und die HTTP-Fassung laden.
#[tauri::command]
pub fn tab_allow_http<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    id: u32,
) -> Result<View, String> {
    let window = window_of(&webview);
    let tab = tab_in(&app, &window, id)?;
    let insecure = {
        let browser = app.state::<Browser>();
        let mut inner = browser.lock();
        let insecure = inner
            .tabs
            .iter_mut()
            .find(|t| t.id == id)
            .and_then(|t| t.insecure.take())
            .ok_or("Nichts zu erlauben.")?;
        let url = Url::parse(&insecure).map_err(|e| e.to_string())?;
        if url.scheme() != "http" {
            return Err("Nichts zu erlauben.".into());
        }
        let key = format!(
            "{}|{}",
            http_scope(&inner, &window),
            url.host_str().unwrap_or_default().to_ascii_lowercase()
        );
        inner.http_ok.insert(key);
        url
    };
    tab.navigate(insecure).map_err(|e| e.to_string())?;
    publish(&app, &window);
    Ok(browser_state(app, webview))
}

/// Inhalt zeigen/verdecken (die Leiste öffnet ein Menü über die ganze Fläche).
#[tauri::command]
pub fn content_visible<R: Runtime>(app: AppHandle<R>, webview: Webview<R>, visible: bool) {
    let window = window_of(&webview);
    {
        let browser = app.state::<Browser>();
        let mut inner = browser.lock();
        if let Some(info) = inner.windows.iter_mut().find(|w| w.label == window) {
            info.content_hidden = !visible;
        }
    }
    if let Some(win) = app.get_window(&window) {
        let height = if visible {
            CHROME_HEIGHT
        } else {
            win.inner_size()
                .ok()
                .zip(win.scale_factor().ok())
                .map_or(CHROME_HEIGHT, |(s, f)| s.to_logical::<f64>(f).height)
        };
        if let (Some(chrome), Ok(size)) =
            (app.get_webview(&chrome_label(&window)), win.inner_size())
        {
            let width = win
                .scale_factor()
                .map_or(1280.0, |f| size.to_logical::<f64>(f).width);
            let _ = chrome.set_size(LogicalSize::new(width, height));
        }
    }
    layout(&app, &window);
}

/// Einstellungen speichern (Blocker und HTTPS-only sofort, JavaScript für neue Tabs).
#[tauri::command]
pub fn settings_save<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    settings: Settings,
) -> Result<View, String> {
    let browser = app.state::<Browser>();
    let settings = settings.cleaned();
    browser.store.write_json("settings.json", &settings)?;
    browser
        .blocking
        .store(settings.block_trackers, Ordering::Relaxed);
    browser.lock().settings = settings;
    Ok(browser_state(app.clone(), webview))
}

/// Filterlisten (EasyList, EasyPrivacy) per HTTPS laden – nur auf Wunsch des Nutzers.
#[tauri::command]
pub async fn lists_update<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
) -> Result<View, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || download_lists(&handle))
        .await
        .map_err(|e| e.to_string())??;
    Ok(browser_state(app, webview))
}

fn download_lists<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let browser = app.state::<Browser>();
        for list in List::ALL {
            let response =
                aegis_winffi::http::https_get(list.host(), list.path(), &[], MAX_LIST, 30_000)
                    .map_err(|e| format!("{}: {e}", list.file_name()))?;
            let text = String::from_utf8(response.body)
                .map_err(|_| format!("{}: kein Text", list.file_name()))?;
            if response.status != 200 || !aegis_browser_core::blocker::plausible_list(&text) {
                return Err(format!("{}: keine gültige Filterliste", list.file_name()));
            }
            browser.store.write(list.file_name(), text.as_bytes())?;
        }
        let blocker = load_blocker(&browser.store);
        if let Ok(mut slot) = browser.blocker.write() {
            *slot = blocker;
        }
        let updated = now();
        browser.store.write_json(
            "lists.json",
            &ListsMeta {
                updated: Some(updated),
            },
        )?;
        browser.lock().lists_updated = Some(updated);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Filterlisten laden gibt es nur unter Windows.".into())
    }
}

/// Lesezeichen hinzufügen.
#[tauri::command]
pub fn bookmark_add<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    title: String,
    url: String,
) -> Result<View, String> {
    let browser = app.state::<Browser>();
    let bookmark = Bookmark::new(&title, &url)?;
    let list = {
        let mut inner = browser.lock();
        bookmarks::add(&mut inner.bookmarks, bookmark)?;
        inner.bookmarks.clone()
    };
    browser.store.write_json("bookmarks.json", &list)?;
    Ok(browser_state(app.clone(), webview))
}

/// Lesezeichen entfernen.
#[tauri::command]
pub fn bookmark_remove<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    url: String,
) -> Result<View, String> {
    let browser = app.state::<Browser>();
    let list = {
        let mut inner = browser.lock();
        inner.bookmarks.retain(|b| b.url != url);
        inner.bookmarks.clone()
    };
    browser.store.write_json("bookmarks.json", &list)?;
    Ok(browser_state(app.clone(), webview))
}

/// Ghost-Fenster öffnen (InPrivate; mit `tor` nur, wenn auf 9150/9050 ein SOCKS5-Proxy
/// antwortet – ob das wirklich Tor ist, kann AEGIS nicht prüfen).
#[tauri::command]
pub async fn ghost_open<R: Runtime>(app: AppHandle<R>, tor: bool) -> Result<(), String> {
    let kind = if tor {
        let port = TOR_PORTS
            .into_iter()
            .find(|p| socks5_ready(*p))
            .ok_or("Kein Tor-Proxy gefunden. Starte den Tor Browser oder einen Tor-/Arti-Dienst (SOCKS5 auf Port 9150 oder 9050) und versuche es erneut.")?;
        WindowKind::Ghost { tor: Some(port) }
    } else {
        WindowKind::Ghost { tor: None }
    };
    open_window(&app, kind).map(|_| ())
}
