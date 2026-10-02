using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Shell;
using System.Windows.Threading;

namespace JarvisSetup
{
    public partial class Hauptfenster : Window
    {
        enum Seite { Start, Fortschritt, Fertig, Fehler }

        static readonly CultureInfo Deutsch = CultureInfo.GetCultureInfo("de-DE");
        static readonly Color FarbeAkzentHell = Color.FromRgb(0x9A, 0xAB, 0xFF);
        static readonly Color FarbeErfolg = Color.FromRgb(0x3F, 0xBF, 0x85);
        static readonly Color FarbeFehler = Color.FromRgb(0xF2, 0x64, 0x5F);

        readonly Optionen optionen;
        /// <summary>Windows-Einstellung "Animationen anzeigen". Aus: keine Bewegung.</summary>
        readonly bool bewegung = SystemParameters.ClientAreaAnimation;
        readonly Fortschritt fortschritt = new Fortschritt();
        readonly DispatcherTimer takt;

        Lauf lauf;
        Seite seite = Seite.Start;
        FrameworkElement aktuelleSeite;
        double angezeigt;
        DateTime letzterTakt;
        DateTime restGeaendert;
        DateTime detailsGelesen;
        DateTime laufBeginn;
        bool warInstalliert;
        bool jarvisLief;
        bool jarvisImHintergrund;
        bool abbruchBestaetigt;
        bool rueckfrageOffen;
        bool detailsOffen;
        bool zielFertig;

        /// <summary>Rückgabewert des Programms (0: alles gut).</summary>
        public int Rueckgabe { get; private set; } = 1;

        internal Hauptfenster(Optionen optionen)
        {
            this.optionen = optionen;
            InitializeComponent();
            KugelFormen(0);  // die Form steht schon vor dem ersten Bild
            SchrittListe.ItemsSource = fortschritt.Schritte;
            Version version = typeof(Hauptfenster).Assembly.GetName().Version;
            VersionText.Text = "Version " + version.Major + "." + version.Minor + "." + version.Build;
            // Kein eigenes Icon setzen: Ohne nimmt WPF das Symbol der EXE in allen Größen (scharf in der Taskleiste).
            aktuelleSeite = SeiteStart;
            takt = new DispatcherTimer(DispatcherPriority.Render) { Interval = TimeSpan.FromMilliseconds(33) };
            takt.Tick += Takt;
            Loaded += Geladen;
            PreviewKeyDown += Taste;
            if (optionen.BilderOrdner != null)
                KulisseZeigen();
        }

        // ------------------------------------------------------------------ Start

        void Geladen(object sender, RoutedEventArgs e)
        {
            AnBildschirmAnpassen();
            KugelStarten();
            KernAtmen(3.6);
            if (optionen.Vorschau)
                VorschauVorbereiten();
            else
                UmgebungPruefen();
            KnopfInstallieren.Focus();
            if (optionen.BilderOrdner != null)
                _ = BilderMachenAsync();
        }

        /// <summary>Auf kleinen Bildschirmen (z. B. 1366 x 768 bei 150 %) passt das Fenster sonst nicht.</summary>
        void AnBildschirmAnpassen()
        {
            Rect frei = SystemParameters.WorkArea;
            double breite = Wurzel.ActualWidth + 48, hoehe = Wurzel.ActualHeight + 48;
            double skala = Math.Min(1, Math.Min(frei.Width / breite, frei.Height / hoehe));
            if (skala >= 0.98)
                return;
            Wurzel.LayoutTransform = new ScaleTransform(skala, skala);
            UpdateLayout();
            Left = frei.Left + (frei.Width - ActualWidth) / 2;
            Top = frei.Top + (frei.Height - ActualHeight) / 2;
        }

