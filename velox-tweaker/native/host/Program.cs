// VELOX.exe - the installed app: a native window (WinForms + WebView2) around the PowerShell backend.
//
//   VELOX.exe            real mode: elevates itself (UAC), starts Velox.ps1 hidden, shows the UI
//   VELOX.exe --test     Testmodus: no elevation, Velox.ps1 -Simulate (nothing on the PC is changed)
//
// Internal switch: --elevated (set on the relaunch through UAC, prevents a relaunch loop).
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Velox.Native;

namespace Velox.Host
{
    internal static class Program
    {
        public static Log Log;
        public static string AppDir;
        public static string DataDir;
        /// <summary>Started by VeloxSetup.exe right after its own (full) intro: the start screen plays the short one.</summary>
        public static bool FromSetup;
        /// <summary>The user muted the installer's intro (M / sound button): this start screen stays silent too (not saved).</summary>
        public static bool QuietStart;
        private static Mutex _mutex;
        private static uint _activateMsg;

        [STAThread]
        private static int Main(string[] args)
        {
            AppDir = Path.GetDirectoryName(Application.ExecutablePath);
            DataDir = Path.Combine(Util.LocalAppData(), "Velox");
            Log = new Log(Path.Combine(Path.Combine(DataDir, "logs"), "host.log"));
            bool test = HasArg(args, "--test") || HasArg(args, "/test");
            bool elevatedRelaunch = HasArg(args, "--elevated");
            FromSetup = HasArg(args, "--from-setup");
            QuietStart = HasArg(args, "--quiet-start");
            Log.Info("VELOX.exe " + Util.Version() + " startet (" + (test ? "Testmodus" : "echter Modus") + ", Admin: " + Util.IsElevated() + ", " + (IntPtr.Size * 8) + "-Bit)");

            try { Application.EnableVisualStyles(); } catch (Exception) { }
            try { Application.SetCompatibleTextRenderingDefault(false); } catch (Exception) { }
            Application.ThreadException += (s, e) => { Log.Error("UI-Fehler: " + e.Exception); };
            AppDomain.CurrentDomain.UnhandledException += (s, e) => { Log.Error("Unbehandelter Fehler: " + e.ExceptionObject); };
            try { _activateMsg = NativeMethods.RegisterWindowMessage("VELOX.Host.Activate.v1"); } catch (Exception) { _activateMsg = 0; }

            // A second start only brings the running window of the same mode to the front - before any
            // UAC prompt, so double-clicking the icon twice never asks twice.
            if (IsRunning(test))
            {
                ActivateOther(test);
                // the other instance may just be closing (it holds the mutex for up to ~3 s while its backend
                // ends): if the mutex goes away soon, start normally instead of leaving the user with nothing
                if (!WaitUntilFree(test, 4500)) { Log.Info("Läuft schon - vorhandenes Fenster nach vorne geholt."); return 0; }
                Log.Info("Die vorige Instanz hat sich gerade beendet - starte normal.");
            }

            if (!test && !Util.IsElevated())
            {
                if (!elevatedRelaunch)
                {
                    int r = RelaunchElevated(args);
                    if (r == 0) return 0;
                    if (r == 2) return 1;   // could not start at all (already reported)
                }
                // UAC declined (or elevation impossible): offer the Testmodus instead
                int choice = DarkDialog.Show(null, "Ohne Admin-Rechte geht es nicht",
                    "VELOX braucht Administrator-Rechte, um Windows-Einstellungen zu ändern. Du hast die Windows-Abfrage abgelehnt.\n\n" +
                    "Du kannst VELOX aber im Testmodus ausprobieren: Da siehst du alles, aber an deinem PC wird nichts verändert.",
                    null, new[] { "Schließen", "Testmodus starten" }, 1, false);
                if (choice != 1) return 1;
                test = true;
                if (IsRunning(true)) { ActivateOther(true); return 0; }
            }

            if (!AcquireMutex(test)) { ActivateOther(test); return 0; }
            try
            {
                if (!File.Exists(Path.Combine(AppDir, "Velox.ps1")) || !Directory.Exists(Path.Combine(AppDir, "core")))
                {
                    DarkDialog.Show(null, "VELOX ist unvollständig", "Im Programmordner fehlen Dateien (Velox.ps1 oder der Ordner core). Bitte VELOX mit VeloxSetup.exe neu installieren.", AppDir, new[] { "Schließen" }, 0, false);
                    return 1;
                }
                string why;
                if (!WebViewSupport.IsAvailable(AppDir, out why))
                {
                    Log.Warn("WebView2 nicht verfügbar (" + why + ") - Edge-App-Fenster wird benutzt.");
                    return FallbackHost.Run(test);
                }
                bool again;
                do
                {
                    using (var form = new HostForm(test))
                    {
                        Application.Run(form);
                        again = form.FallbackRequested;
                        test = form.IsTest;
                    }
                    if (again) { Log.Warn("WebView2 ließ sich nicht starten - Edge-App-Fenster wird benutzt."); return FallbackHost.Run(test); }
                } while (false);
                return 0;
            }
            catch (Exception ex)
            {
                Log.Error("Abbruch: " + ex);
                DarkDialog.Show(null, "VELOX ist abgestürzt", "Etwas ist schiefgelaufen. Starte VELOX bitte neu. Details stehen im Log.", Log.Path, new[] { "Schließen" }, 0, false);
                return 1;
            }
            finally { ReleaseMutex(); }
        }

