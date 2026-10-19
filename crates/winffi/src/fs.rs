//! Dateien sicher öffnen, anlegen und löschen – für die Quarantäne mit den Rechten des
//! Nutzers (der Aufrufer wechselt vorher die Identität, siehe [`crate::pipe`]).
//!
//! - Keine Links/Abzweigungen: Die letzte Pfadkomponente wird nie verfolgt
//!   (`FILE_FLAG_OPEN_REPARSE_POINT`, nur „Namens-Ersatz“-Analysepunkte wie Symlinks und
//!   Abzweigungen gelten als Link – komprimierte Systemdateien, Deduplizierung oder
//!   Cloud-Platzhalter nicht). Zwischenordner prüft der Vergleich des tatsächlichen Pfads
//!   (`GetFinalPathNameByHandleW`, Vergleich wie NTFS mit `CompareStringOrdinal`).
//! - Exklusiv geöffnet (keine Freigabe für andere): Niemand kann die Datei zwischen
//!   Verschlüsseln und Entfernen ändern.
//! - Löschen über das Handle (`FileDispositionInfoEx`, auch schreibgeschützte Dateien).
//! - Geschützte Ordner werden mit ihrer Zugriffsliste **angelegt**; vorhandene Ordner und ihre
//!   Inhalte müssen SYSTEM oder den Administratoren gehören.

use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::ptr;

use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, GENERIC_READ, GENERIC_WRITE, HANDLE};
use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
use windows_sys::Win32::Security::Authorization::{
    GetSecurityInfo, SE_FILE_OBJECT, SetSecurityInfo,
};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, WinBuiltinAdministratorsSid, WinLocalSystemSid,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CREATE_NEW, CreateDirectoryW, CreateFileW, DELETE,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_ATTRIBUTE_TAG_INFO, FILE_DISPOSITION_FLAG_DELETE,
    FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_SEQUENTIAL_SCAN, FILE_NAME_NORMALIZED,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FileAttributeTagInfo, FileDispositionInfo, FileDispositionInfoEx, GetFileInformationByHandle,
    GetFileInformationByHandleEx, GetFinalPathNameByHandleW, GetLongPathNameW, OPEN_EXISTING,
    READ_CONTROL, ReOpenFile, SetFileInformationByHandle, VOLUME_NAME_DOS, WRITE_DAC,
};

use crate::util::{SecurityDescriptor, own, sid_is, wide};

/// Datenordner (Tresor, Schlüssel, Prüfprotokoll): nur SYSTEM und Administratoren.
pub const DATA_DIR_SDDL: &str = "D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)";

/// Analysepunkt, der auf einen anderen Namen verweist (Symlink, Abzweigung) – Bit 29 des Tags.
const NAME_SURROGATE_BIT: u32 = 0x2000_0000;

fn info(handle: HANDLE) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    // SAFETY: Nullinitialisierung ist für diese reine Datenstruktur gültig.
    // aegis-unsafe: winffi-file-info-zeroed
    #[allow(unsafe_code)]
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `handle` ist ein gültiges Datei-Handle, `info` ein gültiger Ausgabezeiger.
    // aegis-unsafe: winffi-file-info
    #[allow(unsafe_code)]
    let ok = unsafe { GetFileInformationByHandle(handle, &mut info) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info)
}

/// Attribute und Analysepunkt-Tag.
fn tag_info(handle: HANDLE) -> io::Result<FILE_ATTRIBUTE_TAG_INFO> {
    let mut tag = FILE_ATTRIBUTE_TAG_INFO {
        FileAttributes: 0,
        ReparseTag: 0,
    };
    // SAFETY: `handle` ist gültig; Puffer und Größe passen zu FILE_ATTRIBUTE_TAG_INFO.
    // aegis-unsafe: winffi-tag-info
    #[allow(unsafe_code)]
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileAttributeTagInfo,
            (&raw mut tag).cast(),
            u32::try_from(size_of::<FILE_ATTRIBUTE_TAG_INFO>()).unwrap_or(8),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(tag)
}

