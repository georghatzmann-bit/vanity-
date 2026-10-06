// Install / update / uninstall engine of VeloxSetup.exe. UI-independent: every UI (web, native
// fallback, silent) calls these methods on a worker thread and gets progress through a callback.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Management;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32;
using Velox.Native;

namespace Velox.Setup
{
    /// <summary>An error with a plain German message for the user and a hint what to do.</summary>
    internal sealed class InstallException : Exception
    {
        public string Hint { get; private set; }
        public InstallException(string message, string hint) : base(message) { Hint = hint; }
        public InstallException(string message, string hint, Exception inner) : base(message, inner) { Hint = hint; }
    }

    internal sealed class InstallOptions
    {
        public string Dir;
        public bool Desktop = true;
        public bool StartMenu = true;
        public bool Launch = true;
        public bool CloseRunning = true;
    }

    internal sealed class InstalledInfo
    {
        public string Dir;
        public string Version;
    }

    /// <summary>percent 0..100, step text (German), current file (may be null).</summary>
    internal delegate void ProgressFn(double percent, string step, string file);

    internal static class Installer
    {
        public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\VELOX";
        public const string ManifestName = ".velox-files";
        public const string Publisher = "VELOX";
        public static Log Log;

        // ------------------------------------------------------------ paths

        public static string ProgramFiles()
        {
            string pf = null;
            try { pf = Environment.GetEnvironmentVariable("ProgramW6432"); } catch (Exception) { }
            if (string.IsNullOrEmpty(pf)) { try { pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles); } catch (Exception) { } }
            if (string.IsNullOrEmpty(pf)) pf = @"C:\Program Files";
            return pf;
        }

        public static string DefaultDir() { return Path.Combine(ProgramFiles(), "VELOX"); }

        /// <summary>
        /// Normalises a folder chosen by the user. A folder that is not called VELOX gets "\VELOX" appended,
        /// so VELOX never spreads its files into (or later deletes from) a shared folder.
        /// Returns null and an error text when the folder cannot be used.
        /// </summary>
        public static string NormalizeDir(string dir, out string error)
        {
            error = null;
            if (string.IsNullOrWhiteSpace(dir)) { error = "Bitte wähle einen Ordner."; return null; }
            string full;
            try { full = Path.GetFullPath(dir.Trim().Trim('"')); }
            catch (Exception) { error = "Dieser Ordnername ist ungültig."; return null; }
            if (full.StartsWith(@"\\", StringComparison.Ordinal)) { error = "Bitte wähle einen Ordner auf diesem PC, nicht im Netzwerk."; return null; }
            if (full.Length < 3 || full[1] != ':') { error = "Bitte wähle einen Ordner auf einem Laufwerk dieses PCs."; return null; }
            try
            {
                var di = new DriveInfo(full.Substring(0, 3));
                if (di.DriveType == DriveType.Network) { error = "Bitte wähle einen Ordner auf diesem PC, nicht auf einem Netzlaufwerk."; return null; }
                if (di.DriveType == DriveType.CDRom) { error = "Auf dieses Laufwerk kann nicht installiert werden."; return null; }
            }
            catch (Exception) { }
            // Windows PowerShell 5.1 treats [ ] in "-File <path>" as wildcards: VELOX would not start from there
            if (full.IndexOfAny(new[] { '[', ']', '`' }) >= 0) { error = "Der Ordnerpfad darf keine eckigen Klammern [ ] enthalten. Bitte wähle einen anderen Ordner."; return null; }
            full = full.TrimEnd('\\');
            if (!string.Equals(Path.GetFileName(full), "VELOX", StringComparison.OrdinalIgnoreCase)) full = Path.Combine(full.Length == 2 ? full + "\\" : full, "VELOX");
            string win = Util.WindowsDir().TrimEnd('\\');
            if (full.StartsWith(win + "\\", StringComparison.OrdinalIgnoreCase)) { error = "In den Windows-Ordner kann VELOX nicht installiert werden."; return null; }
            if (full.Length > 180) { error = "Der Ordnerpfad ist zu lang. Bitte wähle einen kürzeren."; return null; }
            return full;
        }

