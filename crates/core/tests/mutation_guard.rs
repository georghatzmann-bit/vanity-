//! Mutations-Sperre der Goldenen Regel.
//!
//! Prüft alle Workspace-Mitglieder (laut `cargo metadata`) sowie `crates/**` und
//! `apps/*/src-tauri/**` – auch versteckte Ordner; nur `target/`, `node_modules/` direkt in
//! einem Projektordner und `.git/` bleiben außen vor:
//!
//! * Jede Unterdrückung von `clippy::disallowed_methods` (direkt oder über `clippy::all`,
//!   `clippy::style`, `warnings`; per `allow`/`expect`, auch in `cfg_attr`, auch mit
//!   Roh-Bezeichnern `r#…` oder Unicode-Leerraum) steht direkt unter einer Markierung
//!   `// aegis-mutation: <kennung>` bzw. `// aegis-consent: <kennung>` (oder trägt sie am
//!   Zeilenende); jede Unterdrückung von `unsafe_code` unter `// aegis-unsafe: <kennung>`.
//! * Jedes Paar (Datei, Kennung) steht in `crates/core/mutation-allowlist.txt`; veraltete
//!   Einträge und verwaiste Markierungen schlagen fehl.
//! * Ausnahmen sind eng: keine für ein ganzes Modul (`#![…]`, an `mod`/`impl`/`trait`),
//!   keine aus Makro-Metavariablen (`#[$m]`), keine Lint-Unterdrückung außerhalb von
//!   Attributen (z. B. als Makro-Argument).
//! * Nichts entzieht sich Clippy: kein `cfg(clippy)`/`cfg(not(clippy))`, kein `#[path]`,
//!   kein `include!`, keine `#[doc = …]`-Doku, keine Links im Quellbaum, keine Build-Skripte,
//!   die Clippy erkennen; Doctests, die laufen, rufen keine verändernden APIs auf.
//! * Die Sperrliste selbst ist intakt: `clippy.toml` (mit TOML-Parser gelesen) enthält alle
//!   Pflicht-Pfade mit Begründung; keine weitere `clippy.toml` zwischen einem Mitglied und
//!   der Wurzel; kein `CLIPPY_CONF_DIR`, `--cap-lints`, Lint-Abschwächungen oder
//!   Compiler-Wrapper in `.cargo/config*`, CI-Workflows oder der Wurzel-`Cargo.toml`; jedes
//!   Crate erbt die Workspace-Lints; jede Bibliothek unter `crates/` verbietet `unsafe`.
//! * Kein Mitglied hängt direkt von einem Crate mit verändernden APIs ab (tokio, windows,
//!   libc …), ohne dass `clippy.toml` dessen APIs sperrt.
//! * Das Test-Feature `testing` (gestellte Uhr, Fixture-Helfer, simulierte Nutzerantworten)
//!   wird nur in `dev-dependencies` eingeschaltet – geprüft an den Daten, die Cargo selbst
//!   aus den Manifesten liest (`cargo metadata`), nicht per Textsuche; und die
//!   Produktiv-Ziele bauen ohne Dev-Abhängigkeiten (dort gibt es `aegis_core::testing` nicht).
//!
//! Der Scanner arbeitet auf einer Fassung des Quelltexts, in der Kommentare und
//! Zeichenketten ausgeblendet sind – Beispiele in Strings oder Doku zählen also nicht.
//! Seine Logik wird unten an synthetischen Eingaben getestet, die Cargo-basierten Prüfungen
//! an echten Wegwerf-Workspaces.
// Integrationstest: Auch Hilfsfunktionen außerhalb von #[test] dürfen wie Tests per
// unwrap/expect/panic abbrechen (clippy.toml erlaubt das sonst nur direkt in #[test]).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;

/// Lints, deren Unterdrückung die Sperrliste aushebeln würde.
const GUARDED_DISALLOWED: &[&str] = &[
    "clippy::disallowed_methods",
    "clippy::disallowed_method",
    "clippy::all",
    "clippy::style",
    "warnings",
];

/// Lints, deren Unterdrückung `unsafe` erlaubt.
const GUARDED_UNSAFE: &[&str] = &["unsafe_code"];

const ALLOWLIST: &str = "crates/core/mutation-allowlist.txt";
const MIN_JUSTIFICATION_CHARS: usize = 20;

/// Pfade, die `clippy.toml` mindestens sperren muss. Nur `std::os::…` (es gibt sie nicht
/// auf jeder Plattform) darf `allow-invalid = true` tragen.
const REQUIRED_DISALLOWED: &[&str] = &[
    "std::fs::remove_file",
    "std::fs::remove_dir",
    "std::fs::remove_dir_all",
    "std::fs::rename",
    "std::fs::write",
    "std::fs::copy",
    "std::fs::hard_link",
    "std::fs::soft_link",
    "std::fs::set_permissions",
    "std::fs::create_dir",
    "std::fs::create_dir_all",
    "std::fs::DirBuilder::create",
    "std::fs::File::create",
    "std::fs::File::create_new",
    "std::fs::File::set_len",
    "std::fs::File::set_permissions",
    "std::fs::File::set_times",
    "std::fs::File::set_modified",
    "std::fs::OpenOptions::write",
    "std::fs::OpenOptions::append",
    "std::fs::OpenOptions::truncate",
    "std::fs::OpenOptions::create",
    "std::fs::OpenOptions::create_new",
    "std::os::windows::fs::OpenOptionsExt::access_mode",
    "std::os::windows::fs::OpenOptionsExt::custom_flags",
    "std::os::unix::fs::OpenOptionsExt::custom_flags",
    "std::os::windows::fs::symlink_file",
    "std::os::windows::fs::symlink_dir",
    "std::os::unix::fs::symlink",
    "std::os::unix::fs::chown",
    "std::os::unix::fs::fchown",
    "std::os::unix::fs::lchown",
    "std::os::unix::net::UnixListener::bind",
    "std::os::unix::net::UnixDatagram::bind",
    "std::process::Command::spawn",
    "std::process::Command::output",
    "std::process::Command::status",
    "std::os::unix::process::CommandExt::exec",
    "std::process::Child::kill",
    // Nutzerentscheidungen: nur der Pipe-Handler des Dienstes (Goldene Regel).
    "aegis_core::consent::ConsentGate::decide",
    "aegis_core::consent::ConsentGate::confirm_second",
    // Verändernde APIs verbreiteter Crates (dürfen `allow-invalid` tragen).
    "tokio::fs::remove_file",
    "tokio::fs::remove_dir",
    "tokio::fs::remove_dir_all",
    "tokio::fs::rename",
    "tokio::fs::write",
    "tokio::fs::copy",
    "tokio::fs::hard_link",
    "tokio::fs::set_permissions",
    "tokio::fs::create_dir",
    "tokio::fs::create_dir_all",
    "tokio::fs::File::create",
    "tokio::fs::OpenOptions::write",
    "tokio::process::Command::spawn",
    "tokio::process::Command::output",
    "tokio::process::Command::status",
    "tokio::process::Child::kill",
    "tokio::process::Child::start_kill",
    "tempfile::NamedTempFile::persist",
    "tempfile::NamedTempFile::persist_noclobber",
    "tempfile::TempPath::persist",
    "tempfile::NamedTempFile::new_in",
    "tempfile::tempdir_in",
    "tempfile::tempfile_in",
    "tempfile::Builder::tempfile_in",
    "tempfile::Builder::tempdir_in",
];

/// Crates mit verändernden APIs: Hängt ein Mitglied direkt davon ab, muss `clippy.toml`
/// Pfade dieses Crates sperren (sonst fiele jeder Aufruf durch das Raster).
const MUTATION_CAPABLE_CRATES: &[&str] = &[
    "tokio",
    "tempfile",
    "windows",
    "windows-sys",
    "winapi",
    "libc",
    "nix",
    "rustix",
    "async-std",
    "async-fs",
    "async-process",
    "smol",
    "fs_extra",
    "fs-err",
    "fs4",
    "trash",
    "remove_dir_all",
    "filetime",
    "junction",
    "symlink",
    "opener",
    "open",
    "duct",
    "subprocess",
    "shared_child",
    "command-group",
    "sysinfo",
    "cap-std",
    "self_replace",
    "tauri-plugin-fs",
    "tauri-plugin-shell",
    "tauri-plugin-process",
];

// ---------------------------------------------------------------------------------------
// Lexer: blendet Kommentare und Literale aus, sammelt Kommentare
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct LineComment {
    /// Zeile (ab 1).
    line: usize,
    /// Steht der Kommentar allein in seiner Zeile?
    standalone: bool,
    /// Text nach `//`.
    text: String,
}

/// Doku-Blockkommentar `/** … */` bzw. `/*! … */` (Inhalt ohne Begrenzer).
#[derive(Debug, Clone, PartialEq, Eq)]
struct BlockDoc {
    line: usize,
    text: String,
}

