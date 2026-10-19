//! Windows-FFI der AEGIS Suite – **die einzige Bibliothek mit `unsafe`**.
//!
//! Jeder `unsafe`-Block ist klein, mit `// SAFETY:` begründet, mit `// aegis-unsafe:`
//! markiert und in `crates/core/mutation-allowlist.txt` eingetragen (vom Mutations-Wächter
//! erzwungen). Alle anderen Crates nutzen nur die sicheren Hüllen von hier.
//!
//! Auf anderen Systemen ist das Crate leer.
#![deny(unsafe_code)]

#[cfg(windows)]
pub use pipe::*;

#[cfg(windows)]
mod pipe {

    use std::fs::File;
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::Path;
    use std::ptr;

    use windows_sys::Win32::Foundation::{ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE, LocalFree};
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1, SE_FILE_OBJECT,
        SetNamedSecurityInfoW,
    };
    use windows_sys::Win32::Security::{
        ACL, DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };

    /// Name der Pipe des Dienstes.
    pub const PIPE_NAME: &str = r"\\.\pipe\aegis-service";
    /// Pipe: geschützt (keine geerbten Rechte); SYSTEM und Administratoren voll, interaktiv
    /// angemeldete Nutzer lesen/schreiben. Netzwerk-Clients lehnt die Pipe zusätzlich ab.
    pub const PIPE_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)";
    /// Datenordner (Tresor, Schlüssel, Prüfprotokoll): nur SYSTEM und Administratoren.
    pub const DATA_DIR_SDDL: &str = "D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Sicherheitsbeschreibung aus SDDL; wird beim Verwerfen freigegeben.
    struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

    impl SecurityDescriptor {
        fn from_sddl(sddl: &str) -> io::Result<Self> {
            let text = wide(sddl);
            let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
            // SAFETY: `text` ist nullterminiert und lebt bis nach dem Aufruf; `sd` ist ein
            // gültiger Ausgabezeiger; die optionale Längenangabe ist null.
            // aegis-unsafe: service-sddl-parse
            #[allow(unsafe_code)]
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    text.as_ptr(),
                    SDDL_REVISION_1,
                    &mut sd,
                    ptr::null_mut(),
                )
            };
            if ok == 0 || sd.is_null() {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(sd))
        }
    }

    impl Drop for SecurityDescriptor {
        fn drop(&mut self) {
            // SAFETY: `self.0` wurde von ConvertStringSecurityDescriptorToSecurityDescriptorW
            // mit LocalAlloc angelegt und wird genau einmal freigegeben.
            // aegis-unsafe: service-sddl-free
            #[allow(unsafe_code)]
            let _ = unsafe { LocalFree(self.0) };
        }
    }

    /// Legt eine Pipe-Instanz an. `first = true` für die erste Instanz: Dann schlägt das
    /// Anlegen fehl, wenn ein anderes Programm den Namen schon belegt (Schutz vor Übernahme).
    ///
    /// # Errors
    /// Name belegt, Zugriffsliste ungültig.
    pub fn create_instance(name: &str, first: bool) -> io::Result<OwnedHandle> {
        let sd = SecurityDescriptor::from_sddl(PIPE_SDDL)?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>()).unwrap_or(24),
            lpSecurityDescriptor: sd.0,
            bInheritHandle: 0,
        };
        let name = wide(name);
        let open_mode = PIPE_ACCESS_DUPLEX
            | if first {
                FILE_FLAG_FIRST_PIPE_INSTANCE
            } else {
                0
            };
        // SAFETY: `name` ist nullterminiert, `attributes` verweist auf eine gültige
        // Sicherheitsbeschreibung, die bis nach dem Aufruf lebt (`sd`).
        // aegis-unsafe: service-pipe-create
        #[allow(unsafe_code)]
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                open_mode,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                64 * 1024,
                64 * 1024,
                0,
                &attributes,
            )
        };
        if handle == INVALID_HANDLE_VALUE || handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `handle` ist ein gültiges, uns allein gehörendes Handle (gerade angelegt).
        // aegis-unsafe: service-pipe-own-handle
        #[allow(unsafe_code)]
        let owned = unsafe { OwnedHandle::from_raw_handle(handle) };
        Ok(owned)
    }

    /// Wartet (blockierend), bis sich ein Client verbindet, und liefert die Verbindung.
    ///
    /// # Errors
    /// Verbindungsfehler.
    pub fn accept(instance: OwnedHandle) -> io::Result<File> {
        // SAFETY: Das Handle ist eine gültige Pipe-Instanz; synchroner Aufruf ohne OVERLAPPED.
        // aegis-unsafe: service-pipe-connect
        #[allow(unsafe_code)]
        let ok = unsafe { ConnectNamedPipe(instance.as_raw_handle(), ptr::null_mut()) };
        if ok == 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() != i32::try_from(ERROR_PIPE_CONNECTED).ok() {
                return Err(err);
            }
        }
        Ok(File::from(instance))
    }

    /// Setzt die Zugriffsliste des Datenordners auf SYSTEM und Administratoren (geschützt,
    /// ohne geerbte Rechte). Der Ordner muss existieren.
    ///
    /// # Errors
    /// Fehlende Rechte (Dienst läuft nicht als SYSTEM/Administrator).
    pub fn secure_data_dir(path: &Path) -> io::Result<()> {
        let sd = SecurityDescriptor::from_sddl(DATA_DIR_SDDL)?;
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl: *mut ACL = ptr::null_mut();
        // SAFETY: `sd.0` ist eine gültige Sicherheitsbeschreibung; alle Ausgabezeiger gültig.
        // aegis-unsafe: service-dacl-read
        #[allow(unsafe_code)]
        let ok =
            unsafe { GetSecurityDescriptorDacl(sd.0, &mut present, &mut dacl, &mut defaulted) };
        if ok == 0 || present == 0 || dacl.is_null() {
            return Err(io::Error::last_os_error());
        }
        let name = wide(&path.to_string_lossy());
        // SAFETY: `name` ist nullterminiert; `dacl` zeigt in `sd`, das bis nach dem Aufruf
        // lebt; Besitzer, Gruppe und SACL bleiben unverändert (null).
        // aegis-unsafe: service-dacl-apply
        #[allow(unsafe_code)]
        // aegis-mutation: service-dacl-apply-acl
        #[allow(clippy::disallowed_methods)]
        let status = unsafe {
            SetNamedSecurityInfoW(
                name.as_ptr(),
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
}
