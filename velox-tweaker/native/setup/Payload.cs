// The app payload: a zip embedded as the managed resource "payload.zip" (built by native/build.sh).
// It also carries the WebView2 DLLs the setup itself uses for its own window (loaded from memory).
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Reflection;

namespace Velox.Setup
{
    internal static class Payload
    {
        public const string ResourceName = "payload.zip";
        private static byte[] _zip;
        private static readonly object _lock = new object();

        private static byte[] ZipBytes()
        {
            lock (_lock)
            {
                if (_zip != null) return _zip;
                using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName))
                {
                    if (s == null) throw new InvalidOperationException("Das Installationspaket ist beschädigt (payload.zip fehlt).");
                    var ms = new MemoryStream();
                    s.CopyTo(ms);
                    _zip = ms.ToArray();
                }
                return _zip;
            }
        }

        public static ZipArchive Open()
        {
            return new ZipArchive(new MemoryStream(ZipBytes(), false), ZipArchiveMode.Read, false);
        }

        /// <summary>Bytes of one entry ("/" separated path) or null.</summary>
        public static byte[] Read(string entryName)
        {
            using (ZipArchive z = Open())
            {
                ZipArchiveEntry e = z.GetEntry(entryName);
                if (e == null) return null;
                using (Stream s = e.Open())
                {
                    var ms = new MemoryStream();
                    s.CopyTo(ms);
                    return ms.ToArray();
                }
            }
        }

        /// <summary>All file entries (relative paths with "/") and the total unpacked size.</summary>
        public static List<string> Files(out long totalBytes)
        {
            totalBytes = 0;
            var list = new List<string>();
            using (ZipArchive z = Open())
            {
                foreach (ZipArchiveEntry e in z.Entries)
                {
                    if (e.FullName.EndsWith("/", StringComparison.Ordinal)) continue;
                    list.Add(e.FullName);
                    totalBytes += e.Length;
                }
            }
            return list;
        }

        /// <summary>Text of a small embedded resource (the setup UI files), or null.</summary>
        public static byte[] Resource(string name)
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
            {
                if (s == null) return null;
                var ms = new MemoryStream();
                s.CopyTo(ms);
                return ms.ToArray();
            }
        }
    }
}
