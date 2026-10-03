using System;
using System.Threading;
using System.Windows;

namespace JarvisSetup
{
    /// <summary>
    /// Start von JarvisSetup.exe.
    ///   JarvisSetup.exe                      Oberfläche, installiert über den eingebetteten Inno-Kern
    ///   JarvisSetup.exe /VERYSILENT ...      ohne Oberfläche: alle Schalter gehen an den Kern,
    ///                                        sein Rückgabewert ist unserer (für die Proben im Build)
    ///   JarvisSetup.exe /vorschau            spielt die Seiten mit gespieltem Fortschritt durch
    ///   JarvisSetup.exe /vorschau=fehler     dasselbe, endet aber mit einem Fehler
    ///   JarvisSetup.exe /bilder=ORDNER       Bildschirmfotos aller Seiten speichern, dann beenden
    /// </summary>
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            Optionen optionen = Optionen.Lesen(args, Environment.CommandLine);
            if (optionen.Still)
                return Kern.StillAusfuehren(optionen.RoheArgumente);

            if (!optionen.Vorschau)
            {
                string hindernis = Umgebung.Hindernis();
                if (hindernis != null)
                {
                    MessageBox.Show(hindernis, "Jarvis Setup", MessageBoxButton.OK, MessageBoxImage.Warning);
                    return 1;
                }
            }

            // Nur eine Oberfläche gleichzeitig. Ein zweiter Doppelklick holt die erste nach vorn.
            using (var sperre = new Mutex(false, @"Local\JarvisSetupOberflaeche", out bool erste))
            {
                if (!erste && !optionen.Vorschau)
                {
                    Umgebung.AnderesSetupNachVorn();
                    return 0;
                }
                var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
                app.DispatcherUnhandledException += (sender, e) =>
                {
                    Umgebung.FehlerMerken(e.Exception);
                    e.Handled = true;
                    MessageBox.Show("Im Setup ist ein unerwarteter Fehler passiert:\n\n" + e.Exception.Message +
                        "\n\nBitte starten Sie JarvisSetup.exe noch einmal.", "Jarvis Setup", MessageBoxButton.OK, MessageBoxImage.Error);
                    app.Shutdown(1);
                };
                var fenster = new Hauptfenster(optionen);
                app.Run(fenster);
                GC.KeepAlive(sperre);
                return fenster.Rueckgabe;
            }
        }
    }

    /// <summary>Was in der Kommandozeile steht.</summary>
    sealed class Optionen
    {
        /// <summary>/VERYSILENT oder /SILENT: ohne Oberfläche, alles an den Inno-Kern.</summary>
        public bool Still;
        /// <summary>Alles nach dem Programmnamen, genau so, wie es übergeben wurde.</summary>
        public string RoheArgumente = "";
        /// <summary>/vorschau: nichts installieren, nur die Seiten zeigen.</summary>
        public bool Vorschau;
        /// <summary>/vorschau=fehler: die gespielte Installation endet mit einem Fehler.</summary>
        public bool VorschauFehler;
        /// <summary>/bilder=ORDNER: Bildschirmfotos der Seiten speichern, dann beenden.</summary>
        public string BilderOrdner;

        public static Optionen Lesen(string[] args, string kommandozeile)
        {
            var o = new Optionen { RoheArgumente = OhneProgramm(kommandozeile) };
            foreach (string a in args)
            {
                string wert = a.Trim();
                string klein = wert.ToLowerInvariant();
                if (klein == "/verysilent" || klein == "/silent")
                    o.Still = true;
                else if (klein == "/vorschau")
                    o.Vorschau = true;
                else if (klein == "/vorschau=fehler")
                    o.Vorschau = o.VorschauFehler = true;
                else if (klein.StartsWith("/bilder="))
                {
                    o.Vorschau = true;
                    o.BilderOrdner = wert.Substring("/bilder=".Length).Trim('"');
                }
            }
            if (o.Vorschau)
                o.Still = false;
            return o;
        }

        static string OhneProgramm(string zeile)
        {
            if (string.IsNullOrEmpty(zeile))
                return "";
            zeile = zeile.TrimStart();
            int ende;
            if (zeile.StartsWith("\""))
            {
                ende = zeile.IndexOf('"', 1);
                ende = ende < 0 ? zeile.Length : ende + 1;
            }
            else
            {
                ende = 0;
                while (ende < zeile.Length && !char.IsWhiteSpace(zeile[ende]))
                    ende++;
            }
            return zeile.Substring(ende).Trim();
        }
    }
}
