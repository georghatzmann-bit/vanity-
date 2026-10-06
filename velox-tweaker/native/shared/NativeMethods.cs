// Win32 declarations shared by VELOX.exe and VeloxSetup.exe.
// Every call site wraps these in try/catch: a missing export (older Windows) must never crash the app.
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Velox.Native
{
    internal static class NativeMethods
    {
        // ------------------------------------------------------------ window messages / constants
        public const int WM_NCLBUTTONDOWN = 0x00A1;
        public const int HTCAPTION = 2;
        public const int WM_DPICHANGED = 0x02E0;
        public const int WM_SYSCOMMAND = 0x0112;
        public const int SW_RESTORE = 9;
        public const int SW_SHOW = 5;
        public static readonly IntPtr HWND_BROADCAST = new IntPtr(0xFFFF);
        public const int ASFW_ANY = -1;
        public const uint MSGFLT_ALLOW = 1;
        public const uint SWP_NOZORDER = 0x0004;
        public const uint SWP_NOACTIVATE = 0x0010;

        // DWM
        public const int DWMWA_USE_IMMERSIVE_DARK_MODE_OLD = 19;   // Windows 10 1809 - 1909
        public const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;       // Windows 10 2004+ / 11
        public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;      // Windows 11
        public const int DWMWA_BORDER_COLOR = 34;                  // Windows 11
        public const int DWMWA_CAPTION_COLOR = 35;                 // Windows 11
        public const int DWMWCP_ROUND = 2;

        [DllImport("dwmapi.dll", PreserveSig = true)]
        public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint RegisterWindowMessage(string lpString);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool ChangeWindowMessageFilterEx(IntPtr hwnd, uint message, uint action, IntPtr pChangeFilterStruct);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool AllowSetForegroundWindow(int dwProcessId);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        // ------------------------------------------------------------ DPI
        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr hwnd);            // Windows 10 1607+

        [DllImport("shcore.dll")]
        public static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY); // 8.1+

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X, Y; }

        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
        public const uint MONITOR_DEFAULTTONEAREST = 2;

        [DllImport("user32.dll")]
        public static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("gdi32.dll")]
        public static extern int GetDeviceCaps(IntPtr hdc, int index);
        public const int LOGPIXELSX = 88;

        // ------------------------------------------------------------ job objects
        public const int JobObjectExtendedLimitInformation = 9;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint cbInfo);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateJobObject(IntPtr hJob, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        // ------------------------------------------------------------ desktop user (owner of the shell window)
        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        public const uint TOKEN_QUERY = 0x0008;
        public const int TokenUser = 1;

        [DllImport("user32.dll")]
        public static extern IntPtr GetShellWindow();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returnLength);

        // the signed-in user of this session (fallback when the shell's token cannot be opened)
        public const int WTSUserName = 5, WTSDomainName = 7;
        public static readonly IntPtr WTS_CURRENT_SERVER_HANDLE = IntPtr.Zero;
        public const int WTS_CURRENT_SESSION = -1;

        [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool WTSQuerySessionInformationW(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytes);

        [DllImport("wtsapi32.dll")]
        public static extern void WTSFreeMemory(IntPtr memory);

        // the system's OEM code page (what a new console starts with)
        [DllImport("kernel32.dll")]
        public static extern uint GetOEMCP();

        // ------------------------------------------------------------ files
        public const int MOVEFILE_DELAY_UNTIL_REBOOT = 0x4;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool MoveFileEx(string existing, string newName, int flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool GetDiskFreeSpaceEx(string directory, out ulong freeBytesAvailable, out ulong totalBytes, out ulong totalFreeBytes);

        // ------------------------------------------------------------ shell
        [DllImport("shell32.dll")]
        public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
        public const int SHCNE_ASSOCCHANGED = 0x08000000;
        public const uint SHCNF_IDLIST = 0;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern uint GetLongPathName(string shortPath, StringBuilder longPath, uint bufferSize);

        // DeleteFileW also takes "<file>:<stream>" (File.Delete in .NET Framework rejects the colon)
        [DllImport("kernel32.dll", EntryPoint = "DeleteFileW", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool DeleteFileW(string path);

        // ------------------------------------------------------------ input
        public const int VK_LBUTTON = 0x01, VK_RBUTTON = 0x02;
        public const int SM_SWAPBUTTON = 23;

        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int index);
    }

    /// <summary>Small helpers around the raw declarations; every one swallows failures.</summary>
    internal static class Win
    {
        /// <summary>Dark title bar (Windows 10 1809+ / 11), rounded corners and a dark caption on Windows 11.</summary>
        public static void ApplyDarkFrame(IntPtr hwnd, bool roundCorners, int captionBgr)
        {
            if (hwnd == IntPtr.Zero) return;
            try
            {
                int on = 1;
                if (NativeMethods.DwmSetWindowAttribute(hwnd, NativeMethods.DWMWA_USE_IMMERSIVE_DARK_MODE, ref on, 4) != 0)
                {
                    on = 1;
                    NativeMethods.DwmSetWindowAttribute(hwnd, NativeMethods.DWMWA_USE_IMMERSIVE_DARK_MODE_OLD, ref on, 4);
                }
            }
            catch (Exception) { }
            if (roundCorners)
            {
                try
                {
                    int pref = NativeMethods.DWMWCP_ROUND;
                    NativeMethods.DwmSetWindowAttribute(hwnd, NativeMethods.DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, 4);
                }
                catch (Exception) { }
            }
            if (captionBgr >= 0)
            {
                try
                {
                    int c = captionBgr;
                    NativeMethods.DwmSetWindowAttribute(hwnd, NativeMethods.DWMWA_CAPTION_COLOR, ref c, 4);
                }
                catch (Exception) { }
            }
        }

        /// <summary>DPI of the window, or of the monitor under a point, or of the desktop (96 if all fail).</summary>
        public static int DpiForWindow(IntPtr hwnd)
        {
            try
            {
                if (hwnd != IntPtr.Zero)
                {
                    uint d = NativeMethods.GetDpiForWindow(hwnd);
                    if (d >= 72 && d <= 960) return (int)d;
                }
            }
            catch (Exception) { }
            return DesktopDpi();
        }

        public static int DpiForPoint(int x, int y)
        {
            try
            {
                var pt = new NativeMethods.POINT { X = x, Y = y };
                IntPtr mon = NativeMethods.MonitorFromPoint(pt, NativeMethods.MONITOR_DEFAULTTONEAREST);
                uint dx, dy;
                if (mon != IntPtr.Zero && NativeMethods.GetDpiForMonitor(mon, 0, out dx, out dy) == 0 && dx >= 72 && dx <= 960) return (int)dx;
            }
            catch (Exception) { }
            return DesktopDpi();
        }

        public static int DesktopDpi()
        {
            try
            {
                IntPtr dc = NativeMethods.GetDC(IntPtr.Zero);
                if (dc != IntPtr.Zero)
                {
                    try
                    {
                        int d = NativeMethods.GetDeviceCaps(dc, NativeMethods.LOGPIXELSX);
                        if (d >= 72 && d <= 960) return d;
                    }
                    finally { NativeMethods.ReleaseDC(IntPtr.Zero, dc); }
                }
            }
            catch (Exception) { }
            return 96;
        }

        /// <summary>
        /// true while the primary mouse button is physically held down. GetAsyncKeyState reports physical
        /// buttons, so swapped buttons (left-handed setting) are taken into account.
        /// </summary>
        public static bool PrimaryButtonDown()
        {
            try
            {
                bool swapped = NativeMethods.GetSystemMetrics(NativeMethods.SM_SWAPBUTTON) != 0;
                return (NativeMethods.GetAsyncKeyState(swapped ? NativeMethods.VK_RBUTTON : NativeMethods.VK_LBUTTON) & 0x8000) != 0;
            }
            catch (Exception) { return false; }
        }

        /// <summary>
        /// Removes the "Mark of the Web" (Zone.Identifier stream) a copied file inherited from a downloaded
        /// original, so Windows does not show a SmartScreen / security warning when it is started later.
        /// </summary>
        public static void RemoveMotw(string file)
        {
            try { NativeMethods.DeleteFileW(file + ":Zone.Identifier"); } catch (Exception) { }
        }

        /// <summary>Starts dragging a borderless window as if its caption had been grabbed.</summary>
        public static void BeginDrag(IntPtr hwnd)
        {
            try
            {
                NativeMethods.ReleaseCapture();
                NativeMethods.SendMessage(hwnd, NativeMethods.WM_NCLBUTTONDOWN, new IntPtr(NativeMethods.HTCAPTION), IntPtr.Zero);
            }
            catch (Exception) { }
        }

        /// <summary>Applies the rectangle Windows suggests in WM_DPICHANGED (lParam = RECT*).</summary>
        public static void ApplySuggestedRect(IntPtr hwnd, IntPtr lParam)
        {
            try
            {
                var r = (NativeMethods.RECT)Marshal.PtrToStructure(lParam, typeof(NativeMethods.RECT));
                NativeMethods.SetWindowPos(hwnd, IntPtr.Zero, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, NativeMethods.SWP_NOZORDER | NativeMethods.SWP_NOACTIVATE);
            }
            catch (Exception) { }
        }

        public static void BringToFront(IntPtr hwnd)
        {
            try
            {
                if (NativeMethods.IsIconic(hwnd)) NativeMethods.ShowWindow(hwnd, NativeMethods.SW_RESTORE);
                else NativeMethods.ShowWindow(hwnd, NativeMethods.SW_SHOW);
                NativeMethods.SetForegroundWindow(hwnd);
            }
            catch (Exception) { }
        }
    }
}
