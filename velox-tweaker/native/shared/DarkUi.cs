// Native (WinForms/GDI+) pieces in the VELOX design system, for the places where no web view is
// available: dialogs before WebView2 starts, the WebView2-runtime prompt, the fallback installer.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Windows.Forms;

namespace Velox.Native
{
    internal static class Brand
    {
        public static readonly Color Bg = Color.FromArgb(0x0F, 0x11, 0x15);
        public static readonly Color S1 = Color.FromArgb(0x15, 0x18, 0x21);
        public static readonly Color S2 = Color.FromArgb(0x1B, 0x1F, 0x2A);
        public static readonly Color S3 = Color.FromArgb(0x23, 0x28, 0x38);
        public static readonly Color Text = Color.FromArgb(0xE8, 0xEA, 0xF0);
        public static readonly Color Muted = Color.FromArgb(0x9A, 0xA3, 0xB2);
        public static readonly Color Faint = Color.FromArgb(0x6B, 0x73, 0x85);
        public static readonly Color Accent = Color.FromArgb(0x7C, 0x5C, 0xFF);
        public static readonly Color Cyan = Color.FromArgb(0x22, 0xD3, 0xEE);
        public static readonly Color Ok = Color.FromArgb(0x34, 0xD3, 0x99);
        public static readonly Color Err = Color.FromArgb(0xF4, 0x3F, 0x5E);
        /// <summary>#0F1115 as COLORREF (0x00BBGGRR) for DWMWA_CAPTION_COLOR.</summary>
        public const int CaptionBgr = 0x0015110F;

        public static Font UiFont(float px, FontStyle style)
        {
            // px = device pixels (callers already multiply by the DPI factor). GraphicsUnit.Pixel, not Point:
            // in a per-monitor DPI-aware process a point size is converted with the system DPI once more,
            // which made every text 1.5x too big on a 150 % screen and clipped it in the fixed layouts.
            try { return new Font("Segoe UI", px, style, GraphicsUnit.Pixel); }
            catch (Exception) { return new Font(FontFamily.GenericSansSerif, px, style, GraphicsUnit.Pixel); }
        }