fn is_surrogate(tag: &FILE_ATTRIBUTE_TAG_INFO) -> bool {
    tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        && tag.ReparseTag & NAME_SURROGATE_BIT != 0
}

/// Tatsächlicher Pfad eines geöffneten Objekts als UTF-16 (`\\?\C:\…`).
fn final_path_wide(handle: HANDLE) -> io::Result<Vec<u16>> {
    let mut buffer = vec![0u16; 1024];
    loop {
        // SAFETY: `handle` ist ein gültiges Handle; `buffer` hat die angegebene Länge.
        // aegis-unsafe: winffi-final-path
        #[allow(unsafe_code)]
        let len = unsafe {
            GetFinalPathNameByHandleW(
                handle,
                buffer.as_mut_ptr(),
                u32::try_from(buffer.len()).unwrap_or(u32::MAX),
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        };
        let len = usize::try_from(len).unwrap_or(usize::MAX);
        if len == 0 {
            return Err(io::Error::last_os_error());
        }
        if len < buffer.len() {
            buffer.truncate(len);
            return Ok(buffer);
        }
        if len > 64 * 1024 {
            return Err(io::Error::other("Pfad zu lang"));
        }
        buffer.resize(len + 1, 0);
    }
}

/// Tatsächlicher Pfad eines geöffneten Objekts (`\\?\C:\…`).
///
/// # Errors
/// Handle ungültig.
pub fn final_path(file: &File) -> io::Result<PathBuf> {
    final_path_wide(file.as_raw_handle()).map(|w| PathBuf::from(OsString::from_wide(&w)))
}

/// Schreibt Kurznamen (`RUNNER~1`) in die langen Namen um – ohne Links aufzulösen. So zeigt
/// ein Plan den echten Namen, und der Vergleich mit dem tatsächlichen Pfad passt.
///
/// # Errors
/// Pfad existiert nicht oder ist nicht lesbar.
pub fn long_path(path: &Path) -> io::Result<PathBuf> {
    let name = wide(path);
    let mut buffer = vec![0u16; 1024];
    loop {
        // SAFETY: `name` ist nullterminiert; `buffer` hat die angegebene Länge.
        // aegis-unsafe: winffi-long-path
        #[allow(unsafe_code)]
        let len = unsafe {
            GetLongPathNameW(
                name.as_ptr(),
                buffer.as_mut_ptr(),
                u32::try_from(buffer.len()).unwrap_or(u32::MAX),
            )
        };
        let len = usize::try_from(len).unwrap_or(usize::MAX);
        if len == 0 {
            return Err(io::Error::last_os_error());
        }
        if len < buffer.len() {
            buffer.truncate(len);
            return Ok(PathBuf::from(OsString::from_wide(&buffer)));
        }
        if len > 64 * 1024 {
            return Err(io::Error::other("Pfad zu lang"));
        }
        buffer.resize(len + 1, 0);
    }
}

/// Vergleicht zwei Texte ohne Groß-/Kleinschreibung wie NTFS (`CompareStringOrdinal`).
#[must_use]
pub fn ordinal_eq_ignore_case(a: &str, b: &str) -> bool {
    let a: Vec<u16> = a.encode_utf16().collect();
    let b: Vec<u16> = b.encode_utf16().collect();
    ordinal_equal_ignore_case(&a, &b)
}

/// Vergleich ohne Groß-/Kleinschreibung wie im Dateisystem (ordinal, ohne Sonderfaltungen).
fn ordinal_equal_ignore_case(a: &[u16], b: &[u16]) -> bool {
    let (Ok(la), Ok(lb)) = (i32::try_from(a.len()), i32::try_from(b.len())) else {
        return false;
    };
    // SAFETY: Beide Zeiger zeigen auf Puffer der angegebenen Länge (keine Nullterminierung
    // nötig, da die Längen übergeben werden).
    // aegis-unsafe: winffi-compare-ordinal
    #[allow(unsafe_code)]
    let result = unsafe { CompareStringOrdinal(a.as_ptr(), la, b.as_ptr(), lb, 1) };
    result == CSTR_EQUAL
}

fn ensure_same_path(handle: HANDLE, requested: &Path) -> io::Result<()> {
    let actual = final_path_wide(handle)?;
    let requested: Vec<u16> = requested.as_os_str().encode_wide().collect();
    if crate::final_path_matches_with(&actual, &requested, ordinal_equal_ignore_case) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "Pfad führt über eine Verknüpfung woanders hin ({}) – abgelehnt",
                OsString::from_wide(&actual).to_string_lossy()
            ),
        ))
    }
}

