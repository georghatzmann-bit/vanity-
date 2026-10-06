// Starts and supervises the PowerShell backend (Velox.ps1) for VELOX.exe.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using Velox.Native;

namespace Velox.Host
{
    /// <summary>A Windows job object with KILL_ON_JOB_CLOSE: everything in it dies with this process.</summary>
    internal sealed class JobObject : IDisposable
    {
        private IntPtr _handle;

        public JobObject(Log log)
        {
            try
            {
                _handle = NativeMethods.CreateJobObject(IntPtr.Zero, null);
                if (_handle == IntPtr.Zero) { log.Warn("CreateJobObject fehlgeschlagen: " + System.Runtime.InteropServices.Marshal.GetLastWin32Error()); return; }
                var info = new NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = NativeMethods.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                uint size = (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                if (!NativeMethods.SetInformationJobObject(_handle, NativeMethods.JobObjectExtendedLimitInformation, ref info, size))
                    log.Warn("SetInformationJobObject fehlgeschlagen: " + System.Runtime.InteropServices.Marshal.GetLastWin32Error());
            }
            catch (Exception ex) { log.Warn("Job-Objekt nicht verfügbar: " + ex.Message); _handle = IntPtr.Zero; }
        }

        public bool Assign(Process p, Log log)
        {
            if (_handle == IntPtr.Zero || p == null) return false;
            try
            {
                if (NativeMethods.AssignProcessToJobObject(_handle, p.Handle)) return true;
                log.Warn("AssignProcessToJobObject fehlgeschlagen: " + System.Runtime.InteropServices.Marshal.GetLastWin32Error());
            }
            catch (Exception ex) { log.Warn("AssignProcessToJobObject: " + ex.Message); }
            return false;
        }

        public void Terminate()
        {
            if (_handle == IntPtr.Zero) return;
            try { NativeMethods.TerminateJobObject(_handle, 1); } catch (Exception) { }
        }

        public void Dispose()
        {
            if (_handle == IntPtr.Zero) return;
            try { NativeMethods.CloseHandle(_handle); } catch (Exception) { }   // KILL_ON_JOB_CLOSE ends what is left
            _handle = IntPtr.Zero;
        }
    }

    /// <summary>
    /// One run of Velox.ps1. Events fire on thread-pool threads; the form marshals them.
    /// Protocol on stdout (one line each): VELOX_READY &lt;url&gt; | VELOX_RUNNING &lt;url&gt; | VELOX_ERROR &lt;text&gt;
    /// | VELOX_STATUS &lt;key&gt; (start-up phase: core, system, catalog, server).
    /// </summary>
    internal sealed class Backend : IDisposable
    {
        private readonly Log _log;
        private readonly object _lock = new object();
        private readonly Queue<string> _tail = new Queue<string>();
        private readonly List<string> _errors = new List<string>();
        private Process _proc;
        private JobObject _job;
        private bool _disposed;
        private bool _readySeen;

        public event Action<string> Ready;           // app url (own backend)
        public event Action<string> AlreadyRunning;  // app url of another running backend
        public event Action<int> Exited;             // exit code (-1 unknown)
        public event Action<string> Status;          // start-up phase key (VELOX_STATUS)
        public event Action Output;                  // any line on stdout/stderr: the backend is alive

        public string Url { get; private set; }
        public string Origin { get; private set; }   // http://127.0.0.1:<port>/
        public string Token { get; private set; }
        public bool Simulate { get; private set; }
        public int ProcessId { get; private set; }
        public bool OwnsServer { get; private set; }

        public Backend(Log log) { _log = log; }

        public static string PowerShellPath()
        {
            string win = Util.WindowsDir();
            // a 32-bit process on 64-bit Windows would get the 32-bit PowerShell through System32
            if (!Environment.Is64BitProcess && Environment.Is64BitOperatingSystem)
            {
                string sysnative = Path.Combine(Path.Combine(Path.Combine(win, "Sysnative"), "WindowsPowerShell"), "v1.0");
                string p = Path.Combine(sysnative, "powershell.exe");
                if (File.Exists(p)) return p;
            }
            return Path.Combine(Path.Combine(Path.Combine(Environment.SystemDirectory, "WindowsPowerShell"), "v1.0"), "powershell.exe");
        }

