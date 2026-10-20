//! Fenster, Tabs und Regeln der Navigation. Jedes Browser-Fenster hat eine Leiste (WebView
//! `chrome-<fenster>`, lokale App-Seite) und je Tab ein WebView `tab-<n>` darunter. Nur die
//! Leiste darf Befehle aufrufen (Capability); Webseiten bekommen keine Rechte.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};

use aegis_browser_core::address::{self, display_host, navigable, upgrade};
use aegis_browser_core::blocker::{Blocker, List, MAX_LIST};
use aegis_browser_core::bookmarks::{self, Bookmark};
use aegis_browser_core::settings::{self, Settings, USER_AGENT};
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

/// Art eines Fensters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowKind {
    /// Normales Fenster (eigenes Profil im Datenordner).
    Normal,
    /// Ghost: InPrivate (nichts bleibt), optional über Tor.
    Ghost {
        /// SOCKS-Port eines laufenden Tor/Arti (`None`: ohne Tor).
        tor: Option<u16>,
    },
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
}

#[derive(Debug, Clone)]
struct WindowInfo {
    label: String,
    kind: WindowKind,
    active: Option<u32>,
    /// Inhalt verdeckt (Leiste zeigt ein Menü über die ganze Fläche).
    content_hidden: bool,
}

#[derive(Debug, Default)]
struct Inner {
    windows: Vec<WindowInfo>,
    tabs: Vec<Tab>,
    next_tab: u32,
    next_window: u32,
    settings: Settings,
    bookmarks: Vec<Bookmark>,
    /// Hosts, für die der Nutzer in dieser Sitzung HTTP erlaubt hat.
    http_ok: HashSet<String>,
    /// Zeitpunkt der geladenen Listen (Unix-Sekunden).
    lists_updated: Option<i64>,
}

/// Zustand des Browsers.
pub struct Browser {
    inner: Mutex<Inner>,
    blocker: Arc<RwLock<Blocker>>,
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
    tabs: Vec<TabView>,
    active: Option<u32>,
    settings: Settings,
    bookmarks: Vec<Bookmark>,
    rules: usize,
    lists_updated: Option<i64>,
    /// Blocker wirkt (nur Windows/WebView2).
    filtering: bool,
}

fn view(browser: &Browser, inner: &Inner, window: &str) -> View {
    let info = inner.windows.iter().find(|w| w.label == window);
    let kind = info.map_or(WindowKind::Normal, |w| w.kind);
    View {
        window: window.to_owned(),
        ghost: matches!(kind, WindowKind::Ghost { .. }),
        tor: matches!(kind, WindowKind::Ghost { tor: Some(_) }),
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
        active: info.and_then(|w| w.active),
        settings: inner.settings.clone(),
        bookmarks: inner.bookmarks.clone(),
        rules: browser.rules(),
        lists_updated: inner.lists_updated,
        filtering: cfg!(windows) && inner.settings.block_trackers && browser.rules() > 0,
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
        inner.next_window += 1;
        let label = match kind {
            WindowKind::Normal => format!("win-{}", inner.next_window),
            WindowKind::Ghost { .. } => format!("ghost-{}", inner.next_window),
        };
        inner.windows.push(WindowInfo {
            label: label.clone(),
            kind,
            active: None,
            content_hidden: false,
        });
        label
    };
    let title = match kind {
        WindowKind::Normal => "AEGIS Browser",
        WindowKind::Ghost { tor: None } => "AEGIS Browser – Ghost",
        WindowKind::Ghost { tor: Some(_) } => "AEGIS Browser – Ghost über Tor",
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
        }
        _ => {}
    });
    let home = browser.lock().settings.home.clone();
    open_tab(app, &label, home.as_deref().unwrap_or("about:blank"))?;
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

fn tor_reachable(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_millis(400),
    )
    .is_ok()
}

