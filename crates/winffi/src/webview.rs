//! WebView2-Anbindung des Privacy-Browsers (P12): Netzanfragen der Webseiten vor dem Laden
//! prüfen und – wenn der Blocker es sagt – mit einer leeren 403-Antwort beantworten;
//! Navigationen eingebetteter Seiten prüfen, Starts externer Programme über Adressen
//! (`ms-msdt:`, `search-ms:` …) immer abbrechen, Erfolg der Hauptnavigation melden und
//! Zurück/Vor über WebView2 selbst (nicht über Skripte der Seite). Ändert nichts am System;
//! wirkt nur im eigenen Browser.

use std::io;
use std::sync::{Arc, Mutex, PoisonError};

use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST,
    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL, ICoreWebView2, ICoreWebView2_2,
    ICoreWebView2_18, ICoreWebView2_22, ICoreWebView2Controller,
};
use webview2_com::{
    LaunchingExternalUriSchemeEventHandler, NavigationCompletedEventHandler,
    NavigationStartingEventHandler, WebResourceRequestedEventHandler, take_pwstr,
};
use windows::core::{BOOL, Interface, PWSTR, w};

/// Prüffunktion: (Adresse der Anfrage, Adresse der Seite, Art) → blockieren?
pub type RequestCheck = Box<dyn Fn(&str, &str, &str) -> bool + Send + Sync>;
/// Rückmeldung „Hauptnavigation beendet“: (Adresse, erfolgreich?).
pub type Completed = Box<dyn Fn(&str, bool) + Send + Sync>;

/// Rückmeldungen des Browsers an WebView2.
pub struct Hooks {
    /// Anfrage blockieren? (siehe [`RequestCheck`]).
    pub block: RequestCheck,
    /// Darf eine eingebettete Seite (iframe) diese Adresse laden?
    pub frame_allowed: Box<dyn Fn(&str) -> bool + Send + Sync>,
    /// Hauptnavigation beendet: (Adresse, erfolgreich?).
    pub completed: Completed,
    /// Eine Seite wollte ein externes Programm starten (abgebrochen); Argument: Schema.
    pub external_refused: Box<dyn Fn(&str) + Send + Sync>,
}

impl std::fmt::Debug for Hooks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hooks").finish_non_exhaustive()
    }
}

/// Was die Hooks eingerichtet haben.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Installed {
    /// Anfragen von Service-/Shared-Workern werden mitgeprüft (WebView2 ab ICoreWebView2_22).
    pub workers: bool,
    /// Starts externer Programme werden abgebrochen (ab ICoreWebView2_18).
    pub external: bool,
}

fn context_name(context: COREWEBVIEW2_WEB_RESOURCE_CONTEXT) -> &'static str {
    match context {
        c if c == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => "document",
        c if c == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
        c if c == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
        c if c == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
        c if c == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
        c if c == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => "media",
        c if c == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST
            || c == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH =>
        {
            "xhr"
        }
        c if c == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
        _ => "other",
    }
}

/// Adresse ohne Fragment (`#…`) – so vergleicht WebView2 Anfrage und Navigation.
fn without_fragment(uri: &str) -> &str {
    uri.split_once('#').map_or(uri, |(base, _)| base)
}

/// Art einer Dokument-Anfrage: die laufende Hauptnavigation ist `document`, alles andere
/// (iframes) `subdocument` – WebView2 meldet beides als DOCUMENT.
#[must_use]
pub fn document_kind(uri: &str, top_level: &str) -> &'static str {
    if !top_level.is_empty() && without_fragment(uri) == without_fragment(top_level) {
        "document"
    } else {
        "subdocument"
    }
}

fn err(e: &windows::core::Error) -> io::Error {
    io::Error::other(format!("WebView2: {e}"))
}

fn core_of(controller: &ICoreWebView2Controller) -> io::Result<ICoreWebView2> {
    // SAFETY: dokumentierte Methode des Controllers; Rückgabe ist eine gezählte Schnittstelle.
    // aegis-unsafe: winffi-webview-core
    #[allow(unsafe_code)]
    unsafe {
        controller.CoreWebView2().map_err(|e| err(&e))
    }
}

