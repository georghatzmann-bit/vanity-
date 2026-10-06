// The modern installer window: a borderless WinForms window hosting WebView2 with the HTML UI from
// native/setup-ui (embedded). ALL code that touches WebView2 types lives in this file.
//
// The WebView2 browser process does not get this process's administrator rights (the runtime de-elevates it;
// under Administrator Protection it may even run as another account). So it reads nothing of ours from disk -
// the UI is answered from memory (EmbeddedSite via WebResourceRequested) - and its user data folder is a
// normal folder of the user (WebViewData), never inside the private Admins-only Program.TempDir, which is
// only for what THIS process loads (WebView2Loader.dll).
//
// Message protocol (JSON objects, docs/ARCHITECTURE.md "Native host & installer"):
//   page -> setup: ready | drag | minimize | close | browse | checkRunning | install{dir,desktop,startMenu,launch,closeRunning}
//                  | uninstall{keepData,closeRunning} | launch | openLog | exit
//   setup -> page: init{...} | folder{dir,error,freeMB} | running{running} | progress{percent,step,file}
//                  | done{mode,launched} | error{message,hint}
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Velox.Native;

namespace Velox.Setup
{
    internal static class WebSetup
    {
        private static bool _loaderSet;

        public static bool RuntimeAvailable(string loaderDir, out string why)
        {
            why = null;
            try
            {
                if (!_loaderSet) { CoreWebView2Environment.SetLoaderDllFolderPath(loaderDir); _loaderSet = true; }
                string v = CoreWebView2Environment.GetAvailableBrowserVersionString();
                if (string.IsNullOrEmpty(v)) { why = "keine Version"; return false; }
                Program.Log.Info("WebView2 Runtime " + v);
                return true;
            }
            catch (WebView2RuntimeNotFoundException) { why = "WebView2 Runtime nicht installiert"; return false; }
            catch (Exception ex) { why = ex.GetType().Name + ": " + ex.Message; return false; }
        }

        /// <summary>false = the web window could not even start (caller shows the native fallback).</summary>
        public static bool Run(Program.Args a, out int exitCode)
        {
            exitCode = 1;
            // index.html, setup.css, setup.js and brand/* (byte-identical copies of the brand kit), from memory
            var site = new EmbeddedSite(SetupForm.Host, typeof(Program).Assembly, "ui/");
            foreach (string f in new[] { "index.html", "setup.css", "setup.js", "brand/intro.js", "brand/ticks.js" })
                if (!site.Has(f)) { Program.Log.Error("UI-Datei fehlt im Setup: " + f); return false; }
            WebViewData.CleanupStaleSetupRuns(Program.Log);
            using (var form = new SetupForm(a, site))
            {
                Application.Run(form);
                exitCode = form.ExitCode;
                return !form.StartFailed;
            }
        }
    }

    internal sealed class SetupForm : Form
    {
        internal const string Host = "setup.velox.example";
        // the intro's sound plays without a click (WebView2 otherwise blocks audio until a user gesture)
        private const string AutoplayArgs = "--autoplay-policy=no-user-gesture-required";
        private const int DipW = 880, DipH = 560;
        // a runtime that never finishes CreateAsync / EnsureCoreWebView2Async (stuck, or waiting behind one of its
        // own error dialogs) must not leave the user with an empty window: give up and use the native window
        private const int WebViewStartTimeoutMs = 30000;
        // the page must report "ready" this long after its navigation began; otherwise (not loaded - an Edge error
        // page - or its modules failed) nothing has happened yet and the native window takes over
        private const int PageReadyTimeoutMs = 15000;

        private readonly Program.Args _args;
        private readonly EmbeddedSite _site;
        private CoreWebView2Environment _env;
        private readonly System.Windows.Forms.Timer _webWatchdog = new System.Windows.Forms.Timer { Interval = WebViewStartTimeoutMs };
        private bool _webGaveUp;
        private readonly System.Windows.Forms.Timer _pageWatchdog = new System.Windows.Forms.Timer { Interval = PageReadyTimeoutMs };
        private bool _pageReady;
        private ulong _pageNavId;
        private readonly Log _log = Program.Log;
        private readonly WebView2 _web;
        private CoreWebView2 _core;
        private bool _busy;
        private bool _allowClose;
        private string _installedDir;   // after a successful install, for "VELOX starten"
        private bool _quietStart;       // the intro was muted here (M / sound button): passed to VELOX.exe as --quiet-start
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();

        public int ExitCode { get; private set; }
        public bool StartFailed { get; private set; }

