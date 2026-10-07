// VeloxBuildTool - build-machine helper for native/build.sh and native/Build.ps1.
//
//   pack   --app <velox-tweaker> --host <VELOX.exe build dir> --out <payload.zip>
//          Deterministic zip (sorted entries, fixed timestamps) of everything the installed app needs.
//   verify --setup <VeloxSetup.exe> --app <velox-tweaker> [--max-mb 3]
//          Opens the built exe and checks manifests, resources, version, payload content, size budget,
//          that both web UIs are served from memory (shared/EmbeddedSite.cs run against the embedded files)
//          and the WebView2 rules in the native sources (no folder mapping, no user data folder in TempDir).
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using Velox.Native;

internal static class Program
{
    // What the installed app consists of (relative to velox-tweaker/). Folders are copied recursively.
    private static readonly string[] AppFiles = { "Velox.ps1", "Start.bat", "Start-Testmodus.bat", "README.md", "VERSION" };
    private static readonly string[] AppDirs = { "core", "ui", "data" };
    private static readonly string[] HostFiles =
    {
        "VELOX.exe", "VELOX.exe.config",
        "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll",
        "runtimes/win-x64/native/WebView2Loader.dll", "runtimes/win-x86/native/WebView2Loader.dll", "runtimes/win-arm64/native/WebView2Loader.dll"
    };
    private static readonly string[] Forbidden = { "tests/", "tools/", "docs/", "native/", "dist/", "node_modules/", ".git" };
    private static readonly DateTimeOffset FixedTime = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0) { Console.Error.WriteLine("usage: pack|verify ..."); return 2; }
            var opt = ParseOptions(args.Skip(1).ToArray());
            switch (args[0])
            {
                case "pack": return Pack(opt["app"], opt["host"], opt["out"]);
                case "verify": return Verify(opt["setup"], opt["app"], opt.TryGetValue("max-mb", out string mb) ? double.Parse(mb, System.Globalization.CultureInfo.InvariantCulture) : 3.0);
                default: Console.Error.WriteLine("unknown command " + args[0]); return 2;
            }
        }
        catch (KeyNotFoundException ex) { Console.Error.WriteLine("missing option: " + ex.Message); return 2; }
        catch (Exception ex) { Console.Error.WriteLine("ERROR: " + ex); return 1; }
    }

    private static Dictionary<string, string> ParseOptions(string[] a)
    {
        var d = new Dictionary<string, string>();
        for (int i = 0; i + 1 < a.Length; i += 2)
        {
            if (!a[i].StartsWith("--")) throw new ArgumentException("bad option " + a[i]);
            d[a[i].Substring(2)] = a[i + 1];
        }
        return d;
    }

    // ------------------------------------------------------------------ pack

    /// <summary>relative path ("/") -> absolute source file, sorted ordinal.</summary>
    private static SortedDictionary<string, string> AppManifest(string app, string host)
    {
        var map = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (string f in AppFiles)
        {
            string p = Path.Combine(app, f);
            if (!File.Exists(p)) throw new FileNotFoundException("app file missing: " + p);
            map[f] = p;
        }
        foreach (string d in AppDirs)
        {
            string root = Path.Combine(app, d);
            if (!Directory.Exists(root)) throw new DirectoryNotFoundException("app folder missing: " + root);
            foreach (string f in Directory.GetFiles(root, "*", SearchOption.AllDirectories))
            {
                string rel = Path.GetRelativePath(app, f).Replace('\\', '/');
                string name = Path.GetFileName(f);
                if (name.StartsWith(".") || name.EndsWith("~") || name.EndsWith(".tmp")) continue;
                map[rel] = f;
            }
        }
        if (host != null)
        {
            foreach (string f in HostFiles)
            {
                string p = Path.Combine(host, f.Replace('/', Path.DirectorySeparatorChar));
                if (!File.Exists(p)) throw new FileNotFoundException("host build output missing: " + p);
                map[f] = p;
            }
        }
        return map;
    }

    private static int Pack(string app, string host, string output)
    {
        var map = AppManifest(app, host);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output)));
        string tmp = output + ".tmp";
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write))
        using (var zip = new ZipArchive(fs, ZipArchiveMode.Create))
        {
            foreach (var kv in map)
            {
                var e = zip.CreateEntry(kv.Key, CompressionLevel.SmallestSize);
                e.LastWriteTime = FixedTime;
                using (var s = e.Open())
                {
                    byte[] b = File.ReadAllBytes(kv.Value);
                    s.Write(b, 0, b.Length);
                }
            }
        }
        if (File.Exists(output)) File.Delete(output);
        File.Move(tmp, output);
        long raw = map.Values.Sum(p => new FileInfo(p).Length);
        Console.WriteLine($"payload: {map.Count} files, {raw / 1024} KB -> {new FileInfo(output).Length / 1024} KB ({output})");
        return 0;
    }

    // ------------------------------------------------------------------ verify

    private static int _fails;
    private static void Check(bool ok, string what)
    {
        Console.WriteLine((ok ? "  ok    " : "  FAIL  ") + what);
        if (!ok) _fails++;
    }

    private static int Verify(string setupPath, string app, double maxMb)
    {
        _fails = 0;
        string version = File.ReadAllText(Path.Combine(app, "VERSION")).Trim();
        byte[] setup = File.ReadAllBytes(setupPath);
        Console.WriteLine($"VeloxSetup.exe: {setup.Length} bytes ({setup.Length / 1048576.0:0.00} MB), VERSION {version}");
        Check(setup.Length <= maxMb * 1048576, $"size {setup.Length / 1048576.0:0.00} MB <= budget {maxMb} MB");

        var s = InspectPe(setup, "VeloxSetup.exe");
        Check(s.Manifest.Contains("level=\"requireAdministrator\""), "setup manifest: requireAdministrator");
        Check(s.Manifest.Contains("PerMonitorV2"), "setup manifest: PerMonitorV2");
        CheckManifestXml(s.Manifest, "setup manifest");
        Check(s.HasIcon, "setup: icon group resource");
        Check(s.HasVersion, "setup: version resource");
        Check(s.AssemblyVersion == version + ".0", $"setup: assembly version {s.AssemblyVersion} = {version}.0");
        Check(s.Informational == version, $"setup: informational version {s.Informational} = {version}");
        foreach (string r in new[] { "payload.zip", "ui/index.html", "ui/setup.css", "ui/setup.js" })
            Check(s.Resources.ContainsKey(r), "setup: embedded resource " + r);
        CheckEmbeddedFiles("setup", s, "ui/", app, Path.Combine(app, "native", "setup-ui"), new[] { "index.html", "setup.css", "setup.js" });
        CheckBrandCopies("setup", s, "ui/brand/", app, SetupBrand);
        Check(!s.ReferencesWebView2Files, "setup: no WebView2 DLL needed next to the exe (only assembly references)");
        Check(s.TargetFramework == TargetFramework, $"setup: built for {s.TargetFramework} (expected {TargetFramework})");

        if (!s.Resources.TryGetValue("payload.zip", out byte[] payload)) { Console.WriteLine($"FAILED: {_fails} check(s)"); return 1; }
        Console.WriteLine($"payload.zip: {payload.Length / 1024} KB");
        var expected = AppManifest(app, null);
        using var zip = new ZipArchive(new MemoryStream(payload), ZipArchiveMode.Read);
        var entries = zip.Entries.ToDictionary(e => e.FullName, e => e, StringComparer.Ordinal);
        int same = 0;
        foreach (var kv in expected)
        {
            if (!entries.TryGetValue(kv.Key, out var e)) { Check(false, "payload contains " + kv.Key); continue; }
            using var st = e.Open();
            using var ms = new MemoryStream();
            st.CopyTo(ms);
            if (ms.ToArray().AsSpan().SequenceEqual(File.ReadAllBytes(kv.Value))) same++;
            else Check(false, "payload copy is identical: " + kv.Key);
        }
        Check(same == expected.Count, $"payload: all {expected.Count} app files present and identical (core/, ui/, data/, Velox.ps1, Start*.bat, README.md, VERSION)");
        foreach (string f in HostFiles) Check(entries.ContainsKey(f), "payload contains " + f);
        Check(!entries.Keys.Any(k => Forbidden.Any(f => k.StartsWith(f, StringComparison.OrdinalIgnoreCase))), "payload: nothing from tests/, tools/, docs/, native/, dist/");
        Check(!entries.Keys.Any(k => k.Contains("..") || k.StartsWith("/") || k.Contains('\\') || k.Contains(':')), "payload: only plain relative paths");
        Check(entries.Count == expected.Count + HostFiles.Length, $"payload: exactly {expected.Count + HostFiles.Length} files (no extras), found {entries.Count}");
        Check(entries.Values.All(e => e.LastWriteTime == FixedTime), "payload: fixed timestamps (deterministic)");
        var order = entries.Keys.ToList();
        Check(zip.Entries.Select(e => e.FullName).SequenceEqual(zip.Entries.Select(e => e.FullName).OrderBy(x => x, StringComparer.Ordinal)), "payload: sorted entries (deterministic)");
        foreach (string bat in new[] { "Start.bat", "Start-Testmodus.bat" })
        {
            byte[] b = Read(entries[bat]);
            Check(b.Length > 0 && Encoding.ASCII.GetString(b).Replace("\r\n", "").IndexOf('\n') < 0, bat + ": CRLF line endings kept");
        }
        byte[] vps = Read(entries["Velox.ps1"]);
        Check(vps.Length > 3 && vps[0] == 0xEF && vps[1] == 0xBB && vps[2] == 0xBF, "Velox.ps1: UTF-8 BOM kept");

        var v = InspectPe(Read(entries["VELOX.exe"]), "VELOX.exe");
        Check(v.Manifest.Contains("level=\"asInvoker\""), "VELOX.exe manifest: asInvoker");
        Check(v.Manifest.Contains("PerMonitorV2"), "VELOX.exe manifest: PerMonitorV2");
        CheckManifestXml(v.Manifest, "VELOX.exe manifest");
        CheckConfigXml(Encoding.UTF8.GetString(Read(entries["VELOX.exe.config"])), "VELOX.exe.config");
        Check(v.HasIcon, "VELOX.exe: icon group resource");
        Check(v.HasVersion, "VELOX.exe: version resource");
        Check(v.AssemblyVersion == version + ".0", $"VELOX.exe: assembly version {v.AssemblyVersion} = {version}.0");
        CheckEmbeddedFiles("VELOX.exe", v, "start/", app, Path.Combine(app, "native", "host", "start"), new[] { "splash.html", "splash.css", "splash.js" });
        CheckBrandCopies("VELOX.exe", v, "start/brand/", app, HostBrand);
        CheckServedFromMemory("setup", s, "ui/", "setup.velox.example", "index.html", SetupBrand);
        CheckServedFromMemory("VELOX.exe", v, "start/", "start.velox.example", "splash.html", HostBrand);
        CheckNativeSources(app);
        var core = InspectPe(Read(entries["Microsoft.Web.WebView2.Core.dll"]), "Microsoft.Web.WebView2.Core.dll");
        var wf = InspectPe(Read(entries["Microsoft.Web.WebView2.WinForms.dll"]), "Microsoft.Web.WebView2.WinForms.dll");
        Check(core.IlOnly && wf.IlOnly, "WebView2 managed DLLs are IL-only (loadable from memory by the setup)");

        // .NET Framework version: what VELOX.exe is built for = what VELOX.exe.config asks Windows for = what
        // the setup checks before it installs. A mismatch means Windows shows its own runtime dialog instead of VELOX.
        Check(v.TargetFramework == TargetFramework, $"VELOX.exe: built for {v.TargetFramework} (expected {TargetFramework})");
        var cfg = new System.Xml.XmlDocument();
        try { cfg.LoadXml(Encoding.UTF8.GetString(Read(entries["VELOX.exe.config"])).TrimStart('\uFEFF')); } catch (System.Xml.XmlException) { }
        string sku = (cfg.SelectSingleNode("/configuration/startup/supportedRuntime/@sku") as System.Xml.XmlAttribute)?.Value ?? "";
        Check(sku == v.TargetFramework, $"VELOX.exe.config: supportedRuntime sku \"{sku}\" = the framework VELOX.exe is built for");
        CheckSetupRuntimeGate(app, v.TargetFramework);

        // Every assembly the exes load at run time is in the payload, next to VELOX.exe, with exactly the
        // referenced identity (name, version, public key token): what the CLR probes for VELOX.exe and what the
        // setup's AssemblyResolve hands out from the payload. Framework assemblies come from Windows.
        var dlls = new Dictionary<string, PeInfo>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in entries.Values.Where(e => !e.FullName.Contains('/') && e.FullName.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)))
            dlls[Path.GetFileNameWithoutExtension(e.FullName)] = InspectPe(Read(e), e.FullName);
        CheckDependencies("VELOX.exe", v, dlls);
        CheckDependencies("setup", s, dlls);
        foreach (var kv in dlls) CheckDependencies(kv.Key + ".dll", kv.Value, dlls);
        foreach (var arch in new[] { ("win-x64", Machine.Amd64), ("win-x86", Machine.I386), ("win-arm64", Machine.Arm64) })
        {
            using var pe = new PEReader(new MemoryStream(Read(entries[$"runtimes/{arch.Item1}/native/WebView2Loader.dll"])));
            Check(pe.PEHeaders.CoffHeader.Machine == arch.Item2, $"WebView2Loader.dll {arch.Item1}: machine {pe.PEHeaders.CoffHeader.Machine}");
        }

        string sha = Convert.ToHexString(SHA256.HashData(setup)).ToLowerInvariant();
        Console.WriteLine($"sha256 {sha}");
        Console.WriteLine(_fails == 0 ? "VERIFY OK" : $"VERIFY FAILED: {_fails} check(s)");
        return _fails == 0 ? 0 : 1;
    }

    // ------------------------------------------------------------------ WebView2: content from memory, UDF in user folders
    //
    // The WebView2 browser process is untrusted-for-elevation: it does not get the host's administrator rights
    // (de-elevated / filtered token; Administrator Protection: another account). 1.2.0 put the pages and the
    // setup's user data folder into a private Admins-only temp folder - on a real Windows 11 PC the browser could
    // neither read the pages (ERR_FILE_NOT_FOUND) nor create its data folder (modal runtime error). Rules:
    //   - pages come from memory: EmbeddedSite + WebResourceRequested, never a folder mapping;
    //   - every user data folder comes from shared/WebViewData.cs, never from TempDir / CreatePrivateTempDir.

    /// <summary>Runs shared/EmbeddedSite.cs (the code both exes use) against the files embedded in the built exe.</summary>
    private static void CheckServedFromMemory(string label, PeInfo pe, string prefix, string host, string page, string[] brand)
    {
        var files = pe.Resources.Where(kv => kv.Key.StartsWith(prefix, StringComparison.Ordinal))
            .Select(kv => new KeyValuePair<string, byte[]>(kv.Key.Substring(prefix.Length), kv.Value)).ToList();
        var site = new EmbeddedSite(host, files);
        string o = "https://" + host + "/";
        int served = 0;
        foreach (var f in files)
        {
            var r = site.Resolve(o + f.Key, "GET");
            string want = EmbeddedSite.ContentType(f.Key);
            if (r != null && r.Status == 200 && want != null && r.ContentType == want && r.Body != null && r.Body.AsSpan().SequenceEqual(f.Value)
                && r.Headers.Contains("Content-Type: " + want) && r.Headers.Contains("X-Content-Type-Options: nosniff")) served++;
            else Check(false, $"{label}: {o}{f.Key} is served from memory with a known Content-Type");
        }
        Check(files.Count > 0 && served == files.Count, $"{label}: all {files.Count} embedded files under {prefix} served from memory as {o}* (status 200, identical bytes, Content-Type, nosniff)");
        Check(brand.All(b => site.Has("brand/" + b)), $"{label}: brand/ files reachable under {o}brand/");
        var html = site.Resolve(o + page + "?v=1&sound=0", "GET");
        Check(html != null && html.Status == 200 && html.ContentType == "text/html; charset=utf-8", $"{label}: {page} with a query string -> 200 text/html; charset=utf-8");
        var js = site.Resolve(o + "brand/intro.js", "GET");
        Check(js != null && js.ContentType == "text/javascript; charset=utf-8", $"{label}: ES modules as text/javascript");
        // the light's module worker: a worker script must come with a JavaScript MIME type or it does not start
        var worker = site.Resolve(o + "brand/light-worker.js", "GET");
        Check(worker != null && worker.Status == 200 && worker.ContentType == "text/javascript; charset=utf-8" && worker.Headers.Contains("X-Content-Type-Options: nosniff"),
            $"{label}: brand/light-worker.js (module worker) -> 200 text/javascript, nosniff");
        string csp = html == null || html.Body == null ? "" : Encoding.UTF8.GetString(html.Body);
        Check(Regex.IsMatch(csp, "http-equiv=\"Content-Security-Policy\"[^>]*script-src 'self'") && !csp.Contains("unsafe-inline") && !csp.Contains("unsafe-eval"),
            $"{label}: {page} keeps its strict CSP (script-src 'self', nothing unsafe)");
        string workerSrc = CspWorkerSource(csp, out string from);
        Check(workerSrc != null && Regex.IsMatch(workerSrc, "(^|\\s)'self'(\\s|$)"),
            $"{label}: {page}'s CSP lets the same-origin light worker start ({from ?? "no directive"}: {workerSrc ?? "-"})");
        var head = site.Resolve(o + page, "HEAD");
        Check(head != null && head.Status == 200 && head.Body == null, $"{label}: HEAD -> 200 without body");
        bool all404 = true;
        foreach (string bad in new[] { "", "nope.html", "brand/..%2f" + page, "brand%5c..%5c" + page, "brand//intro.js", "..%2f" + page, "%2e%2e%2f" + page,
                                       page + "%00", page + "%22", "%3c" + page, "brand%7c" + page, "C:/Windows/win.ini", "%2fetc/passwd", page.ToUpperInvariant(), "payload.zip", "brand/", "brand/../../" + page + "%2f.." })
        {
            var r = site.Resolve(o + bad, "GET");
            if (r == null || r.Status != 404) { all404 = false; Check(false, $"{label}: {o}{bad} -> 404 (got {(r == null ? "unhandled" : r.Status.ToString())})"); }
        }
        Check(all404, $"{label}: unknown names, encoded traversal (..%2f, %5c), absolute paths -> 404 (no file system behind it)");
        // plain dot segments are removed by the URL rules (RFC 3986, like the browser does before it asks):
        // they can only ever reach a file of the site itself
        bool inside = true;
        foreach (string dots in new[] { "../" + page, "%2e%2e/" + page, "./" + page, "brand/../" + page, "../../../" + page })
        {
            var r = site.Resolve(o + dots, "GET");
            if (r == null || !(r.Status == 404 || (r.Status == 200 && r.Body.AsSpan().SequenceEqual(html.Body)))) { inside = false; Check(false, $"{label}: {o}{dots} stays inside the site"); }
        }
        Check(inside, $"{label}: dot segments (../, %2e%2e/, ./) resolve inside the site or 404");
        var post = site.Resolve(o + page, "POST");
        Check(post != null && post.Status == 405, $"{label}: POST -> 405");
        Check(site.Resolve("https://evil.example/" + page, "GET") == null && site.Resolve("http://" + host + "/" + page, "GET") == null
              && site.Resolve("https://" + host + ":8443/" + page, "GET") == null, $"{label}: other origins are not answered");
    }

    /// <summary>
    /// The CSP source list that governs `new Worker(...)` (CSP3 fallback: worker-src, then child-src, then
    /// script-src, then default-src), taken from the page's Content-Security-Policy meta; null if none applies.
    /// </summary>
    internal static string CspWorkerSource(string html, out string directive)
    {
        directive = null;
        var meta = Regex.Match(html ?? "", "<meta[^>]*http-equiv=\"Content-Security-Policy\"[^>]*content=\"([^\"]*)\"", RegexOptions.IgnoreCase);
        if (!meta.Success) return null;
        var dirs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string part in meta.Groups[1].Value.Split(';'))
        {
            string d = part.Trim();
            if (d.Length == 0) continue;
            int sp = d.IndexOf(' ');
            string name = sp < 0 ? d : d.Substring(0, sp);
            if (!dirs.ContainsKey(name)) dirs[name] = sp < 0 ? "" : d.Substring(sp + 1).Trim();   // the first one wins
        }
        foreach (string name in new[] { "worker-src", "child-src", "script-src", "default-src" })
            if (dirs.TryGetValue(name, out string list)) { directive = name; return list; }
        return null;
    }

    private static void CheckNativeSources(string app)
    {
        var files = new List<(string name, string text)>();
        foreach (string dir in new[] { "host", "setup", "shared" })
            foreach (string f in Directory.GetFiles(Path.Combine(app, "native", dir), "*.cs", SearchOption.AllDirectories).OrderBy(x => x, StringComparer.Ordinal))
            {
                string rel = Path.GetRelativePath(app, f).Replace('\\', '/');
                if (rel.Contains("/bin/") || rel.Contains("/obj/")) continue;
                files.Add((rel, File.ReadAllText(f)));
            }
        var found = SourceViolations(files).Distinct().ToList();
        foreach (string v in found) Check(false, "native sources: " + v);
        Check(files.Count > 10 && found.Count == 0, $"native sources ({files.Count} files): no folder mapping for WebView2, every user data folder from WebViewData (never TempDir / CreatePrivateTempDir)");
        int creates = files.Sum(f => Regex.Matches(StripComments(f.text), @"CoreWebView2Environment\.CreateAsync\s*\(").Count);
        Check(creates >= 2, $"native sources: {creates} CoreWebView2Environment.CreateAsync calls checked (host + setup)");
        foreach (string front in new[] { "native/host/HostForm.cs", "native/setup/SetupWindow.cs" })
        {
            string t = files.FirstOrDefault(f => f.name == front).text ?? "";
            Check(t.Contains("AddWebResourceRequestedFilter(") && t.Contains("WebResourceRequested += ") && t.Contains("CreateWebResourceResponse(") && t.Contains("new MemoryStream("),
                $"{front}: pages answered from memory (filter + WebResourceRequested + CreateWebResourceResponse(MemoryStream))");
            // the light's module worker and its imports are requested by a dedicated worker: the Document source kind
            // covers the page "including dedicated workers and iframes" (WebView2 docs); a shared/service worker would not be
            Check(Regex.IsMatch(t, @"AddWebResourceRequestedFilter\([^;]*CoreWebView2WebResourceRequestSourceKinds\.(Document|All)\b"),
                $"{front}: the resource filter covers the page and its dedicated workers (source kind Document)");
        }
        // a page that does not load (Edge error page) or never reports in must not stay on screen
        string hostSrc = files.FirstOrDefault(f => f.name == "native/host/HostForm.cs").text ?? "";
        string setupSrc = files.FirstOrDefault(f => f.name == "native/setup/SetupWindow.cs").text ?? "";
        Check(hostSrc.Contains("OnSplashBroken(") && hostSrc.Contains("_splashWatchdog") && hostSrc.Contains("e.NavigationId == _splashNavId"),
            "native/host/HostForm.cs: a start screen that fails to load / never reports splash-ready is detected (no Edge error page left on screen)");
        Check(setupSrc.Contains("PageFailed(") && setupSrc.Contains("_pageWatchdog") && setupSrc.Contains("NavigationCompleted +="),
            "native/setup/SetupWindow.cs: a setup page that fails to load / never reports ready switches to the native window");

        // the guard itself: each rule must fire on a known-bad sample, and a good sample must pass
        string M = "SetVirtual" + "HostNameToFolderMapping";
        var samples = new (string what, string code, bool bad)[]
        {
            ("folder mapping", "_core." + M + "(\"h\", dir, CoreWebView2HostResourceAccessKind.Deny);", true),
            ("UDF in TempDir", "string udf = Path.Combine(Program.TempDir, \"webview2\");\nvar env = await CoreWebView2Environment.CreateAsync(null, udf, opts);", true),
            ("UDF expression", "var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Util.CreatePrivateTempDir(\"x\"), \"wv\"), opts);", true),
            ("UDF reassigned", "string udf = WebViewData.NewSetupRun(log);\nudf = Program.TempDir;\nvar env = await CoreWebView2Environment.CreateAsync(null, udf, opts);", true),
            ("default UDF", "await _web.EnsureCoreWebView2Async();", true),
            ("file URL", "_core.Navigate(\"file:///C:/x/index.html\");", true),
            ("good", "string udf = WebViewData.ForHost(dir, test, log);\nif (udf == null) return;\nvar env = await CoreWebView2Environment.CreateAsync(null, udf, opts);\nawait _web.EnsureCoreWebView2Async(env);", false),
        };
        bool guardOk = true;
        foreach (var x in samples)
        {
            bool fired = SourceViolations(new List<(string, string)> { ("sample.cs", x.code) }).Count > 0;
            if (fired != x.bad) { guardOk = false; Check(false, $"source guard self-test: '{x.what}' {(x.bad ? "not detected" : "flagged although fine")}"); }
        }
        Check(guardOk, $"source guard self-test: {samples.Length} samples (mapping, UDF in TempDir / private temp, reassigned, default UDF, file:// - and a good one)");
        // the CSP worker check itself: CSP3's fallback order, the first directive of a name wins
        string Meta(string c) => "<meta http-equiv=\"Content-Security-Policy\" content=\"" + c + "\">";
        bool cspOk = CspWorkerSource(Meta("default-src 'none'; script-src 'self'"), out string d1) == "'self'" && d1 == "script-src"
            && CspWorkerSource(Meta("default-src 'self'; worker-src 'none'"), out string d2) == "'none'" && d2 == "worker-src"
            && CspWorkerSource(Meta("default-src 'self'; child-src blob:; script-src 'self'"), out string d3) == "blob:" && d3 == "child-src"
            && CspWorkerSource(Meta("default-src 'self'"), out string d4) == "'self'" && d4 == "default-src"
            && CspWorkerSource("<p>no csp</p>", out _) == null;
        Check(cspOk, "CSP worker check self-test: worker-src > child-src > script-src > default-src");
    }

    /// <summary>Drops // comments (a "//" at the line start or after whitespace - not the one in "https://") and /* */ blocks.</summary>
    private static string StripComments(string code)
    {
        code = Regex.Replace(code, @"/\*.*?\*/", " ", RegexOptions.Singleline);
        return Regex.Replace(code, @"(?m)(^|\s)//.*$", "$1");
    }

    internal static List<string> SourceViolations(List<(string name, string text)> files)
    {
        var bad = new List<string>();
        string mapping = "SetVirtual" + "HostNameToFolderMapping";
        foreach (var (name, raw) in files)
        {
            if (raw.Contains(mapping)) bad.Add($"{name}: uses {mapping} - the WebView2 browser process may not be able to read that folder; serve from memory (EmbeddedSite)");
            string code = StripComments(raw);
            if (Regex.IsMatch(code, @"EnsureCoreWebView2Async\s*\(\s*(\)|null\b)")) bad.Add($"{name}: EnsureCoreWebView2Async without an environment (default user data folder next to the exe)");
            if (code.Contains("CreationProperties")) bad.Add($"{name}: CreationProperties - user data folders only through WebViewData");
            if (Regex.IsMatch(code, "\"file:", RegexOptions.IgnoreCase)) bad.Add($"{name}: a file: URL - the browser process must not read our files from disk");
            foreach (string line in code.Split('\n'))
                if (Regex.IsMatch(line, @"\b(TempDir|CreatePrivateTempDir)\b") && Regex.IsMatch(line, @"webview|udf|UserData", RegexOptions.IgnoreCase))
                    bad.Add($"{name}: user data folder derived from the private temp folder: {line.Trim()}");
            foreach (Match m in Regex.Matches(code, @"CoreWebView2Environment\.CreateAsync\s*\("))
            {
                List<string> args = CallArguments(code, m.Index + m.Length);
                if (args.Count < 2) { bad.Add($"{name}: CoreWebView2Environment.CreateAsync without an explicit user data folder"); continue; }
                string udf = args[1].Trim();
                if (!Regex.IsMatch(udf, @"^[A-Za-z_]\w*$")) { bad.Add($"{name}: CreateAsync user data folder must be a variable set from WebViewData, not '{udf}'"); continue; }
                var sets = Regex.Matches(code, @"(?<![\w.=!<>])" + udf + @"\s*=(?!=)\s*([^;]+);").Select(a => a.Groups[1].Value.Trim()).ToList();
                if (sets.Count == 0) bad.Add($"{name}: CreateAsync user data folder '{udf}' is never set from WebViewData");
                foreach (string rhs in sets)
                    if (!rhs.StartsWith("WebViewData.", StringComparison.Ordinal) && rhs != "null")
                        bad.Add($"{name}: user data folder '{udf}' = {rhs} - only WebViewData may choose it");
                if (sets.Count > 0 && sets.All(r => r == "null")) bad.Add($"{name}: user data folder '{udf}' is never set from WebViewData");
            }
            // .NET Framework's System.IO.Path throws on " < > | NUL - which a URL can carry; this check runs on .NET 8,
            // where it does not throw, so the request path must never reach a Path API in the first place
            if (name.EndsWith("/EmbeddedSite.cs", StringComparison.Ordinal) && Regex.IsMatch(code, @"\bPath\.\w+\s*\("))
                bad.Add($"{name}: System.IO.Path on a request path (throws on .NET Framework for \" < > | NUL)");
            if (name.EndsWith("/WebViewData.cs", StringComparison.Ordinal) && Regex.IsMatch(code, @"\b(TempDir|CreatePrivateTempDir|SetAccessRuleProtection)\b"))
                bad.Add($"{name}: WebViewData must not use the private temp folder or protected ACLs");
        }
        return bad;
    }

    /// <summary>The top-level comma separated arguments of a call whose "(" ends right before <paramref name="start"/>.</summary>
    private static List<string> CallArguments(string code, int start)
    {
        var args = new List<string>();
        int depth = 0, from = start;
        bool inStr = false;
        for (int i = start; i < code.Length; i++)
        {
            char c = code[i];
            if (inStr) { if (c == '\\') i++; else if (c == '"') inStr = false; continue; }
            if (c == '"') { inStr = true; continue; }
            if (c == '(' || c == '[' || c == '{') depth++;
            else if (c == ')' || c == ']' || c == '}')
            {
                if (depth == 0) { string last = code.Substring(from, i - from); if (args.Count > 0 || last.Trim().Length > 0) args.Add(last); return args; }
                depth--;
            }
            else if (c == ',' && depth == 0) { args.Add(code.Substring(from, i - from)); from = i + 1; }
        }
        return args;
    }

    // The brand kit (velox-tweaker/brand) is the single source of truth: each surface embeds byte-identical
    // copies of exactly the runtime files it needs (the lists of tools/sync-brand.mjs) and nothing else.
    // light-worker.js is runtime: intro.js starts it as a module worker (new URL('./light-worker.js', import.meta.url))
    private static readonly string[] HostBrand = { "glyphs.js", "intro.css", "intro.js", "light-worker.js", "sound.js", "tokens.css" };
    private static readonly string[] SetupBrand = { "glyphs.js", "intro.css", "intro.js", "kit.css", "light-worker.js", "sound.js", "ticks.js", "tokens.css" };

    private static void CheckBrandCopies(string label, PeInfo pe, string prefix, string app, string[] files)
    {
        var embedded = pe.Resources.Keys.Where(k => k.StartsWith(prefix, StringComparison.Ordinal)).Select(k => k.Substring(prefix.Length)).OrderBy(k => k, StringComparer.Ordinal).ToList();
        Check(embedded.SequenceEqual(files.OrderBy(f => f, StringComparer.Ordinal)), $"{label}: brand files embedded under {prefix} = {string.Join(", ", files)} (found {string.Join(", ", embedded)})");
        int same = 0;
        foreach (string f in files)
        {
            string src = Path.Combine(app, "brand", f);
            if (!File.Exists(src)) { Check(false, $"{label}: brand/{f} exists"); continue; }
            if (pe.Resources.TryGetValue(prefix + f, out byte[] b) && b.AsSpan().SequenceEqual(File.ReadAllBytes(src))) same++;
            else Check(false, $"{label}: embedded {prefix}{f} is byte-identical to brand/{f}");
        }
        Check(same == files.Length, $"{label}: all {files.Length} embedded brand files byte-identical to brand/ (SHA-256 {ShortHash(files.Select(f => Path.Combine(app, "brand", f)))})");
    }

    private static void CheckEmbeddedFiles(string label, PeInfo pe, string prefix, string app, string dir, string[] files)
    {
        foreach (string f in files)
        {
            string src = Path.Combine(dir, f);
            bool ok = File.Exists(src) && pe.Resources.TryGetValue(prefix + f, out byte[] b) && b.AsSpan().SequenceEqual(File.ReadAllBytes(src));
            Check(ok, $"{label}: embedded {prefix}{f} = {Path.GetRelativePath(app, src).Replace('\\', '/')}");
        }
    }

    private static string ShortHash(IEnumerable<string> paths)
    {
        using var sha = SHA256.Create();
        foreach (string p in paths.Where(File.Exists)) { byte[] b = File.ReadAllBytes(p); sha.TransformBlock(b, 0, b.Length, null, 0); }
        sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
        return Convert.ToHexString(sha.Hash).ToLowerInvariant().Substring(0, 12);
    }

    private const string TargetFramework = ".NETFramework,Version=v4.7.2";
    // "Release" values of HKLM\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full (minimum per version)
    private static readonly Dictionary<string, int> FrameworkRelease = new Dictionary<string, int>
    {
        [".NETFramework,Version=v4.6.2"] = 394802, [".NETFramework,Version=v4.7"] = 460798, [".NETFramework,Version=v4.7.1"] = 461308,
        [".NETFramework,Version=v4.7.2"] = 461808, [".NETFramework,Version=v4.8"] = 528040, [".NETFramework,Version=v4.8.1"] = 533320,
    };
    private static readonly HashSet<string> FrameworkKeyTokens = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "b77a5c561934e089", "b03f5f7f11d50a3a", "31bf3856ad364e35", "cc7b13ffcd2ddd51"
    };

    /// <summary>The setup's .NET check (Util.NetFrameworkMinRelease) must match the framework VELOX.exe needs.</summary>
    private static void CheckSetupRuntimeGate(string app, string tfm)
    {
        string src = Path.Combine(app, "native", "shared", "Common.cs");
        var m = File.Exists(src) ? Regex.Match(File.ReadAllText(src), @"NetFrameworkMinRelease\s*=\s*(\d+)") : Match.Empty;
        bool known = FrameworkRelease.TryGetValue(tfm ?? "", out int need);
        Check(m.Success && known && int.Parse(m.Groups[1].Value) == need,
            $"setup checks .NET Release >= {(m.Success ? m.Groups[1].Value : "?")} = what {tfm} needs ({(known ? need.ToString() : "?")})");
    }

    private static void CheckDependencies(string label, PeInfo pe, Dictionary<string, PeInfo> dlls)
    {
        foreach (var r in pe.References)
        {
            if (FrameworkKeyTokens.Contains(r.Token)) continue;
            bool ok = dlls.TryGetValue(r.Name, out var d) && d.Name == r.Name && d.Version == r.Version && string.Equals(d.Token, r.Token, StringComparison.OrdinalIgnoreCase);
            Check(ok, $"{label} -> {r.Name} {r.Version} ({r.Token}): in the payload next to VELOX.exe" + (d != null && !ok ? $" (found {d.Name} {d.Version} {d.Token})" : ""));
        }
    }

    // Windows' side-by-side loader parses the embedded manifest (and <exe>.config) strictly before the
    // process starts: malformed XML - for example "--" inside a comment - makes Windows refuse to start
    // the exe with "Die Side-by-Side-Konfiguration ist ungültig" (ERROR_SXS_CANT_GEN_ACTCTX, 14001).
    // The C# compiler embeds the file without looking at it, so check it here.
    private static XmlDocument StrictXml(string xml, string what)
    {
        try
        {
            var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
            var doc = new XmlDocument { XmlResolver = null };
            using (var r = XmlReader.Create(new StringReader(xml.TrimStart('\uFEFF')), settings)) doc.Load(r);
            Check(true, what + ": well-formed XML");
            return doc;
        }
        catch (XmlException ex)
        {
            Check(false, what + ": well-formed XML (" + ex.Message + ")");
            return null;
        }
    }

    private static void CheckManifestXml(string xml, string what)
    {
        var doc = StrictXml(xml, what);
        if (doc == null) return;
        var root = doc.DocumentElement;
        Check(root.LocalName == "assembly" && root.NamespaceURI == "urn:schemas-microsoft-com:asm.v1" && root.GetAttribute("manifestVersion") == "1.0",
            what + ": root <assembly manifestVersion=\"1.0\"> in urn:schemas-microsoft-com:asm.v1");
        var ns = new XmlNamespaceManager(doc.NameTable);
        ns.AddNamespace("a1", "urn:schemas-microsoft-com:asm.v1");
        ns.AddNamespace("a3", "urn:schemas-microsoft-com:asm.v3");
        var id = root.SelectSingleNode("a1:assemblyIdentity", ns) as XmlElement;
        Check(id != null && Regex.IsMatch(id.GetAttribute("version"), @"^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$") && id.GetAttribute("name").Length > 0,
            what + ": assemblyIdentity with name and a four-part numeric version");
        var levels = doc.SelectNodes("//a3:requestedExecutionLevel", ns);
        Check(levels.Count == 1 && new[] { "asInvoker", "requireAdministrator", "highestAvailable" }.Contains(((XmlElement)levels[0]).GetAttribute("level")),
            what + ": exactly one valid requestedExecutionLevel");
        Check(doc.SelectNodes("//comment()").Cast<XmlNode>().All(c => !c.Value.Contains("--")), what + ": no \"--\" inside comments");
    }

    private static void CheckConfigXml(string xml, string what)
    {
        var doc = StrictXml(xml, what);
        if (doc == null) return;
        Check(doc.DocumentElement.LocalName == "configuration" && doc.SelectSingleNode("/configuration/startup/supportedRuntime[@version='v4.0']") != null,
            what + ": <configuration><startup><supportedRuntime version=\"v4.0\">");
    }

    private static byte[] Read(ZipArchiveEntry e)
    {
        using var s = e.Open();
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        return ms.ToArray();
    }

    private sealed class PeInfo
    {
        public string Manifest = "";
        public bool HasIcon, HasVersion, IlOnly, ReferencesWebView2Files;
        public string AssemblyVersion = "", Informational = "", TargetFramework = "";
        public string Name = "", Token = "";
        public Version Version;
        public List<(string Name, Version Version, string Token)> References = new List<(string, Version, string)>();
        public Dictionary<string, byte[]> Resources = new Dictionary<string, byte[]>(StringComparer.Ordinal);
    }

    private static PeInfo InspectPe(byte[] image, string label)
    {
        var info = new PeInfo();
        using var pe = new PEReader(new MemoryStream(image));
        var h = pe.PEHeaders;
        if (h.CorHeader != null)
        {
            var flags = h.CorHeader.Flags;
            info.IlOnly = (flags & CorFlags.ILOnly) != 0;
            bool req32 = (flags & CorFlags.Requires32Bit) != 0, pref32 = (flags & CorFlags.Prefers32Bit) != 0;
            if (label.EndsWith(".exe"))
            {
                Check(info.IlOnly && !req32 && !pref32 && h.CoffHeader.Machine == Machine.I386, $"{label}: AnyCPU, IL-only, no 32-bit preference (64-bit on 64-bit Windows)");
            }
            var md = pe.GetMetadataReader();
            var asm = md.GetAssemblyDefinition();
            info.AssemblyVersion = asm.Version.ToString();
            info.Name = md.GetString(asm.Name);
            info.Version = asm.Version;
            info.Token = TokenOf(md.GetBlobBytes(asm.PublicKey), false);
            foreach (var rh in md.AssemblyReferences)
            {
                var r = md.GetAssemblyReference(rh);
                bool full = (r.Flags & System.Reflection.AssemblyFlags.PublicKey) != 0;
                info.References.Add((md.GetString(r.Name), r.Version, TokenOf(md.GetBlobBytes(r.PublicKeyOrToken), !full)));
            }
            foreach (var ca in asm.GetCustomAttributes())
            {
                var attr = md.GetCustomAttribute(ca);
                if (attr.Constructor.Kind != HandleKind.MemberReference) continue;
                var mref = md.GetMemberReference((MemberReferenceHandle)attr.Constructor);
                if (mref.Parent.Kind != HandleKind.TypeReference) continue;
                string tn = md.GetString(md.GetTypeReference((TypeReferenceHandle)mref.Parent).Name);
                if (tn == "AssemblyInformationalVersionAttribute")
                {
                    var br = md.GetBlobReader(attr.Value);
                    br.ReadUInt16();
                    info.Informational = br.ReadSerializedString();
                }
                if (tn == "TargetFrameworkAttribute")
                {
                    var br = md.GetBlobReader(attr.Value);
                    br.ReadUInt16();
                    info.TargetFramework = br.ReadSerializedString();
                }
            }
            // managed resources
            var resDir = h.CorHeader.ResourcesDirectory;
            foreach (var rh in md.ManifestResources)
            {
                var r = md.GetManifestResource(rh);
                if (!r.Implementation.IsNil) continue;
                var block = pe.GetSectionData(resDir.RelativeVirtualAddress + (int)r.Offset);
                var reader = block.GetReader();
                int len = reader.ReadInt32();
                info.Resources[md.GetString(r.Name)] = reader.ReadBytes(len);
            }
            foreach (var fh in md.AssemblyFiles) info.ReferencesWebView2Files = true;
        }
        // Win32 resources (.rsrc): type 24 = manifest, 14 = group icon, 16 = version
        var dir = h.PEHeader.ResourceTableDirectory;
        if (dir.Size > 0)
        {
            var data = pe.GetSectionData(dir.RelativeVirtualAddress);
            var all = data.GetContent();
            foreach (var (type, rva, size) in ResourceLeaves(all, dir.RelativeVirtualAddress))
            {
                if (type == 24)
                {
                    var bytes = pe.GetSectionData(rva).GetContent(0, size);
                    info.Manifest = Encoding.UTF8.GetString(bytes.ToArray());
                }
                if (type == 14) info.HasIcon = true;
                if (type == 16) info.HasVersion = true;
            }
        }
        return info;
    }

    /// <summary>Public key token (hex): the blob itself when it is a token, else the last 8 bytes of SHA-1(key) reversed.</summary>
    private static string TokenOf(byte[] blob, bool isToken)
    {
        if (blob == null || blob.Length == 0) return "";
        byte[] t = isToken ? blob : SHA1.HashData(blob).Skip(12).Reverse().ToArray();
        return Convert.ToHexString(t).ToLowerInvariant();
    }

    /// <summary>Walks IMAGE_RESOURCE_DIRECTORY (type -> name -> language) and yields data entries.</summary>
    private static IEnumerable<(int type, int rva, int size)> ResourceLeaves(System.Collections.Immutable.ImmutableArray<byte> rsrc, int baseRva)
    {
        var b = rsrc.ToArray();
        int U16(int o) => BitConverter.ToUInt16(b, o);
        int I32(int o) => BitConverter.ToInt32(b, o);
        IEnumerable<(int id, int off, bool isDir)> Entries(int dirOff)
        {
            int named = U16(dirOff + 12), ids = U16(dirOff + 14);
            for (int i = 0; i < named + ids; i++)
            {
                int e = dirOff + 16 + i * 8;
                int nameOrId = I32(e), off = I32(e + 4);
                yield return (nameOrId & 0x7FFFFFFF, off & 0x7FFFFFFF, (off & unchecked((int)0x80000000)) != 0);
            }
        }
        foreach (var t in Entries(0))
        {
            if (!t.isDir) continue;
            foreach (var n in Entries(t.off))
            {
                if (!n.isDir) continue;
                foreach (var l in Entries(n.off))
                {
                    if (l.isDir) continue;
                    yield return (t.id, I32(l.off), I32(l.off + 4));
                }
            }
        }
    }
}
