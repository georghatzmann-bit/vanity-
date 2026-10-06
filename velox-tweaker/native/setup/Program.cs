// VeloxSetup.exe - one self-contained installer (and, copied as Uninstall.exe, the uninstaller).
//
//   VeloxSetup.exe                     installer UI (or update UI when VELOX is installed)
//   VeloxSetup.exe /S [/D=<folder>]    silent install (default folder: C:\Program Files\VELOX); like NSIS,
//                                      /D= may be unquoted with spaces when it is the last argument
//   Uninstall.exe /uninstall           uninstall UI
//   Uninstall.exe /uninstall /S        silent uninstall (keeps settings and backups)
//   options: /nodesktop  /nostartmenu  /nolaunch (silent install never starts VELOX)  /purge (uninstall: delete data)
//
// Internal: --from-temp --dir "<folder>" [--parent <pid> --result <file>] (the uninstaller re-runs
// itself from a temp copy so it can delete its own folder; with /S the launcher waits for the result
// file instead of the copy's exit, exits, and the copy then removes the launcher's Uninstall.exe).
//
// The WebView2 DLLs are not files next to the exe: the managed ones are loaded from the embedded
// payload (AssemblyResolve), WebView2Loader.dll is extracted to a private temp folder. All
// WebView2-typed code lives in SetupWindow.cs, so it is only JIT-compiled after the resolver runs.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Velox.Native;

namespace Velox.Setup
{
    internal static class Program
    {
        public static Log Log;
        public static string TempDir;
        private static readonly Dictionary<string, Assembly> Loaded = new Dictionary<string, Assembly>(StringComparer.OrdinalIgnoreCase);

        [STAThread]
        private static int Main(string[] args)
        {
            Log = new Log(Path.Combine(Path.GetTempPath(), "VeloxSetup.log"));
            Installer.Log = Log;
            AppDomain.CurrentDomain.AssemblyResolve += ResolveFromPayload;
            AppDomain.CurrentDomain.UnhandledException += (s, e) => Log.Error("Unbehandelter Fehler: " + e.ExceptionObject);
            var a = new Args(args, Environment.CommandLine);
            Log.Info("VeloxSetup " + Util.Version() + " (" + string.Join(" ", args) + "), Admin: " + Util.IsElevated() + ", " + (IntPtr.Size * 8) + "-Bit");
            int code = 1;
            try
            {
                try { Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); } catch (Exception) { }
                Application.ThreadException += (s, e) => Log.Error("UI-Fehler: " + e.Exception);
                if (!Util.IsElevated())
                {
                    // the manifest asks for administrator rights; this only happens if UAC is off for a standard user
                    if (!a.Silent) DarkDialog.Show(null, "Administrator-Rechte nötig", "Das Setup braucht Administrator-Rechte. Bitte mit Rechtsklick „Als Administrator ausführen“ starten.", null, new[] { "OK" }, 0, false);
                    return 5;
                }
                if (a.Uninstall && !a.FromTemp) { code = RelaunchFromTemp(a); return code; }
                if (!a.Uninstall && !NetFrameworkOk(a)) return code = 1;
                TempDir = Util.CreatePrivateTempDir("VeloxSetup-");
                code = a.Silent ? RunSilent(a) : RunUi(a);
                return code;
            }
            catch (Exception ex)
            {
                Log.Error("Abbruch: " + ex);
                if (!a.Silent) DarkDialog.Show(null, "Setup abgebrochen", "Etwas ist schiefgelaufen. Details stehen im Log.", Log.Path, new[] { "OK" }, 0, false);
                return 1;
            }
            finally
            {
                Log.Info("Ende (Code " + code + ")");
                CleanupTemp(a);
            }
        }

        // ------------------------------------------------------------ arguments

