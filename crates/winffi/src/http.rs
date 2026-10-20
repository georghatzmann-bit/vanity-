//! HTTPS-Abruf über WinHTTP (Windows-Zertifikatsspeicher, System-Proxy). Nur `GET`, nur
//! HTTPS auf Port 443, keine automatischen Weiterleitungen (bei 3xx steht das Ziel in
//! `Response::location`, der Aufrufer prüft es selbst), Antwortgröße begrenzt. Für optionale Dienste
//! (Leck-Check) und später Updates – nie im Hintergrund ohne Nutzerwunsch.

use std::ffi::c_void;
use std::io;
use std::ptr;

use windows_sys::Win32::Networking::WinHttp::{
    INTERNET_DEFAULT_HTTPS_PORT, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_ADDREQ_FLAG_ADD,
    WINHTTP_FLAG_SECURE, WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2, WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3,
    WINHTTP_OPTION_REDIRECT_POLICY, WINHTTP_OPTION_REDIRECT_POLICY_NEVER,
    WINHTTP_OPTION_SECURE_PROTOCOLS, WINHTTP_QUERY_CONTENT_LENGTH, WINHTTP_QUERY_FLAG_NUMBER,
    WINHTTP_QUERY_FLAG_NUMBER64, WINHTTP_QUERY_LOCATION, WINHTTP_QUERY_STATUS_CODE,
    WinHttpAddRequestHeaders, WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest,
    WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest,
    WinHttpSetOption, WinHttpSetTimeouts,
};

use crate::util::wide;

/// Antwort eines Abrufs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    /// HTTP-Status.
    pub status: u16,
    /// Inhalt (höchstens die erlaubte Größe).
    pub body: Vec<u8>,
    /// Ziel einer Weiterleitung (nur bei 3xx; ungeprüft – der Aufrufer entscheidet).
    pub location: Option<String>,
}

/// WinHTTP-Handle, wird beim Verlassen geschlossen.
struct Internet(*mut c_void);

impl Internet {
    fn new(handle: *mut c_void) -> io::Result<Self> {
        if handle.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }
}

impl Drop for Internet {
    fn drop(&mut self) {
        // SAFETY: Handle stammt von WinHTTP und wird genau einmal geschlossen.
        // aegis-unsafe: winffi-http-close
        #[allow(unsafe_code)]
        unsafe {
            WinHttpCloseHandle(self.0);
        }
    }
}

fn check(ok: windows_sys::core::BOOL) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.contains('.')
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

fn clean(text: &str) -> bool {
    !text.chars().any(|c| c.is_control())
}

/// `GET https://<host><path>` mit zusätzlichen Kopfzeilen.
///
/// # Errors
/// Ungültige Eingaben, keine Verbindung, Zertifikat ungültig, Zeitüberschreitung oder Antwort
/// größer als `max_bytes`.
pub fn https_get(
    host: &str,
    path: &str,
    headers: &[(&str, &str)],
    max_bytes: usize,
    timeout_ms: i32,
) -> io::Result<Response> {
    https_get_progress(host, path, headers, max_bytes, timeout_ms, &mut |_, _| ())
}