#[derive(Debug)]
struct Lexed {
    /// Quelltext mit ausgeblendeten Kommentaren/Literalen (Zeilenumbrüche bleiben erhalten).
    code: Vec<u8>,
    comments: Vec<LineComment>,
    block_docs: Vec<BlockDoc>,
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn utf8_len(first: u8) -> usize {
    match first {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    }
}

fn lex(src: &str) -> Lexed {
    let b = src.as_bytes();
    let n = b.len();
    let mut code: Vec<u8> = Vec::with_capacity(n);
    let mut comments = Vec::new();
    let mut block_docs = Vec::new();
    let mut line = 1;
    let mut i = 0;

    // Blendet b[from..to] aus (Zeilenumbrüche bleiben).
    let mask = |code: &mut Vec<u8>, line: &mut usize, from: usize, to: usize| {
        for &byte in &b[from..to.min(n)] {
            if byte == b'\n' {
                *line += 1;
                code.push(b'\n');
            } else {
                code.push(b' ');
            }
        }
    };

    while i < n {
        let c = b[i];
        let next = b.get(i + 1).copied();
        let prev_ident = code.last().is_some_and(|&p| is_ident_byte(p));

        // Zeilenkommentar
        if c == b'/' && next == Some(b'/') {
            let end = b[i..].iter().position(|&x| x == b'\n').map_or(n, |p| i + p);
            let line_start = code.iter().rposition(|&x| x == b'\n').map_or(0, |p| p + 1);
            let standalone = code[line_start..].iter().all(u8::is_ascii_whitespace);
            comments.push(LineComment {
                line,
                standalone,
                text: src[i + 2..end].to_owned(),
            });
            mask(&mut code, &mut line, i, end);
            i = end;
            continue;
        }
        // Blockkommentar (verschachtelt)
        if c == b'/' && next == Some(b'*') {
            let mut depth = 0usize;
            let mut j = i;
            while j < n {
                if b[j] == b'/' && b.get(j + 1) == Some(&b'*') {
                    depth += 1;
                    j += 2;
                } else if b[j] == b'*' && b.get(j + 1) == Some(&b'/') {
                    depth -= 1;
                    j += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    j += 1;
                }
            }
            let body = &src[i..j.min(n)];
            let is_doc =
                (body.starts_with("/**") && !body.starts_with("/***")) || body.starts_with("/*!");
            if is_doc && body.len() >= 5 {
                let inner = &body[3..body.len().saturating_sub(2).max(3)];
                block_docs.push(BlockDoc {
                    line,
                    text: inner.to_owned(),
                });
            }
            mask(&mut code, &mut line, i, j);
            i = j;
            continue;
        }
        // Roh-Zeichenketten: r"…", r#"…"#, br"…", cr#"…"#
        if !prev_ident && (c == b'r' || ((c == b'b' || c == b'c') && next == Some(b'r'))) {
            let mut j = if c == b'r' { i + 1 } else { i + 2 };
            let mut hashes = 0;
            while b.get(j) == Some(&b'#') {
                hashes += 1;
                j += 1;
            }
            if b.get(j) == Some(&b'"') {
                j += 1;
                loop {
                    if j >= n {
                        break;
                    }
                    if b[j] == b'"'
                        && b[j + 1..]
                            .iter()
                            .take(hashes)
                            .filter(|&&h| h == b'#')
                            .count()
                            == hashes
                    {
                        j += 1 + hashes;
                        break;
                    }
                    j += 1;
                }
                mask(&mut code, &mut line, i, j);
                i = j;
                continue;
            }
        }
        // Byte-/C-Zeichenketten b"…", c"…"
        if !prev_ident && (c == b'b' || c == b'c') && next == Some(b'"') {
            code.push(b' ');
            i += 1;
            continue; // das folgende `"` beginnt die Zeichenkette
        }
        // Zeichenkette
        if c == b'"' {
            let mut j = i + 1;
            while j < n {
                match b[j] {
                    b'\\' => j += 2,
                    b'"' => {
                        j += 1;
                        break;
                    }
                    _ => j += 1,
                }
            }
            mask(&mut code, &mut line, i, j);
            i = j;
            continue;
        }
        // Zeichenliteral oder Lebensdauer
        if c == b'\'' {
            if next == Some(b'\\') {
                let mut j = i + 3;
                while j < n && b[j] != b'\'' {
                    j += 1;
                }
                mask(&mut code, &mut line, i, j + 1);
                i = j + 1;
                continue;
            }
            if let Some(first) = next {
                let len = utf8_len(first);
                if b.get(i + 1 + len) == Some(&b'\'') {
                    mask(&mut code, &mut line, i, i + 2 + len);
                    i += 2 + len;
                    continue;
                }
            }
            code.push(c);
            i += 1;
            continue;
        }
        if c == b'\n' {
            line += 1;
        }
        code.push(c);
        i += 1;
    }
    Lexed {
        code,
        comments,
        block_docs,
    }
}

// ---------------------------------------------------------------------------------------
// Tokens: Bezeichner (Roh-Bezeichner ohne `r#`) und Satzzeichen, Leerraum (auch Unicode)
// trennt nur
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct Token {
    text: String,
    line: usize,
    ident: bool,
}

/// Leerraum, wie ihn der Rust-Lexer kennt (`Pattern_White_Space`) – samt Unicode-Zeichen,
/// die rustfmt nicht anfasst (VT, U+2028, U+200E …).
fn is_rust_whitespace(c: char) -> bool {
    c.is_whitespace() || matches!(c, '\u{200e}' | '\u{200f}')
}

fn is_ident_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn tokenize(code: &[u8]) -> Vec<Token> {
    let text = String::from_utf8_lossy(code);
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut line = 1;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\n' {
            line += 1;
            i += 1;
            continue;
        }
        if is_rust_whitespace(c) {
            i += 1;
            continue;
        }
        if is_ident_char(c) {
            // Roh-Bezeichner `r#name` zählt wie `name`.
            if c == 'r'
                && chars.get(i + 1) == Some(&'#')
                && chars.get(i + 2).is_some_and(|&n| is_ident_char(n))
                && !chars
                    .get(i.wrapping_sub(1))
                    .is_some_and(|&p| i > 0 && is_ident_char(p))
            {
                i += 2;
            }
            let start = i;
            while i < chars.len() && is_ident_char(chars[i]) {
                i += 1;
            }
            tokens.push(Token {
                text: chars[start..i].iter().collect(),
                line,
                ident: true,
            });
            continue;
        }
        tokens.push(Token {
            text: c.to_string(),
            line,
            ident: false,
        });
        i += 1;
    }
    tokens
}

/// Ein Attribut `#[…]` / `#![…]`.
#[derive(Debug, Clone)]
struct Attribute {
    /// Zeile des `#`.
    line: usize,
    inner: bool,
    /// Inhalt zwischen den Klammern, Tokens ohne Leerraum aneinandergereiht.
    text: String,
    /// Token-Bereich [start, end] (einschließlich).
    start: usize,
    end: usize,
}

fn is_punct(tokens: &[Token], index: usize, text: &str) -> bool {
    tokens
        .get(index)
        .is_some_and(|t| !t.ident && t.text == text)
}

fn is_ident(tokens: &[Token], index: usize, text: &str) -> bool {
    tokens.get(index).is_some_and(|t| t.ident && t.text == text)
}

fn attributes(tokens: &[Token]) -> Vec<Attribute> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        if !is_punct(tokens, i, "#") {
            i += 1;
            continue;
        }
        let inner = is_punct(tokens, i + 1, "!");
        let open = if inner { i + 2 } else { i + 1 };
        if !is_punct(tokens, open, "[") {
            i += 1;
            continue;
        }
        let mut depth = 0usize;
        let mut k = open;
        while k < tokens.len() {
            if is_punct(tokens, k, "[") {
                depth += 1;
            } else if is_punct(tokens, k, "]") {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            k += 1;
        }
        let end = k.min(tokens.len().saturating_sub(1));
        let text: String = tokens[open + 1..end.max(open + 1)]
            .iter()
            .map(|t| t.text.as_str())
            .collect();
        out.push(Attribute {
            line: tokens[i].line,
            inner,
            text,
            start: i,
            end,
        });
        i = end + 1;
    }
    out
}

/// Welche bewachten Lints unterdrückt der Text (per `allow(…)`/`expect(…)`)?
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Suppresses {
    disallowed: bool,
    unsafe_code: bool,
}

impl Suppresses {
    const fn any(self) -> bool {
        self.disallowed || self.unsafe_code
    }
}

fn suppressed_lints(text: &str) -> Suppresses {
    let bytes = text.as_bytes();
    let mut found = Suppresses::default();
    for keyword in ["allow(", "expect("] {
        let mut from = 0;
        while let Some(pos) = text[from..].find(keyword) {
            let at = from + pos;
            from = at + keyword.len();
            if at > 0 && is_ident_byte(bytes[at - 1]) {
                continue;
            }
            let mut depth = 1usize;
            let mut k = from;
            while k < bytes.len() && depth > 0 {
                match bytes[k] {
                    b'(' => depth += 1,
                    b')' => depth -= 1,
                    _ => {}
                }
                k += 1;
            }
            let inner = &text[from..k.saturating_sub(1).max(from)];
            for item in inner.split(',') {
                found.disallowed |= GUARDED_DISALLOWED.contains(&item);
                found.unsafe_code |= GUARDED_UNSAFE.contains(&item);
            }
        }
    }
    found
}

/// `true`, wenn `needle` im Attribut-Text am Anfang oder nach `(`/`,` steht.
fn has_meta_item(text: &str, needle: &str) -> bool {
    let mut from = 0;
    while let Some(pos) = text[from..].find(needle) {
        let at = from + pos;
        if at == 0 || matches!(text.as_bytes()[at - 1], b'(' | b',') {
            return true;
        }
        from = at + needle.len();
    }
    false
}

/// Das Element nach einem Attribut ist ein ganzes Modul, `impl`, `trait`, `extern`-Block
/// oder Makro?
fn attribute_covers_module(tokens: &[Token], attr_end: usize) -> bool {
    let mut i = attr_end + 1;
    loop {
        // Weitere Attribute überspringen.
        if is_punct(tokens, i, "#") && is_punct(tokens, i + 1, "[") {
            let mut depth = 0usize;
            let mut k = i + 1;
            while k < tokens.len() {
                if is_punct(tokens, k, "[") {
                    depth += 1;
                } else if is_punct(tokens, k, "]") {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                k += 1;
            }
            i = k + 1;
            continue;
        }
        break;
    }
    if is_ident(tokens, i, "pub") {
        i += 1;
        if is_punct(tokens, i, "(") {
            while i < tokens.len() && !is_punct(tokens, i, ")") {
                i += 1;
            }
            i += 1;
        }
    }
    if is_ident(tokens, i, "unsafe") {
        i += 1;
    }
    match tokens.get(i) {
        Some(t) if t.ident => match t.text.as_str() {
            "mod" | "impl" | "trait" | "macro_rules" => true,
            "extern" => is_ident(tokens, i + 1, "crate") || is_punct(tokens, i + 1, "{"),
            _ => false,
        },
        _ => false,
    }
}

// ---------------------------------------------------------------------------------------
// Scanner für eine Datei
// ---------------------------------------------------------------------------------------

/// Art der Markierung.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkerKind {
    /// `aegis-mutation:` – verändernde API.
    Mutation,
    /// `aegis-consent:` – Nutzerentscheidung annehmen.
    Consent,
    /// `aegis-unsafe:` – `unsafe` (nur Windows-FFI mit `// SAFETY:`).
    Unsafe,
}