/// Prüft an einem bereits geöffneten Handle, dass es genau `requested` ist – nicht über einen
/// Link oder eine Abzweigung (auch in Zwischenordnern) erreicht.
///
/// # Errors
/// Pfad weicht ab oder Handle ungültig.
pub fn ensure_file_at(file: &File, requested: &Path) -> io::Result<()> {
    ensure_same_path(file.as_raw_handle(), requested)
}

/// Öffnet ein Objekt nur zum Lesen der Attribute, ohne Analysepunkten zu folgen.
fn open_attributes(path: &Path, directory: bool) -> io::Result<OwnedHandle> {
    let name = wide(path);
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            0
        };
    // SAFETY: `name` ist nullterminiert; nur Attribut-Zugriff (zählt nicht für Freigabe-
    // Konflikte), alle Freigaben gesetzt – andere Programme werden nicht gestört.
    // aegis-unsafe: winffi-open-attributes
    #[allow(unsafe_code)]
    // Nur Lesen der Attribute (FILE_READ_ATTRIBUTES), OPEN_EXISTING.
    // aegis-mutation: winffi-open-attributes-call
    #[allow(clippy::disallowed_methods)]
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            OPEN_EXISTING,
            flags,
            ptr::null_mut(),
        )
    };
    own(handle)
}

/// Ist der Pfad ein Link/eine Abzweigung (Namens-Ersatz)? Andere Analysepunkte (WOF-
/// Komprimierung, Deduplizierung, Cloud-Platzhalter) sind normale Dateien.
///
/// # Errors
/// Nicht lesbar.
pub fn is_name_surrogate(path: &Path) -> io::Result<bool> {
    let directory = std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir());
    let handle = open_attributes(path, directory)?;
    Ok(is_surrogate(&tag_info(handle.as_raw_handle())?))
}

/// Öffnet eine Datei zum Isolieren: lesen + löschen, **exklusiv**, ohne Links. Abgelehnt
/// werden Ordner, Links/Abzweigungen (auch in Zwischenordnern) und Dateien mit mehreren
/// Hardlinks (der Inhalt bliebe unter anderem Namen erreichbar).
///
/// Ablauf: erst nur Attribute öffnen (ohne Analysepunkten zu folgen) und prüfen, dann über
/// dasselbe Dateiobjekt (`ReOpenFile`, kein erneutes Auflösen des Namens) exklusiv öffnen.
///
/// # Errors
/// Kein Zugriff (mit den Rechten des Aufrufers), in Benutzung, Link, falscher Typ.
pub fn open_exclusive(path: &Path) -> io::Result<File> {
    let probe = open_attributes(path, false)?;
    let tag = tag_info(probe.as_raw_handle())?;
    if tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 || is_surrogate(&tag) {
        return Err(io::Error::other(
            "keine reguläre Datei (Links und Ordner werden nicht isoliert)",
        ));
    }
    // Andere Analysepunkte (z. B. komprimierte Systemdateien) normal öffnen, damit der Inhalt
    // gelesen wird und nicht die Analysepunkt-Daten.
    let flags = FILE_FLAG_SEQUENTIAL_SCAN
        | if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
            FILE_FLAG_OPEN_REPARSE_POINT
        } else {
            0
        };
    // SAFETY: `probe` ist ein gültiges Handle; ReOpenFile öffnet dasselbe Dateiobjekt neu.
    // aegis-unsafe: winffi-open-exclusive
    #[allow(unsafe_code)]
    let handle = own(unsafe {
        ReOpenFile(
            probe.as_raw_handle(),
            GENERIC_READ | DELETE | FILE_READ_ATTRIBUTES,
            0,
            flags,
        )
    })?;
    drop(probe);
    let info = info(handle.as_raw_handle())?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        return Err(io::Error::other("keine reguläre Datei"));
    }
    if info.nNumberOfLinks != 1 {
        return Err(io::Error::other(
            "Datei hat mehrere Hardlinks – Isolieren würde sie nicht entfernen",
        ));
    }
    ensure_same_path(handle.as_raw_handle(), path)?;
    Ok(File::from(handle))
}

