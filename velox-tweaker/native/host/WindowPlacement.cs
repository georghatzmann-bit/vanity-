// Remembers size, position and the maximized state of the VELOX window in %LOCALAPPDATA%\Velox\window.json.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Velox.Native;

namespace Velox.Host
{
    internal static class WindowPlacement
    {
        public const int DefaultW = 1360, DefaultH = 880, MinW = 900, MinH = 600;

        private static string FilePath { get { return Path.Combine(Program.DataDir, "window.json"); } }

        /// <summary>The bounds to open with: the saved ones if they are still on a screen, else the default size centred on the primary work area.</summary>
        public static Rectangle Initial(out bool maximized)
        {
            maximized = false;
            try
            {
                if (File.Exists(FilePath))
                {
                    var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(FilePath, Encoding.UTF8));
                    int x = Convert.ToInt32(d["x"], CultureInfo.InvariantCulture), y = Convert.ToInt32(d["y"], CultureInfo.InvariantCulture);
                    int w = Convert.ToInt32(d["w"], CultureInfo.InvariantCulture), h = Convert.ToInt32(d["h"], CultureInfo.InvariantCulture);
                    object mx;
                    if (d.TryGetValue("maximized", out mx) && mx is bool) maximized = (bool)mx;
                    var r = new Rectangle(x, y, w, h);
                    Screen scr = Screen.FromRectangle(r);
                    Rectangle wa = scr.WorkingArea;
                    var visible = Rectangle.Intersect(wa, r);
                    // at least a good part of the title bar must be reachable on the screen
                    if (w >= 200 && h >= 150 && visible.Width >= 160 && visible.Height >= 80 && r.Top >= wa.Top - 8)
                        return Clamp(r, wa, Win.DpiForPoint(wa.Left + wa.Width / 2, wa.Top + wa.Height / 2));
                }
            }
            catch (Exception ex) { Program.Log.Warn("window.json nicht lesbar: " + ex.Message); }
            Rectangle area = Screen.PrimaryScreen != null ? Screen.PrimaryScreen.WorkingArea : new Rectangle(0, 0, 1366, 728);
            int dpi = Win.DpiForPoint(area.Left + area.Width / 2, area.Top + area.Height / 2);
            float k = dpi / 96f;
            int dw = (int)Math.Round(DefaultW * k), dh = (int)Math.Round(DefaultH * k);
            var def = new Rectangle(area.Left + (area.Width - dw) / 2, area.Top + (area.Height - dh) / 2, dw, dh);
            return Clamp(def, area, dpi);
        }

        /// <summary>Keeps the window inside the work area (and never smaller than the minimum).</summary>
        public static Rectangle Clamp(Rectangle r, Rectangle wa, int dpi)
        {
            float k = dpi / 96f;
            int minW = Math.Min((int)Math.Round(MinW * k), wa.Width), minH = Math.Min((int)Math.Round(MinH * k), wa.Height);
            int w = Math.Max(minW, Math.Min(r.Width, wa.Width));
            int h = Math.Max(minH, Math.Min(r.Height, wa.Height));
            int x = Math.Max(wa.Left, Math.Min(r.Left, wa.Right - w));
            int y = Math.Max(wa.Top, Math.Min(r.Top, wa.Bottom - h));
            return new Rectangle(x, y, w, h);
        }

        public static void Save(Form f)
        {
            try
            {
                Rectangle r = f.WindowState == FormWindowState.Normal ? f.Bounds : f.RestoreBounds;
                if (r.Width < 200 || r.Height < 150) return;
                bool max = f.WindowState == FormWindowState.Maximized;
                string json = string.Format(CultureInfo.InvariantCulture, "{{\"x\":{0},\"y\":{1},\"w\":{2},\"h\":{3},\"maximized\":{4}}}", r.X, r.Y, r.Width, r.Height, max ? "true" : "false");
                Directory.CreateDirectory(Program.DataDir);
                string tmp = FilePath + ".tmp";
                File.WriteAllText(tmp, json, new UTF8Encoding(false));
                if (File.Exists(FilePath)) File.Delete(FilePath);
                File.Move(tmp, FilePath);
            }
            catch (Exception ex) { Program.Log.Warn("window.json nicht gespeichert: " + ex.Message); }
        }
    }
}
