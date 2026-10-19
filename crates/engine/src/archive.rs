//! Archive und Abbilder sicher öffnen: ZIP, 7z, CAB, GZIP, TAR, ISO – **nur in den Speicher**,
//! nie auf die Platte, mit Grenzen gegen Zip-Bomben (Größe je Eintrag, Gesamtgröße, Anzahl).
//! Passwortgeschützte Inhalte werden als „nicht prüfbar“ gemeldet. RAR entpackt AEGIS nicht
//! selbst (Lizenz des Entpackers); ClamAV prüft RAR, wenn installiert. Datenträger-Abbilder
//! (VHD/VHDX/IMG) werden erkannt, aber nicht entpackt.

use std::io::{self, Cursor, Read};

use crate::iso;

/// Art des Containers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerKind {
    /// ZIP (auch OOXML, JAR …).
    Zip,
    /// 7-Zip.
    SevenZip,
    /// Microsoft-Cabinet.
    Cab,
    /// GZIP (ein Datenstrom).
    Gzip,
    /// TAR.
    Tar,
    /// ISO-9660-Abbild.
    Iso,
    /// RAR (nicht selbst entpackt).
    Rar,
    /// Datenträger-Abbild (nicht entpackt).
    DiskImage,
}

impl ContainerKind {
    /// Anzeigename.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Zip => "ZIP",
            Self::SevenZip => "7z",
            Self::Cab => "CAB",
            Self::Gzip => "GZIP",
            Self::Tar => "TAR",
            Self::Iso => "ISO",
            Self::Rar => "RAR",
            Self::DiskImage => "Datenträger-Abbild",
        }
    }

    /// Abbild, dessen Inhalt beim Einhängen keinen Download-Hinweis erbt?
    #[must_use]
    pub const fn is_image(self) -> bool {
        matches!(self, Self::Iso | Self::DiskImage)
    }
}

/// Erkennt einen Container am Inhalt (bei Datenträger-Abbildern zusätzlich an der Endung).
#[must_use]
pub fn detect(name: &str, bytes: &[u8]) -> Option<ContainerKind> {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    if bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06") {
        Some(ContainerKind::Zip)
    } else if bytes.starts_with(b"7z\xBC\xAF\x27\x1C") {
        Some(ContainerKind::SevenZip)
    } else if bytes.starts_with(b"MSCF\0\0\0\0") {
        Some(ContainerKind::Cab)
    } else if bytes.starts_with(&[0x1F, 0x8B]) {
        Some(ContainerKind::Gzip)
    } else if bytes.starts_with(b"Rar!\x1A\x07") {
        Some(ContainerKind::Rar)
    } else if bytes.get(257..262) == Some(b"ustar") {
        Some(ContainerKind::Tar)
    } else if iso::is_iso(bytes) {
        Some(ContainerKind::Iso)
    } else if bytes.starts_with(b"vhdxfile")
        || bytes.starts_with(b"conectix")
        || (matches!(ext.as_str(), "vhd" | "vhdx" | "img")
            && bytes.len() > 512
            && bytes.get(510..512) == Some(&[0x55, 0xAA]))
        || bytes
            .len()
            .checked_sub(512)
            .and_then(|o| bytes.get(o..o + 8))
            .is_some_and(|f| f == b"conectix")
    {
        Some(ContainerKind::DiskImage)
    } else {
        None
    }
}

/// Grenzen für einen ganzen Prüflauf einer Datei (über alle Verschachtelungen).
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    /// Noch erlaubte entpackte Bytes insgesamt.
    pub bytes_left: u64,
    /// Noch erlaubte Einträge insgesamt.
    pub entries_left: u32,
    /// Höchstgröße eines einzelnen entpackten Eintrags.
    pub max_member: u64,
    /// Höchste Verschachtelungstiefe.
    pub max_depth: u8,
}

impl Default for Budget {
    fn default() -> Self {
        Self {
            bytes_left: 512 * 1024 * 1024,
            entries_left: 10_000,
            max_member: 128 * 1024 * 1024,
            max_depth: 3,
        }
    }
}