const MARKER_PREFIXES: &[(&str, MarkerKind)] = &[
    ("aegis-mutation:", MarkerKind::Mutation),
    ("aegis-consent:", MarkerKind::Consent),
    ("aegis-unsafe:", MarkerKind::Unsafe),
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct Suppression {
    line: usize,
    marker: Option<String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct FileScan {
    suppressions: Vec<Suppression>,
    errors: Vec<String>,
}

fn is_valid_marker_id(id: &str) -> bool {
    !id.is_empty()
        && id.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// Eine Markierung im Quelltext.
#[derive(Debug, Clone)]
struct Marker {
    line: usize,
    standalone: bool,
    kind: MarkerKind,
    id: Result<String, String>,
}

fn markers(comments: &[LineComment]) -> Vec<Marker> {
    comments
        .iter()
        .filter_map(|comment| {
            let text = comment.text.trim();
            let (rest, kind) = MARKER_PREFIXES
                .iter()
                .find_map(|(prefix, kind)| text.strip_prefix(prefix).map(|rest| (rest, *kind)))?;
            let id = rest.trim();
            let parsed = if is_valid_marker_id(id) {
                Ok(id.to_owned())
            } else {
                Err(format!(
                    "Zeile {}: ungültige Markierung „{text}“ (erlaubt: Kleinbuchstaben, Ziffern, Bindestriche)",
                    comment.line
                ))
            };
            Some(Marker {
                line: comment.line,
                standalone: comment.standalone,
                kind,
                id: parsed,
            })
        })
        .collect()
}

/// Bezeichner, die in einem laufenden Doctest (nach `.` oder `::`) auf eine verändernde
/// API hindeuten.
const MUTATING_IDENTS: &[&str] = &[
    "remove_file",
    "remove_dir",
    "remove_dir_all",
    "rename",
    "write",
    "copy",
    "hard_link",
    "soft_link",
    "symlink",
    "symlink_file",
    "symlink_dir",
    "set_permissions",
    "create_dir",
    "create_dir_all",
    "create",
    "create_new",
    "set_len",
    "set_times",
    "set_modified",
    "append",
    "truncate",
    "custom_flags",
    "access_mode",
    "chown",
    "fchown",
    "lchown",
    "spawn",
    "output",
    "status",
    "kill",
    "start_kill",
    "exec",
    "persist",
    "persist_noclobber",
    "bind",
];

/// Rustdoc-Angaben, mit denen ein Codeblock weiterhin Rust ist.
const RUSTDOC_ATTRS: &[&str] = &[
    "rust",
    "ignore",
    "should_panic",
    "no_run",
    "compile_fail",
    "test_harness",
    "standalone_crate",
    "edition2015",
    "edition2018",
    "edition2021",
    "edition2024",
];

/// Prüft die Codeblöcke einer Doku auf laufende Doctests mit verändernden Aufrufen.
fn check_doctests(chunks: &[(usize, Vec<String>)], errors: &mut Vec<String>) {
    for (start, lines) in chunks {
        let mut fence: Option<(String, bool, usize)> = None;
        let mut code = String::new();
        for (offset, raw) in lines.iter().enumerate() {
            let line = raw.trim();
            let marker = if line.starts_with("```") {
                Some("```")
            } else if line.starts_with("~~~") {
                Some("~~~")
            } else {
                None
            };
            match (&fence, marker) {
                (None, Some(m)) => {
                    let info = line.trim_start_matches(m).trim();
                    let tags: Vec<&str> = info
                        .split(|c: char| c == ',' || c.is_whitespace())
                        .filter(|t| !t.is_empty())
                        .collect();
                    let rust = tags.is_empty()
                        || tags.contains(&"rust")
                        || tags.iter().all(|t| RUSTDOC_ATTRS.contains(t));
                    let runs = rust
                        && !tags
                            .iter()
                            .any(|t| matches!(*t, "ignore" | "no_run" | "compile_fail"));
                    fence = Some((m.to_owned(), runs, start + offset));
                    code.clear();
                }
                (Some((open, runs, at)), Some(m)) if m == open => {
                    if *runs {
                        let tokens = tokenize(&lex(&code).code);
                        for (i, token) in tokens.iter().enumerate() {
                            let after_path = i >= 1 && is_punct(&tokens, i - 1, ".")
                                || i >= 2
                                    && is_punct(&tokens, i - 1, ":")
                                    && is_punct(&tokens, i - 2, ":");
                            if token.ident
                                && after_path
                                && MUTATING_IDENTS.contains(&token.text.as_str())
                            {
                                errors.push(format!(
                                    "Zeile {at}: Doctest ruft „{}“ auf und läuft bei `cargo test` – \
                                     als `no_run`/`ignore` kennzeichnen oder aegis_core::testing nutzen",
                                    token.text
                                ));
                            }
                        }
                    }
                    fence = None;
                }
                (Some(_), _) => {
                    let code_line = raw.trim_start();
                    let code_line = code_line
                        .strip_prefix("# ")
                        .or_else(|| (code_line == "#").then_some(""))
                        .unwrap_or(code_line);
                    code.push_str(code_line);
                    code.push('\n');
                }
                (None, None) => {}
            }
        }
    }
}

/// Doku-Abschnitte einer Datei: aufeinanderfolgende `///`/`//!`-Zeilen und Doku-Blöcke.
fn doc_chunks(lexed: &Lexed) -> Vec<(usize, Vec<String>)> {
    let mut chunks: Vec<(usize, Vec<String>)> = Vec::new();
    let mut last_line = 0;
    for comment in &lexed.comments {
        let doc = (comment.text.starts_with('/') && !comment.text.starts_with("//"))
            || comment.text.starts_with('!');
        if !doc {
            continue;
        }
        let text = comment.text[1..].to_owned();
        match chunks.last_mut() {
            Some((_, lines)) if comment.line == last_line + 1 => lines.push(text),
            _ => chunks.push((comment.line, vec![text])),
        }
        last_line = comment.line;
    }
    for block in &lexed.block_docs {
        let lines = block
            .text
            .lines()
            .map(|l| {
                let t = l.trim_start();
                t.strip_prefix('*').unwrap_or(t).to_owned()
            })
            .collect();
        chunks.push((block.line, lines));
    }
    chunks
}

fn scan_source(src: &str) -> FileScan {
    let lexed = lex(src);
    let tokens = tokenize(&lexed.code);
    let attrs = attributes(&tokens);
    let found_markers = markers(&lexed.comments);
    let mut used_marker_lines = BTreeSet::new();
    let mut scan = FileScan::default();
    let mut ids_seen = BTreeSet::new();
    let mut in_attribute = vec![false; tokens.len()];

    for attr in &attrs {
        for flag in &mut in_attribute[attr.start..=attr.end] {
            *flag = true;
        }
        let line = attr.line;
        if attr.text.contains('$') {
            scan.errors.push(format!(
                "Zeile {line}: Attribut aus Makro-Metavariablen (`#[$…]`) – Lint-Ausnahmen ließen \
                 sich so verstecken, verboten"
            ));
        }
        if has_meta_item(&attr.text, "path=") {
            scan.errors.push(format!(
                "Zeile {line}: `#[path = …]` holt Quelltext von außerhalb des geprüften Baums – verboten"
            ));
        }
        if has_meta_item(&attr.text, "doc=") {
            scan.errors.push(format!(
                "Zeile {line}: `#[doc = …]` – Doctests darin würden nicht geprüft; bitte `///` verwenden"
            ));
        }
        let lints = suppressed_lints(&attr.text);
        if !lints.any() {
            continue;
        }
        if attr.inner {
            scan.errors.push(format!(
                "Zeile {line}: Ausnahme als inneres Attribut (`#![…]`) gilt für Modul oder Crate – \
                 so eng wie möglich setzen"
            ));
        } else if attribute_covers_module(&tokens, attr.end) {
            scan.errors.push(format!(
                "Zeile {line}: Ausnahme an `mod`/`impl`/`trait`/`extern`/Makro gilt für zu viel – \
                 an das Statement oder eine kleine Funktion setzen"
            ));
        }
        if lints.disallowed && lints.unsafe_code {
            scan.errors.push(format!(
                "Zeile {line}: `unsafe_code` und Mutations-Lints in einer Ausnahme – getrennt setzen"
            ));
        }
        let marker = found_markers
            .iter()
            .find(|m| (m.standalone && m.line + 1 == line) || (!m.standalone && m.line == line));
        let marker = match marker {
            Some(m) => {
                used_marker_lines.insert(m.line);
                let fits = if lints.unsafe_code {
                    m.kind == MarkerKind::Unsafe
                } else {
                    matches!(m.kind, MarkerKind::Mutation | MarkerKind::Consent)
                };
                if !fits {
                    scan.errors.push(format!(
                        "Zeile {line}: Markierung passt nicht zur Ausnahme (`unsafe_code` braucht \
                         `aegis-unsafe:`, Mutations-Lints `aegis-mutation:`/`aegis-consent:`)"
                    ));
                }
                match &m.id {
                    Ok(id) => {
                        if !ids_seen.insert(id.clone()) {
                            scan.errors.push(format!(
                                "Zeile {line}: Kennung „{id}“ ist in dieser Datei doppelt"
                            ));
                        }
                        Some(id.clone())
                    }
                    Err(_) => None,
                }
            }
            None => None,
        };
        scan.suppressions.push(Suppression { line, marker });
    }

    for (i, token) in tokens.iter().enumerate() {
        if !token.ident {
            continue;
        }
        let line = token.line;
        // `cfg(clippy)`, `cfg(not(clippy))`, `cfg_attr(clippy, …)`, `cfg!(clippy)`: Code, den
        // Clippy nicht sieht, der aber gebaut wird.
        if token.text == "clippy"
            && !(is_punct(&tokens, i + 1, ":") && is_punct(&tokens, i + 2, ":"))
        {
            scan.errors.push(format!(
                "Zeile {line}: `clippy` als cfg-Prädikat blendet Code vor Clippy aus – verboten"
            ));
        }
        if token.text == "include" && is_punct(&tokens, i + 1, "!") {
            scan.errors.push(format!(
                "Zeile {line}: `include!` holt ungeprüften Quelltext – verboten"
            ));
        }
        // Lint-Unterdrückung außerhalb eines Attributs (z. B. als Makro-Argument).
        if (token.text == "allow" || token.text == "expect")
            && !in_attribute[i]
            && is_punct(&tokens, i + 1, "(")
        {
            let mut depth = 0usize;
            let mut k = i + 1;
            let mut text = String::from(&token.text);
            while k < tokens.len() {
                if is_punct(&tokens, k, "(") {
                    depth += 1;
                } else if is_punct(&tokens, k, ")") {
                    depth -= 1;
                }
                text.push_str(&tokens[k].text);
                if depth == 0 {
                    break;
                }
                k += 1;
            }
            if suppressed_lints(&text).any() {
                scan.errors.push(format!(
                    "Zeile {line}: Lint-Unterdrückung außerhalb eines Attributs (z. B. über ein Makro) – verboten"
                ));
            }
        }
    }

    for marker in &found_markers {
        match &marker.id {
            Err(message) => scan.errors.push(message.clone()),
            Ok(id) if !used_marker_lines.contains(&marker.line) => scan.errors.push(format!(
                "Zeile {}: Markierung „{id}“ ohne direkt folgende Ausnahme (verwaist)",
                marker.line
            )),
            Ok(_) => {}
        }
    }
    check_doctests(&doc_chunks(&lexed), &mut scan.errors);
    scan
}

// ---------------------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------------------

type Allowlist = BTreeMap<(String, String), String>;

fn parse_allowlist(text: &str) -> (Allowlist, Vec<String>) {
    let mut entries = Allowlist::new();
    let mut errors = Vec::new();
    for (index, raw) in text.lines().enumerate() {
        let line_no = index + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.splitn(3, " :: ").map(str::trim).collect();
        let [path, id, justification] = parts.as_slice() else {
            errors.push(format!(
                "{ALLOWLIST}:{line_no}: erwartet „<pfad> :: <kennung> :: <begründung>“"
            ));
            continue;
        };
        if path.is_empty()
            || path.starts_with('/')
            || path.contains('\\')
            || path
                .split('/')
                .any(|part| part == ".." || part == "." || part.is_empty())
            || !path.ends_with(".rs")
        {
            errors.push(format!(
                "{ALLOWLIST}:{line_no}: ungültiger Pfad „{path}“ (relativ ab Repo-Wurzel, mit „/“, auf .rs)"
            ));
            continue;
        }
        if !is_valid_marker_id(id) {
            errors.push(format!("{ALLOWLIST}:{line_no}: ungültige Kennung „{id}“"));
            continue;
        }
        if justification.chars().count() < MIN_JUSTIFICATION_CHARS {
            errors.push(format!(
                "{ALLOWLIST}:{line_no}: Begründung fehlt oder ist zu kurz (mindestens {MIN_JUSTIFICATION_CHARS} Zeichen)"
            ));
            continue;
        }
        let key = ((*path).to_owned(), (*id).to_owned());
        if entries.insert(key, (*justification).to_owned()).is_some() {
            errors.push(format!(
                "{ALLOWLIST}:{line_no}: doppelter Eintrag {path} :: {id}"
            ));
        }
    }
    (entries, errors)
}

// ---------------------------------------------------------------------------------------
// Konfiguration (clippy.toml, Manifeste, .cargo/config) – mit TOML-Parser
// ---------------------------------------------------------------------------------------

fn parse_toml(name: &str, text: &str, errors: &mut Vec<String>) -> Option<toml::Table> {
    match text.parse::<toml::Table>() {
        Ok(table) => Some(table),
        Err(err) => {
            errors.push(format!("{name}: kein gültiges TOML ({err})"));
            None
        }
    }
}

/// Stufe eines Eintrags in einer `[lints]`-Tabelle (`"allow"` oder `{ level = "allow" }`).
fn lint_level(value: &toml::Value) -> Option<&str> {
    match value {
        toml::Value::String(level) => Some(level),
        toml::Value::Table(table) => table.get("level").and_then(toml::Value::as_str),
        _ => None,
    }
}

fn get_table<'a>(table: &'a toml::Table, path: &[&str]) -> Option<&'a toml::Table> {
    let mut current = table;
    for key in path {
        current = current.get(*key)?.as_table()?;
    }
    Some(current)
}

/// Erbt das Manifest die Workspace-Lints (`[lints]` mit `workspace = true`)?
fn manifest_inherits_lints(manifest: &str) -> bool {
    let mut errors = Vec::new();
    parse_toml("Cargo.toml", manifest, &mut errors).is_some_and(|table| {
        get_table(&table, &["lints"])
            .and_then(|lints| lints.get("workspace"))
            .and_then(toml::Value::as_bool)
            == Some(true)
    })
}

/// Fehler in der Wurzel-`clippy.toml`.
fn check_clippy_toml(text: &str) -> Vec<String> {
    let mut errors = Vec::new();
    let Some(table) = parse_toml("clippy.toml", text, &mut errors) else {
        return errors;
    };
    if table.contains_key("disallowed_methods") {
        errors.push(
            "clippy.toml: Schlüssel `disallowed_methods` (mit Unterstrich) ist mehrdeutig – nur `disallowed-methods`"
                .to_owned(),
        );
    }
    let Some(entries) = table
        .get("disallowed-methods")
        .and_then(toml::Value::as_array)
    else {
        errors.push("clippy.toml: Liste `disallowed-methods` fehlt".to_owned());
        return errors;
    };
    let mut listed: BTreeMap<String, bool> = BTreeMap::new();
    for entry in entries {
        let Some(entry) = entry.as_table() else {
            errors.push(format!(
                "clippy.toml: Eintrag {entry} ohne Begründung – jede Sperre braucht `path` und `reason`"
            ));
            continue;
        };
        let path = entry.get("path").and_then(toml::Value::as_str);
        let reason = entry.get("reason").and_then(toml::Value::as_str);
        let (Some(path), Some(reason)) = (path, reason) else {
            errors.push(format!(
                "clippy.toml: Eintrag {entry} – jede Sperre braucht `path` und `reason`"
            ));
            continue;
        };
        if reason.trim().is_empty() {
            errors.push(format!("clippy.toml: Sperre „{path}“ ohne Begründung"));
        }
        let allow_invalid = entry
            .get("allow-invalid")
            .and_then(toml::Value::as_bool)
            .unwrap_or(false);
        listed.insert(path.to_owned(), allow_invalid);
    }
    for path in REQUIRED_DISALLOWED {
        match listed.get(*path) {
            None => errors.push(format!(
                "clippy.toml: Pflicht-Sperre „{path}“ fehlt in disallowed-methods"
            )),
            Some(true)
                if (path.starts_with("std::") && !path.starts_with("std::os::"))
                    || path.starts_with("aegis_core::") =>
            {
                errors.push(format!(
                    "clippy.toml: Pflicht-Sperre „{path}“ darf kein `allow-invalid` tragen (sie gilt überall)"
                ));
            }
            Some(_) => {}
        }
    }
    errors
}

/// Fehler in der Wurzel-`Cargo.toml` (Lint-Abschwächungen, Test-Feature im Workspace).
fn check_root_manifest(text: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if text.contains("disallowed_methods") || text.contains("disallowed-methods") {
        errors.push("Cargo.toml: disallowed_methods darf nicht umkonfiguriert werden".to_owned());
    }
    let Some(table) = parse_toml("Cargo.toml", text, &mut errors) else {
        return errors;
    };
    if let Some(clippy_lints) = get_table(&table, &["workspace", "lints", "clippy"]) {
        for key in ["all", "style", "disallowed_methods", "disallowed_method"] {
            if clippy_lints.get(key).and_then(lint_level) == Some("allow") {
                errors.push(format!(
                    "Cargo.toml: clippy::{key} darf nicht auf „allow“ stehen"
                ));
            }
        }
    }
    let rust = get_table(&table, &["workspace", "lints", "rust"]);
    if rust.and_then(|r| r.get("warnings")).and_then(lint_level) == Some("allow") {
        errors.push("Cargo.toml: `warnings` darf nicht auf „allow“ stehen".to_owned());
    }
    if !matches!(
        rust.and_then(|r| r.get("unsafe_code")).and_then(lint_level),
        Some("deny" | "forbid")
    ) {
        errors.push("Cargo.toml: `unsafe_code` muss auf „deny“ oder „forbid“ stehen".to_owned());
    }
    if let Some(deps) = get_table(&table, &["workspace", "dependencies"]) {
        for (key, dep) in deps {
            let Some(dep) = dep.as_table() else { continue };
            let package = dep
                .get("package")
                .and_then(toml::Value::as_str)
                .unwrap_or(key);
            let testing = dep
                .get("features")
                .and_then(toml::Value::as_array)
                .is_some_and(|f| f.iter().any(|v| v.as_str() == Some("testing")));
            if package == "aegis-core" && testing {
                errors.push(
                    "Cargo.toml: Feature „testing“ von aegis-core darf nicht in [workspace.dependencies] stehen"
                        .to_owned(),
                );
            }
        }
    }
    errors
}

/// Fehler in einer `.cargo/config(.toml)`: nichts darf Clippy umkonfigurieren.
fn check_cargo_config(name: &str, text: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if text.contains("disallowed") || text.contains("clippy::") {
        errors.push(format!("{name}: darf keine Clippy-Lints umkonfigurieren"));
    }
    let Some(table) = parse_toml(name, text, &mut errors) else {
        return errors;
    };
    if let Some(env) = get_table(&table, &["env"]) {
        for key in env.keys() {
            if key.to_ascii_uppercase().contains("CLIPPY") {
                errors.push(format!(
                    "{name}: [env] {key} würde Clippy eine andere Konfiguration geben – verboten"
                ));
            }
        }
    }
    if let Some(build) = get_table(&table, &["build"]) {
        for key in ["rustc", "rustc-wrapper", "rustc-workspace-wrapper"] {
            if build.contains_key(key) {
                errors.push(format!(
                    "{name}: build.{key} ersetzt den Compiler (und damit Clippy) – verboten"
                ));
            }
        }
    }
    // rustflags/rustdocflags in [build] und [target.*]
    let mut flag_lists: Vec<(&str, &toml::Value)> = Vec::new();
    if let Some(build) = get_table(&table, &["build"]) {
        for key in ["rustflags", "rustdocflags"] {
            if let Some(value) = build.get(key) {
                flag_lists.push((key, value));
            }
        }
    }
    if let Some(targets) = get_table(&table, &["target"]) {
        for target in targets.values().filter_map(toml::Value::as_table) {
            for key in ["rustflags", "rustdocflags"] {
                if let Some(value) = target.get(key) {
                    flag_lists.push((key, value));
                }
            }
        }
    }
    for (key, value) in flag_lists {
        let flags: Vec<String> = match value {
            toml::Value::String(s) => s.split_whitespace().map(str::to_owned).collect(),
            toml::Value::Array(items) => items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect(),
            _ => Vec::new(),
        };
        for flag in &flags {
            if flag.starts_with("-A")
                || flag.starts_with("--allow")
                || flag.starts_with("--cap-lints")
                || flag.starts_with("--force-warn")
                || flag.contains("crate-attr")
            {
                errors.push(format!(
                    "{name}: {key} enthält „{flag}“ – Lints dürfen hier nicht abgeschwächt werden"
                ));
            }
        }
    }
    if let Some(aliases) = get_table(&table, &["alias"]) {
        for key in aliases.keys() {
            if matches!(key.as_str(), "clippy" | "check" | "test" | "build" | "fmt") {
                errors.push(format!(
                    "{name}: [alias] {key} würde den Prüfbefehl umlenken – verboten"
                ));
            }
        }
    }
    errors
}

/// Fehler in einem CI-Workflow: Clippy darf dort nicht umkonfiguriert werden.
fn check_workflow(name: &str, text: &str) -> Vec<String> {
    [
        "CLIPPY_CONF_DIR",
        "cap-lints",
        "disallowed_method",
        "disallowed-method",
        "-A clippy::",
        "-Aclippy::",
        "-A warnings",
        "-Awarnings",
        "--force-warn",
    ]
    .iter()
    .filter(|needle| text.contains(**needle))
    .map(|needle| format!("{name}: „{needle}“ würde Clippy oder die Sperrliste aushebeln"))
    .collect()
}

// ---------------------------------------------------------------------------------------
// Workspace laut Cargo (`cargo metadata`)
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Dependency {
    /// Paketname (auch bei Umbenennung).
    name: String,
    /// Name im Manifest, falls umbenannt (`core = { package = "aegis-core" }`).
    rename: Option<String>,
    /// `None` = normal, sonst `dev`/`build`.
    kind: Option<String>,
    features: Vec<String>,
}

#[derive(Debug, Clone)]
struct TargetInfo {
    kinds: Vec<String>,
    src_path: PathBuf,
}

#[derive(Debug, Clone)]
struct Package {
    name: String,
    manifest_path: PathBuf,
    dependencies: Vec<Dependency>,
    features: BTreeMap<String, Vec<String>>,
    targets: Vec<TargetInfo>,
}

impl Package {
    fn dir(&self) -> &Path {
        self.manifest_path.parent().unwrap()
    }
}

/// Führt `cargo` aus – nur `metadata` (liest Manifeste) und `check` (baut in einen eigenen
/// Ordner). Umgebungsvariablen für Abdeckung/Wrapper werden entfernt, damit der innere
/// Aufruf genau das prüft, was ein normaler Build sieht.
fn run_cargo(dir: &Path, args: &[&str]) -> Output {
    assert!(
        matches!(args.first(), Some(&("metadata" | "check"))),
        "nur cargo metadata/check"
    );
    let mut command = Command::new(option_env!("CARGO").unwrap_or("cargo"));
    command.current_dir(dir).args(args);
    for var in [
        "RUSTFLAGS",
        "CARGO_ENCODED_RUSTFLAGS",
        "CARGO_BUILD_RUSTFLAGS",
        "RUSTDOCFLAGS",
        "CARGO_ENCODED_RUSTDOCFLAGS",
        "RUSTC_WRAPPER",
        "RUSTC_WORKSPACE_WRAPPER",
        "CARGO_BUILD_RUSTC_WRAPPER",
        "CARGO_TARGET_DIR",
        "CARGO_BUILD_TARGET_DIR",
        "LLVM_PROFILE_FILE",
        "CARGO_LLVM_COV",
        "CARGO_LLVM_COV_TARGET_DIR",
        "CARGO_INCREMENTAL",
    ] {
        command.env_remove(var);
    }
    // aegis-mutation: guard-runs-cargo
    #[allow(clippy::disallowed_methods)]
    let output = command.output();
    output.expect("cargo lässt sich nicht starten")
}

fn string_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Liest die Workspace-Mitglieder so, wie Cargo sie versteht (`cargo metadata --no-deps`:
/// nur Manifeste, keine Auflösung, kein Netz).
fn load_packages(workspace: &Path) -> Vec<Package> {
    let output = run_cargo(
        workspace,
        &[
            "metadata",
            "--no-deps",
            "--format-version",
            "1",
            "--offline",
            "--manifest-path",
            workspace.join("Cargo.toml").to_str().unwrap(),
        ],
    );
    assert!(
        output.status.success(),
        "cargo metadata fehlgeschlagen:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let metadata: Value = serde_json::from_slice(&output.stdout).unwrap();
    metadata["packages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| Package {
            name: p["name"].as_str().unwrap().to_owned(),
            manifest_path: PathBuf::from(p["manifest_path"].as_str().unwrap()),
            dependencies: p["dependencies"]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| Dependency {
                    name: d["name"].as_str().unwrap().to_owned(),
                    rename: d["rename"].as_str().map(str::to_owned),
                    kind: d["kind"].as_str().map(str::to_owned),
                    features: string_list(&d["features"]),
                })
                .collect(),
            features: p["features"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), string_list(v)))
                .collect(),
            targets: p["targets"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| TargetInfo {
                    kinds: string_list(&t["kind"]),
                    src_path: PathBuf::from(t["src_path"].as_str().unwrap()),
                })
                .collect(),
        })
        .collect()
}