        void UmgebungPruefen()
        {
            warInstalliert = Umgebung.Installiert;
            SchalterAutostart.IsChecked = !warInstalliert || Umgebung.AutostartAn;
            SchalterDesktop.IsChecked = warInstalliert && Umgebung.DesktopSymbol;
            long frei = Umgebung.FreierPlatz(out string laufwerk);
            PlatzZeigen(frei, laufwerk);
            jarvisLief = Umgebung.JarvisLaeuft();
            LaeuftHinweis.Visibility = jarvisLief ? Visibility.Visible : Visibility.Collapsed;
            StartTexteSetzen();
            // Ob Jarvis unsichtbar läuft, steht in seiner Kommandozeile (WMI dauert einen Moment).
            Task.Run(() => Umgebung.LaufendesJarvis()).ContinueWith(t =>
            {
                if (t.Status != TaskStatus.RanToCompletion || !t.Result.Laeuft)
                    return;
                jarvisLief = true;
                jarvisImHintergrund = t.Result.Hintergrund;
                if (seite == Seite.Start)
                    LaeuftHinweis.Visibility = Visibility.Visible;
            }, TaskScheduler.FromCurrentSynchronizationContext());
        }

        void StartTexteSetzen()
        {
            StartTitel.Text = warInstalliert ? "Jarvis aktualisieren" : "Jarvis installieren";
            StartSatz.Text = warInstalliert
                ? "Die neue Version ist in ein, zwei Minuten da. Ihre Einstellungen und das Gedächtnis bleiben erhalten."
                : "Der Installer holt alles Nötige selbst und richtet Jarvis in wenigen Minuten ein.";
            KnopfInstallieren.Content = warInstalliert ? "Aktualisieren" : "Installieren";
        }

        void PlatzZeigen(long frei, string laufwerk)
        {
            if (frei < 0)
            {
                PlatzText.Text = "Braucht etwa 3 GB Speicherplatz.";
                return;
            }
            double gb = frei / 1073741824.0;
            bool knapp = warInstalliert ? gb < 1 : gb < 3;
            PlatzSymbol.Visibility = knapp ? Visibility.Visible : Visibility.Collapsed;
            PlatzText.Foreground = (Brush)FindResource(knapp ? "Warnung" : "Schwach");
            PlatzText.Text = knapp
                ? string.Format(Deutsch, "Auf Laufwerk {0} sind nur noch {1:0.0} GB frei. Jarvis braucht etwa 3 GB.", laufwerk, gb)
                : string.Format(Deutsch, "Braucht etwa 3 GB. Auf Laufwerk {0} sind {1:N0} GB frei.", laufwerk, gb);
        }

        // ------------------------------------------------------------------ Installieren

        void Installieren_Click(object sender, RoutedEventArgs e)
        {
            if (lauf != null && lauf.Laeuft)
                return;
            if (!optionen.Vorschau && Umgebung.JarvisLaeuft())
                jarvisLief = true;
            fortschritt.Zuruecksetzen();
            zielFertig = false;
            abbruchBestaetigt = false;
            angezeigt = 0;
            FortschrittAnzeigen(0);
            RestText.Text = "Restzeit wird berechnet";
            FortschrittTitel.Text = warInstalliert ? "Jarvis wird aktualisiert" : "Jarvis wird installiert";
            FortschrittSatz.Text = warInstalliert
                ? "Das dauert meist nur ein, zwei Minuten."
                : "Das dauert beim ersten Mal ein paar Minuten. Sie können nebenbei weiterarbeiten.";
            DetailsSchliessen(false);
            KernStarten();
            SeiteZeigen(SeiteFortschritt, Seite.Fortschritt);
            Taskleiste.ProgressState = TaskbarItemProgressState.Normal;
            Taskleiste.ProgressValue = 0;

            laufBeginn = DateTime.Now;
            fortschritt.Starten(laufBeginn);
            fortschritt.Schritte[0].Detail = jarvisLief ? "Jarvis wird kurz beendet" : "Dateien werden kopiert";
            letzterTakt = laufBeginn;
            restGeaendert = laufBeginn;
            takt.Start();

            if (optionen.Vorschau)
            {
                if (optionen.BilderOrdner == null)
                    VorschauAbspielen();
                return;
            }
            if (!Kern.Eingebettet)
            {
                FehlerZeigen("Dieses Setup ist unvollständig: Der Installations-Kern fehlt.",
                    "Laden Sie JarvisSetup.exe bitte noch einmal herunter.", 1);
                return;
            }
            lauf = new Lauf();
            lauf.Gemeldet += meldung => fortschritt.Anwenden(meldung, DateTime.Now);
            lauf.Beendet += LaufBeendet;
            try
            {
                lauf.Starten(SchalterAutostart.IsChecked == true, SchalterDesktop.IsChecked == true);
            }
            catch (Exception ex)
            {
                Umgebung.FehlerMerken(ex);
                lauf = null;
                FehlerZeigen("Das Setup konnte seine Dateien nicht entpacken.",
                    "Prüfen Sie, ob genug Platz frei ist und ob ein Virenscanner JarvisSetup.exe blockiert. Dann „Nochmal versuchen“.", 1);
            }
        }