        internal sealed class Args
        {
            public bool Silent, Uninstall, FromTemp, NoDesktop, NoStartMenu, NoLaunch, Purge;
            public string Dir;
            public int ParentPid;           // internal (temp copy of a silent uninstall): the launcher
            public string ResultFile;       // internal: where the temp copy reports its exit code
            public Args(string[] args) : this(args, null) { }
            public Args(string[] args, string commandLine)
            {
                bool internalDir = false;
                for (int i = 0; i < args.Length; i++)
                {
                    string x = args[i];
                    string l = x.ToLowerInvariant();
                    if (l == "/s" || l == "-s" || l == "/silent" || l == "--silent") Silent = true;
                    else if (l == "/uninstall" || l == "--uninstall" || l == "-uninstall") Uninstall = true;
                    else if (l == "--from-temp") FromTemp = true;
                    else if (l == "/nodesktop") NoDesktop = true;
                    else if (l == "/nostartmenu") NoStartMenu = true;
                    else if (l == "/nolaunch") NoLaunch = true;
                    else if (l == "/purge") Purge = true;
                    else if (l == "--dir" && i + 1 < args.Length) { Dir = args[++i]; internalDir = true; }
                    else if (l == "--parent" && i + 1 < args.Length) { int pid; if (int.TryParse(args[++i], out pid)) ParentPid = pid; }
                    else if (l == "--result" && i + 1 < args.Length) ResultFile = args[++i];
                    else if (l.StartsWith("/d=", StringComparison.Ordinal)) Dir = x.Substring(3);
                }
                // NSIS convention: "/D=C:\Program Files\VELOX" without quotes, as the last argument. The
                // split argv would cut that at the first space, so read it from the raw command line.
                if (!internalDir)
                {
                    string raw = DirFromCommandLine(commandLine);
                    if (raw != null) Dir = raw;
                }
            }

            private static readonly string[] Switches = { "/s", "-s", "/silent", "--silent", "/nodesktop", "/nostartmenu", "/nolaunch", "/purge", "/uninstall", "--uninstall", "-uninstall" };

            /// <summary>The folder of a "/D=" switch, read NSIS-style from the raw command line; null if there is none.</summary>
            internal static string DirFromCommandLine(string cmd)
            {
                if (string.IsNullOrEmpty(cmd)) return null;
                // skip the program path (quoted or not)
                string s = cmd.TrimStart();
                if (s.StartsWith("\"", StringComparison.Ordinal)) { int q = s.IndexOf('"', 1); s = q < 0 ? "" : s.Substring(q + 1); }
                else { int sp = s.IndexOfAny(new[] { ' ', '\t' }); s = sp < 0 ? "" : s.Substring(sp); }
                Match m = Regex.Match(s, "(?:^|\\s)(\"?)/D=", RegexOptions.IgnoreCase);
                if (!m.Success) return null;
                string rest = s.Substring(m.Index + m.Length);
                if (m.Groups[1].Value.Length > 0)
                {
                    // "/D=C:\Mein Ordner" - the whole switch in quotes
                    int q = rest.IndexOf('"');
                    if (q >= 0) rest = rest.Substring(0, q);
                }
                else
                {
                    // /D=C:\Program Files\VELOX - everything up to the end; known switches after it are tolerated
                    rest = rest.TrimEnd();
                    bool cut = true;
                    while (cut)
                    {
                        cut = false;
                        foreach (string sw in Switches)
                        {
                            if (rest.Length > sw.Length && rest.EndsWith(sw, StringComparison.OrdinalIgnoreCase) && char.IsWhiteSpace(rest[rest.Length - sw.Length - 1]))
                            {
                                rest = rest.Substring(0, rest.Length - sw.Length).TrimEnd();
                                cut = true;
                            }
                        }
                    }
                    rest = rest.Trim().Trim('"');
                }
                rest = rest.Trim();
                return rest.Length > 0 ? rest : null;
            }
        }

        // ------------------------------------------------------------ .NET Framework

