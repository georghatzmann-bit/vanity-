// Start-up helpers shared by HostForm (WebView2 window) and FallbackForm (Edge app window):
// the start timeout and the German texts for start-up phases and start failures.
using System;
using System.Diagnostics;
using System.Windows.Forms;

namespace Velox.Host
{
    /// <summary>
    /// The backend must report ready in time. Not a fixed deadline from process start: every output line
    /// (banner, VELOX_STATUS phase) shows it is still working, so a slow first start after boot or install
    /// (cold PowerShell, the virus scanner reading the fresh files) is not killed while it makes progress.
    /// Fires after <see cref="IdleMs"/> without any output, at the latest after <see cref="MaxMs"/>.
    /// </summary>
    internal sealed class StartTimer : IDisposable
    {
        public const int IdleMs = 60000;
        public const int MaxMs = 180000;

        private readonly Timer _timer = new Timer { Interval = IdleMs };
        private readonly Stopwatch _clock = new Stopwatch();
        private Action _onTimeout;

        public StartTimer(Action onTimeout)
        {
            _onTimeout = onTimeout;
            _timer.Tick += (s, e) => { _timer.Stop(); _clock.Stop(); var h = _onTimeout; if (h != null) h(); };
        }

        public int ElapsedSeconds { get { return (int)Math.Round(_clock.Elapsed.TotalSeconds); } }

        public void Begin()
        {
            _timer.Stop();
            _timer.Interval = IdleMs;
            _clock.Reset();
            _clock.Start();
            _timer.Start();
        }

        /// <summary>The backend wrote something: restart the idle wait (never past MaxMs in total).</summary>
        public void Alive()
        {
            if (!_timer.Enabled) return;
            long left = MaxMs - _clock.ElapsedMilliseconds;
            if (left <= 0) return;
            _timer.Stop();
            _timer.Interval = (int)Math.Max(1000, Math.Min(IdleMs, left));
            _timer.Start();
        }

        public void Stop() { _timer.Stop(); _clock.Stop(); }

        public void Dispose() { _onTimeout = null; try { _timer.Dispose(); } catch (Exception) { } }
    }

    internal static class StartupText
    {
        /// <summary>German text for a VELOX_STATUS phase key; null for unknown keys.</summary>
        public static string Status(string key, bool test)
        {
            switch ((key ?? "").Trim().ToLowerInvariant())
            {
                case "core": return "Bausteine werden geladen …";
                case "system": return "Windows wird geprüft …";
                case "catalog": return "Tweaks werden eingelesen …";
                case "server": return test ? "Testmodus ist gleich bereit …" : "Gleich geht's los …";
            }
            return null;
        }

        /// <summary>
        /// The message when the backend ended before it was ready. PowerShell itself may refuse to run
        /// Velox.ps1 before any of its code runs (execution policy forced by Group Policy, the virus scanner,
        /// Constrained Language Mode); then there is no VELOX_ERROR line, only PowerShell's error on stderr.
        /// </summary>
        public static string EarlyExit(string errors, string tail, int code, string appDir)
        {
            string blocked = Blocked((errors ?? "") + "\n" + (tail ?? ""), appDir);
            if (blocked != null) return blocked;
            if (!string.IsNullOrEmpty(errors)) return errors;
            return "Der VELOX-Motor (PowerShell) hat sich sofort wieder beendet (Code " + code + "). Oft hilft „Erneut versuchen“ oder ein Neustart des PCs. Wenn nicht, schau ins Log.";
        }

        private static bool Has(string text, params string[] needles)
        {
            foreach (string n in needles) if (text.IndexOf(n, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        /// <summary>A simple German explanation when Windows blocked PowerShell; null otherwise.</summary>
        public static string Blocked(string text, string appDir)
        {
            if (string.IsNullOrEmpty(text)) return null;
            if (Has(text, "ScriptContainedMaliciousContent", "malicious content", "schädliche Inhalte", "schädlichen Inhalt", "antivirus software", "Antivirensoftware"))
                return "Dein Virenschutz hat VELOX blockiert. Nimm den Ordner „" + appDir + "“ in deinem Virenschutz als Ausnahme auf und starte VELOX dann noch einmal.";
            if (Has(text, "ConstrainedLanguage", "Constrained Language", "eingeschränkten Sprachmodus"))
                return "Windows lässt PowerShell auf diesem PC nur eingeschränkt laufen (eine Sicherheitsrichtlinie). Damit kann VELOX nicht arbeiten. Ist das ein Firmen- oder Schul-PC, frag dort nach.";
            if (Has(text, "PSSecurityException", "FullyQualifiedErrorId : UnauthorizedAccess", "running scripts is disabled", "Ausführung von Skripts", "is not digitally signed", "nicht digital signiert", "execution policy", "Ausführungsrichtlinie"))
                return "Windows erlaubt auf diesem PC keine PowerShell-Skripte (eine Richtlinie oder dein Virenschutz verbietet es). Ist das ein Firmen- oder Schul-PC, frag dort nach. Sonst nimm den Ordner „" + appDir + "“ in deinem Virenschutz als Ausnahme auf.";
            return null;
        }
    }
}