        void LaufBeendet(int code)
        {
            if (abbruchBestaetigt)
            {
                Rueckgabe = 5;
                Close();
                return;
            }
            if (code == 0 && !fortschritt.Fehlgeschlagen)
                Geschafft();
            else
                Fehlgeschlagen(code);
        }

        void Geschafft()
        {
            Rueckgabe = 0;
            fortschritt.AllesFertig();
            zielFertig = true;
            Taskleiste.ProgressValue = 1;
            bool neuGestartet = false;
            if (jarvisLief && !optionen.Vorschau)
            {
                try
                {
                    Umgebung.JarvisStarten(jarvisImHintergrund);
                    neuGestartet = true;
                }
                catch (Exception ex)
                {
                    Umgebung.FehlerMerken(ex);
                }
            }
            if (neuGestartet)
            {
                FertigSatz.Text = "Jarvis läuft wieder. Ihre Einstellungen und das Gedächtnis sind geblieben.";
                KnopfStarten.Content = "Jarvis zeigen";
            }
            else if (warInstalliert)
            {
                FertigSatz.Text = "Ihre Einstellungen und das Gedächtnis sind geblieben.";
                KnopfStarten.Content = "Jarvis starten";
            }
            else
            {
                FertigSatz.Text = "Beim ersten Start öffnet sich die Einrichtung: Mikrofon, Stimme und die Anmeldung für das Gehirn.";
                KnopfStarten.Content = "Jarvis starten";
            }
            FertigHinweise.ItemsSource = fortschritt.Hinweise.ToArray();
            FertigHinweise.Visibility = fortschritt.Hinweise.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            FertigZeile.Text = fortschritt.Hinweise.Count == 0
                ? "Alle sechs Schritte sind fertig."
                : "Fertig. Bitte lesen Sie einmal die Hinweise unten.";

            // Erst den vollen Bogen zeigen, dann die Fertig-Seite.
            var pause = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(bewegung ? 700 : 0) };
            pause.Tick += (s, e) =>
            {
                pause.Stop();
                takt.Stop();
                FortschrittAnzeigen(1);
                KernFertig();
                SeiteZeigen(SeiteFertig, Seite.Fertig);
                Taskleiste.ProgressState = TaskbarItemProgressState.None;
                if (!IsActive)
                    Native.Blinken(new WindowInteropHelper(this).Handle);
            };
            pause.Start();
        }

        void Fehlgeschlagen(int code)
        {
            Rueckgabe = code == 0 ? 1 : code;
            string text = fortschritt.FehlerText;
            string tipp = fortschritt.FehlerTipp;
            if (string.IsNullOrEmpty(text))
            {
                string[] ersatz = FehlerFuerCode(code);
                text = ersatz[0];
                if (string.IsNullOrEmpty(tipp))
                    tipp = ersatz[1];
            }
            FehlerZeigen(text, tipp, fortschritt.FehlerSchritt);
        }

        /// <summary>Meldung und Tipp, wenn der Kern selbst scheitert (Rückgabewerte von Inno Setup).</summary>
        static string[] FehlerFuerCode(int code)
        {
            switch (code)
            {
                case 2:
                case 5:
                    return new[] { "Die Installation wurde abgebrochen.", "Klicken Sie auf „Nochmal versuchen“, um weiterzumachen." };
                case 3:
                case 4:
                    return new[] { "Beim Kopieren der Dateien ist etwas schiefgegangen.", "Schließen Sie alle Jarvis-Fenster und klicken Sie auf „Nochmal versuchen“." };
                case 7:
                case 8:
                    return new[] { "Windows hat die Installation angehalten.", "Starten Sie den PC neu und versuchen Sie es dann noch einmal." };
                case 199:
                    return new[] { "Windows PowerShell ließ sich nicht starten.", "Starten Sie den PC neu und versuchen Sie es dann noch einmal." };
                case 0:
                case 1:
                    return new[] { "Das Setup konnte nicht starten.", "Starten Sie den PC neu und versuchen Sie es dann noch einmal." };
                default:
                    return new[] { "Bei der Installation ist etwas schiefgegangen (Code " + code + ").",
                        "Klicken Sie auf „Nochmal versuchen“. Hilft das nicht, öffnen Sie das Protokoll und schicken Sie es an Claude im Jarvis-Projekt." };
            }
        }

