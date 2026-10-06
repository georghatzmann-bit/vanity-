// WebView2 user data folders (UDF). The ONLY place that decides where they live (buildtool verify checks
// that every CoreWebView2Environment.CreateAsync gets its folder from here).
//
// Rule: the WebView2 browser process is untrusted-for-elevation. It writes the UDF, but it does not run with
// the host's administrator rights - current runtimes de-elevate it (filtered token: the user SID is enabled,
// BUILTIN\Administrators is deny-only), and under Windows 11 Administrator Protection it may run as the
// signed-in user while the host runs as the shadow admin. So a UDF must be a normal folder of the user
// (inherited ACL of the profile) - never inside a private Admins-only temp folder - and:
//   - the process user's own SID must be granted on it (not only via Administrators),
//   - if the desktop user (owner of the shell window in this session) is another account, it is granted
//     Modify too. Nothing else is changed; protection and other entries stay as they are.
//
//   VELOX.exe        %LOCALAPPDATA%\Velox\webview2\<real|test>          (kept across runs, as in 1.1.x)
//   VeloxSetup.exe   %TEMP%\VeloxSetup-WebView2-<random>                (per run, deleted afterwards)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;

namespace Velox.Native
{
    internal static class WebViewData
    {
        private const string SetupPrefix = "VeloxSetup-WebView2-";
        private static readonly List<string> SetupRuns = new List<string>();

        /// <summary>VELOX.exe: %LOCALAPPDATA%\Velox\webview2\real|test, created if needed, browser access ensured.</summary>
        public static string ForHost(string dataDir, bool test, Log log)
        {
            string dir = Path.Combine(Path.Combine(dataDir, "webview2"), test ? "test" : "real");
            Directory.CreateDirectory(dir);
            EnsureBrowserAccess(dir, log);
            return dir;
        }

        /// <summary>VeloxSetup.exe: a fresh folder for this run in the user's %TEMP% (normal inherited ACL).</summary>
        public static string NewSetupRun(Log log)
        {
            string root = Path.GetTempPath();
            string dir = Path.Combine(root, SetupPrefix + Guid.NewGuid().ToString("N").Substring(0, 12));
            Directory.CreateDirectory(dir);   // no DirectorySecurity: inherits the profile's ACL (user, SYSTEM, Administrators)
            lock (SetupRuns) SetupRuns.Add(dir);
            EnsureBrowserAccess(dir, log);
            if (log != null) log.Info("WebView2-Datenordner: " + dir);
            return dir;
        }

        /// <summary>
        /// Deletes this run's setup folders. The browser processes release them a moment after the window is
        /// gone: retry for up to <paramref name="ms"/>, then leave the rest to Windows at the next restart.
        /// </summary>
        public static void DeleteSetupRuns(int ms, Log log)
        {
            string[] dirs;
            lock (SetupRuns) { dirs = SetupRuns.ToArray(); SetupRuns.Clear(); }
            if (dirs.Length == 0) return;
            var sw = Stopwatch.StartNew();
            foreach (string d in dirs)
            {
                while (Directory.Exists(d))
                {
                    try { Directory.Delete(d, true); } catch (Exception) { }
                    if (!Directory.Exists(d) || sw.ElapsedMilliseconds > ms) break;
                    Thread.Sleep(250);
                }
                if (Directory.Exists(d))
                {
                    if (log != null) log.Warn("WebView2-Datenordner bleibt bis zum Neustart: " + d);
                    Util.DeleteTree(d, true);
                }
            }
        }

        /// <summary>Setup folders of earlier runs that could not be deleted (killed process, reboot pending).</summary>
        public static void CleanupStaleSetupRuns(Log log)
        {
            try
            {
                foreach (string d in Directory.GetDirectories(Path.GetTempPath(), SetupPrefix + "*"))
                {
                    try { if (Directory.GetLastWriteTimeUtc(d) < DateTime.UtcNow.AddHours(-12)) Util.DeleteTree(d, false); }
                    catch (Exception) { }
                }
            }
            catch (Exception ex) { if (log != null) log.Warn("Alte WebView2-Datenordner: " + ex.Message); }
        }

        // ------------------------------------------------------------ access for the browser process

        /// <summary>
        /// Makes sure the browser process can write the folder whatever token it gets: the process user's SID and
        /// (if it is another account) the desktop user's SID need an allow entry of their own. Only adds entries.
        /// </summary>
        public static void EnsureBrowserAccess(string dir, Log log)
        {
            SecurityIdentifier self = null;
            try { using (var id = WindowsIdentity.GetCurrent()) self = id.User; } catch (Exception) { }
            SecurityIdentifier desk = DesktopUserSid(log);
            var want = new List<SecurityIdentifier>();
            if (self != null) want.Add(self);
            if (desk != null && !desk.Equals(self) && !desk.IsWellKnown(WellKnownSidType.LocalSystemSid)) want.Add(desk);
            if (log != null && desk != null && !desk.Equals(self)) log.Info("Desktop-Benutzer " + desk.Value + " ist nicht der Prozess-Benutzer " + (self == null ? "?" : self.Value) + " - bekommt Zugriff auf " + dir);
            foreach (SecurityIdentifier sid in want)
            {
                try
                {
                    DirectorySecurity sec = Directory.GetAccessControl(dir, AccessControlSections.Access);
                    if (HasWriteAccess(sec, sid)) continue;
                    sec.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.Modify | FileSystemRights.Synchronize,
                        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                    Directory.SetAccessControl(dir, sec);
                    if (log != null) log.Info("WebView2-Datenordner: Ändern-Recht für " + sid.Value + " ergänzt.");
                }
                catch (Exception ex)
                {
                    // not fatal by itself: if the browser cannot use the folder, starting WebView2 fails and the
                    // caller falls back (setup: native window, VELOX.exe: Edge app window)
                    if (log != null) log.Warn("WebView2-Datenordner: Rechte für " + sid.Value + " nicht gesetzt: " + ex.Message);
                }
            }
        }

