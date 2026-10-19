//! Mutations-Sperre der Goldenen Regel.
//!
//! Prüft den gesamten Workspace (`crates/**` und `apps/*/src-tauri/**`, ohne `target/` und
//! `node_modules/`):
//!
//! * Jede Unterdrückung von `clippy::disallowed_methods` (direkt oder über `clippy::all`,
//!   `clippy::style`, `warnings`; per `allow`/`expect`, auch in `cfg_attr`) steht direkt
//!   unter einer Markierung `// aegis-mutation: <kennung>` (oder trägt sie am Zeilenende).
//! * Jedes Paar (Datei, Kennung) steht in `crates/core/mutation-allowlist.txt`; veraltete
//!   Einträge und verwaiste Markierungen schlagen fehl.
//! * Die Sperrliste selbst ist intakt: keine zusätzliche `clippy.toml`, alle Pflicht-Pfade
//!   in der Wurzel-`clippy.toml`, jedes Crate erbt die Workspace-Lints.
//! * Das Test-Feature `testing` (gestellte Uhr, Fixture-Helfer) wird nur in
//!   `dev-dependencies` eingeschaltet.
//!
//! Der Scanner arbeitet auf einer Fassung des Quelltexts, in der Kommentare und
//! Zeichenketten ausgeblendet sind – Beispiele in Strings oder Doku zählen also nicht.
//! Seine Logik wird unten an synthetischen Eingaben getestet.
// Integrationstest: Auch Hilfsfunktionen außerhalb von #[test] dürfen wie Tests per
// unwrap/expect/panic abbrechen (clippy.toml erlaubt das sonst nur direkt in #[test]).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// Lints, deren Unterdrückung die Sperrliste aushebeln würde.
const GUARDED_LINTS: &[&str] = &[
    "clippy::disallowed_methods",
    "clippy::disallowed_method",
    "clippy::all",
    "clippy::style",
    "warnings",
];

const MARKER_PREFIX: &str = "aegis-mutation:";
const ALLOWLIST: &str = "crates/core/mutation-allowlist.txt";
const MIN_JUSTIFICATION_CHARS: usize = 20;

/// Pfade, die `clippy.toml` mindestens sperren muss.
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
    "std::process::Command::spawn",
    "std::process::Command::output",
    "std::process::Command::status",
    "std::os::unix::process::CommandExt::exec",
    "std::process::Child::kill",
];

// ---------------------------------------------------------------------------------------
// Lexer: blendet Kommentare und Literale aus, sammelt Zeilenkommentare
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

#[derive(Debug)]
struct Lexed {
    /// Quelltext mit ausgeblendeten Kommentaren/Literalen (Zeilenumbrüche bleiben erhalten).
    code: Vec<u8>,
    comments: Vec<LineComment>,
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
    Lexed { code, comments }
}

// ---------------------------------------------------------------------------------------
// Scanner für eine Datei
// ---------------------------------------------------------------------------------------

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

/// Attribute (`#[…]`, `#![…]`) als (Startzeile, Text ohne Leerraum).
fn attributes(code: &[u8]) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut line = 1;
    let mut i = 0;
    while i < code.len() {
        if code[i] == b'\n' {
            line += 1;
        }
        if code[i] != b'#' {
            i += 1;
            continue;
        }
        let start_line = line;
        let mut j = i + 1;
        let skip_ws = |j: &mut usize| {
            while *j < code.len() && code[*j].is_ascii_whitespace() {
                *j += 1;
            }
        };
        skip_ws(&mut j);
        if code.get(j) == Some(&b'!') {
            j += 1;
            skip_ws(&mut j);
        }
        if code.get(j) != Some(&b'[') {
            i += 1;
            continue;
        }
        let mut depth = 0usize;
        let mut k = j;
        while k < code.len() {
            match code[k] {
                b'[' => depth += 1,
                b']' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            k += 1;
        }
        let end = k.min(code.len().saturating_sub(1));
        let text: String = code[i..=end]
            .iter()
            .filter(|b| !b.is_ascii_whitespace())
            .map(|&b| char::from(b))
            .collect();
        line += code[i..=end].iter().filter(|&&b| b == b'\n').count();
        out.push((start_line, text));
        i = end + 1;
    }
    out
}