        public bool Start(string appDir, bool simulate, bool noBrowser, out string error)
        {
            error = null;
            Simulate = simulate;
            string ps = PowerShellPath();
            if (!File.Exists(ps)) { error = "Windows PowerShell wurde nicht gefunden: " + ps; return false; }
            string script = Path.Combine(appDir, "Velox.ps1");
            var args = new StringBuilder();
            args.Append("-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ").Append(Util.QuoteArg(script));
            if (noBrowser) args.Append(" -NoBrowser");
            args.Append(" -Port 0 -HostPid ").Append(Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture));
            if (simulate) args.Append(" -Simulate");

            Encoding oem = ConsoleEncoding();
            var psi = new ProcessStartInfo(ps, args.ToString())
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
                StandardOutputEncoding = oem,
                StandardErrorEncoding = oem,
                WorkingDirectory = appDir
            };
            // a PowerShell 7 module path in the environment breaks module loading in Windows PowerShell 5.1
            try { psi.EnvironmentVariables.Remove("PSModulePath"); } catch (Exception) { }
            try { psi.EnvironmentVariables.Remove("VELOX_DATA_DIR"); } catch (Exception) { }

            _job = new JobObject(_log);
            try
            {
                var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
                p.OutputDataReceived += (s, e) => OnLine(e.Data, false);
                p.ErrorDataReceived += (s, e) => OnLine(e.Data, true);
                p.Exited += OnExited;
                _log.Info("Starte Backend: \"" + ps + "\" " + args);
                if (!p.Start()) { error = "PowerShell ließ sich nicht starten."; return false; }
                _proc = p;
                ProcessId = p.Id;
                _job.Assign(p, _log);
                try { p.StandardInput.Close(); } catch (Exception) { }   // a stray Read-Host gets EOF instead of hanging
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                return true;
            }
            catch (Exception ex)
            {
                error = "PowerShell ließ sich nicht starten: " + ex.Message;
                _log.Error(error);
                return false;
            }
        }

        /// <summary>
        /// What Windows PowerShell 5.1 writes redirected output in: [Console]::OutputEncoding, i.e. the console code
        /// page of its (hidden) console, which starts as the system's OEM code page - GetOEMCP(), not the user
        /// culture's OEMCodePage (they differ with another display language, or 65001 with the "Beta: UTF-8" option).
        /// </summary>
        internal static Encoding ConsoleEncoding()
        {
            try
            {
                int cp = (int)NativeMethods.GetOEMCP();
                if (cp > 0) return Encoding.GetEncoding(cp);
            }
            catch (Exception) { }
            try { return Encoding.GetEncoding(CultureInfo.CurrentCulture.TextInfo.OEMCodePage); } catch (Exception) { return Encoding.Default; }
        }

        private void OnLine(string line, bool isErr)
        {
            if (line == null) return;
            var o = Output;
            if (o != null && !_disposed && !_readySeen) { try { o(); } catch (Exception) { } }
            lock (_lock)
            {
                _tail.Enqueue((isErr ? "! " : "") + line);
                while (_tail.Count > 400) _tail.Dequeue();
            }
            _log.Write(isErr ? "backend-err" : "backend", line);
            string t = line.Trim();
            if (t.StartsWith("VELOX_READY ", StringComparison.Ordinal))
            {
                string url = t.Substring(12).Trim();
                if (Accept(url) && !_readySeen) { _readySeen = true; OwnsServer = true; var h = Ready; if (h != null) h(url); }
            }
            else if (t.StartsWith("VELOX_RUNNING ", StringComparison.Ordinal))
            {
                string url = t.Substring(14).Trim();
                if (Accept(url) && !_readySeen) { _readySeen = true; OwnsServer = false; var h = AlreadyRunning; if (h != null) h(url); }
            }
            else if (t.StartsWith("VELOX_ERROR ", StringComparison.Ordinal))
            {
                lock (_lock) { _errors.Add(t.Substring(12).Trim()); }
            }
            else if (t.StartsWith("VELOX_STATUS ", StringComparison.Ordinal) && !_readySeen)
            {
                var h = Status;
                if (h != null && !_disposed) h(t.Substring(13).Trim());
            }
        }

