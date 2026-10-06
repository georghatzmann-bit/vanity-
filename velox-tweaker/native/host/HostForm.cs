// The VELOX window: WebView2 showing the embedded start screen, then the backend's UI.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Velox.Native;

namespace Velox.Host
{
    /// <summary>WebView2 runtime checks. Must run before any other WebView2 call (SetLoaderDllFolderPath).</summary>
    internal static class WebViewSupport
    {
        private static bool _loaderSet;

        public static void SetLoader(string appDir)
        {
            if (_loaderSet) return;
            _loaderSet = true;
            string dir = Path.Combine(Path.Combine(Path.Combine(appDir, "runtimes"), Util.LoaderArch()), "native");
            if (File.Exists(Path.Combine(dir, "WebView2Loader.dll")))
            {
                try { CoreWebView2Environment.SetLoaderDllFolderPath(dir); }
                catch (Exception ex) { Program.Log.Warn("SetLoaderDllFolderPath: " + ex.Message); }
            }
            else Program.Log.Warn("WebView2Loader.dll fehlt in " + dir);
        }

        public static bool IsAvailable(string appDir, out string why)
        {
            why = null;
            try
            {
                SetLoader(appDir);
                string v = CoreWebView2Environment.GetAvailableBrowserVersionString();
                if (string.IsNullOrEmpty(v)) { why = "keine WebView2-Version gefunden"; return false; }
                Program.Log.Info("WebView2 Runtime " + v);
                return true;
            }
            catch (WebView2RuntimeNotFoundException) { why = "WebView2 Runtime nicht installiert"; return false; }
            catch (Exception ex) { why = ex.GetType().Name + ": " + ex.Message; return false; }
        }
    }

    internal sealed class HostForm : Form
    {
        // A WebView2 runtime that is installed but stuck (half-finished update, leftover msedgewebview2.exe
        // holding the user data folder, a security product hooking it) never completes CreateAsync /
        // EnsureCoreWebView2Async and never throws: without this the user would stare at an empty window.
        private const int WebViewStartTimeoutMs = 30000;
        // the start sequence plays its sound without a click (WebView2 otherwise blocks audio until a gesture)
        private const string AutoplayArgs = "--autoplay-policy=no-user-gesture-required";
        // the browser process of a VELOX that is just closing (or of 1.1.x, started without these arguments)
        // can still own the user data folder: a new environment with other options then fails with this
        private const int ErrorInvalidState = unchecked((int)0x8007139F);
        // hand-over: a broken start screen may delay the app by at most this much after VELOX_READY ...
        private const int HandoverCapMs = 1000;
        // ... a working one by its own announced rest of the intro + this, never more than HandoverMaxMs
        private const int HandoverGraceMs = 250, HandoverMaxMs = 2300;
        // a start screen that has not reported "splash-ready" this long after its navigation began counts as
        // broken (not loaded, or its modules failed): VELOX then goes straight to the app / the Edge window
        private const int SplashReadyTimeoutMs = 12000;

        private readonly Log _log = Program.Log;
        private WebView2 _web;
        private CoreWebView2 _core;
        private Backend _backend;
        private readonly StartTimer _timeout;
        private readonly Timer _webWatchdog = new Timer { Interval = WebViewStartTimeoutMs };
        private bool _webGaveUp;
        private ulong _appNavId;            // NavigationId of the latest navigation to the app
        private string _lastErrorJson;      // shown again whenever the start screen (re)loads
        private string _lastStatusJson;     // latest start-up phase; the start screen may load after it arrived
        private bool _splashReady;
        private bool _onInternal;
        private string _pendingAppUrl;      // backend ready before the web view
        private string _goUrl;              // app URL waiting for the start screen's hand-over
        private readonly Timer _handover = new Timer();
        private readonly Timer _splashWatchdog = new Timer { Interval = SplashReadyTimeoutMs };
        private ulong _splashNavId;         // NavigationId of the latest navigation to the start screen
        private bool _splashBroken;         // the start screen failed to load: never wait for it again
        private DateTime _readyAt;
        private EmbeddedSite _startSite;    // the start screen, served from memory as https://start.velox.example/
        private CoreWebView2Environment _env;
        private string _introVariant;       // full | short for the first load of the start screen
        private int _splashLoads;
        private bool? _soundChoice;         // M / sound button on the start screen (forwarded to the app)
        private string _appOrigin;          // http://127.0.0.1:<port>/
        private string _appOriginAlt;       // http://localhost:<port>/
        private bool _closing;
        private bool _exitNow;
        private bool _failed;
        private bool _restoreMaximized;
        private int _navFailures;

