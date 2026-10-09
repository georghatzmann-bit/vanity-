using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Threading;

namespace JarvisSetup
{
    /// <summary>
    /// Der eingebettete Inno-Kern (JarvisKern.exe): entpacken, unsichtbar starten, aufräumen.
    /// Er installiert die Dateien, ruft werkzeuge\installieren.ps1 auf und bleibt für die
    /// Deinstallation und "Apps &amp; Features" zuständig.
    /// </summary>
    static class Kern
    {
        const string Ressource = "JarvisKern.exe";

        public static bool Eingebettet => typeof(Kern).Assembly.GetManifestResourceInfo(Ressource) != null;

        /// <summary>Entpackt den Kern in einen eigenen Ordner unter %TEMP%.</summary>
        public static string Entpacken(out string ordner)
        {
            ordner = Path.Combine(Path.GetTempPath(), "JarvisSetup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(ordner);
            string ziel = Path.Combine(ordner, Ressource);
            using (Stream quelle = typeof(Kern).Assembly.GetManifestResourceStream(Ressource))
            {
                if (quelle == null)
                    throw new InvalidOperationException("Dieses Setup ist unvollständig: Der Installations-Kern fehlt.");
                using (FileStream datei = File.Create(ziel))
                    quelle.CopyTo(datei);
            }
            return ziel;
        }

        public static void Aufraeumen(string ordner)
        {
            if (string.IsNullOrEmpty(ordner))
                return;
            // Ein Virenscanner hält die Datei manchmal noch kurz fest.
            for (int versuch = 0; versuch < 10; versuch++)
            {
                try
                {
                    if (Directory.Exists(ordner))
                        Directory.Delete(ordner, true);
                    return;
                }
                catch (Exception)
                {
                    Thread.Sleep(200);
                }
            }
        }

        /// <summary>Ohne Oberfläche: alle Schalter an den Kern, dessen Rückgabewert zurück.</summary>
        public static int StillAusfuehren(string argumente)
        {
            string ordner = null;
            try
            {
                string kern = Entpacken(out ordner);
                var start = new ProcessStartInfo(kern, argumente)
                {
                    UseShellExecute = false,
                    // Relative Pfade (z. B. /LOG=setup.log) gelten wie bisher im aktuellen Ordner.
                    WorkingDirectory = Environment.CurrentDirectory,
                };
                using (Process prozess = Process.Start(start))
                {
                    prozess.WaitForExit();
                    return prozess.ExitCode;
                }
            }
            catch (Exception ex)
            {
                Umgebung.FehlerMerken(ex);
                return 1;
            }
            finally
            {
                Aufraeumen(ordner);
            }
        }
    }

    /// <summary>
    /// Eine Installation mit Oberfläche: startet den Kern unsichtbar und liest seine
    /// Fortschritts-Zeilen (JARVIS-...) aus der Datei in JARVIS_FORTSCHRITT.
    /// </summary>
    sealed class Lauf
    {
        public event Action<Meldung> Gemeldet;
        public event Action<int> Beendet;

        /// <summary>Protokoll des Inno-Kerns (Dateien kopieren).</summary>
        public string InnoProtokoll { get; private set; }
        public DateTime Beginn { get; private set; }
        public bool Laeuft => prozess != null && !fertig;

        Process prozess;
        string ordner;
        string datei;
        long gelesen;
        DispatcherTimer uhr;
        bool fertig;

        public void Starten(bool autostart, bool desktop)
        {
            Beginn = DateTime.Now;
            string kern = Kern.Entpacken(out ordner);
            datei = Path.Combine(ordner, "fortschritt.txt");
            File.WriteAllText(datei, "");
            Directory.CreateDirectory(Umgebung.DatenOrdner);
            InnoProtokoll = Path.Combine(Umgebung.DatenOrdner, "setup.log");
            string aufgaben = (autostart ? "autostart" : "!autostart") + "," + (desktop ? "desktopicon" : "!desktopicon");
            string argumente = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /MERGETASKS=\"" + aufgaben + "\" /LOG=\"" + InnoProtokoll + "\"";
            var start = new ProcessStartInfo(kern, argumente)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = ordner,
            };
            start.EnvironmentVariables["JARVIS_FORTSCHRITT"] = datei;
            prozess = Process.Start(start);
            uhr = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromMilliseconds(200) };
            uhr.Tick += Ticken;
            uhr.Start();
        }

        void Ticken(object sender, EventArgs e)
        {
            bool zuEnde = prozess.HasExited;
            foreach (string zeile in NeueZeilen(zuEnde))
            {
                Meldung meldung = Meldung.Lesen(zeile);
                if (meldung != null)
                    Gemeldet?.Invoke(meldung);
            }
            if (!zuEnde)
                return;
            uhr.Stop();
            fertig = true;
            int code = prozess.ExitCode;
            prozess.Dispose();
            Kern.Aufraeumen(ordner);
            Beendet?.Invoke(code);
        }

        /// <summary>Neue ganze Zeilen seit dem letzten Mal (am Ende auch den Rest).</summary>
        List<string> NeueZeilen(bool alles)
        {
            var zeilen = new List<string>();
            try
            {
                using (var fs = new FileStream(datei, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    if (fs.Length <= gelesen)
                        return zeilen;
                    fs.Position = gelesen;
                    var puffer = new byte[fs.Length - gelesen];
                    int n = fs.Read(puffer, 0, puffer.Length);
                    if (n <= 0)
                        return zeilen;
                    int ende = alles ? n : Array.LastIndexOf(puffer, (byte)'\n', n - 1) + 1;
                    if (ende <= 0)
                        return zeilen;
                    gelesen += ende;
                    foreach (string roh in Encoding.UTF8.GetString(puffer, 0, ende).Split('\n'))
                    {
                        string zeile = roh.Trim('\r', ' ', '\t', '﻿');
                        if (zeile.Length > 0)
                            zeilen.Add(zeile);
                    }
                }
            }
            catch (IOException)
            {
                // Gerade gesperrt (der Kern schreibt): beim nächsten Mal.
            }
            catch (UnauthorizedAccessException)
            {
            }
            return zeilen;
        }

        /// <summary>Bricht ab: beendet den Kern samt PowerShell, pip und allen anderen Kindern.</summary>
        public void Abbrechen()
        {
            if (prozess == null || fertig)
                return;
            try
            {
                var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "taskkill.exe"), "/PID " + prozess.Id + " /T /F")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                using (Process taskkill = Process.Start(start))
                    taskkill.WaitForExit(8000);
            }
            catch (Exception ex)
            {
                Umgebung.FehlerMerken(ex);
            }
        }
    }
}