        private const FileSystemRights NeededRights = FileSystemRights.ReadData | FileSystemRights.WriteData | FileSystemRights.AppendData
            | FileSystemRights.ReadAttributes | FileSystemRights.WriteAttributes | FileSystemRights.Delete;

        /// <summary>An allow entry for exactly this SID that covers the folder itself and is inherited by files and sub folders.</summary>
        internal static bool HasWriteAccess(DirectorySecurity sec, SecurityIdentifier sid)
        {
            FileSystemRights granted = 0;
            foreach (FileSystemAccessRule r in sec.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            {
                if (!sid.Equals(r.IdentityReference)) continue;
                if ((r.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
                const InheritanceFlags both = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
                if (r.AccessControlType == AccessControlType.Deny) return false;
                if ((r.InheritanceFlags & both) != both) continue;
                granted |= r.FileSystemRights;
            }
            return (granted & NeededRights) == NeededRights;
        }

        /// <summary>
        /// The account that owns the desktop shell window of this session (explorer.exe): GetShellWindow
        /// -> GetWindowThreadProcessId -> OpenProcess -> OpenProcessToken -> TokenUser; if that is not possible,
        /// the signed-in user of the current session (WTSQuerySessionInformation); null if neither works.
        /// </summary>
        public static SecurityIdentifier DesktopUserSid(Log log)
        {
            // the shell's token says exactly who owns the desktop; it may be closed to another account (token
            // DACL) or explorer may not run - then the signed-in user of this session (WTS) is asked instead
            return ShellOwnerSid(log) ?? SessionUserSid(log);
        }

        private static SecurityIdentifier SessionUserSid(Log log)
        {
            string user = SessionString(NativeMethods.WTSUserName), domain = SessionString(NativeMethods.WTSDomainName);
            if (string.IsNullOrEmpty(user)) return null;
            try
            {
                var acc = new NTAccount(string.IsNullOrEmpty(domain) ? user : domain + "\\" + user);
                return (SecurityIdentifier)acc.Translate(typeof(SecurityIdentifier));
            }
            catch (Exception ex)
            {
                if (log != null) log.Warn("Sitzungsbenutzer " + user + " nicht aufgelöst: " + ex.Message);
                return null;
            }
        }

        private static string SessionString(int infoClass)
        {
            IntPtr buf = IntPtr.Zero;
            try
            {
                int bytes;
                if (!NativeMethods.WTSQuerySessionInformationW(NativeMethods.WTS_CURRENT_SERVER_HANDLE, NativeMethods.WTS_CURRENT_SESSION, infoClass, out buf, out bytes) || buf == IntPtr.Zero) return null;
                return Marshal.PtrToStringUni(buf);
            }
            catch (Exception) { return null; }
            finally { if (buf != IntPtr.Zero) NativeMethods.WTSFreeMemory(buf); }
        }

        private static SecurityIdentifier ShellOwnerSid(Log log)
        {
            IntPtr proc = IntPtr.Zero, tok = IntPtr.Zero, buf = IntPtr.Zero;
            try
            {
                IntPtr shell = NativeMethods.GetShellWindow();
                if (shell == IntPtr.Zero) return null;
                uint pid;
                NativeMethods.GetWindowThreadProcessId(shell, out pid);
                if (pid == 0) return null;
                proc = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (proc == IntPtr.Zero) return null;
                if (!NativeMethods.OpenProcessToken(proc, NativeMethods.TOKEN_QUERY, out tok)) return null;
                int len;
                NativeMethods.GetTokenInformation(tok, NativeMethods.TokenUser, IntPtr.Zero, 0, out len);
                if (len <= 0 || len > 4096) return null;
                buf = Marshal.AllocHGlobal(len);
                if (!NativeMethods.GetTokenInformation(tok, NativeMethods.TokenUser, buf, len, out len)) return null;
                IntPtr psid = Marshal.ReadIntPtr(buf);   // TOKEN_USER.User.Sid
                return psid == IntPtr.Zero ? null : new SecurityIdentifier(psid);
            }
            catch (Exception ex)
            {
                if (log != null) log.Warn("Desktop-Benutzer nicht ermittelt: " + ex.Message);
                return null;
            }
            finally
            {
                if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
                if (tok != IntPtr.Zero) NativeMethods.CloseHandle(tok);
                if (proc != IntPtr.Zero) NativeMethods.CloseHandle(proc);
            }
        }
    }
}
