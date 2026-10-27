// NIOBIUM: log and version hint for the redirect DLL (own code, GPL-3.0).
//
// - NiobiumLog(...) writes to %LOCALAPPDATA%\Rift\logs\redirect.log, so after a start you can see
//   which pattern matched and whether the redirect is in place. Lines about a failed redirect start
//   with "ERROR:" - the launcher looks for that word to explain why the game closed.
// - NiobiumFortniteMajor() reads "-niobiumversion=<x.y>" from the command line (set by the launcher).
#pragma once
#include <Windows.h>
#include <ShlObj.h>
#include <cstdarg>
#include <cstdio>
#include <cwchar>
#include <string>
#pragma comment(lib, "shell32.lib")

inline void NiobiumLog(const char* Format, ...)
{
    static FILE* File = []() -> FILE* {
        wchar_t Base[MAX_PATH]{};
        if (FAILED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, 0, Base)))
            return nullptr;
        std::wstring Dir = std::wstring(Base) + L"\\Rift";
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

// Major version from "-niobiumversion=19.10" (-1 if it isn't there).
inline int NiobiumFortniteMajor()
{
    static const int Major = []() {
        constexpr wchar_t Arg[] = L"-niobiumversion=";
        const wchar_t* Cmd = GetCommandLineW();
        const wchar_t* Pos = Cmd ? wcsstr(Cmd, Arg) : nullptr;
        if (!Pos)
            return -1;
        return _wtoi(Pos + (sizeof(Arg) / sizeof(Arg[0]) - 1));
    }();
    return Major;
}

// Memory-leak fix only for Chapter 1 (up to 10.x) - Reboot does the same. Off without a version,
// because on newer builds the pattern could hit a different function.
inline bool NiobiumMemLeakAllowed()
{
    const int Major = NiobiumFortniteMajor();
    return Major >= 1 && Major <= 10;
}