        void FehlerZeigen(string text, string tipp, int schritt)
        {
            takt.Stop();
            fortschritt.Fehlgeschlagen = true;
            if (schritt < 1 || schritt > 6)
                schritt = fortschritt.FehlerSchritt;
            Schritt s = fortschritt.SchrittNr(schritt);
            if (s == null)
            {
                foreach (Schritt kandidat in fortschritt.Schritte)
                    if (kandidat.Zustand == Zustand.Laeuft)
                        s = kandidat;
            }
            if (s != null && s.Zustand != Zustand.Fehler)
                fortschritt.FehlerAn(s.Nr, text);
            FehlerSchrittText.Text = s != null ? "Schritt " + s.Nr + " von 6: " + s.Titel : "Vor dem ersten Schritt";
            FehlerMeldung.Text = text;
            FehlerTipp.Text = string.IsNullOrEmpty(tipp)
                ? "Klicken Sie auf „Nochmal versuchen“. Was schon geladen ist, bleibt erhalten."
                : tipp;
            KernFehler();
            SeiteZeigen(SeiteFehler, Seite.Fehler);
            Taskleiste.ProgressState = TaskbarItemProgressState.Error;
            if (!IsActive)
                Native.Blinken(new WindowInteropHelper(this).Handle);
        }

        void Nochmal_Click(object sender, RoutedEventArgs e) => Installieren_Click(sender, e);

        void Protokoll_Click(object sender, RoutedEventArgs e)
        {
            string datei = ProtokollQuelle();
            if (datei == null)
            {
                FehlerTipp.Text = "Es gibt noch kein Protokoll. Klicken Sie auf „Nochmal versuchen“.";
                return;
            }
            try
            {
                Process.Start(new ProcessStartInfo("notepad.exe", "\"" + datei + "\"") { UseShellExecute = true })?.Dispose();
            }
            catch (Exception ex)
            {
                Umgebung.FehlerMerken(ex);
            }
        }

        /// <summary>Das Protokoll von installieren.ps1, sobald es zu diesem Lauf gehört, sonst das vom Kern.</summary>
        string ProtokollQuelle()
        {
            try
            {
                if (File.Exists(Umgebung.Protokoll) && File.GetLastWriteTime(Umgebung.Protokoll) >= laufBeginn.AddSeconds(-2))
                    return Umgebung.Protokoll;
                if (lauf?.InnoProtokoll != null && File.Exists(lauf.InnoProtokoll))
                    return lauf.InnoProtokoll;
                if (File.Exists(Umgebung.Protokoll))
                    return Umgebung.Protokoll;
            }
            catch (Exception)
            {
            }
            return null;
        }

        void Starten_Click(object sender, RoutedEventArgs e)
        {
            if (!optionen.Vorschau)
            {
                try
                {
                    Umgebung.JarvisStarten(false);
                }
                catch (Exception ex)
                {
                    Umgebung.FehlerMerken(ex);
                    FehlerZeigen("Jarvis ließ sich nicht starten.",
                        "Klicken Sie auf „Nochmal versuchen“, damit das Setup die fehlenden Teile nachlädt.", 0);
                    return;
                }
            }
            Close();
        }

        void Schliessen_Click(object sender, RoutedEventArgs e) => Close();

        // ------------------------------------------------------------------ Fortschritt anzeigen

