//! Transport zwischen Oberfläche und Dienst.
//!
//! - **Windows:** Named Pipe `\\.\pipe\aegis-service` mit Zugriffsliste (SYSTEM und
//!   Administratoren voll, angemeldete Nutzer lesen/schreiben), keine Netzwerk-Clients,
//!   erste Instanz exklusiv (verhindert, dass ein anderes Programm den Namen vorher belegt).
//! - **Unix** (nur Entwicklung/Tests): Unix-Socket in einem privaten Ordner.

use std::io::{self, Read, Write};
use std::sync::Mutex;

use aegis_core::consent::Clock;

use crate::handler::Service;
use crate::protocol::{Request, Response, read_frame, write_frame};

/// Bedient eine Verbindung, bis die Gegenseite schließt.
///
/// # Errors
/// Ein-/Ausgabefehler der Verbindung.
pub fn serve_connection<C: Clock, W: Write, S: Read + Write>(
    service: &Mutex<Service<C, W>>,
    stream: &mut S,
) -> io::Result<()> {
    loop {
        let payload = match read_frame(stream) {
            Ok(p) => p,
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e),
        };
        let response = match serde_json::from_slice::<Request>(&payload) {
            Ok(request) => service
                .lock()
                .map_err(|_| io::Error::other("Dienst-Zustand beschädigt"))?
                .handle(request),
            Err(e) => Response::error("invalid", format!("Ungültige Anfrage: {e}")),
        };
        let bytes = serde_json::to_vec(&response).map_err(io::Error::other)?;
        write_frame(stream, &bytes)?;
    }
}

/// Client: sendet eine Anfrage (JSON) und liefert die Antwort (JSON).
///
/// # Errors
/// Ein-/Ausgabefehler.
pub fn roundtrip<S: Read + Write>(stream: &mut S, request_json: &[u8]) -> io::Result<Vec<u8>> {
    write_frame(stream, request_json)?;
    read_frame(stream)
}

/// Unix-Socket (Entwicklung und Tests unter Linux).
#[cfg(unix)]
pub mod unix {
    use std::io;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;

    /// Bindet den Socket. Der Ordner muss AEGIS gehören (z. B. Datenordner des Dienstes).
    ///
    /// # Errors
    /// Pfad belegt oder nicht anlegbar.
    pub fn bind(path: &Path) -> io::Result<UnixListener> {
        // Socket-Datei im AEGIS-eigenen Datenordner anlegen (nur Entwicklung unter Linux).
        // aegis-mutation: service-unix-socket-bind
        #[allow(clippy::disallowed_methods)]
        let listener = UnixListener::bind(path);
        listener
    }

    /// Verbindet sich mit dem Dienst.
    ///
    /// # Errors
    /// Dienst nicht erreichbar.
    pub fn connect(path: &Path) -> io::Result<UnixStream> {
        UnixStream::connect(path)
    }
}

/// Named Pipe mit Zugriffsliste (Windows) – FFI liegt in `aegis-winffi`.
#[cfg(windows)]
pub mod windows {
    use std::fs::File;
    use std::io;

    pub use aegis_winffi::{
        DATA_DIR_SDDL, PIPE_NAME, PIPE_SDDL, accept, create_instance, secure_data_dir,
    };

    /// Verbindet sich als Client mit der Pipe.
    ///
    /// # Errors
    /// Dienst nicht erreichbar oder Zugriff verweigert.
    pub fn connect(name: &str) -> io::Result<File> {
        // Öffnet die Pipe des Dienstes zum Senden der Anfrage – keine Datei.
        // aegis-mutation: service-pipe-client-open
        #[allow(clippy::disallowed_methods)]
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(name);
        file
    }
}