/// Schaltet ein Mitglied das Test-Feature `testing` von `aegis-core` außerhalb von
/// `dev-dependencies` ein (direkt, über `[features]`, mit Umbenennung, als `?/testing`,
/// oder `aegis-core` selbst per `default`)? Dann gäbe es `ManualClock`, die Fixture-Helfer
/// und simulierte Nutzerantworten auch im Produktivcode.
fn testing_feature_leaks(packages: &[Package]) -> Vec<String> {
    let mut errors = Vec::new();
    for package in packages {
        let mut aliases: BTreeSet<String> = BTreeSet::new();
        for dep in package
            .dependencies
            .iter()
            .filter(|d| d.name == "aegis-core")
        {
            aliases.insert(dep.rename.clone().unwrap_or_else(|| dep.name.clone()));
            if dep.kind.as_deref() != Some("dev") && dep.features.iter().any(|f| f == "testing") {
                errors.push(format!(
                    "{}: Feature „testing“ von aegis-core nur in [dev-dependencies] erlaubt (hier: {})",
                    package.name,
                    match dep.kind.as_deref() {
                        Some("build") => "[build-dependencies]",
                        _ => "[dependencies]",
                    }
                ));
            }
        }
        aliases.insert("aegis-core".to_owned());
        for (feature, values) in &package.features {
            for value in values {
                let value = value.strip_prefix("dep:").unwrap_or(value);
                let Some((dep, feat)) = value.split_once('/') else {
                    continue;
                };
                let dep = dep.trim_end_matches('?');
                if feat == "testing" && aliases.contains(dep) {
                    errors.push(format!(
                        "{}: Feature „{feature}“ schaltet „{value}“ ein – „testing“ nur in [dev-dependencies]",
                        package.name
                    ));
                }
            }
        }
        if package.name == "aegis-core" {
            // Das eigene `default` darf `testing` nicht (auch nicht über Umwege) enthalten.
            let mut open = vec!["default".to_owned()];
            let mut seen = BTreeSet::new();
            while let Some(feature) = open.pop() {
                if !seen.insert(feature.clone()) {
                    continue;
                }
                if feature == "testing" {
                    errors
                        .push("aegis-core: `default` schaltet „testing“ ein – verboten".to_owned());
                    break;
                }
                for value in package.features.get(&feature).into_iter().flatten() {
                    if !value.contains('/') && !value.starts_with("dep:") {
                        open.push(value.clone());
                    }
                }
            }
        }
    }
    errors
}