        void Takt(object sender, EventArgs e)
        {
            DateTime jetzt = DateTime.Now;
            double dt = Math.Max(0.001, (jetzt - letzterTakt).TotalSeconds);
            letzterTakt = jetzt;
            double ziel = zielFertig ? 1 : vorschauZiel ?? fortschritt.Gesamt(jetzt);
            if (ziel > angezeigt)
                angezeigt += (ziel - angezeigt) * (bewegung ? 1 - Math.Exp(-dt / 0.35) : 1);
            if (ziel - angezeigt < 0.0005)
                angezeigt = Math.Max(angezeigt, ziel);
            FortschrittAnzeigen(angezeigt);

            if (vorschauRest == null && (jetzt - restGeaendert).TotalSeconds >= 2)
            {
                restGeaendert = jetzt;
                RestText.Text = zielFertig ? "gleich fertig" : fortschritt.Restzeit(jetzt, fortschritt.Gesamt(jetzt));
            }
            if (detailsOffen && vorschauZeilen == null && (jetzt - detailsGelesen).TotalMilliseconds >= 600)
            {
                detailsGelesen = jetzt;
                DetailsZeilen.ItemsSource = Umgebung.LetzteZeilen(ProtokollQuelle(), 9);
            }
        }

        void FortschrittAnzeigen(double anteil)
        {
            anteil = Math.Max(0, Math.Min(1, anteil));
            BogenSetzen(anteil);
            ProzentText.Text = ((int)Math.Floor(anteil * 100 + 0.0001)).ToString(Deutsch) + " %";
            BalkenFuellung.Width = Math.Max(0, BalkenSpur.ActualWidth * anteil);
            Taskleiste.ProgressValue = anteil;
        }

        /// <summary>Der dünne Bogen um die Kugel, oben beginnend im Uhrzeigersinn.</summary>
        void BogenSetzen(double anteil)
        {
            const double mitte = 120, radius = 82;
            if (anteil <= 0.001)
            {
                Bogen.Data = null;
                return;
            }
            if (anteil >= 0.999)
            {
                Bogen.Data = new EllipseGeometry(new Point(mitte, mitte), radius, radius);
                return;
            }
            double winkel = anteil * 2 * Math.PI;
            var start = new Point(mitte, mitte - radius);
            var ende = new Point(mitte + radius * Math.Sin(winkel), mitte - radius * Math.Cos(winkel));
            var figur = new PathFigure { StartPoint = start, IsClosed = false, IsFilled = false };
            figur.Segments.Add(new ArcSegment(ende, new Size(radius, radius), 0, anteil > 0.5, SweepDirection.Clockwise, true));
            var geometrie = new PathGeometry();
            geometrie.Figures.Add(figur);
            geometrie.Freeze();
            Bogen.Data = geometrie;
        }

        // ------------------------------------------------------------------ Details

        void Details_Click(object sender, RoutedEventArgs e)
        {
            if (detailsOffen)
                DetailsSchliessen(true);
            else
                DetailsOeffnen();
        }

        void DetailsOeffnen()
        {
            detailsOffen = true;
            detailsGelesen = DateTime.MinValue;
            if (vorschauZeilen != null)
                DetailsZeilen.ItemsSource = vorschauZeilen;
            else
                DetailsZeilen.ItemsSource = Umgebung.LetzteZeilen(ProtokollQuelle(), 9);
            DetailsKnopfText.Text = "Details ausblenden";
            DetailsFlaeche.Visibility = Visibility.Visible;
            Animieren(DetailsSkala, ScaleTransform.ScaleYProperty, 1, 180);
            Animieren(DetailsFlaeche, OpacityProperty, 1, 180);
            Animieren(SchrittListe, OpacityProperty, 0, 160);
            Animieren(DetailsPfeil, RotateTransform.AngleProperty, 180, 180);
        }

        void DetailsSchliessen(bool weich)
        {
            detailsOffen = false;
            DetailsKnopfText.Text = "Details";
            int dauer = weich ? 160 : 0;
            Animieren(DetailsSkala, ScaleTransform.ScaleYProperty, 0, dauer, () =>
            {
                if (!detailsOffen)
                    DetailsFlaeche.Visibility = Visibility.Collapsed;
            });
            Animieren(DetailsFlaeche, OpacityProperty, 0, dauer);
            Animieren(SchrittListe, OpacityProperty, 1, weich ? 180 : 0);
            Animieren(DetailsPfeil, RotateTransform.AngleProperty, 0, dauer);
        }

