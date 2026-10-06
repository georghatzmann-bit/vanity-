// VeloxSetup.exe - one self-contained installer (and, copied as Uninstall.exe, the uninstaller).
//
//   VeloxSetup.exe                     installer UI (or update UI when VELOX is installed)
//   VeloxSetup.exe /S [/D=<folder>]    silent install (default folder: C:\Program Files\VELOX)
//   Uninstall.exe /uninstall           uninstall UI
//   Uninstall.exe /uninstall /S        silent uninstall (keeps settings and backups)
//   options: /nodesktop  /nostartmenu  /nolaunch (silent install never starts VELOX)  /purge (uninstall: delete data)
//
// Internal: --from-temp --dir "<folder>" (the uninstaller re-runs itself from a temp copy so it can
// delete its own folder).
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
            var a = new Args(args);
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
                if (a.Uninstall && !a.FromTemp) return RelaunchFromTemp(a);
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
            public Args(string[] args)
            {
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
                    else if (l == "--dir" && i + 1 < args.Length) Dir = args[++i];
                    else if (l.StartsWith("/d=", StringComparison.Ordinal)) Dir = x.Substring(3);
                }
            }
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
                    Installer.Uninstall(dir, !a.Purge, true, report);
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
            string args = "/uninstall --from-temp --dir " + Util.QuoteArg(dir) + (a.Silent ? " /S" : "") + (a.Purge ? " /purge" : "");
            Log.Info("Deinstallation läuft aus einer Kopie: " + copy);
            using (Process p = Process.Start(new ProcessStartInfo(copy, args) { UseShellExecute = false, WorkingDirectory = tmp }))
            {
                if (!a.Silent) return 0;
                p.WaitForExit();
                return p.ExitCode;
            }
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