/// Unterdrückt das Attribut (per `allow`/`expect`) einen der bewachten Lints?
fn suppresses_guarded_lint(attr: &str) -> bool {
    let bytes = attr.as_bytes();
    for keyword in ["allow(", "expect("] {
        let mut from = 0;
        while let Some(pos) = attr[from..].find(keyword) {
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
            let inner = &attr[from..k.saturating_sub(1).max(from)];
            if inner.split(',').any(|item| GUARDED_LINTS.contains(&item)) {
                return true;
            }
        }
    }
    false
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

/// Markierungs-Kommentare: Zeile → (allein in der Zeile?, Kennung oder Fehler).
fn markers(comments: &[LineComment]) -> Vec<(usize, bool, Result<String, String>)> {
    comments
        .iter()
        .filter_map(|comment| {
            let text = comment.text.trim();
            let rest = text.strip_prefix(MARKER_PREFIX)?;
            let id = rest.trim();
            let parsed = if is_valid_marker_id(id) {
                Ok(id.to_owned())
            } else {
                Err(format!(
                    "Zeile {}: ungültige Markierung „{text}“ (erlaubt: Kleinbuchstaben, Ziffern, Bindestriche)",
                    comment.line
                ))
            };
            Some((comment.line, comment.standalone, parsed))
        })
        .collect()
}

fn scan_source(src: &str) -> FileScan {
    let lexed = lex(src);
    let found_markers = markers(&lexed.comments);
    let mut used_marker_lines = BTreeSet::new();
    let mut scan = FileScan::default();
    let mut ids_seen = BTreeSet::new();

    for (line, attr) in attributes(&lexed.code) {
        if !suppresses_guarded_lint(&attr) {
            continue;
        }
        let marker = found_markers.iter().find(|(marker_line, standalone, _)| {
            (*standalone && *marker_line + 1 == line) || (!*standalone && *marker_line == line)
        });
        let marker = match marker {
            Some((marker_line, _, Ok(id))) => {
                used_marker_lines.insert(*marker_line);
                if !ids_seen.insert(id.clone()) {
                    scan.errors.push(format!(
                        "Zeile {line}: Kennung „{id}“ ist in dieser Datei doppelt"
                    ));
                }
                Some(id.clone())
            }
            Some((marker_line, _, Err(_))) => {
                used_marker_lines.insert(*marker_line);
                None
            }
            None => None,
        };
        scan.suppressions.push(Suppression { line, marker });
    }
    for (line, _, parsed) in &found_markers {
        match parsed {
            Err(message) => scan.errors.push(message.clone()),
            Ok(id) if !used_marker_lines.contains(line) => scan.errors.push(format!(
                "Zeile {line}: Markierung „{id}“ ohne direkt folgende Ausnahme (verwaist)"
            )),
            Ok(_) => {}
        }
    }
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
// Konfiguration (clippy.toml, Manifeste)
// ---------------------------------------------------------------------------------------

/// Erbt das Manifest die Workspace-Lints (`[lints]` mit `workspace = true`)?
fn manifest_inherits_lints(manifest: &str) -> bool {
    let mut in_lints = false;
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            in_lints = line == "[lints]";
            continue;
        }
        if in_lints && line.replace(' ', "") == "workspace=true" {
            return true;
        }
    }
    false
}

/// Schaltet das Manifest das Test-Feature `testing` von `aegis-core` außerhalb von
/// `dev-dependencies` ein? (Dann gäbe es `ManualClock` und die Fixture-Helfer auch im
/// Produktivcode – Fristen ließen sich mit einer gestellten Uhr aushebeln.)
fn testing_feature_leaks(manifest: &str) -> bool {
    let mut section = String::new();
    for raw in manifest.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            section = line
                .trim_matches(|c| c == '[' || c == ']')
                .trim()
                .to_owned();
            continue;
        }
        if section.contains("dev-dependencies") {
            continue;
        }
        let inline = section.ends_with("dependencies") && line.starts_with("aegis-core");
        let table = section.ends_with("dependencies.aegis-core");
        if (inline || table) && line.contains("\"testing\"") {
            return true;
        }
    }
    false
}