        /// <summary>
        /// VELOX.exe needs .NET Framework 4.7.2 or newer (every Windows 10 from 1803 on and Windows 11 have it).
        /// Checked before anything is installed: otherwise Windows would greet the user with an English
        /// runtime dialog when VELOX.exe starts. An unknown value (registry not readable) is not a reason to stop.
        /// </summary>
        private static bool NetFrameworkOk(Args a)
        {
            int release = Util.NetFrameworkRelease();
            Log.Info(".NET Framework Release " + (release > 0 ? release.ToString() : "unbekannt"));
            if (release <= 0 || release >= Util.NetFrameworkMinRelease) return true;
            Log.Error(".NET Framework ist zu alt (Release " + release + ", gebraucht: 4.7.2 = " + Util.NetFrameworkMinRelease + ").");
            if (a.Silent) return false;
            int r = DarkDialog.Show(null, "Windows braucht ein Update",
                "VELOX braucht „.NET Framework 4.8“ von Microsoft. Auf diesem PC ist eine ältere Version.\n\n" +
                "Am einfachsten: Windows Update ausführen. Oder lade .NET Framework 4.8 direkt bei Microsoft herunter, installiere es, starte den PC neu und dann dieses Setup noch einmal.",
                null, new[] { "Schließen", "Download öffnen" }, 1, false);
            if (r == 1) Util.OpenUnelevated(Util.NetFrameworkDownloadUrl, Log);
            return false;
        }

        // ------------------------------------------------------------ WebView2 DLLs from the payload

        private static Assembly ResolveFromPayload(object sender, ResolveEventArgs e)
        {
            string name = new AssemblyName(e.Name).Name;
            if (!name.StartsWith("Microsoft.Web.WebView2.", StringComparison.OrdinalIgnoreCase)) return null;
            lock (Loaded)
            {
                Assembly asm;
                if (Loaded.TryGetValue(name, out asm)) return asm;
                try
                {
                    byte[] bytes = Payload.Read(name + ".dll");
                    if (bytes == null) { Log.Warn("Nicht im Paket: " + name); return null; }
                    asm = Assembly.Load(bytes);
                    Loaded[name] = asm;
                    Log.Info("Geladen aus dem Paket: " + name);
                    return asm;
                }
                catch (Exception ex) { Log.Error("Laden fehlgeschlagen (" + name + "): " + ex.Message); return null; }
            }
        }

        /// <summary>Extracts the WebView2Loader.dll for this process architecture; returns its folder or null.</summary>
        public static string ExtractLoader()
        {
            try
            {
                string arch = Util.LoaderArch();
                byte[] dll = Payload.Read("runtimes/" + arch + "/native/WebView2Loader.dll");
                if (dll == null) { Log.Warn("WebView2Loader.dll (" + arch + ") nicht im Paket."); return null; }
                string dir = Path.Combine(TempDir, "loader");
                Directory.CreateDirectory(dir);
                File.WriteAllBytes(Path.Combine(dir, "WebView2Loader.dll"), dll);
                return dir;
            }
            catch (Exception ex) { Log.Warn("WebView2Loader.dll nicht entpackt: " + ex.Message); return null; }
        }

        // ------------------------------------------------------------ modes

        internal static string ResolveUninstallDir(Args a)
        {
            if (!string.IsNullOrEmpty(a.Dir)) return a.Dir.TrimEnd('\\');
            InstalledInfo inf = Installer.Detect();
            if (inf != null) return inf.Dir;
            string own = Path.GetDirectoryName(Application.ExecutablePath);
            if (File.Exists(Path.Combine(own, "VELOX.exe"))) return own;
            return null;
        }

        private static int RunSilent(Args a)
        {
            ProgressFn report = (p, step, file) => { };
            try
            {
                if (a.Uninstall)
                {
                    string dir = ResolveUninstallDir(a);
                    if (dir == null) { Log.Warn("Keine Installation gefunden."); return 0; }
                    bool launcherWaits = a.FromTemp && a.ParentPid > 0 && !string.IsNullOrEmpty(a.ResultFile);
                    Installer.Uninstall(dir, !a.Purge, true, report, launcherWaits);
                    if (launcherWaits)
                    {
                        // the launching Uninstall.exe can only be deleted once it has exited: hand it the result
                        // first (so it exits with it), then wait for it and remove it and the empty folder
                        ReportToLauncher(a.ResultFile, 0);
                        WaitForLauncher(a.ParentPid, 15000);
                        Installer.RemoveLeftovers(dir);
                    }
                    return 0;
                }
                InstalledInfo inf = Installer.Detect();
                var o = new InstallOptions
                {
                    Dir = !string.IsNullOrEmpty(a.Dir) ? a.Dir : (inf != null ? inf.Dir : Installer.DefaultDir()),
                    Desktop = !a.NoDesktop,
                    StartMenu = !a.NoStartMenu,
                    Launch = false,
                    CloseRunning = true
                };
                RunSta(() => Installer.Install(o, report));
                return 0;
            }
            catch (InstallException ex) { Log.Error(ex.Message + " " + ex.Hint); return 1; }
        }