        public static long FreeBytes(string dir)
        {
            try
            {
                string root = Path.GetPathRoot(Path.GetFullPath(dir));
                ulong free, total, totalFree;
                if (NativeMethods.GetDiskFreeSpaceEx(root, out free, out total, out totalFree)) return (long)free;
            }
            catch (Exception) { }
            return -1;
        }

        private static RegistryKey Hklm()
        {
            return RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, Environment.Is64BitOperatingSystem ? RegistryView.Registry64 : RegistryView.Default);
        }

        public static InstalledInfo Detect()
        {
            try
            {
                using (RegistryKey hk = Hklm())
                using (RegistryKey k = hk.OpenSubKey(UninstallKey, false))
                {
                    if (k == null) return null;
                    string dir = k.GetValue("InstallLocation") as string;
                    if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return null;
                    return new InstalledInfo { Dir = dir.TrimEnd('\\'), Version = (k.GetValue("DisplayVersion") as string) ?? "" };
                }
            }
            catch (Exception ex) { Log.Warn("Registry nicht lesbar: " + ex.Message); return null; }
        }

        // ------------------------------------------------------------ running VELOX

        private static bool UnderDir(string path, string dir)
        {
            if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(dir)) return false;
            string d = dir.TrimEnd('\\') + "\\";
            return path.StartsWith(d, StringComparison.OrdinalIgnoreCase);
        }

        private static List<Process> HostProcesses(string dir)
        {
            var list = new List<Process>();
            Process[] all;
            try { all = Process.GetProcessesByName("VELOX"); } catch (Exception) { return list; }
            foreach (Process p in all)
            {
                string file = null;
                try { file = p.MainModule.FileName; } catch (Exception) { }
                if (file == null || UnderDir(file, dir)) list.Add(p);   // unknown path: better close it than lock files
                else p.Dispose();
            }
            return list;
        }

        /// <summary>PowerShell processes running &lt;dir&gt;\Velox.ps1 (also the ones Start.bat started).</summary>
        private static List<int> BackendProcessIds(string dir)
        {
            var ids = new List<int>();
            string needle = dir.TrimEnd('\\') + "\\Velox.ps1";
            try
            {
                using (var searcher = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'powershell.exe' OR Name = 'pwsh.exe'"))
                using (ManagementObjectCollection res = searcher.Get())
                {
                    foreach (ManagementBaseObject mo in res)
                    {
                        using (mo)
                        {
                            string cmd = mo["CommandLine"] as string;
                            if (cmd != null && cmd.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)
                                ids.Add(Convert.ToInt32(mo["ProcessId"]));
                        }
                    }
                }
            }
            catch (Exception ex) { Log.Warn("Prozessliste (WMI) nicht verfügbar: " + ex.Message); }
            return ids;
        }

        public static bool IsVeloxRunning(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return false;
            List<Process> hosts = HostProcesses(dir);
            bool any = hosts.Count > 0;
            foreach (Process p in hosts) p.Dispose();
            return any || BackendProcessIds(dir).Count > 0;
        }

        /// <summary>Closes VELOX.exe politely (window close, it ends its backend), then forces what is left.</summary>
        public static void CloseVelox(string dir)
        {
            foreach (Process p in HostProcesses(dir))
            {
                using (p)
                {
                    try
                    {
                        if (p.HasExited) continue;
                        Log.Info("Schließe VELOX.exe (PID " + p.Id + ")");
                        bool asked = false;
                        try { asked = p.CloseMainWindow(); } catch (Exception) { }
                        if (!asked || !p.WaitForExit(12000)) { Log.Warn("VELOX.exe reagiert nicht - wird beendet."); p.Kill(); p.WaitForExit(5000); }
                    }
                    catch (Exception ex) { Log.Warn("VELOX.exe nicht beendet: " + ex.Message); }
                }
            }
            foreach (int id in BackendProcessIds(dir))
            {
                try
                {
                    using (Process p = Process.GetProcessById(id))
                    {
                        Log.Info("Beende VELOX-Backend (PID " + id + ")");
                        p.Kill();
                        p.WaitForExit(5000);
                    }
                }
                catch (Exception ex) { Log.Warn("Backend nicht beendet: " + ex.Message); }
            }
        }

        // ------------------------------------------------------------ install

        public static long RequiredBytes()
        {
            long total;
            Payload.Files(out total);
            return total + 2 * 1024 * 1024;
        }

        public static void Install(InstallOptions o, ProgressFn report)
        {
            string error;
            string dir = NormalizeDir(o.Dir, out error);
            if (dir == null) throw new InstallException(error, "Wähle unter „Optionen“ einen anderen Ordner.");
            Log.Info("Installation nach " + dir + " (Desktop " + o.Desktop + ", Startmenü " + o.StartMenu + ", Start " + o.Launch + ")");

            InstalledInfo before = Detect();
            report(1, "Vorbereiten …", null);
            long need = RequiredBytes();
            long free = FreeBytes(Path.GetPathRoot(dir));
            if (free >= 0 && free < need)
                throw new InstallException("Auf dem Laufwerk ist nicht genug Platz frei (gebraucht: " + (need / (1024 * 1024) + 1) + " MB).", "Mach etwas Platz frei oder wähle ein anderes Laufwerk.");

            // 1. close VELOX if it runs from this folder (or from the folder of the old installation)
            var dirsToCheck = new List<string> { dir };
            if (before != null && !string.Equals(before.Dir, dir, StringComparison.OrdinalIgnoreCase)) dirsToCheck.Add(before.Dir);
            foreach (string d in dirsToCheck)
            {
                if (IsVeloxRunning(d))
                {
                    if (!o.CloseRunning) throw new InstallException("VELOX läuft gerade.", "Schließe VELOX und starte die Installation noch einmal.");
                    report(3, "VELOX wird geschlossen …", null);
                    CloseVelox(d);
                }
            }

            // 2. folder (admin-only write access when it is not below Program Files)
            report(6, "Ordner wird vorbereitet …", dir);
            try { Directory.CreateDirectory(dir); }
            catch (Exception ex) { throw new InstallException("Der Ordner konnte nicht angelegt werden.", "Wähle einen anderen Ordner. (" + ex.Message + ")", ex); }
            Harden(dir);
            HashSet<string> oldFiles = ReadManifest(dir);

            // 3. files
            var written = new List<string>();
            using (ZipArchive z = Payload.Open())
            {
                long total = 0, done = 0;
                var entries = z.Entries.Where(e => !e.FullName.EndsWith("/", StringComparison.Ordinal)).ToList();
                foreach (ZipArchiveEntry e in entries) total += e.Length;
                if (total <= 0) total = 1;
                foreach (ZipArchiveEntry e in entries)
                {
                    string rel = e.FullName.Replace('/', '\\');
                    string target = SafeCombine(dir, rel);
                    report(8 + 74.0 * done / total, "Dateien werden kopiert …", e.FullName);
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    WriteEntry(e, target);
                    written.Add(rel);
                    done += e.Length;
                }
            }
            report(82, "Dateien werden kopiert …", null);

            // 4. uninstaller = a copy of this setup
            string self = Assembly.GetExecutingAssembly().Location;
            string uninst = Path.Combine(dir, "Uninstall.exe");
            if (!string.Equals(Path.GetFullPath(self), Path.GetFullPath(uninst), StringComparison.OrdinalIgnoreCase))
            {
                report(84, "Deinstallation wird eingerichtet …", "Uninstall.exe");
                Retry(() => File.Copy(self, uninst, true), "Uninstall.exe");
            }
            // File.Copy also copies the download's "Mark of the Web": without this, removing VELOX from the
            // Windows settings would greet the user with a SmartScreen warning for Uninstall.exe
            Win.RemoveMotw(uninst);
            written.Add("Uninstall.exe");

            // 5. files of the old version that this version no longer has
            foreach (string old in oldFiles)
            {
                if (written.Contains(old, StringComparer.OrdinalIgnoreCase)) continue;
                try
                {
                    string p = SafeCombine(dir, old);
                    if (File.Exists(p)) { File.Delete(p); Log.Info("Alte Datei entfernt: " + old); }
                }
                catch (Exception ex) { Log.Warn("Alte Datei nicht entfernt (" + old + "): " + ex.Message); }
            }
            RemoveEmptyDirs(dir, false);
            WriteManifest(dir, written);

            // 6. shortcuts
            report(88, "Verknüpfungen werden angelegt …", null);
            string exe = Path.Combine(dir, "VELOX.exe");
            Shortcuts(exe, dir, o.Desktop, o.StartMenu);

            // 7. Apps & Features entry
            report(94, "VELOX wird bei Windows angemeldet …", null);
            WriteUninstallEntry(dir, EstimatedKb(dir, written));

            // a previous installation in another folder: remove its files, keep nothing twice
            if (before != null && !string.Equals(before.Dir.TrimEnd('\\'), dir, StringComparison.OrdinalIgnoreCase))
            {
                try { RemoveInstalledFiles(before.Dir); } catch (Exception ex) { Log.Warn("Alte Installation nicht entfernt: " + ex.Message); }
            }
            try { NativeMethods.SHChangeNotify(NativeMethods.SHCNE_ASSOCCHANGED, NativeMethods.SHCNF_IDLIST, IntPtr.Zero, IntPtr.Zero); } catch (Exception) { }
            report(100, "Fertig", null);
            Log.Info("Installation abgeschlossen.");
        }

        private static string SafeCombine(string dir, string rel)
        {
            if (string.IsNullOrEmpty(rel) || Path.IsPathRooted(rel) || rel.Contains(".."))
                throw new InstallException("Das Installationspaket ist beschädigt.", "Lade VeloxSetup.exe neu herunter.");
            string full = Path.GetFullPath(Path.Combine(dir, rel));
            if (!UnderDir(full, dir)) throw new InstallException("Das Installationspaket ist beschädigt.", "Lade VeloxSetup.exe neu herunter.");
            return full;
        }

        private static void WriteEntry(ZipArchiveEntry e, string target)
        {
            Retry(() =>
            {
                if (File.Exists(target)) File.SetAttributes(target, FileAttributes.Normal);
                using (Stream src = e.Open())
                using (var dst = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    src.CopyTo(dst);
                }
            }, e.FullName);
        }

        private static void Retry(Action a, string what)
        {
            for (int i = 0; ; i++)
            {
                try { a(); return; }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
                {
                    if (i >= 8)
                    {
                        Log.Error("Datei nicht schreibbar: " + what + " - " + ex.Message);
                        throw new InstallException("Die Datei „" + Path.GetFileName(what) + "“ konnte nicht geschrieben werden – sie wird gerade benutzt.",
                            "Schließe VELOX (auch das schwarze Konsolen-Fenster) und versuche es noch einmal. Hilft das nicht: PC neu starten.", ex);
                    }
                    Thread.Sleep(400 + 200 * i);
                }
            }
        }

        /// <summary>Only administrators may change the program files (VELOX runs them elevated).</summary>
        private static void Harden(string dir)
        {
            // Program Files (both) is protected already
            if (UnderDir(dir, ProgramFiles())) return;
            try { string x86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86); if (!string.IsNullOrEmpty(x86) && UnderDir(dir, x86)) return; } catch (Exception) { }
            try
            {
                var sec = new DirectorySecurity();
                sec.SetAccessRuleProtection(true, false);
                var inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
                var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
                sec.AddAccessRule(new FileSystemAccessRule(admins, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
                sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
                sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.ReadAndExecute, inherit, PropagationFlags.None, AccessControlType.Allow));
                Directory.SetAccessControl(dir, sec);
                Log.Info("Ordnerrechte gesetzt (nur Administratoren dürfen ändern): " + dir);
                // a folder a normal user created before (e.g. D:\VELOX) would still be theirs, and an owner may
                // always change the permissions again: hand it to the Administrators group
                try
                {
                    var own = new DirectorySecurity();
                    own.SetOwner(admins);
                    Directory.SetAccessControl(dir, own);
                }
                catch (Exception ex) { Log.Warn("Besitzer nicht gesetzt: " + ex.Message); }
            }
            catch (Exception ex) { Log.Warn("Ordnerrechte nicht gesetzt: " + ex.Message); }
        }

        private static HashSet<string> ReadManifest(string dir)
        {
            var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                string p = Path.Combine(dir, ManifestName);
                if (File.Exists(p))
                    foreach (string line in File.ReadAllLines(p, Encoding.UTF8))
                    {
                        string l = line.Trim();
                        if (l.Length > 0 && !l.StartsWith("#", StringComparison.Ordinal)) set.Add(l);
                    }
            }
            catch (Exception ex) { Log.Warn("Dateiliste nicht lesbar: " + ex.Message); }
            return set;
        }

        private static void WriteManifest(string dir, List<string> files)
        {
            try
            {
                var sb = new StringBuilder("# VELOX - installierte Dateien (für Update und Deinstallation)\r\n");
                foreach (string f in files) sb.Append(f).Append("\r\n");
                string p = Path.Combine(dir, ManifestName);
                if (File.Exists(p)) File.SetAttributes(p, FileAttributes.Normal);
                File.WriteAllText(p, sb.ToString(), new UTF8Encoding(false));
                File.SetAttributes(p, FileAttributes.Hidden);
            }
            catch (Exception ex) { Log.Warn("Dateiliste nicht geschrieben: " + ex.Message); }
        }

        private static long EstimatedKb(string dir, List<string> files)
        {
            long sum = 0;
            foreach (string f in files) { try { sum += new FileInfo(Path.Combine(dir, f)).Length; } catch (Exception) { } }
            return Math.Max(1, sum / 1024);
        }

        private static void RemoveEmptyDirs(string dir, bool includeRoot)
        {
            try
            {
                string[] subs = Directory.GetDirectories(dir, "*", SearchOption.AllDirectories);
                Array.Sort(subs, (a, b) => b.Length.CompareTo(a.Length));
                foreach (string d in subs)
                {
                    try { if (!Directory.EnumerateFileSystemEntries(d).Any()) Directory.Delete(d, false); } catch (Exception) { }
                }
                if (includeRoot && !Directory.EnumerateFileSystemEntries(dir).Any()) Directory.Delete(dir, false);
            }
            catch (Exception) { }
        }

        // ------------------------------------------------------------ shortcuts (WScript.Shell)

        private static string CommonPrograms() { return Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms); }
        private static string CommonDesktop() { return Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory); }

        private static void Shortcuts(string exe, string dir, bool desktop, bool startMenu)
        {
            string progs = CommonPrograms(), desk = CommonDesktop();
            string icon = exe + ",0";
            if (startMenu && !string.IsNullOrEmpty(progs))
            {
                MakeShortcut(Path.Combine(progs, "VELOX.lnk"), exe, "", dir, icon, "VELOX – Windows schneller, ruhiger und privater");
                MakeShortcut(Path.Combine(progs, "VELOX Testmodus.lnk"), exe, "--test", dir, icon, "VELOX ausprobieren – am PC wird nichts verändert");
            }
            else
            {
                DeleteFile(Path.Combine(progs ?? "", "VELOX.lnk"));
                DeleteFile(Path.Combine(progs ?? "", "VELOX Testmodus.lnk"));
            }
            if (desktop && !string.IsNullOrEmpty(desk)) MakeShortcut(Path.Combine(desk, "VELOX.lnk"), exe, "", dir, icon, "VELOX starten");
            else DeleteFile(Path.Combine(desk ?? "", "VELOX.lnk"));
        }

        private static void MakeShortcut(string lnk, string target, string args, string workDir, string icon, string description)
        {
            object shell = null, sc = null;
            try
            {
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                if (t == null) { Log.Warn("WScript.Shell nicht verfügbar"); return; }
                shell = Activator.CreateInstance(t);
                sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
                Type st = sc.GetType();
                st.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { target });
                st.InvokeMember("Arguments", BindingFlags.SetProperty, null, sc, new object[] { args ?? "" });
                st.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { workDir });
                st.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { icon });
                st.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { description });
                st.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
                Log.Info("Verknüpfung: " + lnk);
            }
            catch (Exception ex) { Log.Warn("Verknüpfung nicht angelegt (" + lnk + "): " + ex.Message); }
            finally
            {
                try { if (sc != null && System.Runtime.InteropServices.Marshal.IsComObject(sc)) System.Runtime.InteropServices.Marshal.ReleaseComObject(sc); } catch (Exception) { }
                try { if (shell != null && System.Runtime.InteropServices.Marshal.IsComObject(shell)) System.Runtime.InteropServices.Marshal.ReleaseComObject(shell); } catch (Exception) { }
            }
        }

        private static void DeleteFile(string p)
        {
            try { if (!string.IsNullOrEmpty(p) && File.Exists(p)) { File.Delete(p); Log.Info("Entfernt: " + p); } } catch (Exception ex) { Log.Warn("Nicht entfernt (" + p + "): " + ex.Message); }
        }

        // ------------------------------------------------------------ registry

        private static void WriteUninstallEntry(string dir, long sizeKb)
        {
            string uninst = Path.Combine(dir, "Uninstall.exe");
            try
            {
                using (RegistryKey hk = Hklm())
                using (RegistryKey k = hk.CreateSubKey(UninstallKey, true))
                {
                    k.SetValue("DisplayName", "VELOX", RegistryValueKind.String);
                    k.SetValue("DisplayVersion", Util.Version(), RegistryValueKind.String);
                    k.SetValue("Publisher", Publisher, RegistryValueKind.String);
                    k.SetValue("DisplayIcon", Path.Combine(dir, "VELOX.exe") + ",0", RegistryValueKind.String);
                    k.SetValue("InstallLocation", dir, RegistryValueKind.String);
                    k.SetValue("UninstallString", "\"" + uninst + "\" /uninstall", RegistryValueKind.String);
                    k.SetValue("QuietUninstallString", "\"" + uninst + "\" /uninstall /S", RegistryValueKind.String);
                    k.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, sizeKb), RegistryValueKind.DWord);
                    k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"), RegistryValueKind.String);
                }
            }
            catch (Exception ex)
            {
                Log.Error("Registry: " + ex.Message);
                throw new InstallException("VELOX konnte nicht bei Windows angemeldet werden.", "Starte das Setup mit Administrator-Rechten neu.", ex);
            }
        }

        private static void DeleteUninstallEntry()
        {
            try
            {
                using (RegistryKey hk = Hklm()) hk.DeleteSubKeyTree(UninstallKey, false);
                Log.Info("Registry-Eintrag entfernt.");
            }
            catch (Exception ex) { Log.Warn("Registry-Eintrag nicht entfernt: " + ex.Message); }
        }

        // ------------------------------------------------------------ uninstall

        /// <summary>
        /// Removes exactly the files VELOX installed (manifest + current payload list), then empty folders.
        /// What is locked is deleted at the next restart (MoveFileEx), the folder too - Windows removes it then
        /// if it is empty by that time. keepSelf: Uninstall.exe is still running (the launcher of a silent
        /// uninstall waits for the result); RemoveLeftovers deletes it once it has exited.
        /// </summary>
        private static void RemoveInstalledFiles(string dir, ProgressFn report = null, double from = 0, double to = 0, bool keepSelf = false)
        {
            HashSet<string> files = ReadManifest(dir);
            long ignored;
            foreach (string f in Payload.Files(out ignored)) files.Add(f.Replace('/', '\\'));
            files.Add("Uninstall.exe");
            files.Add(ManifestName);
            int i = 0, n = Math.Max(1, files.Count);
            foreach (string rel in files)
            {
                i++;
                string p;
                try { p = SafeCombine(dir, rel); } catch (Exception) { continue; }
                if (report != null) report(from + (to - from) * i / n, "Dateien werden entfernt …", rel.Replace('\\', '/'));
                if (keepSelf && string.Equals(rel, "Uninstall.exe", StringComparison.OrdinalIgnoreCase)) continue;
                try
                {
                    if (File.Exists(p)) { File.SetAttributes(p, FileAttributes.Normal); File.Delete(p); }
                }
                catch (Exception ex)
                {
                    Log.Warn("Nicht gelöscht (" + rel + "): " + ex.Message);
                    try { NativeMethods.MoveFileEx(p, null, NativeMethods.MOVEFILE_DELAY_UNTIL_REBOOT); } catch (Exception) { }
                }
            }
            RemoveEmptyDirs(dir, true);
            if (!keepSelf) ScheduleDirRemoval(dir);
        }

        /// <summary>
        /// Registers the install folder for removal at the next restart when it is still there. Registered after
        /// its files, so Windows deletes them first; a folder that is not empty by then simply stays.
        /// </summary>
        private static void ScheduleDirRemoval(string dir)
        {
            if (!Directory.Exists(dir)) return;
            try
            {
                if (NativeMethods.MoveFileEx(dir, null, NativeMethods.MOVEFILE_DELAY_UNTIL_REBOOT)) Log.Info("Ordner wird beim nächsten Neustart entfernt: " + dir);
            }
            catch (Exception) { }
        }

        /// <summary>After a silent uninstall: the launching Uninstall.exe has exited - delete it and the empty folder.</summary>
        public static void RemoveLeftovers(string dir)
        {
            string self = Path.Combine(dir, "Uninstall.exe");
            for (int i = 0; File.Exists(self); i++)
            {
                try { File.SetAttributes(self, FileAttributes.Normal); File.Delete(self); Log.Info("Uninstall.exe entfernt."); break; }
                catch (Exception ex)
                {
                    if (i < 10) { Thread.Sleep(300); continue; }
                    Log.Warn("Nicht gelöscht (Uninstall.exe): " + ex.Message);
                    try { NativeMethods.MoveFileEx(self, null, NativeMethods.MOVEFILE_DELAY_UNTIL_REBOOT); } catch (Exception) { }
                    break;
                }
            }
            RemoveEmptyDirs(dir, true);
            if (!Directory.Exists(dir)) Log.Info("Programmordner entfernt: " + dir);
            ScheduleDirRemoval(dir);
        }

        public static void Uninstall(string dir, bool keepData, bool closeRunning, ProgressFn report, bool launcherWaits = false)
        {
            Log.Info("Deinstallation aus " + dir + " (Daten behalten: " + keepData + ")");
            report(2, "Vorbereiten …", null);
            if (IsVeloxRunning(dir))
            {
                if (!closeRunning) throw new InstallException("VELOX läuft gerade.", "Schließe VELOX und versuche es noch einmal.");
                report(5, "VELOX wird geschlossen …", null);
                CloseVelox(dir);
            }
            report(12, "Verknüpfungen werden entfernt …", null);
            DeleteFile(Path.Combine(CommonPrograms() ?? "", "VELOX.lnk"));
            DeleteFile(Path.Combine(CommonPrograms() ?? "", "VELOX Testmodus.lnk"));
            DeleteFile(Path.Combine(CommonDesktop() ?? "", "VELOX.lnk"));
            if (Directory.Exists(dir)) RemoveInstalledFiles(dir, report, 15, 80, launcherWaits);
            report(85, "Eintrag bei Windows wird entfernt …", null);
            DeleteUninstallEntry();
            if (!keepData)
            {
                report(90, "Einstellungen und Sicherungen werden gelöscht …", null);
                string data = Path.Combine(Util.LocalAppData(), "Velox");
                Util.DeleteTree(data, true);
                Log.Info("Daten gelöscht: " + data);
            }
            try { NativeMethods.SHChangeNotify(NativeMethods.SHCNE_ASSOCCHANGED, NativeMethods.SHCNF_IDLIST, IntPtr.Zero, IntPtr.Zero); } catch (Exception) { }
            report(100, "Fertig", null);
            Log.Info("Deinstallation abgeschlossen.");
        }

        // ------------------------------------------------------------ start VELOX

        /// <param name="quiet">the user muted the installer's intro: VELOX.exe's start screen stays silent for this run</param>
        public static bool Launch(string dir, bool quiet = false)
        {
            string exe = Path.Combine(dir, "VELOX.exe");
            try
            {
                // --from-setup: the installer just played the full intro, so VELOX.exe starts with the short one
                using (Process.Start(new ProcessStartInfo(exe, quiet ? "--from-setup --quiet-start" : "--from-setup") { UseShellExecute = false, WorkingDirectory = dir })) { }
                Log.Info("VELOX gestartet.");
                return true;
            }
            catch (Exception ex)
            {
                Log.Warn("VELOX direkt nicht startbar (" + ex.Message + ") - über Explorer.");
                return Util.OpenUnelevated(exe, Log);
            }
        }
    }
}