        public SetupForm(Program.Args args, EmbeddedSite site)
        {
            _args = args;
            _site = site;
            ExitCode = 2;   // closed without finishing
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.None;
            MaximizeBox = false;    // no Win+Up / caption double-click maximize of the fixed-size window
            BackColor = Brand.Bg;
            Text = args.Uninstall ? "VELOX entfernen" : "VELOX Setup";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
            ShowInTaskbar = true;
            StartPosition = FormStartPosition.Manual;
            Rectangle wa = Screen.FromPoint(Cursor.Position).WorkingArea;
            float k = Win.DpiForPoint(wa.Left + wa.Width / 2, wa.Top + wa.Height / 2) / 96f;
            int w = Math.Min((int)Math.Round(DipW * k), wa.Width), h = Math.Min((int)Math.Round(DipH * k), wa.Height);
            Bounds = new Rectangle(wa.Left + (wa.Width - w) / 2, wa.Top + (wa.Height - h) / 2, w, h);

            // the env var WEBVIEW2_DEFAULT_BACKGROUND_COLOR is ignored for elevated hosts (this one always is):
            // the control property is applied to the controller when it is created - no white flash
            _web = new WebView2 { Dock = DockStyle.Fill };
            try { _web.DefaultBackgroundColor = Brand.Bg; } catch (Exception) { }
            Controls.Add(_web);
        }

