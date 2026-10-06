// Installs the Microsoft Edge WebView2 Runtime when it is missing (Evergreen bootstrapper from Microsoft).
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Threading;
using System.Windows.Forms;
using Velox.Native;

namespace Velox.Setup
{
    internal static class Authenticode
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WINTRUST_FILE_INFO
        {
            public uint cbStruct;
            [MarshalAs(UnmanagedType.LPWStr)] public string pcwszFilePath;
            public IntPtr hFile;
            public IntPtr pgKnownSubject;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WINTRUST_DATA
        {
            public uint cbStruct;
            public IntPtr pPolicyCallbackData;
            public IntPtr pSIPClientData;
            public uint dwUIChoice;
            public uint fdwRevocationChecks;
            public uint dwUnionChoice;
            public IntPtr pFile;
            public uint dwStateAction;
            public IntPtr hWVTStateData;
            public IntPtr pwszURLReference;
            public uint dwProvFlags;
            public uint dwUIContext;
            public IntPtr pSignatureSettings;
        }

        [DllImport("wintrust.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
        private static extern int WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid actionId, ref WINTRUST_DATA data);

        private static readonly Guid GenericVerifyV2 = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        private const uint WTD_UI_NONE = 2, WTD_REVOKE_NONE = 0, WTD_CHOICE_FILE = 1, WTD_STATEACTION_VERIFY = 1, WTD_STATEACTION_CLOSE = 2, WTD_CACHE_ONLY_URL_RETRIEVAL = 0x1000;

        /// <summary>true when the file has a valid Authenticode signature from Microsoft Corporation.</summary>
        public static bool IsSignedByMicrosoft(string path, Log log)
        {
            IntPtr pFile = IntPtr.Zero;
            try
            {
                var fi = new WINTRUST_FILE_INFO { cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)), pcwszFilePath = path };
                pFile = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)));
                Marshal.StructureToPtr(fi, pFile, false);
                var data = new WINTRUST_DATA
                {
                    cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA)),
                    dwUIChoice = WTD_UI_NONE,
                    fdwRevocationChecks = WTD_REVOKE_NONE,
                    dwUnionChoice = WTD_CHOICE_FILE,
                    pFile = pFile,
                    dwStateAction = WTD_STATEACTION_VERIFY,
                    dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL
                };
                int hr = WinVerifyTrust(IntPtr.Zero, GenericVerifyV2, ref data);
                data.dwStateAction = WTD_STATEACTION_CLOSE;
                WinVerifyTrust(IntPtr.Zero, GenericVerifyV2, ref data);
                if (hr != 0) { log.Warn("Signatur ungültig (0x" + hr.ToString("X8") + "): " + path); return false; }
                using (var cert = new X509Certificate2(X509Certificate.CreateFromSignedFile(path)))
                {
                    bool ms = cert.Subject.IndexOf("O=Microsoft Corporation", StringComparison.OrdinalIgnoreCase) >= 0;
                    if (!ms) log.Warn("Unerwarteter Herausgeber: " + cert.Subject);
                    return ms;
                }
            }
            catch (Exception ex) { log.Warn("Signaturprüfung fehlgeschlagen: " + ex.Message); return false; }
            finally
            {
                if (pFile != IntPtr.Zero)
                {
                    try { Marshal.DestroyStructure(pFile, typeof(WINTRUST_FILE_INFO)); } catch (Exception) { }
                    Marshal.FreeHGlobal(pFile);
                }
            }
        }
    }

    internal static class WebView2Runtime
    {
        public const string BootstrapperUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

        /// <summary>Downloads and silently runs the Evergreen bootstrapper. Returns true on exit code 0.</summary>
        public static bool Install(string tempDir, Log log, Action<string> status)
        {
            string file = Path.Combine(tempDir, "MicrosoftEdgeWebview2Setup.exe");
            try
            {
                status("Wird heruntergeladen …");
                try { ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12; } catch (Exception) { }
                var req = (HttpWebRequest)WebRequest.Create(BootstrapperUrl);
                req.Timeout = 60000;
                req.ReadWriteTimeout = 60000;
                req.AllowAutoRedirect = true;
                req.UserAgent = "VeloxSetup/" + Util.Version();
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (Stream s = resp.GetResponseStream())
                using (var f = new FileStream(file, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    var buf = new byte[81920];
                    long total = 0;
                    int n;
                    while ((n = s.Read(buf, 0, buf.Length)) > 0)
                    {
                        f.Write(buf, 0, n);
                        total += n;
                        if (total > 50L * 1024 * 1024) throw new IOException("Download zu groß");
                    }
                    log.Info("WebView2-Bootstrapper geladen: " + total + " Bytes von " + resp.ResponseUri);
                }
                if (!Authenticode.IsSignedByMicrosoft(file, log)) { status("Die Datei ist nicht von Microsoft signiert."); return false; }
                status("Wird installiert …");
                var psi = new ProcessStartInfo(file, "/silent /install") { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = tempDir };
                using (Process p = Process.Start(psi))
                {
                    if (!p.WaitForExit(10 * 60 * 1000)) { log.Warn("WebView2-Installation dauert zu lange."); return false; }
                    log.Info("WebView2-Installation beendet, Code " + p.ExitCode);
                    return p.ExitCode == 0;
                }
            }
            catch (Exception ex)
            {
                log.Warn("WebView2-Installation fehlgeschlagen: " + ex.Message);
                return false;
            }
            finally { try { if (File.Exists(file)) File.Delete(file); } catch (Exception) { } }
        }
    }

    /// <summary>Small dark progress window while the runtime downloads and installs.</summary>
    internal sealed class RuntimeProgressForm : Form
    {
        private readonly float _k;
        private readonly System.Windows.Forms.Timer _anim = new System.Windows.Forms.Timer { Interval = 33 };
        private float _phase;
        private string _status = "Wird vorbereitet …";
        public bool Result { get; private set; }

        public RuntimeProgressForm(string tempDir, Log log)
        {
            _k = Win.DpiForPoint(Cursor.Position.X, Cursor.Position.Y) / 96f;
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false; ControlBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Brand.Bg;
            Text = "VELOX Setup";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
            ClientSize = new Size((int)(420 * _k), (int)(170 * _k));
            DoubleBuffered = true;
            _anim.Tick += (s, e) => { _phase += 0.033f; Invalidate(); };
            Shown += (s, e) =>
            {
                _anim.Start();
                var t = new Thread(() =>
                {
                    bool ok = WebView2Runtime.Install(tempDir, log, txt => { try { BeginInvoke((Action)(() => { _status = txt; Invalidate(); })); } catch (Exception) { } });
                    try { BeginInvoke((Action)(() => { Result = ok; _anim.Stop(); Close(); })); } catch (Exception) { }
                }) { IsBackground = true };
                t.Start();
            };
        }

        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Win.ApplyDarkFrame(Handle, true, Brand.CaptionBgr); }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            int pad = (int)(24 * _k);
            Brand.DrawLogo(g, new RectangleF(pad, pad, 48 * _k, 48 * _k), (float)Math.Sin(_phase * 4.5) * 2f);
            using (var f = Brand.UiFont(16 * _k, FontStyle.Bold))
                TextRenderer.DrawText(g, "Microsoft WebView2 wird installiert", f, new Point((int)(pad + 64 * _k), pad + (int)(4 * _k)), Brand.Text);
            using (var f = Brand.UiFont(14 * _k, FontStyle.Regular))
                TextRenderer.DrawText(g, _status, f, new Point((int)(pad + 64 * _k), pad + (int)(30 * _k)), Brand.Muted);
            var track = new RectangleF(pad, ClientSize.Height - pad - 6 * _k, ClientSize.Width - 2 * pad, 6 * _k);
            using (var p = Brand.Rounded(track, 3 * _k)) using (var br = new SolidBrush(Color.FromArgb(18, 255, 255, 255))) g.FillPath(br, p);
            float w = track.Width * 0.38f, x = track.X + (float)((_phase * 0.55) % 1.3 - 0.3) * track.Width;
            var seg = RectangleF.Intersect(track, new RectangleF(x, track.Y, w, track.Height));
            if (seg.Width > 1)
                using (var p = Brand.Rounded(seg, 3 * _k))
                using (var br = new LinearGradientBrush(new RectangleF(seg.X - 1, seg.Y, seg.Width + 2, seg.Height), Brand.Accent, Brand.Cyan, 0f))
                    g.FillPath(br, p);
        }

        protected override void Dispose(bool disposing) { if (disposing) _anim.Dispose(); base.Dispose(disposing); }
    }
}