/// Ein Eintrag eines Containers.
#[derive(Debug)]
pub enum Member {
    /// Entpackter Inhalt.
    Data {
        /// Name im Container.
        name: String,
        /// Inhalt.
        bytes: Vec<u8>,
    },
    /// Passwortgeschützt.
    Encrypted {
        /// Name im Container.
        name: String,
    },
    /// Größer als erlaubt (möglicherweise Zip-Bombe).
    TooLarge {
        /// Name im Container.
        name: String,
    },
    /// Nicht lesbar (beschädigt, unbekanntes Verfahren).
    Unreadable {
        /// Name im Container.
        name: String,
        /// Grund.
        error: String,
    },
}

/// Ergebnis des Durchgehens.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Listing {
    /// Nicht alle Einträge geprüft (Grenzen erreicht).
    pub truncated: bool,
    /// Ganzes Archiv passwortgeschützt (z. B. verschlüsselte 7z-Kopfdaten).
    pub encrypted: bool,
    /// Container nicht lesbar.
    pub error: Option<String>,
    /// Container wird bewusst nicht entpackt (RAR, Datenträger-Abbild).
    pub unsupported: bool,
}

/// Liest höchstens `limit` Byte; `None`, wenn es mehr wären.
fn read_limited<R: Read>(reader: R, limit: u64) -> io::Result<Option<Vec<u8>>> {
    let mut out = Vec::new();
    reader.take(limit.saturating_add(1)).read_to_end(&mut out)?;
    Ok((out.len() as u64 <= limit).then_some(out))
}

/// Gibt einen Eintrag nach Budget weiter.
fn emit<R: Read>(
    name: String,
    reader: R,
    budget: &mut Budget,
    visit: &mut dyn FnMut(Member, &mut Budget),
) -> bool {
    if budget.entries_left == 0 || budget.bytes_left == 0 {
        return false;
    }
    budget.entries_left -= 1;
    let limit = budget.max_member.min(budget.bytes_left);
    match read_limited(reader, limit) {
        Ok(Some(bytes)) => {
            budget.bytes_left = budget.bytes_left.saturating_sub(bytes.len() as u64);
            visit(Member::Data { name, bytes }, budget);
        }
        Ok(None) => {
            budget.bytes_left = budget.bytes_left.saturating_sub(limit);
            visit(Member::TooLarge { name }, budget);
        }
        Err(e) => visit(
            Member::Unreadable {
                name,
                error: e.to_string(),
            },
            budget,
        ),
    }
    true
}

/// Geht alle Einträge durch und ruft `visit` für jeden auf.
pub fn members(
    kind: ContainerKind,
    name_hint: &str,
    bytes: &[u8],
    budget: &mut Budget,
    visit: &mut dyn FnMut(Member, &mut Budget),
) -> Listing {
    let mut listing = Listing::default();
    match kind {
        ContainerKind::Zip => zip_members(bytes, budget, visit, &mut listing),
        ContainerKind::SevenZip => seven_members(bytes, budget, visit, &mut listing),
        ContainerKind::Cab => cab_members(bytes, budget, visit, &mut listing),
        ContainerKind::Gzip => {
            let decoder = flate2::read::GzDecoder::new(bytes);
            let inner = decoder
                .header()
                .and_then(|h| h.filename())
                .map(|f| String::from_utf8_lossy(f).into_owned())
                .unwrap_or_else(|| {
                    name_hint
                        .strip_suffix(".gz")
                        .or_else(|| name_hint.strip_suffix(".tgz"))
                        .unwrap_or("inhalt")
                        .to_owned()
                });
            listing.truncated = !emit(inner, decoder, budget, visit);
        }
        ContainerKind::Tar => tar_members(bytes, budget, visit, &mut listing),
        ContainerKind::Iso => {
            match iso::files(bytes, usize::try_from(budget.entries_left).unwrap_or(0)) {
                Ok((files, truncated)) => {
                    listing.truncated = truncated;
                    for f in files {
                        if !emit(f.name, &bytes[f.range], budget, visit) {
                            listing.truncated = true;
                            break;
                        }
                    }
                }
                Err(e) => listing.error = Some(e),
            }
        }
        ContainerKind::Rar | ContainerKind::DiskImage => listing.unsupported = true,
    }
    listing
}

