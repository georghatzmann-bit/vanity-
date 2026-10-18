// HELIX-Setup – die eigentliche Arbeit: neueste Version finden, herunterladen, prüfen,
// installieren (pro Benutzer, ohne Administrator), Verknüpfungen, Eintrag in "Apps & Features",
// Deinstallation. Keine Oberfläche hier – die steckt in MainWindow.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace HelixSetup
{
    /// <summary>Fortschritt für die Anzeige. Percent &lt; 0 = unbestimmt.</summary>
    public sealed class StepProgress
    {
        public int Step;
        public string Detail;
        public double Percent = -1;
    }

    public sealed class ReleaseInfo
    {
        public string Version;
        public string ZipUrl;
        public string ShaUrl;
        public long Size;
        public string Source; // "github", "fallback", "local", "url"
    }

    public sealed class InstallOptions
    {
        public string InstallDir;
        public bool DesktopShortcut = true;
        public bool StartMenuShortcut = true;
    }

    /// <summary>Fehler mit einer verständlichen Meldung und einem Tipp, was zu tun ist.</summary>
    public sealed class SetupException : Exception
    {
        public string Advice { get; }
        public SetupException(string message, string advice, Exception inner = null) : base(message, inner) { Advice = advice; }
    }

    public static class Engine
    {
        public const string Repo = "georghatzmann-bit/vanity-";
        public const string TagPrefix = "helix-v";
        public const string ExeName = "HELIX.exe";
        public const string SetupCopyName = "HELIX-Setup.exe";
        public const string Marker = ".helix-install";
        public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\HELIX";
        static readonly Regex ZipName = new Regex(@"^HELIX-App-[0-9][0-9A-Za-z.\-]*-win-x64\.zip$", RegexOptions.IgnoreCase);

        public static string BuildVersion
        {
            get
            {
                var v = Assembly.GetExecutingAssembly().GetName().Version;
                return $"{v.Major}.{v.Minor}.{v.Build}";
            }
        }

        public static string ReleasesPage => $"https://github.com/{Repo}/releases";
        public static string DefaultInstallDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "HELIX");
        public static string DataDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "HELIX");
        public static string SelfPath => Process.GetCurrentProcess().MainModule.FileName;
        public static string LogPath => Path.Combine(Path.GetTempPath(), "HELIX-Setup.log");

        public static void Log(string text)
        {
            try { File.AppendAllText(LogPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {text}{Environment.NewLine}"); } catch { }
        }

        // ------------------------------------------------------------ Version finden

        static HttpClient NewClient()
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            var c = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
            c.DefaultRequestHeaders.UserAgent.ParseAdd($"HELIX-Setup/{BuildVersion}");
            return c;
        }

        /// <summary>
        /// Sucht die App: 1) eigene Quelle (/source=), 2) ZIP neben dem Setup, 3) neueste HELIX-Version auf GitHub,
        /// 4) die Version, mit der dieses Setup gebaut wurde.
        /// </summary>
        public static async Task<ReleaseInfo> FindRelease(string sourceOverride, CancellationToken ct)
        {
            if (!string.IsNullOrWhiteSpace(sourceOverride))
            {
                if (File.Exists(sourceOverride))
                    return new ReleaseInfo { Version = VersionFromName(Path.GetFileName(sourceOverride)), ZipUrl = Path.GetFullPath(sourceOverride), Source = "local", Size = new FileInfo(sourceOverride).Length };
                if (Uri.TryCreate(sourceOverride, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps)
                    return new ReleaseInfo { Version = VersionFromName(Path.GetFileName(u.LocalPath)), ZipUrl = u.ToString(), Source = "url" };
                throw new SetupException("Die angegebene Quelle wurde nicht gefunden.", "Prüfe den Pfad hinter /source=.");
            }

            try
            {
                var dir = Path.GetDirectoryName(SelfPath);
                var local = Directory.GetFiles(dir, "HELIX-App-*-win-x64.zip").OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault();
                if (local != null)
                    return new ReleaseInfo { Version = VersionFromName(Path.GetFileName(local)), ZipUrl = local, Source = "local", Size = new FileInfo(local).Length };
            }
            catch (Exception e) { Log("Lokale Suche: " + e.Message); }

            try
            {
                using (var c = NewClient())
                using (var cts = CancellationTokenSource.CreateLinkedTokenSource(ct))
                {
                    cts.CancelAfter(TimeSpan.FromSeconds(20));
                    c.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
                    var json = await (await c.GetAsync($"https://api.github.com/repos/{Repo}/releases?per_page=50", cts.Token)).EnsureSuccessStatusCode().Content.ReadAsStringAsync();
                    var best = PickRelease(json);
                    if (best != null) return best;
                    Log("GitHub: keine passende HELIX-Version gefunden");
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception e) { Log("GitHub-Abfrage fehlgeschlagen: " + e.Message); }

            var v = BuildVersion;
            return new ReleaseInfo
            {
                Version = v,
                ZipUrl = $"https://github.com/{Repo}/releases/download/{TagPrefix}{v}/HELIX-App-{v}-win-x64.zip",
                ShaUrl = $"https://github.com/{Repo}/releases/download/{TagPrefix}{v}/HELIX-App-{v}-win-x64.zip.sha256",
                Source = "fallback",
            };
        }

        /// <summary>Wählt aus der GitHub-Antwort die neueste fertige HELIX-Version.</summary>
        public static ReleaseInfo PickRelease(string json)
        {
            var list = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 }.DeserializeObject(json) as object[];
            if (list == null) return null;
            ReleaseInfo best = null;
            Version bestV = null;
            foreach (var o in list.OfType<Dictionary<string, object>>())
            {
                if (Get<bool>(o, "draft") || Get<bool>(o, "prerelease")) continue;
                var tag = Get<string>(o, "tag_name") ?? "";
                if (!tag.StartsWith(TagPrefix, StringComparison.OrdinalIgnoreCase)) continue;
                if (!Version.TryParse(tag.Substring(TagPrefix.Length), out var ver)) continue;
                var assets = (o.TryGetValue("assets", out var a) ? a as object[] : null) ?? new object[0];
                Dictionary<string, object> zip = null, sha = null;
                foreach (var asset in assets.OfType<Dictionary<string, object>>())
                {
                    var name = Get<string>(asset, "name") ?? "";
                    if (ZipName.IsMatch(name)) zip = asset;
                    else if (name.EndsWith(".zip.sha256", StringComparison.OrdinalIgnoreCase)) sha = asset;
                }
                if (zip == null) continue;
                if (bestV != null && ver <= bestV) continue;
                bestV = ver;
                best = new ReleaseInfo
                {
                    Version = ver.ToString(),
                    ZipUrl = Get<string>(zip, "browser_download_url"),
                    ShaUrl = sha != null ? Get<string>(sha, "browser_download_url") : null,
                    Size = Convert.ToInt64(zip.TryGetValue("size", out var sz) ? sz ?? 0 : 0),
                    Source = "github",
                };
            }
            return best;
        }

        static T Get<T>(Dictionary<string, object> d, string key)
        {
            if (d.TryGetValue(key, out var v) && v is T t) return t;
            return default(T);
        }

        static string VersionFromName(string name)
        {
            var m = Regex.Match(name ?? "", @"HELIX-App-([0-9][0-9A-Za-z.\-]*)-win-x64", RegexOptions.IgnoreCase);
            return m.Success ? m.Groups[1].Value : "?";
        }

        // ------------------------------------------------------------ Herunterladen & prüfen

        /// <summary>Lädt die App herunter (oder nimmt die lokale Datei) und prüft sie. Rückgabe: Pfad der ZIP-Datei.</summary>
        public static async Task<string> Fetch(ReleaseInfo rel, string workDir, IProgress<StepProgress> progress, CancellationToken ct)
        {
            Directory.CreateDirectory(workDir);
            string zipPath;
            if (rel.Source == "local")
            {
                zipPath = rel.ZipUrl;
                progress?.Report(new StepProgress { Step = 1, Detail = "Lokale Datei wird verwendet", Percent = 100 });
            }
            else
            {
                zipPath = Path.Combine(workDir, $"HELIX-App-{rel.Version}.zip");
                await DownloadWithRetry(rel.ZipUrl, zipPath, rel.Size, progress, ct);
            }

            progress?.Report(new StepProgress { Step = 2, Detail = "Datei wird geprüft …" });
            if (!string.IsNullOrEmpty(rel.ShaUrl) && rel.Source != "local")
            {
                string expected = null;
                try
                {
                    using (var c = NewClient())
                    {
                        var text = await c.GetStringAsync(rel.ShaUrl);
                        expected = Regex.Match(text, "[0-9a-fA-F]{64}").Value.ToLowerInvariant();
                    }
                }
                catch (Exception e) { Log("Prüfsumme nicht ladbar: " + e.Message); }
                if (!string.IsNullOrEmpty(expected))
                {
                    var actual = Sha256(zipPath);
                    if (actual != expected)
                        throw new SetupException("Die heruntergeladene Datei ist beschädigt (Prüfsumme stimmt nicht).", "Bitte versuche es noch einmal. Wenn es wieder passiert, lade HELIX von der Release-Seite herunter.");
                }
            }
            using (var z = ZipFile.OpenRead(zipPath))
            {
                if (!z.Entries.Any(e => e.FullName.Equals(ExeName, StringComparison.OrdinalIgnoreCase)))
                    throw new SetupException("In der heruntergeladenen Datei fehlt HELIX.exe.", "Bitte lade HELIX erneut herunter.");
            }
            return zipPath;
        }

        static async Task DownloadWithRetry(string url, string dest, long expectedSize, IProgress<StepProgress> progress, CancellationToken ct)
        {
            Exception last = null;
            for (int attempt = 1; attempt <= 3; attempt++)
            {
                try
                {
                    await Download(url, dest, expectedSize, progress, ct);
                    return;
                }
                catch (OperationCanceledException) { throw; }
                catch (HttpRequestException e) when (e.Message.Contains("404"))
                {
                    throw new SetupException("Die HELIX-Version wurde auf GitHub nicht gefunden.", "Öffne die Release-Seite und lade HELIX von Hand herunter.", e);
                }
                catch (Exception e)
                {
                    last = e;
                    Log($"Download-Versuch {attempt} fehlgeschlagen: {e.Message}");
                    progress?.Report(new StepProgress { Step = 1, Detail = $"Verbindung unterbrochen – neuer Versuch ({attempt + 1}/3) …" });
                    await Task.Delay(1500 * attempt, ct);
                }
            }
            throw new SetupException("Der Download hat nicht geklappt.", "Prüfe deine Internetverbindung und versuche es noch einmal.", last);
        }

        static async Task Download(string url, string dest, long expectedSize, IProgress<StepProgress> progress, CancellationToken ct)
        {
            using (var c = NewClient())
            using (var resp = await c.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct))
            {
                if (resp.StatusCode == HttpStatusCode.NotFound) throw new HttpRequestException("404");
                resp.EnsureSuccessStatusCode();
                var total = resp.Content.Headers.ContentLength ?? expectedSize;
                var tmp = dest + ".part";
                using (var src = await resp.Content.ReadAsStreamAsync())
                using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16, true))
                {
                    var buf = new byte[1 << 16];
                    long done = 0;
                    var sw = Stopwatch.StartNew();
                    var lastReport = 0L;
                    int n;
                    while ((n = await src.ReadAsync(buf, 0, buf.Length, ct)) > 0)
                    {
                        await fs.WriteAsync(buf, 0, n, ct);
                        done += n;
                        if (sw.ElapsedMilliseconds - lastReport > 150)
                        {
                            lastReport = sw.ElapsedMilliseconds;
                            var speed = done / Math.Max(0.5, sw.Elapsed.TotalSeconds);
                            progress?.Report(new StepProgress
                            {
                                Step = 1,
                                Percent = total > 0 ? done * 100.0 / total : -1,
                                Detail = total > 0
                                    ? $"{Mb(done)} von {Mb(total)} · {Mb((long)speed)}/s"
                                    : $"{Mb(done)} · {Mb((long)speed)}/s",
                            });
                        }
                    }
                }
                if (File.Exists(dest)) File.Delete(dest);
                File.Move(tmp, dest);
                progress?.Report(new StepProgress { Step = 1, Percent = 100, Detail = "Download fertig" });
            }
        }

        public static string Mb(long bytes) => $"{bytes / 1048576.0:0.0} MB".Replace('.', ',');

        public static string Sha256(string file)
        {
            using (var s = File.OpenRead(file))
            using (var h = SHA256.Create())
                return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant();
        }

        // ------------------------------------------------------------ Installieren

        /// <summary>
        /// Prüft den Zielordner. Ein fremder, nicht leerer Ordner wird nie überschrieben –
        /// dann wird automatisch ein Unterordner "HELIX" genommen.
        /// </summary>
        public static string ResolveInstallDir(string chosen)
        {
            var dir = Path.GetFullPath(string.IsNullOrWhiteSpace(chosen) ? DefaultInstallDir : chosen.Trim());
            var root = Path.GetPathRoot(dir);
            if (string.Equals(dir.TrimEnd('\\'), root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                return Path.Combine(dir, "HELIX");
            if (Directory.Exists(dir) && Directory.EnumerateFileSystemEntries(dir).Any()
                && !File.Exists(Path.Combine(dir, Marker)) && !File.Exists(Path.Combine(dir, ExeName)))
                return Path.Combine(dir, "HELIX");
            return dir;
        }

        public static void Install(string zipPath, ReleaseInfo rel, InstallOptions opt, IProgress<StepProgress> progress)
        {
            var dir = ResolveInstallDir(opt.InstallDir);
            var parent = Path.GetDirectoryName(dir);
            Directory.CreateDirectory(parent);

            progress?.Report(new StepProgress { Step = 3, Detail = "Laufendes HELIX wird geschlossen …" });
            CloseRunningHelix(dir);

            var stage = dir + ".neu-" + Guid.NewGuid().ToString("N").Substring(0, 6);
            progress?.Report(new StepProgress { Step = 3, Detail = "Dateien werden entpackt …" });
            try
            {
                ZipFile.ExtractToDirectory(zipPath, stage);
                if (!File.Exists(Path.Combine(stage, ExeName)))
                    throw new SetupException("Nach dem Entpacken fehlt HELIX.exe.", "Bitte lade HELIX erneut herunter.");
                // Setup selbst mitnehmen: damit läuft später die Deinstallation
                File.Copy(SelfPath, Path.Combine(stage, SetupCopyName), true);
                File.WriteAllText(Path.Combine(stage, Marker), $"HELIX {rel.Version}\r\ninstalliert {DateTime.Now:yyyy-MM-dd HH:mm}\r\n");
            }
            catch (IOException e) when (e.HResult == unchecked((int)0x80070070) || e.HResult == unchecked((int)0x80070027))
            {
                TryDelete(stage);
                throw new SetupException("Auf dem Laufwerk ist nicht genug Platz.", "Mache etwas Platz frei (etwa 400 MB) und versuche es noch einmal.", e);
            }
            catch
            {
                TryDelete(stage);
                throw;
            }

            progress?.Report(new StepProgress { Step = 3, Detail = "Neue Version wird eingesetzt …" });
            string old = null;
            try
            {
                if (Directory.Exists(dir))
                {
                    old = dir + ".alt-" + Guid.NewGuid().ToString("N").Substring(0, 6);
                    RetryIo(() => Directory.Move(dir, old));
                }
                RetryIo(() => Directory.Move(stage, dir));
            }
            catch (Exception e)
            {
                // zurückrollen
                try { if (old != null && !Directory.Exists(dir)) Directory.Move(old, dir); } catch { }
                TryDelete(stage);
                throw new SetupException("HELIX konnte nicht in den Ordner geschrieben werden.", "Schließe HELIX (auch im Infobereich unten rechts) und versuche es noch einmal.", e);
            }
            if (old != null) TryDelete(old);

            progress?.Report(new StepProgress { Step = 4, Detail = "Verknüpfungen werden angelegt …" });
            var exe = Path.Combine(dir, ExeName);
            if (opt.DesktopShortcut) CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "HELIX.lnk"), exe);
            if (opt.StartMenuShortcut) CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "HELIX.lnk"), exe);
            RegisterUninstall(dir, rel.Version);
            progress?.Report(new StepProgress { Step = 5, Percent = 100, Detail = "Fertig" });
            Log($"Installiert: HELIX {rel.Version} in {dir}");
        }

        static void RetryIo(Action a)
        {
            for (int i = 0; ; i++)
            {
                try { a(); return; }
                catch (IOException) when (i < 6) { Thread.Sleep(300 * (i + 1)); }
                catch (UnauthorizedAccessException) when (i < 6) { Thread.Sleep(300 * (i + 1)); }
            }
        }

        static void TryDelete(string dir)
        {
            for (int i = 0; i < 4; i++)
            {
                try
                {
                    if (!Directory.Exists(dir)) return;
                    foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
                    {
                        try { File.SetAttributes(f, FileAttributes.Normal); } catch { }
                    }
                    Directory.Delete(dir, true);
                    return;
                }
                catch { Thread.Sleep(400); }
            }
        }

        /// <summary>Schließt HELIX, wenn es aus diesem Ordner läuft (erst normal, dann sofort).</summary>
        public static void CloseRunningHelix(string dir)
        {
            foreach (var p in Process.GetProcessesByName("HELIX"))
            {
                try
                {
                    var path = p.MainModule?.FileName ?? "";
                    if (!path.StartsWith(dir, StringComparison.OrdinalIgnoreCase)) continue;
                    if (p.MainWindowHandle != IntPtr.Zero) p.CloseMainWindow();
                    if (!p.WaitForExit(5000)) { p.Kill(); p.WaitForExit(5000); }
                }
                catch (Exception e) { Log("HELIX schließen: " + e.Message); }
            }
        }

        public static bool IsHelixRunning(string dir)
        {
            foreach (var p in Process.GetProcessesByName("HELIX"))
            {
                try { if ((p.MainModule?.FileName ?? "").StartsWith(dir, StringComparison.OrdinalIgnoreCase)) return true; } catch { }
            }
            return false;
        }

        static void CreateShortcut(string lnkPath, string target)
        {
            object shell = null, lnk = null;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(lnkPath));
                var t = Type.GetTypeFromProgID("WScript.Shell");
                shell = Activator.CreateInstance(t);
                dynamic sh = shell;
                lnk = sh.CreateShortcut(lnkPath);
                dynamic l = lnk;
                l.TargetPath = target;
                l.WorkingDirectory = Path.GetDirectoryName(target);
                l.IconLocation = target + ",0";
                l.Description = "HELIX – Fortnite-Tuning-Cockpit";
                l.Save();
            }
            catch (Exception e) { Log("Verknüpfung " + lnkPath + ": " + e.Message); }
            finally
            {
                if (lnk != null) Marshal.FinalReleaseComObject(lnk);
                if (shell != null) Marshal.FinalReleaseComObject(shell);
            }
        }

        static void RegisterUninstall(string dir, string version)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                var setup = Path.Combine(dir, SetupCopyName);
                k.SetValue("DisplayName", "HELIX");
                k.SetValue("DisplayVersion", version ?? BuildVersion);
                k.SetValue("Publisher", "HELIX");
                k.SetValue("InstallLocation", dir);
                k.SetValue("DisplayIcon", Path.Combine(dir, ExeName) + ",0");
                k.SetValue("UninstallString", $"\"{setup}\" /uninstall");
                k.SetValue("QuietUninstallString", $"\"{setup}\" /uninstall /silent");
                k.SetValue("URLInfoAbout", ReleasesPage);
                k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                try
                {
                    var kb = new DirectoryInfo(dir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length) / 1024;
                    k.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, kb), RegistryValueKind.DWord);
                }
                catch { }
            }
        }

        public static string InstalledDir()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(UninstallKey))
                return k?.GetValue("InstallLocation") as string;
        }

        public static string InstalledVersion()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(UninstallKey))
                return k?.GetValue("DisplayVersion") as string;
        }

        // ------------------------------------------------------------ Deinstallieren

        /// <summary>
        /// Läuft das Setup aus dem Installationsordner, wird es nach %TEMP% kopiert und von dort neu gestartet,
        /// damit der Ordner gelöscht werden kann. Rückgabe true = dieser Prozess soll sich beenden.
        /// </summary>
        public static bool RelaunchFromTemp(string[] args, string installDir)
        {
            if (string.IsNullOrEmpty(installDir)) return false;
            var self = SelfPath;
            if (!self.StartsWith(installDir.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) return false;
            var copy = Path.Combine(Path.GetTempPath(), $"HELIX-Deinstallation-{Guid.NewGuid():N}.exe");
            File.Copy(self, copy, true);
            var rest = string.Join(" ", args.Where(a => !a.StartsWith("/from=", StringComparison.OrdinalIgnoreCase)).Select(Quote));
            Process.Start(new ProcessStartInfo(copy, $"{rest} {Quote("/from=" + installDir)} /tempcopy") { UseShellExecute = false });
            return true;
        }

        static string Quote(string a) => a.Contains(" ") ? "\"" + a.Replace("\"", "") + "\"" : a;

        public static void Uninstall(string dir, bool removeData, IProgress<StepProgress> progress)
        {
            if (string.IsNullOrEmpty(dir)) dir = InstalledDir();
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
            {
                RemoveShortcuts(null);
                Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
                if (removeData) TryDelete(DataDir);
                return;
            }
            // Sicherheitsprüfung: nur einen echten HELIX-Ordner löschen
            if (!File.Exists(Path.Combine(dir, Marker)) && !File.Exists(Path.Combine(dir, ExeName)))
                throw new SetupException("Der Ordner sieht nicht nach einer HELIX-Installation aus und wird deshalb nicht gelöscht.", dir);

            progress?.Report(new StepProgress { Step = 1, Detail = "HELIX wird geschlossen …" });
            CloseRunningHelix(dir);
            progress?.Report(new StepProgress { Step = 2, Detail = "Verknüpfungen werden entfernt …" });
            RemoveShortcuts(dir);
            progress?.Report(new StepProgress { Step = 3, Detail = "Dateien werden gelöscht …" });
            TryDelete(dir);
            if (Directory.Exists(dir))
                throw new SetupException("Einige Dateien konnten nicht gelöscht werden.", "Starte den PC neu und lösche danach den Ordner " + dir + " von Hand.");
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
            if (removeData)
            {
                progress?.Report(new StepProgress { Step = 4, Detail = "Profile und Sicherungen werden gelöscht …" });
                TryDelete(DataDir);
            }
            progress?.Report(new StepProgress { Step = 5, Percent = 100, Detail = "Fertig" });
            Log($"Deinstalliert: {dir} (Daten gelöscht: {removeData})");
        }

        static void RemoveShortcuts(string dir)
        {
            foreach (var lnk in new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "HELIX.lnk"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "HELIX.lnk"),
            })
            {
                try { if (File.Exists(lnk)) File.Delete(lnk); } catch (Exception e) { Log("Verknüpfung löschen: " + e.Message); }
            }
        }

        /// <summary>Löscht die temporäre Deinstallations-Kopie kurz nach dem Beenden.</summary>
        public static void ScheduleSelfDelete()
        {
            try
            {
                var self = SelfPath;
                Process.Start(new ProcessStartInfo("cmd.exe", $"/c ping 127.0.0.1 -n 3 > nul & del /f /q \"{self}\"")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden,
                });
            }
            catch { }
        }

        public static void StartHelix(string dir)
        {
            var exe = Path.Combine(ResolveInstalledDir(dir), ExeName);
            if (File.Exists(exe)) Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(exe) });
        }

        static string ResolveInstalledDir(string dir) => File.Exists(Path.Combine(dir ?? "", ExeName)) ? dir : (InstalledDir() ?? dir);

        public static void OpenUrl(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
        }

        // ------------------------------------------------------------ eingebettete Dateien

        static string mediaDir;

        /// <summary>Entpackt eingebettete Clips/Klänge in einen Temp-Ordner (MediaElement braucht echte Dateien).</summary>
        public static string Media(string name)
        {
            if (mediaDir == null)
            {
                mediaDir = Path.Combine(Path.GetTempPath(), "HELIX-Setup-" + Process.GetCurrentProcess().Id);
                Directory.CreateDirectory(mediaDir);
            }
            var path = Path.Combine(mediaDir, name);
            if (!File.Exists(path))
            {
                using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
                {
                    if (s == null) return null;
                    using (var f = File.Create(path)) s.CopyTo(f);
                }
            }
            return path;
        }

        public static void CleanupMedia()
        {
            if (mediaDir != null) TryDelete(mediaDir);
        }
    }
}