        private static bool HasArg(string[] args, string name)
        {
            foreach (string a in args) if (string.Equals(a, name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        // ------------------------------------------------------------ elevation

        /// <summary>0 = elevated copy started, 1 = declined/failed (offer Testmodus), 2 = hard error.</summary>
        private static int RelaunchElevated(string[] args)
        {
            try
            {
                var sb = new System.Text.StringBuilder();
                foreach (string a in args)
                {
                    if (string.Equals(a, "--elevated", StringComparison.OrdinalIgnoreCase)) continue;
                    sb.Append(Util.QuoteArg(a)).Append(' ');
                }
                sb.Append("--elevated");
                var psi = new ProcessStartInfo(Application.ExecutablePath, sb.ToString())
                {
                    UseShellExecute = true,
                    Verb = "runas",
                    WorkingDirectory = AppDir
                };
                using (Process.Start(psi)) { }
                Log.Info("Mit Administrator-Rechten neu gestartet.");
                return 0;
            }
            catch (Win32Exception ex)
            {
                // 1223 = ERROR_CANCELLED: the user said "No" in the UAC prompt
                Log.Warn("Erhöhung abgelehnt oder fehlgeschlagen (" + ex.NativeErrorCode + "): " + ex.Message);
                return 1;
            }
            catch (Exception ex)
            {
                Log.Error("Erhöhung fehlgeschlagen: " + ex.Message);
                return 1;
            }
        }

        // ------------------------------------------------------------ single instance

        private static string MutexName(bool test) { return @"Local\VELOX-Host-" + (test ? "sim" : "real"); }

        private static bool IsRunning(bool test)
        {
            try
            {
                Mutex m;
                if (Mutex.TryOpenExisting(MutexName(test), out m)) { m.Dispose(); return true; }
                return false;
            }
            catch (UnauthorizedAccessException) { return true; }  // exists, created by an elevated instance
            catch (Exception) { return false; }
        }

        private static bool WaitUntilFree(bool test, int ms)
        {
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < ms)
            {
                Thread.Sleep(250);
                if (!IsRunning(test)) return true;
            }
            return false;
        }

        public static bool AcquireMutex(bool test)
        {
            try
            {
                bool created;
                var m = new Mutex(true, MutexName(test), out created);
                if (!created)
                {
                    bool owned = false;
                    try { owned = m.WaitOne(0); } catch (AbandonedMutexException) { owned = true; }
                    if (!owned) { m.Dispose(); return false; }
                }
                _mutex = m;
                return true;
            }
            catch (UnauthorizedAccessException) { return false; }
            catch (Exception ex) { Log.Warn("Mutex nicht verfügbar: " + ex.Message); return true; }
        }

        public static void ReleaseMutex()
        {
            if (_mutex == null) return;
            try { _mutex.ReleaseMutex(); } catch (Exception) { }
            try { _mutex.Dispose(); } catch (Exception) { }
            _mutex = null;
        }

        public static uint ActivateMessage { get { return _activateMsg; } }

        /// <summary>Asks the running window of that mode to come to the front (it may run elevated).</summary>
        public static void ActivateOther(bool test)
        {
            if (_activateMsg == 0) return;
            try { NativeMethods.AllowSetForegroundWindow(NativeMethods.ASFW_ANY); } catch (Exception) { }
            try { NativeMethods.PostMessage(NativeMethods.HWND_BROADCAST, _activateMsg, new IntPtr(test ? 2 : 1), IntPtr.Zero); } catch (Exception) { }
        }
    }
}
