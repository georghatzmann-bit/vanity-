// The plain native installer UI (no WebView2): same colours, simple controls. Used when the
// WebView2 runtime is missing and could not be installed, or the web window failed to start.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Threading;
using System.Windows.Forms;
using Velox.Native;

namespace Velox.Setup
{
    internal sealed class FallbackForm : Form
    {
        private readonly Program.Args _args;
        private readonly Log _log = Program.Log;
        private readonly float _k;
        private readonly string _mode;          // install | update | uninstall
        private string _dir;
        private readonly Label _title, _sub, _dirLbl, _status, _info;
        private readonly CheckBox _desktop, _startMenu, _launch, _keep;
        private readonly FlatButton _primary, _secondary, _change;
        private double _pct = -1;
        private bool _busy, _done;

        public int ExitCode { get; private set; }

        public FallbackForm(Program.Args args)
        {
            _args = args;
            ExitCode = 2;
            _k = Win.DpiForPoint(Cursor.Position.X, Cursor.Position.Y) / 96f;
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Brand.Bg;
            ForeColor = Brand.Text;
            Font = Brand.UiFont(14 * _k, FontStyle.Regular);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
            DoubleBuffered = true;
            ClientSize = new Size(S(560), S(400));

            InstalledInfo inf = null;
            try { inf = Installer.Detect(); } catch (Exception) { }
            _mode = args.Uninstall ? "uninstall" : (inf != null ? "update" : "install");
            _dir = args.Uninstall ? (Program.ResolveUninstallDir(args) ?? "") : (inf != null ? inf.Dir : Installer.DefaultDir());
            string ver = Util.Version();
            Text = _mode == "uninstall" ? "VELOX entfernen" : "VELOX Setup";

            int x = S(96), w = ClientSize.Width - x - S(32);
            _title = AddLabel(_mode == "uninstall" ? "VELOX entfernen" : _mode == "update" ? "VELOX aktualisieren" : "VELOX installieren", 20, FontStyle.Bold, Brand.Text, x, S(30), w, S(30));
            _sub = AddLabel(_mode == "uninstall" ? "VELOX wird von diesem PC entfernt." : _mode == "update" ? "Version " + (inf != null && inf.Version.Length > 0 ? inf.Version : "?") + " → " + ver : "Version " + ver + " · Windows schneller, ruhiger und privater", 14, FontStyle.Regular, Brand.Muted, x, S(62), w, S(22));

            int y = S(116);
            if (_mode != "uninstall")
            {
                AddLabel("Installieren nach", 12, FontStyle.Regular, Brand.Faint, S(32), y, S(300), S(18));
                _dirLbl = AddLabel(_dir, 14, FontStyle.Regular, Brand.Text, S(32), y + S(20), ClientSize.Width - S(32) - S(140), S(24));
                _dirLbl.AutoEllipsis = true;
                _change = new FlatButton { Text = "Ändern …", UiScale = _k, Font = Brand.UiFont(14 * _k, FontStyle.Bold) };
                _change.SetBounds(ClientSize.Width - S(32) - S(110), y + S(12), S(110), S(34));
                _change.Click += (s, e) => Browse();
                Controls.Add(_change);
                y += S(66);
                _desktop = AddCheck("Verknüpfung auf dem Desktop", y); y += S(30);
                _startMenu = AddCheck("Einträge im Startmenü (VELOX und VELOX Testmodus)", y); y += S(30);
                _launch = AddCheck("VELOX nach der Installation starten", y); y += S(30);
            }
            else
            {
                _keep = AddCheck("Einstellungen und Sicherungen behalten", y); y += S(36);
                _info = AddLabel("Wichtig: Tweaks, die VELOX angewendet hat, bleiben aktiv. Willst du sie rückgängig machen, " +
                    "öffne vorher VELOX und spiele sie unter „Sicherungen“ zurück.", 12, FontStyle.Regular, Brand.Muted, S(32), y, ClientSize.Width - S(64), S(54));
                y += S(60);
            }

            _status = AddLabel("", 12, FontStyle.Regular, Brand.Muted, S(32), ClientSize.Height - S(112), ClientSize.Width - S(64), S(20));
            _status.AutoEllipsis = true;

            _primary = new FlatButton { Primary = _mode != "uninstall", Danger = _mode == "uninstall", UiScale = _k, Font = Brand.UiFont(14 * _k, FontStyle.Bold),
                Text = _mode == "uninstall" ? "Entfernen" : _mode == "update" ? "Aktualisieren" : "Installieren" };
            _secondary = new FlatButton { Text = "Abbrechen", UiScale = _k, Font = Brand.UiFont(14 * _k, FontStyle.Bold) };
            _primary.SetBounds(ClientSize.Width - S(32) - S(150), ClientSize.Height - S(32) - S(38), S(150), S(38));
            _secondary.SetBounds(_primary.Left - S(8) - S(120), _primary.Top, S(120), S(38));
            _primary.Click += (s, e) => OnPrimary();
            _secondary.Click += (s, e) => Close();
            Controls.Add(_primary);
            Controls.Add(_secondary);
            AcceptButtonLike();
        }

        private int S(int v) { return (int)Math.Round(v * _k); }

        private void AcceptButtonLike() { Shown += (s, e) => { try { _primary.Focus(); } catch (Exception) { } }; }