/// Öffnet einen Tab im Fenster `window` mit der Adresse `target` (bereits geprüft).
fn open_tab<R: Runtime>(app: &AppHandle<R>, window: &str, target: &str) -> Result<u32, String> {
    let url = Url::parse(target).map_err(|e| e.to_string())?;
    if !navigable(&url) {
        return Err("Diese Adresse öffnet der Browser nicht.".into());
    }
    let browser = app.state::<Browser>();
    let (id, settings, kind) = {
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
        inner.next_tab += 1;
        let id = inner.next_tab;
        inner.tabs.push(Tab {
            id,
            window: window.to_owned(),
            url: url.to_string(),
            title: String::new(),
            loading: true,
            insecure: None,
        });
        (id, inner.settings.clone(), kind)
    };
    let label = tab_label(id);
    let data = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .user_agent(USER_AGENT)
        .additional_browser_args(&settings::browser_args(&settings));
    builder = match kind {
        WindowKind::Normal => builder.data_directory(data.join("profile")),
        WindowKind::Ghost { tor: None } => {
            builder.data_directory(data.join("profile")).incognito(true)
        }
        // Tor braucht eine eigene Umgebung (Proxy gilt für den ganzen Engine-Prozess).
        WindowKind::Ghost { tor: Some(port) } => builder
            .data_directory(data.join("ghost-tor"))
            .incognito(true)
            .proxy_url(settings::tor_proxy(port)?),
    };
    if !settings.javascript {
        builder = builder.disable_javascript();
    }
    let nav_app = app.clone();
    let nav_label = label.clone();
    builder = builder.on_navigation(move |url| allow_navigation(&nav_app, &nav_label, id, url));
    let load_app = app.clone();
    let load_window = window.to_owned();
    builder = builder.on_page_load(move |webview, payload| {
        let browser = load_app.state::<Browser>();
        {
            let mut inner = browser.lock();
            if let Some(tab) = inner.tabs.iter_mut().find(|t| t.id == id) {
                tab.url = payload.url().to_string();
                tab.loading = payload.event() == PageLoadEvent::Started;
                if payload.url().scheme() == "https"
                    && tab
                        .insecure
                        .as_deref()
                        .and_then(|i| Url::parse(i).ok())
                        .is_some_and(|i| i.host_str() != payload.url().host_str())
                {
                    tab.insecure = None;
                }
            }
        }
        let _ = webview;
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
        // Pop-ups werden zu Tabs im selben Fenster (nie ein fremdes Fenster).
        if navigable(&url) {
            let app = popup_app.clone();
            let window = popup_window.clone();
            std::thread::spawn(move || {
                if open_tab(&app, &window, url.as_str()).is_ok() {
                    layout(&app, &window);
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
                    "Download gespeichert. Ist der AEGIS-Echtzeit-Wächter an, prüft er die Datei."
                } else {
                    "Download nicht abgeschlossen."
                },
            );
        }
        true
    });
    let win = app.get_window(window).ok_or("Fenster unbekannt.")?;
    let webview = win
        .add_child(
            builder,
            LogicalPosition::new(0.0, CHROME_HEIGHT),
            LogicalSize::new(1280.0, 700.0),
        )
        .map_err(|e| e.to_string())?;
    install_filter(&browser, &webview);
    {
        let mut inner = browser.lock();
        if let Some(info) = inner.windows.iter_mut().find(|w| w.label == window) {
            info.active = Some(id);
        }
    }
    layout(app, window);
    Ok(id)
}

/// Werbe-/Tracker-Blocker in WebView2 einhängen (nur Windows).
fn install_filter<R: Runtime>(browser: &Browser, webview: &Webview<R>) {
    #[cfg(windows)]
    {
        let blocker = Arc::clone(&browser.blocker);
        let enabled = browser.lock().settings.block_trackers;
        if enabled {
            let _ = webview.with_webview(move |platform| {
                let check = move |url: &str, source: &str, kind: &str| {
                    blocker.read().is_ok_and(|b| {
                        b.blocks(
                            url,
                            source,
                            aegis_browser_core::blocker::Kind::from_name(kind),
                        )
                    })
                };
                let _ =
                    aegis_winffi::webview::block_requests(&platform.controller(), Box::new(check));
            });
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (browser, webview);
    }
}

/// Regeln der Navigation (Links, Umleitungen, Eingaben): nur http/https; HTTPS-only hebt an.
fn allow_navigation<R: Runtime>(app: &AppHandle<R>, label: &str, id: u32, url: &Url) -> bool {
    if !navigable(url) {
        return false;
    }
    if url.scheme() != "http" {
        return true;
    }
    let browser = app.state::<Browser>();
    let mut inner = browser.lock();
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if !inner.settings.https_only || inner.http_ok.contains(&host) {
        return true;
    }
    if let Some(tab) = inner.tabs.iter_mut().find(|t| t.id == id) {
        tab.insecure = Some(url.to_string());
    }
    drop(inner);
    let target = upgrade(url.clone());
    let app = app.clone();
    let label = label.to_owned();
    std::thread::spawn(move || {
        if let Some(webview) = app.get_webview(&label) {
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
    open_tab(&app, &window, home.as_deref().unwrap_or("about:blank"))?;
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
        open_tab(&app, &window, "about:blank")?;
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

fn history<R: Runtime>(
    app: &AppHandle<R>,
    webview: &Webview<R>,
    id: u32,
    js: &str,
) -> Result<(), String> {
    let tab = tab_in(app, &window_of(webview), id)?;
    tab.eval(js).map_err(|e| e.to_string())
}

/// Zurück.
#[tauri::command]
pub fn tab_back<R: Runtime>(app: AppHandle<R>, webview: Webview<R>, id: u32) -> Result<(), String> {
    history(&app, &webview, id, "history.back()")
}

/// Vor.
#[tauri::command]
pub fn tab_forward<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    id: u32,
) -> Result<(), String> {
    history(&app, &webview, id, "history.forward()")
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
        inner
            .http_ok
            .insert(url.host_str().unwrap_or_default().to_ascii_lowercase());
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

/// Einstellungen speichern (DoH und JavaScript gelten für neue Tabs bzw. nach Neustart).
#[tauri::command]
pub fn settings_save<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    settings: Settings,
) -> Result<View, String> {
    let browser = app.state::<Browser>();
    let settings = settings.cleaned();
    browser.store.write_json("settings.json", &settings)?;
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

/// Ghost-Fenster öffnen (InPrivate; mit `tor` nur, wenn ein Tor-/Arti-Proxy läuft).
#[tauri::command]
pub async fn ghost_open<R: Runtime>(app: AppHandle<R>, tor: bool) -> Result<(), String> {
    let kind = if tor {
        let port = TOR_PORTS
            .into_iter()
            .find(|p| tor_reachable(*p))
            .ok_or("Tor läuft nicht. Starte den Tor Browser oder einen Tor-/Arti-Dienst (SOCKS auf Port 9150 oder 9050) und versuche es erneut.")?;
        WindowKind::Ghost { tor: Some(port) }
    } else {
        WindowKind::Ghost { tor: None }
    };
    open_window(&app, kind).map(|_| ())
}