        public bool FallbackRequested { get; private set; }
        public bool IsTest { get; private set; }

        public HostForm(bool test)
        {
            IsTest = test;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Brand.Bg;
            ForeColor = Brand.Text;
            Text = test ? "VELOX – Testmodus" : "VELOX";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
            StartPosition = FormStartPosition.Manual;
            bool max;
            Bounds = WindowPlacement.Initial(out max);
            _restoreMaximized = max;
            UpdateMinimumSize();

            // WebView2 paints this colour until the first page is ready: never a white flash. The env var only
            // counts for the non-elevated Testmodus (the runtime ignores it for elevated hosts); the control
            // property below is what works in every case (applied to the controller when it is created)
            try { Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FF0C0D0F"); } catch (Exception) { }
            _web = new WebView2 { Dock = DockStyle.Fill };
            try { _web.DefaultBackgroundColor = Brand.Bg; } catch (Exception) { }
            Controls.Add(_web);

            _timeout = new StartTimer(OnStartTimeout);
            _webWatchdog.Tick += (s, e) => { _webWatchdog.Stop(); OnWebViewStuck(); };
            _handover.Tick += (s, e) => { _handover.Stop(); Continue("Zeitlimit"); };
            _splashWatchdog.Tick += (s, e) =>
            {
                _splashWatchdog.Stop();
                if (_core != null && _onInternal && !_splashReady && !_closing) OnSplashBroken("keine Meldung nach " + SplashReadyTimeoutMs / 1000 + " s");
            };
        }

        // ------------------------------------------------------------ window chrome

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Win.ApplyDarkFrame(Handle, true, Brand.CaptionBgr);
            try
            {
                if (Program.ActivateMessage != 0)
                    NativeMethods.ChangeWindowMessageFilterEx(Handle, Program.ActivateMessage, NativeMethods.MSGFLT_ALLOW, IntPtr.Zero);
            }
            catch (Exception) { }
            UpdateMinimumSize();
        }

        private void UpdateMinimumSize()
        {
            int dpi = IsHandleCreated ? Win.DpiForWindow(Handle) : Win.DpiForPoint(Left + Width / 2, Top + Height / 2);
            float k = dpi / 96f;
            Rectangle wa = Screen.FromRectangle(Bounds).WorkingArea;
            MinimumSize = new Size(Math.Min((int)(WindowPlacement.MinW * k), wa.Width), Math.Min((int)(WindowPlacement.MinH * k), wa.Height));
        }

        protected override void WndProc(ref Message m)
        {
            if (Program.ActivateMessage != 0 && m.Msg == (int)Program.ActivateMessage)
            {
                long mode = m.WParam.ToInt64();
                if ((mode == 2) == IsTest && !_closing) { Win.BringToFront(Handle); Activate(); }
                return;
            }
            if (m.Msg == NativeMethods.WM_DPICHANGED)
            {
                // the old minimum (in pixels of the old DPI) would veto the smaller suggested rectangle when
                // the window moves to a monitor with less scaling: drop it first, then apply, then recompute
                try { MinimumSize = Size.Empty; } catch (Exception) { }
                Win.ApplySuggestedRect(Handle, m.LParam);
                UpdateMinimumSize();
                m.Result = IntPtr.Zero;
                return;
            }
            base.WndProc(ref m);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (_restoreMaximized) WindowState = FormWindowState.Maximized;
        }

