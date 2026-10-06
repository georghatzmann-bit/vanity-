// Shared helpers: logging, paths, process helpers, protected temp folders.
using System;
using System.Diagnostics;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace Velox.Native
{
    /// <summary>Append-only text log; never throws. Rotates once at 1 MB.</summary>
    internal sealed class Log
    {
        private readonly object _lock = new object();
        public string Path { get; private set; }

        public Log(string path)
        {
            Path = path;
            try
            {
                string dir = System.IO.Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                var fi = new FileInfo(path);
                if (fi.Exists && fi.Length > 1024 * 1024)
                {
                    string old = path + ".old";
                    try { if (File.Exists(old)) File.Delete(old); } catch (Exception) { }
                    File.Move(path, old);
                }
            }
            catch (Exception) { }
        }

        public void Info(string msg) { Write("info", msg); }
        public void Warn(string msg) { Write("warn", msg); }
        public void Error(string msg) { Write("error", msg); }

        public void Write(string level, string msg)
        {
            try
            {
                string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " [" + level + "] " + (msg ?? "") + Environment.NewLine;
                lock (_lock) { File.AppendAllText(Path, line, new UTF8Encoding(false)); }
            }
            catch (Exception) { }
        }
    }

    internal static class Util
    {
        public static bool IsElevated()
        {
            try
            {
                using (var id = WindowsIdentity.GetCurrent())
                {
                    return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
                }
            }
            catch (Exception) { return false; }
        }

        public static string LocalAppData()
        {
            string p = null;
            try { p = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); } catch (Exception) { }
            if (string.IsNullOrEmpty(p)) p = System.IO.Path.GetTempPath();
            return p;
        }

        public static string WindowsDir()
        {
            string w = null;
            try { w = Environment.GetFolderPath(Environment.SpecialFolder.Windows); } catch (Exception) { }
            if (string.IsNullOrEmpty(w)) w = Environment.GetEnvironmentVariable("SystemRoot");
            if (string.IsNullOrEmpty(w)) w = @"C:\Windows";
            return w;
        }

        /// <summary>
        /// Opens a web address or a file in the signed-in user's default program WITHOUT our
        /// administrator rights: explorer.exe hands the request to the running (non-elevated) shell.
        /// </summary>
        public static bool OpenUnelevated(string target, Log log)
        {
            if (string.IsNullOrEmpty(target)) return false;
            try
            {
                string explorer = System.IO.Path.Combine(WindowsDir(), "explorer.exe");
                var psi = new ProcessStartInfo(explorer, "\"" + target.Replace("\"", "") + "\"") { UseShellExecute = false };
                using (Process.Start(psi)) { }
                return true;
            }
            catch (Exception ex)
            {
                if (log != null) log.Warn("explorer.exe konnte nicht starten: " + ex.Message);
            }
            try
            {
                using (Process.Start(new ProcessStartInfo(target) { UseShellExecute = true })) { }
                return true;
            }
            catch (Exception ex)
            {
                if (log != null) log.Warn("Öffnen fehlgeschlagen: " + ex.Message);
                return false;
            }
        }

        /// <summary>
        /// Creates a fresh folder with a random name that only Administrators and SYSTEM may write to
        /// (or only the current user when not elevated). Used for DLLs and copies the elevated setup loads,
        /// so a normal-user process cannot swap them in between.
        /// NEVER for anything the WebView2 browser process reads or writes (pages, user data folder): it runs
        /// without our administrator rights and cannot open this folder (WebViewData, EmbeddedSite).
        /// </summary>
        public static string CreatePrivateTempDir(string prefix)
        {
            string dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), prefix + Guid.NewGuid().ToString("N").Substring(0, 12));
            try
            {
                var sec = new DirectorySecurity();
                sec.SetAccessRuleProtection(true, false);
                var rights = FileSystemRights.FullControl;
                var inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
                sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), rights, inherit, PropagationFlags.None, AccessControlType.Allow));
                if (IsElevated())
                {
                    sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), rights, inherit, PropagationFlags.None, AccessControlType.Allow));
                }
                else
                {
                    using (var id = WindowsIdentity.GetCurrent())
                    {
                        sec.AddAccessRule(new FileSystemAccessRule(id.User, rights, inherit, PropagationFlags.None, AccessControlType.Allow));
                    }
                }
                Directory.CreateDirectory(dir, sec);
            }
            catch (Exception)
            {
                Directory.CreateDirectory(dir);
            }
            return dir;
        }

        /// <summary>Best-effort recursive delete; files still in use are scheduled for deletion at the next reboot.</summary>
        public static void DeleteTree(string dir, bool scheduleOnReboot)
        {
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return;
            try { Directory.Delete(dir, true); return; } catch (Exception) { }
            try
            {
                foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
                {
                    try { File.SetAttributes(f, FileAttributes.Normal); File.Delete(f); }
                    catch (Exception) { if (scheduleOnReboot) { try { NativeMethods.MoveFileEx(f, null, NativeMethods.MOVEFILE_DELAY_UNTIL_REBOOT); } catch (Exception) { } } }
                }
                string[] subs = Directory.GetDirectories(dir, "*", SearchOption.AllDirectories);
                Array.Sort(subs, (a, b) => b.Length.CompareTo(a.Length));
                foreach (string d in subs)
                {
                    try { Directory.Delete(d, false); }
                    catch (Exception) { if (scheduleOnReboot) { try { NativeMethods.MoveFileEx(d, null, NativeMethods.MOVEFILE_DELAY_UNTIL_REBOOT); } catch (Exception) { } } }
                }
                try { Directory.Delete(dir, false); }
                catch (Exception) { if (scheduleOnReboot) { try { NativeMethods.MoveFileEx(dir, null, NativeMethods.MOVEFILE_DELAY_UNTIL_REBOOT); } catch (Exception) { } } }
            }
            catch (Exception) { }
        }

        /// <summary>Sub folder of the WebView2Loader.dll that matches this process (x64, x86 or arm64).</summary>
        public static string LoaderArch()
        {
            try
            {
                switch (System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture)
                {
                    case System.Runtime.InteropServices.Architecture.Arm64: return "win-arm64";
                    case System.Runtime.InteropServices.Architecture.X64: return "win-x64";
                    case System.Runtime.InteropServices.Architecture.X86: return "win-x86";
                }
            }
            catch (Exception) { }
            string a = (Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "").ToUpperInvariant();
            if (a == "ARM64") return "win-arm64";
            if (IntPtr.Size == 8) return "win-x64";
            return "win-x86";
        }

        public static string HtmlEscape(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder(s.Length + 16);
            foreach (char c in s)
            {
                switch (c)
                {
                    case '<': sb.Append("&lt;"); break;
                    case '>': sb.Append("&gt;"); break;
                    case '&': sb.Append("&amp;"); break;
                    case '"': sb.Append("&quot;"); break;
                    case '\'': sb.Append("&#39;"); break;
                    default: sb.Append(c); break;
                }
            }
            return sb.ToString();
        }

        public static string Version()
        {
            try
            {
                var attrs = typeof(Util).Assembly.GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false);
                if (attrs.Length > 0)
                {
                    string v = ((System.Reflection.AssemblyInformationalVersionAttribute)attrs[0]).InformationalVersion ?? "";
                    int plus = v.IndexOf('+');
                    if (plus > 0) v = v.Substring(0, plus);
                    if (v.Length > 0) return v;
                }
            }
            catch (Exception) { }
            Version ver = typeof(Util).Assembly.GetName().Version;
            return ver.Major + "." + ver.Minor + "." + ver.Build;
        }

        /// <summary>.NET Framework 4.7.2 (the version VELOX.exe and the setup are built for).</summary>
        public const int NetFrameworkMinRelease = 461808;
        public const string NetFrameworkDownloadUrl = "https://dotnet.microsoft.com/download/dotnet-framework/net48";

        /// <summary>The "Release" number of the installed .NET Framework 4.x; 0 when it cannot be read.</summary>
        public static int NetFrameworkRelease()
        {
            try
            {
                using (var hk = Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Default))
                using (var k = hk.OpenSubKey(@"SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full", false))
                {
                    object v = k == null ? null : k.GetValue("Release");
                    return v is int ? (int)v : 0;
                }
            }
            catch (Exception) { return 0; }
        }

        /// <summary>Quotes one command-line argument for CommandLineToArgvW / the C runtime.</summary>
        public static string QuoteArg(string arg)
        {
            if (arg == null) return "\"\"";
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
            var sb = new StringBuilder("\"");
            int bs = 0;
            foreach (char c in arg)
            {
                if (c == '\\') { bs++; continue; }
                if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
                sb.Append('\\', bs); bs = 0; sb.Append(c);
            }
            sb.Append('\\', bs * 2);
            sb.Append('"');
            return sb.ToString();
        }
    }
}