/// Fehler in der Wurzel-`clippy.toml`.
fn check_clippy_toml(text: &str) -> Vec<String> {
    let mut errors = Vec::new();
    for path in REQUIRED_DISALLOWED {
        if !text.contains(&format!("path = \"{path}\"")) {
            errors.push(format!(
                "clippy.toml: Pflicht-Sperre „{path}“ fehlt in disallowed-methods"
            ));
        }
    }
    let entries = text.matches("{ path = ").count();
    let reasons = text.matches("reason = \"").count();
    if entries != reasons {
        errors.push(format!(
            "clippy.toml: {entries} Sperren, aber {reasons} Begründungen – jede Sperre braucht `reason`"
        ));
    }
    errors
}

/// Fehler in der Wurzel-`Cargo.toml` (Lint-Abschwächungen).
fn check_root_manifest(text: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if text.contains("disallowed_methods") || text.contains("disallowed-methods") {
        errors.push("Cargo.toml: disallowed_methods darf nicht umkonfiguriert werden".to_owned());
    }
    let mut in_clippy = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            in_clippy = line == "[workspace.lints.clippy]";
            continue;
        }
        let key = line.split('=').next().unwrap_or_default().trim();
        if in_clippy && (key == "all" || key == "style") && line.contains("\"allow\"") {
            errors.push(format!(
                "Cargo.toml: clippy::{key} darf nicht auf „allow“ stehen"
            ));
        }
    }
    errors
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn is_skipped_dir(name: &str) -> bool {
    name == "target" || name == "node_modules" || name.starts_with('.')
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap()).collect();
    entries.sort_by_key(fs::DirEntry::path);
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = entry.file_type().unwrap();
        if file_type.is_dir() {
            if !is_skipped_dir(&name) {
                walk(&path, out);
            }
        } else if file_type.is_file() {
            out.push(path);
        }
    }
}