        // ------------------------------------------------------------------ Abbrechen

        bool InstallationLaeuft => seite == Seite.Fortschritt && ((lauf != null && lauf.Laeuft) || vorschauLaeuft);

        protected override void OnClosing(CancelEventArgs e)
        {
            if (InstallationLaeuft && !abbruchBestaetigt)
            {
                e.Cancel = true;
                RueckfrageZeigen();
                return;
            }
            if (seite == Seite.Start && optionen.BilderOrdner == null)
                Rueckgabe = 0;
            base.OnClosing(e);
        }

        void RueckfrageZeigen()
        {
            if (rueckfrageOffen)
                return;
            rueckfrageOffen = true;
            Seiten.IsEnabled = false;
            Titelleiste.IsEnabled = false;
            KnopfWeiter.IsDefault = true;
            Rueckfrage.Visibility = Visibility.Visible;
            Animieren(Rueckfrage, OpacityProperty, 1, 160);
            Animieren(RueckfrageSkala, ScaleTransform.ScaleXProperty, 1, 180);
            Animieren(RueckfrageSkala, ScaleTransform.ScaleYProperty, 1, 180);
            Dispatcher.BeginInvoke(new Action(() => KnopfWeiter.Focus()), DispatcherPriority.Input);
        }

        void RueckfrageSchliessen()
        {
            if (!rueckfrageOffen)
                return;
            rueckfrageOffen = false;
            KnopfWeiter.IsDefault = false;
            Seiten.IsEnabled = true;
            Titelleiste.IsEnabled = true;
            Animieren(RueckfrageSkala, ScaleTransform.ScaleXProperty, 0.97, 140);
            Animieren(RueckfrageSkala, ScaleTransform.ScaleYProperty, 0.97, 140);
            Animieren(Rueckfrage, OpacityProperty, 0, 140, () =>
            {
                if (!rueckfrageOffen)
                    Rueckfrage.Visibility = Visibility.Collapsed;
            });
        }

        void Weiter_Click(object sender, RoutedEventArgs e) => RueckfrageSchliessen();

        void AbbrechenJa_Click(object sender, RoutedEventArgs e)
        {
            abbruchBestaetigt = true;
            KnopfAbbrechenJa.IsEnabled = false;
            KnopfWeiter.IsEnabled = false;
            RueckfrageTitel.Text = "Wird abgebrochen …";
            if (lauf != null && lauf.Laeuft)
            {
                lauf.Abbrechen();
                // Falls sich der Kern nicht beenden lässt: das Fenster trotzdem schließen.
                var notfall = new DispatcherTimer { Interval = TimeSpan.FromSeconds(10) };
                notfall.Tick += (s, a) =>
                {
                    notfall.Stop();
                    Rueckgabe = 5;
                    Close();
                };
                notfall.Start();
                return;
            }
            Rueckgabe = 5;
            Close();
        }

        // ------------------------------------------------------------------ Tastatur, Fenster

        void Taste(object sender, KeyEventArgs e)
        {
            if (e.Key != Key.Escape)
                return;
            e.Handled = true;
            if (rueckfrageOffen)
            {
                if (!abbruchBestaetigt)
                    RueckfrageSchliessen();
                return;
            }
            if (InstallationLaeuft)
            {
                RueckfrageZeigen();
                return;
            }
            Close();
        }

        void Ziehen(object sender, MouseButtonEventArgs e)
        {
            if (e.ChangedButton != MouseButton.Left || e.ButtonState != MouseButtonState.Pressed)
                return;
            try
            {
                DragMove();
            }
            catch (InvalidOperationException)
            {
            }
        }

        void Minimieren_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

        void SchliessenTitel_Click(object sender, RoutedEventArgs e) => Close();

        // ------------------------------------------------------------------ Seiten und Bewegung

