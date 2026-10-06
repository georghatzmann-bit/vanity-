// Remembers size, position and the maximized state of the VELOX window in %LOCALAPPDATA%\Velox\window.json,
// and lastIntroVersion: the VERSION whose full start sequence VELOX.exe last played (host-owned, never settings.json).
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
                Dictionary<string, object> d = Read();
                d["x"] = r.X; d["y"] = r.Y; d["w"] = r.Width; d["h"] = r.Height;
                d["maximized"] = f.WindowState == FormWindowState.Maximized;
                Write(d);
            }
            catch (Exception ex) { Program.Log.Warn("window.json nicht gespeichert: " + ex.Message); }
        }

        /// <summary>
        /// "full" the first time this VERSION starts (first start after an install or update), "short" after that.
        /// Records the version at once, so a start that ends in an error does not replay the full intro.
        /// </summary>
        public static string TakeIntroVariant(string version)
        {
            try
            {
                Dictionary<string, object> d = Read();
                object v;
                if (d.TryGetValue("lastIntroVersion", out v) && string.Equals(v as string, version, StringComparison.Ordinal)) return "short";
                d["lastIntroVersion"] = version;
                Write(d);
                return "full";
            }
            catch (Exception ex)
            {
                Program.Log.Warn("window.json (lastIntroVersion): " + ex.Message);
                return "short";
            }
        }

        /// <summary>The whole file (other keys are kept on every write); empty when missing or unreadable.</summary>
        private static Dictionary<string, object> Read()
        {
            try
            {
                if (File.Exists(FilePath))
                {
                    var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(FilePath, Encoding.UTF8));
                    if (d != null) return d;
                }
            }
            catch (Exception) { }
            return new Dictionary<string, object>();
        }

        private static void Write(Dictionary<string, object> d)
        {
            Directory.CreateDirectory(Program.DataDir);
            string tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, new JavaScriptSerializer().Serialize(d), new UTF8Encoding(false));
            if (File.Exists(FilePath))
            {
                try { File.Replace(tmp, FilePath, null, true); return; }      // atomic on NTFS
                catch (PlatformNotSupportedException) { }
                catch (IOException) { }
                File.Delete(FilePath);
            }
            File.Move(tmp, FilePath);
        }
    }
}
