// Fallback when the WebView2 runtime is missing or broken: the backend opens its own Edge app window
// (the same path Start.bat uses) and VELOX.exe stays alive in the background as its parent, so the
// job object still ties the backend's lifetime to this process.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Windows.Forms;
using Velox.Native;

namespace Velox.Host
{
    internal static class FallbackHost
    {
        public static int Run(bool test)
        {
            using (var f = new FallbackForm(test)) Application.Run(f);
            return 0;
        }
    }

    /// <summary>Small dark start window; hides itself once the Edge app window is open.</summary>
    internal sealed class FallbackForm : Form
    {
        private readonly Log _log = Program.Log;
        private readonly Timer _timeout = new Timer { Interval = 45000 };
        private readonly Timer _anim = new Timer { Interval = 33 };
        private Backend _backend;
        private bool _test;
        private bool _ready;
        private bool _quitting;
        private float _phase;
        private string _status = "VELOX wird gestartet …";
        private readonly float _k;

        public FallbackForm(bool test)
        {
            _test = test;
            _k = Win.DpiForPoint(Cursor.Position.X, Cursor.Position.Y) / 96f;
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Brand.Bg;
            Text = test ? "VELOX – Testmodus" : "VELOX";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
            ClientSize = new Size(S(420), S(260));
            DoubleBuffered = true;
            _timeout.Tick += (s, e) => { _timeout.Stop(); OnTimeout(); };
            _anim.Tick += (s, e) => { _phase += 0.033f; Invalidate(); };
        }

        private int S(int v) { return (int)Math.Round(v * _k); }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Win.ApplyDarkFrame(Handle, true, Brand.CaptionBgr);
            try { if (Program.ActivateMessage != 0) NativeMethods.ChangeWindowMessageFilterEx(Handle, Program.ActivateMessage, NativeMethods.MSGFLT_ALLOW, IntPtr.Zero); } catch (Exception) { }
        }

        protected override void WndProc(ref Message m)
        {
            if (Program.ActivateMessage != 0 && m.Msg == (int)Program.ActivateMessage)
            {
                if ((m.WParam.ToInt64() == 2) == _test)
                {
                    if (_ready) ReopenAppWindow();
                    else if (Visible) Win.BringToFront(Handle);
                }
                return;
            }
            base.WndProc(ref m);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            _anim.Start();
            Start();
        }

        private void Start()
        {
            if (_backend != null) _backend.Dispose();
            _ready = false;
            _status = _test ? "Testmodus wird gestartet …" : "VELOX wird gestartet …";
            var b = new Backend(_log);
            b.Ready += url => UI(() => { if (b != _backend) return; _ready = true; _timeout.Stop(); _anim.Stop(); Hide(); });
            b.AlreadyRunning += url => UI(() => { if (b != _backend) return; _quitting = true; Close(); });
            b.Exited += code => UI(() => OnExited(b, code));
            _backend = b;
            string err;
            if (!b.Start(Program.AppDir, _test, false, out err)) { Fail(err, b.Tail(30)); return; }
            _timeout.Start();
        }

        /// <summary>A second start while the Edge window is open: Velox.ps1 opens the existing window again and exits.</summary>
        private void ReopenAppWindow()
        {
            try
            {
                var once = new Backend(_log);
                string err;
                if (!once.Start(Program.AppDir, _test, false, out err)) once.Dispose();
                // it exits on its own after opening the window; the job object ends it with us otherwise
            }
            catch (Exception ex) { _log.Warn("Fenster erneut öffnen: " + ex.Message); }
        }

        private void UI(Action a) { try { if (!IsDisposed && IsHandleCreated) BeginInvoke(a); } catch (Exception) { } }

        private void OnExited(Backend b, int code)
        {
            if (b != _backend || _quitting) return;
            _timeout.Stop();
            if (_ready) { _quitting = true; Close(); return; }   // the app window was closed: VELOX ends
            string errs = b.Errors();
            Fail(string.IsNullOrEmpty(errs) ? "Der VELOX-Motor (PowerShell) hat sich sofort wieder beendet (Code " + code + ")." : errs, b.Tail(30));
        }

