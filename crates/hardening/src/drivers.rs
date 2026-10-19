//! Treiber-Check (P6.4): Abgleich der Kernel-Treiber mit der Liste bekannt verwundbarer bzw.
//! bösartiger Treiber von LOLDrivers (Apache-2.0, `rules/drivers/`). Verglichen wird die
//! SHA-256-Prüfsumme der Datei und – für neu signierte Fassungen – der Authenticode-Hash.
//!
//! Hier stehen nur Liste, Prüfsummen und Pfad-Auflösung (rein, überall testbar). Gelesen wird im
//! Dienst; verändert wird hier nichts.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Die gebündelte Liste (erzeugt mit `scripts/update-loldrivers.mjs`).
const LIST: &str = include_str!("../../../rules/drivers/loldrivers.tsv");

/// Größte Treiberdatei, die geprüft wird (größere sind keine üblichen Treiber).
pub const MAX_DRIVER_BYTES: u64 = 64 * 1024 * 1024;

/// Art des Listeneintrags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriverCategory {
    /// Bösartiger Treiber (z. B. Rootkit).
    Malicious,
    /// Legitimer, aber verwundbarer Treiber („Bring your own vulnerable driver“).
    Vulnerable,
}

/// Ein Eintrag der Liste.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnownDriver {
    /// Art.
    pub category: DriverCategory,
    /// Lädt trotz Speicher-Integrität (HVCI)?
    pub loads_despite_hvci: bool,
    /// Kennung bei LOLDrivers.
    pub id: String,
    /// Bekannter Dateiname.
    pub file: String,
}

/// Die Liste mit Nachschlagetabellen.
#[derive(Debug, Default)]
pub struct DriverList {
    entries: Vec<KnownDriver>,
    by_sha256: HashMap<[u8; 32], usize>,
    by_authentihash: HashMap<[u8; 32], usize>,
    date: Option<String>,
}

fn parse_hex32(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(text.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

impl DriverList {
    /// Liest eine Liste im Format von `rules/drivers/loldrivers.tsv` (fehlerhafte Zeilen werden
    /// übersprungen).
    #[must_use]
    pub fn parse(text: &str) -> Self {
        let mut list = Self::default();
        for line in text.lines() {
            if let Some(comment) = line.strip_prefix('#') {
                if let Some(rest) = comment.trim().strip_prefix("Stand:") {
                    list.date = rest.split('·').next().map(|d| d.trim().to_owned());
                }
                continue;
            }
            let cols: Vec<&str> = line.split('\t').collect();
            let [sha, authenti, category, hvci, id, file] = cols.as_slice() else {
                continue;
            };
            let category = match *category {
                "m" => DriverCategory::Malicious,
                "v" => DriverCategory::Vulnerable,
                _ => continue,
            };
            let sha = parse_hex32(sha);
            let authenti = parse_hex32(authenti);
            if sha.is_none() && authenti.is_none() {
                continue;
            }
            let index = list.entries.len();
            list.entries.push(KnownDriver {
                category,
                loads_despite_hvci: *hvci == "1",
                id: (*id).chars().take(64).collect(),
                file: (*file).chars().take(64).collect(),
            });
            if let Some(h) = sha {
                list.by_sha256.entry(h).or_insert(index);
            }
            if let Some(h) = authenti {
                list.by_authentihash.entry(h).or_insert(index);
            }
        }
        list
    }

    /// Anzahl Einträge.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Leer?
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Stand der Liste (`JJJJ-MM-TT`).
    #[must_use]
    pub fn date(&self) -> Option<&str> {
        self.date.as_deref()
    }

    /// Sucht eine Datei über ihre Prüfsummen (bösartig vor verwundbar).
    #[must_use]
    pub fn lookup(&self, hashes: &DriverHashes) -> Option<&KnownDriver> {
        let by_sha = self.by_sha256.get(&hashes.sha256);
        let by_auth = hashes
            .authentihash
            .as_ref()
            .and_then(|h| self.by_authentihash.get(h));
        let mut found: Vec<&KnownDriver> = [by_sha, by_auth]
            .into_iter()
            .flatten()
            .filter_map(|i| self.entries.get(*i))
            .collect();
        found.sort_by_key(|d| d.category != DriverCategory::Malicious);
        found.into_iter().next()
    }
}

/// Die gebündelte Liste (einmal gelesen).
#[must_use]
pub fn list() -> &'static DriverList {
    static PARSED: LazyLock<DriverList> = LazyLock::new(|| DriverList::parse(LIST));
    &PARSED
}

/// Prüfsummen einer Treiberdatei.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriverHashes {
    /// SHA-256 der ganzen Datei.
    pub sha256: [u8; 32],
    /// SHA-256-Authenticode-Hash (ohne Signatur), falls die Datei ein PE ist.
    pub authentihash: Option<[u8; 32]>,
}