/// Alle Dateien im geprüften Bereich: `crates/**` und `apps/*/src-tauri/**`.
fn scanned_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    walk(&root.join("crates"), &mut files);
    for app in fs::read_dir(root.join("apps")).unwrap() {
        let tauri = app.unwrap().path().join("src-tauri");
        if tauri.is_dir() {
            walk(&tauri, &mut files);
        }
    }
    files
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap()
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn check_workspace(root: &Path) -> Vec<String> {
    let mut errors = Vec::new();
    let (allowlist, list_errors) =
        parse_allowlist(&fs::read_to_string(root.join(ALLOWLIST)).unwrap());
    errors.extend(list_errors);

    let files = scanned_files(root);
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
            if testing_feature_leaks(&text) {
                errors.push(format!(
                    "{rel}: Feature „testing“ von aegis-core nur in [dev-dependencies] erlaubt"
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
                        "{rel}:{}: Unterdrückung von clippy::disallowed_methods ohne Markierung \
                         „// aegis-mutation: <kennung>“ direkt darüber",
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

    match fs::read_to_string(root.join("clippy.toml")) {
        Ok(text) => errors.extend(check_clippy_toml(&text)),
        Err(err) => errors.push(format!("clippy.toml fehlt in der Wurzel: {err}")),
    }
    if root.join(".clippy.toml").exists() {
        errors.push(".clippy.toml in der Wurzel würde clippy.toml ersetzen – verboten".to_owned());
    }
    let root_manifest = fs::read_to_string(root.join("Cargo.toml")).unwrap();
    errors.extend(check_root_manifest(&root_manifest));
    if testing_feature_leaks(&root_manifest) {
        errors.push(
            "Cargo.toml: Feature „testing“ von aegis-core darf nicht in [workspace.dependencies] stehen"
                .to_owned(),
        );
    }
    for config in [".cargo/config.toml", ".cargo/config"] {
        if let Ok(text) = fs::read_to_string(root.join(config))
            && (text.contains("disallowed") || text.contains("clippy::"))
        {
            errors.push(format!("{config}: darf keine Clippy-Lints umkonfigurieren"));
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

#[test]
fn scanner_finds_unmarked_allow() {
    let src =
        "fn f() {\n    #[allow(clippy::disallowed_methods)]\n    std::fs::remove_file(\"x\");\n}\n";
    assert_eq!(suppressions(src), vec![unmarked(2)]);
}

#[test]
fn scanner_accepts_marker_above_or_trailing() {
    let src = "fn f() {\n    // aegis-mutation: delete-one\n    #[allow(clippy::disallowed_methods)]\n    x();\n    #[allow(clippy::disallowed_methods)] // aegis-mutation: trailing-two\n    y();\n}\n";
    assert_eq!(
        suppressions(src),
        vec![marked(3, "delete-one"), marked(5, "trailing-two")]
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
#![allow(clippy::disallowed_methods)]
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
    assert_eq!(lines, vec![2, 3, 8, 10, 12, 14, 16, 18, 20, 22]);
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

#[test]
fn manifest_and_config_checks() {
    assert!(manifest_inherits_lints(
        "[package]\nname = \"x\"\n\n[lints]\nworkspace = true\n"
    ));
    assert!(manifest_inherits_lints(
        "[lints]\nworkspace=true\n[dependencies]\n"
    ));
    assert!(!manifest_inherits_lints(
        "[package]\nname = \"x\"\n[dependencies]\nworkspace = true\n"
    ));
    assert!(!manifest_inherits_lints(
        "[lints.clippy]\nall = \"allow\"\n"
    ));

    let full: String = REQUIRED_DISALLOWED
        .iter()
        .map(|p| format!("  {{ path = \"{p}\", reason = \"Grund\" }},\n"))
        .collect();
    assert!(check_clippy_toml(&full).is_empty());
    let missing = full.replace("std::fs::remove_file\"", "std::fs::remove_filex\"");
    assert!(
        check_clippy_toml(&missing)
            .iter()
            .any(|e| e.contains("std::fs::remove_file"))
    );
    let no_reason = format!("{full}  {{ path = \"std::x\" }},\n");
    assert!(
        check_clippy_toml(&no_reason)
            .iter()
            .any(|e| e.contains("reason"))
    );

    assert!(
        check_root_manifest(
            "[workspace.lints.clippy]\nall = { level = \"warn\", priority = -1 }\n"
        )
        .is_empty()
    );
    assert_eq!(
        check_root_manifest("[workspace.lints.clippy]\nall = { level = \"allow\", priority = -1 }\nstyle = \"allow\"\n").len(),
        2
    );
    assert_eq!(
        check_root_manifest("[workspace.lints.clippy]\ndisallowed_methods = \"allow\"\n").len(),
        1
    );
    // `all` außerhalb der Clippy-Sektion ist egal.
    assert!(check_root_manifest("[features]\nall = \"allow\"\n").is_empty());
}

#[test]
fn testing_feature_must_stay_in_dev_dependencies() {
    let ok = "[dependencies]\naegis-core = { workspace = true }\n\n[dev-dependencies]\naegis-core = { workspace = true, features = [\"testing\"] }\n";
    assert!(!testing_feature_leaks(ok));
    let target_dev = "[target.'cfg(windows)'.dev-dependencies]\naegis-core = { workspace = true, features = [\"testing\"] }\n";
    assert!(!testing_feature_leaks(target_dev));
    for leaking in [
        "[dependencies]\naegis-core = { workspace = true, features = [\"testing\"] }\n",
        "[build-dependencies]\naegis-core = { path = \"../core\", features = [\"testing\"] }\n",
        "[target.'cfg(windows)'.dependencies]\naegis-core = { workspace = true, features = [\"testing\"] }\n",
        "[workspace.dependencies]\naegis-core = { path = \"crates/core\", features = [\"testing\"] }\n",
        "[dependencies.aegis-core]\nworkspace = true\nfeatures = [\"testing\"]\n",
    ] {
        assert!(testing_feature_leaks(leaking), "{leaking}");
    }
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
