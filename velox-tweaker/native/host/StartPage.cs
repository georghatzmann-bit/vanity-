// The start screen's files (native/host/start/: splash.html/.css/.js + brand/ copies) are embedded in VELOX.exe
// as resources "start/<path>". At start-up they are written to a fresh private temp folder (only the current
// user - or Administrators and SYSTEM when elevated - may write there, so nobody can swap a file the
// elevated window loads) and served with SetVirtualHostNameToFolderMapping as https://start.velox.example/.
// ES modules need a real origin: NavigateToString (an opaque data: origin) cannot load brand/intro.js.
using System;
using System.IO;
using System.Reflection;
using Velox.Native;

namespace Velox.Host
{
    internal static class StartPage
    {
        public const string HostName = "start.velox.example";
        public const string Origin = "https://" + HostName + "/";
        private const string Prefix = "start/";
        private const string TempPrefix = "VeloxStart-";

        /// <summary>Writes the embedded start screen into a new private folder; null if that is impossible.</summary>
        public static string Extract(Log log)
        {
            string dir = null;
            try
            {
                CleanupStale(log);
                dir = Util.CreatePrivateTempDir(TempPrefix);
                Assembly asm = typeof(StartPage).Assembly;
                int n = 0;
                foreach (string name in asm.GetManifestResourceNames())
                {
                    if (!name.StartsWith(Prefix, StringComparison.Ordinal)) continue;
                    string rel = name.Substring(Prefix.Length);
                    if (rel.Length == 0 || rel.Contains("..") || rel.Contains(":") || rel.StartsWith("/", StringComparison.Ordinal) || rel.Contains("\\")) continue;
                    string path = Path.Combine(dir, rel.Replace('/', Path.DirectorySeparatorChar));
                    string sub = Path.GetDirectoryName(path);
                    if (!string.IsNullOrEmpty(sub)) Directory.CreateDirectory(sub);
                    using (Stream s = asm.GetManifestResourceStream(name))
                    using (var f = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                        s.CopyTo(f);
                    n++;
                }
                if (!File.Exists(Path.Combine(dir, "splash.html")) || !File.Exists(Path.Combine(dir, "brand", "intro.js")))
                    throw new FileNotFoundException("Startbildschirm fehlt in VELOX.exe (" + n + " Dateien).");
                return dir;
            }
            catch (Exception ex)
            {
                if (log != null) log.Error("Startbildschirm konnte nicht entpackt werden: " + ex.Message);
                if (dir != null) Util.DeleteTree(dir, false);
                return null;
            }
        }

        /// <summary>The start-screen URL for one load.</summary>
        public static string Url(string variant, bool sound, bool test)
        {
            return Origin + "splash.html?v=" + Uri.EscapeDataString(Util.Version()) + "&variant=" + variant
                + "&sound=" + (sound ? "1" : "0") + "&test=" + (test ? "1" : "0");
        }

        public static bool IsStartUri(string uri)
        {
            return uri != null && uri.StartsWith(Origin, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>Folders of earlier runs that could not be deleted (killed process, files still open).</summary>
        private static void CleanupStale(Log log)
        {
            try
            {
                foreach (string d in Directory.GetDirectories(Path.GetTempPath(), TempPrefix + "*"))
                {
                    try { if (Directory.GetLastWriteTimeUtc(d) < DateTime.UtcNow.AddHours(-12)) Util.DeleteTree(d, false); }
                    catch (Exception) { }
                }
            }
            catch (Exception ex) { if (log != null) log.Warn("Alte Startbildschirm-Ordner: " + ex.Message); }
        }
    }
}