/// Direkte Abhängigkeiten von Crates mit verändernden APIs, für die `clippy.toml` nichts sperrt.
fn unguarded_mutation_crates(packages: &[Package], clippy_toml: &str) -> Vec<String> {
    let mut errors = Vec::new();
    for package in packages {
        for dep in &package.dependencies {
            if !MUTATION_CAPABLE_CRATES.contains(&dep.name.as_str()) {
                continue;
            }
            let prefix = format!("\"{}::", dep.name.replace('-', "_"));
            if !clippy_toml.contains(&prefix) {
                errors.push(format!(
                    "{}: hängt von „{}“ ab (verändernde APIs), aber clippy.toml sperrt keine seiner \
                     Funktionen – erst die Sperren ergänzen",
                    package.name, dep.name
                ));
            }
        }
    }
    errors
}

// ---------------------------------------------------------------------------------------
// Dateien im geprüften Bereich
// ---------------------------------------------------------------------------------------

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

/// `target/` und `node_modules/` werden nur direkt in einem Projektordner (mit
/// `Cargo.toml` oder `package.json`) übersprungen – ein Modul `src/target/` wird geprüft.
fn is_skipped_dir(path: &Path) -> bool {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    if name == ".git" {
        return true;
    }
    if name == "target" || name == "node_modules" {
        let parent = path.parent().unwrap_or(path);
        return parent.join("Cargo.toml").is_file() || parent.join("package.json").is_file();
    }
    false
}

fn walk(dir: &Path, files: &mut BTreeSet<PathBuf>, errors: &mut Vec<String>, root: &Path) {
    let mut entries: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap()).collect();
    entries.sort_by_key(fs::DirEntry::path);
    for entry in entries {
        let path = entry.path();
        let file_type = entry.file_type().unwrap();
        if file_type.is_symlink() {
            errors.push(format!(
                "{}: symbolischer Link im Quellbaum – der Wächter folgt keinen Links, verboten",
                relative(root, &path)
            ));
        } else if file_type.is_dir() {
            if !is_skipped_dir(&path) {
                walk(&path, files, errors, root);
            }
        } else if file_type.is_file() {
            files.insert(path);
        }
    }
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Alle Dateien im geprüften Bereich: `crates/**`, `apps/*/src-tauri/**` und jedes
/// Workspace-Mitglied (auch außerhalb von `crates/`, auch in versteckten Ordnern).
fn scanned_files(root: &Path, packages: &[Package], errors: &mut Vec<String>) -> Vec<PathBuf> {
    let mut files = BTreeSet::new();
    let mut dirs: BTreeSet<PathBuf> = BTreeSet::new();
    dirs.insert(root.join("crates"));
    for app in fs::read_dir(root.join("apps")).into_iter().flatten() {
        let tauri = app.unwrap().path().join("src-tauri");
        if tauri.is_dir() {
            dirs.insert(tauri);
        }
    }
    for package in packages {
        dirs.insert(package.dir().to_path_buf());
    }
    for dir in &dirs {
        walk(dir, &mut files, errors, root);
    }
    files.into_iter().collect()
}

/// Ordner zwischen einem Mitglied und der Wurzel (ohne Wurzel), in denen Clippy bzw. Cargo
/// zusätzliche Konfiguration finden würde.
fn ancestors_below_root(root: &Path, dir: &Path) -> Vec<PathBuf> {
    dir.ancestors()
        .take_while(|d| *d != root && d.starts_with(root))
        .map(Path::to_path_buf)
        .collect()
}

fn check_workspace(root: &Path) -> Vec<String> {
    let mut errors = Vec::new();
    let packages = load_packages(root);
    let (allowlist, list_errors) =
        parse_allowlist(&fs::read_to_string(root.join(ALLOWLIST)).unwrap());
    errors.extend(list_errors);

    let files = scanned_files(root, &packages, &mut errors);
    let scanned: BTreeSet<&PathBuf> = files.iter().collect();
    let mut used = BTreeSet::new();
    let mut rust_files = 0;
    for path in &files {
        let rel = relative(root, path);
        let name = path.file_name().unwrap().to_string_lossy();
        if name == "clippy.toml" || name == ".clippy.toml" {
            errors.push(format!(
                "{rel}: zusätzliche clippy.toml würde die Sperrliste der Wurzel ersetzen – verboten"
            ));
        }
        let in_cargo_dir = path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|n| n == ".cargo");
        if in_cargo_dir && (name == "config.toml" || name == "config") {
            errors.extend(check_cargo_config(&rel, &fs::read_to_string(path).unwrap()));
        }
        if name == "Cargo.toml" {
            let text = fs::read_to_string(path).unwrap();
            if text.contains("disallowed_methods") || text.contains("disallowed-methods") {
                errors.push(format!(
                    "{rel}: disallowed_methods darf nicht umkonfiguriert werden"
                ));
            }
            if text.contains("[package]") && !manifest_inherits_lints(&text) {
                errors.push(format!("{rel}: `[lints] workspace = true` fehlt"));
            }
        }
        if name == "build.rs" {
            let text = fs::read_to_string(path).unwrap();
            let lower = text.to_ascii_lowercase();
            if lower.contains("clippy") || text.contains("RUSTC_WORKSPACE_WRAPPER") {
                errors.push(format!(
                    "{rel}: Build-Skript erkennt Clippy – Code, der nur ohne Clippy gebaut wird, ist verboten"
                ));
            }
        }
        if path.extension().is_some_and(|ext| ext == "rs") {
            rust_files += 1;
            let src = fs::read_to_string(path).unwrap();
            let scan = scan_source(&src);
            errors.extend(scan.errors.iter().map(|e| format!("{rel}: {e}")));
            for suppression in scan.suppressions {
                match suppression.marker {
                    None => errors.push(format!(
                        "{rel}:{}: Unterdrückung eines bewachten Lints ohne Markierung \
                         „// aegis-mutation: <kennung>“ (bzw. aegis-consent/aegis-unsafe) direkt darüber",
                        suppression.line
                    )),
                    Some(id) => {
                        let key = (rel.clone(), id);
                        if !allowlist.contains_key(&key) {
                            errors.push(format!(
                                "{rel}:{}: Markierung „{}“ fehlt in {ALLOWLIST}",
                                suppression.line, key.1
                            ));
                        }
                        used.insert(key);
                    }
                }
            }
        }
    }
    assert!(
        rust_files > 10,
        "Scanner hat zu wenige Rust-Dateien gefunden ({rust_files})"
    );

    for (path, id) in allowlist.keys() {
        if !used.contains(&(path.clone(), id.clone())) {
            errors.push(format!(
                "{ALLOWLIST}: veralteter Eintrag „{path} :: {id}“ – keine passende Ausnahme im Code"
            ));
        }
    }

    // Mitglieder: Ziele nur aus dem eigenen, geprüften Ordner; Lints geerbt; Bibliotheken
    // unter crates/ verbieten unsafe; keine Konfiguration zwischen Mitglied und Wurzel.
    for package in &packages {
        let dir = package.dir();
        for target in &package.targets {
            let src = &target.src_path;
            if !src.starts_with(dir) || !scanned.contains(src) {
                errors.push(format!(
                    "{}: Ziel {} liegt außerhalb des geprüften Paketordners",
                    package.name,
                    src.display()
                ));
            }
            let is_lib = target.kinds.iter().any(|k| {
                matches!(
                    k.as_str(),
                    "lib" | "rlib" | "dylib" | "cdylib" | "staticlib"
                )
            });
            if is_lib && dir.starts_with(root.join("crates")) {
                let tokens = tokenize(&lex(&fs::read_to_string(src).unwrap()).code);
                let forbids = attributes(&tokens)
                    .iter()
                    .any(|a| a.inner && a.text == "forbid(unsafe_code)");
                if !forbids {
                    errors.push(format!(
                        "{}: {} braucht `#![forbid(unsafe_code)]`",
                        package.name,
                        relative(root, src)
                    ));
                }
            }
        }
        if !manifest_inherits_lints(&fs::read_to_string(&package.manifest_path).unwrap()) {
            errors.push(format!(
                "{}: `[lints] workspace = true` fehlt",
                package.name
            ));
        }
        for ancestor in ancestors_below_root(root, dir) {
            for name in ["clippy.toml", ".clippy.toml"] {
                if ancestor.join(name).exists() {
                    errors.push(format!(
                        "{}: {name} würde für {} die Sperrliste der Wurzel ersetzen – verboten",
                        relative(root, &ancestor),
                        package.name
                    ));
                }
            }
            for name in [".cargo/config.toml", ".cargo/config"] {
                let config = ancestor.join(name);
                if let Ok(text) = fs::read_to_string(&config)
                    && !scanned.contains(&config)
                {
                    errors.extend(check_cargo_config(&relative(root, &config), &text));
                }
            }
        }
    }
    errors.extend(testing_feature_leaks(&packages));

    let clippy_toml = fs::read_to_string(root.join("clippy.toml"));
    match &clippy_toml {
        Ok(text) => {
            errors.extend(check_clippy_toml(text));
            errors.extend(unguarded_mutation_crates(&packages, text));
        }
        Err(err) => errors.push(format!("clippy.toml fehlt in der Wurzel: {err}")),
    }
    if root.join(".clippy.toml").exists() {
        errors.push(".clippy.toml in der Wurzel würde clippy.toml ersetzen – verboten".to_owned());
    }
    if let Some(dir) = std::env::var_os("CLIPPY_CONF_DIR") {
        errors.push(format!(
            "Umgebung: CLIPPY_CONF_DIR={} würde Clippy eine andere Sperrliste geben – verboten",
            Path::new(&dir).display()
        ));
    }
    errors.extend(check_root_manifest(
        &fs::read_to_string(root.join("Cargo.toml")).unwrap(),
    ));
    for config in [".cargo/config.toml", ".cargo/config"] {
        if let Ok(text) = fs::read_to_string(root.join(config)) {
            errors.extend(check_cargo_config(config, &text));
        }
    }
    if let Ok(workflows) = fs::read_dir(root.join(".github/workflows")) {
        for workflow in workflows {
            let path = workflow.unwrap().path();
            if path
                .extension()
                .is_some_and(|ext| ext == "yml" || ext == "yaml")
            {
                errors.extend(check_workflow(
                    &relative(root, &path),
                    &fs::read_to_string(&path).unwrap(),
                ));
            }
        }
    }
    errors
}

// ---------------------------------------------------------------------------------------
// Der eigentliche Wächter
// ---------------------------------------------------------------------------------------

#[test]
fn workspace_respects_mutation_allowlist() {
    let errors = check_workspace(&workspace_root());
    assert!(
        errors.is_empty(),
        "Verstöße gegen die Mutations-Sperre (siehe {ALLOWLIST}):\n  - {}",
        errors.join("\n  - ")
    );
}