        void SeiteZeigen(FrameworkElement neu, Seite welche)
        {
            seite = welche;
            KnopfInstallieren.IsDefault = welche == Seite.Start;
            KnopfStarten.IsDefault = welche == Seite.Fertig;
            KnopfNochmal.IsDefault = welche == Seite.Fehler;
            FrameworkElement alt = aktuelleSeite;
            aktuelleSeite = neu;
            if (alt != null && alt != neu)
            {
                alt.IsHitTestVisible = false;
                Animieren(alt, OpacityProperty, 0, 120, () =>
                {
                    if (aktuelleSeite != alt)
                        alt.Visibility = Visibility.Collapsed;
                });
            }
            if (!(neu.RenderTransform is TranslateTransform verschiebung) || verschiebung.IsFrozen)
            {
                verschiebung = new TranslateTransform();
                neu.RenderTransform = verschiebung;
            }
            neu.Visibility = Visibility.Visible;
            neu.IsHitTestVisible = true;
            if (alt != neu)
            {
                neu.BeginAnimation(OpacityProperty, null);
                neu.Opacity = 0;
                Animieren(neu, OpacityProperty, 1, 180, null, 60);
                verschiebung.BeginAnimation(TranslateTransform.YProperty, null);
                verschiebung.Y = bewegung ? 8 : 0;
                Animieren(verschiebung, TranslateTransform.YProperty, 0, 200, null, 60);
            }
            Button vorne = welche switch
            {
                Seite.Start => KnopfInstallieren,
                Seite.Fertig => KnopfStarten,
                Seite.Fehler => KnopfNochmal,
                _ => null,
            };
            if (vorne != null)
                Dispatcher.BeginInvoke(new Action(() => vorne.Focus()), DispatcherPriority.Input);
        }

