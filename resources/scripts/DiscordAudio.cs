// Schaltet die Wiedergabe (Audio-Sitzungen) von Discord unter Windows stumm oder wieder laut.
// Wird von DiscordAudio.ps1 mit Add-Type geladen. Muss C# 5 bleiben (Windows PowerShell 5.1).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace KontoRetter.Audio
{
    // ---- Enums (values from mmdeviceapi.h) ----
    public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
    public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

    // ---- CoClass: MMDeviceEnumerator  CLSID {BCDE0395-E52F-467C-8E3D-C4579291692E} ----
    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject
    {
    }

    // IMMDeviceEnumerator : IUnknown  (vtable order after IUnknown)
    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, uint dwStateMask, out IMMDeviceCollection ppDevices);
        [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr pClient);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr pClient);
    }

    // IMMDeviceCollection : IUnknown
    [ComImport]
    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint pcDevices);
        [PreserveSig] int Item(uint nDevice, out IMMDevice ppDevice);
    }

    // IMMDevice : IUnknown
    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        [PreserveSig] int OpenPropertyStore(uint stgmAccess, out IntPtr ppProperties); // IPropertyStore** (unused)
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        [PreserveSig] int GetState(out uint pdwState);
    }

    // IAudioSessionManager2 : IAudioSessionManager : IUnknown
    // C# ComImport interfaces do not inherit vtable slots, so the two
    // IAudioSessionManager methods are re-declared first, in order.
    [ComImport]
    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionManager2
    {
        // --- IAudioSessionManager ---
        [PreserveSig] int GetAudioSessionControl(IntPtr AudioSessionGuid, uint StreamFlags, out IntPtr SessionControl);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr AudioSessionGuid, uint StreamFlags, out IntPtr AudioVolume);
        // --- IAudioSessionManager2 ---
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
        [PreserveSig] int RegisterSessionNotification(IntPtr SessionNotification);
        [PreserveSig] int UnregisterSessionNotification(IntPtr SessionNotification);
        [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionID, IntPtr duckNotification);
        [PreserveSig] int UnregisterDuckNotification(IntPtr duckNotification);
    }

    // IAudioSessionEnumerator : IUnknown
    [ComImport]
    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int SessionCount);
        // Native signature returns IAudioSessionControl**; we take it as IUnknown and QI ourselves.
        [PreserveSig] int GetSession(int SessionCount, [MarshalAs(UnmanagedType.IUnknown)] out object Session);
    }

    // IAudioSessionControl2 : IAudioSessionControl : IUnknown
    // All 9 IAudioSessionControl methods re-declared first, in vtable order.
    [ComImport]
    [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl2
    {
        // --- IAudioSessionControl ---
        [PreserveSig] int GetState(out int pRetVal);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
        [PreserveSig] int GetGroupingParam(out Guid pRetVal);
        [PreserveSig] int SetGroupingParam(ref Guid Override, ref Guid EventContext);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr NewNotifications);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr NewNotifications);
        // --- IAudioSessionControl2 ---
        [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        [PreserveSig] int GetProcessId(out uint pRetVal);
        [PreserveSig] int IsSystemSoundsSession();
        [PreserveSig] int SetDuckingPreferences([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }

    // ISimpleAudioVolume : IUnknown  (BOOL = 4-byte Win32 BOOL -> UnmanagedType.Bool is mandatory)
    [ComImport]
    [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float fLevel, ref Guid EventContext);
        [PreserveSig] int GetMasterVolume(out float pfLevel);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid EventContext);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
    }

    public static class AppMuter
    {
        private const uint DEVICE_STATE_ACTIVE = 0x00000001;
        private const uint CLSCTX_ALL = 0x17; // INPROC_SERVER|INPROC_HANDLER|LOCAL_SERVER|REMOTE_SERVER

        private static void Release(object o)
        {
            if (o != null && Marshal.IsComObject(o))
            {
                try { Marshal.ReleaseComObject(o); } catch { }
            }
        }

        private static string ProcName(uint pid, Dictionary<uint, string> cache)
        {
            string name;
            if (cache.TryGetValue(pid, out name)) return name;
            name = "";
            try
            {
                using (Process p = Process.GetProcessById((int)pid))
                {
                    name = p.ProcessName; // without ".exe"
                }
            }
            catch { }
            cache[pid] = name;
            return name;
        }

        private static bool NameMatches(string procName, string[] names)
        {
            if (string.IsNullOrEmpty(procName) || names == null) return false;
            for (int i = 0; i < names.Length; i++)
            {
                string n = names[i];
                if (string.IsNullOrEmpty(n)) continue;
                if (n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) n = n.Substring(0, n.Length - 4);
                if (string.Equals(procName, n, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        // mode: 0 = query only, 1 = mute, 2 = unmute
        // Returns tab-separated lines: device<TAB>pid<TAB>process<TAB>mutedAfter<TAB>hr
        private static string Run(string[] processNames, int mode)
        {
            StringBuilder sb = new StringBuilder();
            Dictionary<uint, string> cache = new Dictionary<uint, string>();
            Guid ctx = Guid.Empty;
            Guid iidSessionManager2 = typeof(IAudioSessionManager2).GUID;

            IMMDeviceEnumerator enumerator = null;
            IMMDeviceCollection devices = null;
            try
            {
                enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
                int hr = enumerator.EnumAudioEndpoints(EDataFlow.eRender, DEVICE_STATE_ACTIVE, out devices);
                if (hr < 0 || devices == null) throw new COMException("EnumAudioEndpoints failed", hr);

                uint devCount;
                devices.GetCount(out devCount);
                for (uint d = 0; d < devCount; d++)
                {
                    IMMDevice device = null;
                    object smObj = null;
                    IAudioSessionManager2 sm = null;
                    IAudioSessionEnumerator sessions = null;
                    try
                    {
                        if (devices.Item(d, out device) < 0 || device == null) continue;
                        string devId;
                        if (device.GetId(out devId) < 0) devId = "?";

                        if (device.Activate(ref iidSessionManager2, CLSCTX_ALL, IntPtr.Zero, out smObj) < 0 || smObj == null) continue;
                        sm = smObj as IAudioSessionManager2;
                        if (sm == null) continue;
                        if (sm.GetSessionEnumerator(out sessions) < 0 || sessions == null) continue;

                        int sessionCount;
                        sessions.GetCount(out sessionCount);
                        for (int s = 0; s < sessionCount; s++)
                        {
                            object ctlObj = null;
                            try
                            {
                                if (sessions.GetSession(s, out ctlObj) < 0 || ctlObj == null) continue;
                                IAudioSessionControl2 ctl2 = ctlObj as IAudioSessionControl2; // QueryInterface
                                if (ctl2 == null) continue;
                                if (ctl2.IsSystemSoundsSession() == 0) continue; // S_OK => system sounds session

                                uint pid;
                                int hrPid = ctl2.GetProcessId(out pid); // may be AUDCLNT_S_NO_SINGLE_PROCESS (success code)
                                if (hrPid < 0 || pid == 0) continue;

                                string pname = ProcName(pid, cache);
                                if (!NameMatches(pname, processNames)) continue;

                                ISimpleAudioVolume vol = ctlObj as ISimpleAudioVolume; // QueryInterface
                                if (vol == null) continue;

                                int hrSet = 0;
                                if (mode == 1) hrSet = vol.SetMute(true, ref ctx);
                                else if (mode == 2) hrSet = vol.SetMute(false, ref ctx);

                                bool muted;
                                if (vol.GetMute(out muted) < 0) muted = false;

                                sb.Append(devId).Append('\t')
                                  .Append(pid).Append('\t')
                                  .Append(pname).Append('\t')
                                  .Append(muted ? "1" : "0").Append('\t')
                                  .Append(hrSet.ToString("X8"))
                                  .Append("\r\n");
                            }
                            finally
                            {
                                Release(ctlObj);
                            }
                        }
                    }
                    finally
                    {
                        Release(sessions);
                        Release(smObj);
                        Release(device);
                    }
                }
            }
            finally
            {
                Release(devices);
                Release(enumerator);
            }
            return sb.ToString();
        }

        public static string Mute(string[] processNames) { return Run(processNames, 1); }
        public static string Unmute(string[] processNames) { return Run(processNames, 2); }
        public static string Query(string[] processNames) { return Run(processNames, 0); }
    }
}