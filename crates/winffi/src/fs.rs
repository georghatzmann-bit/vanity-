//! Dateien sicher öffnen, anlegen und löschen – für die Quarantäne mit den Rechten des
//! Nutzers (der Aufrufer wechselt vorher die Identität, siehe [`crate::pipe`]).
//!
//! - Keine Links/Abzweigungen: Die letzte Pfadkomponente wird nie verfolgt
//!   (`FILE_FLAG_OPEN_REPARSE_POINT`), Zwischenordner prüft der Vergleich des tatsächlichen
//!   Pfads (`GetFinalPathNameByHandleW`) mit dem angefragten.
//! - Exklusiv geöffnet (keine Freigabe für andere): Niemand kann die Datei zwischen
//!   Verschlüsseln und Entfernen ändern.
//! - Löschen über das Handle (`FileDispositionInfo`) statt über den Namen.
//! - Geschützte Ordner werden mit ihrer Zugriffsliste **angelegt**; vorhandene Ordner müssen
//!   SYSTEM oder den Administratoren gehören.

use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::ptr;

use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, GENERIC_READ, GENERIC_WRITE};
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
    FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_FLAG_SEQUENTIAL_SCAN, FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
    FileDispositionInfo, GetFileInformationByHandle, GetFinalPathNameByHandleW, OPEN_EXISTING,
    READ_CONTROL, SetFileInformationByHandle, VOLUME_NAME_DOS, WRITE_DAC,
};

use crate::util::{SecurityDescriptor, own, sid_is, wide};

/// Datenordner (Tresor, Schlüssel, Prüfprotokoll): nur SYSTEM und Administratoren.
pub const DATA_DIR_SDDL: &str = "D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)";

fn info(handle: &OwnedHandle) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    // SAFETY: Nullinitialisierung ist für diese reine Datenstruktur gültig.
    // aegis-unsafe: winffi-file-info-zeroed
    #[allow(unsafe_code)]
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `handle` ist ein gültiges Datei-Handle, `info` ein gültiger Ausgabezeiger.
    // aegis-unsafe: winffi-file-info
    #[allow(unsafe_code)]
    let ok = unsafe { GetFileInformationByHandle(handle.as_raw_handle(), &mut info) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info)
}

/// Tatsächlicher Pfad eines geöffneten Objekts (`\\?\C:\…`).
///
/// # Errors
/// Handle ungültig.
pub fn final_path(file: &File) -> io::Result<PathBuf> {
    let mut buffer = vec![0u16; 1024];
    loop {
        // SAFETY: `file` ist ein gültiges Handle; `buffer` hat die angegebene Länge.
        // aegis-unsafe: winffi-final-path
        #[allow(unsafe_code)]
        let len = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
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
            return Ok(PathBuf::from(OsString::from_wide(&buffer)));
        }
        if len > 64 * 1024 {
            return Err(io::Error::other("Pfad zu lang"));
        }
        buffer.resize(len + 1, 0);
    }
}

fn ensure_same_path(file: &File, requested: &Path) -> io::Result<()> {
    let actual = final_path(file)?;
    if crate::final_path_matches(&actual.to_string_lossy(), &requested.to_string_lossy()) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "Pfad führt über eine Verknüpfung woanders hin ({}) – abgelehnt",
                actual.display()
            ),
        ))
    }
}

/// Öffnet eine Datei zum Isolieren: lesen + löschen, **exklusiv**, ohne Links. Abgelehnt
/// werden Ordner, Links/Abzweigungen (auch in Zwischenordnern) und Dateien mit mehreren
/// Hardlinks (der Inhalt bliebe unter anderem Namen erreichbar).
///
/// # Errors
/// Kein Zugriff (mit den Rechten des Aufrufers), in Benutzung, Link, falscher Typ.
pub fn open_exclusive(path: &Path) -> io::Result<File> {
    let name = wide(path);
    // SAFETY: `name` ist nullterminiert; keine Sicherheitsattribute, keine Vorlage.
    // aegis-unsafe: winffi-open-exclusive
    #[allow(unsafe_code)]
    // Öffnet nur (OPEN_EXISTING) mit Löschrecht; gelöscht wird erst nach Freigabe über
    // `delete_by_handle`.
    // aegis-mutation: winffi-open-exclusive-call
    #[allow(clippy::disallowed_methods)]
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | DELETE | FILE_READ_ATTRIBUTES,
            0,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN,
            ptr::null_mut(),
        )
    };
    let handle = own(handle)?;
    let info = info(&handle)?;
    if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 {
        return Err(io::Error::other(
            "keine reguläre Datei (Links und Ordner werden nicht isoliert)",
        ));
    }
    if info.nNumberOfLinks != 1 {
        return Err(io::Error::other(
            "Datei hat mehrere Hardlinks – Isolieren würde sie nicht entfernen",
        ));
    }
    let file = File::from(handle);
    ensure_same_path(&file, path)?;
    Ok(file)
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
    if let Err(e) = ensure_same_path(&file, path) {
        delete_by_handle(&file)?;
        return Err(e);
    }
    Ok(file)
}

/// Markiert die geöffnete Datei zum Löschen; entfernt wird sie beim Schließen des (einzigen)
/// Handles. Der Name wird dafür nicht erneut aufgelöst.
///
/// # Errors
/// Handle ohne Löschrecht.
pub fn delete_by_handle(file: &File) -> io::Result<()> {
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: `file` ist ein gültiges Handle mit DELETE-Recht; `disposition` lebt bis nach
    // dem Aufruf, die Größe passt zur Struktur.
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
    let info = info(&handle)?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
    {
        return Err(io::Error::other(format!(
            "{} ist kein echter Ordner (Link/Abzweigung) – Dienst startet nicht",
            path.display()
        )));
    }
    let mut owner: PSID = ptr::null_mut();
    let mut owner_sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: `handle` ist gültig mit READ_CONTROL; Ausgabezeiger gültig; `owner` zeigt in
    // `owner_sd`, das unten per LocalFree (SecurityDescriptor) freigegeben wird.
    // aegis-unsafe: winffi-read-owner
    #[allow(unsafe_code)]
    let status = unsafe {
        GetSecurityInfo(
            handle.as_raw_handle(),
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
    let trusted_owner = sid_is(owner, &[WinLocalSystemSid, WinBuiltinAdministratorsSid]);
    drop(owner_sd);
    if !trusted_owner {
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