        /// <summary>Weiche Animation zu einem Wert (CubicEase). Ohne Animationen in Windows: sofort.</summary>
        void Animieren(IAnimatable ziel, DependencyProperty eigenschaft, double wert, int ms, Action danach = null, int verzoegerung = 0)
        {
            var animation = new DoubleAnimation(wert, TimeSpan.FromMilliseconds(bewegung ? ms : 0))
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
                BeginTime = TimeSpan.FromMilliseconds(bewegung ? verzoegerung : 0),
            };
            if (danach != null)
                animation.Completed += (s, e) => danach();
            ziel.BeginAnimation(eigenschaft, animation);
        }

        /// <summary>Sanftes Atmen der Kugel (größer, kleiner, der Schein mit).</summary>
        void KernAtmen(double sekunden)
        {
            if (!bewegung)
                return;
            var dauer = TimeSpan.FromSeconds(sekunden);
            var atmen = new DoubleAnimation(1.0, 1.035, dauer)
            {
                AutoReverse = true,
                RepeatBehavior = RepeatBehavior.Forever,
                EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
            };
            Timeline.SetDesiredFrameRate(atmen, 30);
            KugelSkala.BeginAnimation(ScaleTransform.ScaleXProperty, atmen);
            KugelSkala.BeginAnimation(ScaleTransform.ScaleYProperty, atmen);
            var schein = new DoubleAnimation(0.6, 1.0, dauer)
            {
                AutoReverse = true,
                RepeatBehavior = RepeatBehavior.Forever,
                EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
            };
            Timeline.SetDesiredFrameRate(schein, 30);
            KernGlanz.BeginAnimation(OpacityProperty, schein);
        }

        /// <summary>Installation beginnt: Bogen in der Akzentfarbe, die Kugel atmet etwas schneller.</summary>
        void KernStarten()
        {
            BogenFarbe.BeginAnimation(SolidColorBrush.ColorProperty, null);
            BogenFarbe.Color = FarbeAkzentHell;
            Animieren(Bogen, OpacityProperty, 1, 200);
            Animieren(BogenSpur, OpacityProperty, 1, 200);
            Animieren(Kugel, OpacityProperty, 1, 200);
            kugelTempo = 1.7;
            KernAtmen(2.6);
        }

        /// <summary>Fertig: der Bogen schließt sich grün und tritt dann leise zurück,
        /// die Kugel pulsiert einmal und atmet ruhig weiter.</summary>
        void KernFertig()
        {
            BogenSetzen(1);
            Animieren(Bogen, OpacityProperty, 0.35, 700, null, 1200);
            Animieren(BogenSpur, OpacityProperty, 0, 700, null, 1200);
            if (bewegung)
                BogenFarbe.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(FarbeErfolg, TimeSpan.FromMilliseconds(200)));
            else
                BogenFarbe.Color = FarbeErfolg;
            if (!bewegung)
                return;
            var puls = new DoubleAnimation(1.0, 1.08, TimeSpan.FromMilliseconds(200))
            {
                AutoReverse = true,
                EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
            };
            kugelTempo = 1.0;
            puls.Completed += (s, e) => KernAtmen(3.6);
            KugelSkala.BeginAnimation(ScaleTransform.ScaleXProperty, puls);
            KugelSkala.BeginAnimation(ScaleTransform.ScaleYProperty, puls);
        }

        /// <summary>Fehler: der Bogen bleibt stehen und wird rot, die Kugel wird ruhiger.</summary>
        void KernFehler()
        {
            if (bewegung)
                BogenFarbe.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(FarbeFehler, TimeSpan.FromMilliseconds(200)));
            else
                BogenFarbe.Color = FarbeFehler;
            Animieren(Bogen, OpacityProperty, 1, 200);
            Animieren(BogenSpur, OpacityProperty, 1, 200);
            Animieren(Kugel, OpacityProperty, 0.7, 200);
            kugelTempo = 0.5;
            KernAtmen(4.2);
        }

        // ------------------------------------------------------------------ Lebendige Kugel

        // Dieselbe Form wie im Jarvis-Fenster (gui/web/orb.js): kein starrer Kreis, sondern langsame,
        // weiche Wellen wie bei einem Tropfen. Dahinter kreisen zwei farbige Schleier.
        readonly Stopwatch kugelUhr = Stopwatch.StartNew();
        double kugelTempo = 1.0;
        double kugelZeit;
        double kugelLetzte = -1;

        void KugelStarten()
        {
            KugelFormen(0);
            if (!bewegung)
                return;  // Windows-Einstellung "Animationen anzeigen" ist aus: Form bleibt still
            CompositionTarget.Rendering += KugelBild;
            Closed += (s, e) => CompositionTarget.Rendering -= KugelBild;
            var drehen = new DoubleAnimation(0, 360, TimeSpan.FromSeconds(26)) { RepeatBehavior = RepeatBehavior.Forever };
            Timeline.SetDesiredFrameRate(drehen, 30);
            SchleierDrehung.BeginAnimation(RotateTransform.AngleProperty, drehen);
        }

        void KugelBild(object sender, EventArgs e)
        {
            double jetzt = kugelUhr.Elapsed.TotalSeconds;
            if (kugelLetzte >= 0 && jetzt - kugelLetzte < 1.0 / 40)
                return;  // 40 Bilder pro Sekunde reichen
            double dt = kugelLetzte < 0 ? 0 : Math.Min(0.1, jetzt - kugelLetzte);
            kugelLetzte = jetzt;
            kugelZeit += dt * kugelTempo;
            KugelFormen(kugelZeit);
        }

        /// <summary>Formt die Kugel für den Zeitpunkt t: 72 Punkte, weich verbunden.</summary>
        void KugelFormen(double t)
        {
            const int punkte = 72;
            const double mitte = 60, grund = 57;
            var p = new Point[punkte];
            for (int i = 0; i < punkte; i++)
            {
                double winkel = i * 2 * Math.PI / punkte;
                double r = grund * (1 + 0.045 * (0.6 * Math.Sin(2 * winkel + t * 0.8) + 0.4 * Math.Sin(3 * winkel - t * 0.6 + 1.9)));
                p[i] = new Point(mitte + Math.Cos(winkel) * r, mitte + Math.Sin(winkel) * r);
            }
            var form = new StreamGeometry();
            using (StreamGeometryContext stift = form.Open())
            {
                stift.BeginFigure(Mitte(p[punkte - 1], p[0]), true, true);
                for (int i = 0; i < punkte; i++)
                    stift.QuadraticBezierTo(p[i], Mitte(p[i], p[(i + 1) % punkte]), true, true);
            }
            form.Freeze();
            KugelForm.Data = form;
            KugelFormTiefe.Data = form;
            KugelFormLicht.Data = form;
            KugelFormRand.Data = form;
        }

        static Point Mitte(Point a, Point b) => new Point((a.X + b.X) / 2, (a.Y + b.Y) / 2);
    }
}