        protected override CreateParams CreateParams
        {
            get
            {
                const int WS_MINIMIZEBOX = 0x00020000, WS_SYSMENU = 0x00080000, CS_DROPSHADOW = 0x00020000;
                CreateParams cp = base.CreateParams;
                cp.Style |= WS_MINIMIZEBOX | WS_SYSMENU;   // taskbar click minimizes/restores a borderless window
                cp.ClassStyle |= CS_DROPSHADOW;
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Win.ApplyDarkFrame(Handle, true, -1);
            try
            {
                int border = Brand.LineBgr;   // --vx-line as COLORREF: a hairline around the window (Windows 11)
                NativeMethods.DwmSetWindowAttribute(Handle, NativeMethods.DWMWA_BORDER_COLOR, ref border, 4);
            }
            catch (Exception) { }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == NativeMethods.WM_DPICHANGED)
            {
                Win.ApplySuggestedRect(Handle, m.LParam);
                m.Result = IntPtr.Zero;
                return;
            }
            base.WndProc(ref m);
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            string udf = null;
            _webWatchdog.Tick += (s0, a0) =>
            {
                _webWatchdog.Stop();
                if (_core != null || _webGaveUp) return;
                _webGaveUp = true;
                _log.Error("WebView2 hat sich nach " + WebViewStartTimeoutMs / 1000 + " s nicht gemeldet (Datenordner " + (udf ?? "-") + ") - einfache Ansicht.");
                StartFailed = true;
                _allowClose = true;
                Close();
            };
            _webWatchdog.Start();
            try
            {
                // a fresh user data folder per run in the user's %TEMP% with the normal inherited ACL (WebViewData),
                // so no other browser process can hold it with other options; if the runtime still refuses the
                // argument, start without it in another fresh folder (the intro then runs silent and offers
                // "Ton: klicken"). The autoplay flag is an API option, which the runtime honours for elevated hosts.
                udf = WebViewData.NewSetupRun(_log);
                CoreWebView2Environment env;
                var opts = new CoreWebView2EnvironmentOptions();
                try { opts.Language = "de-DE"; } catch (Exception) { }
                opts.AdditionalBrowserArguments = AutoplayArgs;
                try { env = await CoreWebView2Environment.CreateAsync(null, udf, opts); }
                catch (Exception ex)
                {
                    if (_webGaveUp) return;
                    _log.Warn("WebView2 mit Autoplay nicht gestartet (HRESULT 0x" + ex.HResult.ToString("X8") + ": " + ex.Message + ") - ohne.");
                    opts = new CoreWebView2EnvironmentOptions();
                    try { opts.Language = "de-DE"; } catch (Exception) { }
                    udf = WebViewData.NewSetupRun(_log);
                    env = await CoreWebView2Environment.CreateAsync(null, udf, opts);
                }
                if (_webGaveUp) return;
                await _web.EnsureCoreWebView2Async(env);
                if (_webGaveUp) return;
                _webWatchdog.Stop();
                _env = env;
                _core = _web.CoreWebView2;
                Try(() => _web.DefaultBackgroundColor = Brand.Bg);
                CoreWebView2Settings s = _core.Settings;
                Try(() => s.AreDevToolsEnabled = false);
                Try(() => s.AreBrowserAcceleratorKeysEnabled = false);
                Try(() => s.AreDefaultContextMenusEnabled = false);
                Try(() => s.IsStatusBarEnabled = false);
                Try(() => s.IsZoomControlEnabled = false);
                Try(() => s.IsPinchZoomEnabled = false);
                Try(() => s.IsSwipeNavigationEnabled = false);
                Try(() => s.IsGeneralAutofillEnabled = false);
                Try(() => s.IsPasswordAutosaveEnabled = false);
                Try(() => s.AreHostObjectsAllowed = false);
                Try(() => s.IsWebMessageEnabled = true);
                // https://setup.velox.example/* from memory; the event fires on the UI thread and is answered
                // synchronously (no deferral)
                try { _core.AddWebResourceRequestedFilter(_site.Filter, CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.Document); }
                catch (NotImplementedException) { _core.AddWebResourceRequestedFilter(_site.Filter, CoreWebView2WebResourceContext.All); }   // runtime without ICoreWebView2_22
                _core.WebResourceRequested += OnWebResourceRequested;
                _core.NavigationStarting += (s2, a2) =>
                {
                    string uri = a2.Uri ?? "";
                    if (uri.StartsWith("https://" + Host + "/", StringComparison.OrdinalIgnoreCase)) { _pageNavId = a2.NavigationId; return; }
                    a2.Cancel = true;
                    if (a2.IsUserInitiated && (uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase)))
                        Util.OpenUnelevated(uri, _log);
                };
                _core.NavigationCompleted += (s2, a2) =>
                {
                    if (a2.IsSuccess || _pageReady || a2.NavigationId != _pageNavId || a2.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
                    int http = 0;
                    try { http = a2.HttpStatusCode; } catch (Exception) { }
                    PageFailed(a2.WebErrorStatus + (http != 0 ? ", HTTP " + http : ""));
                };
                _core.NewWindowRequested += (s2, a2) => { a2.Handled = true; };
                _core.WebMessageReceived += OnMessage;
                _core.ProcessFailed += (s2, a2) =>
                {
                    _log.Warn("WebView2-Prozess ausgefallen: " + a2.ProcessFailedKind);
                    if (a2.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited || a2.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                        Try(() => _core.Reload());
                };
                // the start sound follows the app's setting (settings.json "startSound", read only; missing = on)
                bool sound = UserSettings.StartSound(UserSettings.DataDir(), _log);
                _pageWatchdog.Tick += (s2, a2) => { _pageWatchdog.Stop(); if (!_pageReady) PageFailed("keine Meldung nach " + PageReadyTimeoutMs / 1000 + " s"); };
                _pageWatchdog.Start();
                _core.Navigate("https://" + Host + "/index.html?sound=" + (sound ? "1" : "0"));
            }
            catch (Exception ex)
            {
                _webWatchdog.Stop();
                if (_webGaveUp) return;   // the watchdog has already switched to the native window
                _log.Error("WebView2 konnte nicht starten (HRESULT 0x" + ex.HResult.ToString("X8") + ", Datenordner " + (udf ?? "-") + "): " + ex);
                StartFailed = true;
                _allowClose = true;
                Close();
            }
        }

        private void Try(Action a) { try { a(); } catch (Exception ex) { _log.Warn("WebView2: " + ex.Message); } }

        /// <summary>
        /// The installer page did not load (an Edge error page) or never reported "ready": nothing has been done
        /// yet, so the native window (FallbackForm) takes over instead of leaving the user on a broken page.
        /// </summary>
        private void PageFailed(string why)
        {
            _pageWatchdog.Stop();
            if (_pageReady || _webGaveUp || _allowClose) return;
            _webGaveUp = true;
            _log.Error("Setup-Oberfläche nicht geladen (" + why + ") - einfache Ansicht.");
            StartFailed = true;
            _allowClose = true;
            // deferred: this may run inside a WebView2 event, and closing disposes the control
            try { BeginInvoke((Action)Close); } catch (Exception) { Close(); }
        }

        private void OnWebResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            try
            {
                if (_env == null) return;
                EmbeddedSite.Reply r = _site.Resolve(e.Request.Uri, e.Request.Method);
                if (r == null) return;
                // a fresh read-only MemoryStream per response: it stays valid until the runtime has read it
                e.Response = _env.CreateWebResourceResponse(r.Body == null ? null : new MemoryStream(r.Body, false), r.Status, r.Reason, r.Headers);
                if (r.Status != 200 && !(e.Request.Uri ?? "").EndsWith("/favicon.ico", StringComparison.OrdinalIgnoreCase)) _log.Warn("Setup-Oberfläche: " + r.Status + " für " + (e.Request.Uri ?? ""));
            }
            catch (Exception ex) { _log.Warn("Setup-Oberfläche: " + ex.Message); }
        }

