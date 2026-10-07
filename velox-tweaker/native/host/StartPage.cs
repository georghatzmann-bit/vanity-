// The start screen's files (native/host/start/: splash.html/.css/.js + brand/ copies) are embedded in VELOX.exe
// as resources "start/<path>" and served FROM MEMORY as https://start.velox.example/ through WebView2's
// WebResourceRequested event (EmbeddedSite; HostForm glues it to the WebView). Nothing is written to disk:
// the WebView2 browser process does not get our administrator rights, so it could not read a private
// Admins-only folder (1.2.0: ERR_FILE_NOT_FOUND), and a folder it could read could be swapped by anyone.
// ES modules need a real origin: NavigateToString (an opaque data: origin) cannot load brand/intro.js.
using System;
using System.IO;
using Velox.Native;

namespace Velox.Host
{
    internal static class StartPage
    {
        public const string HostName = "start.velox.example";
        public const string Origin = "https://" + HostName + "/";
        private const string Prefix = "start/";
        // 1.2.0 extracted the start screen into %TEMP%\VeloxStart-<random>; leftovers of a killed run are removed
        private const string OldTempPrefix = "VeloxStart-";

        /// <summary>The embedded start screen; null if it is missing from VELOX.exe (the caller uses the Edge fallback).</summary>
        public static EmbeddedSite Load(Log log)
        {
            try
            {
                CleanupOldFolders(log);
                var site = new EmbeddedSite(HostName, typeof(StartPage).Assembly, Prefix);
                if (!site.Has("splash.html") || !site.Has("splash.js") || !site.Has("brand/intro.js"))
                    throw new FileNotFoundException("Startbildschirm fehlt in VELOX.exe (" + site.Count + " Dateien).");
                return site;
            }
            catch (Exception ex)
            {
                if (log != null) log.Error("Startbildschirm nicht verfügbar: " + ex.Message);
                return null;
            }
        }

        /// <summary>The start-screen URL for one load (variant long | short | still, see HostForm.StartVariant).</summary>
        public static string Url(string variant, bool sound, bool test)
        {
            return Origin + "splash.html?v=" + Uri.EscapeDataString(Util.Version()) + "&variant=" + variant
                + "&sound=" + (sound ? "1" : "0") + "&test=" + (test ? "1" : "0");
        }

        public static bool IsStartUri(string uri)
        {
            return uri != null && uri.StartsWith(Origin, StringComparison.OrdinalIgnoreCase);
        }

        private static void CleanupOldFolders(Log log)
        {
            try
            {
                foreach (string d in Directory.GetDirectories(Path.GetTempPath(), OldTempPrefix + "*"))
                {
                    try { if (Directory.GetLastWriteTimeUtc(d) < DateTime.UtcNow.AddHours(-12)) Util.DeleteTree(d, false); }
                    catch (Exception) { }
                }
            }
            catch (Exception ex) { if (log != null) log.Warn("Alte Startbildschirm-Ordner: " + ex.Message); }
        }
    }
}
