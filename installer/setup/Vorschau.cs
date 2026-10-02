using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace JarvisSetup
{
    /// <summary>
    /// /vorschau: die Seiten mit gespieltem Fortschritt, ohne etwas zu installieren.
    /// /bilder=ORDNER: dazu Bildschirmfotos aller Seiten (für den Build auf GitHub).
    /// </summary>
    public partial class Hauptfenster
    {
        /// <summary>Fester Gesamtfortschritt für die Bilder (null: der echte).</summary>
        double? vorschauZiel;
        /// <summary>Feste Restzeit für die Bilder.</summary>
        string vorschauRest;
        /// <summary>Feste Protokollzeilen für die Bilder.</summary>
        string[] vorschauZeilen;
        bool vorschauLaeuft;
        DispatcherTimer vorschauUhr;

        /// <summary>So meldet es eine echte Installation (gekürzt auf 14 Sekunden).</summary>
        static readonly (int Ms, string Zeile)[] Drehbuch =
        {
            (0, "JARVIS-SCHRITT 1/6 Vorbereiten"),
            (300, "JARVIS-ANTEIL 40"),
            (800, "JARVIS-ANTEIL 80"),
            (1200, "JARVIS-OK 1"),
            (1300, "JARVIS-SCHRITT 2/6 Python"),
            (1400, "JARVIS-DETAIL Python 3.12 wird geladen: 6 von 25 MB"),
            (2100, "JARVIS-DETAIL Python 3.12 wird geladen: 19 von 25 MB"),
            (2200, "JARVIS-ANTEIL 50"),
            (2600, "JARVIS-DETAIL Python 3.12 wird eingerichtet"),
            (3500, "JARVIS-OK 2 Python 3.12"),
            (3600, "JARVIS-SCHRITT 3/6 Pakete"),
            (3700, "JARVIS-DETAIL Eigene Python-Umgebung wird angelegt"),
            (4400, "JARVIS-DETAIL Pakete werden geladen: 14 von etwa 60"),
            (4500, "JARVIS-ANTEIL 25"),
            (5500, "JARVIS-DETAIL Pakete werden geladen: 37 von etwa 60"),
            (5600, "JARVIS-ANTEIL 52"),
            (6700, "JARVIS-DETAIL Pakete werden geladen: 58 von etwa 60"),
            (6800, "JARVIS-ANTEIL 78"),
            (7400, "JARVIS-DETAIL Oberfläche und Extras: pywebview (1 von 7)"),
            (8300, "JARVIS-ANTEIL 95"),
            (8700, "JARVIS-OK 3"),
            (8800, "JARVIS-SCHRITT 4/6 Spracherkennung"),
            (8900, "JARVIS-DETAIL Spracherkennung wird geladen: 96 von etwa 460 MB"),
            (9800, "JARVIS-DETAIL Spracherkennung wird geladen: 310 von etwa 460 MB"),
            (9900, "JARVIS-ANTEIL 70"),
            (10700, "JARVIS-OK 4"),
            (10800, "JARVIS-SCHRITT 5/6 Jarvis' Gehirn"),
            (10900, "JARVIS-DETAIL Claude Code wird geladen: 120 von 236 MB"),
            (11700, "JARVIS-DETAIL Claude Code wird eingerichtet"),
            (12200, "JARVIS-OK 5"),
            (12300, "JARVIS-SCHRITT 6/6 Windows-Bausteine"),
            (12400, "JARVIS-DETAIL Symbol wird angelegt"),
            (13300, "JARVIS-OK 6"),
            (13400, "JARVIS-FERTIG"),
        };

        /// <summary>Endet die gespielte Installation mit einem Fehler (/vorschau=fehler), dann so.</summary>
        static readonly (int Ms, string Zeile)[] DrehbuchFehler =
        {
            (0, "JARVIS-SCHRITT 1/6 Vorbereiten"),
            (900, "JARVIS-OK 1"),
            (1000, "JARVIS-SCHRITT 2/6 Python"),
            (2000, "JARVIS-OK 2 Python 3.12"),
            (2100, "JARVIS-SCHRITT 3/6 Pakete"),
            (2200, "JARVIS-DETAIL Pakete werden geladen: 21 von etwa 60"),
            (2300, "JARVIS-ANTEIL 30"),
            (4000, "JARVIS-TIPP Prüfen Sie das Internet und klicken Sie auf „Nochmal versuchen“. Was schon geladen ist, bleibt erhalten."),
            (4000, "JARVIS-FEHLER 3 14 Die Verbindung ist beim Laden der Pakete abgebrochen."),
        };

        static readonly string[] BeispielProtokoll =
        {
            "Collecting faster-whisper>=1.0.0 (from -r requirements.txt (line 6))",
            "  Downloading faster_whisper-1.2.0-py3-none-any.whl (1.1 MB)",
            "Collecting ctranslate2<5,>=4.0 (from faster-whisper>=1.0.0)",
            "  Downloading ctranslate2-4.6.0-cp312-cp312-win_amd64.whl (18.9 MB)",
            "Collecting onnxruntime>=1.16 (from -r requirements.txt (line 5))",
            "  Downloading onnxruntime-1.22.1-cp312-cp312-win_amd64.whl (12.7 MB)",
            "Collecting av>=11 (from faster-whisper>=1.0.0)",
            "  Downloading av-15.0.0-cp312-cp312-win_amd64.whl (31.9 MB)",
            "Collecting tokenizers<1,>=0.13 (from faster-whisper>=1.0.0)",
        };

        /// <summary>Für die Bilder: ein ruhiger, dunkler Hintergrund statt der Fenster auf dem Desktop.
        /// Das Setup-Fenster gehört ihm und liegt deshalb immer darüber.</summary>
        void KulisseZeigen()
        {
            var kulisse = new Window
            {
                WindowStyle = WindowStyle.None,
                ResizeMode = ResizeMode.NoResize,
                ShowInTaskbar = false,
                ShowActivated = false,
                Background = new LinearGradientBrush(Color.FromRgb(0x2A, 0x2E, 0x3A), Color.FromRgb(0x14, 0x16, 0x1C), 45),
                Left = SystemParameters.VirtualScreenLeft,
                Top = SystemParameters.VirtualScreenTop,
                Width = SystemParameters.VirtualScreenWidth,
                Height = SystemParameters.VirtualScreenHeight,
                Topmost = true,
            };
            kulisse.Show();
            Owner = kulisse;
            Topmost = true;
        }

        void VorschauVorbereiten()
        {
            warInstalliert = false;
            SchalterAutostart.IsChecked = true;
            SchalterDesktop.IsChecked = false;
            PlatzZeigen(214L * 1073741824, "C:");
            LaeuftHinweis.Visibility = Visibility.Collapsed;
            StartTexteSetzen();
        }

        /// <summary>Nach "Installieren" in der Vorschau: das Drehbuch abspielen.</summary>
        void VorschauAbspielen()
        {
            var drehbuch = optionen.VorschauFehler ? DrehbuchFehler : Drehbuch;
            int naechste = 0;
            DateTime beginn = DateTime.Now;
            vorschauLaeuft = true;
            vorschauUhr?.Stop();
            vorschauUhr = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
            vorschauUhr.Tick += (s, e) =>
            {
                double ms = (DateTime.Now - beginn).TotalMilliseconds;
                while (naechste < drehbuch.Length && drehbuch[naechste].Ms <= ms)
                {
                    Meldung meldung = Meldung.Lesen(drehbuch[naechste].Zeile);
                    if (meldung != null)
                        fortschritt.Anwenden(meldung, DateTime.Now);
                    naechste++;
                }
                if (naechste < drehbuch.Length)
                    return;
                vorschauUhr.Stop();
                vorschauLaeuft = false;
                if (abbruchBestaetigt)
                {
                    Close();
                    return;
                }
                LaufBeendet(fortschritt.Fehlgeschlagen ? 114 : 0);
            };
            vorschauUhr.Start();
        }

        /// <summary>Spielt Meldungen sofort ein (für feste Zustände auf den Bildern).</summary>
        void Einspielen(params string[] zeilen)
        {
            foreach (string zeile in zeilen)
            {
                Meldung meldung = Meldung.Lesen(zeile);
                if (meldung != null)
                    fortschritt.Anwenden(meldung, DateTime.Now);
            }
        }

        async Task BilderMachenAsync()
        {
            string ordner = optionen.BilderOrdner;
            // Sicherheitsnetz für den Build: nach zwei Minuten auf jeden Fall beenden.
            var notfall = new DispatcherTimer { Interval = TimeSpan.FromMinutes(2) };
            notfall.Tick += (s, e) =>
            {
                notfall.Stop();
                Rueckgabe = 3;
                abbruchBestaetigt = true;
                Close();
            };
            notfall.Start();
            try
            {
                Directory.CreateDirectory(ordner);
                Activate();
                // Die Maus aus dem Bild (sonst zeigt eine Zeile ihren Hover-Zustand).
                Native.SetCursorPos(0, 0);

                // 1. Start (frischer PC), dann mit Hinweisen (Jarvis läuft, wenig Platz)
                await Task.Delay(1600);
                Foto(ordner, "start.png");
                Rendern(ordner, "start-150.png", 1.5);
                LaeuftHinweis.Visibility = Visibility.Visible;
                PlatzZeigen((long)(2.1 * 1073741824), "C:");
                await Task.Delay(500);
                Foto(ordner, "start-hinweise.png");
                LaeuftHinweis.Visibility = Visibility.Collapsed;
                PlatzZeigen(214L * 1073741824, "C:");

                // 2. Fortschritt bei etwa 40 %: Schritt 3 läuft
                vorschauRest = "noch etwa 3 Minuten";
                vorschauZiel = 0.40;
                Installieren_Click(this, new RoutedEventArgs());
                Einspielen("JARVIS-SCHRITT 1/6 Vorbereiten", "JARVIS-OK 1",
                    "JARVIS-SCHRITT 2/6 Python", "JARVIS-OK 2 Python 3.12",
                    "JARVIS-SCHRITT 3/6 Pakete", "JARVIS-DETAIL Pakete werden geladen: 34 von etwa 60", "JARVIS-ANTEIL 57");
                RestText.Text = vorschauRest;
                await Task.Delay(2200);
                Foto(ordner, "fortschritt.png");
                Rendern(ordner, "fortschritt-150.png", 1.5);

                // 2b. Details aufgeklappt
                vorschauZeilen = BeispielProtokoll;
                DetailsOeffnen();
                await Task.Delay(700);
                Foto(ordner, "fortschritt-details.png");
                DetailsSchliessen(false);

                // 2c. Rückfrage beim Abbrechen (Esc)
                RueckfrageZeigen();
                await Task.Delay(600);
                Foto(ordner, "abbrechen.png");
                RueckfrageSchliessen();
                await Task.Delay(400);

                // 3. Fertig
                vorschauZiel = null;
                Einspielen("JARVIS-SCHRITT 4/6 Spracherkennung", "JARVIS-OK 4", "JARVIS-SCHRITT 5/6 Jarvis' Gehirn", "JARVIS-OK 5",
                    "JARVIS-SCHRITT 6/6 Windows-Bausteine", "JARVIS-OK 6", "JARVIS-FERTIG");
                Geschafft();
                await Task.Delay(2400);
                Foto(ordner, "fertig.png");

                // 4. Fehler
                fortschritt.Zuruecksetzen();
                Einspielen("JARVIS-SCHRITT 1/6 Vorbereiten", "JARVIS-OK 1", "JARVIS-SCHRITT 2/6 Python", "JARVIS-OK 2",
                    "JARVIS-SCHRITT 3/6 Pakete", "JARVIS-ANTEIL 30",
                    "JARVIS-TIPP Prüfen Sie das Internet und klicken Sie auf „Nochmal versuchen“. Was schon geladen ist, bleibt erhalten.",
                    "JARVIS-FEHLER 3 14 Die Verbindung ist beim Laden der Pakete abgebrochen.");
                angezeigt = fortschritt.Gesamt(DateTime.Now);
                FortschrittAnzeigen(angezeigt);
                Fehlgeschlagen(114);
                await Task.Delay(1200);
                Foto(ordner, "fehler.png");
                Rendern(ordner, "fehler-150.png", 1.5);

                Rueckgabe = 0;
            }
            catch (Exception ex)
            {
                Umgebung.FehlerMerken(ex);
                try
                {
                    File.WriteAllText(Path.Combine(ordner, "fehler.txt"), ex.ToString());
                }
                catch (Exception)
                {
                }
                Rueckgabe = 2;
            }
            notfall.Stop();
            abbruchBestaetigt = true;
            Close();
        }

        /// <summary>Echtes Bildschirmfoto des Fensters (mit Schatten und Desktop dahinter).</summary>
        void Foto(string ordner, string name)
        {
            IntPtr fenster = new WindowInteropHelper(this).Handle;
            if (!Native.GetWindowRect(fenster, out Native.RECT r))
                return;
            int breite = r.Right - r.Left, hoehe = r.Bottom - r.Top;
            using (var bild = new System.Drawing.Bitmap(breite, hoehe, System.Drawing.Imaging.PixelFormat.Format32bppRgb))
            {
                using (var grafik = System.Drawing.Graphics.FromImage(bild))
                {
                    // BitBlt mit CAPTUREBLT: so kommt auch ein durchsichtiges (geschichtetes) Fenster mit aufs Bild.
                    IntPtr ziel = grafik.GetHdc();
                    IntPtr bildschirm = Native.GetDC(IntPtr.Zero);
                    try
                    {
                        Native.BitBlt(ziel, 0, 0, breite, hoehe, bildschirm, r.Left, r.Top, Native.SRCCOPY | Native.CAPTUREBLT);
                    }
                    finally
                    {
                        Native.ReleaseDC(IntPtr.Zero, bildschirm);
                        grafik.ReleaseHdc(ziel);
                    }
                }
                bild.Save(Path.Combine(ordner, name), System.Drawing.Imaging.ImageFormat.Png);
            }
        }

        /// <summary>Das Fenster gerendert in einer anderen Skalierung (1.5 = 150 %), Ecken durchsichtig.</summary>
        void Rendern(string ordner, string name, double faktor)
        {
            double breite = Karte.ActualWidth, hoehe = Karte.ActualHeight;
            var bild = new RenderTargetBitmap((int)Math.Ceiling(breite * faktor), (int)Math.Ceiling(hoehe * faktor), 96 * faktor, 96 * faktor, PixelFormats.Pbgra32);
            var zeichnung = new DrawingVisual();
            using (DrawingContext dc = zeichnung.RenderOpen())
                dc.DrawRectangle(new VisualBrush(Karte) { Stretch = Stretch.None, AlignmentX = AlignmentX.Left, AlignmentY = AlignmentY.Top },
                    null, new Rect(0, 0, breite, hoehe));
            bild.Render(zeichnung);
            var png = new PngBitmapEncoder();
            png.Frames.Add(BitmapFrame.Create(bild));
            using (FileStream datei = File.Create(Path.Combine(ordner, name)))
                png.Save(datei);
        }
    }
}
