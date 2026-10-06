// One virtual https origin served from MEMORY: the installer UI (https://setup.velox.example/) and VELOX.exe's
// start screen (https://start.velox.example/) are embedded resources and answered from the WebView2
// WebResourceRequested event. Nothing is written to disk and the browser process never reads our content
// from a folder: the WebView2 browser process does not run with the host's administrator rights (current
// runtimes de-elevate it; with Windows 11 Administrator Protection it even runs as another account), so a
// folder that only Administrators may read - the right protection for files the ELEVATED process loads -
// is invisible to it (1.2.0: ERR_FILE_NOT_FOUND / "Datenverzeichnis konnte nicht erstellt werden").
//
// No WebView2 types here (the setup keeps every WebView2-typed line in SetupWindow.cs); the front ends only
// glue Resolve() to CoreWebView2Environment.CreateWebResourceResponse. buildtool verify runs this same file
// against the resources inside the finished exes.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;

namespace Velox.Native
{
    internal sealed class EmbeddedSite
    {
        /// <summary>One answer: status line, raw header block ("Name: value" lines) and the body (null for HEAD / none).</summary>
        internal sealed class Reply
        {
            public int Status;
            public string Reason;
            public string Headers;
            public byte[] Body;
            public string ContentType;
        }

        private readonly Dictionary<string, byte[]> _files = new Dictionary<string, byte[]>(StringComparer.Ordinal);

        public string HostName { get; private set; }
        /// <summary>"https://&lt;host&gt;/"</summary>
        public string Origin { get; private set; }
        /// <summary>The URI filter for AddWebResourceRequestedFilter: everything below the origin.</summary>
        public string Filter { get { return Origin + "*"; } }
        public int Count { get { return _files.Count; } }

        /// <summary>Every embedded resource "&lt;prefix&gt;&lt;path&gt;" of the assembly becomes "https://&lt;host&gt;/&lt;path&gt;".</summary>
        public EmbeddedSite(string hostName, Assembly asm, string resourcePrefix)
        {
            Init(hostName);
            foreach (string name in asm.GetManifestResourceNames())
            {
                if (!name.StartsWith(resourcePrefix, StringComparison.Ordinal)) continue;
                string rel = name.Substring(resourcePrefix.Length);
                if (!IsPlainPath(rel)) continue;
                using (Stream s = asm.GetManifestResourceStream(name))
                {
                    if (s == null) continue;
                    var ms = new MemoryStream();
                    s.CopyTo(ms);
                    _files[rel] = ms.ToArray();
                }
            }
        }

        /// <summary>From path -&gt; bytes pairs (relative, "/" separated). Used by buildtool verify.</summary>
        public EmbeddedSite(string hostName, IEnumerable<KeyValuePair<string, byte[]>> files)
        {
            Init(hostName);
            foreach (var kv in files) if (IsPlainPath(kv.Key) && kv.Value != null) _files[kv.Key] = kv.Value;
        }

        private void Init(string hostName)
        {
            HostName = hostName.ToLowerInvariant();
            Origin = "https://" + HostName + "/";
        }

        public bool Has(string rel) { return rel != null && _files.ContainsKey(rel); }

        /// <summary>
        /// The answer for one request, or null when the URI is not on this origin (the caller then leaves the
        /// request alone). Only exact names of embedded files are served: no file system, so no path traversal;
        /// anything else is 404, a method other than GET / HEAD is 405.
        /// </summary>
        public Reply Resolve(string uri, string method)
        {
            Uri u;
            if (string.IsNullOrEmpty(uri) || !Uri.TryCreate(uri, UriKind.Absolute, out u)) return null;
            if (!string.Equals(u.Scheme, "https", StringComparison.OrdinalIgnoreCase)) return null;
            if (!string.Equals(u.Host, HostName, StringComparison.OrdinalIgnoreCase) || !u.IsDefaultPort) return null;
            string m = (method ?? "GET").ToUpperInvariant();
            if (m != "GET" && m != "HEAD") return Error(405, "Method Not Allowed", "Allow: GET, HEAD");
            string rel;
            try { rel = Uri.UnescapeDataString(u.AbsolutePath ?? ""); } catch (Exception) { return Error(404, "Not Found", null); }
            if (rel.StartsWith("/", StringComparison.Ordinal)) rel = rel.Substring(1);
            // IsPlainPath first: on .NET Framework the path APIs throw on characters such as " < > | or NUL
            if (!IsPlainPath(rel)) return Error(404, "Not Found", null);
            byte[] body;
            string type = ContentType(rel);
            if (type == null || !_files.TryGetValue(rel, out body)) return Error(404, "Not Found", null);
            return new Reply
            {
                Status = 200,
                Reason = "OK",
                ContentType = type,
                Headers = "Content-Type: " + type + "\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff",
                Body = m == "HEAD" ? null : body
            };
        }

        private static Reply Error(int status, string reason, string extraHeader)
        {
            return new Reply
            {
                Status = status,
                Reason = reason,
                ContentType = "text/plain; charset=utf-8",
                Headers = "Content-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff" + (extraHeader != null ? "\r\n" + extraHeader : ""),
                Body = System.Text.Encoding.UTF8.GetBytes(status + " " + reason)
            };
        }

        /// <summary>Content-Type by extension; null = not a type this site serves (answered with 404).</summary>
        public static string ContentType(string rel)
        {
            // no Path.GetExtension: .NET Framework throws ArgumentException for " < > | NUL in a path
            rel = rel ?? "";
            int dot = rel.LastIndexOf('.'), slash = rel.LastIndexOf('/');
            string ext = dot > slash && dot >= 0 ? rel.Substring(dot).ToLowerInvariant() : "";
            switch (ext)
            {
                case ".html": case ".htm": return "text/html; charset=utf-8";
                case ".js": case ".mjs": return "text/javascript; charset=utf-8";   // ES modules need a JavaScript MIME type
                case ".css": return "text/css; charset=utf-8";
                case ".json": return "application/json; charset=utf-8";
                case ".svg": return "image/svg+xml";
                case ".png": return "image/png";
                case ".ico": return "image/x-icon";
                case ".woff2": return "font/woff2";
                default: return null;
            }
        }

        /// <summary>A relative "a/b.c" path: no empty or dot segments, no backslash, colon, percent or control characters.</summary>
        internal static bool IsPlainPath(string rel)
        {
            if (string.IsNullOrEmpty(rel) || rel.Length > 200) return false;
            foreach (char c in rel)
                if (c < 0x20 || c == '\\' || c == ':' || c == '%' || c == '?' || c == '#' || c == '*' || c == '"' || c == '<' || c == '>' || c == '|') return false;
            foreach (string seg in rel.Split('/'))
                if (seg.Length == 0 || seg == "." || seg == "..") return false;
            return true;
        }
    }
}
