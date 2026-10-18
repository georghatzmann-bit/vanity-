// HELIX-Setup – das Fenster: Intro-Clip, Willkommen, Fortschritt, Fertig, Fehler, Deinstallation.
// Bewegung kommt nur aus den Higgsfield-Clips; im Code gibt es nur kurze Überblendungen zwischen den Seiten.

using System;
using System.Collections.ObjectModel;
using System.IO;
using System.Media;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace HelixSetup
{
    public sealed class StepItem
    {
        public string Text { get; set; }
        public Brush Dot { get; set; }
        public Brush Fg { get; set; }
        public double Glow { get; set; }
    }

    public partial class MainWindow : Window
    {
        static readonly Brush DotIdle = new SolidColorBrush(Color.FromArgb(0x40, 0xFF, 0xFF, 0xFF));
        static readonly Brush DotActive = new SolidColorBrush(Color.FromRgb(0x4F, 0xD8, 0xFF));
        static readonly Brush DotDone = new SolidColorBrush(Color.FromRgb(0x3D, 0xDC, 0x97));
        static readonly Brush TextMain = new SolidColorBrush(Color.FromRgb(0xE8, 0xEA, 0xF0));
        static readonly Brush TextMuted = new SolidColorBrush(Color.FromRgb(0x6F, 0x76, 0x89));

        readonly ObservableCollection<StepItem> steps = new ObservableCollection<StepItem>();
        string[] stepTexts;
        CancellationTokenSource cts;
        SoundPlayer loopPlayer;
        bool muted;
        bool busy;
        bool introDone;
        string installedDir;
        Border current;

        public MainWindow()
        {
            InitializeComponent();
            StepList.ItemsSource = steps;
            DirBox.Text = Engine.InstalledDir() ?? Engine.DefaultInstallDir;
            WhatText.Text = "• Neueste HELIX-Version von GitHub laden und prüfen\n• In deinen Benutzerordner installieren\n• Verknüpfungen und Deinstallation einrichten";
            Loaded += OnLoaded;
            Closing += (s, e) =>
            {
                if (busy && MessageBox.Show(this, "Die Installation läuft noch. Wirklich abbrechen?", "HELIX Setup", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes)
                {
                    e.Cancel = true;
                    return;
                }
                cts?.Cancel();
                StopLoop();
            };
            KeyDown += (s, e) => { if (e.Key == Key.Escape && IntroLayer.Visibility == Visibility.Visible) EndIntro(); };
        }

        void OnLoaded(object sender, RoutedEventArgs e)
        {
            StartBackground();
            if (App.Args.Uninstall)
            {
                TitleSub.Text = "Deinstallation";
                var dir = App.Args.From ?? Engine.InstalledDir();
                UninstallText.Text = string.IsNullOrEmpty(dir)
                    ? "HELIX wurde nicht im üblichen Ordner gefunden. Verknüpfungen und Eintrag werden trotzdem entfernt."
                    : $"HELIX wird aus „{dir}“ entfernt – samt Verknüpfungen und Eintrag in „Apps & Features“.";
                Show(UninstallPanel);
                return;
            }
            var v = Engine.InstalledVersion();
            if (!string.IsNullOrEmpty(v))
            {
                InstallBtn.Content = "Aktualisieren";
                WhatText.Text = $"• HELIX {v} ist schon installiert – das Setup holt die neueste Version\n• Deine Profile und Sicherungen bleiben erhalten\n• Verknüpfungen werden erneuert";
            }
            PlayIntro();
        }

        // ------------------------------------------------------------ Clips & Klang

        void StartBackground()
        {
            var bg = Engine.Media("bg-loop.mp4");
            if (bg == null) { ShowBgFallback(); return; }
            BgVideo.MediaEnded += (s, e) => { BgVideo.Position = TimeSpan.Zero; BgVideo.Play(); };
            BgVideo.MediaFailed += (s, e) => { Engine.Log("Hintergrund-Video: " + e.ErrorException?.Message); ShowBgFallback(); };
            BgVideo.Source = new Uri(bg);
            BgVideo.Play();
        }

        void ShowBgFallback()
        {
            BgVideo.Visibility = Visibility.Collapsed;
            BgFallback.Visibility = Visibility.Visible;
            BgFallback.Source = new System.Windows.Media.Imaging.BitmapImage(new Uri("pack://application:,,,/assets/emblem.png"));
            BgFallback.Stretch = Stretch.None;
            BgFallback.Opacity = 0.08;
        }

        void PlayIntro()
        {
            var clip = Engine.Media("intro.mp4");
            IntroLayer.Visibility = Visibility.Visible;
            if (clip == null) { IntroFallback(); return; }
            IntroVideo.MediaEnded += (s, e) => EndIntro();
            IntroVideo.MediaFailed += (s, e) => { Engine.Log("Intro-Video: " + e.ErrorException?.Message); IntroFallback(); };
            IntroVideo.Source = new Uri(clip);
            IntroVideo.Volume = 0.85;
            IntroVideo.IsMuted = muted;
            IntroVideo.Play();
            // Sicherheitsnetz, falls das Video hängen bleibt
            var t = new DispatcherTimer { Interval = TimeSpan.FromSeconds(9) };
            t.Tick += (s, e) => { t.Stop(); EndIntro(); };
            t.Start();
        }

        /// <summary>Ohne Video-Wiedergabe (z. B. Windows N): Emblem einblenden und den Intro-Klang spielen.</summary>
        void IntroFallback()
        {
            IntroVideo.Visibility = Visibility.Collapsed;
            IntroStill.Visibility = Visibility.Visible;
            IntroStill.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(900)));
            PlayOnce("install-intro.wav");
            var t = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3.2) };
            t.Tick += (s, e) => { t.Stop(); EndIntro(); };
            t.Start();
        }

        void Intro_Click(object sender, RoutedEventArgs e) => EndIntro();
        void Intro_Click(object sender, MouseButtonEventArgs e) => EndIntro();

        void EndIntro()
        {
            if (introDone) return;
            introDone = true;
            var fade = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(450));
            fade.Completed += (s, e) =>
            {
                IntroLayer.Visibility = Visibility.Collapsed;
                IntroVideo.Stop();
                IntroVideo.Source = null;
            };
            IntroLayer.BeginAnimation(OpacityProperty, fade);
            Show(WelcomePanel);
            InstallBtn.Focus();
        }

        void PlayOnce(string name)
        {
            if (muted) return;
            try
            {
                var f = Engine.Media(name);
                if (f != null) new SoundPlayer(f).Play();
            }
            catch (Exception e) { Engine.Log("Ton: " + e.Message); }
        }

        void StartLoop()
        {
            if (muted) return;
            try
            {
                var f = Engine.Media("install-loop.wav");
                if (f == null) return;
                loopPlayer = new SoundPlayer(f);
                loopPlayer.PlayLooping();
            }
            catch (Exception e) { Engine.Log("Ton: " + e.Message); }
        }

        void StopLoop()
        {
            try { loopPlayer?.Stop(); } catch { }
            loopPlayer = null;
        }

        void Mute_Click(object sender, RoutedEventArgs e)
        {
            muted = !muted;
            MuteBtn.Content = muted ? "" : "";
            IntroVideo.IsMuted = muted;
            if (muted) StopLoop();
            else if (busy) StartLoop();
        }

        // ------------------------------------------------------------ Seitenwechsel

        void Show(Border panel)
        {
            foreach (var p in new[] { WelcomePanel, ProgressPanel, DonePanel, ErrorPanel, UninstallPanel })
            {
                if (p == panel) continue;
                if (p.Visibility == Visibility.Visible)
                {
                    var fadeOut = new DoubleAnimation(p.Opacity, 0, TimeSpan.FromMilliseconds(160));
                    var target = p;
                    fadeOut.Completed += (s, e) => { if (current != target) target.Visibility = Visibility.Collapsed; };
                    p.BeginAnimation(OpacityProperty, fadeOut);
                }
            }
            current = panel;
            panel.Visibility = Visibility.Visible;
            panel.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(220)));
        }

        void SetSteps(params string[] texts)
        {
            stepTexts = texts;
            steps.Clear();
            foreach (var t in texts) steps.Add(new StepItem { Text = t, Dot = DotIdle, Fg = TextMuted, Glow = 0 });
        }

        void MarkStep(int active)
        {
            for (int i = 0; i < steps.Count; i++)
            {
                var done = i < active;
                var now = i == active;
                steps[i] = new StepItem
                {
                    Text = stepTexts[i],
                    Dot = done ? DotDone : now ? DotActive : DotIdle,
                    Fg = done || now ? TextMain : TextMuted,
                    Glow = now ? 12 : 0,
                };
            }
        }

        void OnProgress(StepProgress p)
        {
            MarkStep(p.Step);
            if (!string.IsNullOrEmpty(p.Detail)) ProgressDetail.Text = p.Detail;
            if (p.Percent >= 0)
            {
                Bar.IsIndeterminate = false;
                // Gesamtfortschritt: Download zählt am meisten
                double[] start = { 0, 2, 82, 88, 96, 100 };
                double[] end = { 2, 82, 88, 96, 100, 100 };
                var s = Math.Max(0, Math.Min(5, p.Step));
                Bar.Value = start[s] + (end[s] - start[s]) * p.Percent / 100.0;
            }
        }

        // ------------------------------------------------------------ Installieren

        async void Install_Click(object sender, RoutedEventArgs e)
        {
            PlayOnce("click.wav");
            await RunInstall();
        }

        async Task RunInstall()
        {
            busy = true;
            cts = new CancellationTokenSource();
            CancelBtn.IsEnabled = true;
            SetSteps("Neueste Version suchen", "Herunterladen", "Prüfen", "Installieren", "Verknüpfungen & Deinstallation", "Fertig");
            ProgressTitle.Text = "HELIX wird installiert";
            ProgressSub.Text = "Bitte kurz warten – du kannst das Fenster offen lassen.";
            Bar.Value = 0;
            Show(ProgressPanel);
            StartLoop();
            var progress = new Progress<StepProgress>(OnProgress);
            var opts = new InstallOptions
            {
                InstallDir = DirBox.Text,
                DesktopShortcut = OptDesktop.IsChecked == true,
                StartMenuShortcut = OptStart.IsChecked == true,
            };
            try
            {
                OnProgress(new StepProgress { Step = 0, Detail = "Frage GitHub nach der neuesten Version …", Percent = 0 });
                var rel = await Engine.FindRelease(App.Args.Source, cts.Token);
                OnProgress(new StepProgress { Step = 1, Detail = rel.Source == "local" ? "Lokale Datei gefunden" : $"Version {rel.Version} gefunden", Percent = 0 });
                var work = Path.Combine(Path.GetTempPath(), "HELIX-Download");
                var zip = await Engine.Fetch(rel, work, progress, cts.Token);
                CancelBtn.IsEnabled = false; // ab hier nicht mehr abbrechen, damit nichts halb installiert bleibt
                installedDir = Engine.ResolveInstallDir(opts.InstallDir);
                await Task.Run(() => Engine.Install(zip, rel, opts, progress));
                if (rel.Source != "local") { try { File.Delete(zip); } catch { } }
                busy = false;
                StopLoop();
                PlayOnce("install-done.wav");
                DoneTitle.Text = "HELIX ist bereit";
                DoneText.Text = $"Version {rel.Version} ist installiert in „{installedDir}“."
                    + (opts.DesktopShortcut ? " Du findest HELIX auf dem Desktop" + (opts.StartMenuShortcut ? " und im Startmenü." : ".") : opts.StartMenuShortcut ? " Du findest HELIX im Startmenü." : "");
                StartBtn.Visibility = Visibility.Visible;
                Show(DonePanel);
                if (OptRun.IsChecked == true) StartBtn.Focus();
            }
            catch (OperationCanceledException)
            {
                busy = false;
                StopLoop();
                Show(WelcomePanel);
            }
            catch (Exception ex)
            {
                busy = false;
                StopLoop();
                Engine.Log("FEHLER: " + ex);
                ShowError(ex);
            }
        }

        void ShowError(Exception ex)
        {
            if (ex is SetupException se)
            {
                ErrorText.Text = se.Message;
                ErrorAdvice.Text = se.Advice;
            }
            else if (ex is UnauthorizedAccessException)
            {
                ErrorText.Text = "Windows hat den Zugriff auf den Ordner verweigert.";
                ErrorAdvice.Text = "Wähle einen Ordner in deinem Benutzerordner (der Standard-Ordner passt immer).";
            }
            else
            {
                ErrorText.Text = "Unerwarteter Fehler: " + ex.Message;
                ErrorAdvice.Text = "Versuche es noch einmal. Hilft das nicht, lade HELIX von der Release-Seite herunter.";
            }
            PlayOnce("click.wav");
            Show(ErrorPanel);
        }

        async void Retry_Click(object sender, RoutedEventArgs e)
        {
            if (App.Args.Uninstall) { Show(UninstallPanel); return; }
            await RunInstall();
        }

        void Cancel_Click(object sender, RoutedEventArgs e) => cts?.Cancel();

        void Start_Click(object sender, RoutedEventArgs e)
        {
            try { Engine.StartHelix(installedDir); } catch (Exception ex) { Engine.Log("Start: " + ex.Message); }
            Close();
        }

        void ChangeDir_Click(object sender, RoutedEventArgs e)
        {
            using (var d = new System.Windows.Forms.FolderBrowserDialog
            {
                Description = "Wo soll HELIX installiert werden? (Es wird ein Unterordner „HELIX“ angelegt, falls der Ordner nicht leer ist.)",
                SelectedPath = DirBox.Text,
                ShowNewFolderButton = true,
            })
            {
                if (d.ShowDialog() == System.Windows.Forms.DialogResult.OK)
                    DirBox.Text = Engine.ResolveInstallDir(d.SelectedPath);
            }
        }

        // ------------------------------------------------------------ Deinstallieren

        async void DoUninstall_Click(object sender, RoutedEventArgs e)
        {
            busy = true;
            SetSteps("HELIX schließen", "Verknüpfungen entfernen", "Dateien löschen", "Aufräumen", "Fertig");
            ProgressTitle.Text = "HELIX wird entfernt";
            ProgressSub.Text = "Das dauert nur einen Moment.";
            CancelBtn.Visibility = Visibility.Collapsed;
            Bar.Value = 0;
            Bar.IsIndeterminate = true;
            Show(ProgressPanel);
            var removeData = KeepData.IsChecked != true;
            var dir = App.Args.From ?? Engine.InstalledDir();
            var progress = new Progress<StepProgress>(OnProgress);
            try
            {
                await Task.Run(() => Engine.Uninstall(dir, removeData, progress));
                busy = false;
                Bar.IsIndeterminate = false;
                Bar.Value = 100;
                PlayOnce("install-done.wav");
                DoneTitle.Text = "HELIX wurde entfernt";
                DoneText.Text = removeData
                    ? "Programm, Verknüpfungen, Profile und Sicherungen sind gelöscht. Deine Fortnite-Einstellungen sind unverändert."
                    : "Programm und Verknüpfungen sind gelöscht. Deine Profile und Sicherungen liegen weiter in %APPDATA%\\HELIX.";
                StartBtn.Visibility = Visibility.Collapsed;
                Show(DonePanel);
            }
            catch (Exception ex)
            {
                busy = false;
                Engine.Log("FEHLER Deinstallation: " + ex);
                ShowError(ex);
            }
        }

        // ------------------------------------------------------------ Fenster

        void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            if (e.ButtonState == MouseButtonState.Pressed) DragMove();
        }

        void Min_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
        void Close_Click(object sender, RoutedEventArgs e) => Close();
        void Manual_Click(object sender, RoutedEventArgs e) => Engine.OpenUrl(Engine.ReleasesPage);

        protected override void OnClosed(EventArgs e)
        {
            base.OnClosed(e);
            if (App.Args.TempCopy) Engine.ScheduleSelfDelete();
        }
    }
}