        /// <summary>WScript.Shell is an apartment-threaded COM object: run on an STA thread.</summary>
        internal static void RunSta(Action action)
        {
            Exception err = null;
            var t = new Thread(() => { try { action(); } catch (Exception ex) { err = ex; } });
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join();
            if (err != null)
            {
                if (err is InstallException) throw (InstallException)err;
                throw new InstallException("Unerwarteter Fehler: " + err.Message, "Versuche es noch einmal. Details stehen im Log.", err);
            }
        }

        private static int RunUi(Args a)
        {
            string why = null;
            bool web = false;
            string loader = ExtractLoader();
            if (loader != null) web = CheckWebView(loader, out why);
            if (!web)
            {
                Log.Warn("WebView2 nicht verfügbar: " + why);
                int r = DarkDialog.Show(null, "Ein kleiner Baustein fehlt",
                    "Für die moderne Ansicht von VELOX fehlt „Microsoft Edge WebView2“ – ein kostenloser Baustein von Microsoft, den die meisten PCs schon haben.\n\n" +
                    "Soll ich ihn jetzt herunterladen und installieren? Das dauert etwa eine Minute.",
                    null, new[] { "Ohne weiter", "Ja, installieren" }, 1, false);
                if (r == 1)
                {
                    using (var f = new RuntimeProgressForm(TempDir, Log)) { Application.Run(f); }
                    if (loader != null) web = CheckWebView(loader, out why);
                    if (!web)
                    {
                        Log.Warn("WebView2 weiterhin nicht verfügbar: " + why);
                        DarkDialog.Show(null, "Hat nicht geklappt", "WebView2 konnte nicht installiert werden. Kein Problem: Das Setup läuft auch in der einfachen Ansicht weiter.", null, new[] { "Weiter" }, 0, false);
                    }
                }
            }
            if (web)
            {
                int code;
                if (TryRunWeb(a, out code)) return code;
                Log.Warn("Moderne Ansicht ließ sich nicht starten - einfache Ansicht.");
            }
            using (var f = new FallbackForm(a)) { Application.Run(f); return f.ExitCode; }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static bool CheckWebView(string loaderDir, out string why)
        {
            try { return WebSetup.RuntimeAvailable(loaderDir, out why); }
            catch (Exception ex) { why = ex.GetType().Name + ": " + ex.Message; return false; }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static bool TryRunWeb(Args a, out int code)
        {
            code = 1;
            try { return WebSetup.Run(a, out code); }
            catch (Exception ex) { Log.Error("Moderne Ansicht: " + ex); return false; }
        }

        // ------------------------------------------------------------ uninstall from a temp copy

        private static int RelaunchFromTemp(Args a)
        {
            string dir = ResolveUninstallDir(a);
            if (dir == null)
            {
                if (!a.Silent) DarkDialog.Show(null, "VELOX ist nicht installiert", "Es wurde keine VELOX-Installation gefunden.", null, new[] { "OK" }, 0, false);
                return 0;
            }
            string tmp = Util.CreatePrivateTempDir("VeloxUninstall-");
            string copy = Path.Combine(tmp, "Uninstall.exe");
            File.Copy(Application.ExecutablePath, copy, true);
            string result = Path.Combine(tmp, "result.txt");
            string args = "/uninstall --from-temp --dir " + Util.QuoteArg(dir) + (a.Silent ? " /S" : "") + (a.Purge ? " /purge" : "");
            // silent: the caller (winget, a script) waits for this process and wants the real exit code. The copy
            // reports it through a file, this process exits right away, and only then can the copy delete this
            // Uninstall.exe and the install folder (a running exe's file cannot be deleted).
            if (a.Silent) args += " --parent " + Process.GetCurrentProcess().Id + " --result " + Util.QuoteArg(result);
            Log.Info("Deinstallation läuft aus einer Kopie: " + copy);
            using (Process p = Process.Start(new ProcessStartInfo(copy, args) { UseShellExecute = false, WorkingDirectory = tmp }))
            {
                if (!a.Silent) return 0;
                int code;
                while (true)
                {
                    if (TryReadResult(result, out code)) return code;
                    if (p.WaitForExit(200))
                    {
                        if (TryReadResult(result, out code)) return code;
                        return p.ExitCode;
                    }
                }
            }
        }

        private static void ReportToLauncher(string file, int code)
        {
            try
            {
                string tmp = file + ".tmp";
                File.WriteAllText(tmp, code.ToString(System.Globalization.CultureInfo.InvariantCulture), Encoding.ASCII);
                File.Move(tmp, file);   // atomic: the launcher never reads half a file
            }
            catch (Exception ex) { Log.Warn("Ergebnis nicht übergeben: " + ex.Message); }
        }

        private static bool TryReadResult(string file, out int code)
        {
            code = 1;
            try { return File.Exists(file) && int.TryParse(File.ReadAllText(file, Encoding.ASCII).Trim(), out code); }
            catch (Exception) { return false; }
        }

        private static void WaitForLauncher(int pid, int ms)
        {
            try
            {
                using (Process p = Process.GetProcessById(pid))
                {
                    if (!p.WaitForExit(ms)) Log.Warn("Uninstall.exe (PID " + pid + ") läuft noch - Rest beim nächsten Neustart.");
                }
            }
            catch (Exception) { }   // already gone
        }

        private static void CleanupTemp(Args a)
        {
            // In-process and without a helper "cmd /c ping & rd" - that self-deletion pattern is a classic
            // malware trait that antivirus heuristics flag. The WebView2 browser processes release the user
            // data folder a moment after the window is gone, so retry for a few seconds; whatever is still
            // locked - and always the running exe of the uninstaller's temp copy - Windows deletes at the
            // next restart (MoveFileEx, the same way NSIS-style uninstallers clean up after themselves).
            try
            {
                if (!string.IsNullOrEmpty(TempDir)) DeleteWithRetry(TempDir, 6000);
                if (a.FromTemp)
                {
                    string own = Application.ExecutablePath;
                    string dir = Path.GetDirectoryName(own);
                    if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir) && Path.GetFileName(dir).StartsWith("VeloxUninstall-", StringComparison.OrdinalIgnoreCase))
                    {
                        // deletes what it can; the running exe and then its folder are registered for the restart
                        Util.DeleteTree(dir, true);
                    }
                }
            }
            catch (Exception ex) { Log.Warn("Temp-Ordner bleibt bis zum Neustart: " + ex.Message); }
        }

        private static void DeleteWithRetry(string dir, int ms)
        {
            // everything except loader\WebView2Loader.dll, which this process keeps loaded until it exits
            if (!Directory.Exists(dir)) return;
            var sw = Stopwatch.StartNew();
            while (true)
            {
                bool left = false;
                try
                {
                    foreach (string sub in Directory.GetDirectories(dir))
                    {
                        if (string.Equals(Path.GetFileName(sub), "loader", StringComparison.OrdinalIgnoreCase)) continue;
                        try { Directory.Delete(sub, true); } catch (Exception) { left = true; }
                    }
                    foreach (string f in Directory.GetFiles(dir)) { try { File.Delete(f); } catch (Exception) { left = true; } }
                }
                catch (Exception) { left = true; }
                if (!left || sw.ElapsedMilliseconds > ms) break;
                Thread.Sleep(250);
            }
            Util.DeleteTree(dir, true);   // the rest (at least the loader DLL) goes at the next restart
        }
    }
}
