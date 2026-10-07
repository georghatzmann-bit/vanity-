// Read-only access to the backend's %LOCALAPPDATA%\Velox\settings.json for the native exes.
// The backend owns that file (it rewrites it whole on every settings change), so VELOX.exe and the
// setup never write it: a choice made on a native surface reaches the backend through the app
// (VELOX.exe appends &sound=on|off to the app URL, the app saves it - docs/ARCHITECTURE.md §11).
// Read here: "startSound" (both exes) and "introMode" (VELOX.exe's start screen).
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Velox.Native
{
    internal static class UserSettings
    {
        /// <summary>%LOCALAPPDATA%\Velox - the backend's data folder when VELOX.exe starts it.</summary>
        public static string DataDir() { return Path.Combine(Util.LocalAppData(), "Velox"); }

        /// <summary>
        /// settings.json "startSound": may the start sequence play its sound? Missing file, unreadable JSON,
        /// missing key or a non-boolean value all mean true.
        /// </summary>
        public static bool StartSound(string dataDir, Log log)
        {
            object v = Value(dataDir, "startSound", log, "Startton bleibt an");
            return v is bool ? (bool)v : true;
        }

        /// <summary>The values of settings.json "introMode" (core/Common.ps1 Get-VxIntroModes; compared ordinally like the backend).</summary>
        public static readonly string[] IntroModes = { "long", "short", "off" };

        /// <summary>
        /// settings.json "introMode": "long" (the long intro on every launch, the default) | "short" | "off" (no
        /// animation, no sound). Missing file, unreadable JSON, missing key or any other value mean "long".
        /// </summary>
        public static string IntroMode(string dataDir, Log log)
        {
            string v = Value(dataDir, "introMode", log, "Startanimation bleibt lang") as string;
            return v != null && Array.IndexOf(IntroModes, v) >= 0 ? v : "long";
        }

        /// <summary>
        /// One top-level value of settings.json, or null. The backend replaces the file with tmp -> delete -> move,
        /// so it can be missing for a moment: one retry after 50 ms.
        /// </summary>
        private static object Value(string dataDir, string key, Log log, string fallbackNote)
        {
            string path = Path.Combine(dataDir ?? DataDir(), "settings.json");
            for (int attempt = 0; attempt < 2; attempt++)
            {
                if (attempt > 0) Thread.Sleep(50);
                Dictionary<string, object> d;
                bool exists;
                if (!TryRead(path, out d, out exists))
                {
                    if (!exists && !File.Exists(path + ".tmp")) return null;   // never written: the default
                    continue;                                                  // mid-replace or half-read: once more
                }
                object v;
                return d != null && d.TryGetValue(key, out v) ? v : null;
            }
            if (log != null) log.Warn("settings.json nicht lesbar - " + fallbackNote + ".");
            return null;
        }

        private static bool TryRead(string path, out Dictionary<string, object> d, out bool exists)
        {
            d = null;
            exists = false;
            try
            {
                if (!File.Exists(path)) return false;
                exists = true;
                string text;
                // FileShare.ReadWrite | Delete: never block the backend's own replace while we read
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var r = new StreamReader(fs, new UTF8Encoding(false), true))
                    text = r.ReadToEnd();
                d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text);
                return d != null;
            }
            catch (Exception) { return false; }
        }
    }
}
