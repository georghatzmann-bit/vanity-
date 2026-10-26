// [Niobium] Modified version. Original: ATLAS Console (https://github.com/Ralzify/ATLAS-Client),
// (c) ralz, cipherfps and contributors, ATLAS Console Attribution License v1.0 (LICENSE-ATLAS.txt).
// Niobium changes: data paths, visible names/credit, MinHook via project reference.
#pragma once

#include <Windows.h>
#include <ShlObj.h>
#include <cstdarg>
#include <cstdio>
#include <mutex>
#include <string>

namespace AtlasDiagnostics
{
    inline std::wstring GetPath()
    {
        wchar_t appData[MAX_PATH]{};
        // [Niobium] Logs live next to the other Niobium logs: %LOCALAPPDATA%\Niobium\logs
        if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, 0, appData)))
        {
            std::wstring directory = std::wstring(appData) + L"\\Niobium";
            CreateDirectoryW(directory.c_str(), nullptr);
            directory += L"\\logs";
            CreateDirectoryW(directory.c_str(), nullptr);
            return directory + L"\\client-diagnostics.log";
        }

        return L"niobium-client-diagnostics.log";
    }

    inline HANDLE GetFileHandle()
    {
        // Diagnostics can be written for every bound console command. Resolve
        // AppData and open the append handle once instead of doing synchronous
        // shell/path/file work on the game's command-dispatch thread each time.
        static HANDLE file = []
            {
                const std::wstring path = GetPath();
                return CreateFileW(path.c_str(), FILE_APPEND_DATA,
                    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS,
                    FILE_ATTRIBUTE_NORMAL, nullptr);
            }();
        return file;
    }

    inline void WriteLine(const char* format, ...)
    {
        char message[1024]{};
        va_list args;
        va_start(args, format);
        vsnprintf(message, sizeof(message), format, args);
        va_end(args);

        SYSTEMTIME time{};
        GetLocalTime(&time);

        char line[1280]{};
        const int length = snprintf(line, sizeof(line),
            "%02u:%02u:%02u.%03u pid=%lu tid=%lu %s\r\n",
            time.wHour, time.wMinute, time.wSecond, time.wMilliseconds,
            GetCurrentProcessId(), GetCurrentThreadId(), message);
        if (length <= 0)
            return;

        HANDLE file = GetFileHandle();
        if (file == INVALID_HANDLE_VALUE)
            return;

        static std::mutex writeMutex;
        std::lock_guard<std::mutex> lock(writeMutex);
        DWORD written = 0;
        WriteFile(file, line, static_cast<DWORD>(min(length, (int)sizeof(line))), &written, nullptr);
    }

    inline void BeginSession(const char* build)
    {
        WriteLine("session-start build=%s", build ? build : "unknown");
    }
}