        private void OnTimeout()
        {
            if (_ready || _backend == null) return;
            string tail = _backend.Tail(30);
            _backend.Dispose();
            _backend = null;
            Fail("Der VELOX-Motor hat sich nach 45 Sekunden noch nicht gemeldet.", tail);
        }

        private void Fail(string message, string tail)
        {
            _anim.Stop();
            var buttons = _test ? new[] { "Log öffnen", "Schließen", "Erneut versuchen" } : new[] { "Log öffnen", "Testmodus", "Erneut versuchen" };
            while (true)
            {
                int r = DarkDialog.Show(Visible ? this : null, "VELOX konnte nicht starten", message, tail, buttons, 2, false);
                if (r == 0) { Util.OpenUnelevated(_log.Path, _log); continue; }
                if (r == 2) { _anim.Start(); Start(); return; }
                if (r == 1 && !_test)
                {
                    if (_backend != null) { _backend.Dispose(); _backend = null; }
                    Program.ReleaseMutex();
                    if (!Program.AcquireMutex(true)) { Program.ActivateOther(true); break; }
                    _test = true;
                    Text = "VELOX – Testmodus";
                    _anim.Start();
                    Start();
                    return;
                }
                break;
            }
            _quitting = true;
            Close();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var glow = new GraphicsPath())
            {
                var c = new RectangleF(ClientSize.Width / 2f - S(90), S(10), S(180), S(180));
                glow.AddEllipse(c);
                using (var pgb = new PathGradientBrush(glow) { CenterColor = Color.FromArgb(46, Brand.Accent), SurroundColors = new[] { Color.FromArgb(0, Brand.Accent) } })
                    g.FillPath(pgb, glow);
            }
            float lift = (float)Math.Sin(_phase * 4.5) * 2.2f;
            Brand.DrawLogo(g, new RectangleF(ClientSize.Width / 2f - S(36), S(50), S(72), S(72)), lift);
            using (var f = Brand.UiFont(20 * _k, FontStyle.Bold))
                TextRenderer.DrawText(g, "V E L O X", f, new Rectangle(0, S(138), ClientSize.Width, S(30)), Brand.Text, TextFormatFlags.HorizontalCenter);
            using (var f = Brand.UiFont(14 * _k, FontStyle.Regular))
                TextRenderer.DrawText(g, _status, f, new Rectangle(0, S(178), ClientSize.Width, S(24)), Brand.Muted, TextFormatFlags.HorizontalCenter);
            // indeterminate bar
            var track = new RectangleF(S(80), S(214), ClientSize.Width - S(160), S(6));
            using (var p = Brand.Rounded(track, S(3))) using (var br = new SolidBrush(Color.FromArgb(18, 255, 255, 255))) g.FillPath(br, p);
            float w = track.Width * 0.38f;
            float x = track.X + (float)((_phase * 0.55) % 1.3 - 0.3) * track.Width;
            var seg = RectangleF.Intersect(track, new RectangleF(x, track.Y, w, track.Height));
            if (seg.Width > 1)
                using (var p = Brand.Rounded(seg, S(3)))
                using (var br = new LinearGradientBrush(new RectangleF(seg.X - 1, seg.Y, seg.Width + 2, seg.Height), Brand.Accent, Brand.Cyan, 0f))
                    g.FillPath(br, p);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!_quitting && _ready && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); return; }
            _timeout.Stop();
            _anim.Stop();
            if (_backend != null)
            {
                if (!_backend.HasExited) { _backend.RequestShutdown(); _backend.WaitForExit(_ready ? 6000 : 500); }
                _backend.Dispose();
                _backend = null;
            }
            base.OnFormClosing(e);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { _timeout.Dispose(); _anim.Dispose(); if (_backend != null) _backend.Dispose(); }
            base.Dispose(disposing);
        }
    }
}