impl DriverHashes {
    /// Berechnet beide Prüfsummen.
    #[must_use]
    pub fn of(bytes: &[u8]) -> Self {
        Self {
            sha256: Sha256::digest(bytes).into(),
            authentihash: authentihash(bytes),
        }
    }

    /// SHA-256 als Hex-Text.
    #[must_use]
    pub fn sha256_hex(&self) -> String {
        self.sha256.iter().map(|b| format!("{b:02x}")).collect()
    }
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// Authenticode-Hash (SHA-256) eines PE: die Datei ohne Prüfsummenfeld, ohne den Eintrag des
/// Zertifikatsverzeichnisses und ohne die Zertifikatstabelle selbst. `None`, wenn kein PE.
#[must_use]
pub fn authentihash(bytes: &[u8]) -> Option<[u8; 32]> {
    if bytes.get(..2)? != b"MZ" {
        return None;
    }
    let pe = usize::try_from(u32_at(bytes, 0x3c)?).ok()?;
    if bytes.get(pe..pe.checked_add(4)?)? != b"PE\0\0" {
        return None;
    }
    let opt = pe.checked_add(24)?;
    let (rva_count_at, dirs) = match u16_at(bytes, opt)? {
        0x10b => (opt + 92, opt + 96),
        0x20b => (opt + 108, opt + 112),
        _ => return None,
    };
    let checksum = opt + 64;
    if u32_at(bytes, rva_count_at)? <= 4 {
        return None;
    }
    let security = dirs + 4 * 8;
    let cert_offset = usize::try_from(u32_at(bytes, security)?).ok()?;
    let cert_size = usize::try_from(u32_at(bytes, security + 4)?).ok()?;
    let after_entry = security + 8;
    if after_entry > bytes.len() {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(&bytes[..checksum]);
    hasher.update(&bytes[checksum + 4..security]);
    let cert_end = cert_offset.checked_add(cert_size);
    match cert_end {
        Some(end) if cert_size > 0 && cert_offset >= after_entry && end <= bytes.len() => {
            hasher.update(&bytes[after_entry..cert_offset]);
            hasher.update(&bytes[end..]);
        }
        _ => hasher.update(&bytes[after_entry..]),
    }
    Some(hasher.finalize().into())
}

/// Plausibler Windows-Pfad ohne `..`, `/` und Steuerzeichen.
fn plausible(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() >= 4
        && b.len() <= 520
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && b[2] == b'\\'
        && !path.split('\\').any(|part| part == "..")
        && !path.chars().any(|c| c.is_control() || c == '/')
}

fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| text.get(prefix.len()..))
        .flatten()
}

/// Datei eines Treiberdienstes aus `ImagePath` (fehlt er, gilt
/// `System32\drivers\<Dienst>.sys`). `system_root` z. B. `C:\Windows`.
#[must_use]
pub fn driver_path(image: Option<&str>, service: &str, system_root: &str) -> Option<String> {
    let root = system_root.trim_end_matches('\\');
    let image = image
        .map(|i| i.trim().trim_matches('"'))
        .filter(|i| !i.is_empty());
    let path = match image {
        None => format!(r"{root}\System32\drivers\{service}.sys"),
        Some(i) => kernel_path(i, root)?,
    };
    plausible(&path).then_some(path)
}