fn zip_members(
    bytes: &[u8],
    budget: &mut Budget,
    visit: &mut dyn FnMut(Member, &mut Budget),
    listing: &mut Listing,
) {
    let mut zip = match zip::ZipArchive::new(Cursor::new(bytes)) {
        Ok(z) => z,
        Err(e) => {
            listing.error = Some(e.to_string());
            return;
        }
    };
    for i in 0..zip.len() {
        let (name, dir, encrypted) = match zip.by_index_raw(i) {
            Ok(f) => (
                f.name()
                    .map_or_else(|_| format!("#{i}"), std::borrow::Cow::into_owned),
                f.is_dir(),
                f.encrypted(),
            ),
            Err(e) => {
                visit(
                    Member::Unreadable {
                        name: format!("#{i}"),
                        error: e.to_string(),
                    },
                    budget,
                );
                continue;
            }
        };
        if dir {
            continue;
        }
        if encrypted {
            visit(Member::Encrypted { name }, budget);
            continue;
        }
        let ok = match zip.by_index(i) {
            Ok(file) => emit(name, file, budget, visit),
            Err(e) => {
                visit(
                    Member::Unreadable {
                        name,
                        error: e.to_string(),
                    },
                    budget,
                );
                true
            }
        };
        if !ok {
            listing.truncated = true;
            break;
        }
    }
}

fn seven_members(
    bytes: &[u8],
    budget: &mut Budget,
    visit: &mut dyn FnMut(Member, &mut Budget),
    listing: &mut Listing,
) {
    let mut reader =
        match sevenz_rust2::ArchiveReader::new(Cursor::new(bytes), sevenz_rust2::Password::empty())
        {
            Ok(r) => r,
            Err(sevenz_rust2::Error::PasswordRequired) => {
                listing.encrypted = true;
                return;
            }
            Err(e) => {
                listing.error = Some(e.to_string());
                return;
            }
        };
    let mut stopped = false;
    let result = reader.for_each_entries(|entry, data| {
        if entry.is_directory() || !entry.has_stream() {
            return Ok(true);
        }
        if !emit(entry.name().to_owned(), data, budget, visit) {
            stopped = true;
            return Ok(false);
        }
        Ok(true)
    });
    listing.truncated = stopped;
    match result {
        Ok(()) => {}
        Err(sevenz_rust2::Error::PasswordRequired | sevenz_rust2::Error::MaybeBadPassword(_)) => {
            listing.encrypted = true;
        }
        Err(e) => listing.error = Some(e.to_string()),
    }
}

fn cab_members(
    bytes: &[u8],
    budget: &mut Budget,
    visit: &mut dyn FnMut(Member, &mut Budget),
    listing: &mut Listing,
) {
    let mut cab = match cab::Cabinet::new(Cursor::new(bytes)) {
        Ok(c) => c,
        Err(e) => {
            listing.error = Some(e.to_string());
            return;
        }
    };
    let names: Vec<String> = cab
        .folder_entries()
        .flat_map(|f| {
            f.file_entries()
                .map(|e| e.name().to_owned())
                .collect::<Vec<_>>()
        })
        .collect();
    for name in names {
        let ok = match cab.read_file(&name) {
            Ok(reader) => emit(name, reader, budget, visit),
            Err(e) => {
                visit(
                    Member::Unreadable {
                        name,
                        error: e.to_string(),
                    },
                    budget,
                );
                true
            }
        };
        if !ok {
            listing.truncated = true;
            break;
        }
    }
}

