//! Native-Messaging-Host „com.aegis.vault“: vom Browser für die Erweiterung „AEGIS Tresor“
//! gestartet. Jede Nachricht wird geprüft und über die Pipe des eigenen Kontos an die laufende
//! AEGIS-App weitergereicht; die Antwort geht zurück an die Erweiterung. Der Host prüft, dass am
//! anderen Ende wirklich die AEGIS-App aus demselben Installationsordner sitzt.

use std::io::{self, Write};

use aegis_vault_core::bridge::{Response, parse};
use aegis_vault_host::{caller_allowed, read_message, write_message};

fn reply(out: &mut impl Write, response: &Response) -> io::Result<()> {
    let body = zeroize::Zeroizing::new(serde_json::to_vec(response).map_err(io::Error::other)?);
    write_message(out, &body)
}

#[cfg(windows)]
fn forward(request: &[u8]) -> Response {
    use std::io::{BufRead, Read};
    let Ok(sid) = aegis_winffi::pipe::current_user_sid() else {
        return Response::error("app_not_running");
    };
    // Öffnet nur die Pipe der AEGIS-App des eigenen Kontos (keine Datei).
    // aegis-mutation: vault-host-pipe-open
    #[allow(clippy::disallowed_methods)]
    let pipe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(aegis_winffi::pipe::vault_pipe_name(&sid));
    let Ok(mut pipe) = pipe else {
        return Response::error("app_not_running");
    };
    // Ist der Server die AEGIS-App aus unserem Ordner?
    let expected = std::env::current_exe()
        .ok()
        .map(|p| p.with_file_name("aegis.exe"));
    let server = aegis_winffi::pipe::server_process_id(&pipe)
        .ok()
        .and_then(|pid| aegis_winffi::system::process_image_path(pid).ok());
    let same = matches!((&expected, &server), (Some(e), Some(s))
        if e.to_string_lossy().eq_ignore_ascii_case(&s.to_string_lossy()));
    // Und gehört die Pipe dem eigenen Konto (nicht einer fremden, vorher angelegten)?
    let owned = aegis_winffi::pipe::pipe_owner_sid(&pipe)
        .ok()
        .is_some_and(|owner| owner == sid);
    if !same || !owned {
        return Response::error("forbidden");
    }
    let mut line = request.to_vec();
    line.push(b'\n');
    if pipe.write_all(&line).is_err() {
        return Response::error("app_not_running");
    }
    let mut answer = zeroize::Zeroizing::new(String::new());
    let mut reader = io::BufReader::new((&mut pipe).take(1024 * 1024));
    if reader.read_line(&mut answer).is_err() {
        return Response::error("app_not_running");
    }
    serde_json::from_str(answer.trim()).unwrap_or_else(|_| Response::error("invalid"))
}

#[cfg(not(windows))]
fn forward(_request: &[u8]) -> Response {
    Response::error("app_not_running")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !caller_allowed(&args) {
        std::process::exit(2);
    }
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    while let Ok(Some(message)) = read_message(&mut input) {
        let response = match parse(&message) {
            Ok(_) => forward(&message),
            Err(_) => Response::error("invalid"),
        };
        if reply(&mut out, &response).is_err() {
            break;
        }
    }
}
