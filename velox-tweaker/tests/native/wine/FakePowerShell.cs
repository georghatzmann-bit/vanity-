// Stand-in for %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe inside the Wine prefix of
// tests/native/wine-smoke.sh. Wine has no real Windows PowerShell; this fake speaks the VELOX.exe <-> Velox.ps1
// stdout protocol (docs/ARCHITECTURE.md §11) so the native host's protocol handling runs on a real CLR.
//
// Behaviour is picked with the environment variable VELOX_FAKE_PS (VELOX.exe passes its environment on):
//   exit0    print nothing, exit 0                     (= what Wine's own powershell.exe stub does)
//   error    print "VELOX_ERROR <German text with umlauts>" in the OEM code page, exit 2
//   ready    serve 127.0.0.1:<random port>, print "VELOX_READY http://127.0.0.1:<port>/?t=<token>",
//            exit on POST /api/shutdown, when the host process (-HostPid) is gone, or after
//            VELOX_FAKE_PS_LIFETIME seconds (default 600)
//   running  print "VELOX_RUNNING http://127.0.0.1:<port>/?t=<token>", exit 0
//   badurl   print "VELOX_READY https://example.com/?t=abc" (must be rejected), exit 1
//   hang     print nothing, never exit                 (start timeout path)
//   blocked  print PowerShell's "running scripts is disabled" error on stderr, exit 1 (Group Policy / AV)
// Every start appends one line "<pid>|<command line>" to the file named by VELOX_FAKE_PS_LOG (if set).
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

internal static class FakePowerShell
{
    private static Stream _out;
    private static Encoding _oem;

    private static int Main(string[] args)
    {
        string mode = (Environment.GetEnvironmentVariable("VELOX_FAKE_PS") ?? "exit0").Trim().ToLowerInvariant();
        string log = Environment.GetEnvironmentVariable("VELOX_FAKE_PS_LOG");
        try
        {
            if (!string.IsNullOrEmpty(log))
                File.AppendAllText(log, Process.GetCurrentProcess().Id + "|" + mode + "|" + Environment.CommandLine + Environment.NewLine, new UTF8Encoding(false));
        }
        catch (Exception) { }

        // Windows PowerShell 5.1 writes redirected stdout in [Console]::OutputEncoding = the console code page,
        // which starts as the system's OEM code page (GetOEMCP)
        try { _oem = Encoding.GetEncoding((int)GetOEMCP()); } catch (Exception) { _oem = Encoding.ASCII; }
        _out = Console.OpenStandardOutput();

        int hostPid = 0;
        for (int i = 0; i < args.Length - 1; i++)
            if (string.Equals(args[i], "-HostPid", StringComparison.OrdinalIgnoreCase)) int.TryParse(args[i + 1], out hostPid);

        switch (mode)
        {
            case "error":
                Line("Lade VELOX ...");
                Line("VELOX_ERROR Für VELOX fehlt ein Baustein: Größe übersteigt das Maß (Testtext äöüß).");
                return 2;
            case "running":
                Line("VELOX_RUNNING http://127.0.0.1:" + FreePort() + "/?t=fakeRunningToken1");
                return 0;
            case "badurl":
                Line("VELOX_READY https://example.com/?t=abc");
                Line("VELOX_READY http://127.0.0.1:80/");
                return 1;
            case "blocked":
                {
                    byte[] e = _oem.GetBytes("File C:\\Program Files\\VELOX\\Velox.ps1 cannot be loaded because running scripts is disabled on this system.\r\n" +
                        "    + CategoryInfo          : SecurityError: (:) [], ParentContainsErrorRecordException\r\n" +
                        "    + FullyQualifiedErrorId : UnauthorizedAccess\r\n");
                    using (Stream err = Console.OpenStandardError()) { err.Write(e, 0, e.Length); err.Flush(); }
                    return 1;
                }
            case "hang":
                Thread.Sleep(Timeout.Infinite);
                return 0;
            case "ready":
                return Serve(hostPid);
            default:
                return 0;
        }
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern uint GetOEMCP();

    private static void Line(string s)
    {
        byte[] b = _oem.GetBytes(s + "\r\n");
        _out.Write(b, 0, b.Length);
        _out.Flush();
    }

    private static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        int p = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return p;
    }

    private static int Serve(int hostPid)
    {
        int lifetime = 600;
        int.TryParse(Environment.GetEnvironmentVariable("VELOX_FAKE_PS_LIFETIME") ?? "", out lifetime);
        if (lifetime <= 0) lifetime = 600;
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        Line("Server startet ...");
        foreach (string k in new[] { "core", "system", "catalog", "server" }) Line("VELOX_STATUS " + k);
        Line("VELOX_READY http://127.0.0.1:" + port + "/?t=fakeToken123");
        var sw = Stopwatch.StartNew();
        bool stop = false;
        while (!stop && sw.Elapsed.TotalSeconds < lifetime)
        {
            if (hostPid > 0 && !Alive(hostPid)) { Line("Host weg - Ende."); break; }
            if (!listener.Pending()) { Thread.Sleep(100); continue; }
            using (TcpClient c = listener.AcceptTcpClient())
            {
                try
                {
                    c.ReceiveTimeout = 2000;
                    NetworkStream ns = c.GetStream();
                    var req = new StringBuilder();
                    var buf = new byte[4096];
                    int n = ns.Read(buf, 0, buf.Length);
                    if (n > 0) req.Append(Encoding.ASCII.GetString(buf, 0, n));
                    string first = req.ToString().Split('\n')[0].Trim();
                    string body = "{\"ok\":true,\"busy\":false}";
                    string type = "application/json";
                    if (first.StartsWith("POST /api/shutdown", StringComparison.Ordinal)) stop = true;
                    else if (first.StartsWith("GET /", StringComparison.Ordinal) && !first.StartsWith("GET /api/", StringComparison.Ordinal))
                    {
                        body = "<!doctype html><html><body style=\"background:#0F1115;color:#E8EAF0\">VELOX (Fake-Backend)</body></html>";
                        type = "text/html; charset=utf-8";
                    }
                    byte[] payload = Encoding.UTF8.GetBytes(body);
                    byte[] head = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: " + type + "\r\nContent-Length: " + payload.Length + "\r\nConnection: close\r\n\r\n");
                    ns.Write(head, 0, head.Length);
                    ns.Write(payload, 0, payload.Length);
                    Line("request: " + first);
                }
                catch (Exception ex) { Line("request failed: " + ex.Message); }
            }
        }
        listener.Stop();
        return 0;
    }

    private static bool Alive(int pid)
    {
        try { using (Process p = Process.GetProcessById(pid)) return !p.HasExited; }
        catch (Exception) { return false; }
    }
}