/// Hängt Blocker und Navigationsprüfungen an ein WebView2 (im UI-Faden des WebViews
/// aufrufen, bevor die erste Seite geladen wird).
///
/// # Errors
/// WebView2 nicht bereit oder Grundschnittstellen fehlen.
pub fn install(controller: &ICoreWebView2Controller, hooks: Hooks) -> io::Result<Installed> {
    let core = core_of(controller)?;
    let hooks = Arc::new(hooks);
    // Adresse der laufenden Hauptnavigation (für document/subdocument).
    let top_level = Arc::new(Mutex::new(String::new()));
    let mut installed = Installed {
        workers: false,
        external: false,
    };
    // SAFETY: Alle Aufrufe sind dokumentierte WebView2-Schnittstellen im UI-Faden des WebViews.
    // Rückgaben sind gezählte Schnittstellen (windows-Crate), Zeichenketten werden über
    // `take_pwstr` übernommen und freigegeben. Die Rückruf-Closures laufen später ebenfalls im
    // UI-Faden; sie rufen nur Methoden der übergebenen, von WebView2 gehaltenen
    // Ereignis-Argumente auf und lesen/schreiben Rust-Daten über `Arc`/`Mutex`. Die Ereignisse
    // leben so lange wie das WebView (Kennungen werden nicht gebraucht).
    // aegis-unsafe: winffi-webview-filter
    #[allow(unsafe_code)]
    unsafe {
        let environment = core
            .cast::<ICoreWebView2_2>()
            .and_then(|c| c.Environment())
            .map_err(|e| err(&e))?;
        // Auch Anfragen von Service-/Shared-Workern prüfen, wenn WebView2 das kann.
        if let Ok(core22) = core.cast::<ICoreWebView2_22>() {
            installed.workers = core22
                .AddWebResourceRequestedFilterWithRequestSourceKinds(
                    w!("*"),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                )
                .is_ok();
        }
        if !installed.workers {
            core.AddWebResourceRequestedFilter(w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
                .map_err(|e| err(&e))?;
        }

        // Hauptnavigation merken (läuft vor der Dokument-Anfrage, auch bei Umleitungen).
        let top = Arc::clone(&top_level);
        let starting = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                *top.lock().unwrap_or_else(PoisonError::into_inner) = take_pwstr(uri);
            }
            Ok(())
        }));
        let mut token = 0i64;
        core.add_NavigationStarting(&starting, &mut token)
            .map_err(|e| err(&e))?;

        let top = Arc::clone(&top_level);
        let h = Arc::clone(&hooks);
        let requested = WebResourceRequestedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let request = args.Request()?;
            let mut uri = PWSTR::null();
            request.Uri(&mut uri)?;
            let uri = take_pwstr(uri);
            let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default();
            args.ResourceContext(&mut context)?;
            let mut kind = context_name(context);
            if kind == "document" {
                kind = document_kind(&uri, &top.lock().unwrap_or_else(PoisonError::into_inner));
            }
            let source = sender
                .and_then(|s: ICoreWebView2| {
                    let mut page = PWSTR::null();
                    s.Source(&mut page).ok()?;
                    Some(take_pwstr(page))
                })
                .unwrap_or_default();
            if (h.block)(&uri, &source, kind) {
                // Leere Begründung: keine Kennung, die Seiten auslesen könnten.
                let response = environment.CreateWebResourceResponse(None, 403, w!(""), w!(""))?;
                args.SetResponse(&response)?;
            }
            Ok(())
        }));
        core.add_WebResourceRequested(&requested, &mut token)
            .map_err(|e| err(&e))?;

        let h = Arc::clone(&hooks);
        let frames = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                if !(h.frame_allowed)(&take_pwstr(uri)) {
                    args.SetCancel(true)?;
                }
            }
            Ok(())
        }));
        core.add_FrameNavigationStarting(&frames, &mut token)
            .map_err(|e| err(&e))?;

        let h = Arc::clone(&hooks);
        let completed = NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else {
                return Ok(());
            };
            let mut ok = BOOL(0);
            args.IsSuccess(&mut ok)?;
            let mut page = PWSTR::null();
            sender.Source(&mut page)?;
            (h.completed)(&take_pwstr(page), ok.as_bool());
            Ok(())
        }));
        core.add_NavigationCompleted(&completed, &mut token)
            .map_err(|e| err(&e))?;

        if let Ok(core18) = core.cast::<ICoreWebView2_18>() {
            let h = Arc::clone(&hooks);
            let external =
                LaunchingExternalUriSchemeEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        // Immer abbrechen: Der Browser startet keine Programme für Seiten.
                        args.SetCancel(true)?;
                        let mut uri = PWSTR::null();
                        args.Uri(&mut uri)?;
                        let uri = take_pwstr(uri);
                        let scheme = uri.split_once(':').map_or("", |(s, _)| s);
                        (h.external_refused)(scheme);
                    }
                    Ok(())
                }));
            installed.external = core18
                .add_LaunchingExternalUriScheme(&external, &mut token)
                .is_ok();
        }
    }
    Ok(installed)
}

/// Zurück (`back = true`) bzw. Vor in der Verlaufsliste des WebViews.
///
/// # Errors
/// WebView2 nicht bereit.
pub fn go(controller: &ICoreWebView2Controller, back: bool) -> io::Result<()> {
    let core = core_of(controller)?;
    // SAFETY: dokumentierte Methoden im UI-Faden; ohne Verlauf sind sie wirkungslos.
    // aegis-unsafe: winffi-webview-history
    #[allow(unsafe_code)]
    unsafe {
        if back {
            core.GoBack()
        } else {
            core.GoForward()
        }
        .map_err(|e| err(&e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hauptseite_und_eingebettete_seiten() {
        assert_eq!(
            document_kind("https://a.example/x", "https://a.example/x#top"),
            "document"
        );
        assert_eq!(
            document_kind("https://ads.example/frame", "https://a.example/x"),
            "subdocument"
        );
        assert_eq!(document_kind("https://a.example/", ""), "subdocument");
    }
}
