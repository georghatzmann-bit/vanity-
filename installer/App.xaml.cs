// HELIX-Setup – Start: Befehlszeile auswerten, still installieren (für Tests) oder das Fenster öffnen.
//
//   HELIX-Setup.exe                      normale Installation mit Fenster
//   HELIX-Setup.exe /uninstall           Deinstallation (so steht es in "Apps & Features")
//   /silent                              ohne Fenster (Exit-Code 0 = Erfolg)
//   /source=<zip-Datei oder https-URL>   andere Quelle als GitHub
//   /dir=<Ordner>                        Installationsordner
//   /nodesktop  /nostartmenu  /run       Verknüpfungen weglassen / HELIX danach starten
//   /removedata                          bei der Deinstallation auch Profile und Sicherungen löschen

using System;
using System.Linq;
using System.Threading;
using System.Windows;

namespace HelixSetup
{
    public sealed class SetupArgs
    {
        public bool Uninstall, Silent, NoDesktop, NoStartMenu, Run, RemoveData, TempCopy;
        public string Source, Dir, From;
        public string[] Raw;

        public static SetupArgs Parse(string[] args)
        {
            var a = new SetupArgs { Raw = args };
            foreach (var arg in args)
            {
                var s = arg.Trim();
                string Val(string prefix) => s.Substring(prefix.Length).Trim('"');
                if (s.Equals("/uninstall", StringComparison.OrdinalIgnoreCase)) a.Uninstall = true;
                else if (s.Equals("/silent", StringComparison.OrdinalIgnoreCase) || s.Equals("/S", StringComparison.Ordinal)) a.Silent = true;
                else if (s.Equals("/nodesktop", StringComparison.OrdinalIgnoreCase)) a.NoDesktop = true;
                else if (s.Equals("/nostartmenu", StringComparison.OrdinalIgnoreCase)) a.NoStartMenu = true;
                else if (s.Equals("/run", StringComparison.OrdinalIgnoreCase)) a.Run = true;
                else if (s.Equals("/removedata", StringComparison.OrdinalIgnoreCase)) a.RemoveData = true;
                else if (s.Equals("/tempcopy", StringComparison.OrdinalIgnoreCase)) a.TempCopy = true;
                else if (s.StartsWith("/source=", StringComparison.OrdinalIgnoreCase)) a.Source = Val("/source=");
                else if (s.StartsWith("/dir=", StringComparison.OrdinalIgnoreCase)) a.Dir = Val("/dir=");
                else if (s.StartsWith("/from=", StringComparison.OrdinalIgnoreCase)) a.From = Val("/from=");
            }
            return a;
        }
    }

    public partial class App : Application
    {
        public static SetupArgs Args { get; private set; }

        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            Args = SetupArgs.Parse(e.Args);
            Engine.Log($"Setup {Engine.BuildVersion} gestartet: {string.Join(" ", e.Args)}");

            // Aus dem Installationsordner gestartet? Dann erst nach %TEMP% kopieren, sonst lässt sich der Ordner
            // weder ersetzen noch löschen.
            if (!Args.TempCopy)
            {
                var installed = Engine.InstalledDir();
                try
                {
                    if (Engine.RelaunchFromTemp(e.Args, installed))
                    {
                        Shutdown(0);
                        return;
                    }
                }
                catch (Exception ex) { Engine.Log("Neustart aus Temp: " + ex.Message); }
            }

            if (Args.Silent)
            {
                ShutdownMode = ShutdownMode.OnExplicitShutdown;
                int code = RunSilent();
                if (Args.TempCopy) Engine.ScheduleSelfDelete();
                Shutdown(code);
                return;
            }

            var w = new MainWindow();
            MainWindow = w;
            w.Show();
        }

        int RunSilent()
        {
            try
            {
                if (Args.Uninstall)
                {
                    Engine.Uninstall(Args.From ?? Engine.InstalledDir(), Args.RemoveData, null);
                    return 0;
                }
                var cts = new CancellationTokenSource();
                var rel = Engine.FindRelease(Args.Source, cts.Token).GetAwaiter().GetResult();
                var tmp = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "HELIX-Download");
                var zip = Engine.Fetch(rel, tmp, null, cts.Token).GetAwaiter().GetResult();
                Engine.Install(zip, rel, new InstallOptions
                {
                    InstallDir = Args.Dir ?? Engine.InstalledDir() ?? Engine.DefaultInstallDir,
                    DesktopShortcut = !Args.NoDesktop,
                    StartMenuShortcut = !Args.NoStartMenu,
                }, null);
                if (Args.Run) Engine.StartHelix(Args.Dir ?? Engine.InstalledDir());
                return 0;
            }
            catch (Exception ex)
            {
                Engine.Log("FEHLER (still): " + ex);
                Console.Error.WriteLine(ex.Message);
                return 1;
            }
        }

        protected override void OnExit(ExitEventArgs e)
        {
            Engine.CleanupMedia();
            base.OnExit(e);
        }
    }
}