/// Kernel-Schreibweise eines Pfads (`\SystemRoot\…`, `\??\C:\…`, `System32\…`, `\Windows\…`)
/// als Dateipfad. `\Device\…` und Unbekanntes ergeben `None`.
#[must_use]
pub fn kernel_path(path: &str, system_root: &str) -> Option<String> {
    let root = system_root.trim_end_matches('\\');
    let out = if let Some(rest) = strip_prefix_ci(path, r"\SystemRoot\")
        .or_else(|| strip_prefix_ci(path, r"%SystemRoot%\"))
        .or_else(|| strip_prefix_ci(path, r"%windir%\"))
    {
        format!(r"{root}\{rest}")
    } else if let Some(rest) = strip_prefix_ci(path, r"\??\") {
        rest.to_owned()
    } else if strip_prefix_ci(path, r"System32\").is_some()
        || strip_prefix_ci(path, r"SysWOW64\").is_some()
    {
        format!(r"{root}\{path}")
    } else if strip_prefix_ci(path, r"\Device\").is_some() {
        return None;
    } else if path.starts_with('\\') && !path.starts_with(r"\\") {
        // `\Windows\…` ohne Laufwerk: Laufwerk des Windows-Ordners.
        format!("{}{path}", root.get(..2)?)
    } else {
        path.to_owned()
    };
    plausible(&out).then_some(out)
}

/// Liegt der Pfad im Windows-Ordner?
#[must_use]
pub fn in_system_root(path: &str, system_root: &str) -> bool {
    let root = system_root.trim_end_matches('\\');
    strip_prefix_ci(path, root).is_some_and(|rest| rest.starts_with('\\'))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Kleines PE32+ mit Zertifikatstabelle am Ende (nur Kopf, harmlos).
    fn pe(with_cert: bool) -> Vec<u8> {
        let mut b = vec![0u8; 0x400];
        b[0] = b'M';
        b[1] = b'Z';
        b[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        b[0x80..0x84].copy_from_slice(b"PE\0\0");
        let opt = 0x80 + 24;
        b[opt..opt + 2].copy_from_slice(&0x20bu16.to_le_bytes());
        b[opt + 64..opt + 68].copy_from_slice(&0xdead_beefu32.to_le_bytes());
        b[opt + 108..opt + 112].copy_from_slice(&16u32.to_le_bytes());
        for (i, byte) in b.iter_mut().enumerate().skip(0x200) {
            *byte = u8::try_from(i % 251).unwrap_or(0);
        }
        if with_cert {
            let sec = opt + 112 + 32;
            b[sec..sec + 4].copy_from_slice(&0x300u32.to_le_bytes());
            b[sec + 4..sec + 8].copy_from_slice(&0x100u32.to_le_bytes());
        }
        b
    }

    #[test]
    fn authentihash_ohne_pruefsumme_eintrag_und_signatur() {
        let b = pe(true);
        let opt = 0x80 + 24;
        let sec = opt + 112 + 32;
        let mut expected = Sha256::new();
        expected.update(&b[..opt + 64]);
        expected.update(&b[opt + 68..sec]);
        expected.update(&b[sec + 8..0x300]);
        let expected: [u8; 32] = expected.finalize().into();
        assert_eq!(authentihash(&b), Some(expected));

        // Andere Prüfsumme bzw. andere Signatur: gleicher Hash.
        let mut c = b.clone();
        c[opt + 64] ^= 0xff;
        c[0x350] ^= 0xff;
        assert_eq!(authentihash(&c), Some(expected));
        // Geänderter Code: anderer Hash.
        let mut d = b.clone();
        d[0x250] ^= 0xff;
        assert_ne!(authentihash(&d), Some(expected));
        // Ohne Signatur: alles außer Prüfsumme und Verzeichniseintrag.
        let plain = pe(false);
        let mut e = Sha256::new();
        e.update(&plain[..opt + 64]);
        e.update(&plain[opt + 68..sec]);
        e.update(&plain[sec + 8..]);
        let e: [u8; 32] = e.finalize().into();
        assert_eq!(authentihash(&plain), Some(e));
    }

    #[test]
    fn kein_pe_kein_authentihash() {
        assert_eq!(authentihash(b"hallo"), None);
        let mut b = pe(false);
        b[0x80] = b'X';
        assert_eq!(authentihash(&b), None);
        let mut b = pe(false);
        b[0x3c..0x40].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(authentihash(&b), None);
        // Zertifikat hinter dem Dateiende: Datei wird ganz (ohne Eintrag) gehasht.
        let mut b = pe(true);
        let sec = 0x80 + 24 + 112 + 32;
        b[sec + 4..sec + 8].copy_from_slice(&0xffffu32.to_le_bytes());
        assert!(authentihash(&b).is_some());
    }

    #[test]
    fn liste_lesen_und_nachschlagen() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let c = "c".repeat(64);
        let text = format!(
            "# Kopf\n# Stand: 2026-10-19 · Einträge: 3\n{a}\t-\tv\t1\tid-1\tvuln.sys\n-\t{b}\tm\t0\tid-2\tevil.sys\nkaputt\n{c}\t{b}\tx\t0\tid\tf\n"
        );
        let list = DriverList::parse(&text);
        assert_eq!(list.len(), 2);
        assert_eq!(list.date(), Some("2026-10-19"));
        let hit = list
            .lookup(&DriverHashes {
                sha256: parse_hex32(&a).unwrap(),
                authentihash: None,
            })
            .unwrap();
        assert_eq!(hit.category, DriverCategory::Vulnerable);
        assert!(hit.loads_despite_hvci);
        // Über den Authenticode-Hash gefunden – bösartig hat Vorrang.
        let hit = list
            .lookup(&DriverHashes {
                sha256: parse_hex32(&a).unwrap(),
                authentihash: parse_hex32(&b),
            })
            .unwrap();
        assert_eq!(hit.file, "evil.sys");
        assert!(
            list.lookup(&DriverHashes {
                sha256: parse_hex32(&c).unwrap(),
                authentihash: None,
            })
            .is_none()
        );
    }

    #[test]
    fn gebuendelte_liste_ist_lesbar() {
        let list = list();
        assert!(list.len() > 1000, "{}", list.len());
        assert!(list.date().is_some());
        assert!(
            list.entries
                .iter()
                .any(|d| d.category == DriverCategory::Malicious)
        );
    }

    #[test]
    fn treiberpfade() {
        let root = r"C:\Windows";
        assert_eq!(
            driver_path(None, "beep", root).as_deref(),
            Some(r"C:\Windows\System32\drivers\beep.sys")
        );
        assert_eq!(
            driver_path(Some(r"\SystemRoot\System32\drivers\x.sys"), "x", root).as_deref(),
            Some(r"C:\Windows\System32\drivers\x.sys")
        );
        assert_eq!(
            driver_path(Some(r"system32\DRIVERS\y.sys"), "y", root).as_deref(),
            Some(r"C:\Windows\system32\DRIVERS\y.sys")
        );
        assert_eq!(
            driver_path(Some(r"\??\D:\Tools\z.sys"), "z", root).as_deref(),
            Some(r"D:\Tools\z.sys")
        );
        assert_eq!(
            driver_path(Some(r#""C:\Program Files\A\a.sys""#), "a", root).as_deref(),
            Some(r"C:\Program Files\A\a.sys")
        );
        assert_eq!(
            driver_path(Some(r"\Device\HarddiskVolume3\a.sys"), "a", root),
            None
        );
        assert_eq!(driver_path(Some(r"C:\a\..\b.sys"), "b", root), None);
        assert_eq!(
            driver_path(Some(r"C:\Windows\System32\drivers/../../x.sys"), "x", root),
            None
        );
        assert_eq!(
            kernel_path(r"\WINDOWS\system32\ntoskrnl.exe", root).as_deref(),
            Some(r"C:\WINDOWS\system32\ntoskrnl.exe")
        );
        assert_eq!(kernel_path(r"\\server\share\a.sys", root), None);
        assert!(in_system_root(r"c:\windows\System32\drivers\x.sys", root));
        assert!(!in_system_root(r"C:\WindowsApps\x.sys", root));
    }
}