/// Legt eine **neue** Datei an (nie überschreiben, ohne Links) – für das Wiederherstellen.
/// Führt der Pfad über eine Verknüpfung woanders hin, wird die neue Datei sofort wieder
/// entfernt und abgelehnt.
///
/// # Errors
/// Ziel existiert, kein Zugriff, Link im Pfad.
pub fn create_new(path: &Path) -> io::Result<File> {
    let name = wide(path);
    // SAFETY: `name` ist nullterminiert; CREATE_NEW schlägt fehl, wenn das Ziel existiert.
    // aegis-unsafe: winffi-create-new
    #[allow(unsafe_code)]
    // aegis-mutation: winffi-create-new-file
    #[allow(clippy::disallowed_methods)]
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE | DELETE,
            0,
            ptr::null(),
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    let file = File::from(own(handle)?);
    if let Err(e) = ensure_same_path(file.as_raw_handle(), path) {
        delete_by_handle(&file)?;
        return Err(e);
    }
    Ok(file)
}

/// Markiert die geöffnete Datei zum Löschen; entfernt wird sie beim Schließen des (einzigen)
/// Handles. Der Name wird dafür nicht erneut aufgelöst. Schreibgeschützte Dateien werden
/// ebenfalls entfernt (ab Windows 10 1809; sonst wie bisher mit Fehlermeldung).
///
/// # Errors
/// Handle ohne Löschrecht.
pub fn delete_by_handle(file: &File) -> io::Result<()> {
    let ex = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE
            | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
            | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    // SAFETY: `file` ist ein gültiges Handle mit DELETE-Recht; `ex` lebt bis nach dem Aufruf,
    // die Größe passt zur Struktur.
    // aegis-unsafe: winffi-delete-by-handle-ex
    #[allow(unsafe_code)]
    // aegis-mutation: winffi-delete-by-handle-ex-call
    #[allow(clippy::disallowed_methods)]
    let ok = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfoEx,
            (&raw const ex).cast(),
            u32::try_from(size_of::<FILE_DISPOSITION_INFO_EX>()).unwrap_or(4),
        )
    };
    if ok != 0 {
        return Ok(());
    }
    // Älteres Windows oder Dateisystem ohne „Ex“: klassisches Löschen.
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: wie oben, mit FILE_DISPOSITION_INFO.
    // aegis-unsafe: winffi-delete-by-handle
    #[allow(unsafe_code)]
    // aegis-mutation: winffi-delete-by-handle-call
    #[allow(clippy::disallowed_methods)]
    let ok = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&raw const disposition).cast(),
            u32::try_from(size_of::<FILE_DISPOSITION_INFO>()).unwrap_or(1),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Liest den Besitzer und prüft, ob es SYSTEM oder die Administratoren sind.
fn handle_owner_trusted(handle: HANDLE) -> io::Result<bool> {
    let mut owner: PSID = ptr::null_mut();
    let mut owner_sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: `handle` ist gültig mit READ_CONTROL; Ausgabezeiger gültig; `owner` zeigt in
    // `owner_sd`, das per LocalFree (SecurityDescriptor) freigegeben wird.
    // aegis-unsafe: winffi-read-owner
    #[allow(unsafe_code)]
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut owner_sd,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(
            i32::try_from(status).unwrap_or(i32::MAX),
        ));
    }
    let owner_sd = SecurityDescriptor(owner_sd);
    let trusted = sid_is(owner, &[WinLocalSystemSid, WinBuiltinAdministratorsSid]);
    drop(owner_sd);
    Ok(trusted)
}