        // ------------------------------------------------------------ start-up

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            StartBackend();
            _webWatchdog.Start();
            _startSite = StartPage.Load(_log);
            if (_startSite == null) { UseFallback(); return; }   // no start screen: the Edge window has its own
            _introVariant = WindowPlacement.TakeIntroVariant(Util.Version());
            // the installer has just played the full intro with its sound: not the same strike twice in a row
            // (the version is recorded above all the same, so the next start is short as well)
            if (Program.FromSetup) _introVariant = "short";
            string udf = null;
            try
            {
                // %LOCALAPPDATA%\Velox\webview2\real|test: a normal folder of the user that the (de-elevated)
                // browser process can write - never a private Admins-only folder (WebViewData)
                udf = WebViewData.ForHost(Program.DataDir, IsTest, _log);
                // An environment's options must match a browser process that still runs on the same user data
                // folder (ERROR_INVALID_STATE otherwise): wait for it a few times, then start without autoplay -
                // the intro then shows "Ton: klicken" instead of failing over to the Edge window.
                string[] attempts = { AutoplayArgs, AutoplayArgs, AutoplayArgs, AutoplayArgs, null };
                for (int i = 0; ; i++)
                {
                    try
                    {
                        var opts = new CoreWebView2EnvironmentOptions();
                        try { opts.Language = "de-DE"; } catch (Exception) { }
                        if (attempts[i] != null) opts.AdditionalBrowserArguments = attempts[i];
                        CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, udf, opts);
                        if (_webGaveUp) return;
                        await _web.EnsureCoreWebView2Async(env);
                        _env = env;
                        if (attempts[i] == null) _log.Warn("WebView2 ohne Autoplay gestartet - der Startton braucht dann einen Klick.");
                        break;
                    }
                    catch (Exception ex)
                    {
                        if (_webGaveUp || _closing) return;
                        if (!IsInvalidState(ex) || i + 1 >= attempts.Length) throw;
                        _log.Warn("WebView2-Profil noch belegt (" + (i + 1) + "): " + ex.Message);
                        RecreateWebControl();
                        await Task.Delay(600);
                        if (_webGaveUp || _closing) return;
                    }
                }
                if (_webGaveUp) return;
                _webWatchdog.Stop();
                _core = _web.CoreWebView2;
                ConfigureCore();
                NavigateSplash();
                if (_pendingAppUrl != null) { string u = _pendingAppUrl; _pendingAppUrl = null; GoToApp(u); }
            }
            catch (Exception ex)
            {
                if (_webGaveUp || _closing) return;   // the watchdog switched to the Edge window already / the user closed VELOX
                _log.Error("WebView2-Start fehlgeschlagen (HRESULT 0x" + ex.HResult.ToString("X8") + ", Datenordner " + (udf ?? "-") + "): " + ex);
                UseFallback();
            }
        }

        private static bool IsInvalidState(Exception ex)
        {
            for (Exception x = ex; x != null; x = x.InnerException) if (x.HResult == ErrorInvalidState) return true;
            return false;
        }

        /// <summary>A WebView2 control whose initialisation failed is not reused: a fresh one for the next attempt.</summary>
        private void RecreateWebControl()
        {
            try { Controls.Remove(_web); _web.Dispose(); } catch (Exception) { }
            _web = new WebView2 { Dock = DockStyle.Fill };
            try { _web.DefaultBackgroundColor = Brand.Bg; } catch (Exception) { }
            Controls.Add(_web);
        }

        private void OnWebViewStuck()
        {
            if (_core != null || _closing || _webGaveUp) return;
            _webGaveUp = true;
            _log.Error("WebView2 hat sich nach " + WebViewStartTimeoutMs / 1000 + " s nicht gemeldet - Edge-App-Fenster wird benutzt.");
            UseFallback();
        }

        /// <summary>WebView2 cannot be used: end this window and its backend; Program starts FallbackHost.</summary>
        private void UseFallback()
        {
            _webWatchdog.Stop();
            _timeout.Stop();
            FallbackRequested = true;
            _exitNow = true;
            if (_backend != null) { _backend.Dispose(); _backend = null; }
            try { Close(); } catch (Exception) { }
        }

        private void ConfigureCore()
        {
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
            Try(() => s.AreDefaultScriptDialogsEnabled = true);
            // the env var WEBVIEW2_DEFAULT_BACKGROUND_COLOR is ignored for elevated hosts: the control property
            // (applied to the controller at creation and here again) is what keeps the window dark
            Try(() => _web.DefaultBackgroundColor = Brand.Bg);
            ServeStartPage();
            _core.NavigationStarting += OnNavigationStarting;
            _core.FrameNavigationStarting += OnFrameNavigationStarting;
            _core.NewWindowRequested += OnNewWindowRequested;
            _core.NavigationCompleted += OnNavigationCompleted;
            _core.WebMessageReceived += OnWebMessage;
            _core.ProcessFailed += OnProcessFailed;
        }

        /// <summary>
        /// https://start.velox.example/* is answered from memory (EmbeddedSite): the browser process never reads
        /// a file of ours. The event fires on the UI thread; the response is set synchronously (no deferral).
        /// </summary>
        private void ServeStartPage()
        {
            try { _core.AddWebResourceRequestedFilter(_startSite.Filter, CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.Document); }
            catch (NotImplementedException)
            {
                // runtime older than ICoreWebView2_22: the original overload (documents only anyway)
                _core.AddWebResourceRequestedFilter(_startSite.Filter, CoreWebView2WebResourceContext.All);
            }
            _core.WebResourceRequested += OnWebResourceRequested;
        }

        private void OnWebResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            try
            {
                if (_startSite == null || _env == null) return;
                EmbeddedSite.Reply r = _startSite.Resolve(e.Request.Uri, e.Request.Method);
                if (r == null) return;
                // a fresh read-only MemoryStream per response: it stays valid until the runtime has read it
                e.Response = _env.CreateWebResourceResponse(r.Body == null ? null : new MemoryStream(r.Body, false), r.Status, r.Reason, r.Headers);
                if (r.Status != 200 && !(e.Request.Uri ?? "").EndsWith("/favicon.ico", StringComparison.OrdinalIgnoreCase)) _log.Warn("Startbildschirm: " + r.Status + " für " + Shorten(e.Request.Uri ?? ""));
            }
            catch (Exception ex) { _log.Warn("Startbildschirm-Anfrage: " + ex.Message); }
        }

        private void Try(Action a)
        {
            try { a(); } catch (Exception ex) { _log.Warn("WebView2-Einstellung nicht verfügbar: " + ex.Message); }
        }

        private void StartBackend()
        {
            if (_backend != null) { _backend.Dispose(); _backend = null; }
            _failed = false;
            _lastErrorJson = null;
            _lastStatusJson = null;
            _navFailures = 0;
            _appOrigin = _appOriginAlt = null;
            var b = new Backend(_log);
            b.Ready += url => UI(() => OnBackendReady(b, url));
            b.AlreadyRunning += url => UI(() => OnBackendReady(b, url));
            b.Exited += code => UI(() => OnBackendExited(b, code));
            b.Output += () => UI(() => { if (b == _backend) _timeout.Alive(); });
            b.Status += key => UI(() => OnBackendStatus(b, key));
            _backend = b;
            _timeout.Begin();
            string err;
            if (!b.Start(Program.AppDir, IsTest, true, out err))
            {
                ShowError("VELOX konnte nicht starten", err ?? "PowerShell ließ sich nicht starten.", b.Tail(40));
                return;
            }
        }

        private void OnBackendStatus(Backend b, string key)
        {
            if (b != _backend || _closing || _failed) return;
            string text = StartupText.Status(key, IsTest);
            if (text == null) return;
            _lastStatusJson = Json(new Dictionary<string, object> { { "type", "status" }, { "text", text } });
            PostToSplash(_lastStatusJson);
        }

        private void UI(Action a)
        {
            try { if (!IsDisposed && IsHandleCreated) BeginInvoke(a); } catch (Exception) { }
        }

        private void OnBackendReady(Backend b, string url)
        {
            if (b != _backend || _closing) return;
            _timeout.Stop();
            _appOrigin = b.Origin;
            Uri u = new Uri(b.Origin);
            _appOriginAlt = "http://" + (u.Host == "localhost" ? "127.0.0.1" : "localhost") + ":" + u.Port + "/";
            if (!b.OwnsServer) _log.Info("Ein anderes VELOX-Backend läuft schon - verbinde mit " + b.Origin);
            if (_core == null) { _pendingAppUrl = b.Url; return; }
            GoToApp(b.Url);
        }

        /// <summary>
        /// Backend ready: the start screen plays its hand-over (intro.done()) and answers "continue"; then the app
        /// is loaded. A start screen that does not answer costs at most HandoverCapMs (see the constants).
        /// </summary>
        private void GoToApp(string url)
        {
            _goUrl = url;
            _readyAt = DateTime.UtcNow;
            _handover.Stop();
            if (_splashBroken && _onInternal) { Continue("Startbildschirm nicht verfügbar"); return; }
            if (!_splashReady || !_onInternal) { _handover.Interval = HandoverCapMs; _handover.Start(); return; }   // "ready" goes out on splash-ready
            PostToSplash("{\"type\":\"ready\"}");
            _handover.Interval = HandoverCapMs;
            _handover.Start();
        }

        /// <summary>The start screen announced how long its hand-over still takes.</summary>
        private void OnHandoverAnnounced(object ms)
        {
            if (_goUrl == null || !_handover.Enabled) return;
            double want;
            try { want = Convert.ToDouble(ms, System.Globalization.CultureInfo.InvariantCulture); } catch (Exception) { return; }
            if (double.IsNaN(want) || want < 0) return;
            double spent = (DateTime.UtcNow - _readyAt).TotalMilliseconds;
            double left = Math.Min(want + HandoverGraceMs, HandoverMaxMs) - spent;
            _handover.Stop();
            _handover.Interval = (int)Math.Max(1, Math.Max(left, HandoverCapMs - spent));
            _handover.Start();
        }

        private void Continue(string why)
        {
            _handover.Stop();
            _splashWatchdog.Stop();
            string url = _goUrl;
            _goUrl = null;
            if (url == null || _closing || _failed || _core == null) return;
            if (why != null) _log.Info("Übergabe an die Oberfläche: " + why + " nach " + (int)(DateTime.UtcNow - _readyAt).TotalMilliseconds + " ms");
            try { _core.Navigate(AppUrl(url)); } catch (Exception ex) { _log.Error("Navigate: " + ex.Message); }
        }

        /// <summary>
        /// The app URL plus from=host (the in-app splash only shows the end pose) and the start sound the user
        /// chose on the start screen, if any - the app saves it as settings.json "startSound" (ARCHITECTURE §11).
        /// </summary>
        private string AppUrl(string url)
        {
            string sep = url.IndexOf('?') >= 0 ? "&" : "?";
            string extra = "from=host";
            if (_soundChoice.HasValue) extra += "&sound=" + (_soundChoice.Value ? "on" : "off");
            int hash = url.IndexOf('#');
            return hash >= 0 ? url.Substring(0, hash) + sep + extra + url.Substring(hash) : url + sep + extra;
        }

        private void OnBackendExited(Backend b, int code)
        {
            if (b != _backend || _closing) return;
            _timeout.Stop();
            if (!b.OwnsServer && !string.IsNullOrEmpty(b.Origin)) return; // only connected to another instance's server
            if (string.IsNullOrEmpty(b.Origin))
                ShowError("VELOX konnte nicht starten", StartupText.EarlyExit(b.Errors(), b.Tail(80), code, Program.AppDir), b.Tail(40));
            else
                ShowError("VELOX wurde unerwartet beendet", "Der VELOX-Motor im Hintergrund läuft nicht mehr (Code " + code + "). Deine Änderungen sind gesichert – starte ihn einfach neu.", b.Tail(40));
        }

        private void OnStartTimeout()
        {
            if (_closing || _backend == null || !string.IsNullOrEmpty(_backend.Origin)) return;
            int secs = _timeout.ElapsedSeconds;
            _log.Warn("Backend nicht rechtzeitig bereit (" + secs + " s).");
            string tail = _backend.Tail(40);
            _backend.Dispose();
            _backend = null;
            ShowError("VELOX startet nicht", "Der VELOX-Motor hat sich nach " + secs + " Sekunden noch nicht gemeldet. Oft hilft ein zweiter Versuch oder ein Neustart des PCs. Wenn nicht, schau ins Log.", tail);
        }

        // ------------------------------------------------------------ start screen (embedded page)

        private void NavigateSplash()
        {
            if (_core == null) return;
            _splashReady = false;
            _onInternal = true;
            // the first load plays the intro (full after an install / update); a later one (an error after the
            // app was shown) is the still end pose: no second intro, no sound
            string variant = _splashLoads++ == 0 ? (_introVariant ?? "short") : "still";
            // muted in the installer a moment ago (--quiet-start): silent for this run, settings.json stays as it is
            bool sound = _soundChoice ?? (!Program.QuietStart && UserSettings.StartSound(Program.DataDir, _log));
            _splashWatchdog.Stop();
            _splashWatchdog.Start();
            try { _core.Navigate(StartPage.Url(variant, sound, IsTest)); }
            catch (Exception ex) { _log.Error("Startbildschirm: " + ex.Message); OnSplashBroken("Navigate: " + ex.Message); }
            // mode and a pending error are sent when the page reports "splash-ready"
        }

        /// <summary>
        /// The start screen did not load or never reported in. VELOX does not wait for it any more: the app is
        /// loaded as soon as the backend is ready, and an error it cannot show goes to the Edge app window.
        /// </summary>
        private void OnSplashBroken(string why)
        {
            _splashWatchdog.Stop();
            if (_closing) return;
            if (!_splashBroken) _log.Error("Startbildschirm nicht geladen (" + why + ") - VELOX öffnet die Oberfläche direkt.");
            _splashBroken = true;
            _splashReady = false;
            // deferred: this may run inside a WebView2 event, and the fallback disposes the control
            if (_failed) { UI(() => { if (!_closing && !_exitNow) UseFallback(); }); return; }
            if (_goUrl != null) Continue("Startbildschirm nicht verfügbar");
        }

        /// <summary>Sends a message to the start screen if it is showing and listening; otherwise drops it.</summary>
        private void PostToSplash(string json)
        {
            if (_core == null || !_splashReady || !_onInternal) return;
            try { _core.PostWebMessageAsJson(json); } catch (Exception ex) { _log.Warn("PostWebMessage: " + ex.Message); }
        }

        private void OnSplashReady()
        {
            _splashWatchdog.Stop();
            _splashReady = true;
            PostToSplash(Json(new Dictionary<string, object> { { "type", "mode" }, { "test", IsTest } }));
            if (_failed && _lastErrorJson != null) PostToSplash(_lastErrorJson);
            else if (!_failed && _lastStatusJson != null && _backend != null && string.IsNullOrEmpty(_backend.Origin)) PostToSplash(_lastStatusJson);
            if (!_failed && _goUrl != null) PostToSplash("{\"type\":\"ready\"}");   // the backend was faster than the page
        }

        private void ShowError(string title, string message, string log)
        {
            if (_closing) return;
            _failed = true;
            _timeout.Stop();
            _handover.Stop();
            _goUrl = null;
            _log.Warn(title + ": " + message);
            _lastErrorJson = Json(new Dictionary<string, object> {
                { "type", "error" }, { "title", title }, { "message", message }, { "log", log ?? "" }, { "canTest", !IsTest }
            });
            if (_core == null) return;                 // the start screen shows it once it is loaded
            if (_splashBroken)
            {
                // the start screen cannot show it: the Edge app window (FallbackHost) starts over and reports itself
                _log.Error("Startbildschirm nicht verfügbar - Fehler wird im Edge-App-Fenster gezeigt.");
                UI(() => { if (!_closing && !_exitNow) UseFallback(); });   // may run inside a WebView2 event
                return;
            }
            if (!_onInternal) { NavigateSplash(); return; }
            PostToSplash(_lastErrorJson);
        }

        private static string Json(Dictionary<string, object> d) { return new JavaScriptSerializer().Serialize(d); }

        // ------------------------------------------------------------ navigation policy

        private bool IsAppUri(string uri)
        {
            if (string.IsNullOrEmpty(uri)) return false;
            return (_appOrigin != null && uri.StartsWith(_appOrigin, StringComparison.OrdinalIgnoreCase))
                || (_appOriginAlt != null && uri.StartsWith(_appOriginAlt, StringComparison.OrdinalIgnoreCase));
        }

        private static bool IsWebUri(string uri)
        {
            return uri != null && (uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase));
        }

        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            string uri = e.Uri ?? "";
            if (StartPage.IsStartUri(uri)) { _onInternal = true; _splashReady = false; _splashNavId = e.NavigationId; return; }
            if (IsAppUri(uri)) { _onInternal = false; _splashReady = false; _appNavId = e.NavigationId; return; }
            e.Cancel = true;
            if (IsWebUri(uri) && e.IsUserInitiated) Util.OpenUnelevated(uri, _log);
            else _log.Warn("Navigation blockiert: " + Shorten(uri));
        }

        private void OnFrameNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            string uri = e.Uri ?? "";
            if (IsAppUri(uri) || StartPage.IsStartUri(uri) || uri == "about:blank" || uri.StartsWith("about:srcdoc", StringComparison.OrdinalIgnoreCase)) return;
            e.Cancel = true;
            _log.Warn("Frame-Navigation blockiert: " + Shorten(uri));
        }

        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;   // never a second browser window inside the app
            string uri = e.Uri ?? "";
            if (IsWebUri(uri) && !IsAppUri(uri)) Util.OpenUnelevated(uri, _log);
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess && _onInternal && e.NavigationId == _splashNavId && e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
            {
                // the start screen itself did not load (an Edge error page instead): never leave the user there
                int http = 0;
                try { http = e.HttpStatusCode; } catch (Exception) { }
                OnSplashBroken(e.WebErrorStatus + (http != 0 ? ", HTTP " + http : ""));
                return;
            }
            if (_onInternal || e.IsSuccess) { if (!_onInternal) _navFailures = 0; return; }
            // Only a failed load of the app counts. Not: the start screen replaced by the app before it finished,
            // a navigation this host cancelled (a file dropped onto the window, a blocked link) - both end with
            // OperationCanceled - or any older navigation that a newer one replaced.
            if (e.NavigationId != _appNavId || e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
            _navFailures++;
            _log.Warn("Seite nicht geladen: " + e.WebErrorStatus);
            if (_closing || _backend == null) return;
            if (_navFailures <= 3 && !_backend.HasExited)
            {
                var t = new Timer { Interval = 700 * _navFailures };
                t.Tick += (s, a) => { t.Stop(); t.Dispose(); if (!_closing && _backend != null && _backend.Url != null) try { _core.Navigate(_backend.Url); } catch (Exception) { } };
                t.Start();
            }
            else ShowError("VELOX ist nicht erreichbar", "Die Oberfläche konnte den VELOX-Motor nicht erreichen (" + e.WebErrorStatus + ").", _backend.Tail(40));
        }

        private void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            _log.Warn("WebView2-Prozess ausgefallen: " + e.ProcessFailedKind);
            if (_closing) return;
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
            {
                // the web view is gone for good: start over in a fresh window process
                DarkDialog.Show(this, "Anzeige abgestürzt", "Die Anzeige von VELOX ist abgestürzt. VELOX wird neu gestartet.", null, new[] { "OK" }, 0, false);
                Restart();
                return;
            }
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited || e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
            {
                try { _core.Reload(); } catch (Exception) { }
            }
        }

        private void Restart()
        {
            _closing = true;
            try { if (_backend != null) _backend.Dispose(); } catch (Exception) { }
            try
            {
                Program.ReleaseMutex();
                string args = IsTest ? "--test" : "--elevated";
                using (System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Application.ExecutablePath, args) { UseShellExecute = false })) { }
            }
            catch (Exception ex) { _log.Error("Neustart fehlgeschlagen: " + ex.Message); }
            _exitNow = true;
            Close();
        }

        // ------------------------------------------------------------ messages from the start screen

        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            // only the embedded start screen talks to the host, never the backend's pages
            string src = e.Source ?? "";
            if (!_onInternal || !StartPage.IsStartUri(src)) return;
            string type = null;
            Dictionary<string, object> d;
            try
            {
                d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
                object t;
                if (d != null && d.TryGetValue("type", out t)) type = t as string;
            }
            catch (Exception) { return; }
            switch (type)
            {
                case "splash-ready":
                    OnSplashReady();
                    break;
                case "retry":
                    PostToSplash("{\"type\":\"starting\",\"text\":\"VELOX wird neu gestartet …\"}");
                    StartBackend();
                    break;
                case "test":
                    SwitchToTest();
                    break;
                case "openlog":
                    string logs = Path.GetDirectoryName(_log.Path);
                    Util.OpenUnelevated(File.Exists(_log.Path) ? _log.Path : logs, _log);
                    break;
                case "sound":
                    object on;
                    if (d.TryGetValue("on", out on) && on is bool) { _soundChoice = (bool)on; _log.Info("Startton " + ((bool)on ? "an" : "aus") + " (wird an die Oberfläche weitergegeben)."); }
                    break;
                case "handover":
                    object ms;
                    if (d.TryGetValue("ms", out ms)) OnHandoverAnnounced(ms);
                    break;
                case "continue":
                    Continue(null);
                    break;
            }
        }

        private void SwitchToTest()
        {
            if (IsTest) return;
            if (_backend != null) { _backend.Dispose(); _backend = null; }
            Program.ReleaseMutex();
            if (!Program.AcquireMutex(true))
            {
                Program.ActivateOther(true);
                _exitNow = true;
                Close();
                return;
            }
            IsTest = true;
            Text = "VELOX – Testmodus";
            _log.Info("Wechsel in den Testmodus.");
            PostToSplash(Json(new Dictionary<string, object> { { "type", "mode" }, { "test", true } }));
            PostToSplash("{\"type\":\"starting\",\"text\":\"Testmodus wird gestartet …\"}");
            StartBackend();
        }

        // ------------------------------------------------------------ closing

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (_exitNow) { base.OnFormClosing(e); return; }
            if (e.CloseReason == CloseReason.WindowsShutDown || e.CloseReason == CloseReason.TaskManagerClosing)
            {
                WindowPlacement.Save(this);
                _closing = true;
                if (_backend != null) { _backend.RequestShutdown(); _backend.Dispose(); _backend = null; }
                base.OnFormClosing(e);
                return;
            }
            e.Cancel = true;
            if (_closing) return;
            _closing = true;
            BeginClose();
        }

        private async void BeginClose()
        {
            try
            {
                Backend b = _backend;
                bool busy = false;
                if (b != null && b.OwnsServer && !string.IsNullOrEmpty(b.Origin)) busy = await Task.Run(() => b.IsBusy());
                if (busy)
                {
                    int r = DarkDialog.Show(this, "VELOX ändert gerade etwas",
                        "Eine Aufgabe läuft noch. Am besten wartest du, bis sie fertig ist.\n\nWenn du jetzt beendest, wird sie abgebrochen. Was schon geändert wurde, kannst du später unter „Sicherungen“ zurückspielen.",
                        null, new[] { "Trotzdem beenden", "Weiter warten" }, 1, false);
                    if (r != 0) { _closing = false; return; }
                }
                WindowPlacement.Save(this);
                Hide();
                // the page goes first: its heartbeat would otherwise cancel the shutdown request
                try { if (_web != null) { _web.Dispose(); _web = null; _core = null; } } catch (Exception) { }
                if (b != null)
                {
                    await Task.Run(() =>
                    {
                        b.RequestShutdown();
                        // nothing is running (checked above) and the window is gone. The backend keeps a 4 s grace
                        // period for page reloads, so after 3 s the job object ends it together with everything it
                        // started - safe, because every change is saved the moment it is made.
                        if (!b.WaitForExit(3000)) _log.Info("Backend wird über das Job-Objekt beendet.");
                        b.Dispose();
                    });
                }
            }
            catch (Exception ex) { _log.Error("Beenden: " + ex.Message); }
            _backend = null;
            _exitNow = true;
            Close();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                try { _timeout.Dispose(); } catch (Exception) { }
                try { _webWatchdog.Dispose(); } catch (Exception) { }
                try { _handover.Dispose(); } catch (Exception) { }
                try { _splashWatchdog.Dispose(); } catch (Exception) { }
                try { if (_web != null) { _web.Dispose(); _web = null; } } catch (Exception) { }
                try { if (_backend != null) _backend.Dispose(); } catch (Exception) { }
            }
            base.Dispose(disposing);
        }

        private static string Shorten(string s) { return s.Length > 120 ? s.Substring(0, 120) + "…" : s; }
    }
}