        private Label AddLabel(string text, float px, FontStyle style, Color color, int x, int y, int w, int h)
        {
            var l = new Label { Text = text, AutoSize = false, ForeColor = color, BackColor = Color.Transparent, Font = Brand.UiFont(px * _k, style) };
            l.SetBounds(x, y, w, h);
            Controls.Add(l);
            return l;
        }

        private CheckBox AddCheck(string text, int y)
        {
            var c = new CheckBox { Text = text, Checked = true, AutoSize = false, ForeColor = Brand.Text, BackColor = Brand.Bg, FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand };
            c.FlatAppearance.BorderColor = Brand.Line2;
            c.FlatAppearance.CheckedBackColor = Brand.S2;
            c.FlatAppearance.MouseOverBackColor = Brand.S1;
            c.SetBounds(S(32), y, ClientSize.Width - S(64), S(26));
            Controls.Add(c);
            return c;
        }

        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Win.ApplyDarkFrame(Handle, true, Brand.CaptionBgr); }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Brand.DrawAppIcon(g, new RectangleF(S(32), S(28), S(52), S(52)));
            if (_pct >= 0)
                Brand.DrawLoader(g, new RectangleF(S(32), ClientSize.Height - S(84), ClientSize.Width - S(64), S(2)), _k, 0, _pct);
        }

        private void Browse()
        {
            using (var dlg = new FolderBrowserDialog { Description = "Wähle den Ordner für VELOX. Es wird ein Unterordner „VELOX“ angelegt.", ShowNewFolderButton = true })
            {
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                string error;
                string d = Installer.NormalizeDir(dlg.SelectedPath, out error);
                if (d == null) { DarkDialog.Show(this, "Dieser Ordner geht nicht", error, null, new[] { "OK" }, 0, false); return; }
                _dir = d;
                _dirLbl.Text = d;
            }
        }

        private void SetBusy(bool busy)
        {
            _busy = busy;
            foreach (Control c in Controls) if (c is CheckBox || c == _change || c == _secondary) c.Enabled = !busy;
            _primary.Enabled = !busy;
        }

        private void OnPrimary()
        {
            if (_busy) return;
            if (_done)
            {
                if (_mode != "uninstall" && _launch != null && !_launch.Checked)
                {
                    string err; string d = Installer.NormalizeDir(_dir, out err);
                    if (d != null) Installer.Launch(d);
                }
                Close();
                return;
            }
            string checkDir = _mode == "uninstall" ? _dir : (Installer.Detect() != null ? Installer.Detect().Dir : _dir);
            bool running = false;
            try { running = !string.IsNullOrEmpty(checkDir) && Installer.IsVeloxRunning(checkDir); } catch (Exception) { }
            if (running)
            {
                int r = DarkDialog.Show(this, "VELOX läuft gerade", "Damit es weitergehen kann, wird VELOX jetzt geschlossen. Eine laufende Änderung wird vorher abgeschlossen.", null, new[] { "Abbrechen", "VELOX schließen" }, 1, false);
                if (r != 1) return;
            }
            SetBusy(true);
            _pct = 0;
            Invalidate();
            ProgressFn report = (p, step, file) =>
            {
                try { BeginInvoke((Action)(() => { _pct = p; _status.Text = string.IsNullOrEmpty(file) ? step : step + "  " + file; Invalidate(); })); } catch (Exception) { }
            };
            bool uninstall = _mode == "uninstall";
            bool keep = _keep == null || _keep.Checked;
            var o = uninstall ? null : new InstallOptions { Dir = _dir, Desktop = _desktop.Checked, StartMenu = _startMenu.Checked, Launch = _launch.Checked, CloseRunning = true };
            var t = new Thread(() =>
            {
                Exception err = null;
                try
                {
                    if (uninstall) Installer.Uninstall(_dir, keep, true, report);
                    else Installer.Install(o, report);
                }
                catch (Exception ex) { err = ex; }
                try { BeginInvoke((Action)(() => Finish(err, o))); } catch (Exception) { }
            }) { IsBackground = true };
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
        }

        private void Finish(Exception err, InstallOptions o)
        {
            SetBusy(false);
            if (err != null)
            {
                _log.Error("Fehlgeschlagen: " + err);
                var ie = err as InstallException;
                ExitCode = 1;
                _pct = -1;
                _status.Text = "";
                Invalidate();
                DarkDialog.Show(this, "Das hat leider nicht geklappt", ie != null ? ie.Message : "Etwas ist unerwartet schiefgelaufen.",
                    (ie != null ? ie.Hint : "Versuche es noch einmal.") + "\n\nLog: " + _log.Path, new[] { "OK" }, 0, false);
                return;
            }
            ExitCode = 0;
            _done = true;
            _status.Text = _mode == "uninstall" ? "VELOX wurde entfernt." : "Fertig! VELOX ist installiert.";
            _status.ForeColor = Brand.Ok;
            _secondary.Visible = false;
            if (_mode == "uninstall") { _primary.Text = "Schließen"; _primary.Danger = false; _primary.Primary = true; _primary.Invalidate(); return; }
            if (o != null && o.Launch)
            {
                string e2; string d = Installer.NormalizeDir(o.Dir, out e2);
                if (d != null) Installer.Launch(d);
                _primary.Text = "Schließen";
            }
            else _primary.Text = "VELOX starten";
            _primary.Invalidate();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (_busy && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; return; }
            base.OnFormClosing(e);
        }
    }
}
