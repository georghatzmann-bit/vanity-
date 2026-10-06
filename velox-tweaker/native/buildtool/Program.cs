// VeloxBuildTool - build-machine helper for native/build.sh and native/Build.ps1.
//
//   pack   --app <velox-tweaker> --host <VELOX.exe build dir> --out <payload.zip>
//          Deterministic zip (sorted entries, fixed timestamps) of everything the installed app needs.
//   verify --setup <VeloxSetup.exe> --app <velox-tweaker> [--max-mb 3]
//          Opens the built exe and checks manifests, resources, version, payload content, size budget.
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
        Check(v.Resources.ContainsKey("splash.html"), "VELOX.exe: embedded start screen splash.html");
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
