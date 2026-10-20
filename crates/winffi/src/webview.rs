//! WebView2-Anbindung des Privacy-Browsers (P12): Netzanfragen der Webseiten vor dem Laden
//! prüfen und – wenn der Blocker es sagt – mit einer leeren 403-Antwort beantworten. Ändert
//! nichts am System; blockiert nur Inhalte im eigenen Browser.

use std::io;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST, ICoreWebView2, ICoreWebView2_2,
    ICoreWebView2Controller,
};
use webview2_com::{WebResourceRequestedEventHandler, take_pwstr};
use windows::core::{Interface, PWSTR, w};

/// Prüffunktion: (Adresse der Anfrage, Adresse der Seite, Art) → blockieren?
pub type RequestCheck = Box<dyn Fn(&str, &str, &str) -> bool + Send + Sync>;

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

fn err(e: &windows::core::Error) -> io::Error {
    io::Error::other(format!("WebView2: {e}"))
}

/// Hängt die Prüfung an alle Netzanfragen eines WebView2 (im UI-Faden des WebViews aufrufen).
///
/// # Errors
/// WebView2 nicht bereit oder Schnittstelle fehlt.
pub fn block_requests(controller: &ICoreWebView2Controller, check: RequestCheck) -> io::Result<()> {
    // SAFETY: Dokumentierte WebView2-Schnittstellen im UI-Faden des WebViews; alle Rückgaben
    // sind gezählte Schnittstellen (windows-Crate), Zeichenketten werden über `take_pwstr`
    // übernommen und freigegeben; das Ereignis lebt so lange wie das WebView.
    // aegis-unsafe: winffi-webview-filter
    #[allow(unsafe_code)]
    unsafe {
        let core: ICoreWebView2 = controller.CoreWebView2().map_err(|e| err(&e))?;
        let environment = core
            .cast::<ICoreWebView2_2>()
            .and_then(|c| c.Environment())
            .map_err(|e| err(&e))?;
        core.AddWebResourceRequestedFilter(w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
            .map_err(|e| err(&e))?;
        let handler = WebResourceRequestedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let request = args.Request()?;
            let mut uri = PWSTR::null();
            request.Uri(&mut uri)?;
            let uri = take_pwstr(uri);
            let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default();
            args.ResourceContext(&mut context)?;
            let source = sender
                .and_then(|s: ICoreWebView2| {
                    let mut page = PWSTR::null();
                    s.Source(&mut page).ok()?;
                    Some(take_pwstr(page))
                })
                .unwrap_or_default();
            if check(&uri, &source, context_name(context)) {
                let response = environment.CreateWebResourceResponse(
                    None,
                    403,
                    w!("Blocked by AEGIS"),
                    w!(""),
                )?;
                args.SetResponse(&response)?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        core.add_WebResourceRequested(&handler, &mut token)
            .map_err(|e| err(&e))?;
    }
    Ok(())
}