        // ------------------------------------------------------------ messages

        private void Post(Dictionary<string, object> msg)
        {
            if (_core == null) return;
            try { _core.PostWebMessageAsJson(_json.Serialize(msg)); } catch (Exception ex) { _log.Warn("PostWebMessage: " + ex.Message); }
        }

        private void PostFromWorker(Dictionary<string, object> msg)
        {
            try { if (!IsDisposed && IsHandleCreated) BeginInvoke((Action)(() => Post(msg))); } catch (Exception) { }
        }

        private static string Str(Dictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : null;
        }

        private static bool Bool(Dictionary<string, object> d, string key, bool def)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v is bool) return (bool)v;
            return def;
        }

        private void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!(e.Source ?? "").StartsWith("https://" + Host + "/", StringComparison.OrdinalIgnoreCase)) return;
            Dictionary<string, object> m;
            try { m = _json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson); } catch (Exception) { return; }
            string type = Str(m, "type");
            switch (type)
            {
                case "ready":
                    if (_webGaveUp) return;
                    _pageReady = true;
                    _pageWatchdog.Stop();
                    SendInit();
                    break;
                case "drag":
                    // the message arrives a few ms after the mousedown: only start the move loop while the button is still down
                    // (physical button state: the click went to the WebView2 window, whose input this thread's
                    // own key state may not have seen - a stale "down" would start a move loop that sticks to the mouse)
                    if (WindowState == FormWindowState.Normal && Win.PrimaryButtonDown()) Win.BeginDrag(Handle);
                    break;
                case "minimize": WindowState = FormWindowState.Minimized; break;
                case "close":
                case "exit":
                    if (!_busy) { _allowClose = true; Close(); }
                    break;
                case "browse": Browse(Str(m, "dir")); break;
                case "checkRunning": CheckRunning(); break;
                case "install": StartInstall(m); break;
                case "uninstall": StartUninstall(m); break;
                case "launch":
                    if (_installedDir != null) Installer.Launch(_installedDir, _quietStart);
                    _allowClose = true;
                    Close();
                    break;
                case "openLog": Util.OpenUnelevated(_log.Path, _log); break;
                case "sound":
                    // M / the sound button in the intro: only for this run (the setup never writes the app's settings)
                    _quietStart = !Bool(m, "on", true);   // ... but a VELOX.exe started from here stays silent too
                    _log.Info("Startton im Setup " + (_quietStart ? "aus" : "an") + ".");
                    break;
            }
        }

        private void SendInit()
        {
            InstalledInfo inf = null;
            try { inf = Installer.Detect(); } catch (Exception) { }
            string mode = _args.Uninstall ? "uninstall" : (inf != null ? "update" : "install");
            string dir = _args.Uninstall ? (Program.ResolveUninstallDir(_args) ?? "") : (inf != null ? inf.Dir : Installer.DefaultDir());
            long req = 0;
            try { req = Installer.RequiredBytes(); } catch (Exception) { }
            Post(new Dictionary<string, object>
            {
                { "type", "init" },
                { "version", Util.Version() },
                { "mode", mode },
                { "installedVersion", inf != null ? inf.Version : "" },
                { "dir", dir },
                { "defaultDir", Installer.DefaultDir() },
                { "sizeMB", Math.Max(1, (int)Math.Ceiling(req / 1048576.0)) },
                { "freeMB", FreeMb(dir) },
                { "running", false }
            });
            // checking for a running VELOX can take a moment (WMI): answer separately
            CheckRunning();
        }

        private static long FreeMb(string dir)
        {
            long free = string.IsNullOrEmpty(dir) ? -1 : Installer.FreeBytes(dir);
            return free < 0 ? -1 : free / 1048576;
        }

        private void CheckRunning()
        {
            string dir = null;
            try
            {
                InstalledInfo inf = Installer.Detect();
                dir = _args.Uninstall ? Program.ResolveUninstallDir(_args) : (inf != null ? inf.Dir : null);
            }
            catch (Exception) { }
            var t = new Thread(() =>
            {
                bool running = false;
                try { running = dir != null && Installer.IsVeloxRunning(dir); } catch (Exception) { }
                PostFromWorker(new Dictionary<string, object> { { "type", "running" }, { "running", running } });
            }) { IsBackground = true };
            t.Start();
        }

        private void Browse(string current)
        {
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.Description = "Wähle den Ordner für VELOX. Es wird ein Unterordner „VELOX“ angelegt.";
                dlg.ShowNewFolderButton = true;
                try
                {
                    string start = current;
                    if (!string.IsNullOrEmpty(start) && string.Equals(Path.GetFileName(start.TrimEnd('\\')), "VELOX", StringComparison.OrdinalIgnoreCase))
                        start = Path.GetDirectoryName(start.TrimEnd('\\'));
                    if (!string.IsNullOrEmpty(start) && Directory.Exists(start)) dlg.SelectedPath = start;
                }
                catch (Exception) { }
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                string error;
                string dir = Installer.NormalizeDir(dlg.SelectedPath, out error);
                Post(new Dictionary<string, object> { { "type", "folder" }, { "dir", dir ?? current ?? "" }, { "error", error ?? "" }, { "freeMB", dir == null ? -1 : FreeMb(dir) } });
            }
        }

        private void StartInstall(Dictionary<string, object> m)
        {
            if (_busy) return;
            _busy = true;
            var o = new InstallOptions
            {
                Dir = Str(m, "dir") ?? Installer.DefaultDir(),
                Desktop = Bool(m, "desktop", true),
                StartMenu = Bool(m, "startMenu", true),
                Launch = Bool(m, "launch", true),
                CloseRunning = Bool(m, "closeRunning", true)
            };
            RunWorker(report => Installer.Install(o, report), () =>
            {
                string error;
                _installedDir = Installer.NormalizeDir(o.Dir, out error);
                bool launched = false;
                if (o.Launch && _installedDir != null) launched = Installer.Launch(_installedDir, _quietStart);
                ExitCode = 0;
                Post(new Dictionary<string, object> { { "type", "done" }, { "mode", "install" }, { "launched", launched } });
            });
        }

        private void StartUninstall(Dictionary<string, object> m)
        {
            if (_busy) return;
            string dir = Program.ResolveUninstallDir(_args);
            if (dir == null)
            {
                Post(new Dictionary<string, object> { { "type", "error" }, { "message", "Es wurde keine VELOX-Installation gefunden." }, { "hint", "Vielleicht wurde VELOX schon entfernt." } });
                return;
            }
            _busy = true;
            bool keep = Bool(m, "keepData", true), close = Bool(m, "closeRunning", true);
            RunWorker(report => Installer.Uninstall(dir, keep, close, report), () =>
            {
                ExitCode = 0;
                Post(new Dictionary<string, object> { { "type", "done" }, { "mode", "uninstall" }, { "launched", false } });
            });
        }

        /// <summary>Runs work on an STA worker thread; progress is throttled to about 30 messages per second.</summary>
        private void RunWorker(Action<ProgressFn> work, Action onSuccess)
        {
            var t = new Thread(() =>
            {
                DateTime last = DateTime.MinValue;
                double lastPct = -1;
                ProgressFn report = (pct, step, file) =>
                {
                    DateTime now = DateTime.UtcNow;
                    if (pct < 100 && (now - last).TotalMilliseconds < 33 && pct - lastPct < 5) return;
                    last = now;
                    lastPct = pct;
                    PostFromWorker(new Dictionary<string, object>
                    {
                        { "type", "progress" }, { "percent", Math.Round(Math.Max(0, Math.Min(100, pct)), 1) }, { "step", step ?? "" }, { "file", file ?? "" }
                    });
                };
                try
                {
                    work(report);
                    BeginInvoke((Action)(() => { _busy = false; onSuccess(); }));
                }
                catch (Exception ex)
                {
                    var ie = ex as InstallException;
                    _log.Error("Fehlgeschlagen: " + ex);
                    string msg = ie != null ? ie.Message : "Etwas ist unerwartet schiefgelaufen.";
                    string hint = ie != null ? ie.Hint : "Versuche es noch einmal. Hilft das nicht, starte den PC neu und probiere es dann erneut.";
                    try
                    {
                        BeginInvoke((Action)(() =>
                        {
                            _busy = false;
                            ExitCode = 1;
                            Post(new Dictionary<string, object> { { "type", "error" }, { "message", msg }, { "hint", hint } });
                        }));
                    }
                    catch (Exception) { }
                }
            }) { IsBackground = true };
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { try { _webWatchdog.Dispose(); } catch (Exception) { } try { _pageWatchdog.Dispose(); } catch (Exception) { } }
            base.Dispose(disposing);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (_busy && e.CloseReason == CloseReason.UserClosing && !_allowClose) { e.Cancel = true; return; }
            base.OnFormClosing(e);
        }
    }
}