fn tar_members(
    bytes: &[u8],
    budget: &mut Budget,
    visit: &mut dyn FnMut(Member, &mut Budget),
    listing: &mut Listing,
) {
    let mut archive = tar::Archive::new(Cursor::new(bytes));
    let entries = match archive.entries() {
        Ok(e) => e,
        Err(e) => {
            listing.error = Some(e.to_string());
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                listing.error = Some(e.to_string());
                break;
            }
        };
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let name = entry
            .path()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "?".into());
        if !emit(name, entry, budget, visit) {
            listing.truncated = true;
            break;
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    /// ZIP im Speicher (Test-Hilfe).
    pub(crate) fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            for (name, body) in files {
                z.start_file(*name, opts).unwrap();
                z.write_all(body).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    fn collect(kind: ContainerKind, bytes: &[u8], budget: &mut Budget) -> (Vec<String>, Listing) {
        let mut seen = Vec::new();
        let listing = members(kind, "x", bytes, budget, &mut |m, _| {
            seen.push(match m {
                Member::Data { name, bytes } => format!("{name}:{}", bytes.len()),
                Member::Encrypted { name } => format!("{name}:verschlüsselt"),
                Member::TooLarge { name } => format!("{name}:zu groß"),
                Member::Unreadable { name, .. } => format!("{name}:kaputt"),
            });
        });
        (seen, listing)
    }

    #[test]
    fn zip_und_grenzen() {
        let z = zip_of(&[("a.txt", b"hallo"), ("dir/b.bin", &[0u8; 5000])]);
        assert_eq!(detect("x.zip", &z), Some(ContainerKind::Zip));
        let (seen, l) = collect(ContainerKind::Zip, &z, &mut Budget::default());
        assert_eq!(seen, ["a.txt:5", "dir/b.bin:5000"]);
        assert_eq!(l, Listing::default());
        // Bombe: Eintrag größer als erlaubt wird nicht ganz entpackt.
        let mut small = Budget {
            max_member: 1000,
            ..Budget::default()
        };
        let (seen, _) = collect(ContainerKind::Zip, &z, &mut small);
        assert_eq!(seen, ["a.txt:5", "dir/b.bin:zu groß"]);
        // Anzahl begrenzt.
        let mut one = Budget {
            entries_left: 1,
            ..Budget::default()
        };
        let (seen, l) = collect(ContainerKind::Zip, &z, &mut one);
        assert_eq!(seen.len(), 1);
        assert!(l.truncated);
    }

    #[test]
    fn gzip_tar_und_iso() {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(b"inhalt").unwrap();
        let gz = gz.finish().unwrap();
        assert_eq!(detect("a.txt.gz", &gz), Some(ContainerKind::Gzip));
        let mut seen = Vec::new();
        members(
            ContainerKind::Gzip,
            "a.txt.gz",
            &gz,
            &mut Budget::default(),
            &mut |m, _| {
                if let Member::Data { name, bytes } = m {
                    seen.push((name, bytes));
                }
            },
        );
        assert_eq!(seen, [("a.txt".to_owned(), b"inhalt".to_vec())]);

        let mut tar = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(3);
        header.set_cksum();
        tar.append_data(&mut header, "t/x.ps1", &b"abc"[..])
            .unwrap();
        let tar = tar.into_inner().unwrap();
        assert_eq!(detect("a.tar", &tar), Some(ContainerKind::Tar));
        assert_eq!(
            collect(ContainerKind::Tar, &tar, &mut Budget::default()).0,
            ["t/x.ps1:3"]
        );

        let image = crate::iso::tests::build(&[("a.exe", b"MZ")]);
        assert_eq!(detect("a.iso", &image), Some(ContainerKind::Iso));
        assert_eq!(
            collect(ContainerKind::Iso, &image, &mut Budget::default()).0,
            ["A.EXE:2"]
        );
    }

    #[test]
    fn rar_und_abbilder_werden_nicht_entpackt() {
        assert_eq!(
            detect("a.rar", b"Rar!\x1A\x07\x01\x00"),
            Some(ContainerKind::Rar)
        );
        let (seen, l) = collect(ContainerKind::Rar, b"Rar!", &mut Budget::default());
        assert!(seen.is_empty() && l.unsupported);
        assert_eq!(
            detect("a.vhdx", b"vhdxfile...."),
            Some(ContainerKind::DiskImage)
        );
        assert_eq!(detect("a.txt", b"nur text"), None);
        let (_, l) = collect(
            ContainerKind::Zip,
            b"PK\x03\x04kaputt",
            &mut Budget::default(),
        );
        assert!(l.error.is_some());
        let (_, l) = collect(
            ContainerKind::SevenZip,
            b"7z\xBC\xAF\x27\x1Ckaputt",
            &mut Budget::default(),
        );
        assert!(l.error.is_some() || l.encrypted);
    }
}
