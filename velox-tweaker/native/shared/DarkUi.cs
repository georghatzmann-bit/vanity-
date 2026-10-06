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
        // brand/tokens.css ("Versatz"): ink + bone, one signal colour, no gradients, no glow
        public static readonly Color Bg = Color.FromArgb(0x0C, 0x0D, 0x0F);       // --vx-ink
        public static readonly Color S1 = Color.FromArgb(0x14, 0x15, 0x18);       // --vx-ink-2
        public static readonly Color S2 = Color.FromArgb(0x1A, 0x1B, 0x1F);       // --vx-ink-3 (the icon tile)
        public static readonly Color S3 = Color.FromArgb(0x21, 0x23, 0x28);       // --vx-ink-4
        public static readonly Color Line = Color.FromArgb(0x2A, 0x2C, 0x31);     // --vx-line
        public static readonly Color Line2 = Color.FromArgb(0x45, 0x48, 0x4F);    // --vx-line-2
        public static readonly Color Text = Color.FromArgb(0xEC, 0xE9, 0xE2);     // --vx-bone
        public static readonly Color Muted = Color.FromArgb(0x8E, 0x8B, 0x85);    // --vx-ash
        public static readonly Color Faint = Color.FromArgb(0x80, 0x7D, 0x77);    // --vx-ash-2
        public static readonly Color Accent = Color.FromArgb(0xFF, 0x5A, 0x1F);   // --vx-signal
        public static readonly Color AccentHi = Color.FromArgb(0xFF, 0x70, 0x38); // --vx-signal-hi
        public static readonly Color OnAccent = Color.FromArgb(0x0C, 0x0D, 0x0F); // --vx-on-signal (never bone on signal)
        public static readonly Color Ok = Color.FromArgb(0x3F, 0xC9, 0x8A);       // --vx-safe
        public static readonly Color Err = Color.FromArgb(0xF2, 0x5A, 0x80);      // --vx-risk
        /// <summary>#0C0D0F as COLORREF (0x00BBGGRR) for DWMWA_CAPTION_COLOR.</summary>
        public const int CaptionBgr = 0x000F0D0C;
        /// <summary>#2A2C31 as COLORREF for DWMWA_BORDER_COLOR (the borderless setup window's hairline).</summary>
        public const int LineBgr = 0x00312C2A;

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

        // brand/mark.svg (viewBox 0 0 106.84 100): the wordmark's V, cut at 44-52, the upper half one step ahead
        private static readonly PointF[] MarkTopL = { new PointF(22.84f, 0), new PointF(47.84f, 0), new PointF(52.56f, 44), new PointF(28.63f, 44) };
        private static readonly PointF[] MarkTopR = { new PointF(63.18f, 44), new PointF(81.84f, 0), new PointF(106.84f, 0), new PointF(87.11f, 44) };
        private static readonly PointF[] MarkFoot = { new PointF(46.41f, 52), new PointF(47.7f, 64), new PointF(52.79f, 52), new PointF(76.52f, 52), new PointF(55, 100), new PointF(29, 100), new PointF(22.68f, 52) };

        /// <summary>
        /// The VELOX mark (brand/mark.svg) centred in a box. <paramref name="shift"/> moves the bone upper half
        /// sideways in mark units (0 = the canonical pose, where it already sits one step ahead).
        /// </summary>
        public static void DrawLogo(Graphics g, RectangleF box, float shift)
        {
            var state = g.Save();
            try
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                float s = Math.Min(box.Width / 106.84f, box.Height / 100f);
                g.TranslateTransform(box.X + (box.Width - 106.84f * s) / 2, box.Y + (box.Height - 100f * s) / 2);
                g.ScaleTransform(s, s);
                using (var foot = new SolidBrush(Accent)) g.FillPolygon(foot, MarkFoot);
                g.TranslateTransform(shift, 0);
                using (var top = new SolidBrush(Text))
                {
                    g.FillPolygon(top, MarkTopL);
                    g.FillPolygon(top, MarkTopR);
                }
            }
            finally { g.Restore(state); }
        }

        /// <summary>
        /// The kit's loader (brand/intro.css .vx-track): a 1 px hairline with a 2 px signal segment. pct &lt; 0 =
        /// indeterminate (the segment slides along every 1.7 s, <paramref name="seconds"/> = a running clock);
        /// 0..100 = the finished part in bone with the signal only at its head (brand/ticks.js: orange is the
        /// current position, never "finished"); 100 = all bone.
        /// </summary>
        public static void DrawLoader(Graphics g, RectangleF r, float k, double seconds, double pct)
        {
            var mode = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.None;
            float thick = Math.Max(1, (float)Math.Round(2 * k)), hair = Math.Max(1, (float)Math.Round(k));
            float y = (float)Math.Round(r.Y), x0 = (float)Math.Round(r.X), w = (float)Math.Round(r.Width);
            using (var line = new SolidBrush(Line)) g.FillRectangle(line, x0, y + (float)Math.Floor((thick - hair) / 2), w, hair);
            if (pct < 0)
            {
                double u = (seconds % 1.7) / 1.7;
                double a = u < 0.5 ? 2 * u * u : 1 - Math.Pow(-2 * u + 2, 2) / 2;     // ease in-out across the track
                float segW = w * 0.22f, sx = x0 + (float)((w + segW) * a) - segW;
                float l = Math.Max(x0, sx), rgt = Math.Min(x0 + w, sx + segW);
                if (rgt - l >= 1) using (var b = new SolidBrush(Accent)) g.FillRectangle(b, l, y, rgt - l, thick);
            }
            else
            {
                float fw = (float)Math.Round(w * Math.Max(0, Math.Min(100, pct)) / 100.0);
                if (fw >= 1) using (var b = new SolidBrush(Text)) g.FillRectangle(b, x0, y, fw, thick);
                if (pct < 100) using (var b = new SolidBrush(Accent)) g.FillRectangle(b, x0 + Math.Max(0, fw - thick), y - thick, thick, thick * 3);
            }
            g.SmoothingMode = mode;
        }

        /// <summary>The app icon: the mark on the lifted tile (brand/app-icon.svg: #1A1B1F, 1 px keyline #45484F).</summary>
        public static void DrawAppIcon(Graphics g, RectangleF box)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float r = box.Width * 54.72f / 256f;
            var tile = new RectangleF(box.X + 0.5f, box.Y + 0.5f, box.Width - 1, box.Height - 1);
            using (var p = Rounded(tile, r))
            using (var br = new SolidBrush(S2))
            using (var pen = new Pen(Line2, 1f))
            {
                g.FillPath(br, p);
                g.DrawPath(pen, p);
            }
            // app-icon.svg: the mark at translate(44.41 51.2) scale(1.536) inside the 256 tile
            float k = box.Width / 256f;
            DrawLogo(g, new RectangleF(box.X + 44.41f * k, box.Y + 51.2f * k, 106.84f * 1.536f * k, 100f * 1.536f * k), 0);
        }
    }

    /// <summary>Flat button: "primary" = solid signal with ink text, otherwise a hairline button (brand/tokens.css).</summary>
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
            float radius = 6 * UiScale;
            using (var path = Brand.Rounded(r, radius))
            {
                if (Primary)
                {
                    using (var br = new SolidBrush(_hover && Enabled ? Brand.AccentHi : Brand.Accent)) g.FillPath(br, path);
                }
                else if (Danger)
                {
                    using (var br = new SolidBrush(Color.FromArgb(_hover ? 46 : 26, Brand.Err))) g.FillPath(br, path);
                    using (var pen = new Pen(Color.FromArgb(_hover ? 200 : 140, Brand.Err), 1f)) g.DrawPath(pen, path);
                }
                else
                {
                    if (_hover && Enabled) using (var br = new SolidBrush(Brand.S3)) g.FillPath(br, path);
                    using (var pen = new Pen(Brand.Line2, 1f)) g.DrawPath(pen, path);
                }
                if (Focused && ShowFocusCues)
                {
                    var fr = r; fr.Inflate(1.5f * UiScale, 1.5f * UiScale);
                    using (var fp = Brand.Rounded(fr, radius + 1.5f * UiScale))
                    using (var pen = new Pen(Brand.Accent, 2f * UiScale)) g.DrawPath(pen, fp);
                }
            }
            Color fg = Primary ? Brand.OnAccent : (Danger ? Brand.Err : Brand.Text);
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
            Brand.DrawAppIcon(g, new RectangleF(pad, pad, S(56), S(56)));
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