        public static GraphicsPath Rounded(RectangleF r, float radius)
        {
            var p = new GraphicsPath();
            float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            if (d <= 0.5f) { p.AddRectangle(r); return p; }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        /// <summary>The fader-V logo (ui/index.html .vx-logo, viewBox 0 0 48 48) into a square.</summary>
        public static void DrawLogo(Graphics g, RectangleF box, float capLift)
        {
            var state = g.Save();
            try
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                float s = Math.Min(box.Width, box.Height) / 48f;
                g.TranslateTransform(box.X + (box.Width - 48 * s) / 2, box.Y + (box.Height - 48 * s) / 2);
                g.ScaleTransform(s, s);
                using (var track = new Pen(Color.FromArgb(97, Accent), 2.6f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                {
                    g.DrawLine(track, 11, 6, 11, 42);
                    g.DrawLine(track, 24, 6, 24, 42);
                    g.DrawLine(track, 37, 6, 37, 42);
                }
                using (var glow = new Pen(Color.FromArgb(60, Accent), 9f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                {
                    g.DrawLines(glow, new[] { new PointF(11, 13), new PointF(24, 35), new PointF(37, 13) });
                }
                using (var v = new Pen(Accent, 5f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                {
                    g.DrawLines(v, new[] { new PointF(11, 13), new PointF(24, 35), new PointF(37, 13) });
                }
                using (var cap = new SolidBrush(Text))
                {
                    foreach (var r in new[] { new RectangleF(5, 9.5f - capLift, 12, 7), new RectangleF(18, 31.5f + capLift, 12, 7), new RectangleF(31, 9.5f - capLift, 12, 7) })
                    {
                        using (var p = Rounded(r, 2.4f)) g.FillPath(cap, p);
                    }
                }
            }
            finally { g.Restore(state); }
        }
    }

    /// <summary>Flat, rounded button: "primary" = brand gradient, otherwise a subtle glass button.</summary>
    internal sealed class FlatButton : Control
    {
        private bool _hover, _down;
        public bool Primary { get; set; }
        public bool Danger { get; set; }
        public float UiScale { get; set; }

        public FlatButton()
        {
            UiScale = 1f;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
            Cursor = Cursors.Hand;
            BackColor = Brand.S1;
            ForeColor = Brand.Text;
            TabStop = true;
        }

        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; _down = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { _down = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { _down = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

        protected override bool IsInputKey(Keys keyData) { return keyData == Keys.Enter || keyData == Keys.Space || base.IsInputKey(keyData); }
        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter || e.KeyCode == Keys.Space) { OnClick(EventArgs.Empty); e.Handled = true; }
            base.OnKeyDown(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            using (var bg = new SolidBrush(Parent != null ? Parent.BackColor : Brand.Bg)) g.FillRectangle(bg, ClientRectangle);
            var r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
            if (_down) r.Inflate(-1, -1);
            float radius = 8 * UiScale;
            using (var path = Brand.Rounded(r, radius))
            {
                if (Primary)
                {
                    using (var br = new LinearGradientBrush(r, Brand.Accent, Brand.Cyan, 20f))
                    {
                        g.FillPath(br, path);
                    }
                    if (_hover && Enabled) using (var hl = new SolidBrush(Color.FromArgb(28, 255, 255, 255))) g.FillPath(hl, path);
                }
                else if (Danger)
                {
                    using (var br = new SolidBrush(Color.FromArgb(_hover ? 60 : 36, Brand.Err))) g.FillPath(br, path);
                    using (var pen = new Pen(Color.FromArgb(_hover ? 140 : 90, Brand.Err), 1f)) g.DrawPath(pen, path);
                }
                else
                {
                    using (var br = new SolidBrush(Color.FromArgb(_hover ? 26 : 15, 255, 255, 255))) g.FillPath(br, path);
                    using (var pen = new Pen(Color.FromArgb(_hover ? 41 : 26, 255, 255, 255), 1f)) g.DrawPath(pen, path);
                }
                if (Focused && ShowFocusCues)
                {
                    using (var pen = new Pen(Brand.Accent, 2f)) g.DrawPath(pen, path);
                }
            }
            Color fg = Primary ? Color.White : (Danger ? Color.FromArgb(0xFF, 0x8B, 0xA0) : Brand.Text);
            if (!Enabled) fg = Color.FromArgb(120, fg);
            TextRenderer.DrawText(g, Text, Font, Rectangle.Round(r), fg, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
        }
    }

    /// <summary>
    /// A dark, borderless-looking message dialog with the VELOX logo, a title, a message, an optional
    /// monospace detail box and up to three buttons. Returns the index of the clicked button (-1 = closed).
    /// </summary>
    internal sealed class DarkDialog : Form
    {
        private int _result = -1;
        private readonly float _k;

        private DarkDialog(string title, string message, string detail, string[] buttons, int primary, bool danger)
        {
            int dpi = Win.DpiForPoint(Cursor.Position.X, Cursor.Position.Y);
            _k = dpi / 96f;
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = true;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Brand.Bg;
            ForeColor = Brand.Text;
            Text = "VELOX";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
            Font = Brand.UiFont(14 * _k, FontStyle.Regular);

            int pad = S(24), width = S(460);
            int x = pad + S(56) + S(16);
            int textW = width - x - pad;
            int y = pad;

            var titleLbl = new Label { Text = title, AutoSize = false, ForeColor = Brand.Text, BackColor = Color.Transparent, Font = Brand.UiFont(20 * _k, FontStyle.Bold) };
            Size ts = TextRenderer.MeasureText(title, titleLbl.Font, new Size(textW, int.MaxValue), TextFormatFlags.WordBreak);
            titleLbl.SetBounds(x, y, textW, ts.Height + S(2));
            Controls.Add(titleLbl);
            y += titleLbl.Height + S(8);

            var msgLbl = new Label { Text = message, AutoSize = false, ForeColor = Brand.Muted, BackColor = Color.Transparent, Font = Font };
            Size ms = TextRenderer.MeasureText(message, msgLbl.Font, new Size(textW, int.MaxValue), TextFormatFlags.WordBreak);
            msgLbl.SetBounds(x, y, textW, ms.Height + S(4));
            Controls.Add(msgLbl);
            y += msgLbl.Height + S(12);

            if (!string.IsNullOrEmpty(detail))
            {
                var box = new TextBox
                {
                    Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, WordWrap = true,
                    BorderStyle = BorderStyle.None, BackColor = Brand.S1, ForeColor = Brand.Muted,
                    Text = detail.Replace("\r\n", "\n").Replace("\n", "\r\n")
                };
                try { box.Font = new Font("Consolas", 12f * _k, FontStyle.Regular, GraphicsUnit.Pixel); } catch (Exception) { }   // pixels: points would be scaled twice
                box.SetBounds(pad, y, width - 2 * pad, S(140));
                Controls.Add(box);
                y += box.Height + S(16);
            }
            y = Math.Max(y, pad + S(56) + S(16));

            int bh = S(36), gap = S(8), bx = width - pad;
            var made = new List<FlatButton>();
            for (int i = buttons.Length - 1; i >= 0; i--)
            {
                int idx = i;
                var b = new FlatButton { Text = buttons[i], Primary = i == primary && !danger, Danger = i == primary && danger, UiScale = _k, Font = Brand.UiFont(14 * _k, FontStyle.Bold) };
                int bw = Math.Max(S(96), TextRenderer.MeasureText(buttons[i], b.Font).Width + S(32));
                bx -= bw;
                b.SetBounds(bx, y, bw, bh);
                bx -= gap;
                b.Click += (s, e) => { _result = idx; Close(); };
                Controls.Add(b);
                made.Add(b);
            }
            ClientSize = new Size(width, y + bh + pad);
            if (primary >= 0 && primary < buttons.Length)
            {
                FlatButton def = made[buttons.Length - 1 - primary];
                Shown += (s, e) => { try { def.Focus(); } catch (Exception) { } };
            }
            KeyPreview = true;
            KeyDown += (s, e) => { if (e.KeyCode == Keys.Escape) { _result = -1; Close(); } };
        }

        private int S(int v) { return (int)Math.Round(v * _k); }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Win.ApplyDarkFrame(Handle, true, Brand.CaptionBgr);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            int pad = S(24);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var tile = new RectangleF(pad, pad, S(56), S(56));
            using (var p = Brand.Rounded(tile, S(14)))
            using (var br = new SolidBrush(Brand.S1))
            using (var pen = new Pen(Color.FromArgb(18, 255, 255, 255)))
            {
                g.FillPath(br, p);
                g.DrawPath(pen, p);
            }
            var inner = tile;
            inner.Inflate(-S(8), -S(8));
            Brand.DrawLogo(g, inner, 0);
        }

        public static int Show(IWin32Window owner, string title, string message, string detail, string[] buttons, int primary, bool danger)
        {
            try
            {
                using (var d = new DarkDialog(title, message, detail, buttons, primary, danger))
                {
                    if (owner != null) { d.StartPosition = FormStartPosition.CenterParent; d.ShowDialog(owner); }
                    else { d.TopMost = true; d.ShowDialog(); }
                    return d._result;
                }
            }
            catch (Exception)
            {
                // last resort: the plain system dialog
                try
                {
                    var r = MessageBox.Show(message + (string.IsNullOrEmpty(detail) ? "" : "\n\n" + detail), title, buttons.Length > 1 ? MessageBoxButtons.OKCancel : MessageBoxButtons.OK);
                    return r == DialogResult.OK ? Math.Max(0, primary) : -1;
                }
                catch (Exception) { return -1; }
            }
        }
    }
}
