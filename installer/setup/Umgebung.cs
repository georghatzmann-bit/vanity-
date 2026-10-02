using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace JarvisSetup
{
    /// <summary>Was auf dem PC schon da ist, und wie Jarvis gestartet wird.</summary>
    static class Umgebung
    {
        /// <summary>AppId aus installer\jarvis.iss (Inno legt den Eintrag mit "_is1" an).</summary>
        const string Deinstallieren = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\{6F2C3E1A-7B4D-4E8A-9C1F-4A5B6C7D8E9F}_is1";
        const string AutostartSchluessel = @"Software\Microsoft\Windows\CurrentVersion\Run";

        public static string LocalAppData => Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        public static string DatenOrdner => Path.Combine(LocalAppData, "Jarvis");
        /// <summary>Protokoll von werkzeuge\installieren.ps1.</summary>
        public static string Protokoll => Path.Combine(DatenOrdner, "installation.log");
        public static string PythonW => Path.Combine(DatenOrdner, "venv", "Scripts", "pythonw.exe");

        public static string ProgrammOrdner
        {
            get
            {
                try
                {
                    using (RegistryKey key = Registry.CurrentUser.OpenSubKey(Deinstallieren))
                    {
                        string ort = key?.GetValue("InstallLocation") as string;
                        if (!string.IsNullOrWhiteSpace(ort))
                            return ort.TrimEnd('\\');
                    }
                }
                catch (Exception)
                {
                }
                return Path.Combine(LocalAppData, "Programs", "Jarvis");
            }
        }

        /// <summary>Ist Jarvis schon installiert (dann ist es ein Update)?</summary>
        public static bool Installiert
        {
            get
            {
                try
                {
                    using (RegistryKey key = Registry.CurrentUser.OpenSubKey(Deinstallieren))
                        if (key != null)
                            return true;
                }
                catch (Exception)
                {
                }
                return File.Exists(Path.Combine(ProgrammOrdner, "Jarvis.pyw"));
            }
        }

        public static bool AutostartAn
        {
            get
            {
                try
                {
                    using (RegistryKey key = Registry.CurrentUser.OpenSubKey(AutostartSchluessel))
                        return key?.GetValue("Jarvis") != null;
                }
                catch (Exception)
                {
                    return false;
                }
            }
        }

        public static bool DesktopSymbol
        {
            get
            {
                try
                {
                    return File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Jarvis.lnk"));
                }
                catch (Exception)
                {
                    return false;
                }
            }
        }

        /// <summary>Freier Platz auf dem Laufwerk mit %LOCALAPPDATA% in Bytes (-1: unbekannt).</summary>
        public static long FreierPlatz(out string laufwerk)
        {
            laufwerk = "C:";
            try
            {
                string wurzel = Path.GetPathRoot(LocalAppData);
                laufwerk = wurzel.TrimEnd('\\');
                return new DriveInfo(wurzel).AvailableFreeSpace;
            }
            catch (Exception)
            {
                return -1;
            }
        }

        /// <summary>Läuft Jarvis (oder seine Einrichtung)? Jarvis hält dafür eine Sperre.</summary>
        public static bool JarvisLaeuft()
        {
            foreach (string name in new[] { @"Local\JarvisSprachassistent", @"Local\JarvisEinrichtung" })
            {
                try
                {
                    if (Mutex.TryOpenExisting(name, out Mutex sperre))
                    {
                        sperre.Dispose();
                        return true;
                    }
                }
                catch (UnauthorizedAccessException)
                {
                    return true;
                }
                catch (Exception)
                {
                }
            }
            return false;
        }

        public sealed class JarvisProzess
        {
            public bool Laeuft;
            public bool Hintergrund;
        }

        /// <summary>Laufende Jarvis-Prozesse und ob sie unsichtbar laufen (--hintergrund).</summary>
        public static JarvisProzess LaufendesJarvis()
        {
            var info = new JarvisProzess();
            try
            {
                using (var suche = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE Name='pythonw.exe' OR Name='python.exe'"))
                using (ManagementObjectCollection liste = suche.Get())
                {
                    foreach (ManagementBaseObject prozess in liste)
                    {
                        using (prozess)
                        {
                            string zeile = prozess["CommandLine"] as string;
                            if (zeile == null || zeile.IndexOf("jarvis", StringComparison.OrdinalIgnoreCase) < 0)
                                continue;
                            info.Laeuft = true;
                            if (zeile.IndexOf("--hintergrund", StringComparison.OrdinalIgnoreCase) >= 0)
                                info.Hintergrund = true;
                        }
                    }
                }
            }
            catch (Exception)
            {
            }
            return info;
        }

        /// <summary>Warum Jarvis hier nicht läuft (null: alles gut).</summary>
        public static string Hindernis()
        {
            if (!Environment.Is64BitOperatingSystem)
                return "Jarvis braucht ein 64-Bit-Windows.";
            int build = WindowsBuild();
            if (build > 0 && build < 17763)
                return "Jarvis braucht Windows 10 ab Version 1809 oder Windows 11.\n\nBitte installieren Sie zuerst die Windows-Updates.";
            return null;
        }

        static int WindowsBuild()
        {
            try
            {
                using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
                    if (int.TryParse(key?.GetValue("CurrentBuildNumber") as string, out int build))
                        return build;
            }
            catch (Exception)
            {
            }
            return Environment.OSVersion.Version.Build;
        }

        /// <summary>Startet Jarvis wie die Verknüpfung: pythonw + Jarvis.pyw, ohne Konsolenfenster.
        /// Beim allerersten Start öffnet Jarvis von selbst die Einrichtung.</summary>
        public static void JarvisStarten(bool hintergrund)
        {
            string ordner = ProgrammOrdner;
            if (!File.Exists(PythonW))
                throw new FileNotFoundException("pythonw.exe fehlt.", PythonW);
            var start = new ProcessStartInfo(PythonW, "\"" + Path.Combine(ordner, "Jarvis.pyw") + "\"" + (hintergrund ? " --hintergrund" : ""))
            {
                WorkingDirectory = ordner,
                UseShellExecute = false,
            };
            // Der PATH von jetzt (das Setup kennt neue Einträge wie Claude Code sonst noch nicht)
            string pfad = FrischerPfad();
            if (!string.IsNullOrEmpty(pfad))
                start.EnvironmentVariables["PATH"] = pfad;
            Process.Start(start)?.Dispose();
        }

        static string FrischerPfad()
        {
            try
            {
                string maschine = Registry.GetValue(@"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\Environment", "Path", "") as string ?? "";
                string benutzer = Registry.GetValue(@"HKEY_CURRENT_USER\Environment", "Path", "") as string ?? "";
                return Environment.ExpandEnvironmentVariables(maschine + ";" + benutzer).Trim(';');
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>Die letzten Zeilen eines Protokolls, ohne die JARVIS-Zeilen für die Oberfläche.</summary>
        public static string[] LetzteZeilen(string datei, int anzahl)
        {
            var zeilen = new List<string>();
            try
            {
                if (string.IsNullOrEmpty(datei) || !File.Exists(datei))
                    return zeilen.ToArray();
                using (var fs = new FileStream(datei, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    long start = Math.Max(0, fs.Length - 16384);
                    fs.Position = start;
                    var puffer = new byte[fs.Length - start];
                    int n = fs.Read(puffer, 0, puffer.Length);
                    string[] roh = Encoding.UTF8.GetString(puffer, 0, n).Split('\n');
                    for (int i = start > 0 ? 1 : 0; i < roh.Length; i++)
                    {
                        string zeile = roh[i].TrimEnd('\r');
                        int cr = zeile.LastIndexOf('\r');
                        if (cr >= 0)
                            zeile = zeile.Substring(cr + 1);
                        zeile = zeile.Trim('﻿').TrimEnd();
                        if (zeile.Trim().Length == 0 || zeile.StartsWith("JARVIS-", StringComparison.Ordinal))
                            continue;
                        zeilen.Add(zeile);
                    }
                }
            }
            catch (Exception)
            {
            }
            int weg = Math.Max(0, zeilen.Count - anzahl);
            return zeilen.GetRange(weg, zeilen.Count - weg).ToArray();
        }

        /// <summary>Unerwartete Fehler für die Fehlersuche festhalten (in %TEMP%).</summary>
        public static void FehlerMerken(Exception ex)
        {
            try
            {
                File.AppendAllText(Path.Combine(Path.GetTempPath(), "JarvisSetup-fehler.txt"), DateTime.Now + " " + ex + Environment.NewLine, Encoding.UTF8);
            }
            catch (Exception)
            {
            }
        }

        public static void AnderesSetupNachVorn()
        {
            IntPtr fenster = Native.FindWindow(null, "Jarvis Setup");
            if (fenster == IntPtr.Zero)
                return;
            Native.ShowWindow(fenster, 9);  // SW_RESTORE
            Native.SetForegroundWindow(fenster);
        }
    }

    static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left, Top, Right, Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct FLASHWINFO
        {
            public uint cbSize;
            public IntPtr hwnd;
            public uint dwFlags;
            public uint uCount;
            public uint dwTimeout;
        }

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr FindWindow(string klasse, string titel);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int befehl);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern bool FlashWindowEx(ref FLASHWINFO info);

        public const int SRCCOPY = 0x00CC0020;
        public const int CAPTUREBLT = 0x40000000;

        [DllImport("user32.dll")]
        public static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);

        [DllImport("gdi32.dll")]
        public static extern bool BitBlt(IntPtr ziel, int x, int y, int breite, int hoehe, IntPtr quelle, int qx, int qy, int art);

        /// <summary>Taskleisten-Knopf blinken lassen, bis das Fenster nach vorn kommt.</summary>
        public static void Blinken(IntPtr fenster)
        {
            var info = new FLASHWINFO
            {
                cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO)),
                hwnd = fenster,
                dwFlags = 2 | 12,  // FLASHW_TRAY | FLASHW_TIMERNOFG
                uCount = 0,
                dwTimeout = 0,
            };
            FlashWindowEx(ref info);
        }
    }
}
