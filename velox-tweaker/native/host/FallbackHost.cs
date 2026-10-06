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
        private readonly StartTimer _timeout;
        private readonly Timer _anim = new Timer { Interval = 33 };
        private Backend _backend;
        private bool _test;
        private bool _ready;
        private bool _quitting;
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
            _timeout = new StartTimer(OnTimeout);
            _anim.Tick += (s, e) => Invalidate();
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
            b.Output += () => UI(() => { if (b == _backend) _timeout.Alive(); });
            b.Status += key => UI(() =>
            {
                if (b != _backend || _ready) return;
                string text = StartupText.Status(key, _test);
                if (text != null) { _status = text; Invalidate(); }
            });
            _backend = b;
            _timeout.Begin();
            string err;
            if (!b.Start(Program.AppDir, _test, false, out err)) { _timeout.Stop(); Fail(err, b.Tail(30)); return; }
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
            Fail(StartupText.EarlyExit(b.Errors(), b.Tail(80), code, Program.AppDir), b.Tail(30));
        }

        private void OnTimeout()
        {
            if (_ready || _backend == null) return;
            string tail = _backend.Tail(30);
            _backend.Dispose();
            _backend = null;
            Fail("Der VELOX-Motor hat sich nach " + _timeout.ElapsedSeconds + " Sekunden noch nicht gemeldet. Oft hilft ein zweiter Versuch oder ein Neustart des PCs.", tail);
        }

        private void Fail(string message, string tail)
        {
            _anim.Stop();
            _log.Warn("VELOX konnte nicht starten: " + message);
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
            // brand/: ink ground, the mark, bone title, ash status, the kit's hairline loader. Left-aligned on one edge.
            int m = S(32);
            Brand.DrawLogo(g, new RectangleF(m, S(36), S(56), S(52)), 0);
            using (var f = Brand.UiFont(22 * _k, FontStyle.Bold))
                TextRenderer.DrawText(g, "VELOX", f, new Point(m, S(104)), Brand.Text, TextFormatFlags.NoPadding);
            if (_test)
                using (var f = Brand.UiFont(12 * _k, FontStyle.Regular))
                    TextRenderer.DrawText(g, "Testmodus", f, new Rectangle(m, S(20), ClientSize.Width - 2 * m, S(18)), Brand.Ok, TextFormatFlags.Right | TextFormatFlags.NoPadding);
            Brand.DrawLoader(g, new RectangleF(m, S(176), ClientSize.Width - 2 * m, S(2)), _k, Environment.TickCount / 1000.0, -1);
            using (var f = Brand.UiFont(13 * _k, FontStyle.Regular))
                TextRenderer.DrawText(g, _status, f, new Rectangle(m, S(190), ClientSize.Width - 2 * m, S(22)), Brand.Muted, TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding);
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