/// Wie [`https_get`], meldet beim Lesen den Fortschritt: (gelesene Bytes, `Content-Length`
/// oder 0, wenn unbekannt).
///
/// # Errors
/// Wie [`https_get`].
pub fn https_get_progress(
    host: &str,
    path: &str,
    headers: &[(&str, &str)],
    max_bytes: usize,
    timeout_ms: i32,
    progress: &mut dyn FnMut(u64, u64),
) -> io::Result<Response> {
    if !valid_host(host)
        || !path.starts_with('/')
        || !clean(path)
        || path.contains(' ')
        || headers
            .iter()
            .any(|(k, v)| !clean(k) || !clean(v) || k.contains(':') || k.is_empty())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "ungültige Anfrage",
        ));
    }
    let agent = wide("AEGIS-Suite");
    // SAFETY: `agent` ist nullterminiert; kein fester Proxy (System/automatisch).
    // aegis-unsafe: winffi-http-open
    #[allow(unsafe_code)]
    let session = Internet::new(unsafe {
        WinHttpOpen(
            agent.as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            ptr::null(),
            ptr::null(),
            0,
        )
    })?;
    // SAFETY: gültiges Sitzungs-Handle.
    // aegis-unsafe: winffi-http-timeouts
    #[allow(unsafe_code)]
    check(unsafe {
        WinHttpSetTimeouts(session.0, timeout_ms, timeout_ms, timeout_ms, timeout_ms)
    })?;
    let protocols: u32 = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3;
    // SAFETY: gültiges Handle; Puffer ist ein u32 mit passender Länge.
    // aegis-unsafe: winffi-http-protocols
    #[allow(unsafe_code)]
    let ok = unsafe {
        WinHttpSetOption(
            session.0,
            WINHTTP_OPTION_SECURE_PROTOCOLS,
            (&raw const protocols).cast(),
            4,
        )
    };
    if ok == 0 {
        // Ältere Windows-10-Versionen kennen TLS 1.3 nicht: dann nur TLS 1.2.
        let tls12: u32 = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
        // SAFETY: wie oben.
        // aegis-unsafe: winffi-http-protocols-tls12
        #[allow(unsafe_code)]
        check(unsafe {
            WinHttpSetOption(
                session.0,
                WINHTTP_OPTION_SECURE_PROTOCOLS,
                (&raw const tls12).cast(),
                4,
            )
        })?;
    }
    let server = wide(host);
    // SAFETY: gültiges Sitzungs-Handle, nullterminierter Name.
    // aegis-unsafe: winffi-http-connect
    #[allow(unsafe_code)]
    let connection = Internet::new(unsafe {
        WinHttpConnect(session.0, server.as_ptr(), INTERNET_DEFAULT_HTTPS_PORT, 0)
    })?;
    let verb = wide("GET");
    let object = wide(path);
    // SAFETY: gültiges Verbindungs-Handle; nullterminierte Texte; HTTPS erzwungen.
    // aegis-unsafe: winffi-http-request
    #[allow(unsafe_code)]
    let request = Internet::new(unsafe {
        WinHttpOpenRequest(
            connection.0,
            verb.as_ptr(),
            object.as_ptr(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            WINHTTP_FLAG_SECURE,
        )
    })?;
    let never: u32 = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    // SAFETY: gültiges Anfrage-Handle; Puffer ist ein u32.
    // aegis-unsafe: winffi-http-no-redirect
    #[allow(unsafe_code)]
    check(unsafe {
        WinHttpSetOption(
            request.0,
            WINHTTP_OPTION_REDIRECT_POLICY,
            (&raw const never).cast(),
            4,
        )
    })?;
    for (name, value) in headers {
        let line = wide(format!("{name}: {value}"));
        // SAFETY: gültiges Anfrage-Handle; nullterminierte Kopfzeile (Länge -1 = bis Null).
        // aegis-unsafe: winffi-http-header
        #[allow(unsafe_code)]
        check(unsafe {
            WinHttpAddRequestHeaders(request.0, line.as_ptr(), u32::MAX, WINHTTP_ADDREQ_FLAG_ADD)
        })?;
    }
    // SAFETY: gültiges Anfrage-Handle; keine zusätzlichen Kopfzeilen oder Daten.
    // aegis-unsafe: winffi-http-send
    #[allow(unsafe_code)]
    check(unsafe { WinHttpSendRequest(request.0, ptr::null(), 0, ptr::null(), 0, 0, 0) })?;
    // SAFETY: gültiges Anfrage-Handle.
    // aegis-unsafe: winffi-http-receive
    #[allow(unsafe_code)]
    check(unsafe { WinHttpReceiveResponse(request.0, ptr::null_mut()) })?;
    let mut status = 0u32;
    let mut size = 4u32;
    // SAFETY: Puffer ist ein u32 mit passender Länge; kein Name, kein Index.
    // aegis-unsafe: winffi-http-status
    #[allow(unsafe_code)]
    check(unsafe {
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            ptr::null(),
            (&raw mut status).cast(),
            &mut size,
            ptr::null_mut(),
        )
    })?;
    let location = if (300..400).contains(&status) {
        let mut buffer = vec![0u16; 4096];
        let mut bytes = u32::try_from(buffer.len() * 2).unwrap_or(0);
        // SAFETY: gültiges Anfrage-Handle; Puffer mit angegebener Länge in Bytes; WinHTTP
        // schreibt höchstens so viel und gibt die geschriebene Länge zurück.
        // aegis-unsafe: winffi-http-location
        #[allow(unsafe_code)]
        let ok = unsafe {
            WinHttpQueryHeaders(
                request.0,
                WINHTTP_QUERY_LOCATION,
                ptr::null(),
                buffer.as_mut_ptr().cast(),
                &mut bytes,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            None
        } else {
            let len = (usize::try_from(bytes).unwrap_or(0) / 2).min(buffer.len());
            String::from_utf16(&buffer[..len]).ok()
        }
    } else {
        None
    };
    let mut length = 0u64;
    let mut size = 8u32;
    // SAFETY: Puffer ist ein u64 mit passender Länge; fehlt die Kopfzeile, bleibt er 0.
    // aegis-unsafe: winffi-http-length
    #[allow(unsafe_code)]
    let _ = unsafe {
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER64,
            ptr::null(),
            (&raw mut length).cast(),
            &mut size,
            ptr::null_mut(),
        )
    };
    let mut body = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let mut read = 0u32;
        // SAFETY: gültiges Anfrage-Handle; Puffer mit angegebener Länge.
        // aegis-unsafe: winffi-http-read
        #[allow(unsafe_code)]
        check(unsafe {
            WinHttpReadData(
                request.0,
                chunk.as_mut_ptr().cast(),
                u32::try_from(chunk.len()).unwrap_or(0),
                &mut read,
            )
        })?;
        if read == 0 {
            break;
        }
        let read = usize::try_from(read).unwrap_or(0).min(chunk.len());
        if body.len() + read > max_bytes {
            return Err(io::Error::other("Antwort zu groß"));
        }
        body.extend_from_slice(&chunk[..read]);
        progress(u64::try_from(body.len()).unwrap_or(u64::MAX), length);
    }
    Ok(Response {
        status: u16::try_from(status).unwrap_or(0),
        body,
        location,
    })
}
