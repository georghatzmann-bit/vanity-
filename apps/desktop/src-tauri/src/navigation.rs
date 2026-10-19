//! Navigations-Wächter: Im App-Fenster läuft nur die eigene Oberfläche.
//!
//! Die CSP regelt keine Navigation des ganzen Fensters. Ohne diesen Wächter könnte ein Link
//! (`<a href="https://…">`) oder `location.href = …` eine fremde Seite *im* AEGIS-Fenster
//! laden – mit Titel „AEGIS“, ohne Adressleiste. Eine solche Seite könnte die
//! Bestätigungs-Oberfläche der Goldenen Regel nachahmen. Darum lässt der Wächter nur
//! Navigationen zum Ursprung der gebündelten Oberfläche zu (im Entwicklungs-Build zusätzlich
//! zum Vite-Server aus `build.devUrl`) und bricht alle anderen ab – fail-closed.
//!
//! Neue Fenster (`target="_blank"`, `window.open`) lehnt wry ohnehin ab. Externe Links
//! dürfen später nur über einen eigenen, vom Nutzer bestätigten Öffner laufen, nie über das
//! App-Fenster.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, Url};

/// Name des Plugins (nur intern; es stellt keine IPC-Befehle bereit).
const PLUGIN_NAME: &str = "aegis-navigation-guard";

/// Schema, Host und Port – das, was zwei URLs zum selben Ursprung macht.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Origin {
    scheme: String,
    host: String,
    port: Option<u16>,
}

impl Origin {
    /// `None` für URLs ohne Host (`about:`, `data:`, `javascript:` …) – die sind nie erlaubt.
    fn of(url: &Url) -> Option<Self> {
        let host = url.host_str()?;
        if host.is_empty() {
            return None;
        }
        Some(Self {
            scheme: url.scheme().to_ascii_lowercase(),
            host: host.to_ascii_lowercase(),
            port: url.port_or_known_default(),
        })
    }

    /// Ursprung der gebündelten Oberfläche, wie Tauri ihn ausliefert: unter Windows
    /// (WebView2) `http://tauri.localhost` bzw. `https://…` bei `useHttpsScheme`, sonst das
    /// eigene Protokoll `tauri://localhost`.
    fn bundled(use_https_scheme: bool) -> Self {
        if cfg!(windows) {
            let (scheme, port) = if use_https_scheme {
                ("https", 443)
            } else {
                ("http", 80)
            };
            Self {
                scheme: scheme.to_owned(),
                host: "tauri.localhost".to_owned(),
                port: Some(port),
            }
        } else {
            Self {
                scheme: "tauri".to_owned(),
                host: "localhost".to_owned(),
                port: None,
            }
        }
    }
}

/// Welche Ziele das App-Fenster laden darf.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NavigationPolicy {
    allowed: Vec<Origin>,
}

impl NavigationPolicy {
    /// Erlaubt die gebündelte Oberfläche und – nur wenn `dev_url` gesetzt ist – den
    /// Ursprung des Entwicklungs-Servers. Im ausgelieferten Build (`tauri build`, ohne
    /// `cfg(dev)`) übergibt `main` nie eine `dev_url`.
    pub fn new(use_https_scheme: bool, dev_url: Option<&Url>) -> Self {
        let mut allowed = vec![Origin::bundled(use_https_scheme)];
        allowed.extend(dev_url.and_then(Origin::of));
        Self { allowed }
    }

    /// Darf das Fenster zu `url` navigieren? Nur bei exakt gleichem Ursprung.
    pub fn allows(&self, url: &Url) -> bool {
        Origin::of(url).is_some_and(|origin| self.allowed.contains(&origin))
    }
}

/// Plugin, das jede Navigation jedes Webviews gegen `policy` prüft und sonst abbricht.
pub fn guard<R: Runtime>(policy: NavigationPolicy) -> TauriPlugin<R> {
    Builder::new(PLUGIN_NAME)
        .on_navigation(move |_webview, url| policy.allows(url))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    /// Ursprung der gebündelten Oberfläche auf der laufenden Plattform.
    fn bundled_url(path: &str) -> Url {
        if cfg!(windows) {
            url(&format!("http://tauri.localhost{path}"))
        } else {
            url(&format!("tauri://localhost{path}"))
        }
    }

    #[test]
    fn erlaubt_die_gebuendelte_oberflaeche() {
        let policy = NavigationPolicy::new(false, None);
        assert!(policy.allows(&bundled_url("/")));
        assert!(policy.allows(&bundled_url("/index.html?x=1#start")));
    }

    #[test]
    fn verweigert_fremde_seiten_im_app_fenster() {
        let policy = NavigationPolicy::new(false, None);
        for target in [
            "https://example.com/",
            "http://example.com/",
            "https://tauri.localhost.example.com/",
            "https://example.com/?u=tauri.localhost",
            "http://127.0.0.1:5173/",
            "http://localhost/",
            "file:///C:/Windows/System32/",
            "data:text/html,<h1>AEGIS</h1>",
            "about:blank",
            "javascript:alert(1)",
            "blob:https://example.com/abc",
            "ftp://tauri.localhost/",
            "ws://tauri.localhost/",
        ] {
            assert!(
                !policy.allows(&url(target)),
                "{target} muss abgelehnt werden"
            );
        }
    }

    #[test]
    fn verweigert_den_ursprung_der_jeweils_anderen_plattform() {
        let policy = NavigationPolicy::new(false, None);
        if cfg!(windows) {
            assert!(!policy.allows(&url("tauri://localhost/")));
            // Ohne useHttpsScheme liefert Tauri nur über http aus.
            assert!(!policy.allows(&url("https://tauri.localhost/")));
            assert!(!policy.allows(&url("http://tauri.localhost:8080/")));
        } else {
            assert!(!policy.allows(&url("http://tauri.localhost/")));
            assert!(!policy.allows(&url("https://tauri.localhost/")));
            assert!(!policy.allows(&url("tauri://evil/")));
        }
    }

    #[test]
    fn https_nur_mit_use_https_scheme() {
        let policy = NavigationPolicy::new(true, None);
        if cfg!(windows) {
            assert!(policy.allows(&url("https://tauri.localhost/")));
            assert!(!policy.allows(&url("http://tauri.localhost/")));
        } else {
            assert!(policy.allows(&url("tauri://localhost/")));
        }
    }

    #[test]
    fn entwicklungs_server_nur_mit_dev_url_und_nur_genau_dieser_ursprung() {
        let dev = url("http://127.0.0.1:5173");
        let policy = NavigationPolicy::new(false, Some(&dev));
        assert!(policy.allows(&url("http://127.0.0.1:5173/")));
        assert!(policy.allows(&url("http://127.0.0.1:5173/src/main.tsx")));
        assert!(policy.allows(&bundled_url("/")));
        for target in [
            "http://127.0.0.1:5174/",
            "https://127.0.0.1:5173/",
            "http://localhost:5173/",
            "http://127.0.0.2:5173/",
            "https://example.com/",
        ] {
            assert!(
                !policy.allows(&url(target)),
                "{target} muss abgelehnt werden"
            );
        }
    }

    #[test]
    fn dev_url_ohne_host_erweitert_nichts() {
        let policy = NavigationPolicy::new(false, Some(&url("data:text/plain,x")));
        assert_eq!(policy, NavigationPolicy::new(false, None));
    }

    #[test]
    fn plugin_laesst_sich_bauen() {
        let _plugin: TauriPlugin<tauri::Wry> = guard(NavigationPolicy::new(false, None));
    }
}