/// Gehört die Datei bzw. der Ordner SYSTEM oder den Administratoren und ist kein Link?
/// (Prüfung vorhandener Inhalte des Datenordners beim Start.)
///
/// # Errors
/// Nicht lesbar.
pub fn owner_is_trusted(path: &Path) -> io::Result<bool> {
    let name = wide(path);
    // SAFETY: `name` ist nullterminiert; nur READ_CONTROL + Attribute, ohne Links zu folgen.
    // aegis-unsafe: winffi-open-for-owner
    #[allow(unsafe_code)]
    // Nur Lesen von Besitzer und Attributen (OPEN_EXISTING).
    // aegis-mutation: winffi-open-for-owner-call
    #[allow(clippy::disallowed_methods)]
    let handle = own(unsafe {
        CreateFileW(
            name.as_ptr(),
            READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    })?;
    if is_surrogate(&tag_info(handle.as_raw_handle())?) {
        return Ok(false);
    }
    handle_owner_trusted(handle.as_raw_handle())
}

/// Legt einen Ordner mit der Zugriffsliste `DATA_DIR_SDDL` an. Existiert er schon, muss er
/// ein echter Ordner (kein Link) sein und SYSTEM oder den Administratoren gehören – sonst
/// hätte ihn ein Nutzer vorher anlegen und als Besitzer die Rechte zurückholen können. Dann
/// wird die Zugriffsliste (geschützt, ohne Vererbung) neu gesetzt.
///
/// # Errors
/// Ordner gehört jemand anderem, ist ein Link oder ist nicht absicherbar.
pub fn create_secure_dir(path: &Path) -> io::Result<()> {
    let sd = SecurityDescriptor::from_sddl(DATA_DIR_SDDL)?;
    let attributes = sd.attributes();
    let name = wide(path);
    // SAFETY: `name` ist nullterminiert; `attributes` verweist auf `sd`, das lebt.
    // aegis-unsafe: winffi-create-secure-dir
    #[allow(unsafe_code)]
    // aegis-mutation: winffi-create-secure-dir-call
    #[allow(clippy::disallowed_methods)]
    let ok = unsafe { CreateDirectoryW(name.as_ptr(), &attributes) };
    if ok != 0 {
        return Ok(());
    }
    let err = io::Error::last_os_error();
    if err.raw_os_error() != i32::try_from(ERROR_ALREADY_EXISTS).ok() {
        return Err(err);
    }
    // Vorhanden: als Ordner öffnen, ohne einer Abzweigung zu folgen.
    // SAFETY: `name` ist nullterminiert; BACKUP_SEMANTICS ist zum Öffnen von Ordnern nötig.
    // aegis-unsafe: winffi-open-existing-dir
    #[allow(unsafe_code)]
    // Öffnet den eigenen Datenordner, um Besitzer und Zugriffsliste zu prüfen/setzen.
    // aegis-mutation: winffi-open-existing-dir-call
    #[allow(clippy::disallowed_methods)]
    let handle = own(unsafe {
        CreateFileW(
            name.as_ptr(),
            READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    })?;
    let attrs = info(handle.as_raw_handle())?.dwFileAttributes;
    if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 || attrs & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(io::Error::other(format!(
            "{} ist kein echter Ordner (Link/Abzweigung) – Dienst startet nicht",
            path.display()
        )));
    }
    if !handle_owner_trusted(handle.as_raw_handle())? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "{} gehört weder SYSTEM noch den Administratoren (vermutlich von einem Nutzer vorab angelegt) – bitte prüfen und entfernen; der Dienst startet nicht",
                path.display()
            ),
        ));
    }
    let dacl = sd.dacl()?;
    // SAFETY: `handle` hat WRITE_DAC; `dacl` zeigt in `sd`, das bis nach dem Aufruf lebt;
    // Besitzer, Gruppe und SACL bleiben unverändert (null).
    // aegis-unsafe: service-dacl-apply
    #[allow(unsafe_code)]
    // aegis-mutation: service-dacl-apply-acl
    #[allow(clippy::disallowed_methods)]
    let status = unsafe {
        SetSecurityInfo(
            handle.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            dacl,
            ptr::null(),
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(
            i32::try_from(status).unwrap_or(i32::MAX),
        ));
    }
    Ok(())
}