#[test]
fn allowlist_is_not_empty_and_points_to_existing_files() {
    let root = workspace_root();
    let (entries, errors) = parse_allowlist(&fs::read_to_string(root.join(ALLOWLIST)).unwrap());
    assert!(errors.is_empty(), "{errors:?}");
    assert!(!entries.is_empty());
    for (path, _) in entries.keys() {
        assert!(root.join(path).is_file(), "{path} existiert nicht");
    }
}

/// Produktiv-Ziele müssen ohne Dev-Abhängigkeiten bauen: `cargo clippy --all-targets` und
/// `cargo test` schalten über die Dev-Abhängigkeit `aegis-core[testing]` das Feature für den
/// ganzen Build ein (Feature-Vereinigung) – ein Aufruf von `aegis_core::testing` im
/// Produktivcode fiele dort nicht auf. Hier wird ohne Test-Ziele gebaut (eigener Ordner,
/// ohne die Desktop-App, die der Tauri-Build ohnehin ohne Dev-Features baut).
#[test]
fn production_targets_build_without_test_features() {
    let root = workspace_root();
    let target_dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("aegis-no-dev-check");
    let output = run_cargo(
        &root,
        &[
            "check",
            "--workspace",
            "--exclude",
            "aegis-desktop",
            "--lib",
            "--bins",
            "--locked",
            "--quiet",
            "--message-format",
            "short",
            "--target-dir",
            target_dir.to_str().unwrap(),
        ],
    );
    assert!(
        output.status.success(),
        "Produktivcode baut nicht ohne Test-Features (nutzt er aegis_core::testing?):\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

// ---------------------------------------------------------------------------------------
// Tests der Scanner-Logik an synthetischen Eingaben
// ---------------------------------------------------------------------------------------

fn suppressions(src: &str) -> Vec<Suppression> {
    let scan = scan_source(src);
    assert!(
        scan.errors.is_empty(),
        "unerwartete Fehler: {:?}",
        scan.errors
    );
    scan.suppressions
}

fn marked(line: usize, id: &str) -> Suppression {
    Suppression {
        line,
        marker: Some(id.to_owned()),
    }
}

fn unmarked(line: usize) -> Suppression {
    Suppression { line, marker: None }
}

/// Fehlertexte eines Scans, die `needle` enthalten.
fn errors_with(src: &str, needle: &str) -> usize {
    scan_source(src)
        .errors
        .iter()
        .filter(|e| e.contains(needle))
        .count()
}

#[test]
fn scanner_finds_unmarked_allow() {
    let src =
        "fn f() {\n    #[allow(clippy::disallowed_methods)]\n    std::fs::remove_file(\"x\");\n}\n";
    assert_eq!(suppressions(src), vec![unmarked(2)]);
}

#[test]
fn scanner_accepts_marker_above_or_trailing() {
    let src = "fn f() {\n    // aegis-mutation: delete-one\n    #[allow(clippy::disallowed_methods)]\n    x();\n    #[allow(clippy::disallowed_methods)] // aegis-mutation: trailing-two\n    y();\n    // aegis-consent: pipe-answer\n    #[allow(clippy::disallowed_methods)]\n    gate.decide();\n}\n";
    assert_eq!(
        suppressions(src),
        vec![
            marked(3, "delete-one"),
            marked(5, "trailing-two"),
            marked(8, "pipe-answer")
        ]
    );
}

#[test]
fn scanner_requires_marker_directly_above() {
    let gap = "// aegis-mutation: weit-weg\n\n#[allow(clippy::disallowed_methods)]\nfn f() {}\n";
    let scan = scan_source(gap);
    assert_eq!(scan.suppressions, vec![unmarked(3)]);
    assert!(
        scan.errors
            .iter()
            .any(|e| e.contains("verwaist") || e.contains("ungültige"))
    );

    let other_attr =
        "// aegis-mutation: abc\n#[cfg(test)]\n#[allow(clippy::disallowed_methods)]\nfn f() {}\n";
    let scan = scan_source(other_attr);
    assert_eq!(scan.suppressions, vec![unmarked(3)]);
    assert_eq!(scan.errors.len(), 1, "{:?}", scan.errors);
}

#[test]
fn scanner_handles_attribute_variants() {
    let src = r#"
fn z() {}
#[allow(
    dead_code,
    clippy::disallowed_methods
)]
fn a() {}
#[cfg_attr(test, allow(clippy::disallowed_methods))]
fn b() {}
#[expect(clippy::disallowed_methods, reason = "nur im Test")]
fn c() {}
#[allow(clippy::all)]
fn d() {}
#[allow(clippy::style)]
fn e() {}
#[allow(warnings)]
fn f() {}
#[allow(clippy::disallowed_method)]
fn g() {}
#[allow(clippy :: disallowed_methods)]
fn h() {}
# [ allow ( clippy::disallowed_methods ) ]
fn i() {}
"#;
    let lines: Vec<usize> = suppressions(src).iter().map(|s| s.line).collect();
    assert_eq!(lines, vec![3, 8, 10, 12, 14, 16, 18, 20, 22]);

    // Ein inneres Attribut wird gefunden – und ist als Modul-Ausnahme verboten.
    let inner = "#![allow(clippy::disallowed_methods)]\nfn a() {}\n";
    let scan = scan_source(inner);
    assert_eq!(scan.suppressions, vec![unmarked(1)]);
    assert!(scan.errors.iter().any(|e| e.contains("inneres Attribut")));
}

#[test]
fn scanner_ignores_unrelated_attributes() {
    let src = r#"
#[allow(clippy::too_many_arguments)]
#[deny(clippy::disallowed_methods)]
#[warn(warnings)]
#[forbid(clippy::all)]
#[should_panic(expected = "allow(clippy::disallowed_methods)")]
#[my_allow(clippy::disallowed_methods)]
#[allow(clippy::all_the_things)]
fn f() {}
"#;
    assert_eq!(suppressions(src), vec![]);
}

#[test]
fn scanner_ignores_strings_comments_and_docs() {
    let src = r####"
/// Beispiel: #[allow(clippy::disallowed_methods)]
//! #[allow(clippy::disallowed_methods)]
// #[allow(clippy::disallowed_methods)]
/* #[allow(clippy::disallowed_methods)] /* verschachtelt */ #[allow(warnings)] */
fn f() {
    let a = "#[allow(clippy::disallowed_methods)]";
    let b = r#"#[allow(clippy::disallowed_methods)] "noch im String" "#;
    let c = r##"// aegis-mutation: im-string
#[allow(clippy::disallowed_methods)]"##;
    let d = b"#[allow(warnings)]";
    let e = br#"#[allow(warnings)]"#;
    let f = '"';
    let g = '\'';
    let h = "escaped \" #[allow(warnings)]";
    let i: &'static str = "x";
    let j = 'ä';
    let k = '\u{1F600}';
}
"####;
    assert_eq!(suppressions(src), vec![]);
}

#[test]
fn scanner_sees_code_after_tricky_literals() {
    // Nach Literal/Lebensdauer geht der Code weiter – die echte Ausnahme muss gefunden werden.
    let src = "fn f<'a>(x: &'a str) -> char {\n    let _q = '\"';\n    let _s = \"a\\\"b\";\n    #[allow(clippy::disallowed_methods)]\n    g();\n    'x'\n}\n";
    assert_eq!(suppressions(src), vec![unmarked(4)]);
}

#[test]
fn scanner_reports_orphan_invalid_and_duplicate_markers() {
    let orphan = "// aegis-mutation: allein\nfn f() {}\n";
    let scan = scan_source(orphan);
    assert!(scan.suppressions.is_empty());
    assert_eq!(scan.errors.len(), 1);
    assert!(scan.errors[0].contains("verwaist"));

    let invalid =
        "// aegis-mutation: Groß_Buchstaben\n#[allow(clippy::disallowed_methods)]\nfn f() {}\n";
    let scan = scan_source(invalid);
    assert_eq!(scan.suppressions, vec![unmarked(2)]);
    assert!(
        scan.errors
            .iter()
            .any(|e| e.contains("ungültige Markierung"))
    );

    let extra_words =
        "// aegis-mutation: id mit text\n#[allow(clippy::disallowed_methods)]\nfn f() {}\n";
    assert_eq!(scan_source(extra_words).suppressions, vec![unmarked(2)]);

    let duplicate = "// aegis-mutation: gleich\n#[allow(clippy::disallowed_methods)]\nfn f() {}\n// aegis-mutation: gleich\n#[allow(clippy::disallowed_methods)]\nfn g() {}\n";
    let scan = scan_source(duplicate);
    assert_eq!(
        scan.suppressions,
        vec![marked(2, "gleich"), marked(5, "gleich")]
    );
    assert!(scan.errors.iter().any(|e| e.contains("doppelt")));

    // Doku-Kommentare sind keine Markierungen.
    let doc = "/// aegis-mutation: doku\n#[allow(clippy::disallowed_methods)]\nfn f() {}\n";
    assert_eq!(scan_source(doc).suppressions, vec![unmarked(2)]);
}

#[test]
fn marker_ids_are_validated() {
    for ok in ["a", "quarantine-move", "x1-y2-z3"] {
        assert!(is_valid_marker_id(ok), "{ok}");
    }
    for bad in ["", "-a", "a-", "a--b", "A", "a_b", "a b", "ä"] {
        assert!(!is_valid_marker_id(bad), "{bad}");
    }
}

#[test]
fn allowlist_parser() {
    let text = "\
# Kommentar

crates/x/src/lib.rs :: write-log :: Schreibt nur das AEGIS-eigene Prüfprotokoll.
crates/x/src/lib.rs :: kurz :: zu kurz
crates/x/src/lib.rs :: write-log :: Schreibt nur das AEGIS-eigene Prüfprotokoll.
/abs/pfad.rs :: a :: Begründung lang genug für den Test hier.
crates\\x\\lib.rs :: a :: Begründung lang genug für den Test hier.
crates/../x.rs :: a :: Begründung lang genug für den Test hier.
crates/x/Cargo.toml :: a :: Begründung lang genug für den Test hier.
crates/x/src/lib.rs :: Ungültig :: Begründung lang genug für den Test hier.
nur-ein-teil
crates/x/src/lib.rs :: mit-doppelpunkt :: Begründung :: mit Trenner im Text ist erlaubt.
";
    let (entries, errors) = parse_allowlist(text);
    assert_eq!(
        entries.keys().cloned().collect::<Vec<_>>(),
        vec![
            (
                "crates/x/src/lib.rs".to_owned(),
                "mit-doppelpunkt".to_owned()
            ),
            ("crates/x/src/lib.rs".to_owned(), "write-log".to_owned()),
        ]
    );
    assert_eq!(errors.len(), 8, "{errors:#?}");
    assert!(errors[0].contains(":4:") && errors[0].contains("zu kurz"));
    assert!(errors[1].contains(":5:") && errors[1].contains("doppelt"));
    assert!(
        errors
            .iter()
            .any(|e| e.contains(":11:") && e.contains("erwartet"))
    );
}

/// Eine gültige clippy.toml mit allen Pflicht-Sperren (plattformabhängige mit `allow-invalid`).
fn full_clippy_toml() -> String {
    let entries: String = REQUIRED_DISALLOWED
        .iter()
        .map(|p| {
            let invalid = if p.starts_with("std::os::") {
                ", allow-invalid = true"
            } else {
                ""
            };
            format!("  {{ path = \"{p}\", reason = \"Grund\"{invalid} }},\n")
        })
        .collect();
    format!("disallowed-methods = [\n{entries}]\n")
}