        /// <summary>Only http://127.0.0.1:&lt;port&gt;/ or http://localhost:&lt;port&gt;/ with a token is accepted.</summary>
        private bool Accept(string url)
        {
            Uri u;
            if (!Uri.TryCreate(url, UriKind.Absolute, out u)) return false;
            if (u.Scheme != Uri.UriSchemeHttp) return false;
            if (u.Host != "127.0.0.1" && u.Host != "localhost") return false;
            if (u.Port <= 0 || u.IsDefaultPort) return false;
            var m = Regex.Match(u.Query ?? "", @"[?&]t=([0-9A-Za-z]+)");
            if (!m.Success) return false;
            Url = u.AbsoluteUri;
            Origin = u.Scheme + "://" + u.Host + ":" + u.Port.ToString(CultureInfo.InvariantCulture) + "/";
            Token = m.Groups[1].Value;
            return true;
        }

        private void OnExited(object sender, EventArgs e)
        {
            int code = -1;
            try { code = _proc.ExitCode; } catch (Exception) { }
            _log.Info("Backend beendet (Code " + code + ").");
            var h = Exited;
            if (h != null && !_disposed) h(code);
        }

        public bool HasExited
        {
            get { try { return _proc == null || _proc.HasExited; } catch (Exception) { return true; } }
        }

        public string Tail(int lines)
        {
            lock (_lock)
            {
                var all = _tail.ToArray();
                int start = Math.Max(0, all.Length - lines);
                var sb = new StringBuilder();
                for (int i = start; i < all.Length; i++) sb.AppendLine(all[i]);
                return sb.ToString().TrimEnd();
            }
        }

        public string Errors()
        {
            lock (_lock) { return string.Join("\n", _errors.ToArray()); }
        }

        /// <summary>true when the backend reports a running job (a change in progress). Never throws.</summary>
        public bool IsBusy()
        {
            if (string.IsNullOrEmpty(Origin) || HasExited) return false;
            try
            {
                // POST /api/heartbeat answers { ok, busy } at once; /api/bootstrap would build the whole catalog
                var req = (HttpWebRequest)WebRequest.Create(Origin + "api/heartbeat");
                req.Method = "POST";
                req.Timeout = 3000;
                req.ReadWriteTimeout = 3000;
                req.Proxy = null;
                req.ContentLength = 0;
                req.Headers["X-Velox-Token"] = Token;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var rd = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    string body = rd.ReadToEnd();
                    return Regex.IsMatch(body, "\"busy\"\\s*:\\s*true");
                }
            }
            catch (Exception ex) { _log.Warn("Busy-Abfrage fehlgeschlagen: " + ex.Message); return false; }
        }

        /// <summary>POST /api/shutdown?t=&lt;token&gt; - the backend ends after its grace period (and after a running job).</summary>
        public void RequestShutdown()
        {
            if (string.IsNullOrEmpty(Origin) || HasExited || !OwnsServer) return;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(Origin + "api/shutdown?t=" + Uri.EscapeDataString(Token));
                req.Method = "POST";
                req.Timeout = 2000;
                req.ReadWriteTimeout = 2000;
                req.Proxy = null;
                req.ContentLength = 0;
                using (var resp = (HttpWebResponse)req.GetResponse()) { }
                _log.Info("Backend um Beenden gebeten.");
            }
            catch (Exception ex) { _log.Warn("Shutdown-Anfrage fehlgeschlagen: " + ex.Message); }
        }

        public bool WaitForExit(int ms)
        {
            try { return _proc == null || _proc.WaitForExit(ms); } catch (Exception) { return true; }
        }

        /// <summary>Ends the backend and everything it started (job object), even if it is still busy.</summary>
        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try
            {
                if (_proc != null && !_proc.HasExited)
                {
                    _log.Info("Backend wird beendet (Job-Objekt).");
                    if (_job != null) _job.Terminate();
                    try { if (!_proc.WaitForExit(1500)) _proc.Kill(); } catch (Exception) { }
                }
            }
            catch (Exception) { }
            try { if (_job != null) _job.Dispose(); } catch (Exception) { }
            try { if (_proc != null) _proc.Dispose(); } catch (Exception) { }
            _job = null;
            _proc = null;
        }
    }
}
