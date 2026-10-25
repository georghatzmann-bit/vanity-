// VANITY: Protokoll und Versions-Hinweis fuer die Umleitungs-DLL (eigener Code, GPL-3.0).
//
// - VanityLog(...) schreibt nach %LOCALAPPDATA%\Vanity\logs\redirect.log, damit man nach einem Start
//   sehen kann, welches Muster gepasst hat und ob die Umleitung steht.
// - VanityFortniteMajor() liest "-vanityversion=<x.y>" aus der Kommandozeile (setzt der Launcher).
#pragma once
#include <Windows.h>
#include <ShlObj.h>
#include <cstdarg>
#include <cstdio>
#include <cwchar>
#include <string>
#pragma comment(lib, "shell32.lib")

inline void VanityLog(const char* Format, ...)
{
    static FILE* File = []() -> FILE* {
        wchar_t Base[MAX_PATH]{};
        if (FAILED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, 0, Base)))
            return nullptr;
        std::wstring Dir = std::wstring(Base) + L"\\Vanity";
        CreateDirectoryW(Dir.c_str(), nullptr);
        Dir += L"\\logs";
        CreateDirectoryW(Dir.c_str(), nullptr);
        FILE* Out = nullptr;
        _wfopen_s(&Out, (Dir + L"\\redirect.log").c_str(), L"a");
        return Out;
    }();
    if (!File)
        return;
    SYSTEMTIME Time{};
    GetLocalTime(&Time);
    fprintf(File, "%02u:%02u:%02u pid=%lu ", Time.wHour, Time.wMinute, Time.wSecond, GetCurrentProcessId());
    va_list Args;
    va_start(Args, Format);
    vfprintf(File, Format, Args);
    va_end(Args);
    fputc('\n', File);
    fflush(File);
}

// Hauptversion aus "-vanityversion=19.10" (-1, wenn nicht angegeben).
inline int VanityFortniteMajor()
{
    static const int Major = []() {
        const wchar_t* Cmd = GetCommandLineW();
        const wchar_t* Pos = Cmd ? wcsstr(Cmd, L"-vanityversion=") : nullptr;
        if (!Pos)
            return -1;
        return _wtoi(Pos + 15);
    }();
    return Major;
}

// Speicherleck-Fix nur fuer Chapter 1 (bis 10.x) – so macht es auch Reboot. Ohne Versionsangabe aus,
// weil das Muster auf neueren Builds eine fremde Funktion treffen koennte.
inline bool VanityMemLeakAllowed()
{
    const int Major = VanityFortniteMajor();
    return Major >= 1 && Major <= 10;
}