#[test]
fn manifest_and_config_checks() {
    assert!(manifest_inherits_lints(
        "[package]\nname = \"x\"\n\n[lints]\nworkspace = true\n"
    ));
    assert!(manifest_inherits_lints(
        "[lints]\nworkspace=true\n[dependencies]\n"
    ));
    assert!(manifest_inherits_lints("lints.workspace = true\n"));
    assert!(!manifest_inherits_lints(
        "[package]\nname = \"x\"\n[dependencies]\nworkspace = true\n"
    ));
    assert!(!manifest_inherits_lints(
        "[lints.clippy]\nall = \"allow\"\n"
    ));
    assert!(!manifest_inherits_lints(
        "[lints]\n# workspace = true\nworkspace = false\n"
    ));

    let full = full_clippy_toml();
    assert!(
        check_clippy_toml(&full).is_empty(),
        "{:?}",
        check_clippy_toml(&full)
    );
    let missing = full.replace("std::fs::remove_file\"", "std::fs::remove_filex\"");
    assert!(
        check_clippy_toml(&missing)
            .iter()
            .any(|e| e.contains("std::fs::remove_file"))
    );
    let no_reason = full.replace("]\n", "  { path = \"std::x\" },\n]\n");
    assert!(
        check_clippy_toml(&no_reason)
            .iter()
            .any(|e| e.contains("reason"))
    );

    let root_ok = "[workspace.lints.rust]\nunsafe_code = \"deny\"\n[workspace.lints.clippy]\nall = { level = \"warn\", priority = -1 }\n";
    assert!(
        check_root_manifest(root_ok).is_empty(),
        "{:?}",
        check_root_manifest(root_ok)
    );
    assert_eq!(
        check_root_manifest("[workspace.lints.rust]\nunsafe_code = \"deny\"\n[workspace.lints.clippy]\nall = { level = \"allow\", priority = -1 }\nstyle = \"allow\"\n").len(),
        2
    );
    assert_eq!(
        check_root_manifest("[workspace.lints.rust]\nunsafe_code = \"deny\"\n[workspace.lints.clippy]\ndisallowed_methods = \"allow\"\n").len(),
        2
    );
    // `all` außerhalb der Clippy-Sektion ist egal.
    assert!(
        check_root_manifest(
            "[features]\nall = \"allow\"\n[workspace.lints.rust]\nunsafe_code = \"forbid\"\n"
        )
        .is_empty()
    );
}

// ---------------------------------------------------------------------------------------
// Test-Feature: geprüft mit echtem `cargo metadata` an Wegwerf-Workspaces
// ---------------------------------------------------------------------------------------

/// Wegwerf-Workspace mit `aegis-core` (Feature `testing`) und einem Mitglied `probe`.
fn fake_workspace(root_extra: &str, core_features: &str, probe_body: &str) -> tempfile::TempDir {
    use aegis_core::testing::write_fixture;
    let dir = tempfile::tempdir().unwrap();
    let root = format!(
        "[workspace]\nresolver = \"3\"\nmembers = [\"core\", \"probe\"]\n\n[workspace.dependencies]\naegis-core = {{ path = \"core\" }}\n{root_extra}\n"
    );
    write_fixture(dir.path(), "Cargo.toml", root.as_bytes()).unwrap();
    let core = format!(
        "[package]\nname = \"aegis-core\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[features]\ntesting = []\n{core_features}\n"
    );
    write_fixture(dir.path(), "core/Cargo.toml", core.as_bytes()).unwrap();
    write_fixture(dir.path(), "core/src/lib.rs", b"").unwrap();
    let probe = format!(
        "[package]\nname = \"probe\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n{probe_body}\n"
    );
    write_fixture(dir.path(), "probe/Cargo.toml", probe.as_bytes()).unwrap();
    write_fixture(dir.path(), "probe/src/lib.rs", b"").unwrap();
    dir
}

fn leaks(root_extra: &str, core_features: &str, probe_body: &str) -> Vec<String> {
    let dir = fake_workspace(root_extra, core_features, probe_body);
    let mut errors = testing_feature_leaks(&load_packages(dir.path()));
    errors.extend(
        check_root_manifest(&fs::read_to_string(dir.path().join("Cargo.toml")).unwrap())
            .into_iter()
            .filter(|e| e.contains("testing")),
    );
    errors
}

#[test]
fn testing_feature_must_stay_in_dev_dependencies() {
    for ok in [
        "[dependencies]\naegis-core = { workspace = true }\n\n[dev-dependencies]\naegis-core = { workspace = true, features = [\"testing\"] }\n",
        "[target.'cfg(windows)'.dev-dependencies]\naegis-core = { workspace = true, features = [\"testing\"] }\n",
        "[dev-dependencies]\ncore = { package = \"aegis-core\", path = \"../core\", features = ['testing'] }\n",
        // Ein eigenes Feature, das nur ein anderes Feature von aegis-core nennt.
        "[dependencies]\naegis-core = { workspace = true }\n[features]\nx = []\n",
    ] {
        assert_eq!(leaks("", "", ok), Vec::<String>::new(), "{ok}");
    }
    let leaking: &[(&str, &str, &str)] = &[
        // Die Formen der ersten Fassung …
        (
            "",
            "",
            "[dependencies]\naegis-core = { workspace = true, features = [\"testing\"] }\n",
        ),
        (
            "",
            "",
            "[build-dependencies]\naegis-core = { path = \"../core\", features = [\"testing\"] }\n",
        ),
        (
            "",
            "",
            "[target.'cfg(windows)'.dependencies]\naegis-core = { workspace = true, features = [\"testing\"] }\n",
        ),
        (
            "",
            "",
            "[dependencies.aegis-core]\nworkspace = true\nfeatures = [\"testing\"]\n",
        ),
        // … und alle, die die Textsuche übersah:
        (
            "",
            "",
            "[features]\ndefault = [\"aegis-core/testing\"]\n\n[dependencies]\naegis-core = { workspace = true }\n",
        ),
        (
            "",
            "",
            "[dependencies]\naegis-core = { workspace = true, features = ['testing'] }\n",
        ),
        (
            "",
            "",
            "[dependencies] # Kommentar\naegis-core = { workspace = true, features = [\"testing\"] }\n",
        ),
        (
            "",
            "",
            "[dependencies]\ncore = { package = \"aegis-core\", path = \"../core\", features = [\"testing\"] }\n",
        ),
        (
            "",
            "",
            "[dependencies]\naegis-core = { workspace = true, features = [\n    \"testing\",\n] }\n",
        ),
        (
            "",
            "",
            "[dependencies.core]\npackage = \"aegis-core\"\npath = \"../core\"\nfeatures = [\"testing\"]\n",
        ),
        (
            "",
            "",
            "[dependencies.\"aegis-core\"]\nworkspace = true\nfeatures = [\"testing\"]\n",
        ),
        (
            "",
            "",
            "[features]\nextra = [\"aegis-core?/testing\"]\n\n[dependencies]\naegis-core = { workspace = true, optional = true }\n",
        ),
        (
            "",
            "",
            "[features]\ndefault = [\"core/testing\"]\n\n[dependencies]\ncore = { package = \"aegis-core\", path = \"../core\" }\n",
        ),
        // aegis-core selbst schaltet es per default ein (auch über einen Umweg).
        (
            "",
            "default = [\"umweg\"]\numweg = [\"testing\"]\n",
            "[dependencies]\naegis-core = { workspace = true }\n",
        ),
    ];
    for (root_extra, core_features, probe) in leaking {
        assert!(
            !leaks(root_extra, core_features, probe).is_empty(),
            "nicht erkannt:\n{core_features}\n{probe}"
        );
    }
    // Feature im Workspace-Eintrag: in jedem Mitglied, das ihn normal nutzt – und schon im
    // Wurzel-Manifest.
    let workspace_leak = "[dependencies]\naegis-core = { workspace = true }\n";
    let dir = fake_workspace("", "", workspace_leak);
    let root_text = fs::read_to_string(dir.path().join("Cargo.toml"))
        .unwrap()
        .replace(
            "aegis-core = { path = \"core\" }",
            "aegis-core = { path = \"core\", features = [\"testing\"] }",
        );
    aegis_core::testing::write_fixture(dir.path(), "Cargo.toml", root_text.as_bytes()).unwrap();
    assert!(!testing_feature_leaks(&load_packages(dir.path())).is_empty());
    assert!(
        check_root_manifest(&root_text)
            .iter()
            .any(|e| e.contains("testing"))
    );
}

// ---------------------------------------------------------------------------------------
// Regressionen aus dem Security-Review (Umgehungen der ersten Fassung)
// ---------------------------------------------------------------------------------------

#[test]
fn cfg_clippy_predicates_are_rejected() {
    for src in [
        "fn f() {\n    #[cfg(not(clippy))]\n    { let _ = std::fs::remove_file(\"x\"); }\n}\n",
        "#[cfg(clippy)]\nfn f() {}\n",
        "#[cfg_attr(clippy, allow(dead_code))]\nfn f() {}\n",
        "fn f() -> bool { cfg!(clippy) }\n",
        "#[cfg(not(r#clippy))]\nfn f() {}\n",
    ] {
        assert!(errors_with(src, "cfg-Prädikat") > 0, "{src}");
    }
    // `clippy::…`-Pfade sind normal.
    assert_eq!(
        errors_with(
            "#[allow(clippy::too_many_arguments)]\nfn f() {}\n",
            "cfg-Prädikat"
        ),
        0
    );
}

#[test]
fn raw_identifiers_and_unicode_whitespace_do_not_hide_suppressions() {
    for (src, line) in [
        ("#[allow(r#clippy::disallowed_methods)]\nfn a() {}\n", 1),
        ("#[allow(r#warnings)]\nfn b() {}\n", 1),
        ("#[r#allow(r#clippy::r#disallowed_methods)]\nfn c() {}\n", 1),
        (
            "#[rustfmt::skip]\n#[allow(clippy::\u{0b}disallowed_methods)]\nfn d() {}\n",
            2,
        ),
        (
            "#[rustfmt::skip]\n#[allow(clippy::disallowed_methods\u{2028})]\nfn e() {}\n",
            2,
        ),
        (
            "#[rustfmt::skip]\n#[allow(\u{200e}clippy::disallowed_methods)]\nfn f() {}\n",
            2,
        ),
        ("#[allow(unsafe_code)]\nfn g() {}\n", 1),
        ("#[allow(r#unsafe_code)]\nfn h() {}\n", 1),
    ] {
        assert_eq!(
            scan_source(src).suppressions,
            vec![unmarked(line)],
            "{src:?}"
        );
    }
}

#[test]
fn macro_built_lint_attributes_are_rejected() {
    let meta = "macro_rules! with_lint { ($m:meta; $i:item) => { #[$m] $i }; }\nwith_lint!(allow(clippy::disallowed_methods); pub fn c() {});\n";
    let scan = scan_source(meta);
    assert!(
        scan.errors
            .iter()
            .any(|e| e.contains("Makro-Metavariablen")),
        "{:?}",
        scan.errors
    );
    assert!(
        scan.errors
            .iter()
            .any(|e| e.contains("außerhalb eines Attributs")),
        "{:?}",
        scan.errors
    );
    let idents = "macro_rules! lint { ($a:ident $t:ident $l:ident) => { #[$a($t::$l)] fn x() {} }; }\nlint!(allow clippy disallowed_methods);\n";
    assert!(errors_with(idents, "Makro-Metavariablen") > 0);
}

#[test]
fn module_wide_suppressions_are_rejected() {
    for src in [
        "// aegis-mutation: weit\n#![allow(clippy::disallowed_methods)]\n",
        "// aegis-mutation: weit\n#[allow(clippy::disallowed_methods)]\nmod m;\n",
        "// aegis-mutation: weit\n#[allow(clippy::disallowed_methods)]\npub(crate) mod m {}\n",
        "// aegis-mutation: weit\n#[allow(clippy::disallowed_methods)]\n#[cfg(test)]\nimpl X {}\n",
        "// aegis-mutation: weit\n#[allow(clippy::disallowed_methods)]\nunsafe impl Send for X {}\n",
        "// aegis-mutation: weit\n#[allow(clippy::disallowed_methods)]\npub trait T {}\n",
    ] {
        let scan = scan_source(src);
        assert_eq!(scan.suppressions, vec![marked(2, "weit")], "{src}");
        assert!(
            scan.errors
                .iter()
                .any(|e| e.contains("inneres Attribut") || e.contains("gilt für zu viel")),
            "{src}: {:?}",
            scan.errors
        );
    }
    // Am Statement, an einer Funktion oder einem Block ist es erlaubt.
    for src in [
        "fn f() {\n    // aegis-mutation: eng\n    #[allow(clippy::disallowed_methods)]\n    g();\n}\n",
        "// aegis-mutation: eng\n#[allow(clippy::disallowed_methods)]\npub fn f() {}\n",
        "fn f() {\n    // aegis-mutation: eng\n    #[allow(clippy::disallowed_methods)]\n    {\n        g();\n    }\n}\n",
    ] {
        assert!(scan_source(src).errors.is_empty(), "{src}");
    }
}

#[test]
fn unsafe_suppressions_need_their_own_marker() {
    let ok = "// aegis-unsafe: ffi-call\n#[allow(unsafe_code)]\nfn f() {}\n";
    assert_eq!(suppressions(ok), vec![marked(2, "ffi-call")]);
    let wrong_kind = "// aegis-mutation: ffi-call\n#[allow(unsafe_code)]\nfn f() {}\n";
    assert!(errors_with(wrong_kind, "passt nicht") > 0);
    let wrong_kind = "// aegis-unsafe: datei\n#[allow(clippy::disallowed_methods)]\nfn f() {}\n";
    assert!(errors_with(wrong_kind, "passt nicht") > 0);
    let both =
        "// aegis-unsafe: beides\n#[allow(unsafe_code, clippy::disallowed_methods)]\nfn f() {}\n";
    assert!(errors_with(both, "getrennt") > 0);
}

#[test]
fn path_include_and_doc_attributes_are_rejected() {
    assert!(errors_with("#[path = \".hidden/evil.rs\"]\nmod hidden;\n", "#[path") > 0);
    assert!(
        errors_with(
            "#[cfg_attr(unix, path = \"x.rs\")]\nmod hidden;\n",
            "#[path"
        ) > 0
    );
    assert!(errors_with("include!(\"../../../rules/included.rs\");\n", "include!") > 0);
    assert!(errors_with("#![doc = include_str!(\"../README.md\")]\n", "#[doc") > 0);
    // include_str!/include_bytes! (Daten, kein Code) sind erlaubt.
    assert!(
        scan_source("const ICON: &[u8] = include_bytes!(\"icon.png\");\n")
            .errors
            .is_empty()
    );
}

#[test]
fn running_doctests_must_not_mutate() {
    let bad = "//! ```\n//! let _ = std::fs::remove_file(\"/tmp/doctest-victim.txt\");\n//! ```\n";
    assert!(errors_with(bad, "Doctest") > 0);
    let hidden = "/// ```rust\n/// # std::process::Command::new(\"x\").status().unwrap();\n/// ```\nfn f() {}\n";
    assert!(errors_with(hidden, "Doctest") > 0);
    let block = "/**\n * ```\n * std::fs::write(\"x\", b\"y\").unwrap();\n * ```\n */\nfn f() {}\n";
    assert!(errors_with(block, "Doctest") > 0);
    // Nicht laufende oder andere Sprachen sind erlaubt, ebenso die Test-Helfer.
    for ok in [
        "//! ```no_run\n//! std::fs::remove_file(\"x\").unwrap();\n//! ```\n",
        "//! ```ignore\n//! std::fs::remove_file(\"x\").unwrap();\n//! ```\n",
        "//! ```compile_fail\n//! std::fs::remove_file(\"x\").unwrap();\n//! ```\n",
        "//! ```text\n//! std::fs::remove_file(x)\n//! ```\n",
        "//! ```\n//! aegis_core::testing::write_fixture(dir, \"a\", b\"x\")?;\n//! ```\n",
        "/// Beispiel ohne Codeblock: std::fs::remove_file(x)\nfn f() {}\n",
    ] {
        assert!(
            scan_source(ok).errors.is_empty(),
            "{ok}: {:?}",
            scan_source(ok).errors
        );
    }
}

#[test]
fn clippy_toml_must_really_list_every_entry() {
    let full = full_clippy_toml();
    // Auskommentiert: Der Text ist noch da, die Sperre nicht.
    let commented = full.replace(
        "  { path = \"std::fs::remove_dir_all\"",
        "  # { path = \"std::fs::remove_dir_all\"",
    );
    assert!(
        check_clippy_toml(&commented)
            .iter()
            .any(|e| e.contains("std::fs::remove_dir_all"))
    );
    // Schlüssel umbenannt: keine einzige Sperre mehr.
    let renamed = full.replace("disallowed-methods", "disallowed-macros");
    assert!(
        check_clippy_toml(&renamed)
            .iter()
            .any(|e| e.contains("fehlt"))
    );
    // `allow-invalid` an einem überall vorhandenen std-Pfad unterdrückt Tippfehler-Warnungen.
    let invalid = full.replace(
        "{ path = \"std::fs::remove_file\", reason = \"Grund\" }",
        "{ path = \"std::fs::remove_file\", reason = \"Grund\", allow-invalid = true }",
    );
    assert!(
        check_clippy_toml(&invalid)
            .iter()
            .any(|e| e.contains("allow-invalid"))
    );
    // Eintrag ohne Begründung (nur Pfad als Text).
    let bare = full.replace("]\n", "  \"std::fs::read\",\n]\n");
    assert!(!check_clippy_toml(&bare).is_empty());
    // Kaputtes TOML.
    assert!(!check_clippy_toml("disallowed-methods = [").is_empty());
}

#[test]
fn root_manifest_style_allow_forms_are_rejected() {
    let base = "[workspace.lints.rust]\nunsafe_code = \"deny\"\n";
    for lints in [
        "[workspace.lints.clippy]\nstyle = { level = 'allow', priority = 1 }\n",
        "[workspace.lints.clippy]\n\"style\" = { level = \"allow\", priority = 1 }\n",
        "[workspace.lints.clippy]\nstyle.level = \"allow\"\nstyle.priority = 1\n",
        "[workspace.lints.clippy.style]\nlevel = \"allow\"\npriority = 1\n",
        "[workspace.lints.clippy]\nall = 'allow'\n",
    ] {
        let text = format!("{base}{lints}");
        assert!(!check_root_manifest(&text).is_empty(), "{text}");
    }
    assert!(
        !check_root_manifest(
            "[workspace.lints.rust]\nwarnings = \"allow\"\nunsafe_code = \"deny\"\n"
        )
        .is_empty()
    );
    assert!(!check_root_manifest("[workspace.lints.rust]\nunsafe_code = \"allow\"\n").is_empty());
    assert!(!check_root_manifest("[workspace.lints.clippy]\n").is_empty());
}

#[test]
fn cargo_config_cannot_disable_clippy() {
    for config in [
        "[env]\nCLIPPY_CONF_DIR = \"/\"\n",
        "[env]\nCLIPPY_CONF_DIR = { value = \"docs\", relative = true }\n",
        "[build]\nrustflags = [\"--cap-lints=warn\"]\n",
        "[build]\nrustflags = \"-A clippy::all\"\n",
        "[build]\nrustflags = [\"--force-warn\", \"x\"]\n",
        "[target.x86_64-unknown-linux-gnu]\nrustflags = [\"-Awarnings\"]\n",
        "[build]\nrustc-wrapper = \"/usr/bin/env\"\n",
        "[build]\nrustc-workspace-wrapper = \"x\"\n",
        "[alias]\nclippy = \"check\"\n",
        "[build\n",
    ] {
        assert!(
            !check_cargo_config(".cargo/config.toml", config).is_empty(),
            "{config}"
        );
    }
    assert!(
        check_cargo_config(
            ".cargo/config.toml",
            "[build]\nrustflags = [\"-D\", \"warnings\"]\n[alias]\nxtask = \"run -p xtask\"\n"
        )
        .is_empty()
    );
    for workflow in [
        "env:\n  CLIPPY_CONF_DIR: docs\n",
        "run: cargo clippy -- --cap-lints warn\n",
        "run: cargo clippy -- -A clippy::disallowed_methods\n",
    ] {
        assert!(!check_workflow("ci.yml", workflow).is_empty(), "{workflow}");
    }
    assert!(
        check_workflow(
            "ci.yml",
            "run: cargo clippy --workspace --all-targets -- -D warnings\n"
        )
        .is_empty()
    );
}

#[test]
fn mutation_capable_dependencies_need_clippy_entries() {
    let package = |dep: &str| Package {
        name: "probe".to_owned(),
        manifest_path: PathBuf::from("/x/probe/Cargo.toml"),
        dependencies: vec![Dependency {
            name: dep.to_owned(),
            rename: None,
            kind: None,
            features: Vec::new(),
        }],
        features: BTreeMap::new(),
        targets: Vec::new(),
    };
    let config = full_clippy_toml();
    assert!(unguarded_mutation_crates(&[package("tokio")], &config).is_empty());
    assert!(unguarded_mutation_crates(&[package("tempfile")], &config).is_empty());
    for dep in ["windows-sys", "libc", "nix", "fs_extra", "trash"] {
        assert!(
            !unguarded_mutation_crates(&[package(dep)], &config).is_empty(),
            "{dep}"
        );
    }
    assert!(!unguarded_mutation_crates(&[package("tokio")], "disallowed-methods = []").is_empty());
    assert!(unguarded_mutation_crates(&[package("serde")], "").is_empty());
}

#[test]
fn hidden_and_unusual_locations_are_scanned() {
    use aegis_core::testing::{create_fixture_dir, write_fixture};
    let dir = tempfile::tempdir().unwrap();
    write_fixture(dir.path(), "Cargo.toml", b"[package]\nname = \"p\"\n").unwrap();
    write_fixture(dir.path(), "src/.hidden/evil.rs", b"fn f() {}\n").unwrap();
    write_fixture(dir.path(), "src/target/mod.rs", b"fn g() {}\n").unwrap();
    write_fixture(dir.path(), "target/debug/build.rs", b"fn h() {}\n").unwrap();
    create_fixture_dir(dir.path(), ".git").unwrap();
    write_fixture(dir.path(), ".git/x.rs", b"").unwrap();
    let mut files = BTreeSet::new();
    let mut errors = Vec::new();
    walk(dir.path(), &mut files, &mut errors, dir.path());
    let names: Vec<String> = files.iter().map(|p| relative(dir.path(), p)).collect();
    assert_eq!(
        names,
        ["Cargo.toml", "src/.hidden/evil.rs", "src/target/mod.rs"]
    );
    assert!(errors.is_empty());

    #[cfg(unix)]
    {
        aegis_core::testing::create_fixture_symlink(
            dir.path(),
            "src/linked.rs",
            &dir.path().join("src/target/mod.rs"),
        )
        .unwrap();
        let mut files = BTreeSet::new();
        let mut errors = Vec::new();
        walk(dir.path(), &mut files, &mut errors, dir.path());
        assert!(
            errors.iter().any(|e| e.contains("symbolischer Link")),
            "{errors:?}"
        );
    }
}

#[test]
fn clippy_toml_between_member_and_root_is_found() {
    let root = Path::new("/w");
    assert_eq!(
        ancestors_below_root(root, Path::new("/w/apps/desktop/src-tauri")),
        [
            PathBuf::from("/w/apps/desktop/src-tauri"),
            PathBuf::from("/w/apps/desktop"),
            PathBuf::from("/w/apps")
        ]
    );
    assert!(ancestors_below_root(root, Path::new("/elsewhere/x")).is_empty());
}

#[test]
fn lexer_keeps_line_structure() {
    let src = "a /* x\ny */ b \"s\ns\" c // k\nd";
    let lexed = lex(src);
    assert_eq!(lexed.code.len(), src.len());
    assert_eq!(
        lexed.code.iter().filter(|&&b| b == b'\n').count(),
        src.matches('\n').count()
    );
    assert_eq!(
        lexed.comments,
        vec![LineComment {
            line: 3,
            standalone: false,
            text: " k".to_owned()
        }]
    );
    let code = String::from_utf8(lexed.code).unwrap();
    assert!(code.starts_with("a "));
    assert!(code.contains(" b "));
    assert!(code.ends_with("\nd"));
    assert!(!code.contains('s'));
}
