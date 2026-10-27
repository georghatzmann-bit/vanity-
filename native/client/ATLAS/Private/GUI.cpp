// [Rift] Modified version. Original: ATLAS Console (https://github.com/Ralzify/ATLAS-Client),
// (c) ralz, cipherfps and contributors, ATLAS Console Attribution License v1.0 (LICENSE-ATLAS.txt).
// Rift changes: data paths, visible names/credit, MinHook via project reference,
// all visible menu texts in plain English with short hints, brand colours, Bubble Builds
// status row, Bubble look switch, Editing rows by route (hook or Fortnite's own setting),
// Reset builds switch and key (all marked with [Rift]).
#include "pch.h"
#include "../Public/GUI.h"
#include "../Public/Hotkey.h"
#include "../Public/Configuration.h"
#include "../Public/Client.h"
#include "../Public/Diagnostics.h"
#include "../Public/Icon.h"
#include "../Public/NiobiumTrickshotTab.h" // [Rift] Trickshot tab and trickshot banner
#include "../Public/RiftHostTab.h" // [Rift] Host tab (everything the host controls during a match)
#include "../Public/BubbleLook.h" // [Rift] Bubble look state (written by the game thread)
#include "../Public/EditFeatureRoutes.h" // [Rift] EOR/ROR/pre-edits: hook or Fortnite's own setting
#include "../Public/QuickReset.h" // [Rift] "Reset builds" key and status
#include "../ImGui/imgui.h"
#include "../ImGui/imgui_internal.h"
#include "../ImGui/imgui_stdlib.h"

#include <sstream>
#include <iomanip>
#include <array>
#include <atomic>
#include <cctype>
#include <cmath>
#include <deque>
#include <mutex>
#include <Shellapi.h>
#include <unordered_set>
#include <vector>

#pragma comment(lib, "Shell32.lib")

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG

#include "../ImGui/stb_image.h"

extern void* SelectEdit(void*);
extern void* SelectReset(void*);
extern bool ATLAS_PrepareReplicationForOpen(
    const char* command,
    wchar_t* error,
    size_t errorCapacity);

// [Rift] Brand accent violet #8B5CF6 (was the ATLAS accent #00A2CE), pressed #7C3AED.
#define ACCENT_R 0.545f
#define ACCENT_G 0.361f
#define ACCENT_B 0.965f

static ImVec4 Accent(float a = 1.f) { return ImVec4(ACCENT_R, ACCENT_G, ACCENT_B, a); }
static ImVec4 AccentDk(float a = 1.f) { return ImVec4(0.486f, 0.227f, 0.929f, a); }
// [Rift] Second brand accent, neon cyan #22D3EE: thin light only (the active-tab indicator),
// never a fill behind text.
static ImVec4 AccentCyan(float a = 1.f) { return ImVec4(0.133f, 0.827f, 0.933f, a); }
// [Rift] Accent for text and thin glyphs: violet-text #C4B5FD (10.3:1 on the menu background;
// plain violet is too dark for small text).
static ImVec4 AccentText(float a = 1.f) { return ImVec4(0.769f, 0.710f, 0.992f, a); }
// [Rift] Brand text #F4F4F8, text-muted #A6A6BC (hints and other secondary text people need
// to read, 8.0:1) and text-faint #80809A (captions, key labels, disabled text only, 5.0:1).
static const ImVec4 kNiobiumText(0.957f, 0.957f, 0.973f, 1.f);
static const ImVec4 kNiobiumHintText(0.651f, 0.651f, 0.737f, 1.f);
static const ImVec4 kNiobiumMutedText(0.502f, 0.502f, 0.604f, 1.f);
// [Rift] Brand backgrounds: bg #07070C (top bar, sidebar), surface #0F0F19 (window),
// surface-raised #161624 (fields, buttons).
static const ImVec4 kNiobiumBg(0.027f, 0.027f, 0.047f, 1.f);

// [Rift] GUI.cpp is built without /utf-8 and stays plain ASCII. The few non-ASCII characters
// of the menu texts are UTF-8 bytes (what ImGui expects) in their own literals that the compiler
// glues onto the neighbouring ones, e.g. "Off " NB_DASH " on". For wide L"..." texts (console)
// use Unicode escapes instead (backslash, "u", four hex digits, e.g. 2013 for the en dash).
// All of these characters exist in the embedded font.
#define NB_DASH "\xE2\x80\x93"   // en dash (U+2013)
#define NB_NBSP "\xC2\xA0"       // no-break space (U+00A0): ImGui never wraps there

enum class EConsoleLineKind : uint8_t
{
    Output,
    Command,
    Spacer,
    System,
    Error
};

struct FConsoleLine
{
    uint64_t Id = 0;
    EConsoleLineKind Kind = EConsoleLineKind::Output;
    std::string Time;
    std::string Text;
};

struct FConsoleUiState
{
    std::string Input;
    std::string Draft;
    std::vector<std::string> History;
    int HistoryPosition = -1;
    std::string CompletionSeed;
    std::vector<std::string> CompletionMatches;
    int CompletionPosition = -1;
    bool FocusInput = false;
    bool ScrollToBottom = false;
    bool WasAtBottom = true;
    bool WindowFocused = false;
    bool Expanded = false;
    bool ResetExpansion = false;
    float Expansion = 0.f;
    bool InitialHelpPending = false;
    bool InitialHelpRequested = false;
    uint64_t InitialHelpSession = 0;
    unsigned int InitialHelpAttempts = 0;
    ULONGLONG NextInitialHelpAttemptAt = 0;
    bool ReloadInput = false;
    bool SlashPrefillActive = false;
    bool RefocusAfterEscapeClear = false;
};

enum class ESavedCommandEditTarget : uint8_t
{
    None,
    Command,
    MacroStep,
    MacroDelay
};

struct FSavedCommandEditState
{
    ESavedCommandEditTarget Target =
        ESavedCommandEditTarget::None;
    int CommandIndex = -1;
    int MacroIndex = -1;
    int StepIndex = -1;
    std::string Draft;
    std::string Original;
    int DelayDraft = 250;
    int DelayOriginal = 250;
    std::string Error;
    bool FocusNextFrame = false;
};

static FConsoleUiState g_ConsoleUi;
static FSavedCommandEditState g_SavedCommandEdit;
static std::deque<FConsoleLine> g_ConsoleLines;
static size_t g_ConsoleLineBytes = 0;
static uint64_t g_NextConsoleLineId = 1;
static uint64_t g_ConsoleLineRevision = 0;

static std::mutex g_ConsolePendingMutex;
static std::deque<std::string> g_ConsolePending;
static size_t g_ConsolePendingBytes = 0;
static std::atomic_uint g_ConsoleDroppedMessages = 0;
static std::string g_ConsoleDrainCarry;
static size_t g_ConsoleDrainOffset = 0;
static bool g_FocusMenuWindow = false;
static bool g_MenuWindowFocused = false;
static ULONGLONG g_BindErrorUntil = 0;
static std::string g_BindError;
// [Rift] Which key button the bind error belongs to (0 = the menu/join/command keys,
// 1 = the Reset builds key), so the Options tab shows it only once, next to the right button.
static int g_BindErrorOwner = 0;
static constexpr unsigned int SettingCommandMobileBuilds = 1u << 0;
static constexpr unsigned int SettingCommandInGameFog = 1u << 1;
static constexpr unsigned int SettingCommandDebugCamera = 1u << 2;
static constexpr unsigned int SettingCommandTargetInfo = 1u << 3;
static constexpr unsigned int SettingCommandMipMapLODBias = 1u << 4;
static constexpr unsigned int SettingCommandFOV = 1u << 5;
static std::atomic_uint g_PendingSettingCommandMask = 0;
// Coordinate command-backed menu changes with game-thread dispatch. Debug
// Camera and Target Info additionally need an assumed applied state because
// UE exposes them as toggle-only commands.
static std::mutex g_SettingCommandMutex;
static unsigned int g_AppliedToggleSettingMask = 0;
// [Rift] Mobile Builds and fog are only sent when they change something. These remember that
// Rift itself set a non-neutral console value in this game process (console values outlive a
// map change), so switching back sends the neutral value only to undo our own change. Guarded by
// g_SettingCommandMutex.
static bool g_MobileBuildsValueSet = false;
static bool g_FogValueSet = false;
// [Rift] World (Client::GetWorldGeneration) the toggle-only commands were applied in.
static uint64_t g_ToggleSettingWorld = 0;

static constexpr size_t kMaximumConsoleLines = 2048;
static constexpr size_t kMaximumConsoleBytes = 1024 * 1024;
static constexpr size_t kMaximumPendingMessages = 256;
static constexpr size_t kMaximumPendingBytes = 512 * 1024;
static constexpr size_t kMaximumConsoleLineLength = 4096;
static constexpr size_t kMaximumConsoleHistory = 100;
static constexpr size_t kMaximumConsoleCommandLength = 2048;
static constexpr size_t kMaximumDrainLinesPerFrame = 256;
static constexpr size_t kMaximumDrainBytesPerFrame = 64 * 1024;
static constexpr unsigned int kMaximumInitialHelpAttempts = 3;
static constexpr ULONGLONG kInitialHelpRetryMs = 5000;

static void CancelSavedCommandEdit()
{
    g_SavedCommandEdit = {};
}

static bool FinishSavedCommandEdit(bool keepOpenOnInvalid);

static bool IsReservedConsoleHotkey(int vk)
{
    // Both characters produced by the Tilde key arrive as VK_OEM_3. F8 is
    // ATLAS's second fixed alias for the same UE-style console cycle. Slash
    // is a fixed shortcut that opens the compact ATLAS console with `/` ready.
    return vk == VK_OEM_3 || vk == VK_F8 || vk == VK_OEM_2;
}

bool GUI_IsOverlayVisible()
{
    return FGUI::bVisible || FGUI::bConsoleVisible;
}

static bool ContainsInsensitive(const std::string& value, const char* needle)
{
    if (!needle || !*needle)
        return true;

    const size_t needleLength = strlen(needle);
    if (needleLength > value.size())
        return false;

    for (size_t start = 0; start + needleLength <= value.size(); start++)
    {
        size_t i = 0;
        for (; i < needleLength; i++)
        {
            const unsigned char left = static_cast<unsigned char>(value[start + i]);
            const unsigned char right = static_cast<unsigned char>(needle[i]);
            if (std::tolower(left) != std::tolower(right))
                break;
        }
        if (i == needleLength)
            return true;
    }

    return false;
}

static bool StartsWithInsensitive(const std::string& value, const std::string& prefix)
{
    if (prefix.size() > value.size())
        return false;

    for (size_t i = 0; i < prefix.size(); i++)
    {
        const unsigned char left = static_cast<unsigned char>(value[i]);
        const unsigned char right = static_cast<unsigned char>(prefix[i]);
        if (std::tolower(left) != std::tolower(right))
            return false;
    }

    return true;
}

static EConsoleLineKind ClassifyConsoleOutput(const std::string& text)
{
    if (StartsWithInsensitive(text, "[Rift]"))
        return EConsoleLineKind::System;

    static const char* kErrorWords[] = {
        "could not", "failed", "invalid", "wrong number", "error", "no player",
        "not found", "unavailable", "queue full"
    };

    for (const char* word : kErrorWords)
        if (ContainsInsensitive(text, word))
            return EConsoleLineKind::Error;

    return EConsoleLineKind::Output;
}

static void AppendConsoleLine(EConsoleLineKind kind, std::string text)
{
    const bool isSpacer = kind == EConsoleLineKind::Spacer;
    if (!isSpacer)
    {
        while (!text.empty() &&
            (text.back() == '\r' || text.back() == '\n' ||
                text.back() == '\0'))
        {
            text.pop_back();
        }

        if (text.empty())
            return;

        if (text.size() > kMaximumConsoleLineLength)
        {
            text.resize(kMaximumConsoleLineLength - 14);
            text += " ...[truncated]";
        }
    }

    SYSTEMTIME now{};
    char timestamp[16]{};
    if (!isSpacer)
    {
        GetLocalTime(&now);
        snprintf(timestamp, sizeof(timestamp), "%02u:%02u:%02u",
            now.wHour, now.wMinute, now.wSecond);
    }

    FConsoleLine line{};
    line.Id = g_NextConsoleLineId++;
    line.Kind = kind;
    line.Time = timestamp;
    line.Text = std::move(text);
    g_ConsoleLineBytes += line.Time.size() + line.Text.size();
    g_ConsoleLines.push_back(std::move(line));

    while (!g_ConsoleLines.empty() &&
        (g_ConsoleLines.size() > kMaximumConsoleLines || g_ConsoleLineBytes > kMaximumConsoleBytes))
    {
        g_ConsoleLineBytes -= g_ConsoleLines.front().Time.size() + g_ConsoleLines.front().Text.size();
        g_ConsoleLines.pop_front();
    }

    g_ConsoleLineRevision++;
}

bool GUI_QueueConsoleOutput(const wchar_t* text, int length)
{
    if (!text || length <= 0)
        return false;

    if (length > 16384)
        length = 16384;

    // Reserve access before converting. Once the bounded queue is saturated,
    // producers drop immediately instead of repeatedly allocating and doing
    // UTF conversion on the gameplay/RPC thread.
    std::unique_lock<std::mutex> lock(g_ConsolePendingMutex, std::try_to_lock);
    const size_t minimumUtf8Bytes = static_cast<size_t>(length);
    if (!lock.owns_lock() ||
        g_ConsolePending.size() >= kMaximumPendingMessages ||
        g_ConsolePendingBytes >= kMaximumPendingBytes ||
        minimumUtf8Bytes > kMaximumPendingBytes - g_ConsolePendingBytes)
    {
        g_ConsoleDroppedMessages.fetch_add(1, std::memory_order_relaxed);
        return false;
    }

    const int utf8Length = WideCharToMultiByte(CP_UTF8, 0, text, length, nullptr, 0, nullptr, nullptr);
    if (utf8Length <= 0)
        return false;

    std::string utf8(static_cast<size_t>(utf8Length), '\0');
    if (WideCharToMultiByte(CP_UTF8, 0, text, length, utf8.data(), utf8Length, nullptr, nullptr) != utf8Length)
        return false;

    if (utf8.size() > kMaximumPendingBytes - g_ConsolePendingBytes)
    {
        g_ConsoleDroppedMessages.fetch_add(1, std::memory_order_relaxed);
        return false;
    }

    g_ConsolePendingBytes += utf8.size();
    g_ConsolePending.push_back(std::move(utf8));
    return true;
}

static void DrainConsoleOutput()
{
    const unsigned int dropped = g_ConsoleDroppedMessages.exchange(0, std::memory_order_acq_rel);
    if (dropped > 0)
    {
        // [Rift] plain English
        char message[128]{};
        snprintf(message, sizeof(message), "[Rift] Skipped %u message%s so the game stays smooth.",
            dropped, dropped == 1 ? "" : "s");
        AppendConsoleLine(EConsoleLineKind::System, message);
    }

    size_t lineCount = 0;
    size_t byteCount = 0;
    while (lineCount < kMaximumDrainLinesPerFrame &&
        byteCount < kMaximumDrainBytesPerFrame)
    {
        if (g_ConsoleDrainOffset >= g_ConsoleDrainCarry.size())
        {
            g_ConsoleDrainCarry.clear();
            g_ConsoleDrainOffset = 0;

            std::lock_guard<std::mutex> lock(g_ConsolePendingMutex);
            if (g_ConsolePending.empty())
                break;

            g_ConsolePendingBytes -= g_ConsolePending.front().size();
            g_ConsoleDrainCarry = std::move(g_ConsolePending.front());
            g_ConsolePending.pop_front();
        }

        const size_t end = g_ConsoleDrainCarry.find('\n', g_ConsoleDrainOffset);
        const size_t lineEnd = end == std::string::npos ? g_ConsoleDrainCarry.size() : end;
        const size_t consumedBytes = lineEnd - g_ConsoleDrainOffset +
            (end == std::string::npos ? 0 : 1);

        if (lineCount > 0 && consumedBytes > kMaximumDrainBytesPerFrame - byteCount)
            break;

        std::string line = g_ConsoleDrainCarry.substr(
            g_ConsoleDrainOffset, lineEnd - g_ConsoleDrainOffset);
        AppendConsoleLine(ClassifyConsoleOutput(line), std::move(line));

        lineCount++;
        byteCount += consumedBytes;
        g_ConsoleDrainOffset = end == std::string::npos
            ? g_ConsoleDrainCarry.size()
            : end + 1;
    }
}

static void AppendConsoleCommandEcho(
    const std::string& command)
{
    // Flush output produced by the previous command before placing the next
    // command boundary. This keeps hotkey-triggered output grouped even when
    // the console is closed between key presses.
    DrainConsoleOutput();

    if (!g_ConsoleLines.empty() &&
        g_ConsoleLines.back().Kind != EConsoleLineKind::Spacer)
    {
        AppendConsoleLine(EConsoleLineKind::Spacer, {});
    }

    if (!command.empty())
    {
        AppendConsoleLine(
            EConsoleLineKind::Command,
            "> " + command);
    }

    g_ConsoleUi.ScrollToBottom = true;
}

static void ClearConsoleLogs()
{
    {
        std::lock_guard<std::mutex> lock(g_ConsolePendingMutex);
        g_ConsolePending.clear();
        g_ConsolePendingBytes = 0;
    }

    g_ConsoleDroppedMessages.store(0, std::memory_order_release);
    g_ConsoleDrainCarry.clear();
    g_ConsoleDrainOffset = 0;
    g_ConsoleLines.clear();
    g_ConsoleLineBytes = 0;
    g_ConsoleLineRevision++;
    g_ConsoleUi.ScrollToBottom = false;
    g_ConsoleUi.WasAtBottom = true;
}

static const char* VKName(int vk)
{
    static char buf[32];

    // [Rift] Friendly key names (display only, never saved).
    switch (vk)
    {
    case VK_LBUTTON: return "Mouse 1";
    case VK_RBUTTON: return "Mouse 2";
    case VK_MBUTTON: return "Mouse 3";
    case VK_XBUTTON1: return "Mouse 4";
    case VK_XBUTTON2: return "Mouse 5";
    case VK_F1:  return "F1";  case VK_F2:  return "F2";
    case VK_F3:  return "F3";  case VK_F4:  return "F4";
    case VK_F5:  return "F5";  case VK_F6:  return "F6";
    case VK_F7:  return "F7";  case VK_F8:  return "F8";
    case VK_F9:  return "F9";  case VK_F10: return "F10";
    case VK_F11: return "F11"; case VK_F12: return "F12";
    case VK_INSERT: return "Insert"; case VK_DELETE: return "Delete";
    case VK_HOME:   return "Home";   case VK_END:    return "End";
    case VK_PRIOR:  return "Page Up"; case VK_NEXT:  return "Page Down";
    case VK_SPACE:  return "Space";  case VK_RETURN: return "Enter";
    case VK_TAB:    return "Tab";    case VK_BACK:   return "Backspace";
    case VK_LEFT:   return "Left arrow"; case VK_RIGHT: return "Right arrow";
    case VK_UP:     return "Up arrow";   case VK_DOWN:  return "Down arrow";
    case VK_CAPITAL: return "Caps Lock"; case VK_OEM_3: return "`";
    }

    if (vk >= '0' && vk <= '9') { buf[0] = (char)vk; buf[1] = '\0'; return buf; }
    if (vk >= 'A' && vk <= 'Z') { buf[0] = (char)vk; buf[1] = '\0'; return buf; }

    if (vk >= VK_NUMPAD0 && vk <= VK_NUMPAD9)
    {
        snprintf(buf, sizeof(buf), "Num %d", vk - VK_NUMPAD0); // [Rift] same as in the launcher
        return buf;
    }

    // Fall back to the OS name for anything else (OEM/punctuation keys etc.).
    UINT sc = MapVirtualKeyW((UINT)vk, MAPVK_VK_TO_VSC);
    wchar_t wname[32]{};
    if (sc != 0 && GetKeyNameTextW((LONG)(sc << 16), wname, 32) > 0 &&
        WideCharToMultiByte(CP_UTF8, 0, wname, -1, buf, sizeof(buf), nullptr, nullptr) > 0)
        return buf;

    snprintf(buf, sizeof(buf), "0x%02X", vk);
    return buf;
}

static const char* BindName(int vk)
{
    return (vk > 0 && vk <= 254) ? VKName(vk) : "none"; // [Rift] was "UNBOUND"
}

// Saved command hotkeys are actions owned by ATLAS. Keep an atomic lookup for
// WndProc so those presses do not also activate the game's binding (MOUSE5 is
// commonly bound to Jump, which can otherwise leave ability activations open).
static std::array<std::atomic_bool, 0xFF> g_ExclusiveCommandHotkeys{};

static void RefreshExclusiveCommandHotkeys()
{
    for (auto& exclusive : g_ExclusiveCommandHotkeys)
        exclusive.store(false, std::memory_order_release);

    for (const auto& command : FGUI::Commands)
    {
        if (command.VK > 0 && command.VK <= 0xFE)
        {
            g_ExclusiveCommandHotkeys[static_cast<size_t>(command.VK)].store(true, std::memory_order_release);
            AtlasDiagnostics::WriteLine("command-hotkey-exclusive vk=%d command=%s", command.VK, command.Command.c_str());
        }
    }

    for (const auto& macro : FGUI::Macros)
    {
        if (macro.VK > 0 && macro.VK <= 0xFE)
        {
            g_ExclusiveCommandHotkeys[static_cast<size_t>(macro.VK)].store(true, std::memory_order_release);
            AtlasDiagnostics::WriteLine("macro-hotkey-exclusive vk=%d macro=%s", macro.VK, macro.Name.c_str());
        }
    }
}

static HotkeyPersist::UserPreferences DefaultUserPreferences()
{
    // One console.json is shared across supported builds. Keep the legacy
    // feature defaults enabled in storage; version gates decide whether each
    // preference is displayed or used on the current build.
    return HotkeyPersist::UserPreferences{};
}

static HotkeyPersist::UserPreferences CaptureUserPreferences()
{
    HotkeyPersist::UserPreferences preferences{};
    preferences.SaveTogglePreferences =
        FConfiguration::bSaveTogglePreferences.load(
            std::memory_order_acquire);
    preferences.SlashKey =
        FConfiguration::bSlashKeyEnabled.load(
            std::memory_order_acquire);
    preferences.EditOnRelease =
        FConfiguration::bEOREnabled.load(
            std::memory_order_acquire);
    preferences.ResetOnRelease =
        FConfiguration::bROREnabled.load(
            std::memory_order_acquire);
    preferences.DisablePreEdits =
        FConfiguration::bDisablePreEdits.load(
            std::memory_order_acquire);
    preferences.MobileBuilds =
        FConfiguration::bMobileBuilds.load(
            std::memory_order_acquire);
    preferences.BubbleLook =
        FConfiguration::bBubbleLook.load(
            std::memory_order_acquire);
    preferences.BubbleStrength = NiobiumBubbleLook::SanitizeStrength(
        FConfiguration::BubbleStrength.load(
            std::memory_order_acquire));
    // Debug switch: not shown in the menu, only kept so saving doesn't drop it.
    preferences.BubbleProbe =
        FConfiguration::bBubbleProbe.load(
            std::memory_order_acquire);
    preferences.InGameFog =
        FConfiguration::bGameplayFog.load(
            std::memory_order_acquire);
    preferences.FirstPerson =
        FConfiguration::bFirstPerson.load(
            std::memory_order_acquire);
    preferences.RespawnsEnabled =
        FConfiguration::bForceRespawns.load(
            std::memory_order_acquire);
    // [Rift] Reset builds (Options). The probe is a debug switch like bubbleProbe.
    preferences.ResetBuilds =
        FConfiguration::bResetBuilds.load(
            std::memory_order_acquire);
    preferences.ResetBuildsKey = HotkeyPersist::SanitizeResetBuildsKey(
        FConfiguration::ResetBuildsVK.load(
            std::memory_order_acquire));
    preferences.ResetBuildsProbe =
        FConfiguration::bResetBuildsProbe.load(
            std::memory_order_acquire);
    return preferences;
}

static void ApplyUserPreferences(
    const HotkeyPersist::UserPreferences& preferences)
{
    FConfiguration::bSaveTogglePreferences.store(
        preferences.SaveTogglePreferences,
        std::memory_order_release);
    FConfiguration::bSlashKeyEnabled.store(
        preferences.SlashKey, std::memory_order_release);
    FConfiguration::bEOREnabled.store(
        preferences.EditOnRelease, std::memory_order_release);
    FConfiguration::bROREnabled.store(
        preferences.ResetOnRelease, std::memory_order_release);
    FConfiguration::bDisablePreEdits.store(
        preferences.DisablePreEdits, std::memory_order_release);
    FConfiguration::bMobileBuilds.store(
        preferences.MobileBuilds, std::memory_order_release);
    FConfiguration::bBubbleLook.store(
        preferences.BubbleLook, std::memory_order_release);
    FConfiguration::BubbleStrength.store(
        NiobiumBubbleLook::SanitizeStrength(preferences.BubbleStrength),
        std::memory_order_release);
    FConfiguration::bGameplayFog.store(
        preferences.InGameFog, std::memory_order_release);
    FConfiguration::bFirstPerson.store(
        preferences.FirstPerson, std::memory_order_release);
    FConfiguration::bForceRespawns.store(
        preferences.RespawnsEnabled, std::memory_order_release);
    FConfiguration::bResetBuilds.store(
        preferences.ResetBuilds, std::memory_order_release);
    FConfiguration::ResetBuildsVK.store(
        HotkeyPersist::SanitizeResetBuildsKey(preferences.ResetBuildsKey),
        std::memory_order_release);
}

void GUI_LoadUserPreferences()
{
    const HotkeyPersist::UserPreferences savedPreferences =
        HotkeyPersist::LoadUserPreferences(
            DefaultUserPreferences());
    HotkeyPersist::UserPreferences preferences =
        savedPreferences.SaveTogglePreferences
            ? savedPreferences
            : DefaultUserPreferences();
    // The master preference always persists independently. When it is off,
    // every managed toggle starts from its canonical default for this session.
    preferences.SaveTogglePreferences =
        savedPreferences.SaveTogglePreferences;
    ApplyUserPreferences(preferences);
    // [Rift] The Bubble look probe is a debug switch, not a toggle: it follows the file
    // even when "Remember my settings" is off.
    FConfiguration::bBubbleProbe.store(
        savedPreferences.BubbleProbe, std::memory_order_release);
    FConfiguration::bResetBuildsProbe.store(
        savedPreferences.ResetBuildsProbe, std::memory_order_release);

    // [Rift] Only send what changes something: Mobile Builds when it is on, fog when it is
    // off. A console value outranks Fortnite's own graphics presets for the whole session, so
    // the neutral values ("r.StaticMeshLODDistanceScale 1", "r.Fog 1") are never sent at
    // startup any more; they are only sent to undo a value Rift set itself.
    unsigned int commandMask = 0;
    if (preferences.MobileBuilds)
        commandMask |= SettingCommandMobileBuilds;
    if (!preferences.InGameFog)
        commandMask |= SettingCommandInGameFog;
    {
        std::lock_guard<std::mutex> lock(
            g_SettingCommandMutex);
        g_AppliedToggleSettingMask = 0;
        g_PendingSettingCommandMask.store(
            commandMask, std::memory_order_release);
    }
}

static void SaveUserPreferences()
{
    if (!FConfiguration::bSaveTogglePreferences.load(
            std::memory_order_acquire))
    {
        return;
    }
    HotkeyPersist::SaveUserPreferences(
        CaptureUserPreferences());
}

static bool TogglePreferencePersistenceCheckbox()
{
    bool value = FConfiguration::bSaveTogglePreferences.load(
        std::memory_order_acquire);
    // [Rift] Plain English label; the ImGui id stays fixed ("###save_toggles").
    if (!ImGui::Checkbox("Remember my settings###save_toggles", &value))
        return false;

    FConfiguration::bSaveTogglePreferences.store(
        value, std::memory_order_release);
    HotkeyPersist::SaveTogglePreferencesMode(
        value, CaptureUserPreferences());
    return true;
}

static bool PersistentCheckbox(
    const char* label,
    std::atomic_bool& setting)
{
    bool value = setting.load(std::memory_order_acquire);
    if (!ImGui::Checkbox(label, &value))
        return false;

    setting.store(value, std::memory_order_release);
    SaveUserPreferences();
    return true;
}

static void ReconcileToggleSettingCommandLocked(
    unsigned int bit,
    bool desired)
{
    const bool applied =
        (g_AppliedToggleSettingMask & bit) != 0;
    if (desired != applied)
    {
        g_PendingSettingCommandMask.fetch_or(
            bit, std::memory_order_acq_rel);
    }
    else
    {
        g_PendingSettingCommandMask.fetch_and(
            ~bit, std::memory_order_acq_rel);
    }
}

static bool SessionToggleCommandCheckbox(
    const char* label,
    std::atomic_bool& setting,
    unsigned int bit)
{
    bool value = setting.load(std::memory_order_acquire);
    if (!ImGui::Checkbox(label, &value))
        return false;

    {
        std::lock_guard<std::mutex> lock(
            g_SettingCommandMutex);
        setting.store(value, std::memory_order_release);
        ReconcileToggleSettingCommandLocked(bit, value);
    }
    return true;
}

static bool PersistentAbsoluteCommandCheckbox(
    const char* label,
    std::atomic_bool& setting,
    unsigned int bit)
{
    bool value = setting.load(std::memory_order_acquire);
    if (!ImGui::Checkbox(label, &value))
        return false;

    {
        std::lock_guard<std::mutex> lock(
            g_SettingCommandMutex);
        setting.store(value, std::memory_order_release);
        g_PendingSettingCommandMask.fetch_or(
            bit, std::memory_order_acq_rel);
    }
    SaveUserPreferences();
    return true;
}

void FGUI::SaveHotkey()
{
    const int hotkey = HotkeyPersist::SanitizeRequiredMenuHotkey(
        FGUI::HotkeyVK.load(std::memory_order_acquire));
    FGUI::HotkeyVK.store(hotkey, std::memory_order_release);
    HotkeyPersist::Save(hotkey);
}

void FGUI::LoadHotkey()
{
    FGUI::HotkeyVK.store(
        HotkeyPersist::SanitizeRequiredMenuHotkey(
            HotkeyPersist::Load(HotkeyPersist::DefaultMenuHotkeyVK)),
        std::memory_order_release);
}

void FGUI::SaveJoinHotkey() { HotkeyPersist::Save(FGUI::JoinHotkeyVK, "joinHotkey"); }
void FGUI::LoadJoinHotkey() { FGUI::JoinHotkeyVK = HotkeyPersist::Load(VK_F5, "joinHotkey"); }

void FGUI::SaveCommands()
{
    HotkeyPersist::SaveCommands(FGUI::Commands, FGUI::Macros);
    RefreshExclusiveCommandHotkeys();
}

void FGUI::LoadCommands()
{
    CancelSavedCommandEdit();
    FGUI::Commands = HotkeyPersist::LoadCommands();
    RefreshExclusiveCommandHotkeys();
}

void FGUI::SaveMacros()
{
    HotkeyPersist::SaveCommands(FGUI::Commands, FGUI::Macros);
    RefreshExclusiveCommandHotkeys();
}

void FGUI::LoadMacros()
{
    CancelSavedCommandEdit();
    FGUI::Macros = HotkeyPersist::LoadMacros();
    RefreshExclusiveCommandHotkeys();
}

void FGUI::ResetAll()
{
    CancelSavedCommandEdit();
    const HotkeyPersist::UserPreferences defaults =
        DefaultUserPreferences();

    // Reset desired state and queue every command-backed default while
    // serialized against the game-thread dispatcher. Toggle-only commands
    // reconcile from their known applied state instead of blindly inverting.
    {
        std::lock_guard<std::mutex> lock(
            g_SettingCommandMutex);
        ApplyUserPreferences(defaults);
        FConfiguration::bDebugCamera.store(
            false, std::memory_order_release);
        FConfiguration::bTargetInfo.store(
            false, std::memory_order_release);
        FConfiguration::MipMapLODBias.store(
            0, std::memory_order_release);
        FConfiguration::FOV.store(
            80, std::memory_order_release);
        g_PendingSettingCommandMask.fetch_or(
            SettingCommandMobileBuilds |
            SettingCommandInGameFog |
            SettingCommandMipMapLODBias |
            SettingCommandFOV,
            std::memory_order_acq_rel);
        ReconcileToggleSettingCommandLocked(
            SettingCommandDebugCamera, false);
        ReconcileToggleSettingCommandLocked(
            SettingCommandTargetInfo, false);
    }

    FGUI::HotkeyVK = HotkeyPersist::DefaultMenuHotkeyVK;
    FGUI::JoinHotkeyVK = VK_F5;
    FConfiguration::ConsoleMode.store(
        static_cast<int>(EConsoleMode::Atlas), std::memory_order_release);
    FGUI::ActiveTab = 0;
    FGUI::HostType = 0;
    FGUI::RemoteIP[0] = '\0';
    FGUI::bRebinding = false;
    FGUI::bRebindingJoin = false;
    FGUI::bRebindingResetBuilds = false;
    FGUI::RebindingCommandIndex = -2;
    FGUI::RebindingMacroIndex = -2;
    FGUI::PendingCommandVK = 0;
    FGUI::CommandInput[0] = '\0';
    FGUI::MacroDelayInput[0] = '\0';
    FGUI::Commands.clear();
    FGUI::Macros.clear();
    FGUI::MacroDraftSteps.clear();
    RefreshExclusiveCommandHotkeys();

    // [Rift] Keep the hidden Bubble look probe switch; everything else goes back to default.
    HotkeyPersist::UserPreferences savedDefaults = defaults;
    savedDefaults.BubbleProbe = FConfiguration::bBubbleProbe.load(
        std::memory_order_acquire);
    savedDefaults.ResetBuildsProbe = FConfiguration::bResetBuildsProbe.load(
        std::memory_order_acquire);
    HotkeyPersist::SaveAll(FGUI::HotkeyVK, FGUI::JoinHotkeyVK,
        static_cast<int>(EConsoleMode::Atlas), {}, {}, &savedDefaults);
}

void GUI_LoadTextures(ID3D11Device* device)
{
    int w, h, ch;
    unsigned char* pixels = stbi_load_from_memory(Icon, (int)sizeof(Icon), &w, &h, &ch, 4);

    if (!pixels) 
        return;

    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = (UINT)w;
    desc.Height = (UINT)h;
    desc.MipLevels = 0;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    desc.MiscFlags = D3D11_RESOURCE_MISC_GENERATE_MIPS;

    ID3D11Texture2D* tex = nullptr;
    if (SUCCEEDED(device->CreateTexture2D(&desc, nullptr, &tex)))
    {
        ID3D11DeviceContext* ctx = nullptr;
        device->GetImmediateContext(&ctx);

        ctx->UpdateSubresource(tex, 0, nullptr, pixels, (UINT)(w * 4), 0);

        D3D11_SHADER_RESOURCE_VIEW_DESC srvDesc{};
        srvDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        srvDesc.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D;
        srvDesc.Texture2D.MipLevels = (UINT)-1;
        ID3D11ShaderResourceView* srv = nullptr;
        if (SUCCEEDED(device->CreateShaderResourceView(tex, &srvDesc, &srv)))
        {
            FGUI::LogoTexture = (ImTextureID)srv;
            ctx->GenerateMips(srv);
            FGUI::LogoW = w;
            FGUI::LogoH = h;
        }

        if (ctx) ctx->Release();
        tex->Release();
    }

    stbi_image_free(pixels);
}

static ID3D12Resource* g_LogoTextureDX12 = nullptr;

struct LogoMipLevel
{
    UINT Width = 0;
    UINT Height = 0;
    std::vector<uint8_t> Pixels;
};

static std::vector<LogoMipLevel> BuildLogoMipChain(const unsigned char* pixels, UINT width, UINT height)
{
    std::vector<LogoMipLevel> mips;
    if (!pixels || !width || !height)
        return mips;

    LogoMipLevel base{};
    base.Width = width;
    base.Height = height;
    base.Pixels.assign(pixels, pixels + (size_t)width * height * 4);
    mips.push_back(std::move(base));

    while (mips.back().Width > 1 || mips.back().Height > 1)
    {
        const LogoMipLevel& src = mips.back();
        LogoMipLevel dst{};
        dst.Width = src.Width > 1 ? src.Width / 2 : 1;
        dst.Height = src.Height > 1 ? src.Height / 2 : 1;
        dst.Pixels.resize((size_t)dst.Width * dst.Height * 4);

        for (UINT y = 0; y < dst.Height; y++)
        {
            for (UINT x = 0; x < dst.Width; x++)
            {
                UINT r = 0, g = 0, b = 0, a = 0;
                for (UINT oy = 0; oy < 2; oy++)
                {
                    const UINT sy = min(src.Height - 1, y * 2 + oy);
                    for (UINT ox = 0; ox < 2; ox++)
                    {
                        const UINT sx = min(src.Width - 1, x * 2 + ox);
                        const uint8_t* p = &src.Pixels[((size_t)sy * src.Width + sx) * 4];
                        const UINT alpha = p[3];
                        r += p[0] * alpha;
                        g += p[1] * alpha;
                        b += p[2] * alpha;
                        a += alpha;
                    }
                }

                uint8_t* out = &dst.Pixels[((size_t)y * dst.Width + x) * 4];
                out[3] = (uint8_t)(a / 4);
                if (a > 0)
                {
                    out[0] = (uint8_t)(r / a);
                    out[1] = (uint8_t)(g / a);
                    out[2] = (uint8_t)(b / a);
                }
                else
                {
                    out[0] = out[1] = out[2] = 0;
                }
            }
        }

        mips.push_back(std::move(dst));
    }

    return mips;
}

void GUI_LoadTexturesDX12(ID3D12Device* device, ID3D12CommandQueue* commandQueue, D3D12_CPU_DESCRIPTOR_HANDLE srvCpu, D3D12_GPU_DESCRIPTOR_HANDLE srvGpu)
{
    if (!device || !commandQueue || !srvCpu.ptr || !srvGpu.ptr)
        return;

    int w, h, ch;
    unsigned char* pixels = stbi_load_from_memory(Icon, (int)sizeof(Icon), &w, &h, &ch, 4);
    if (!pixels)
        return;

    std::vector<LogoMipLevel> mips = BuildLogoMipChain(pixels, (UINT)w, (UINT)h);
    stbi_image_free(pixels);
    if (mips.empty())
        return;

    if (g_LogoTextureDX12)
    {
        g_LogoTextureDX12->Release();
        g_LogoTextureDX12 = nullptr;
    }

    D3D12_RESOURCE_DESC texDesc{};
    texDesc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    texDesc.Width = (UINT64)w;
    texDesc.Height = (UINT)h;
    texDesc.DepthOrArraySize = 1;
    texDesc.MipLevels = (UINT16)mips.size();
    texDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    texDesc.SampleDesc.Count = 1;
    texDesc.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;

    D3D12_HEAP_PROPERTIES defaultHeap{};
    defaultHeap.Type = D3D12_HEAP_TYPE_DEFAULT;

    HRESULT hr = device->CreateCommittedResource(
        &defaultHeap,
        D3D12_HEAP_FLAG_NONE,
        &texDesc,
        D3D12_RESOURCE_STATE_COPY_DEST,
        nullptr,
        IID_PPV_ARGS(&g_LogoTextureDX12));

    if (FAILED(hr))
    {
        return;
    }

    UINT64 uploadSize = 0;
    const UINT mipCount = (UINT)mips.size();
    std::vector<D3D12_PLACED_SUBRESOURCE_FOOTPRINT> footprints(mipCount);
    std::vector<UINT> numRows(mipCount);
    std::vector<UINT64> rowSizeInBytes(mipCount);
    device->GetCopyableFootprints(&texDesc, 0, mipCount, 0, footprints.data(), numRows.data(), rowSizeInBytes.data(), &uploadSize);

    D3D12_HEAP_PROPERTIES uploadHeap{};
    uploadHeap.Type = D3D12_HEAP_TYPE_UPLOAD;

    D3D12_RESOURCE_DESC uploadDesc{};
    uploadDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    uploadDesc.Width = uploadSize;
    uploadDesc.Height = 1;
    uploadDesc.DepthOrArraySize = 1;
    uploadDesc.MipLevels = 1;
    uploadDesc.SampleDesc.Count = 1;
    uploadDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;

    ID3D12Resource* uploadBuffer = nullptr;
    hr = device->CreateCommittedResource(
        &uploadHeap,
        D3D12_HEAP_FLAG_NONE,
        &uploadDesc,
        D3D12_RESOURCE_STATE_GENERIC_READ,
        nullptr,
        IID_PPV_ARGS(&uploadBuffer));

    if (FAILED(hr))
    {
        g_LogoTextureDX12->Release();
        g_LogoTextureDX12 = nullptr;
        return;
    }

    uint8_t* mapped = nullptr;
    D3D12_RANGE readRange{};
    if (FAILED(uploadBuffer->Map(0, &readRange, (void**)&mapped)))
    {
        uploadBuffer->Release();
        g_LogoTextureDX12->Release();
        g_LogoTextureDX12 = nullptr;
        return;
    }

    for (UINT mip = 0; mip < mipCount; mip++)
    {
        const LogoMipLevel& level = mips[mip];
        const UINT srcPitch = level.Width * 4;
        uint8_t* dst = mapped + footprints[mip].Offset;
        for (UINT row = 0; row < level.Height; row++)
            memcpy(dst + row * footprints[mip].Footprint.RowPitch, level.Pixels.data() + (size_t)row * srcPitch, srcPitch);
    }

    uploadBuffer->Unmap(0, nullptr);

    ID3D12CommandAllocator* allocator = nullptr;
    ID3D12GraphicsCommandList* commandList = nullptr;
    ID3D12Fence* fence = nullptr;
    HANDLE fenceEvent = nullptr;

    hr = device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&allocator));
    if (SUCCEEDED(hr))
        hr = device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, allocator, nullptr, IID_PPV_ARGS(&commandList));
    if (SUCCEEDED(hr))
        hr = device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence));
    if (SUCCEEDED(hr))
        fenceEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);

    if (FAILED(hr) || !fenceEvent)
    {
        if (fenceEvent) CloseHandle(fenceEvent);
        if (fence) fence->Release();
        if (commandList) commandList->Release();
        if (allocator) allocator->Release();
        uploadBuffer->Release();
        g_LogoTextureDX12->Release();
        g_LogoTextureDX12 = nullptr;
        return;
    }

    for (UINT mip = 0; mip < mipCount; mip++)
    {
        D3D12_TEXTURE_COPY_LOCATION src{};
        src.pResource = uploadBuffer;
        src.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
        src.PlacedFootprint = footprints[mip];

        D3D12_TEXTURE_COPY_LOCATION dst{};
        dst.pResource = g_LogoTextureDX12;
        dst.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
        dst.SubresourceIndex = mip;

        commandList->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
    }

    D3D12_RESOURCE_BARRIER barrier{};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = g_LogoTextureDX12;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_DEST;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
    commandList->ResourceBarrier(1, &barrier);

    commandList->Close();
    ID3D12CommandList* lists[] = { commandList };
    commandQueue->ExecuteCommandLists(1, lists);
    commandQueue->Signal(fence, 1);
    if (fence->GetCompletedValue() < 1 && SUCCEEDED(fence->SetEventOnCompletion(1, fenceEvent)))
        WaitForSingleObject(fenceEvent, INFINITE);

    D3D12_SHADER_RESOURCE_VIEW_DESC srvDesc{};
    srvDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    srvDesc.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
    srvDesc.Texture2D.MipLevels = mipCount;
    srvDesc.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
    device->CreateShaderResourceView(g_LogoTextureDX12, &srvDesc, srvCpu);

    FGUI::LogoTexture = (ImTextureID)srvGpu.ptr;
    FGUI::LogoW = w;
    FGUI::LogoH = h;

    CloseHandle(fenceEvent);
    fence->Release();
    commandList->Release();
    allocator->Release();
    uploadBuffer->Release();
}

static void PushStyle()
{
    ImFontConfig FontConfig;
    FontConfig.FontDataOwnedByAtlas = false;
    ImGui::GetIO().Fonts->AddFontFromMemoryTTF((void*)Font, sizeof(Font), 17.f, &FontConfig);

    ImGuiStyle& s = ImGui::GetStyle();

    s.WindowRounding = 8.f;
    s.ChildRounding = 6.f;
    s.FrameRounding = 4.5f;
    s.GrabRounding = 16.f;
    s.PopupRounding = 4.f;
    s.ScrollbarRounding = 16.f;
    s.TabRounding = 4.f;
    s.WindowPadding = { 16.f, 14.f };
    s.FramePadding = { 10.f,  5.f };
    s.ItemSpacing = { 8.f,  7.f };
    s.ItemInnerSpacing = { 6.f,  4.f };
    s.IndentSpacing = 18.f;
    s.ScrollbarSize = 18.f;
    s.GrabMinSize = 14.f;
    s.WindowBorderSize = 1.f;
    s.FrameBorderSize = 0.f;

    auto C = [](float r, float g, float b, float a = 1.f) { return ImVec4(r, g, b, a); };
    ImVec4* col = s.Colors;

    // [Rift] brand surface #0F0F19 (was #11151f)
    col[ImGuiCol_WindowBg] = C(0.059f, 0.059f, 0.098f, 1.f);
    col[ImGuiCol_ChildBg] = C(0.059f, 0.059f, 0.098f, 1.f);
    col[ImGuiCol_PopupBg] = C(0.059f, 0.059f, 0.098f, 0.98f);
    col[ImGuiCol_Border] = C(0.141f, 0.141f, 0.227f, 1.f); // [Rift] border #24243A
    col[ImGuiCol_BorderShadow] = C(0.f, 0.f, 0.f, 0.f);
    col[ImGuiCol_FrameBg] = C(0.086f, 0.086f, 0.141f, 1.f); // [Rift] surface-raised #161624
    col[ImGuiCol_FrameBgHovered] = C(0.118f, 0.118f, 0.188f, 1.f);
    col[ImGuiCol_FrameBgActive] = C(0.141f, 0.141f, 0.227f, 1.f);
    col[ImGuiCol_TitleBg] = kNiobiumBg; // [Rift] brand bg #07070C
    col[ImGuiCol_TitleBgActive] = kNiobiumBg;
    col[ImGuiCol_TitleBgCollapsed] = C(0.027f, 0.027f, 0.047f, 0.9f);
    col[ImGuiCol_ScrollbarBg] = C(0.027f, 0.027f, 0.047f, 0.f);
    col[ImGuiCol_ScrollbarGrab] = C(0.141f, 0.141f, 0.227f, 1.f);
    col[ImGuiCol_ScrollbarGrabHovered] = Accent(0.5f);
    col[ImGuiCol_ScrollbarGrabActive] = Accent(1.f);
    col[ImGuiCol_CheckMark] = Accent();
    col[ImGuiCol_SliderGrab] = Accent();
    col[ImGuiCol_SliderGrabActive] = AccentDk();
    col[ImGuiCol_Button] = C(0.086f, 0.086f, 0.141f, 1.f); // [Rift] surface-raised #161624
    col[ImGuiCol_ButtonHovered] = Accent(0.18f);
    col[ImGuiCol_ButtonActive] = Accent(0.32f);
    col[ImGuiCol_Header] = Accent(0.14f);
    col[ImGuiCol_HeaderHovered] = Accent(0.22f);
    col[ImGuiCol_HeaderActive] = Accent(0.32f);
    col[ImGuiCol_Separator] = C(0.141f, 0.141f, 0.227f, 1.f);
    col[ImGuiCol_SeparatorHovered] = Accent(0.4f);
    col[ImGuiCol_SeparatorActive] = Accent(1.f);
    col[ImGuiCol_ResizeGrip] = Accent(0.22f);
    col[ImGuiCol_ResizeGripHovered] = Accent(0.55f);
    col[ImGuiCol_ResizeGripActive] = Accent(0.90f);
    col[ImGuiCol_Tab] = C(0.059f, 0.059f, 0.098f, 1.f);
    col[ImGuiCol_TabHovered] = Accent(0.2f);
    col[ImGuiCol_TabActive] = C(0.086f, 0.086f, 0.141f, 1.f);
    col[ImGuiCol_TabUnfocused] = col[ImGuiCol_Tab];
    col[ImGuiCol_TabUnfocusedActive] = col[ImGuiCol_TabActive];
    col[ImGuiCol_Text] = kNiobiumText; // [Rift] brand text #F4F4F8
    col[ImGuiCol_TextDisabled] = kNiobiumMutedText;
    col[ImGuiCol_PlotLines] = Accent();
    col[ImGuiCol_PlotLinesHovered] = Accent();
    col[ImGuiCol_PlotHistogram] = Accent();
    col[ImGuiCol_PlotHistogramHovered] = AccentDk();
    col[ImGuiCol_TableHeaderBg] = C(0.059f, 0.059f, 0.098f, 1.f);
    col[ImGuiCol_TableBorderLight] = C(0.141f, 0.141f, 0.227f, 1.f);
    col[ImGuiCol_TableBorderStrong] = C(0.141f, 0.141f, 0.227f, 1.f);
    col[ImGuiCol_TableRowBg] = C(0.f, 0.f, 0.f, 0.f);
    col[ImGuiCol_TableRowBgAlt] = C(1.f, 1.f, 1.f, 0.03f);
    col[ImGuiCol_DragDropTarget] = Accent(0.8f);
    col[ImGuiCol_NavHighlight] = Accent();
    col[ImGuiCol_NavWindowingHighlight] = C(1.f, 1.f, 1.f, 0.7f);
    col[ImGuiCol_NavWindowingDimBg] = C(0.8f, 0.8f, 0.8f, 0.2f);
    col[ImGuiCol_ModalWindowDimBg] = C(0.f, 0.f, 0.f, 0.55f);
}

static constexpr float ContentHorizontalInset = 22.f;
static constexpr float SectionBodyIndent = 10.f;

static void SectionLabel(const char* label)
{
    ImGui::Spacing();

    constexpr float HeaderHeight = 28.f;
    const ImVec2 pos = ImGui::GetCursorScreenPos();
    const float headerWidth = (std::max)(
        1.f,
        ImGui::GetContentRegionAvail().x -
            ContentHorizontalInset);
    const ImVec2 end(
        pos.x + headerWidth,
        pos.y + HeaderHeight);
    ImDrawList* drawList = ImGui::GetWindowDrawList();

    drawList->AddRectFilled(
        pos, end,
        ImGui::GetColorU32(ImGuiCol_FrameBg), 4.f);
    // [Rift] The bar on the left runs from brand violet into cyan (the rift light), in every tab.
    drawList->AddRectFilledMultiColor(
        ImVec2(pos.x, pos.y + 1.f), ImVec2(pos.x + 3.f, end.y - 1.f),
        ImGui::GetColorU32(Accent()), ImGui::GetColorU32(Accent()),
        ImGui::GetColorU32(AccentCyan(0.85f)), ImGui::GetColorU32(AccentCyan(0.85f)));

    ImGui::SetCursorScreenPos(ImVec2(
        pos.x + 12.f,
        pos.y +
            (HeaderHeight - ImGui::GetTextLineHeight()) * 0.5f));
    ImGui::TextUnformatted(label);

    ImGui::SetCursorScreenPos(ImVec2(pos.x, end.y + 8.f));
}

static void BeginSectionBody()
{
    ImGui::Indent(SectionBodyIndent);
    ImGui::PushStyleVar(
        ImGuiStyleVar_ItemSpacing, ImVec2(12.f, 7.f));
    ImGui::PushStyleVar(
        ImGuiStyleVar_ItemInnerSpacing, ImVec2(8.f, 4.f));
    ImGui::PushStyleVar(
        ImGuiStyleVar_FramePadding, ImVec2(4.f, 3.f));
}

static void EndSectionBody()
{
    ImGui::PopStyleVar(3);
    ImGui::Unindent(SectionBodyIndent);
}

// [Rift] Building blocks for the short hints (same style as in the Trickshot tab).

// Grey sentence that says what a toggle or button does. Wraps at "width".
// underCheckbox: right below a checkbox, indented to line up with its label.
static void ControlHint(const char* text, float width, bool underCheckbox = false)
{
    const float indent = underCheckbox
        ? ImGui::GetFrameHeight() + ImGui::GetStyle().ItemInnerSpacing.x
        : 0.f;
    if (underCheckbox)
        ImGui::SetCursorPosY(ImGui::GetCursorPosY() - 3.f);
    if (indent > 0.f)
        ImGui::Indent(indent);
    ImGui::PushStyleColor(ImGuiCol_Text, kNiobiumHintText);
    ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + (std::max)(40.f, width - indent));
    ImGui::TextUnformatted(text);
    ImGui::PopTextWrapPos();
    ImGui::PopStyleColor();
    if (indent > 0.f)
        ImGui::Unindent(indent);
}

// Red message when a key could not be assigned (wraps at "width").
// Shown in the "Commands" and "Options" tabs, right where you pick the key.
static void DrawBindError(float width, int owner = 0)
{
    if (g_BindError.empty() || GetTickCount64() >= g_BindErrorUntil ||
        g_BindErrorOwner != owner)
        return;
    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1.f, 0.39f, 0.43f, 1.f));
    ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + (std::max)(40.f, width));
    ImGui::TextUnformatted(g_BindError.c_str());
    ImGui::PopTextWrapPos();
    ImGui::PopStyleColor();
}

// Explanation while the mouse is over the last item.
static void HoverHint(const char* text)
{
    if (text && *text && ImGui::BeginItemTooltip())
    {
        ImGui::PushTextWrapPos(ImGui::GetFontSize() * 18.f);
        ImGui::TextUnformatted(text);
        ImGui::PopTextWrapPos();
        ImGui::EndTooltip();
    }
}

// Long button label if it fits in "width", otherwise the short one.
static const char* FitLabel(const char* longLabel, const char* shortLabel, float width)
{
    const float needed =
        ImGui::CalcTextSize(longLabel, nullptr, true).x +
        ImGui::GetStyle().FramePadding.x * 2.f;
    return needed <= width ? longLabel : shortLabel;
}

// ---------------------------------------------------------------------------------------------
// [Rift] Bubble Builds status (read-only).
// Bubble Builds is the see-through "bubble wrap" build look of Chapter 2 Seasons 5-6. It only
// exists in Performance Mode (the ES3.1 renderer). The launcher turns it on by starting the game
// client with -FeatureLevelES31. It can't be switched while playing, so the menu only reports
// what the launcher did. Same version rules as VersionRules in launcher/core/src/launchargs.rs:
// supported 15.40 <= v < 16.10, experimental 15.30 and 16.10 <= v < 16.50, "lowMeshes"
// 19.00 <= v < 20.00 (Chapter 3 Season 1: Performance Mode with Meshes set to Low, also
// experimental), everything else unavailable.

// Where the status row reads the command line from. The menu preview tool swaps this to show
// every state; the game always uses GetCommandLineW.
static LPWSTR(WINAPI* g_BubbleBuildsCommandLine)() = &GetCommandLineW;

// The version rules and the command line check live in BubbleLook.h, so the game thread (Bubble
// look pause, Client.cpp) uses exactly the same ones.
using EBubbleBuildsLevel = NiobiumBubbleLook::ELevel;

static EBubbleBuildsLevel BubbleBuildsLevelFor(double fortniteVersion)
{
    return NiobiumBubbleLook::LevelFor(fortniteVersion);
}

static const wchar_t* FindCommandLineSwitch(const wchar_t* commandLine, const wchar_t* name)
{
    return NiobiumBubbleLook::FindCommandLineSwitch(commandLine, name);
}

// The version text the launcher passed (-niobiumversion=15.40), digits and dots only.
static std::string LauncherFortniteVersion(const wchar_t* commandLine)
{
    static const wchar_t kSwitch[] = L"-niobiumversion";
    const wchar_t* found = FindCommandLineSwitch(commandLine, kSwitch);
    if (!found || found[_countof(kSwitch) - 1] != L'=')
        return {};

    std::string version;
    for (const wchar_t* at = found + _countof(kSwitch); *at && version.size() < 12; ++at)
    {
        if ((*at >= L'0' && *at <= L'9') || *at == L'.')
            version.push_back(static_cast<char>(*at));
        else
            break;
    }
    if (version.empty() || version == "0")
        return {};
    return version;
}

// "15.40" from 15.4. Early Chapter 1 builds used one decimal ("1.8", "3.5"), later ones two.
static std::string FormatFortniteVersion(double fortniteVersion)
{
    if (!(fortniteVersion > 0.0) || fortniteVersion > 1000.0)
        return {};

    const long long hundredths = std::llround(fortniteVersion * 100.0);
    const long long major = hundredths / 100;
    const long long minor = hundredths % 100;
    char text[32]{};
    if (major < 5 && minor % 10 == 0)
        snprintf(text, sizeof(text), "%lld.%lld", major, minor / 10);
    else
        snprintf(text, sizeof(text), "%lld.%02lld", major, minor);
    return text;
}

// The Fortnite version the menu shows ("19.10"). The running game knows its version best; the
// launcher's text is only the fallback (and the nicer label when both say the same).
// "version" receives the number used for the version rules (0 = unknown).
static std::string MenuFortniteVersionText(const wchar_t* commandLine, double* version)
{
    const std::string launcherVersion = LauncherFortniteVersion(commandLine);
    double current = VersionInfo.FortniteVersion;
    if (!(current > 0.0) && !launcherVersion.empty())
        current = strtod(launcherVersion.c_str(), nullptr);

    std::string versionText = FormatFortniteVersion(current);
    if (!launcherVersion.empty() && current > 0.0 &&
        std::llround(strtod(launcherVersion.c_str(), nullptr) * 100.0) == std::llround(current * 100.0))
    {
        versionText = launcherVersion;
    }
    if (versionText.empty())
        versionText = "this version";
    if (version)
        *version = current;
    return versionText;
}

// Status row: a small dot, then the text (wrapped, never cut off).
static void StatusDotRow(const char* text, ImVec4 dotColour, bool dotFilled, float width)
{
    const float lineHeight = ImGui::GetTextLineHeight();
    const float radius = 4.5f;
    const float dotSpace = radius * 2.f + 8.f;
    const ImVec2 position = ImGui::GetCursorScreenPos();
    const ImVec2 centre(position.x + radius + 1.f, position.y + lineHeight * 0.5f);
    ImDrawList* drawList = ImGui::GetWindowDrawList();
    if (dotFilled)
    {
        drawList->AddCircleFilled(centre, radius + 3.f,
            ImGui::GetColorU32(ImVec4(dotColour.x, dotColour.y, dotColour.z, 0.18f)));
        drawList->AddCircleFilled(centre, radius, ImGui::GetColorU32(dotColour));
    }
    else
    {
        drawList->AddCircle(centre, radius - 0.5f, ImGui::GetColorU32(dotColour), 0, 1.4f);
    }

    ImGui::Indent(dotSpace);
    ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + (std::max)(40.f, width - dotSpace));
    ImGui::TextUnformatted(text);
    ImGui::PopTextWrapPos();
    ImGui::Unindent(dotSpace);
}

// Status colours: success #22C55E, warning #F59E0B (gold is never a warning).
static const ImVec4 kNiobiumSuccess(0.133f, 0.773f, 0.369f, 1.f);
static const ImVec4 kNiobiumWarning(0.961f, 0.620f, 0.043f, 1.f);

static void DrawBubbleBuildsStatus(float width)
{
    const wchar_t* commandLine =
        g_BubbleBuildsCommandLine ? g_BubbleBuildsCommandLine() : nullptr;

    double version = 0.0;
    const std::string versionText = MenuFortniteVersionText(commandLine, &version);

    const EBubbleBuildsLevel level = BubbleBuildsLevelFor(version);
    // Both spellings count, like in the launcher (is_feature_level_es31 in launchargs.rs).
    const bool featureLevelES31 = NiobiumBubbleLook::HasFeatureLevelES31(commandLine);

    std::string status;
    ImVec4 dotColour = kNiobiumMutedText;
    bool dotFilled = false;
    if (level == EBubbleBuildsLevel::Unavailable)
    {
        status = "Bubble Builds: Not available on " + versionText;
    }
    else if (featureLevelES31 &&
        (level == EBubbleBuildsLevel::LowMeshes || level == EBubbleBuildsLevel::Supported))
    {
        // [Rift] 15.40-16.00 and 19.x: the bubbles also need the game's own Meshes setting on
        // Low. It only applies after a restart, so the row follows the value this session
        // started with and only mentions a later change (both read by the game thread,
        // Client.cpp; -1 = not read yet / unknown).
        const int startMeshes =
            NiobiumBubbleLook::StartMeshQuality.load(std::memory_order_acquire);
        const int liveMeshes =
            NiobiumBubbleLook::MeshQuality.load(std::memory_order_acquire);
        if (startMeshes >= 1)
        {
            status = liveMeshes == 0
                ? "Bubble Builds: Meshes is now Low. Restart the game to turn them on."
                : "Bubble Builds: Performance Mode is on, but Meshes is High. "
                  "Set Meshes to Low in Video settings, then restart.";
            dotColour = kNiobiumWarning;
        }
        else if (startMeshes == 0)
        {
            status = liveMeshes >= 1
                ? "Bubble Builds: On (Performance Mode, Meshes Low). "
                  "You set Meshes to High, so they turn off after a restart."
                : "Bubble Builds: On (Performance Mode, Meshes Low)";
            dotColour = kNiobiumSuccess;
        }
        else
        {
            // Meshes couldn't be read: don't claim Low.
            status = "Bubble Builds: On (Performance Mode)";
            dotColour = kNiobiumSuccess;
        }
        dotFilled = true;
    }
    else if (featureLevelES31)
    {
        status = "Bubble Builds: On (set in the launcher)";
        dotColour = kNiobiumSuccess;
        dotFilled = true;
    }
    else
    {
        status = "Bubble Builds: Off " NB_DASH " turn it on in the launcher, then restart the game.";
    }

    StatusDotRow(status.c_str(), dotColour, dotFilled, width);

    if (level == EBubbleBuildsLevel::Experimental || level == EBubbleBuildsLevel::LowMeshes)
    {
        // Small amber "Experimental" pill (warning colour #F59E0B; gold is never a warning).
        const char* badge = "Experimental";
        const ImVec2 textSize = ImGui::CalcTextSize(badge);
        const ImVec2 padding(8.f, 2.f);
        const ImVec2 position = ImGui::GetCursorScreenPos();
        const ImVec2 size(textSize.x + padding.x * 2.f, textSize.y + padding.y * 2.f);
        ImDrawList* drawList = ImGui::GetWindowDrawList();
        const ImVec4 amber = kNiobiumWarning;
        drawList->AddRectFilled(position, ImVec2(position.x + size.x, position.y + size.y),
            ImGui::GetColorU32(ImVec4(amber.x, amber.y, amber.z, 0.14f)), size.y * 0.5f);
        drawList->AddRect(position, ImVec2(position.x + size.x, position.y + size.y),
            ImGui::GetColorU32(ImVec4(amber.x, amber.y, amber.z, 0.55f)), size.y * 0.5f, 0, 1.f);
        drawList->AddText(ImVec2(position.x + padding.x, position.y + padding.y),
            ImGui::GetColorU32(amber), badge);
        ImGui::Dummy(size);
        if (level == EBubbleBuildsLevel::Experimental)
            ControlHint("Epic changed how builds look around this version. Your builds may look normal even with this on.", width);
    }

    if (level == EBubbleBuildsLevel::Unavailable)
    {
        ControlHint("Only on Fortnite 15.40 " NB_DASH " 16.00 (Chapter 2, Seasons 5" NB_DASH "6), "
            "and as an experiment on 19.x (Chapter 3, Season 1). "
            "Try Bubble look or Mobile Builds in the Main tab.", width);
    }
    else if (level == EBubbleBuildsLevel::LowMeshes)
    {
        ControlHint("Chapter 3 version: Performance Mode with Meshes set to Low. Builds look whiter "
            "and more see-through while they go up. The whole game has lower graphics. "
            "Turn it on or off in the launcher. Applies on next launch.", width);
    }
    else
    {
        ControlHint("The see-through \"bubble wrap\" build look from Chapter 2 Seasons 5" NB_DASH "6. "
            "Can't be changed while playing.", width);
    }
}

static bool LabeledSliderInt(
    const char* label,
    const char* id,
    int* value,
    int minimum,
    int maximum,
    float width,
    const char* format = "%d")
{
    ImGui::TextUnformatted(label);
    ImGui::SetNextItemWidth(width);
    return ImGui::SliderInt(
        id, value, minimum, maximum, format,
        ImGuiSliderFlags_AlwaysClamp);
}

static bool IsGameThreadDispatcherReady(); // [Rift] defined with the game-thread mailbox below

// [Rift] One row of the Main > Editing section, drawn by its route (EditFeatureRoutes.h).
// Hook: the checkbox is our client.json switch, as before. Native: the checkbox shows Fortnite's
// own value (read by the game thread about once a second) and a click asks the game thread to
// change it there; nothing is written at startup. Unavailable: greyed out with the reason.
static void DrawEditFeatureRow(
    NiobiumEditRoutes::EFeature feature,
    const char* label,
    std::atomic_bool& hookSetting,
    const char* hookHint,
    const char* nativeHint,
    long long versionHundredths,
    float width)
{
    using NiobiumEditRoutes::EStatus;
    using NiobiumEditRoutes::ERoute;

    const float indent =
        ImGui::GetFrameHeight() + ImGui::GetStyle().ItemInnerSpacing.x;
    const float statusWidth = (std::max)(40.f, width - indent);
    const EStatus status = NiobiumEditRoutes::GetStatus(feature);

    if (NiobiumEditRoutes::PlannedRoute(feature, versionHundredths) == ERoute::Hook)
    {
        if (status == EStatus::HookFailed)
        {
            // Shown off: nothing does this on this version (the saved choice stays as it is).
            bool value = false;
            ImGui::BeginDisabled();
            ImGui::Checkbox(label, &value);
            ImGui::EndDisabled();
            ImGui::Indent(indent);
            ImGui::SetCursorPosY(ImGui::GetCursorPosY() - 3.f);
            StatusDotRow("Couldn't be set up on this version.", kNiobiumWarning, false, statusWidth);
            ImGui::Unindent(indent);
            return;
        }
        // Unknown (startup still running) or installed: the switch works as before.
        PersistentCheckbox(label, hookSetting);
        ControlHint(hookHint, width, true);
        return;
    }

    if (status == EStatus::NativeReady)
    {
        bool value = NiobiumEditRoutes::DisplayedNativeValue(feature) == 1;
        if (ImGui::Checkbox(label, &value))
            NiobiumEditRoutes::RequestNativeWrite(feature, value);
        ControlHint(nativeHint, width, true);
        return;
    }

    // Native route, but not usable (yet): show Fortnite's value if it was ever read, greyed out.
    bool value = NiobiumEditRoutes::NativeValue[NiobiumEditRoutes::Index(feature)].load(
        std::memory_order_acquire) == 1;
    ImGui::BeginDisabled();
    ImGui::Checkbox(label, &value);
    ImGui::EndDisabled();
    ImGui::Indent(indent);
    ImGui::SetCursorPosY(ImGui::GetCursorPosY() - 3.f);
    if (status == EStatus::NativeMissing)
    {
        const wchar_t* commandLine =
            g_BubbleBuildsCommandLine ? g_BubbleBuildsCommandLine() : nullptr;
        const std::string text = "Not available on " +
            MenuFortniteVersionText(commandLine, nullptr) + ".";
        StatusDotRow(text.c_str(), kNiobiumWarning, false, statusWidth);
    }
    else if (status == EStatus::NativeFailed)
    {
        StatusDotRow("Couldn't change it here. Use Fortnite's settings (Game, Building).",
            kNiobiumWarning, false, statusWidth);
    }
    else
    {
        // Waiting / Unknown: the game hasn't loaded your settings yet (or no game thread pump).
        StatusDotRow("Waiting for Fortnite's settings...", kNiobiumMutedText, false, statusWidth);
        ImGui::Unindent(indent);
        ControlHint(nativeHint, width, true);
        return;
    }
    ImGui::Unindent(indent);
}

// [Rift] Status and "Bubble strength" slider under the "Bubble look" checkbox (Main tab),
// indented to line up with the checkbox label. The game thread reports the state
// (NiobiumBubbleLook::State); this only reads it.
static void DrawBubbleLookControls(float width)
{
    const float indent =
        ImGui::GetFrameHeight() + ImGui::GetStyle().ItemInnerSpacing.x;
    const float innerWidth = (std::max)(40.f, width - indent);
    ImGui::Indent(indent);

    const auto state = static_cast<NiobiumBubbleLook::EState>(
        NiobiumBubbleLook::State.load(std::memory_order_acquire));
    // Without the game-thread pump (unsupported client build) nothing ever runs Bubble look,
    // so "Off" there means it can't work, not "waiting".
    if (state == NiobiumBubbleLook::EState::Unavailable ||
        (state == NiobiumBubbleLook::EState::Off && !IsGameThreadDispatcherReady()))
    {
        const wchar_t* commandLine =
            g_BubbleBuildsCommandLine ? g_BubbleBuildsCommandLine() : nullptr;
        const std::string status = "Bubble look isn't available on " +
            MenuFortniteVersionText(commandLine, nullptr) + ".";
        StatusDotRow(status.c_str(), kNiobiumWarning, false, innerWidth);
        // No strength slider: there is nothing it could change on this version.
        ImGui::Unindent(indent);
        return;
    }
    else if (state == NiobiumBubbleLook::EState::Paused)
    {
        // [Rift] Epic's own Bubble Builds are on (Performance Mode, Meshes Low): the game
        // thread put the original values back. No slider: nothing is changed while paused.
        StatusDotRow("Paused: Bubble Builds are already on. Bubble look would only blur them more.",
            kNiobiumMutedText, false, innerWidth);
        ImGui::Unindent(indent);
        return;
    }
    else if (state == NiobiumBubbleLook::EState::Active)
    {
        const int applied = (std::min)(NiobiumBubbleLook::TextureCount, (std::max)(1,
            NiobiumBubbleLook::AppliedCount.load(std::memory_order_acquire)));
        char status[96]{};
        snprintf(status, sizeof(status), "Bubble look: on (%d of %d build textures)",
            applied, NiobiumBubbleLook::TextureCount);
        StatusDotRow(status, kNiobiumSuccess, true, innerWidth);
    }
    else
    {
        // Off (the game thread hasn't seen the switch yet, at most a second) counts as
        // waiting, too.
        StatusDotRow("Bubble look: waiting for the build textures. Place one build piece.",
            kNiobiumMutedText, false, innerWidth);
    }

    int strength = NiobiumBubbleLook::SanitizeStrength(
        FConfiguration::BubbleStrength.load(std::memory_order_acquire));
    if (LabeledSliderInt(
            "Bubble strength", "##bubble_strength",
            &strength, NiobiumBubbleLook::MinStrength, NiobiumBubbleLook::MaxStrength,
            innerWidth))
    {
        // The game thread picks the new value up within about a second.
        FConfiguration::BubbleStrength.store(
            NiobiumBubbleLook::SanitizeStrength(strength), std::memory_order_release);
    }
    // Saved once the slider is let go, not on every step while dragging.
    if (ImGui::IsItemDeactivatedAfterEdit())
        SaveUserPreferences();
    ControlHint("Higher = softer bubbles.", innerWidth);
    {
        // [Rift] Experimental Bubble Builds versions in Performance Mode: Epic's look may be
        // partly there, so Bubble look adds to it.
        const wchar_t* commandLine =
            g_BubbleBuildsCommandLine ? g_BubbleBuildsCommandLine() : nullptr;
        double version = 0.0;
        MenuFortniteVersionText(commandLine, &version);
        if (BubbleBuildsLevelFor(version) == EBubbleBuildsLevel::Experimental &&
            NiobiumBubbleLook::HasFeatureLevelES31(commandLine))
        {
            ControlHint("Lower Bubble strength if builds look too blurry.", innerWidth);
        }
    }

    ImGui::Unindent(indent);
}

static bool LabeledCombo(
    const char* label,
    const char* id,
    int* value,
    const char* const items[],
    int itemCount,
    float width)
{
    if (label && label[0] != '\0')
        ImGui::TextUnformatted(label);
    ImGui::SetNextItemWidth(width);
    return ImGui::Combo(
        id, value, items, itemCount);
}

// [Rift] One Rift menu: the sidebar order. Main and the host's match controls first, then the
// trickshot tools, your own commands, the options and the credits. The tab id is the index.
enum ERiftMenuTab : int
{
    TabMain = 0,
    TabHost = 1,
    TabTrickshot = 2,
    TabCommands = 3,
    TabOptions = 4,
    TabCredits = 5,
};

static bool SidebarTab(const char* label, int index, float height)
{
    ImGui::PushID(index);
    const bool active = (FGUI::ActiveTab == index);

    const ImVec2 size(ImGui::GetContentRegionAvail().x, height);
    const ImVec2 p = ImGui::GetCursorScreenPos();

    const bool pressed = ImGui::InvisibleButton("##tab", size);
    const bool hovered = ImGui::IsItemHovered();

    ImDrawList* dl = ImGui::GetWindowDrawList();

    if (active)
        dl->AddRectFilled(p, ImVec2(p.x + size.x, p.y + size.y), ImGui::GetColorU32(Accent(0.10f)));
    else if (hovered)
        dl->AddRectFilled(p, ImVec2(p.x + size.x, p.y + size.y), ImGui::GetColorU32(Accent(0.05f)));

    ImVec4 textCol = active ? AccentText() : ImVec4(0.56f, 0.56f, 0.66f, 1.f); // [Rift] violet-text
    if (!active && hovered) textCol = ImVec4(0.82f, 0.82f, 0.90f, 1.f);

    const ImVec2 ts = ImGui::CalcTextSize(label);
    dl->AddText(ImVec2(p.x + 26.f, p.y + (size.y - ts.y) * 0.5f), ImGui::GetColorU32(textCol), label);

    if (pressed)
        FGUI::ActiveTab = index;

    ImGui::PopID();
    return pressed;
}

static void QueueCommandError(const wchar_t* message)
{
    if (!message || !*message)
        return;

    GUI_QueueConsoleOutput(message, static_cast<int>(wcslen(message)));
}


static bool IsExecutableAddress(const void* address)
{
    if (!address)
        return false;

    MEMORY_BASIC_INFORMATION region{};
    if (VirtualQuery(
            address, &region, sizeof(region)) !=
        sizeof(region))
    {
        return false;
    }

    const DWORD executableProtection =
        PAGE_EXECUTE | PAGE_EXECUTE_READ |
        PAGE_EXECUTE_READWRITE |
        PAGE_EXECUTE_WRITECOPY;
    return region.State == MEM_COMMIT &&
        (region.Protect &
            (PAGE_GUARD | PAGE_NOACCESS)) == 0 &&
        (region.Protect & executableProtection) != 0;
}

static bool IsReadableRange(
    const void* address,
    size_t length)
{
    if (!address || length == 0)
        return false;

    const uintptr_t begin =
        reinterpret_cast<uintptr_t>(address);
    if (length > SIZE_MAX - begin)
        return false;

    const uintptr_t end = begin + length;
    uintptr_t current = begin;
    while (current < end)
    {
        MEMORY_BASIC_INFORMATION region{};
        if (VirtualQuery(
                reinterpret_cast<const void*>(current),
                &region, sizeof(region)) !=
                sizeof(region) ||
            region.State != MEM_COMMIT ||
            (region.Protect &
                (PAGE_GUARD | PAGE_NOACCESS)) != 0 ||
            region.RegionSize == 0)
        {
            return false;
        }

        const uintptr_t regionBegin =
            reinterpret_cast<uintptr_t>(
                region.BaseAddress);
        if (region.RegionSize >
            SIZE_MAX - regionBegin)
        {
            return false;
        }

        const uintptr_t regionEnd =
            regionBegin + region.RegionSize;
        if (regionEnd <= current)
            return false;

        current = (std::min)(end, regionEnd);
    }
    return true;
}

// UE4's Kismet ExecuteConsoleCommand ultimately invokes the virtual
// APlayerController::ConsoleCommand method with bWriteToLog=true, which throws
// away the FString it builds. Resolve that exact virtual slot from Kismet's
// native implementation and call it with bWriteToLog=false so the normal UE
// response can be copied into the ATLAS console without intercepting an
// uncertain UConsole vtable entry.
using PlayerConsoleCommandNative =
    FString*(*)(UObject*, FString*, const FString*, bool);

static std::atomic_size_t g_PlayerConsoleCommandIndex = SIZE_MAX;
static ULONGLONG g_NextPlayerConsoleCommandResolveAt = 0;

static bool GetBoundedFunctionRange(
    uintptr_t address,
    size_t maximumSize,
    uintptr_t* functionStart,
    uintptr_t* functionEnd)
{
    if (!address || !functionStart || !functionEnd ||
        !IsExecutableAddress(
            reinterpret_cast<void*>(address)))
    {
        return false;
    }

    DWORD64 imageBase = 0;
    const PRUNTIME_FUNCTION runtimeFunction =
        RtlLookupFunctionEntry(
            static_cast<DWORD64>(address),
            &imageBase, nullptr);
    if (!runtimeFunction || !imageBase)
        return false;

    const uintptr_t start =
        static_cast<uintptr_t>(
            imageBase + runtimeFunction->BeginAddress);
    const uintptr_t end =
        static_cast<uintptr_t>(
            imageBase + runtimeFunction->EndAddress);
    if (address < start || address >= end ||
        end <= start ||
        static_cast<size_t>(end - start) >
            maximumSize)
    {
        return false;
    }

    *functionStart = start;
    *functionEnd = end;
    return true;
}

static uintptr_t FollowSimpleJump(uintptr_t address)
{
    for (unsigned int depth = 0; depth < 2; depth++)
    {
        if (!IsExecutableAddress(
                reinterpret_cast<void*>(address)))
        {
            return 0;
        }

        __try
        {
            const auto bytes =
                reinterpret_cast<const uint8_t*>(address);
            if (bytes[0] == 0xE9)
            {
                const int32_t relative =
                    *reinterpret_cast<const int32_t*>(
                        address + 1);
                address = address + 5 + relative;
                continue;
            }

            if (bytes[0] == 0xFF &&
                bytes[1] == 0x25)
            {
                const int32_t relative =
                    *reinterpret_cast<const int32_t*>(
                        address + 2);
                address =
                    *reinterpret_cast<const uintptr_t*>(
                        address + 6 + relative);
                continue;
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER)
        {
            return 0;
        }

        break;
    }
    return address;
}

static bool DecodeRegisterMove(
    const uint8_t* bytes,
    unsigned int* destination,
    unsigned int* source)
{
    if (!bytes || !destination || !source)
        return false;

    const uint8_t rex = bytes[0];
    if ((rex & 0xF8) != 0x48)
        return false;

    const uint8_t opcode = bytes[1];
    const uint8_t modRm = bytes[2];
    if ((opcode != 0x8B && opcode != 0x89) ||
        (modRm & 0xC0) != 0xC0)
    {
        return false;
    }

    const unsigned int reg =
        ((modRm >> 3) & 7u) |
        ((rex & 0x04) ? 8u : 0u);
    const unsigned int rm =
        (modRm & 7u) |
        ((rex & 0x01) ? 8u : 0u);
    if (opcode == 0x8B)
    {
        *destination = reg;
        *source = rm;
    }
    else
    {
        *destination = rm;
        *source = reg;
    }
    return true;
}

static bool LooksLikePlayerConsoleCommand(
    uintptr_t target,
    uint32_t playerOffset)
{
    target = FollowSimpleJump(target);
    if (!target || playerOffset == UINT32_MAX)
        return false;

    uintptr_t functionStart = 0;
    uintptr_t functionEnd = 0;
    if (!GetBoundedFunctionRange(
            target, 0x100,
            &functionStart, &functionEnd))
    {
        return false;
    }

    // A vtable entry must point at the beginning of the resolved runtime
    // function (after following a short import/hot-patch jump). Rejecting
    // interior addresses prevents an unrelated byte sequence from being
    // treated as a complete ConsoleCommand wrapper.
    if (target != functionStart)
        return false;

    uintptr_t savesResultAt = 0;
    uintptr_t loadsPlayerAt = 0;
    uintptr_t testsPlayerAt = 0;
    uintptr_t callsPlayerAt = 0;
    uintptr_t restoresResultAt = 0;
    uintptr_t returnsAt = 0;
    int savedResultRegister = -1;

    __try
    {
        for (uintptr_t cursor = functionStart;
            cursor < functionEnd; cursor++)
        {
            const auto bytes =
                reinterpret_cast<const uint8_t*>(cursor);

            unsigned int destination = 0;
            unsigned int source = 0;
            if (cursor + 3 <= functionEnd &&
                DecodeRegisterMove(
                    bytes, &destination, &source))
            {
                if (!savesResultAt &&
                    cursor - functionStart <= 32 &&
                    source == 2 &&
                    (destination == 3 ||
                        destination == 5 ||
                        destination == 6 ||
                        destination == 7 ||
                        destination >= 12))
                {
                    savesResultAt = cursor;
                    savedResultRegister =
                        static_cast<int>(destination);
                }

                if (callsPlayerAt &&
                    !restoresResultAt &&
                    destination == 0 &&
                    savedResultRegister >= 0 &&
                    source ==
                        static_cast<unsigned int>(
                            savedResultRegister))
                {
                    restoresResultAt = cursor;
                }
            }

            if (!loadsPlayerAt &&
                cursor - functionStart <= 32 &&
                ((cursor + 7 <= functionEnd &&
                    bytes[0] == 0x48 &&
                    bytes[1] == 0x8B &&
                    bytes[2] == 0x89 &&
                    *reinterpret_cast<const uint32_t*>(
                        cursor + 3) == playerOffset) ||
                    (cursor + 4 <= functionEnd &&
                        bytes[0] == 0x48 &&
                        bytes[1] == 0x8B &&
                        bytes[2] == 0x49 &&
                        playerOffset <= 0x7F &&
                        bytes[3] ==
                            static_cast<uint8_t>(
                                playerOffset))))
            {
                loadsPlayerAt = cursor;
            }

            if (!testsPlayerAt &&
                loadsPlayerAt &&
                savesResultAt &&
                cursor > (std::max)(
                    loadsPlayerAt, savesResultAt) &&
                cursor - (std::max)(
                    loadsPlayerAt, savesResultAt) <= 12 &&
                cursor + 3 <= functionEnd &&
                bytes[0] == 0x48 &&
                bytes[1] == 0x85 &&
                bytes[2] == 0xC9)
            {
                testsPlayerAt = cursor;
            }

            if (!callsPlayerAt &&
                testsPlayerAt &&
                cursor > testsPlayerAt &&
                cursor - testsPlayerAt <= 16 &&
                bytes[0] == 0xE8 &&
                cursor + 5 <= functionEnd)
            {
                callsPlayerAt = cursor;
            }

            if (!returnsAt &&
                restoresResultAt &&
                cursor > restoresResultAt &&
                cursor - restoresResultAt <= 16 &&
                bytes[0] == 0xC3)
            {
                returnsAt = cursor;
            }
        }
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        return false;
    }

    return savesResultAt &&
        loadsPlayerAt &&
        ((savesResultAt > loadsPlayerAt
                ? savesResultAt - loadsPlayerAt
                : loadsPlayerAt - savesResultAt) <= 16) &&
        testsPlayerAt &&
        callsPlayerAt &&
        restoresResultAt &&
        returnsAt;
}

static uintptr_t FindResultBufferWrite(
    uintptr_t start,
    uintptr_t end)
{
    for (uintptr_t cursor = start;
        cursor + 5 <= end; cursor++)
    {
        const auto bytes =
            reinterpret_cast<const uint8_t*>(cursor);
        if (bytes[0] == 0x48 &&
            bytes[1] == 0x8D &&
            bytes[2] == 0x54 &&
            bytes[3] == 0x24)
        {
            return cursor;
        }

        if (cursor + 8 <= end &&
            bytes[0] == 0x48 &&
            bytes[1] == 0x8D &&
            bytes[2] == 0x94 &&
            bytes[3] == 0x24)
        {
            return cursor;
        }
    }
    return 0;
}

static uintptr_t FindR9One(
    uintptr_t start,
    uintptr_t end)
{
    for (uintptr_t cursor = start;
        cursor + 3 <= end; cursor++)
    {
        const auto bytes =
            reinterpret_cast<const uint8_t*>(cursor);
        if (bytes[0] == 0x41 &&
            bytes[1] == 0xB1 &&
            bytes[2] == 0x01)
        {
            return cursor;
        }

        if (cursor + 6 <= end &&
            bytes[0] == 0x41 &&
            bytes[1] == 0xB9 &&
            *reinterpret_cast<const uint32_t*>(
                cursor + 2) == 1)
        {
            return cursor;
        }
    }
    return 0;
}

static uintptr_t FindR8Write(
    uintptr_t start,
    uintptr_t end)
{
    for (uintptr_t cursor = start;
        cursor + 3 <= end; cursor++)
    {
        const auto bytes =
            reinterpret_cast<const uint8_t*>(cursor);
        const uint8_t rex = bytes[0];
        if ((rex & 0xF8) == 0x48 &&
            (rex & 0x04) != 0 &&
            (bytes[1] == 0x8B ||
                bytes[1] == 0x8D) &&
            (bytes[2] & 0x38) == 0)
        {
            return cursor;
        }
    }
    return 0;
}

static bool DecodeVtableLoad(
    const uint8_t* bytes,
    unsigned int* vtableRegister,
    unsigned int* controllerRegister)
{
    if (!bytes || !vtableRegister ||
        !controllerRegister)
        return false;

    const uint8_t rex = bytes[0];
    const uint8_t modRm = bytes[2];
    if ((rex & 0xF8) != 0x48 ||
        bytes[1] != 0x8B ||
        (modRm & 0xC0) != 0 ||
        (modRm & 7u) == 4u ||
        (modRm & 7u) == 5u)
    {
        return false;
    }

    *vtableRegister =
        ((modRm >> 3) & 7u) |
        ((rex & 0x04) ? 8u : 0u);
    *controllerRegister =
        (modRm & 7u) |
        ((rex & 0x01) ? 8u : 0u);
    return true;
}

static bool DecodeVirtualCall(
    uintptr_t address,
    uintptr_t end,
    unsigned int* vtableRegister,
    uint32_t* byteOffset,
    size_t* instructionLength)
{
    if (!address || !vtableRegister ||
        !byteOffset || !instructionLength ||
        address >= end)
    {
        return false;
    }

    const auto start =
        reinterpret_cast<const uint8_t*>(address);
    size_t prefixLength = 0;
    uint8_t rex = 0;
    if ((start[0] & 0xF0) == 0x40)
    {
        rex = start[0];
        prefixLength = 1;
    }

    if (address + prefixLength + 6 > end)
        return false;

    const auto bytes = start + prefixLength;
    const uint8_t modRm = bytes[1];
    if (bytes[0] != 0xFF ||
        (modRm & 0xC0) != 0x80 ||
        ((modRm >> 3) & 7u) != 2u ||
        (rex & 0x06) != 0)
    {
        return false;
    }

    const unsigned int rm = modRm & 7u;
    size_t displacementOffset = 2;
    unsigned int baseRegister = rm;
    if (rm == 4u)
    {
        if (address + prefixLength + 7 > end)
            return false;

        const uint8_t sib = bytes[2];
        // A vtable call only needs a base register. Reject indexed SIB forms
        // so an unrelated array-style indirect call cannot qualify.
        if (((sib >> 3) & 7u) != 4u ||
            (rex & 0x02) != 0)
        {
            return false;
        }
        baseRegister = sib & 7u;
        displacementOffset = 3;
    }

    baseRegister |=
        (rex & 0x01) ? 8u : 0u;
    *vtableRegister = baseRegister;
    *byteOffset =
        *reinterpret_cast<const uint32_t*>(
            bytes + displacementOffset);
    *instructionLength =
        prefixLength + displacementOffset + 4;
    return true;
}

static bool MatchesPlayerConsoleCallSite(
    uintptr_t start,
    uintptr_t call,
    unsigned int callVtableRegister)
{
    // Known optimized UE4 builds emit this dataflow in order:
    //   vtable load -> result buffer -> true -> command -> this -> call.
    // Requiring both the order and short instruction gaps avoids combining
    // unrelated bytes from the surrounding implementation.
    for (uintptr_t vtableLoad = start;
        vtableLoad + 3 <= call; vtableLoad++)
    {
        unsigned int vtableRegister = 0;
        unsigned int controllerRegister = 0;
        if (!DecodeVtableLoad(
                reinterpret_cast<const uint8_t*>(
                    vtableLoad),
                &vtableRegister,
                &controllerRegister))
        {
            continue;
        }
        if (vtableRegister != callVtableRegister)
            continue;

        const uintptr_t resultBuffer =
            FindResultBufferWrite(
                vtableLoad + 3,
                (std::min)(call, vtableLoad + 15));
        if (!resultBuffer)
            continue;

        const uintptr_t r9One =
            FindR9One(
                resultBuffer + 3,
                (std::min)(call, resultBuffer + 15));
        if (!r9One)
            continue;

        const uintptr_t r8Write =
            FindR8Write(
                r9One + 3,
                (std::min)(call, r9One + 15));
        if (!r8Write)
            continue;

        for (uintptr_t restoresRcx = r8Write + 3;
            restoresRcx + 3 <= call &&
                restoresRcx < r8Write + 15;
            restoresRcx++)
        {
            unsigned int destination = 0;
            unsigned int source = 0;
            if (DecodeRegisterMove(
                    reinterpret_cast<const uint8_t*>(
                        restoresRcx),
                    &destination, &source) &&
                destination == 1 &&
                source == controllerRegister &&
                call - restoresRcx <= 8)
            {
                return true;
            }
        }
    }
    return false;
}

static bool FindPlayerConsoleCommandIndex(
    uintptr_t implementation,
    UObject* controller,
    size_t* resolvedIndex)
{
    if (!controller || !controller->Vft ||
        !resolvedIndex)
    {
        return false;
    }

    uintptr_t functionStart = 0;
    uintptr_t functionEnd = 0;
    implementation = FollowSimpleJump(implementation);
    if (!implementation ||
        !GetBoundedFunctionRange(
            implementation, 0x1000,
            &functionStart, &functionEnd))
    {
        return false;
    }

    const uint32_t playerOffset =
        controller->GetOffset("Player");
    if (playerOffset == UINT32_MAX)
        return false;

    size_t uniqueIndex = SIZE_MAX;
    __try
    {
        for (uintptr_t call = functionStart;
            call < functionEnd; call++)
        {
            unsigned int callVtableRegister = 0;
            uint32_t byteOffset = 0;
            size_t callLength = 0;
            if (!DecodeVirtualCall(
                    call, functionEnd,
                    &callVtableRegister,
                    &byteOffset,
                    &callLength))
            {
                continue;
            }

            if (callLength < 6 ||
                (byteOffset & 7u) != 0)
            {
                continue;
            }

            const size_t index =
                static_cast<size_t>(byteOffset / 8u);
            if (index >= 768)
                continue;

            const uintptr_t windowStart =
                call > functionStart + 48
                    ? call - 48
                    : functionStart;
            if (!MatchesPlayerConsoleCallSite(
                    windowStart, call,
                    callVtableRegister))
            {
                continue;
            }

            const uintptr_t target =
                reinterpret_cast<uintptr_t>(
                    controller->Vft[index]);
            if (!LooksLikePlayerConsoleCommand(
                    target, playerOffset))
            {
                continue;
            }

            if (uniqueIndex != SIZE_MAX &&
                uniqueIndex != index)
            {
                return false;
            }
            uniqueIndex = index;
        }
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        return false;
    }

    if (uniqueIndex == SIZE_MAX)
        return false;

    *resolvedIndex = uniqueIndex;
    return true;
}

static bool TryResolvePlayerConsoleCommand(
    UObject* controller)
{
    if (g_PlayerConsoleCommandIndex.load(
            std::memory_order_acquire) != SIZE_MAX)
    {
        return true;
    }

    const ULONGLONG now = GetTickCount64();
    if (now < g_NextPlayerConsoleCommandResolveAt)
        return false;
    g_NextPlayerConsoleCommandResolveAt = now + 1000;

    auto library =
        UKismetSystemLibrary::GetDefaultObj();
    UFunction* function =
        library
            ? library->GetFunction(
                "ExecuteConsoleCommand")
            : nullptr;
    const uintptr_t nativeWrapper =
        function
            ? reinterpret_cast<uintptr_t>(
                function->GetNativeFunc())
            : 0;

    uintptr_t wrapperStart = 0;
    uintptr_t wrapperEnd = 0;
    if (!nativeWrapper ||
        !GetBoundedFunctionRange(
            nativeWrapper, 0x1000,
            &wrapperStart, &wrapperEnd))
    {
        return false;
    }

    size_t resolvedIndex = SIZE_MAX;
    bool sawSetNotZero = false;
    __try
    {
        for (uintptr_t cursor = wrapperStart;
            cursor < wrapperEnd; cursor++)
        {
            const auto bytes =
                reinterpret_cast<const uint8_t*>(cursor);
            if (cursor + 2 <= wrapperEnd &&
                bytes[0] == 0x0F &&
                bytes[1] == 0x95)
            {
                sawSetNotZero = true;
                continue;
            }

            if (!sawSetNotZero ||
                cursor + 5 > wrapperEnd ||
                (bytes[0] != 0xE8 &&
                    bytes[0] != 0xE9))
            {
                continue;
            }

            const int32_t relative =
                *reinterpret_cast<const int32_t*>(
                    cursor + 1);
            const uintptr_t candidate =
                cursor + 5 + relative;
            if (FindPlayerConsoleCommandIndex(
                    candidate, controller,
                    &resolvedIndex))
            {
                break;
            }
        }
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        return false;
    }

    if (resolvedIndex == SIZE_MAX)
    {
        AtlasDiagnostics::WriteLine(
            "console-return-path resolve-failed "
            "wrapper=%p",
            reinterpret_cast<void*>(nativeWrapper));
        return false;
    }

    g_PlayerConsoleCommandIndex.store(
        resolvedIndex, std::memory_order_release);
    AtlasDiagnostics::WriteLine(
        "console-return-path resolved index=%zu "
        "target=%p",
        resolvedIndex,
        controller->Vft[resolvedIndex]);
    return true;
}

static PlayerConsoleCommandNative ReadPlayerConsoleCommand(
    UObject* controller,
    size_t index)
{
    __try
    {
        return controller && controller->Vft
            ? reinterpret_cast<PlayerConsoleCommandNative>(
                controller->Vft[index])
            : nullptr;
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        return nullptr;
    }
}

static bool InvokePlayerConsoleCommand(
    PlayerConsoleCommandNative native,
    UObject* controller,
    FString* output,
    const FString* command)
{
    __try
    {
        native(controller, output, command, false);
        return true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        return false;
    }
}

static bool FreeReturnedConsoleOutput(
    FString* output)
{
    __try
    {
        output->Free();
        return true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        return false;
    }
}

static bool QueueReturnedConsoleOutput(
    FString* output,
    int length)
{
    __try
    {
        if (length > 0 &&
            output->Data[length - 1] == L'\0')
        {
            length--;
        }

        if (length > 0)
        {
            GUI_QueueConsoleOutput(
                output->Data, length);
        }
        return true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        return false;
    }
}

static bool ExecuteConsoleCommandWithReturnedOutput(
    UObject* controller,
    const FString& command)
{
    // UE5's Kismet path can route CVars through IConsoleManager before it ever
    // reaches PlayerController, so preserve Kismet dispatch there. UE4 routes
    // this same call directly through PlayerController and can safely expose
    // the otherwise-discarded FString response.
    if (VersionInfo.EngineVersion >= 5.0 ||
        !TryResolvePlayerConsoleCommand(controller))
    {
        return false;
    }

    const size_t index =
        g_PlayerConsoleCommandIndex.load(
            std::memory_order_acquire);
    if (index == SIZE_MAX || index >= 768)
        return false;

    const PlayerConsoleCommandNative native =
        ReadPlayerConsoleCommand(controller, index);
    if (!IsExecutableAddress(
            reinterpret_cast<void*>(native)))
    {
        return false;
    }

    FString output{};
    if (!InvokePlayerConsoleCommand(
            native, controller, &output, &command))
    {
        g_PlayerConsoleCommandIndex.store(
            SIZE_MAX, std::memory_order_release);
        AtlasDiagnostics::WriteLine(
            "console-return-path invoke-failed target=%p",
            reinterpret_cast<void*>(native));
        QueueCommandError(
            L"[Rift] Error: the command could not run."); // [Rift]
        // The native call may already have performed part or all of the
        // command before faulting. Treat it as consumed so the Kismet fallback
        // cannot execute a state-changing command twice.
        return true;
    }

    const bool emptyOutput =
        !output.Data &&
        output.NumElements == 0 &&
        output.MaxElements == 0;
    const bool allocatedOutput =
        output.Data &&
        output.NumElements >= 0 &&
        output.MaxElements >= output.NumElements &&
        output.MaxElements > 0 &&
        output.MaxElements <= 65536 &&
        IsReadableRange(
            output.Data,
            static_cast<size_t>(
                (std::max)(output.NumElements, 1)) *
                sizeof(wchar_t));
    if (!emptyOutput && !allocatedOutput)
    {
        g_PlayerConsoleCommandIndex.store(
            SIZE_MAX, std::memory_order_release);
        AtlasDiagnostics::WriteLine(
            "console-return-path invalid-result "
            "data=%p num=%d max=%d",
            output.Data,
            output.NumElements,
            output.MaxElements);
        QueueCommandError(
            L"[Rift] The command ran, but the game's reply could not be read."); // [Rift]
        return true;
    }

    if (allocatedOutput &&
        output.NumElements > 0)
    {
        const int length =
            (std::min)(output.NumElements, 16384);
        if (!QueueReturnedConsoleOutput(
                &output, length))
        {
            AtlasDiagnostics::WriteLine(
                "console-return-path copy-failed "
                "data=%p num=%d max=%d",
                output.Data,
                output.NumElements,
                output.MaxElements);
        }
    }

    if (allocatedOutput &&
        !FreeReturnedConsoleOutput(&output))
    {
        AtlasDiagnostics::WriteLine(
            "console-return-path free-failed");
    }
    return true;
}

static bool ExecNow(const char* cmd, bool showConsoleErrors = true)
{
    if (!cmd || !*cmd)
        return false;

    wchar_t transportError[256]{};
    if (!ATLAS_PrepareReplicationForOpen(
            cmd,
            transportError,
            std::size(transportError)))
    {
        AtlasDiagnostics::WriteLine(
            "command-skip replication-policy command=%s", cmd);
        if (showConsoleErrors)
            QueueCommandError(transportError);
        return false;
    }

    auto world = UWorld::GetWorld();
    if (!world || !world->OwningGameInstance)
    {
        AtlasDiagnostics::WriteLine("command-skip no-world command=%s", cmd);
        if (showConsoleErrors)
            QueueCommandError(L"[Rift] Not right now \u2013 wait until you are in the game."); // [Rift]
        return false;
    }

    auto& localPlayers = world->OwningGameInstance->LocalPlayers;
    if (localPlayers.Num() == 0 || !localPlayers[0] || !localPlayers[0]->PlayerController)
    {
        AtlasDiagnostics::WriteLine("command-skip no-player command=%s", cmd);
        if (showConsoleErrors)
            QueueCommandError(L"[Rift] Not right now \u2013 your character isn't there yet."); // [Rift]
        return false;
    }

    const int len = MultiByteToWideChar(CP_UTF8, 0, cmd, -1, nullptr, 0);
    if (len <= 1)
    {
        if (showConsoleErrors)
            QueueCommandError(L"[Rift] The command has a character that can't be used."); // [Rift]
        return false;
    }

    std::wstring wide(static_cast<size_t>(len), L'\0');
    if (MultiByteToWideChar(CP_UTF8, 0, cmd, -1, wide.data(), len) != len)
    {
        if (showConsoleErrors)
            QueueCommandError(L"[Rift] The command could not be read."); // [Rift]
        return false;
    }
    wide.resize(static_cast<size_t>(len - 1));

    UObject* activeController =
        localPlayers[0]->PlayerController;
    FString command(wide.c_str());
    AtlasDiagnostics::WriteLine(
        "command-dispatch world=%p pc=%p command=%s",
        world, activeController, cmd);

    const bool usedReturnedOutput =
        ExecuteConsoleCommandWithReturnedOutput(
            activeController, command);
    if (!usedReturnedOutput)
    {
        UKismetSystemLibrary::ExecuteConsoleCommand(
            world, command, activeController);
    }

    AtlasDiagnostics::WriteLine(
        "command-return path=%s command=%s",
        usedReturnedOutput ? "player-result" : "kismet",
        cmd);
    command.Free();
    return true;
}

bool GUI_ExecuteInternalConsoleCommand(
    UWorld* world, UObject* controller, const char* commandText)
{
    if (!world || !controller || !commandText || !*commandText)
        return false;

    const int length = MultiByteToWideChar(
        CP_UTF8, 0, commandText, -1, nullptr, 0);
    if (length <= 1)
        return false;

    std::wstring wide(static_cast<size_t>(length), L'\0');
    if (MultiByteToWideChar(
            CP_UTF8, 0, commandText, -1,
            wide.data(), length) != length)
    {
        return false;
    }
    wide.resize(static_cast<size_t>(length - 1));

    FString command(wide.c_str());
    AtlasDiagnostics::WriteLine(
        "internal-command-dispatch world=%p pc=%p command=%s",
        world, controller, commandText);
    UKismetSystemLibrary::ExecuteConsoleCommand(
        world, command, controller);
    command.Free();
    return true;
}

struct FGameThreadCommand
{
    std::string Command;
    bool ShowConsoleErrors = true;
};

// Present owns the UI scheduler, while Unreal command execution must happen
// on the game thread. A one-item mailbox provides strict backpressure: rapid
// binds may fill the regular bounded queue, but they can never re-enter
// ProcessEvent or build an unbounded game-thread backlog.
static std::mutex g_GameThreadCommandMutex;
static std::deque<FGameThreadCommand> g_GameThreadCommands;
static std::atomic_bool g_GameThreadDispatcherReady = false;
static std::atomic_bool g_GameThreadCommandExecuting = false;
static std::atomic_uint64_t g_GameplayMouseRestoreGeneration = 0;
static std::atomic_uint64_t g_GameplayMouseRestoreHandledGeneration = 0;
static std::atomic<HWND> g_GameplayMouseRestoreWindow = nullptr;
static std::atomic<ULONGLONG> g_GameThreadCommandReadyAfter = 0;
static constexpr size_t kMaximumGameThreadCommands = 1;
static constexpr ULONGLONG kGameThreadCommandSettleMs = 100;

void GUI_RequestGameplayMouseRestore(HWND gameWindow)
{
    if (!gameWindow)
        return;

    g_GameplayMouseRestoreWindow.store(
        gameWindow, std::memory_order_release);
    g_GameplayMouseRestoreGeneration.fetch_add(
        1, std::memory_order_acq_rel);
}

void GUI_CancelGameplayMouseRestore()
{
    g_GameplayMouseRestoreHandledGeneration.store(
        g_GameplayMouseRestoreGeneration.load(
            std::memory_order_acquire),
        std::memory_order_release);
}

static bool IsGameThreadDispatcherReady()
{
    return g_GameThreadDispatcherReady.load(std::memory_order_acquire);
}

void GUI_SetGameThreadDispatcherReady(bool ready)
{
    g_GameThreadDispatcherReady.store(ready, std::memory_order_release);
    if (ready)
        return;

    g_GameThreadCommandReadyAfter.store(
        0, std::memory_order_release);
    std::unique_lock<std::mutex> lock(
        g_GameThreadCommandMutex, std::try_to_lock);
    if (lock.owns_lock())
        g_GameThreadCommands.clear();
}

static bool HandOffGameThreadCommand(
    const std::string& command,
    bool showConsoleErrors = true)
{
    if (command.empty() ||
        !g_GameThreadDispatcherReady.load(std::memory_order_acquire) ||
        g_GameThreadCommandExecuting.load(std::memory_order_acquire) ||
        GetTickCount64() <
            g_GameThreadCommandReadyAfter.load(
                std::memory_order_acquire))
    {
        return false;
    }

    std::unique_lock<std::mutex> lock(
        g_GameThreadCommandMutex, std::try_to_lock);
    if (!lock.owns_lock() ||
        g_GameThreadCommandExecuting.load(std::memory_order_acquire) ||
        g_GameThreadCommands.size() >= kMaximumGameThreadCommands)
    {
        return false;
    }

    g_GameThreadCommands.push_back(
        FGameThreadCommand{ command, showConsoleErrors });
    AtlasDiagnostics::WriteLine(
        "command-handoff depth=%zu command=%s",
        g_GameThreadCommands.size(), command.c_str());
    return true;
}

static bool RestoreGameplayMouseNow()
{
    auto world = UWorld::GetWorld();
    if (!world || !world->OwningGameInstance)
        return false;

    auto& localPlayers = world->OwningGameInstance->LocalPlayers;
    if (localPlayers.Num() == 0 || !localPlayers[0] ||
        !localPlayers[0]->PlayerController)
    {
        return false;
    }

    // Present detects the overlay transition, but reflected Unreal calls must
    // stay on this game-thread pump. SetInputMode_GameOnly reapplies Slate's
    // viewport focus, high-precision movement, capture, and lock policy.
    static UObject* widgetLibrary = nullptr;
    static UFunction* setInputModeGameOnly = nullptr;
    static ULONGLONG nextResolveAttemptAt = 0;
    if (!widgetLibrary || !setInputModeGameOnly)
    {
        const ULONGLONG now = GetTickCount64();
        if (now < nextResolveAttemptAt)
            return false;
        nextResolveAttemptAt = now + 1000;

        if (!widgetLibrary)
        {
            const UClass* widgetLibraryClass =
                FindClass("WidgetBlueprintLibrary");
            if (!widgetLibraryClass)
                return false;

            widgetLibrary = widgetLibraryClass->GetDefaultObj();
        }

        if (widgetLibrary)
        {
            setInputModeGameOnly =
                widgetLibrary->GetFunction(
                    "SetInputMode_GameOnly");
        }
    }
    if (!widgetLibrary || !setInputModeGameOnly)
        return false;

    // UE5 adds bFlushInput after the player-controller parameter. The
    // reflective caller ignores this extra argument on older one-parameter
    // versions, keeping the restore compatible across supported builds.
    widgetLibrary->Call<void>(
        setInputModeGameOnly,
        localPlayers[0]->PlayerController,
        false);
    return true;
}

static void PumpGameplayMouseRestore()
{
    const uint64_t mouseRestoreGeneration =
        g_GameplayMouseRestoreGeneration.load(
            std::memory_order_acquire);
    const uint64_t handledMouseRestoreGeneration =
        g_GameplayMouseRestoreHandledGeneration.load(
            std::memory_order_acquire);
    const HWND mouseRestoreWindow =
        g_GameplayMouseRestoreWindow.load(
            std::memory_order_acquire);
    if (mouseRestoreGeneration !=
            handledMouseRestoreGeneration &&
        mouseRestoreWindow &&
        GetForegroundWindow() == mouseRestoreWindow &&
        !GUI_IsOverlayVisible() &&
        RestoreGameplayMouseNow())
    {
        // Do not erase a newer close request that arrived while ProcessEvent
        // was applying the input mode. Also leave this request pending if the
        // overlay reopened or focus changed during that call.
        if (GetForegroundWindow() == mouseRestoreWindow &&
            !GUI_IsOverlayVisible())
        {
            uint64_t handledGeneration =
                g_GameplayMouseRestoreHandledGeneration.load(
                    std::memory_order_acquire);
            while (handledGeneration <
                    mouseRestoreGeneration &&
                !g_GameplayMouseRestoreHandledGeneration
                    .compare_exchange_weak(
                        handledGeneration,
                        mouseRestoreGeneration,
                        std::memory_order_acq_rel,
                        std::memory_order_acquire))
            {
            }
        }
    }
}

static bool TryApplyPendingSettingCommand()
{
    if (Client::GetConsoleSessionGeneration() == 0 ||
        GetTickCount64() <
            g_GameThreadCommandReadyAfter.load(
                std::memory_order_acquire))
    {
        return false;
    }

    std::unique_lock<std::mutex> commandLock(
        g_SettingCommandMutex);

    // [Rift] Free camera and Target info only exist as toggle commands, so the menu keeps an
    // "applied" bit for them. A new world (match start, map change, back to the lobby) starts
    // without either, so forget the old bits and show both as off again. Otherwise the next
    // click could flip the wrong way. (Free camera swaps the local controller inside the same
    // world, so this follows the world, not the controller.)
    {
        const uint64_t world = Client::GetWorldGeneration();
        if (world != g_ToggleSettingWorld)
        {
            const bool hadToggles = g_ToggleSettingWorld != 0 &&
                (g_AppliedToggleSettingMask &
                    (SettingCommandDebugCamera | SettingCommandTargetInfo)) != 0;
            g_ToggleSettingWorld = world;
            g_AppliedToggleSettingMask &=
                ~(SettingCommandDebugCamera | SettingCommandTargetInfo);
            FConfiguration::bDebugCamera.store(false, std::memory_order_release);
            FConfiguration::bTargetInfo.store(false, std::memory_order_release);
            g_PendingSettingCommandMask.fetch_and(
                ~(SettingCommandDebugCamera | SettingCommandTargetInfo),
                std::memory_order_acq_rel);
            if (hadToggles)
            {
                AtlasDiagnostics::WriteLine(
                    "setting-command world-changed toggles-cleared world-generation=%llu",
                    static_cast<unsigned long long>(world));
            }
        }
    }

    unsigned int mask = g_PendingSettingCommandMask.load(
        std::memory_order_acquire);
    if (mask == 0)
        return false;

    unsigned int bit = 0;
    const char* command = nullptr;
    char commandBuffer[64]{};
    bool toggleCommand = false;
    bool toggleDesired = false;
    // [Rift] Which "value set" flag a successful command changes (Mobile Builds / fog).
    bool* valueSetFlag = nullptr;
    bool valueSetAfter = false;
    while (mask != 0 && !command)
    {
        if ((mask & SettingCommandMobileBuilds) != 0)
        {
            bit = SettingCommandMobileBuilds;
            if (FConfiguration::bMobileBuilds.load(
                    std::memory_order_acquire))
            {
                command = "r.StaticMeshLODDistanceScale 1000";
                valueSetFlag = &g_MobileBuildsValueSet;
                valueSetAfter = true;
            }
            else if (g_MobileBuildsValueSet)
            {
                // Unreal's neutral/default scale is 1. A zero scale is not
                // an off switch and can disrupt mesh LOD streaming while a
                // map is loading. Only sent to undo our own 1000.
                command = "r.StaticMeshLODDistanceScale 1";
                valueSetFlag = &g_MobileBuildsValueSet;
                valueSetAfter = false;
            }
            else
            {
                // Never set by Rift: leave the game's own value alone.
                g_PendingSettingCommandMask.fetch_and(
                    ~bit, std::memory_order_acq_rel);
                mask &= ~bit;
            }
        }
        else if ((mask & SettingCommandInGameFog) != 0)
        {
            bit = SettingCommandInGameFog;
            if (!FConfiguration::bGameplayFog.load(
                    std::memory_order_acquire))
            {
                command = "r.Fog 0";
                valueSetFlag = &g_FogValueSet;
                valueSetAfter = true;
            }
            else if (g_FogValueSet)
            {
                command = "r.Fog 1"; // only to undo our own "r.Fog 0"
                valueSetFlag = &g_FogValueSet;
                valueSetAfter = false;
            }
            else
            {
                g_PendingSettingCommandMask.fetch_and(
                    ~bit, std::memory_order_acq_rel);
                mask &= ~bit;
            }
        }
        else if ((mask & SettingCommandMipMapLODBias) != 0)
        {
            bit = SettingCommandMipMapLODBias;
            snprintf(commandBuffer, sizeof(commandBuffer),
                "r.MipMapLODBias %d",
                FConfiguration::MipMapLODBias.load(
                    std::memory_order_acquire));
            command = commandBuffer;
        }
        else if ((mask & SettingCommandFOV) != 0)
        {
            bit = SettingCommandFOV;
            snprintf(commandBuffer, sizeof(commandBuffer),
                "fov %d",
                FConfiguration::FOV.load(
                    std::memory_order_acquire));
            command = commandBuffer;
        }
        else if ((mask & SettingCommandDebugCamera) != 0)
        {
            bit = SettingCommandDebugCamera;
            if (VersionInfo.FortniteVersion > 10.40)
            {
                g_PendingSettingCommandMask.fetch_and(
                    ~bit, std::memory_order_acq_rel);
                mask &= ~bit;
            }
            else
            {
                toggleDesired = FConfiguration::bDebugCamera.load(
                    std::memory_order_acquire);
                const bool toggleApplied =
                    (g_AppliedToggleSettingMask & bit) != 0;
                if (toggleDesired != toggleApplied)
                {
                    toggleCommand = true;
                    command = "toggledebugcamera";
                }
                else
                {
                    g_PendingSettingCommandMask.fetch_and(
                        ~bit, std::memory_order_acq_rel);
                    mask &= ~bit;
                }
            }
        }
        else if ((mask & SettingCommandTargetInfo) != 0)
        {
            bit = SettingCommandTargetInfo;
            toggleDesired = FConfiguration::bTargetInfo.load(
                std::memory_order_acquire);
            const bool toggleApplied =
                (g_AppliedToggleSettingMask & bit) != 0;
            if (toggleDesired != toggleApplied)
            {
                toggleCommand = true;
                command = "toggletargetinfo";
            }
            else
            {
                g_PendingSettingCommandMask.fetch_and(
                    ~bit, std::memory_order_acq_rel);
                mask &= ~bit;
            }
        }
        else
        {
            // Ignore unknown future bits rather than stalling the game-thread
            // preference queue forever on a value this build cannot apply.
            g_PendingSettingCommandMask.fetch_and(
                ~mask, std::memory_order_acq_rel);
            mask = 0;
        }
    }

    if (!command)
        return false;

    const bool applied = ExecNow(command, false);
    if (toggleCommand)
    {
        if (applied)
        {
            if (toggleDesired)
                g_AppliedToggleSettingMask |= bit;
            else
                g_AppliedToggleSettingMask &= ~bit;
        }

        const bool desiredNow = bit == SettingCommandDebugCamera
            ? FConfiguration::bDebugCamera.load(
                std::memory_order_acquire)
            : FConfiguration::bTargetInfo.load(
                std::memory_order_acquire);
        ReconcileToggleSettingCommandLocked(bit, desiredNow);
    }
    else if (applied)
    {
        if (valueSetFlag)
            *valueSetFlag = valueSetAfter;
        g_PendingSettingCommandMask.fetch_and(
            ~bit, std::memory_order_acq_rel);
    }
    g_GameThreadCommandReadyAfter.store(
        GetTickCount64() + kGameThreadCommandSettleMs,
        std::memory_order_release);
    AtlasDiagnostics::WriteLine(
        "setting-command %s bit=0x%X command=%s",
        applied ? "applied" : "retry",
        bit, command);
    return true;
}

void GUI_PumpGameThreadCommands()
{
    bool expected = false;
    if (!g_GameThreadCommandExecuting.compare_exchange_strong(
        expected, true, std::memory_order_acq_rel,
        std::memory_order_acquire))
    {
        return;
    }

    if (TryApplyPendingSettingCommand())
    {
        g_GameThreadCommandExecuting.store(
            false, std::memory_order_release);
        PumpGameplayMouseRestore();
        return;
    }

    FGameThreadCommand pending{};
    {
        std::unique_lock<std::mutex> lock(
            g_GameThreadCommandMutex, std::try_to_lock);
        if (!lock.owns_lock() || g_GameThreadCommands.empty())
        {
            g_GameThreadCommandExecuting.store(
                false, std::memory_order_release);
            PumpGameplayMouseRestore();
            return;
        }

        pending = std::move(g_GameThreadCommands.front());
        g_GameThreadCommands.pop_front();
    }

    // Do not hold the mailbox, ImGui, or render mutex across ProcessEvent.
    ExecNow(
        pending.Command.c_str(),
        pending.ShowConsoleErrors);
    g_GameThreadCommandReadyAfter.store(
        GetTickCount64() + kGameThreadCommandSettleMs,
        std::memory_order_release);
    g_GameThreadCommandExecuting.store(
        false, std::memory_order_release);

    // A command such as ToggleDebugCamera can synchronously replace the local
    // player's active controller. Resolve and restore input after dispatch so
    // GameOnly mode is applied to the controller that now owns gameplay.
    PumpGameplayMouseRestore();
}

static std::deque<std::string> g_CommandQueue;
static ULONGLONG g_LastCommandDispatch = 0;
static bool g_LastScheduledCommandWasMacro = false;
static constexpr ULONGLONG kMinimumCommandIntervalMs = 100;
static constexpr size_t kMaximumQueuedMacroRuns = 8;

struct QueuedMacroRun
{
    std::string Name;
    std::vector<HotkeyPersist::MacroStep> Steps;
    size_t NextStep = 0;
    ULONGLONG NextDispatchAt = 0;
};

static std::deque<QueuedMacroRun> g_MacroRunQueue;

static bool MatchesCommandFamily(
    const char* command,
    const char* family)
{
    if (!command || !family)
        return false;

    const size_t familyLength = strlen(family);
    return _strnicmp(command, family, familyLength) == 0 &&
        (command[familyLength] == '\0' ||
            std::isspace(static_cast<unsigned char>(
                command[familyLength])));
}

static bool Exec(const char* cmd)
{
    if (!cmd || !*cmd)
        return false;

    if (!g_GameThreadDispatcherReady.load(std::memory_order_acquire))
    {
        AtlasDiagnostics::WriteLine(
            "command-drop dispatcher-unavailable command=%s", cmd);
        return false;
    }

    // Live controls only need their newest value. Coalescing them keeps a
    // dragged slider from filling the bounded queue with stale settings.
    static const char* const coalescedCommandFamilies[] = {
        "fov",
        "r.StaticMeshLODDistanceScale",
        "r.MipMapLODBias",
        "r.Fog"
    };
    const char* coalescedFamily = nullptr;
    for (const char* family : coalescedCommandFamilies)
    {
        if (MatchesCommandFamily(cmd, family))
        {
            coalescedFamily = family;
            break;
        }
    }

    if (coalescedFamily)
    {
        for (auto it = g_CommandQueue.begin(); it != g_CommandQueue.end();)
        {
            if (MatchesCommandFamily(
                    it->c_str(), coalescedFamily))
                it = g_CommandQueue.erase(it);
            else
                ++it;
        }
    }

    if (g_CommandQueue.size() < 32)
    {
        g_CommandQueue.emplace_back(cmd);
        AtlasDiagnostics::WriteLine("command-enqueue depth=%zu command=%s", g_CommandQueue.size(), cmd);
        return true;
    }

    AtlasDiagnostics::WriteLine("command-drop queue-full command=%s", cmd);
    return false;
}

static void QueueMacro(const HotkeyPersist::CommandMacro& macro)
{
    if (macro.Steps.empty())
        return;

    if (g_MacroRunQueue.size() >= kMaximumQueuedMacroRuns)
    {
        AtlasDiagnostics::WriteLine("macro-drop queue-full macro=%s", macro.Name.c_str());
        return;
    }

    QueuedMacroRun run{};
    run.Name = macro.Name;
    run.Steps.reserve(macro.Steps.size());

    for (const auto& step : macro.Steps)
    {
        if (step.Command.empty())
            continue;

        HotkeyPersist::MacroStep copy = step;
        copy.DelayMs = HotkeyPersist::SanitizeMacroDelayMs(copy.DelayMs);
        run.Steps.push_back(std::move(copy));
    }

    if (run.Steps.empty())
        return;

    g_MacroRunQueue.push_back(std::move(run));
    AtlasDiagnostics::WriteLine("macro-enqueue depth=%zu macro=%s steps=%zu", g_MacroRunQueue.size(),
        macro.Name.c_str(), macro.Steps.size());
}

static void RefreshInitialHelpSession(bool armIfVisible)
{
    const uint64_t session = Client::GetConsoleSessionGeneration();
    if (session != g_ConsoleUi.InitialHelpSession)
    {
        g_ConsoleUi.InitialHelpSession = session;
        g_ConsoleUi.InitialHelpRequested = false;
        g_ConsoleUi.InitialHelpPending = false;
        g_ConsoleUi.InitialHelpAttempts = 0;
        g_ConsoleUi.NextInitialHelpAttemptAt = 0;
    }

    if (armIfVisible && session != 0 &&
        !Client::HasReceivedServerCommandList() &&
        !g_ConsoleUi.InitialHelpRequested)
    {
        g_ConsoleUi.InitialHelpRequested = true;
        g_ConsoleUi.InitialHelpPending = true;
        g_ConsoleUi.InitialHelpAttempts = 0;
        g_ConsoleUi.NextInitialHelpAttemptAt = 0;
    }
}

static void DispatchQueuedCommand()
{
    RefreshInitialHelpSession(
        FGUI::bConsoleVisible.load(std::memory_order_acquire));

    const ULONGLONG now = GetTickCount64();
    if (g_LastCommandDispatch != 0 && now - g_LastCommandDispatch < kMinimumCommandIntervalMs)
        return;

    if (g_ConsoleUi.InitialHelpPending &&
        Client::HasReceivedServerCommandList())
    {
        g_ConsoleUi.InitialHelpPending = false;
    }

    if (g_ConsoleUi.InitialHelpPending &&
        g_ConsoleUi.InitialHelpAttempts >=
            kMaximumInitialHelpAttempts)
    {
        g_ConsoleUi.InitialHelpPending = false;
    }

    while (!g_MacroRunQueue.empty() &&
        g_MacroRunQueue.front().NextStep >=
            g_MacroRunQueue.front().Steps.size())
    {
        g_MacroRunQueue.pop_front();
    }

    const bool macroDue =
        !g_MacroRunQueue.empty() &&
        (g_MacroRunQueue.front().NextDispatchAt == 0 ||
            now >= g_MacroRunQueue.front().NextDispatchAt);

    auto dispatchRegular = [&]() -> bool
    {
        if (g_CommandQueue.empty())
            return false;

        const std::string& command = g_CommandQueue.front();
        if (!HandOffGameThreadCommand(command))
            return false;

        g_CommandQueue.pop_front();
        g_LastCommandDispatch = now;
        g_LastScheduledCommandWasMacro = false;
        return true;
    };

    auto dispatchMacro = [&]() -> bool
    {
        if (!macroDue || g_MacroRunQueue.empty())
            return false;

        auto& run = g_MacroRunQueue.front();
        const HotkeyPersist::MacroStep step =
            run.Steps[run.NextStep];
        if (!HandOffGameThreadCommand(step.Command))
            return false;

        run.NextStep++;
        const bool completed =
            run.NextStep >= run.Steps.size();
        const std::string macroName = run.Name;
        const size_t stepNumber = run.NextStep;
        if (completed)
        {
            g_MacroRunQueue.pop_front();
        }
        else
        {
            run.NextDispatchAt =
                now + static_cast<ULONGLONG>(
                    HotkeyPersist::SanitizeMacroDelayMs(
                        step.DelayMs));
        }

        g_LastCommandDispatch = now;
        g_LastScheduledCommandWasMacro = true;
        AtlasDiagnostics::WriteLine(
            "macro-dispatch macro=%s step=%zu command=%s",
            macroName.c_str(), stepNumber,
            step.Command.c_str());
        return true;
    };

    // Alternate when both queues are ready. A delayed macro no longer blocks
    // ordinary commands for up to 60 seconds, and a macro burst cannot starve
    // direct console or saved-bind commands.
    if (!g_CommandQueue.empty() &&
        (!macroDue || g_LastScheduledCommandWasMacro))
    {
        if (dispatchRegular())
            return;
        return;
    }

    if (macroDue)
    {
        if (dispatchMacro())
            return;
        return;
    }

    if (!g_CommandQueue.empty())
    {
        if (dispatchRegular())
            return;
        return;
    }

    // Help discovery is intentionally lowest priority and is requested only
    // once per world/controller session. It cannot repeatedly flood the
    // server merely because the console was reopened before detection latched.
    if (g_ConsoleUi.InitialHelpPending &&
        Client::IsConsoleCaptureReady() &&
        now >= g_ConsoleUi.NextInitialHelpAttemptAt &&
        HandOffGameThreadCommand("cheat", false))
    {
        g_ConsoleUi.InitialHelpAttempts++;
        g_ConsoleUi.NextInitialHelpAttemptAt =
            now + kInitialHelpRetryMs;
        g_LastCommandDispatch = now;
        g_LastScheduledCommandWasMacro = false;
        AtlasDiagnostics::WriteLine(
            "console-help-dispatch command=cheat");
    }
}

static void ClearQueuedCommands()
{
    if (!g_CommandQueue.empty())
        AtlasDiagnostics::WriteLine("command-clear inactive depth=%zu", g_CommandQueue.size());
    if (!g_MacroRunQueue.empty())
        AtlasDiagnostics::WriteLine("macro-clear inactive depth=%zu", g_MacroRunQueue.size());
    g_CommandQueue.clear();
    g_MacroRunQueue.clear();
    g_LastCommandDispatch = 0;
    g_LastScheduledCommandWasMacro = false;

    std::unique_lock<std::mutex> lock(
        g_GameThreadCommandMutex, std::try_to_lock);
    if (lock.owns_lock())
        g_GameThreadCommands.clear();
}

// [Rift] Why the last "Join" on another PC didn't go out (shown under the field; "" = fine).
static std::string g_JoinError;

static bool JoinDigits(const std::string& text, size_t maxLen)
{
    return !text.empty() && text.size() <= maxLen &&
        std::all_of(text.begin(), text.end(), [](unsigned char c) { return std::isdigit(c) != 0; });
}

static bool JoinIsIpv4(const std::string& text)
{
    int parts = 0;
    size_t start = 0;
    while (true)
    {
        const size_t dot = text.find('.', start);
        const std::string part = text.substr(start, dot == std::string::npos ? std::string::npos : dot - start);
        if (!JoinDigits(part, 3) || std::stoi(part) > 255 || (part.size() > 1 && part[0] == '0'))
            return false;
        parts++;
        if (dot == std::string::npos)
            break;
        start = dot + 1;
    }
    return parts == 4 && text != "0.0.0.0";
}

static bool JoinIsPort(const std::string& text)
{
    return JoinDigits(text, 5) && std::stoi(text) >= 1 && std::stoi(text) <= 65535;
}

// "19.10" -> 1910, "19.1" -> 1910, "4.5" -> 450; 0 = can't tell.
static long long JoinVersionHundredths(const std::string& version)
{
    const size_t dot = version.find('.');
    const std::string major = version.substr(0, dot);
    std::string minor = dot == std::string::npos ? "0" : version.substr(dot + 1);
    minor = minor.substr(0, minor.find('.'));
    if (!JoinDigits(major, 3) || !JoinDigits(minor, 2))
        return 0;
    const long long ma = std::stoll(major);
    long long mi = std::stoll(minor);
    if (ma >= 5 && minor.size() == 1)
        mi *= 10;
    return ma * 100 + mi;
}

// [Rift] What was typed into "Join a server": an invite copied in Rift ("RIFT1:100.101.12.7:7777:
// 19.10:18675304:team4+bots", also inside a longer copied line) or an address ("100.101.12.7",
// "100.101.12.7:7777"). Out = what "open" gets. False = g_JoinError says why, in plain words.
static bool ResolveJoinAddress(const char* input, std::string& out)
{
    std::string text = input ? input : "";
    const auto notSpace = [](unsigned char c) { return !std::isspace(c); };
    text.erase(text.begin(), std::find_if(text.begin(), text.end(), notSpace));
    text.erase(std::find_if(text.rbegin(), text.rend(), notSpace).base(), text.end());
    if (text.empty())
    {
        g_JoinError = "Paste your friend's invite code (or their IP address) first.";
        return false;
    }

    std::string upper = text;
    std::transform(upper.begin(), upper.end(), upper.begin(), [](unsigned char c) { return (char)std::toupper(c); });
    const size_t at = upper.find("RIFT");
    if (at != std::string::npos)
    {
        std::string token = text.substr(at, text.find_first_of(" \t\r\n\"'<>`)]", at) - at);
        while (!token.empty() && (token.back() == '.' || token.back() == ',' || token.back() == ';'))
            token.pop_back();
        std::vector<std::string> parts;
        std::stringstream stream(token);
        for (std::string part; std::getline(stream, part, ':');)
            parts.push_back(part);
        std::string prefix = parts.empty() ? "" : parts[0];
        std::transform(prefix.begin(), prefix.end(), prefix.begin(), [](unsigned char c) { return (char)std::toupper(c); });
        if (prefix != "RIFT" && prefix != "RIFT1")
        {
            g_JoinError = prefix.size() > 4 && JoinDigits(prefix.substr(4), 3)
                ? "This invite comes from a newer Rift. Update Rift, then try again."
                : "This invite code is broken. Ask your friend to press \"Copy invite\" in Rift again.";
            return false;
        }
        if (parts.size() < 4 || !JoinIsIpv4(parts[1]) || !JoinIsPort(parts[2]))
        {
            g_JoinError = "This invite code is incomplete. Ask your friend to press \"Copy invite\" in Rift again.";
            return false;
        }
        // Both PCs need the same Fortnite: a different version can't join (the game would only
        // fail later with a network error).
        const long long wanted = JoinVersionHundredths(parts[3]);
        const long long mine = NiobiumEditRoutes::VersionHundredths(VersionInfo.FortniteVersion);
        if (wanted >= 500 && mine >= 500 && wanted != mine)
        {
            char buf[200];
            snprintf(buf, sizeof(buf),
                "This invite is for Fortnite %s, but this game is %.2f. Join from Rift (Servers & Friends) - it starts the right version.",
                parts[3].c_str(), VersionInfo.FortniteVersion);
            g_JoinError = buf;
            return false;
        }
        out = parts[1] + ":" + parts[2];
        return true;
    }

    std::string ip = text;
    const size_t colon = text.rfind(':');
    if (colon != std::string::npos)
    {
        ip = text.substr(0, colon);
        if (!JoinIsPort(text.substr(colon + 1)))
        {
            g_JoinError = "The port must be a number from 1 to 65535 (normally 7777).";
            return false;
        }
    }
    if (!JoinIsIpv4(ip))
    {
        g_JoinError = "That isn't an invite code or an IP address. Example: 100.101.12.7";
        return false;
    }
    out = text;
    return true;
}

static void JoinSelectedHost()
{
    if (FGUI::HostType == 0)
    {
        g_JoinError.clear();
        Exec("open 127.0.0.1");
    }
    else
    {
        std::string address;
        if (!ResolveJoinAddress(FGUI::RemoteIP, address))
            return;
        g_JoinError.clear();
        std::string cmd = "open ";
        cmd += address;
        Exec(cmd.c_str());
    }
}

// [Rift] Helper for the Trickshot tab (NiobiumTrickshotTab.cpp). A sent command shows up as
// "> command" in the console log, just like with the "Run" buttons.
static bool NiobiumTabExec(const char* command)
{
    if (!Exec(command))
        return false;
    AppendConsoleCommandEcho(command);
    return true;
}

// [Rift] The Host tab's status question ("cheat hoststatus") every few seconds: no echo in the log.
static bool RiftHostTabQuery(const char* command)
{
    return Exec(command);
}

void GUI_Init()
{
    // [Rift] Never write imgui.ini into the game folder (the working directory of the game).
    // Every window already uses NoSavedSettings; this also stops ImGui from ever trying.
    ImGui::GetIO().IniFilename = nullptr;
    AtlasDiagnostics::BeginSession(FConfiguration::ConsoleVersion);
    const bool repairMenuHotkey =
        !HotkeyPersist::HasValidSavedMenuHotkey();
    FGUI::LoadHotkey();
    FGUI::LoadJoinHotkey();
    FGUI::LoadCommands();
    FGUI::LoadMacros();

    const int consoleMode = HotkeyPersist::LoadConsoleMode();
    FConfiguration::ConsoleMode.store(consoleMode, std::memory_order_release);

    const bool hadLegacyConsoleHotkey =
        HotkeyPersist::HasLegacyConsoleHotkey();
    const int legacyConsoleHotkey =
        hadLegacyConsoleHotkey
            ? HotkeyPersist::LoadLegacyConsoleHotkey()
            : 0;
    bool migratedSettings =
        hadLegacyConsoleHotkey || repairMenuHotkey;
    int menuHotkey = FGUI::HotkeyVK.load(std::memory_order_acquire);
    int joinHotkey = FGUI::JoinHotkeyVK.load(std::memory_order_acquire);

    if (IsReservedConsoleHotkey(menuHotkey))
    {
        static const int menuFallbacks[] = { VK_F9, VK_F10, VK_F11, VK_F12 };
        for (int fallback : menuFallbacks)
        {
            if (fallback != joinHotkey && !IsReservedConsoleHotkey(fallback))
            {
                menuHotkey = fallback;
                FGUI::HotkeyVK.store(menuHotkey, std::memory_order_release);
                migratedSettings = true;
                break;
            }
        }
    }

    // v1.1 temporarily moved Join from F5 to F6 to make room for a separate
    // console bind. The enhanced console now uses F8 and Unreal's native
    // ` / ~ key, so migrate that generated setting back to F5.
    if (legacyConsoleHotkey == VK_F5 && joinHotkey == VK_F6)
    {
        joinHotkey = VK_F5;
        FGUI::JoinHotkeyVK.store(joinHotkey, std::memory_order_release);
    }

    if (joinHotkey == menuHotkey || IsReservedConsoleHotkey(joinHotkey))
    {
        static const int fallbacks[] = {
            VK_F5, VK_F6, VK_F7, VK_F10, VK_F11, VK_F12
        };
        for (int fallback : fallbacks)
        {
            if (fallback != menuHotkey &&
                !IsReservedConsoleHotkey(fallback))
            {
                joinHotkey = fallback;
                FGUI::JoinHotkeyVK.store(joinHotkey, std::memory_order_release);
                migratedSettings = true;
                break;
            }
        }
    }

    size_t unboundActionCount = 0;
    auto conflictsWithOverlay = [menuHotkey, joinHotkey](int vk)
    {
        return vk > 0 &&
            (vk == menuHotkey || vk == joinHotkey ||
                IsReservedConsoleHotkey(vk));
    };
    for (auto& command : FGUI::Commands)
    {
        if (conflictsWithOverlay(command.VK))
        {
            command.VK = 0;
            unboundActionCount++;
        }
    }
    for (auto& macro : FGUI::Macros)
    {
        if (conflictsWithOverlay(macro.VK))
        {
            macro.VK = 0;
            unboundActionCount++;
        }
    }
    migratedSettings = migratedSettings || unboundActionCount > 0;

    if (migratedSettings)
    {
        HotkeyPersist::SaveAll(menuHotkey, joinHotkey, consoleMode,
            FGUI::Commands, FGUI::Macros);
        RefreshExclusiveCommandHotkeys();
    }

    if (unboundActionCount > 0)
    {
        AtlasDiagnostics::WriteLine(
            "settings-migration unbound-console-conflicts=%zu",
            unboundActionCount);
    }
    if (repairMenuHotkey)
    {
        AtlasDiagnostics::WriteLine(
            "settings-repair menu-hotkey=%d",
            HotkeyPersist::DefaultMenuHotkeyVK);
    }
    PushStyle();
}

static bool IsBindableVK(int vk)
{
    switch (vk)
    {
    case VK_CANCEL:
    case VK_ESCAPE:
    case VK_SHIFT: case VK_CONTROL: case VK_MENU:
    case VK_LSHIFT: case VK_RSHIFT:
    case VK_LCONTROL: case VK_RCONTROL:
    case VK_LMENU: case VK_RMENU:
    case VK_LWIN: case VK_RWIN:
        return false;
    }
    return true;
}

using InputPressCounts = std::array<unsigned int, 0xFF>;
static std::array<std::atomic_uint, 0xFF> g_InputPressCounts{};

static void QueueKeyPress(int vk)
{
    if (vk <= 0 || vk > 0xFE)
        return;

    // A small cap prevents an unattended window from accumulating an
    // unbounded number of actions while still preserving rapid key presses.
    auto& count = g_InputPressCounts[static_cast<size_t>(vk)];
    unsigned int current = count.load(std::memory_order_relaxed);
    while (current < 8 &&
        !count.compare_exchange_weak(current, current + 1,
            std::memory_order_release, std::memory_order_relaxed))
    {
    }
}

static void ClearInputQueue()
{
    for (auto& count : g_InputPressCounts)
        count.store(0, std::memory_order_release);
}

static int InputMessageVK(UINT message, WPARAM wParam)
{
    switch (message)
    {
    case WM_KEYDOWN:
    case WM_KEYUP:
    case WM_SYSKEYDOWN:
    case WM_SYSKEYUP:
        return static_cast<int>(wParam);
    case WM_LBUTTONDOWN:
    case WM_LBUTTONUP:
    case WM_LBUTTONDBLCLK:
        return VK_LBUTTON;
    case WM_RBUTTONDOWN:
    case WM_RBUTTONUP:
    case WM_RBUTTONDBLCLK:
        return VK_RBUTTON;
    case WM_MBUTTONDOWN:
    case WM_MBUTTONUP:
    case WM_MBUTTONDBLCLK:
        return VK_MBUTTON;
    case WM_XBUTTONDOWN:
    case WM_XBUTTONUP:
    case WM_XBUTTONDBLCLK:
        return GET_XBUTTON_WPARAM(wParam) == XBUTTON1 ? VK_XBUTTON1 : VK_XBUTTON2;
    default:
        return 0;
    }
}

static bool IsExclusiveCommandHotkey(int vk)
{
    return vk > 0 && vk <= 0xFE &&
        g_ExclusiveCommandHotkeys[static_cast<size_t>(vk)].load(std::memory_order_acquire);
}

static bool IsAtlasConsoleSelected()
{
    return FConfiguration::ConsoleMode.load(std::memory_order_acquire) ==
        static_cast<int>(EConsoleMode::Atlas);
}

static bool IsSlashConsoleShortcutEnabled()
{
    return IsAtlasConsoleSelected() &&
        FConfiguration::bSlashKeyEnabled.load(
            std::memory_order_acquire);
}

static bool IsAtlasOwnedHotkey(int vk)
{
    return vk > 0 && vk <= 0xFE &&
        (vk == FGUI::HotkeyVK || vk == FGUI::JoinHotkeyVK ||
            vk == VK_F8 ||
            (vk == VK_OEM_2 &&
                IsSlashConsoleShortcutEnabled()) ||
            (IsAtlasConsoleSelected() && vk == VK_OEM_3) ||
            IsExclusiveCommandHotkey(vk));
}

// [Rift] Reset builds: what a key-down does to Fortnite's own (Unreal) console, which keeps
// its state to itself (QuickReset.h, NextGameConsoleState). WndProc thread; key-downs that reach
// the game only. With "Which console?" = Fortnite's, F8 (sent on as `) and ` open and cycle it.
static NiobiumQuickReset::EGameConsoleKey ClassifyGameConsoleKey(int vk)
{
    using NiobiumQuickReset::EGameConsoleKey;
    if (vk == VK_F8 || vk == VK_OEM_3)
        return IsAtlasConsoleSelected() ? EGameConsoleKey::Other : EGameConsoleKey::ConsoleKey;
    if (IsAtlasOwnedHotkey(vk))
        return EGameConsoleKey::Other; // Rift keeps it; the game never sees it
    switch (vk)
    {
    case VK_ESCAPE:
        return EGameConsoleKey::Escape;
    case VK_RETURN:
        return EGameConsoleKey::Enter;
    case VK_UP:
    case VK_DOWN:
    case VK_TAB:
        return EGameConsoleKey::Text; // history or completion fills the line
    default:
        break;
    }
    const bool control = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
    const bool alt = (GetKeyState(VK_MENU) & 0x8000) != 0;
    if (control && !alt && vk == 'V')
        return EGameConsoleKey::Text; // paste
    if (control || alt)
        return EGameConsoleKey::Other;
    const UINT character = MapVirtualKeyW(static_cast<UINT>(vk), MAPVK_VK_TO_CHAR) & 0x7FFFFFFFu;
    return character >= 0x20 ? EGameConsoleKey::Text : EGameConsoleKey::Other;
}

bool GUI_IsOwnedHotkey(int vk)
{
    return IsAtlasOwnedHotkey(vk);
}

bool GUI_ShouldConsumeInputMessage(UINT message, WPARAM wParam)
{
    return IsAtlasOwnedHotkey(InputMessageVK(message, wParam));
}

void GUI_QueueInputMessage(UINT message, WPARAM wParam, LPARAM lParam)
{
    int vk = InputMessageVK(message, wParam);

    switch (message)
    {
    case WM_KEYDOWN:
    case WM_SYSKEYDOWN:
        // Ignore keyboard auto-repeat. Each physical down transition should
        // run a bind once.
        if ((static_cast<ULONG_PTR>(lParam) & (1ull << 30)) == 0)
            vk = static_cast<int>(wParam);
        else
            vk = 0;
        break;
    case WM_LBUTTONDOWN:
    case WM_RBUTTONDOWN:
    case WM_MBUTTONDOWN:
    case WM_XBUTTONDOWN:
        break;
    case WM_KILLFOCUS:
    case WM_CANCELMODE:
        ClearInputQueue();
        return;
    case WM_ACTIVATE:
        if (LOWORD(wParam) == WA_INACTIVE)
            ClearInputQueue();
        return;
    case WM_ACTIVATEAPP:
        if (!wParam)
            ClearInputQueue();
        return;
    default:
        return;
    }

    // [Rift] Reset builds: only stamps the press time; the game thread decides what to do.
    // The key is never swallowed (the game still gets it) and doesn't count while the menu or
    // a console (ours or Fortnite's) is open, while a key is being picked, or when the key is a
    // menu/join/console key or one Rift already owns.
    if (vk > 0)
    {
        const bool overlayVisible = GUI_IsOverlayVisible();
        const bool bindCaptureActive = FGUI::bRebinding || FGUI::bRebindingJoin ||
            FGUI::bRebindingResetBuilds ||
            FGUI::RebindingCommandIndex != -2 || FGUI::RebindingMacroIndex != -2;
        // State before this key: the key that closes Fortnite's console was typed into it.
        const bool gameConsoleOpen = NiobiumQuickReset::IsGameConsoleOpen();
        NiobiumQuickReset::OnKeyDown(vk,
            FConfiguration::ResetBuildsVK.load(std::memory_order_acquire),
            FConfiguration::bResetBuilds.load(std::memory_order_acquire),
            overlayVisible || bindCaptureActive || gameConsoleOpen ||
                IsAtlasOwnedHotkey(vk) || IsReservedConsoleHotkey(vk),
            GetTickCount64());
        // Only keys that reach the game move Fortnite's console (the overlay keeps them).
        if (!overlayVisible && (message == WM_KEYDOWN || message == WM_SYSKEYDOWN))
            NiobiumQuickReset::OnGameConsoleKey(ClassifyGameConsoleKey(vk));
    }

    QueueKeyPress(vk);
}

static InputPressCounts TakeInputPresses()
{
    InputPressCounts presses{};
    for (size_t i = 0; i < presses.size(); i++)
        presses[i] = g_InputPressCounts[i].exchange(0, std::memory_order_acq_rel);
    return presses;
}

static unsigned int TakePressCount(InputPressCounts& presses, int vk)
{
    if (vk <= 0 || vk > 0xFE)
        return 0;

    unsigned int count = presses[static_cast<size_t>(vk)];
    presses[static_cast<size_t>(vk)] = 0;
    return count;
}

static void BeginBindCapture()
{
    // Discard the click/key that activated the bind button. A subsequent
    // window-message transition will be the key the user intended to bind.
    ClearInputQueue();
}

static void EndBindCapture()
{
    ClearInputQueue();
}

static void CancelBindCapture()
{
    FGUI::bRebinding = false;
    FGUI::bRebindingJoin = false;
    FGUI::bRebindingResetBuilds = false;
    FGUI::RebindingCommandIndex = -2;
    FGUI::RebindingMacroIndex = -2;
    FGUI::PendingCommandVK = 0;
    EndBindCapture();
}

static void CloseMenuSurface()
{
    FinishSavedCommandEdit(false);
    FGUI::bVisible.store(false, std::memory_order_release);
    g_MenuWindowFocused = false;
    CancelBindCapture();
    if (FGUI::bConsoleVisible.load(std::memory_order_acquire))
        g_ConsoleUi.FocusInput = true;
}

static void CloseConsoleSurface()
{
    FGUI::bConsoleVisible.store(false, std::memory_order_release);
    if (g_ConsoleUi.SlashPrefillActive)
    {
        // A synthetic slash belongs only to the shortcut-opened console. Do
        // not let it become a draft on a later F8/backtick opening.
        g_ConsoleUi.Input.clear();
        g_ConsoleUi.ReloadInput = true;
        g_ConsoleUi.SlashPrefillActive = false;
    }
    g_ConsoleUi.WindowFocused = false;
    g_ConsoleUi.RefocusAfterEscapeClear = false;
    g_ConsoleUi.HistoryPosition = -1;
    g_ConsoleUi.Draft.clear();
    g_ConsoleUi.CompletionMatches.clear();
    g_ConsoleUi.CompletionPosition = -1;
    if (FGUI::bVisible.load(std::memory_order_acquire))
        g_FocusMenuWindow = true;
}

static int PollBindKey(const InputPressCounts& presses)
{
    for (int vk = 0x01; vk <= 0xFE; vk++)
        if (IsBindableVK(vk) && presses[static_cast<size_t>(vk)] > 0)
            return vk;

    return 0;
}

// [Rift] message = plain text for the menu, reason = the unchanged reason for the
// diagnostics log (stays as in ATLAS so logs remain comparable).
static void SetBindError(const char* message, const char* reason, int owner = 0)
{
    g_BindErrorOwner = owner;
    g_BindError = message ? message : "That key is already in use.";
    g_BindErrorUntil = GetTickCount64() + 3500;
    AtlasDiagnostics::WriteLine("bind-rejected reason=%s",
        reason ? reason : "That key is already in use.");
}

// [Rift] Messages when assigning a key (text for the menu + reason for the log).
static constexpr const char* kBindTakenText =
    "That key is already used for something else.";
static constexpr const char* kBindTakenReason =
    "That key is already assigned to another Rift action.";
static constexpr const char* kBindReservedText =
    "The menu, join and console keys can't be used here.";
static constexpr const char* kBindReservedReason =
    "Menu, Join, and console keys are reserved.";
// [Rift] Reset builds key: never the left or right mouse button.
static constexpr const char* kBindMouseText =
    "The left and right mouse buttons can't be used here: they shoot and aim.";
static constexpr const char* kBindMouseReason =
    "reset-builds key rejected: left/right mouse button";

// [Rift] The Reset builds key while that feature is on (0 = none). Other key buttons can't
// take it, so one press never means two things.
static int ActiveResetBuildsKey()
{
    if (!FConfiguration::bResetBuilds.load(std::memory_order_acquire))
        return 0;
    return HotkeyPersist::SanitizeResetBuildsKey(
        FConfiguration::ResetBuildsVK.load(std::memory_order_acquire));
}

static bool IsResetBuildsKey(int vk)
{
    const int key = ActiveResetBuildsKey();
    return key != 0 && vk == key;
}

static bool IsReservedOverlayKey(int vk, int except)
{
    return (except != 0 && vk == FGUI::HotkeyVK) ||
        (except != 1 && vk == FGUI::JoinHotkeyVK) ||
        IsReservedConsoleHotkey(vk);
}

static bool IsSavedActionHotkey(int vk)
{
    for (const auto& command : FGUI::Commands)
        if (command.VK == vk)
            return true;
    for (const auto& macro : FGUI::Macros)
        if (macro.VK == vk)
            return true;
    return false;
}

void GUI_HandleInput(bool windowActive)
{
    InputPressCounts presses = TakeInputPresses();
    if (!windowActive)
    {
        ClearQueuedCommands();
        return;
    }

    // Never execute a burst of accumulated ProcessEvent calls in one Present.
    // One command per 100 ms keeps rapid binds responsive without re-entering
    // cheat/inventory state changes before the previous command has settled.
    DispatchQueuedCommand();

    const bool wasOverlayVisible = GUI_IsOverlayVisible();

    if ((FGUI::bRebinding || FGUI::bRebindingJoin || FGUI::bRebindingResetBuilds ||
        FGUI::RebindingCommandIndex != -2 || FGUI::RebindingMacroIndex != -2) &&
        TakePressCount(presses, VK_ESCAPE) > 0)
    {
        FGUI::bRebinding = false;
        FGUI::bRebindingJoin = false;
        FGUI::bRebindingResetBuilds = false;
        FGUI::RebindingCommandIndex = -2;
        FGUI::RebindingMacroIndex = -2;
        EndBindCapture();
        return;
    }

    if (FGUI::bRebinding)
    {
        if (int vk = PollBindKey(presses))
        {
            if (IsReservedOverlayKey(vk, 0) || IsSavedActionHotkey(vk) || IsResetBuildsKey(vk))
                SetBindError(kBindTakenText, kBindTakenReason);
            else
            {
                FGUI::HotkeyVK = vk;
                FGUI::SaveHotkey();
            }
            FGUI::bRebinding = false;
            FGUI::RebindingMacroIndex = -2;
            EndBindCapture();
        }
        return;
    }

    if (FGUI::bRebindingJoin)
    {
        if (int vk = PollBindKey(presses))
        {
            if (IsReservedOverlayKey(vk, 1) || IsSavedActionHotkey(vk) || IsResetBuildsKey(vk))
                SetBindError(kBindTakenText, kBindTakenReason);
            else
            {
                FGUI::JoinHotkeyVK = vk;
                FGUI::SaveJoinHotkey();
            }
            FGUI::bRebindingJoin = false;
            FGUI::RebindingMacroIndex = -2;
            EndBindCapture();
        }
        return;
    }

    // [Rift] Reset builds key: never the left/right mouse button, never a key that already
    // does something in Rift (menu, join, console, saved commands). Saved in client.json like
    // the other switches (while "Remember my settings" is on).
    if (FGUI::bRebindingResetBuilds)
    {
        if (int vk = PollBindKey(presses))
        {
            if (NiobiumQuickReset::IsMouseShootOrAimButton(vk))
                SetBindError(kBindMouseText, kBindMouseReason, 1);
            else if (IsReservedOverlayKey(vk, -1) || IsSavedActionHotkey(vk))
                SetBindError(kBindTakenText, kBindTakenReason, 1);
            else
            {
                FConfiguration::ResetBuildsVK.store(
                    HotkeyPersist::SanitizeResetBuildsKey(vk), std::memory_order_release);
                SaveUserPreferences();
                AtlasDiagnostics::WriteLine("reset-builds key-bound vk=%d", vk);
            }
            FGUI::bRebindingResetBuilds = false;
            EndBindCapture();
        }
        return;
    }

    if (FGUI::RebindingCommandIndex != -2)
    {
        if (int vk = PollBindKey(presses))
        {
            if (IsReservedOverlayKey(vk, -1))
            {
                SetBindError(kBindReservedText, kBindReservedReason);
            }
            else if (IsResetBuildsKey(vk))
            {
                SetBindError(kBindTakenText, kBindTakenReason);
            }
            else if (FGUI::RebindingCommandIndex == -1)
            {
                FGUI::PendingCommandVK = vk;
            }
            else if (FGUI::RebindingCommandIndex >= 0 && FGUI::RebindingCommandIndex < (int)FGUI::Commands.size())
            {
                FGUI::Commands[FGUI::RebindingCommandIndex].VK = vk;
                FGUI::SaveCommands();
            }

            FGUI::RebindingCommandIndex = -2;
            EndBindCapture();
        }
        return;
    }

    if (FGUI::RebindingMacroIndex != -2)
    {
        if (int vk = PollBindKey(presses))
        {
            if (IsReservedOverlayKey(vk, -1))
            {
                SetBindError(kBindReservedText, kBindReservedReason);
            }
            else if (IsResetBuildsKey(vk))
            {
                SetBindError(kBindTakenText, kBindTakenReason);
            }
            else if (FGUI::RebindingMacroIndex >= 0 && FGUI::RebindingMacroIndex < (int)FGUI::Macros.size())
            {
                FGUI::Macros[FGUI::RebindingMacroIndex].VK = vk;
                FGUI::SaveMacros();
            }

            FGUI::RebindingMacroIndex = -2;
            EndBindCapture();
        }
        return;
    }

    const unsigned int menuHotkeyPresses = TakePressCount(presses, FGUI::HotkeyVK);
    if ((menuHotkeyPresses & 1u) != 0)
    {
        if (FGUI::bVisible.load(std::memory_order_acquire))
        {
            CloseMenuSurface();
        }
        else
        {
            FGUI::bVisible.store(true, std::memory_order_release);
            g_FocusMenuWindow = true;
        }
    }

    const unsigned int slashConsolePresses =
        TakePressCount(presses, VK_OEM_2);
    if (slashConsolePresses > 0 &&
        IsSlashConsoleShortcutEnabled() &&
        !wasOverlayVisible && !GUI_IsOverlayVisible())
    {
        g_ConsoleUi.Expanded = false;
        g_ConsoleUi.ResetExpansion = true;
        g_ConsoleUi.Input = "/";
        g_ConsoleUi.ReloadInput = true;
        g_ConsoleUi.SlashPrefillActive = true;
        g_ConsoleUi.HistoryPosition = -1;
        g_ConsoleUi.Draft.clear();
        g_ConsoleUi.CompletionSeed.clear();
        g_ConsoleUi.CompletionMatches.clear();
        g_ConsoleUi.CompletionPosition = -1;
        FGUI::bConsoleVisible.store(true, std::memory_order_release);
        RefreshInitialHelpSession(true);
        g_ConsoleUi.FocusInput = true;
        g_ConsoleUi.ScrollToBottom = true;
    }

    const unsigned int consoleHotkeyPresses =
        TakePressCount(presses, VK_OEM_3) +
        TakePressCount(presses, VK_F8);
    if (IsAtlasConsoleSelected())
    {
        const unsigned int advances = consoleHotkeyPresses % 3u;
        for (unsigned int advance = 0; advance < advances; advance++)
        {
            if (!FGUI::bConsoleVisible.load(std::memory_order_acquire))
            {
                g_ConsoleUi.Expanded = false;
                g_ConsoleUi.ResetExpansion = true;
                FGUI::bConsoleVisible.store(true, std::memory_order_release);
                RefreshInitialHelpSession(true);
            }
            else if (!g_ConsoleUi.Expanded)
            {
                g_ConsoleUi.Expanded = true;
            }
            else
            {
                CloseConsoleSurface();
            }

            g_ConsoleUi.FocusInput = true;
            g_ConsoleUi.ScrollToBottom = true;
        }
    }

    if (FGUI::bConsoleVisible.load(std::memory_order_acquire) &&
        (!FGUI::bVisible.load(std::memory_order_acquire) ||
            g_ConsoleUi.WindowFocused || !g_MenuWindowFocused))
    {
        unsigned int escapePresses =
            TakePressCount(presses, VK_ESCAPE);
        if (escapePresses > 0 &&
            !g_ConsoleUi.Input.empty())
        {
            // Clear the backing value here as well as ImGui's active edit
            // buffer below. This keeps the first Escape deterministic even
            // if the console input temporarily lost keyboard focus.
            g_ConsoleUi.Input.clear();
            g_ConsoleUi.ReloadInput = true;
            g_ConsoleUi.SlashPrefillActive = false;
            g_ConsoleUi.HistoryPosition = -1;
            g_ConsoleUi.Draft.clear();
            g_ConsoleUi.CompletionSeed.clear();
            g_ConsoleUi.CompletionMatches.clear();
            g_ConsoleUi.CompletionPosition = -1;
            g_ConsoleUi.RefocusAfterEscapeClear = true;
            escapePresses--;
        }

        if (escapePresses > 0)
            CloseConsoleSurface();
    }

    if (!wasOverlayVisible && !GUI_IsOverlayVisible() &&
        TakePressCount(presses, FGUI::JoinHotkeyVK) > 0)
    {
        JoinSelectedHost();
    }

    // Do not execute presses made while the overlay was visible, including
    // other keys received in the same batch as the close hotkey.
    if (!wasOverlayVisible && !GUI_IsOverlayVisible())
    {
        for (const auto& command : FGUI::Commands)
        {
            const unsigned int pressCount = TakePressCount(presses, command.VK);
            for (unsigned int i = 0; i < pressCount; i++)
            {
                if (Exec(command.Command.c_str()))
                    AppendConsoleCommandEcho(
                        command.Command);
            }
        }

        for (const auto& macro : FGUI::Macros)
        {
            const unsigned int pressCount = TakePressCount(presses, macro.VK);
            for (unsigned int i = 0; i < pressCount; i++)
                QueueMacro(macro);
        }
    }
}

static std::string TrimCommand(const std::string& value)
{
    size_t start = 0;
    while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start])))
        start++;

    size_t end = value.size();
    while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1])))
        end--;

    return value.substr(start, end - start);
}

static bool IsEditingSavedCommand(int commandIndex)
{
    return g_SavedCommandEdit.Target ==
            ESavedCommandEditTarget::Command &&
        g_SavedCommandEdit.CommandIndex == commandIndex;
}

static bool IsEditingSavedMacroStep(
    int macroIndex, int stepIndex)
{
    return g_SavedCommandEdit.Target ==
            ESavedCommandEditTarget::MacroStep &&
        g_SavedCommandEdit.MacroIndex == macroIndex &&
        g_SavedCommandEdit.StepIndex == stepIndex;
}

static bool IsEditingSavedMacroDelay(
    int macroIndex, int stepIndex)
{
    return g_SavedCommandEdit.Target ==
            ESavedCommandEditTarget::MacroDelay &&
        g_SavedCommandEdit.MacroIndex == macroIndex &&
        g_SavedCommandEdit.StepIndex == stepIndex;
}

static bool FinishSavedCommandEdit(bool keepOpenOnInvalid)
{
    if (g_SavedCommandEdit.Target ==
        ESavedCommandEditTarget::None)
    {
        return true;
    }

    const bool validCommandTarget =
        g_SavedCommandEdit.Target ==
            ESavedCommandEditTarget::Command &&
        g_SavedCommandEdit.CommandIndex >= 0 &&
        g_SavedCommandEdit.CommandIndex <
            static_cast<int>(FGUI::Commands.size());
    const bool isMacroEditTarget =
        g_SavedCommandEdit.Target ==
            ESavedCommandEditTarget::MacroStep ||
        g_SavedCommandEdit.Target ==
            ESavedCommandEditTarget::MacroDelay;
    const bool validMacroTarget =
        isMacroEditTarget &&
        g_SavedCommandEdit.MacroIndex >= 0 &&
        g_SavedCommandEdit.MacroIndex <
            static_cast<int>(FGUI::Macros.size()) &&
        g_SavedCommandEdit.StepIndex >= 0 &&
        g_SavedCommandEdit.StepIndex <
            static_cast<int>(FGUI::Macros[
                static_cast<size_t>(
                    g_SavedCommandEdit.MacroIndex)].Steps.size());
    if (!validCommandTarget && !validMacroTarget)
    {
        CancelSavedCommandEdit();
        return false;
    }

    if (g_SavedCommandEdit.Target ==
        ESavedCommandEditTarget::MacroDelay)
    {
        if (g_SavedCommandEdit.DelayDraft ==
            g_SavedCommandEdit.DelayOriginal)
        {
            CancelSavedCommandEdit();
            return true;
        }

        auto& step = FGUI::Macros[static_cast<size_t>(
            g_SavedCommandEdit.MacroIndex)].Steps[
                static_cast<size_t>(
                    g_SavedCommandEdit.StepIndex)];
        step.DelayMs = HotkeyPersist::SanitizeMacroDelayMs(
            g_SavedCommandEdit.DelayDraft);
        FGUI::SaveMacros();
        CancelSavedCommandEdit();
        return true;
    }

    // Escape restores ImGui's activation value. Treat an unchanged draft as
    // cancellation so it is never normalized or written back unnecessarily.
    if (g_SavedCommandEdit.Draft ==
        g_SavedCommandEdit.Original)
    {
        CancelSavedCommandEdit();
        return true;
    }

    const std::string command =
        TrimCommand(g_SavedCommandEdit.Draft);
    // [Rift] Short messages, shown below the input field only.
    const char* error = nullptr;
    if (command.empty())
        error = "The command can't be empty.";
    else if (command.find_first_of("\r\n") != std::string::npos)
        error = "The command must fit on one line.";
    else if (command.size() > kMaximumConsoleCommandLength)
        error = "The command is too long.";

    if (error)
    {
        if (keepOpenOnInvalid)
        {
            g_SavedCommandEdit.Error = error;
            g_SavedCommandEdit.FocusNextFrame = true;
        }
        else
        {
            CancelSavedCommandEdit();
        }
        return false;
    }

    if (validCommandTarget)
    {
        FGUI::Commands[static_cast<size_t>(
            g_SavedCommandEdit.CommandIndex)].Command = command;
        FGUI::SaveCommands();
    }
    else
    {
        auto& macro = FGUI::Macros[static_cast<size_t>(
            g_SavedCommandEdit.MacroIndex)];
        macro.Steps[static_cast<size_t>(
            g_SavedCommandEdit.StepIndex)].Command = command;
        if (g_SavedCommandEdit.StepIndex == 0)
            macro.Name = command;
        FGUI::SaveMacros();
    }

    CancelSavedCommandEdit();
    return true;
}

static void BeginSavedCommandEdit(int commandIndex)
{
    if (commandIndex < 0 || commandIndex >=
        static_cast<int>(FGUI::Commands.size()))
    {
        return;
    }

    FinishSavedCommandEdit(false);
    CancelBindCapture();
    g_SavedCommandEdit.Target =
        ESavedCommandEditTarget::Command;
    g_SavedCommandEdit.CommandIndex = commandIndex;
    g_SavedCommandEdit.Original =
        FGUI::Commands[static_cast<size_t>(commandIndex)].Command;
    g_SavedCommandEdit.Draft =
        g_SavedCommandEdit.Original;
    g_SavedCommandEdit.FocusNextFrame = true;
}

static void BeginSavedMacroStepEdit(
    int macroIndex, int stepIndex)
{
    if (macroIndex < 0 || macroIndex >=
        static_cast<int>(FGUI::Macros.size()) ||
        stepIndex < 0 || stepIndex >=
        static_cast<int>(FGUI::Macros[
            static_cast<size_t>(macroIndex)].Steps.size()))
    {
        return;
    }

    FinishSavedCommandEdit(false);
    CancelBindCapture();
    g_SavedCommandEdit.Target =
        ESavedCommandEditTarget::MacroStep;
    g_SavedCommandEdit.MacroIndex = macroIndex;
    g_SavedCommandEdit.StepIndex = stepIndex;
    g_SavedCommandEdit.Original =
        FGUI::Macros[static_cast<size_t>(macroIndex)].Steps[
            static_cast<size_t>(stepIndex)].Command;
    g_SavedCommandEdit.Draft =
        g_SavedCommandEdit.Original;
    g_SavedCommandEdit.FocusNextFrame = true;
}

static void BeginSavedMacroDelayEdit(
    int macroIndex, int stepIndex)
{
    if (macroIndex < 0 || macroIndex >=
        static_cast<int>(FGUI::Macros.size()) ||
        stepIndex < 0 || stepIndex >=
        static_cast<int>(FGUI::Macros[
            static_cast<size_t>(macroIndex)].Steps.size()))
    {
        return;
    }

    FinishSavedCommandEdit(false);
    CancelBindCapture();
    const int delayMs = FGUI::Macros[
        static_cast<size_t>(macroIndex)].Steps[
            static_cast<size_t>(stepIndex)].DelayMs;
    g_SavedCommandEdit.Target =
        ESavedCommandEditTarget::MacroDelay;
    g_SavedCommandEdit.MacroIndex = macroIndex;
    g_SavedCommandEdit.StepIndex = stepIndex;
    g_SavedCommandEdit.DelayOriginal = delayMs;
    g_SavedCommandEdit.DelayDraft = delayMs;
    g_SavedCommandEdit.FocusNextFrame = true;
}

static void RenderSavedCommandEditor(float width)
{
    const bool editingDelay =
        g_SavedCommandEdit.Target ==
            ESavedCommandEditTarget::MacroDelay;
    if (editingDelay)
    {
        ImGui::TextUnformatted("    Wait"); // [Rift] was "wait"
        ImGui::SameLine(0.f, 6.f);
        ImGui::SetNextItemWidth((std::min)(100.f, width));
    }
    else
    {
        ImGui::SetNextItemWidth(width);
    }
    if (g_SavedCommandEdit.FocusNextFrame)
    {
        ImGui::SetKeyboardFocusHere();
        g_SavedCommandEdit.FocusNextFrame = false;
    }

    bool submitted = false;
    if (editingDelay)
    {
        ImGui::InputInt(
            "##saved_delay_edit",
            &g_SavedCommandEdit.DelayDraft,
            0, 0,
            ImGuiInputTextFlags_CharsDecimal);
    }
    else
    {
        submitted = ImGui::InputText(
            "##saved_command_edit",
            &g_SavedCommandEdit.Draft,
            ImGuiInputTextFlags_EnterReturnsTrue |
                ImGuiInputTextFlags_AutoSelectAll);
    }
    if (ImGui::IsItemEdited())
        g_SavedCommandEdit.Error.clear();
    const bool deactivated = ImGui::IsItemDeactivated();

    if (editingDelay)
    {
        ImGui::SameLine(0.f, 6.f);
        ImGui::TextUnformatted("ms");
    }

    if (submitted)
        FinishSavedCommandEdit(true);
    else if (deactivated)
        FinishSavedCommandEdit(false);

    if (g_SavedCommandEdit.Target !=
            ESavedCommandEditTarget::None &&
        !g_SavedCommandEdit.Error.empty())
    {
        ImGui::PushStyleColor(
            ImGuiCol_Text,
            ImVec4(1.f, 0.39f, 0.43f, 1.f));
        ImGui::TextWrapped(
            "%s", g_SavedCommandEdit.Error.c_str());
        ImGui::PopStyleColor();
    }
}

static std::string NormalizeConsoleCommand(const std::string& entered)
{
    if (entered.empty() || entered[0] != '/')
        return TrimCommand(entered);

    std::string shorthand = TrimCommand(entered.substr(1));
    if (shorthand.empty())
        return std::string();

    if (StartsWithInsensitive(shorthand, "cheat") &&
        (shorthand.size() == 5 || std::isspace(static_cast<unsigned char>(shorthand[5]))))
        return shorthand;

    return "cheat " + shorthand;
}

static std::string LowercaseKey(const std::string& value)
{
    std::string lowered = value;
    for (char& ch : lowered)
        ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    return lowered;
}

static std::string ToConsoleCandidate(const std::string& command)
{
    const std::string trimmed = TrimCommand(command);
    if (!StartsWithInsensitive(trimmed, "cheat"))
        return trimmed;

    size_t position = 5;
    if (position < trimmed.size() && !std::isspace(static_cast<unsigned char>(trimmed[position])))
        return trimmed;
    while (position < trimmed.size() && std::isspace(static_cast<unsigned char>(trimmed[position])))
        position++;

    return "/" + trimmed.substr(position);
}

static void AddCompletionCandidate(std::vector<std::string>& candidates,
    std::unordered_set<std::string>& seen, const std::string& candidate, const std::string& prefix)
{
    size_t start = 0;
    while (start < candidate.size() &&
        std::isspace(static_cast<unsigned char>(candidate[start])))
    {
        start++;
    }

    const std::string completion = candidate.substr(start);
    if (TrimCommand(completion).empty() || !StartsWithInsensitive(completion, prefix))
        return;

    const std::string key = LowercaseKey(completion);
    if (seen.insert(key).second)
        candidates.push_back(completion);
}

static std::vector<std::string> BuildCompletionCandidates(const std::string& prefix)
{
    std::vector<std::string> candidates;
    std::unordered_set<std::string> seen;

    for (auto it = g_ConsoleUi.History.rbegin(); it != g_ConsoleUi.History.rend(); ++it)
        AddCompletionCandidate(candidates, seen, *it, prefix);

    for (const auto& command : FGUI::Commands)
        AddCompletionCandidate(candidates, seen, ToConsoleCandidate(command.Command), prefix);

    for (const auto& macro : FGUI::Macros)
        for (const auto& step : macro.Steps)
            AddCompletionCandidate(candidates, seen, ToConsoleCandidate(step.Command), prefix);

    static const char* kCommonCommands[] = {
        "/give ", "/suicide", "/startaircraft", "/outputge", "/applyge ",
        "/dumpge", "/god", "/fly", "fov ", "open "
    };
    for (const char* command : kCommonCommands)
        AddCompletionCandidate(candidates, seen, command, prefix);

    return candidates;
}

static void ReplaceConsoleInput(ImGuiInputTextCallbackData* data, const std::string& value)
{
    data->DeleteChars(0, data->BufTextLen);
    data->InsertChars(0, value.c_str());
    data->CursorPos = data->SelectionStart = data->SelectionEnd = data->BufTextLen;
}

static int ConsoleInputCallback(ImGuiInputTextCallbackData* data)
{
    auto& state = *static_cast<FConsoleUiState*>(data->UserData);

    if (data->EventFlag == ImGuiInputTextFlags_CallbackHistory)
    {
        state.CompletionMatches.clear();
        state.CompletionPosition = -1;

        if (data->EventKey == ImGuiKey_UpArrow)
        {
            if (state.History.empty())
                return 0;

            if (state.HistoryPosition < 0)
            {
                state.Draft.assign(data->Buf, static_cast<size_t>(data->BufTextLen));
                state.HistoryPosition = static_cast<int>(state.History.size()) - 1;
            }
            else
            {
                const int historyCount =
                    static_cast<int>(state.History.size());
                state.HistoryPosition =
                    (state.HistoryPosition - 1 + historyCount) %
                    historyCount;
            }

            state.SlashPrefillActive = false;
            ReplaceConsoleInput(data, state.History[static_cast<size_t>(state.HistoryPosition)]);
        }
        else if (data->EventKey == ImGuiKey_DownArrow &&
            state.HistoryPosition >= 0 &&
            !state.History.empty())
        {
            state.HistoryPosition =
                (state.HistoryPosition + 1) %
                static_cast<int>(state.History.size());
            state.SlashPrefillActive = false;
            ReplaceConsoleInput(
                data,
                state.History[
                    static_cast<size_t>(
                        state.HistoryPosition)]);
        }
    }
    else if (data->EventFlag == ImGuiInputTextFlags_CallbackCompletion)
    {
        state.HistoryPosition = -1;
        state.Draft.clear();
        const std::string current(data->Buf, static_cast<size_t>(data->BufTextLen));
        if (!state.CompletionMatches.empty() && state.CompletionPosition >= 0 &&
            current == state.CompletionMatches[static_cast<size_t>(state.CompletionPosition)])
        {
            state.CompletionPosition =
                (state.CompletionPosition + 1) % static_cast<int>(state.CompletionMatches.size());
        }
        else
        {
            state.CompletionSeed = current;
            state.CompletionMatches = BuildCompletionCandidates(current);
            state.CompletionPosition = state.CompletionMatches.empty() ? -1 : 0;
        }

        if (state.CompletionPosition >= 0)
        {
            state.SlashPrefillActive = false;
            ReplaceConsoleInput(data, state.CompletionMatches[static_cast<size_t>(state.CompletionPosition)]);
        }
    }
    else if (data->EventFlag == ImGuiInputTextFlags_CallbackEdit)
    {
        // Programmatic navigation focus selects a single-line InputText on
        // its first activation. If a character was already queued for that
        // activation frame, keep the slash prefix that selection replaced.
        if (state.SlashPrefillActive &&
            data->BufTextLen > 0 &&
            data->Buf[0] != '/')
        {
            data->InsertChars(0, "/");
        }
        state.SlashPrefillActive = false;
        if (data->BufTextLen > static_cast<int>(kMaximumConsoleCommandLength))
        {
            int validLength = static_cast<int>(kMaximumConsoleCommandLength);
            while (validLength > 0 &&
                (static_cast<unsigned char>(data->Buf[validLength]) & 0xC0) == 0x80)
            {
                validLength--;
            }
            data->DeleteChars(validLength, data->BufTextLen - validLength);
        }

        state.HistoryPosition = -1;
        state.Draft.clear();
        state.CompletionMatches.clear();
        state.CompletionPosition = -1;
    }

    return 0;
}

static void RememberConsoleCommand(const std::string& command)
{
    const std::string key = LowercaseKey(command);
    for (auto it = g_ConsoleUi.History.begin(); it != g_ConsoleUi.History.end();)
    {
        if (LowercaseKey(*it) == key)
            it = g_ConsoleUi.History.erase(it);
        else
            ++it;
    }

    g_ConsoleUi.History.push_back(command);
    if (g_ConsoleUi.History.size() > kMaximumConsoleHistory)
        g_ConsoleUi.History.erase(g_ConsoleUi.History.begin());
}

static bool SubmitConsoleCommand()
{
    const std::string raw = g_ConsoleUi.Input;
    const std::string entered = TrimCommand(raw);
    if (entered.empty())
        return false;

    if (raw.size() > kMaximumConsoleCommandLength)
    {
        AppendConsoleLine(EConsoleLineKind::Error, "[Rift] That command is too long " NB_DASH " please make it shorter."); // [Rift]
        g_ConsoleUi.FocusInput = true;
        return false;
    }

    const std::string command = NormalizeConsoleCommand(raw);
    if (command.empty())
    {
        AppendConsoleLine(EConsoleLineKind::Error, "[Rift] Type a command after the /, for example /god"); // [Rift]
        g_ConsoleUi.FocusInput = true;
        return false;
    }

    if (!Exec(command.c_str()))
    {
        AppendConsoleLine(
            EConsoleLineKind::Error,
            g_GameThreadDispatcherReady.load(
                std::memory_order_acquire)
                // [Rift] plain English
                ? "[Rift] Too many commands at once " NB_DASH " this one wasn't sent. Wait a moment."
                : "[Rift] Commands don't work yet " NB_DASH " wait until the game has finished loading.");
        g_ConsoleUi.FocusInput = true;
        return false;
    }

    RememberConsoleCommand(raw);
    AppendConsoleCommandEcho(raw);

    g_ConsoleUi.Input.clear();
    g_ConsoleUi.SlashPrefillActive = false;
    g_ConsoleUi.Draft.clear();
    g_ConsoleUi.HistoryPosition = -1;
    g_ConsoleUi.CompletionMatches.clear();
    g_ConsoleUi.CompletionPosition = -1;
    g_ConsoleUi.FocusInput = true;
    g_ConsoleUi.ScrollToBottom = true;
    return true;
}

static ImVec4 ConsoleLineColor(EConsoleLineKind)
{
    return ImVec4(1.f, 1.f, 1.f, 1.f);
}

static void DrawConsoleHistoryPopup(
    const ImVec2& inputMin, const ImVec2& inputMax)
{
    const int selected = g_ConsoleUi.HistoryPosition;
    const int historyCount =
        static_cast<int>(g_ConsoleUi.History.size());
    if (selected < 0 || selected >= historyCount)
        return;

    static constexpr int kMaximumVisibleHistory = 5;
    const int visibleCount =
        (std::min)(kMaximumVisibleHistory, historyCount);
    const int maximumFirst =
        historyCount - visibleCount;
    const int first =
        (std::max)(
            0,
            (std::min)(
                maximumFirst,
                selected - visibleCount / 2));
    const int last = first + visibleCount - 1;
    const float rowHeight =
        std::ceil(ImGui::GetTextLineHeight() + 5.f);
    const float popupPadding = 3.f;
    float popupWidth = 96.f;
    for (int index = first; index <= last; index++)
    {
        const std::string label =
            "> " + g_ConsoleUi.History[static_cast<size_t>(index)];
        popupWidth =
            (std::max)(
                popupWidth,
                ImGui::CalcTextSize(label.c_str()).x + 14.f);
    }
    popupWidth =
        std::ceil(
            (std::min)(
                popupWidth,
                inputMax.x - inputMin.x));

    const float popupHeight =
        rowHeight * static_cast<float>(visibleCount) +
        popupPadding * 2.f;
    const ImVec2 popupMax(
        std::round(inputMin.x) + popupWidth,
        std::round(inputMin.y - 2.f));
    const ImVec2 popupMin(
        std::round(inputMin.x),
        popupMax.y - popupHeight);

    ImDrawList* draw = ImGui::GetForegroundDrawList();
    draw->AddRectFilled(
        popupMin,
        popupMax,
        ImGui::GetColorU32(
            ImVec4(0.025f, 0.025f, 0.025f, 0.94f)));
    draw->PushClipRect(popupMin, popupMax, true);
    for (int index = first; index <= last; index++)
    {
        const float rowTop =
            popupMin.y + popupPadding +
            rowHeight * static_cast<float>(index - first);
        if (index == selected)
        {
            draw->AddRectFilled(
                ImVec2(popupMin.x + 2.f, rowTop),
                ImVec2(popupMax.x - 2.f, rowTop + rowHeight),
                ImGui::GetColorU32(
                    ImVec4(0.24f, 0.24f, 0.24f, 0.72f)));
        }

        const std::string label =
            "> " + g_ConsoleUi.History[static_cast<size_t>(index)];
        draw->AddText(
            ImVec2(popupMin.x + 7.f, rowTop + 2.f),
            ImGui::GetColorU32(
                ImVec4(1.f, 1.f, 1.f, 1.f)),
            label.c_str());
    }
    draw->PopClipRect();
}

static bool RenderConsoleCommandInput(
    float rightPadding, float frameOpacity)
{
    // [Rift] The button width follows the label, so nothing gets cut off.
    const char* clearLabel = "Clear##console_logs";
    const float clearButtonWidth = (std::max)(
        62.f,
        ImGui::CalcTextSize(clearLabel, nullptr, true).x +
            ImGui::GetStyle().FramePadding.x * 2.f);
    const float controlSpacing = 6.f;
    const bool slashPrefillWasActive =
        g_ConsoleUi.SlashPrefillActive;
    ImGui::SetNextItemWidth((std::max)(
        120.f,
        ImGui::GetContentRegionAvail().x -
            rightPadding - clearButtonWidth - controlSpacing));
    if (g_ConsoleUi.FocusInput &&
        FGUI::bConsoleVisible.load(std::memory_order_acquire))
    {
        ImGui::SetKeyboardFocusHere();
        g_ConsoleUi.FocusInput = false;
    }

    if (g_ConsoleUi.ReloadInput)
    {
        // InputText keeps an internal edit buffer while the console fades.
        // Reload it before processing this frame's queued characters so both
        // slash seeding and synthetic-slash cleanup are applied immediately.
        const ImGuiID inputId = ImGui::GetID("##console_input");
        if (ImGuiInputTextState* inputState =
                ImGui::GetInputTextState(inputId))
        {
            inputState->ReloadUserBufAndMoveToEnd();
        }
        g_ConsoleUi.ReloadInput = false;
    }

    const ImGuiInputTextFlags inputFlags =
        ImGuiInputTextFlags_EnterReturnsTrue |
        ImGuiInputTextFlags_EscapeClearsAll |
        ImGuiInputTextFlags_CallbackHistory |
        ImGuiInputTextFlags_CallbackCompletion |
        ImGuiInputTextFlags_CallbackEdit;

    const ImVec2 promptSize = ImGui::CalcTextSize(">");
    const float promptLeftPadding = 8.f;
    const float promptGap = 7.f;
    const float frameAlpha =
        (std::max)(0.f, (std::min)(1.f, frameOpacity));
    const ImVec2 framePadding = ImGui::GetStyle().FramePadding;
    ImGui::PushStyleVar(
        ImGuiStyleVar_FramePadding,
        ImVec2(
            promptLeftPadding + promptSize.x + promptGap,
            framePadding.y));
    ImGui::PushStyleVar(
        ImGuiStyleVar_FrameBorderSize, 0.f);
    ImGui::PushStyleColor(
        ImGuiCol_Text, ImVec4(1.f, 1.f, 1.f, 1.f));
    ImGui::PushStyleColor(
        ImGuiCol_TextSelectedBg,
        ImVec4(0.42f, 0.42f, 0.42f, 0.55f));
    ImGui::PushStyleColor(
        ImGuiCol_NavHighlight,
        ImVec4(0.58f, 0.58f, 0.60f, 0.72f));
    ImGui::PushStyleColor(
        ImGuiCol_FrameBg, ImVec4(0.f, 0.f, 0.f, frameAlpha));
    ImGui::PushStyleColor(
        ImGuiCol_FrameBgHovered, ImVec4(0.f, 0.f, 0.f, frameAlpha));
    ImGui::PushStyleColor(
        ImGuiCol_FrameBgActive, ImVec4(0.f, 0.f, 0.f, frameAlpha));
    const bool submitted = ImGui::InputText(
        "##console_input", &g_ConsoleUi.Input,
        inputFlags, ConsoleInputCallback, &g_ConsoleUi);
    if (slashPrefillWasActive && ImGui::IsItemActivated())
    {
        // SetKeyboardFocusHere() activates a single-line InputText through
        // navigation, which selects its full buffer on first use. Collapse
        // that selection at the end so the next character is appended to the
        // seeded slash instead of replacing it.
        if (ImGuiInputTextState* inputState =
                ImGui::GetInputTextState(ImGui::GetItemID()))
        {
            inputState->SelectAll();
            inputState->ClearSelection();
            inputState->CursorFollow = true;
        }
    }
    if (g_ConsoleUi.RefocusAfterEscapeClear)
    {
        // EscapeClearsAll deactivates an already-empty InputText. Request
        // focus on the next frame so the cleared console remains ready for
        // typing without letting the same Escape reactivate it immediately.
        g_ConsoleUi.RefocusAfterEscapeClear = false;
        if (FGUI::bConsoleVisible.load(std::memory_order_acquire))
            g_ConsoleUi.FocusInput = true;
    }
    const ImVec2 inputMin = ImGui::GetItemRectMin();
    const ImVec2 inputMax = ImGui::GetItemRectMax();
    ImGui::PopStyleColor(6);
    ImGui::PopStyleVar(2);

    const float promptY =
        std::round(
            inputMin.y +
            (std::max)(
                0.f,
                (inputMax.y - inputMin.y - promptSize.y) * 0.5f));
    ImGui::GetWindowDrawList()->AddText(
        ImVec2(
            std::round(inputMin.x + promptLeftPadding),
            promptY),
        ImGui::GetColorU32(
            ImVec4(1.f, 1.f, 1.f, 1.f)),
        ">");
    DrawConsoleHistoryPopup(inputMin, inputMax);

    ImGui::SameLine(0.f, controlSpacing);
    ImGui::PushStyleVar(ImGuiStyleVar_FrameBorderSize, 0.f);
    ImGui::PushStyleColor(
        ImGuiCol_Text, ImVec4(1.f, 1.f, 1.f, 1.f));
    ImGui::PushStyleColor(
        ImGuiCol_Button, ImVec4(0.f, 0.f, 0.f, frameAlpha));
    ImGui::PushStyleColor(
        ImGuiCol_ButtonHovered,
        ImVec4(0.18f, 0.18f, 0.18f, frameAlpha));
    ImGui::PushStyleColor(
        ImGuiCol_ButtonActive,
        ImVec4(0.27f, 0.27f, 0.27f, frameAlpha));
    const bool clearLogs = ImGui::Button(
        clearLabel,
        ImVec2(clearButtonWidth, inputMax.y - inputMin.y));
    ImGui::PopStyleColor(4);
    ImGui::PopStyleVar();
    if (clearLogs)
    {
        ClearConsoleLogs();
        g_ConsoleUi.FocusInput = true;
    }

    return submitted && SubmitConsoleCommand();
}

static void RenderConsoleWindow(float fade)
{
    if (fade <= 0.f)
        return;

    ImGuiIO& io = ImGui::GetIO();
    const bool expanded = g_ConsoleUi.Expanded;
    const float consoleWidth = (std::max)(1.f, io.DisplaySize.x);
    const float screenBottom =
        std::round((std::max)(1.f, io.DisplaySize.y));
    const float compactHeight =
        (std::min)(screenBottom, 40.f);
    const float expansion =
        g_ConsoleUi.Expansion * g_ConsoleUi.Expansion *
        (3.f - 2.f * g_ConsoleUi.Expansion);
    const float desiredConsoleHeight =
        compactHeight +
        (screenBottom - compactHeight) *
            expansion;
    const float consoleY =
        std::round(
            (std::max)(
                0.f,
                screenBottom - desiredConsoleHeight));
    const float consoleHeight =
        (std::max)(1.f, screenBottom - consoleY);
    const bool showExpandedContent =
        expanded && consoleHeight >= 220.f;

    ImGuiWindowFlags flags = ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_NoSavedSettings |
        ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoScrollbar |
        ImGuiWindowFlags_NoScrollWithMouse | ImGuiWindowFlags_NoMove |
        ImGuiWindowFlags_NoResize;
    if (!FGUI::bConsoleVisible)
        flags |= ImGuiWindowFlags_NoInputs;

    ImGui::SetNextWindowPos(ImVec2(0.f, consoleY), ImGuiCond_Always);
    ImGui::SetNextWindowSize(
        ImVec2(consoleWidth, consoleHeight), ImGuiCond_Always);
    if (g_ConsoleUi.FocusInput && FGUI::bConsoleVisible)
        ImGui::SetNextWindowFocus();

    ImGui::PushStyleVar(ImGuiStyleVar_Alpha, fade);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0.f, 0.f));
    ImGui::PushStyleVar(ImGuiStyleVar_WindowRounding, 0.f);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 0.f);
    // The expanded console is a dimmed game view with output drawn directly
    // over it. Keep this interaction window invisible; only the command input
    // retains its own black frame.
    ImGui::PushStyleColor(
        ImGuiCol_WindowBg,
        ImVec4(0.f, 0.f, 0.f, 0.f));
    ImGui::Begin("##atlas_unreal_console", nullptr, flags);
    ImGui::PopStyleColor();
    ImGui::PopStyleVar(3);
    g_ConsoleUi.WindowFocused =
        FGUI::bConsoleVisible.load(std::memory_order_acquire) &&
        ImGui::IsWindowFocused(ImGuiFocusedFlags_RootAndChildWindows);

    const float width = ImGui::GetWindowWidth();
    const ImVec2 windowPos = ImGui::GetWindowPos();
    const float horizontalPadding = 8.f;
    const float inputScreenY =
        screenBottom -
        std::round(ImGui::GetFrameHeight()) - 7.f;
    const float inputY =
        (std::max)(
            2.f,
            inputScreenY - windowPos.y);
    const float inputFrameOpacity =
        0.90f + 0.10f * g_ConsoleUi.Expansion;

    if (!showExpandedContent)
    {
        ImGui::SetCursorPos(ImVec2(horizontalPadding, inputY));
        if (RenderConsoleCommandInput(
                horizontalPadding, inputFrameOpacity) &&
            !expanded)
            CloseConsoleSurface();
    }
    else
    {
        ImGui::SetCursorPos(ImVec2(horizontalPadding, 7.f));
        const float logHeight = (std::max)(
            80.f,
            inputY - ImGui::GetCursorPosY() - 4.f);
        ImGui::PushStyleColor(
            ImGuiCol_ChildBg,
            ImVec4(0.f, 0.f, 0.f, 0.f));
        ImGui::PushStyleColor(
            ImGuiCol_ScrollbarBg,
            ImVec4(0.035f, 0.035f, 0.035f, 0.58f));
        ImGui::PushStyleColor(
            ImGuiCol_ScrollbarGrab,
            ImVec4(0.38f, 0.38f, 0.40f, 0.88f));
        ImGui::PushStyleColor(
            ImGuiCol_ScrollbarGrabHovered,
            ImVec4(0.52f, 0.52f, 0.54f, 0.96f));
        ImGui::PushStyleColor(
            ImGuiCol_ScrollbarGrabActive,
            ImVec4(0.66f, 0.66f, 0.68f, 1.f));
        ImGui::PushStyleVar(
            ImGuiStyleVar_ChildBorderSize, 0.f);
        ImGui::PushStyleVar(
            ImGuiStyleVar_ChildRounding, 0.f);
        ImGui::PushStyleVar(
            ImGuiStyleVar_ScrollbarSize, 11.f);
        ImGui::PushStyleVar(
            ImGuiStyleVar_ScrollbarRounding, 1.f);
        ImGui::BeginChild(
            "##console_log",
            ImVec2(width - horizontalPadding * 2.f, logHeight),
            false,
            ImGuiWindowFlags_HorizontalScrollbar);

        static uint64_t lastRenderedRevision = 0;
        const bool hasNewLines =
            lastRenderedRevision != g_ConsoleLineRevision;
        const bool shouldScroll =
            g_ConsoleUi.ScrollToBottom ||
            (hasNewLines && g_ConsoleUi.WasAtBottom);
        const bool wasAtBottom =
            ImGui::GetScrollY() >= ImGui::GetScrollMaxY() - 2.f;

        if (!g_ConsoleLines.empty())
        {
            const float lineHeight =
                ImGui::GetTextLineHeightWithSpacing();
            const float lineContentHeight =
                lineHeight *
                static_cast<float>(g_ConsoleLines.size());
            const float bottomAlignment =
                (std::max)(
                    0.f,
                    ImGui::GetContentRegionAvail().y -
                        lineContentHeight);
            if (bottomAlignment > 0.f)
            {
                ImGui::SetCursorPosY(
                    ImGui::GetCursorPosY() +
                    bottomAlignment);
            }

            ImGuiListClipper clipper;
            clipper.Begin(
                static_cast<int>(g_ConsoleLines.size()),
                lineHeight);
            if (shouldScroll)
            {
                clipper.IncludeItemByIndex(
                    static_cast<int>(g_ConsoleLines.size()) - 1);
            }

            while (clipper.Step())
            {
                for (int row = clipper.DisplayStart;
                    row < clipper.DisplayEnd; row++)
                {
                    const FConsoleLine& line =
                        g_ConsoleLines[static_cast<size_t>(row)];
                    ImGui::PushID(static_cast<int>(line.Id));
                    if (line.Kind == EConsoleLineKind::Spacer)
                    {
                        ImGui::Dummy(ImVec2(
                            0.f, ImGui::GetTextLineHeight()));
                    }
                    else
                    {
                        ImGui::PushStyleColor(
                            ImGuiCol_Text,
                            ImVec4(0.46f, 0.46f, 0.48f, 1.f));
                        ImGui::TextUnformatted(line.Time.c_str());
                        ImGui::PopStyleColor();
                        ImGui::SameLine();
                        ImGui::PushStyleColor(
                            ImGuiCol_Text,
                            ConsoleLineColor(line.Kind));
                        ImGui::TextUnformatted(line.Text.c_str());
                        ImGui::PopStyleColor();
                    }
                    ImGui::PopID();

                    if (shouldScroll &&
                        row == static_cast<int>(
                            g_ConsoleLines.size()) - 1)
                    {
                        ImGui::SetScrollHereY(1.f);
                    }
                }
            }
        }

        g_ConsoleUi.WasAtBottom = shouldScroll || wasAtBottom;
        g_ConsoleUi.ScrollToBottom = false;
        lastRenderedRevision = g_ConsoleLineRevision;
        ImGui::EndChild();
        ImGui::PopStyleVar(4);
        ImGui::PopStyleColor(5);

        ImGui::SetCursorPos(ImVec2(horizontalPadding, inputY));
        (void)RenderConsoleCommandInput(
            horizontalPadding, inputFrameOpacity);
    }

    ImGui::End();
    ImGui::PopStyleVar();
}

void GUI_Render()
{
    ImGuiIO& io = ImGui::GetIO();
    // Keep background ClientMessage capture bounded, but do not take the
    // pending-output mutex on every Present while the console is hidden.
    // Opening either console size drains everything collected since it closed.
    if (FGUI::bConsoleVisible.load(std::memory_order_acquire))
        DrainConsoleOutput();

    static float s_MenuFade = 0.f;
    static float s_ConsoleFade = 0.f;
    const float deltaTime = io.DeltaTime > 0.f ? io.DeltaTime : 1.f / 60.f;

    if (g_ConsoleUi.ResetExpansion)
    {
        g_ConsoleUi.Expansion = 0.f;
        g_ConsoleUi.ResetExpansion = false;
    }
    const float expansionTarget =
        g_ConsoleUi.Expanded ? 1.f : 0.f;
    const float expansionStep = deltaTime / 0.16f;
    if (g_ConsoleUi.Expansion < expansionTarget)
    {
        g_ConsoleUi.Expansion =
            (std::min)(expansionTarget,
                g_ConsoleUi.Expansion + expansionStep);
    }
    else if (g_ConsoleUi.Expansion > expansionTarget)
    {
        g_ConsoleUi.Expansion =
            (std::max)(expansionTarget,
                g_ConsoleUi.Expansion - expansionStep);
    }

    auto updateFade = [deltaTime](float& value, bool visible, float duration)
    {
        const float target = visible ? 1.f : 0.f;
        const float step = deltaTime / duration;
        if (value < target) { value += step; if (value > target) value = target; }
        else if (value > target) { value -= step; if (value < target) value = target; }
    };

    updateFade(s_MenuFade, FGUI::bVisible, 0.15f);
    updateFade(s_ConsoleFade, FGUI::bConsoleVisible, 0.18f);

    const float menuFade = s_MenuFade * s_MenuFade * (3.f - 2.f * s_MenuFade);
    const float consoleFade = s_ConsoleFade * s_ConsoleFade * (3.f - 2.f * s_ConsoleFade);
    const float surfaceFade = (std::max)(menuFade, consoleFade);

    // [Rift] Trickshot banner: every frame, even when the menu and the console are closed.
    NiobiumToast_Draw();

    if (surfaceFade <= 0.f)
        return;

    const float backdropOpacity = (std::max)(
        menuFade * 0.50f,
        consoleFade *
            (0.50f * g_ConsoleUi.Expansion));
    if (backdropOpacity > 0.f)
    {
        ImGui::GetBackgroundDrawList()->AddRectFilled(
            ImVec2(0.f, 0.f),
            io.DisplaySize,
            IM_COL32(
                0, 0, 0,
                static_cast<int>(backdropOpacity * 255.f)));
    }

    RenderConsoleWindow(consoleFade);
    if (menuFade <= 0.f)
        return;

    const float fade = menuFade;
    ImGuiWindowFlags wflags = ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_NoSavedSettings |
        ImGuiWindowFlags_NoTitleBar;
    if (!FGUI::bVisible)
        wflags |= ImGuiWindowFlags_NoInputs;

    ImGui::SetNextWindowPos(ImVec2(io.DisplaySize.x * 0.5f, io.DisplaySize.y * 0.5f), ImGuiCond_Once, ImVec2(0.5f, 0.5f));
    ImGui::SetNextWindowSize(ImVec2(580.f, 410.f), ImGuiCond_Once);
    ImGui::SetNextWindowSizeConstraints(ImVec2(500.f, 320.f), ImVec2(10000.f, 10000.f));
    if (g_FocusMenuWindow && FGUI::bVisible)
    {
        ImGui::SetNextWindowFocus();
        g_FocusMenuWindow = false;
    }

    ImGui::PushStyleVar(ImGuiStyleVar_Alpha, fade);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0.f, 0.f));
    bool open = true;
    ImGui::Begin("##atlas_main", &open, wflags);
    ImGui::PopStyleVar();
    g_MenuWindowFocused =
        FGUI::bVisible.load(std::memory_order_acquire) &&
        ImGui::IsWindowFocused(ImGuiFocusedFlags_RootAndChildWindows);

    const float W = ImGui::GetWindowWidth();
    const float H = ImGui::GetWindowHeight();
    const ImVec2 wp = ImGui::GetWindowPos();

    const float TopBarH = 46.f;
    const float SidebarW = 118.f;

    // top bar
    {
        ImGui::GetWindowDrawList()->AddRectFilled(
            wp, ImVec2(wp.x + W, wp.y + TopBarH),
            ImGui::GetColorU32(kNiobiumBg), // [Rift] brand bg #07070C
            ImGui::GetStyle().WindowRounding, ImDrawFlags_RoundCornersTop);

        const float LogoSize = 30.f;
        const float PadL = 14.f;

        ImGui::SetCursorPos(ImVec2(PadL, (TopBarH - LogoSize) * 0.5f));
        if (FGUI::LogoTexture != ImTextureID_Invalid)
            ImGui::Image(FGUI::LogoTexture, ImVec2(LogoSize, LogoSize));
        else
            ImGui::Dummy(ImVec2(LogoSize, LogoSize));

        char Badge[32];
        snprintf(Badge, sizeof(Badge), "[%s]", VKName(FGUI::HotkeyVK));
        const float BadgeW = ImGui::CalcTextSize(Badge).x;
        const float BadgeH = ImGui::GetTextLineHeight();

        // Close button pinned to the top-right; the hotkey badge sits to its left.
        const float CloseSize = 22.f;
        const float CloseX = W - CloseSize - 12.f;
        const float BadgeX = CloseX - 12.f - BadgeW;

        ImGui::SameLine(PadL + LogoSize + 10.f);
        const float TitleY = (TopBarH - ImGui::GetTextLineHeight()) * 0.5f;
        ImGui::SetCursorPosY(TitleY);
        {
            // [Rift] Wordmark "RIFT": wide letter spacing, slightly bold, in the brand's text
            // gradient (text #F4F4F8 -> violet-text #C4B5FD -> cyan-text #67E8F9).
            static const char* const kLetters[] = { "R", "I", "F", "T" };
            static const ImVec4 kLetterColours[] = {
                ImVec4(0.957f, 0.957f, 0.973f, 1.f), ImVec4(0.863f, 0.835f, 0.984f, 1.f),
                ImVec4(0.769f, 0.710f, 0.992f, 1.f), ImVec4(0.404f, 0.910f, 0.976f, 1.f)
            };
            constexpr float LetterSpacing = 3.f;
            ImDrawList* dl = ImGui::GetWindowDrawList();
            const ImVec2 start = ImGui::GetCursorScreenPos();
            float x = start.x;
            for (int i = 0; i < 4; ++i)
            {
                const ImU32 colour = ImGui::GetColorU32(kLetterColours[i]);
                dl->AddText(ImVec2(x, start.y), colour, kLetters[i]);
                dl->AddText(ImVec2(x + 1.f, start.y), colour, kLetters[i]);
                x += ImGui::CalcTextSize(kLetters[i]).x + 1.f + LetterSpacing;
            }
            ImGui::Dummy(ImVec2(x - start.x - LetterSpacing, ImGui::GetTextLineHeight()));
        }
        ImGui::SameLine(0.f, 10.f);
        ImGui::SetCursorPosY(TitleY);
        ImGui::PushStyleColor(ImGuiCol_Text, kNiobiumMutedText);
        ImGui::TextUnformatted("Menu"); // [Rift] was "| Console", then "Rift | Menu"
        ImGui::PopStyleColor();

        // [Rift] The version only shows when it fits in front of the key badge
        // (narrow windows used to draw it under the badge).
        const float VersionX = ImGui::GetItemRectMax().x - wp.x + 8.f;
        if (VersionX + ImGui::CalcTextSize(FConfiguration::ConsoleVersion).x + 12.f <= BadgeX)
        {
            ImGui::SameLine(0.f, 8.f);
            ImGui::SetCursorPosY(TitleY);
            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.431f, 0.451f, 0.573f, 0.75f));
            ImGui::TextUnformatted(FConfiguration::ConsoleVersion);
            ImGui::PopStyleColor();
        }

        ImGui::SetCursorPos(ImVec2(BadgeX, (TopBarH - BadgeH) * 0.5f));
        ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.431f, 0.451f, 0.573f, 0.9f));
        ImGui::TextUnformatted(Badge);
        ImGui::PopStyleColor();

        ImGui::SetCursorPos(ImVec2(CloseX, (TopBarH - CloseSize) * 0.5f));
        if (ImGui::InvisibleButton("##closebtn", ImVec2(CloseSize, CloseSize)))
            CloseMenuSurface();
        {
            const bool hovered = ImGui::IsItemHovered();
            ImDrawList* dl = ImGui::GetWindowDrawList();
            const ImVec2 rmin = ImGui::GetItemRectMin();
            const ImVec2 rmax = ImGui::GetItemRectMax();
            if (hovered)
                dl->AddRectFilled(rmin, rmax, ImGui::GetColorU32(Accent(0.20f)), 4.f);
            const float pad = 6.f;
            const ImU32 xcol = ImGui::GetColorU32(hovered ? AccentText() : ImVec4(0.60f, 0.60f, 0.70f, 1.f));
            dl->AddLine(ImVec2(rmin.x + pad, rmin.y + pad), ImVec2(rmax.x - pad, rmax.y - pad), xcol, 1.6f);
            dl->AddLine(ImVec2(rmax.x - pad, rmin.y + pad), ImVec2(rmin.x + pad, rmax.y - pad), xcol, 1.6f);
        }
    }

    // Keep the horizontal rule one pixel inside the top bar so the sidebar
    // child cannot paint over its left segment.
    {
        ImDrawList* fdl = ImGui::GetWindowDrawList();
        const ImU32 line = IM_COL32(36, 36, 58, (int)(fade * 255.f)); // [Rift] border #24243A
        // [Rift] The rule under the header runs from brand violet into cyan (decoration only).
        fdl->AddRectFilledMultiColor(
            ImVec2(wp.x, wp.y + TopBarH - 1.f),
            ImVec2(wp.x + W, wp.y + TopBarH),
            ImGui::GetColorU32(Accent(0.85f)), ImGui::GetColorU32(AccentCyan(0.70f)),
            ImGui::GetColorU32(AccentCyan(0.70f)), ImGui::GetColorU32(Accent(0.85f)));
        fdl->AddLine(ImVec2(wp.x + SidebarW, wp.y + TopBarH), ImVec2(wp.x + SidebarW, wp.y + H), line, 1.f);
    }

    // [Rift] One Rift menu (order: ERiftMenuTab). "Host" holds everything the host controls
    // during a match (the server window is hidden now). The sidebar has room for 6 tabs (minimum
    // height 320 px, 40 px each). Names must fit the 118 px sidebar. The tab id is the index.
    static const char* kTabs[] = {
        "Main", "Host", "Trickshot", "Commands", "Options", "Credits"
    };
    const int kTabCount = (int)(sizeof(kTabs) / sizeof(kTabs[0]));
    const float TabH = 40.f;
    const float TabsTop = 12.f;

    ImGui::SetCursorPos(ImVec2(0.f, TopBarH));
    ImGui::PushStyleColor(ImGuiCol_ChildBg, kNiobiumBg); // [Rift] brand bg #07070C (was #0e1118)
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0.f, 0.f));
    ImGui::BeginChild("##sidebar", ImVec2(SidebarW, H - TopBarH), false, ImGuiWindowFlags_NoScrollbar);
    {
        const ImVec2 sbPos = ImGui::GetWindowPos();

        for (int i = 0; i < kTabCount; i++)
        {
            ImGui::SetCursorPos(ImVec2(0.f, TabsTop + i * TabH));
            SidebarTab(kTabs[i], i, TabH);
        }

        static float s_IndicatorY = -1.f;
        const float localTarget = TabsTop + FGUI::ActiveTab * TabH + TabH * 0.5f;
        if (s_IndicatorY < 0.f) s_IndicatorY = localTarget;
        float lerp = io.DeltaTime * 16.f;
        if (lerp > 1.f) lerp = 1.f;
        s_IndicatorY += (localTarget - s_IndicatorY) * lerp;
        const float indY = sbPos.y + s_IndicatorY;
        ImGui::GetWindowDrawList()->AddRectFilled(
            ImVec2(sbPos.x, indY - 9.f), ImVec2(sbPos.x + 3.f, indY + 9.f),
            ImGui::GetColorU32(AccentCyan()), 2.f); // [Rift] cyan indicator next to the violet tab tint
    }
    ImGui::EndChild();
    ImGui::PopStyleVar();
    ImGui::PopStyleColor();

    if (FGUI::ActiveTab != TabCommands)
        FinishSavedCommandEdit(false);

    const float ContentPadX = ContentHorizontalInset;
    const float ContentPadTop = 14.f;
    const bool bCommandsTab = FGUI::ActiveTab == TabCommands;
    // [Rift] The Trickshot and Host tabs are always taller than the window: keep the scrollbar
    // visible so the button widths don't jump.
    const bool bTrickshotTab = FGUI::ActiveTab == TabTrickshot || FGUI::ActiveTab == TabHost;
    const float ContentChildW =
        (W - SidebarW) - ContentPadX;
    ImGui::SetCursorPos(ImVec2(SidebarW + ContentPadX, TopBarH + ContentPadTop));
    ImGui::PushStyleColor(ImGuiCol_ChildBg, ImVec4(0.f, 0.f, 0.f, 0.f));
    ImGui::PushStyleVar(ImGuiStyleVar_Alpha, fade);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0.f, 0.f));
    ImGui::PushStyleVar(ImGuiStyleVar_ItemSpacing, ImVec2(8.f, 6.f));
    const ImGuiWindowFlags ContentFlags = (bCommandsTab || bTrickshotTab) ? ImGuiWindowFlags_AlwaysVerticalScrollbar : ImGuiWindowFlags_None; // [Rift] + Trickshot
    ImGui::BeginChild("##content",
        ImVec2(ContentChildW, (H - TopBarH) - ContentPadTop - 12.f), false,
        ContentFlags);
    {
        // [Rift] Every tab shares this child window, so a new tab starts at the top
        // instead of inheriting the scroll position of the tab before.
        static int s_LastContentTab = -1;
        if (s_LastContentTab != FGUI::ActiveTab)
        {
            s_LastContentTab = FGUI::ActiveTab;
            ImGui::SetScrollY(0.f);
        }
    }

    float CW =
        ImGui::GetContentRegionAvail().x -
            SectionBodyIndent - ContentHorizontalInset;
    if (CW < 1.f)
        CW = ImGui::GetContentRegionAvail().x;

    switch (FGUI::ActiveTab)
    {
    case TabMain: // main tab ([Rift] "Main": plain English texts with grey hints)
    {
        SectionLabel("Join a server");
        BeginSectionBody();

    const char* hostTypeItems[] = { "On this PC", "On another PC" };
    const float hostControlWidth = CW;
    LabeledCombo(
        "Where is the server running?", "##hosttype", &FGUI::HostType,
        hostTypeItems, IM_ARRAYSIZE(hostTypeItems),
        hostControlWidth);

    ImGui::Spacing();

    if (FGUI::HostType == 0)
    {
        if (ImGui::Button(
                FitLabel("Join the server on this PC###join_local",
                    "Join###join_local", hostControlWidth),
                ImVec2(hostControlWidth, 0.f)))
            JoinSelectedHost();
    }
    else
    {
        ImGui::PushItemWidth(hostControlWidth);
        if (ImGui::InputTextWithHint("##remoteip", "Invite code or IP of the other PC", FGUI::RemoteIP, sizeof(FGUI::RemoteIP)))
            g_JoinError.clear();
        ImGui::PopItemWidth();

        ImGui::Spacing();

        if (ImGui::Button(
                FitLabel("Join the server at this IP###join_remote",
                    "Join###join_remote", hostControlWidth),
                ImVec2(hostControlWidth, 0.f)))
            JoinSelectedHost();
        HoverHint("Paste the invite your friend copied in Rift (RIFT1:...) or their IP address.");
        if (!g_JoinError.empty())
        {
            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1.f, 0.39f, 0.43f, 1.f));
            ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + (std::max)(40.f, hostControlWidth));
            ImGui::TextUnformatted(g_JoinError.c_str());
            ImGui::PopTextWrapPos();
            ImGui::PopStyleColor();
        }
    }

    ImGui::Spacing();
    {
        char joinHint[160];
        snprintf(joinHint, sizeof(joinHint),
            "Tip: when the menu is closed, press %s to join right away.",
            VKName(FGUI::JoinHotkeyVK));
        ControlHint(joinHint, hostControlWidth);
    }
    EndSectionBody();

    // [Rift] Always shown now. Each row uses exactly one route on this version
    // (EditFeatureRoutes.h): our hook on old versions, Fortnite's own setting where Epic has one,
    // or greyed out with the reason. Menu and hooks use the same version rule.
    {
        using NiobiumEditRoutes::EFeature;
        SectionLabel("Editing");
        BeginSectionBody();
        const long long editVersion =
            NiobiumEditRoutes::VersionHundredths(VersionInfo.FortniteVersion);
        const bool autoConfirmEdits =
            editVersion >= NiobiumEditRoutes::EpicSettingSince(EFeature::ResetOnRelease);

        DrawEditFeatureRow(EFeature::EditOnRelease,
            "Edit on release###eor", FConfiguration::bEOREnabled,
            "Your edit is confirmed as soon as you let go of the key.",
            autoConfirmEdits
                ? "Uses Fortnite's own \"Auto Confirm Edits\" setting (Edit)."
                : "Uses Fortnite's own \"Confirm Edit on Release\" setting on this version. "
                  "Changing it here changes it there too.",
            editVersion, CW);

        DrawEditFeatureRow(EFeature::ResetOnRelease,
            "Reset on release###ror", FConfiguration::bROREnabled,
            "Your reset is confirmed as soon as you let go of the key.",
            "Uses Fortnite's own \"Auto Confirm Edits\" setting (Reset). "
            "Edit and Reset both on = \"Both\".",
            editVersion, CW);

        DrawEditFeatureRow(EFeature::PreEdits,
            "Disable pre-edits###disable_pre_edits", FConfiguration::bDisablePreEdits,
            "You never edit the see-through preview piece by accident.",
            "Uses Fortnite's own \"Disable Pre-Edits\" setting.",
            editVersion, CW);
        EndSectionBody();
    }

    SectionLabel("Graphics");
    BeginSectionBody();

    PersistentAbsoluteCommandCheckbox(
        "Mobile Builds###mobile_builds",
        FConfiguration::bMobileBuilds,
        SettingCommandMobileBuilds);
    ControlHint("Draws builds and the world with less detail, like on phones. Works on every version, right away.", CW, true);

    // [Rift] Bubble look: the game thread lowers the detail of the four build blueprint
    // textures (Client.cpp, MaintainBubbleLook). Saved in client.json like Mobile Builds.
    PersistentCheckbox(
        "Bubble look###bubble_look",
        FConfiguration::bBubbleLook);
    ControlHint("Makes the see-through part of builds soft and bubbly by lowering the detail of "
        "the build blueprint textures. Only you see it. Works right away, no restart. "
        "Close to the old effect, not Epic's exact one.", CW, true);
    if (FConfiguration::bBubbleLook.load(std::memory_order_acquire))
        DrawBubbleLookControls(CW);

    PersistentAbsoluteCommandCheckbox(
        "In-game fog###ingame_fog",
        FConfiguration::bGameplayFog,
        SettingCommandInGameFog);
    ControlHint("Off = clearer view into the distance.", CW, true);

    {
        const float sliderWidth = CW;
        int mipMapLODBias = FConfiguration::MipMapLODBias.load(
            std::memory_order_acquire);
        if (LabeledSliderInt(
                "Simpler textures", "##potatographics",
                &mipMapLODBias, 0, 15,
                sliderWidth))
        {
            std::lock_guard<std::mutex> lock(
                g_SettingCommandMutex);
            FConfiguration::MipMapLODBias.store(
                mipMapLODBias, std::memory_order_release);
            g_PendingSettingCommandMask.fetch_or(
                SettingCommandMipMapLODBias,
                std::memory_order_acq_rel);
        }
        ControlHint("0 = normal. Higher = blurrier, but often runs smoother.", sliderWidth);
    }
    EndSectionBody();

    SectionLabel("Field of view");
    {
        BeginSectionBody();
        const char* resetLabel = "Back to 80###reset_fov";
        const float ResetW = (std::max)(
            110.f,
            ImGui::CalcTextSize(resetLabel, nullptr, true).x +
                ImGui::GetStyle().FramePadding.x * 2.f + 12.f);
        const float SliderW = (std::max)(
            80.f,
            CW - ResetW - ImGui::GetStyle().ItemSpacing.x);

        int fieldOfView = FConfiguration::FOV.load(
            std::memory_order_acquire);
        if (LabeledSliderInt(
                "Degrees (normal: 80)", "##fov",
                &fieldOfView, 1, 175, SliderW))
        {
            std::lock_guard<std::mutex> lock(
                g_SettingCommandMutex);
            FConfiguration::FOV.store(
                fieldOfView, std::memory_order_release);
            g_PendingSettingCommandMask.fetch_or(
                SettingCommandFOV,
                std::memory_order_acq_rel);
        }

        ImGui::SameLine();
        if (ImGui::Button(resetLabel, ImVec2(ResetW, 0.f)))
        {
            std::lock_guard<std::mutex> lock(
                g_SettingCommandMutex);
            FConfiguration::FOV.store(
                80, std::memory_order_release);
            g_PendingSettingCommandMask.fetch_or(
                SettingCommandFOV,
                std::memory_order_acq_rel);
        }
        ControlHint("Higher = you see more at the edges.", CW);
        EndSectionBody();
    }

    SectionLabel("Respawn");
    BeginSectionBody();
    PersistentCheckbox(
        "Respawn after you die###respawns_enabled", FConfiguration::bForceRespawns);
    ControlHint("You drop back in from the sky after you die. Applies from your next game start.", CW, true);
    EndSectionBody();

    SectionLabel("Other");
    BeginSectionBody();
    PersistentCheckbox(
        "First person###first_person", FConfiguration::bFirstPerson);
    ControlHint("You see through your character's eyes.", CW, true);

    if (VersionInfo.FortniteVersion <= 10.40)
    {
        SessionToggleCommandCheckbox(
            "Free camera###debug_camera",
            FConfiguration::bDebugCamera,
            SettingCommandDebugCamera);
        ControlHint("The camera flies around freely while your character stays put.", CW, true);
    }

    SessionToggleCommandCheckbox(
        "Target info###target_info",
        FConfiguration::bTargetInfo,
        SettingCommandTargetInfo);
    ControlHint("Shows info about whatever you are aiming at.", CW, true);
    EndSectionBody();

        ImGui::Dummy(ImVec2(0.f, 8.f)); // [Rift] a little space below the last hint
        break;
    }
    case TabCommands: // Commands ([Rift] plain English texts with hints)
    {
        SectionLabel("New command");
        BeginSectionBody();
        ControlHint(
            "Type a command, pick a key and click \"Save\". "
            "For several commands in a row, add each one with \"+" NB_NBSP "Step\" first.", CW);

        ImGui::PushItemWidth(CW);
        ImGui::InputTextWithHint("##commandinput", "Command, e.g. cheat giveammo", FGUI::CommandInput, sizeof(FGUI::CommandInput));
        ImGui::PopItemWidth();

        ImGui::Spacing();

        const float AddButtonW = 110.f;
        const float DelayInputW = CW - AddButtonW - ImGui::GetStyle().ItemSpacing.x;
        ImGui::PushItemWidth(DelayInputW > 140.f ? DelayInputW : 140.f);
        ImGui::InputTextWithHint("##stepdelay", "Wait afterwards (ms)", FGUI::MacroDelayInput, sizeof(FGUI::MacroDelayInput), ImGuiInputTextFlags_CharsDecimal);
        ImGui::PopItemWidth();
        HoverHint("How long to wait before the next step. 1000 ms = 1 second.");
        ImGui::SameLine();

        if (ImGui::Button("+ Step###add_step", ImVec2(AddButtonW, 0.f)))
        {
            const char* start = FGUI::CommandInput;
            while (*start == ' ' || *start == '\t')
                start++;

            if (*start)
            {
                HotkeyPersist::MacroStep step{};
                step.Command = start;
                step.DelayMs = HotkeyPersist::SanitizeMacroDelayMs(atoi(FGUI::MacroDelayInput));
                FGUI::MacroDraftSteps.push_back(std::move(step));
                FGUI::CommandInput[0] = '\0';
            }
        }
        HoverHint("Adds the command as a step. That's how you build a chain of commands.");

        if (!FGUI::MacroDraftSteps.empty())
        {
            ImGui::Spacing();
            ImGui::PushID("draftsteps");
            for (int i = 0; i < (int)FGUI::MacroDraftSteps.size(); i++)
            {
                auto& step = FGUI::MacroDraftSteps[i];
                ImGui::PushID(i);

                ImGui::PushStyleColor(ImGuiCol_Text, kNiobiumText);
                ImGui::TextWrapped("%s", step.Command.c_str());
                ImGui::PopStyleColor();
                ImGui::SameLine();

                if (ImGui::SmallButton("Remove###remove_step"))
                {
                    FGUI::MacroDraftSteps.erase(FGUI::MacroDraftSteps.begin() + i);
                    ImGui::PopID();
                    break;
                }

                if (i + 1 < (int)FGUI::MacroDraftSteps.size())
                {
                    ImGui::PushStyleColor(ImGuiCol_Text, kNiobiumMutedText);
                    ImGui::Text("Wait: %d ms", step.DelayMs);
                    ImGui::PopStyleColor();
                }

                ImGui::PopID();
            }
            ImGui::PopID();
        }

        ImGui::Spacing();

        const float BindButtonW = CW - AddButtonW - ImGui::GetStyle().ItemSpacing.x;
        const float BindButtonWidth = BindButtonW > 140.f ? BindButtonW : 140.f;
        char pendingBindLabel[96];
        if (FGUI::RebindingCommandIndex == -1)
        {
            snprintf(pendingBindLabel, sizeof(pendingBindLabel), "%s",
                FitLabel("Press a key... (Esc = cancel)###new_bind",
                    "Press a key...###new_bind", BindButtonWidth));
        }
        else
        {
            char longBindLabel[96];
            char shortBindLabel[96];
            snprintf(longBindLabel, sizeof(longBindLabel), "Pick a key [%s]###new_bind", BindName(FGUI::PendingCommandVK));
            snprintf(shortBindLabel, sizeof(shortBindLabel), "Key [%s]###new_bind", BindName(FGUI::PendingCommandVK));
            snprintf(pendingBindLabel, sizeof(pendingBindLabel), "%s",
                FitLabel(longBindLabel, shortBindLabel, BindButtonWidth));
        }

        if (ImGui::Button(pendingBindLabel, ImVec2(BindButtonWidth, 0.f)))
        {
            FGUI::RebindingCommandIndex = -1;
            FGUI::RebindingMacroIndex = -2;
            FGUI::bRebinding = false;
            FGUI::bRebindingJoin = false;
            FGUI::bRebindingResetBuilds = false;
            BeginBindCapture();
        }
        HoverHint(FGUI::RebindingCommandIndex == -1
            ? "Press the key you want now. Esc cancels."
            : "This key runs the command later, when the menu is closed. Without a key it only runs with \"Run\".");

        ImGui::SameLine();

        if (ImGui::Button("Save###save_command", ImVec2(AddButtonW, 0.f)))
        {
            std::vector<HotkeyPersist::MacroStep> steps = FGUI::MacroDraftSteps;

            const char* start = FGUI::CommandInput;
            while (*start == ' ' || *start == '\t')
                start++;

            if (*start)
            {
                HotkeyPersist::MacroStep step{};
                step.Command = start;
                step.DelayMs = HotkeyPersist::SanitizeMacroDelayMs(atoi(FGUI::MacroDelayInput));
                steps.push_back(std::move(step));
            }

            if (!steps.empty())
            {
                const int vk = (FGUI::PendingCommandVK > 0 && FGUI::PendingCommandVK <= 254) ? FGUI::PendingCommandVK : 0;

                if (steps.size() == 1)
                {
                    HotkeyPersist::CommandBind command{};
                    command.Command = std::move(steps[0].Command);
                    command.VK = vk;
                    command.DefaultVK = vk;
                    FGUI::Commands.push_back(std::move(command));
                }
                else
                {
                    HotkeyPersist::CommandMacro macro{};
                    macro.Name = steps[0].Command;
                    macro.VK = vk;
                    macro.DefaultVK = vk;
                    macro.Steps = std::move(steps);
                    FGUI::Macros.push_back(std::move(macro));
                }

                FGUI::MacroDraftSteps.clear();
                FGUI::CommandInput[0] = '\0';
                FGUI::MacroDelayInput[0] = '\0';
                FGUI::PendingCommandVK = 0;
                FGUI::RebindingCommandIndex = -2;
                FGUI::SaveCommands();
            }
        }
        HoverHint("Puts the command (or all steps) into \"Your commands\" below.");
        DrawBindError(CW); // [Rift] was only visible in the "Options" tab before

        EndSectionBody();
        SectionLabel("Your commands");
        BeginSectionBody();

        if (FGUI::Commands.empty() && FGUI::Macros.empty())
        {
            ImGui::PushStyleColor(ImGuiCol_Text, kNiobiumHintText);
            ImGui::TextWrapped("No saved commands yet.");
            ImGui::PopStyleColor();
        }
        else
        {
            ControlHint("Double-click a command to change its text.", CW);

            // Row button labels: long if they fit in a third, otherwise short.
            const float RowButtonW = (CW - ImGui::GetStyle().ItemSpacing.x * 2.f) / 3.f;
            const char* runLabel = FitLabel("Run now###run", "Run###run", RowButtonW);
            const char* waitKeyLabel = FitLabel("Press a key...###bind", "Press...###bind", RowButtonW);
            const char* unbindLabel = FitLabel("Remove key###bind", "Unbind###bind", RowButtonW);
            const char* bindLabelText = FitLabel("Pick a key###bind", "Key###bind", RowButtonW);
            const char* deleteLabel = "Delete###delete";
            const char* runHint = "Sends the command right now.";
            const char* waitKeyHint = "Press the key you want now. Esc cancels.";
            const char* unbindHint = "Frees the key. The command stays saved.";
            const char* bindHint = "Pick a key. Then the command runs with one key press when the menu is closed.";
            const char* deleteHint = "Deletes the command from the list.";

            for (int i = 0; i < (int)FGUI::Commands.size(); i++)
            {
                auto& command = FGUI::Commands[i];
                ImGui::PushID(i);

                if (IsEditingSavedCommand(i))
                {
                    RenderSavedCommandEditor(CW);
                }
                else
                {
                    ImGui::PushStyleColor(ImGuiCol_Text, kNiobiumText);
                    ImGui::TextWrapped("%s", command.Command.c_str());
                    ImGui::PopStyleColor();

                    if (ImGui::IsItemHovered())
                    {
                        ImGui::SetMouseCursor(
                            ImGuiMouseCursor_TextInput);
                        if (ImGui::IsMouseDoubleClicked(
                                ImGuiMouseButton_Left))
                        {
                            BeginSavedCommandEdit(i);
                        }
                    }
                }

                ImGui::PushStyleColor(ImGuiCol_Text, kNiobiumMutedText);
                ImGui::Text("Key: %s", BindName(command.VK));
                ImGui::PopStyleColor();

                const float ButtonW = RowButtonW;
                if (ImGui::Button(runLabel, ImVec2(ButtonW, 0.f)))
                {
                    FinishSavedCommandEdit(false);
                    if (Exec(command.Command.c_str()))
                        AppendConsoleCommandEcho(
                            command.Command);
                }
                HoverHint(runHint);
                ImGui::SameLine();

                const bool waitingForKey = FGUI::RebindingCommandIndex == i;
                const bool hasKey = command.VK > 0 && command.VK <= 254;
                const char* bindLabel = waitingForKey ? waitKeyLabel
                    : hasKey ? unbindLabel
                    : bindLabelText;

                if (ImGui::Button(bindLabel, ImVec2(ButtonW, 0.f)))
                {
                    FinishSavedCommandEdit(false);
                    if (FGUI::RebindingCommandIndex == i)
                    {
                        FGUI::RebindingCommandIndex = -2;
                        EndBindCapture();
                    }
                    else if (command.VK > 0 && command.VK <= 254)
                    {
                        command.VK = 0;
                        FGUI::RebindingCommandIndex = -2;
                        FGUI::SaveCommands();
                    }
                    else
                    {
                        FGUI::RebindingCommandIndex = i;
                        FGUI::RebindingMacroIndex = -2;
                        FGUI::bRebinding = false;
                        FGUI::bRebindingJoin = false;
                        FGUI::bRebindingResetBuilds = false;
                        BeginBindCapture();
                    }
                }
                HoverHint(waitingForKey ? waitKeyHint : hasKey ? unbindHint : bindHint);
                ImGui::SameLine();

                if (ImGui::Button(deleteLabel, ImVec2(ButtonW, 0.f)))
                {
                    if (IsEditingSavedCommand(i))
                        CancelSavedCommandEdit();
                    else
                        FinishSavedCommandEdit(false);
                    FGUI::Commands.erase(FGUI::Commands.begin() + i);
                    FGUI::RebindingCommandIndex = -2;
                    FGUI::SaveCommands();
                    ImGui::PopID();
                    break;
                }
                HoverHint(deleteHint);

                ImGui::Separator();
                ImGui::PopID();
            }

            ImGui::PushID("macros");
            for (int i = 0; i < (int)FGUI::Macros.size(); i++)
            {
                auto& macro = FGUI::Macros[i];
                ImGui::PushID(i);

                for (size_t stepIndex = 0; stepIndex < macro.Steps.size(); stepIndex++)
                {
                    ImGui::PushID(static_cast<int>(stepIndex));
                    if (IsEditingSavedMacroStep(
                            i, static_cast<int>(stepIndex)))
                    {
                        RenderSavedCommandEditor(CW);
                    }
                    else
                    {
                        ImGui::PushStyleColor(ImGuiCol_Text, kNiobiumText);
                        ImGui::TextWrapped("%s", macro.Steps[stepIndex].Command.c_str());
                        ImGui::PopStyleColor();

                        if (ImGui::IsItemHovered())
                        {
                            ImGui::SetMouseCursor(
                                ImGuiMouseCursor_TextInput);
                            if (ImGui::IsMouseDoubleClicked(
                                    ImGuiMouseButton_Left))
                            {
                                BeginSavedMacroStepEdit(
                                    i,
                                    static_cast<int>(stepIndex));
                            }
                        }
                    }
                    ImGui::PopID();

                    if (stepIndex + 1 < macro.Steps.size())
                    {
                        ImGui::PushID(
                            static_cast<int>(stepIndex));
                        if (IsEditingSavedMacroDelay(
                                i,
                                static_cast<int>(stepIndex)))
                        {
                            RenderSavedCommandEditor(CW);
                        }
                        else
                        {
                            ImGui::PushStyleColor(
                                ImGuiCol_Text,
                                kNiobiumMutedText);
                            ImGui::Text(
                                "    Wait %d ms",
                                macro.Steps[stepIndex].DelayMs);
                            ImGui::PopStyleColor();

                            if (ImGui::IsItemHovered())
                            {
                                ImGui::SetMouseCursor(
                                    ImGuiMouseCursor_TextInput);
                                if (ImGui::IsMouseDoubleClicked(
                                        ImGuiMouseButton_Left))
                                {
                                    BeginSavedMacroDelayEdit(
                                        i,
                                        static_cast<int>(stepIndex));
                                }
                            }
                        }
                        ImGui::PopID();
                    }
                }

                ImGui::PushStyleColor(ImGuiCol_Text, kNiobiumMutedText);
                ImGui::Text("Key: %s", BindName(macro.VK));
                ImGui::PopStyleColor();

                const float MacroButtonW = RowButtonW;
                if (ImGui::Button(runLabel, ImVec2(MacroButtonW, 0.f)))
                {
                    FinishSavedCommandEdit(false);
                    QueueMacro(macro);
                }
                HoverHint("Sends all steps one after another.");
                ImGui::SameLine();

                const bool waitingForMacroKey = FGUI::RebindingMacroIndex == i;
                const bool macroHasKey = macro.VK > 0 && macro.VK <= 254;
                const char* macroBindLabel = waitingForMacroKey ? waitKeyLabel
                    : macroHasKey ? unbindLabel
                    : bindLabelText;

                if (ImGui::Button(macroBindLabel, ImVec2(MacroButtonW, 0.f)))
                {
                    FinishSavedCommandEdit(false);
                    if (FGUI::RebindingMacroIndex == i)
                    {
                        FGUI::RebindingMacroIndex = -2;
                        EndBindCapture();
                    }
                    else if (macro.VK > 0 && macro.VK <= 254)
                    {
                        macro.VK = 0;
                        FGUI::RebindingMacroIndex = -2;
                        FGUI::SaveMacros();
                    }
                    else
                    {
                        FGUI::RebindingMacroIndex = i;
                        FGUI::RebindingCommandIndex = -2;
                        FGUI::bRebinding = false;
                        FGUI::bRebindingJoin = false;
                        FGUI::bRebindingResetBuilds = false;
                        BeginBindCapture();
                    }
                }
                HoverHint(waitingForMacroKey ? waitKeyHint : macroHasKey ? unbindHint : bindHint);
                ImGui::SameLine();

                if (ImGui::Button(deleteLabel, ImVec2(MacroButtonW, 0.f)))
                {
                    if ((g_SavedCommandEdit.Target ==
                            ESavedCommandEditTarget::MacroStep ||
                         g_SavedCommandEdit.Target ==
                            ESavedCommandEditTarget::MacroDelay) &&
                        g_SavedCommandEdit.MacroIndex == i)
                    {
                        CancelSavedCommandEdit();
                    }
                    else
                    {
                        FinishSavedCommandEdit(false);
                    }
                    FGUI::Macros.erase(FGUI::Macros.begin() + i);
                    FGUI::RebindingMacroIndex = -2;
                    FGUI::SaveMacros();
                    ImGui::PopID();
                    break;
                }
                HoverHint(deleteHint);

                ImGui::Separator();
                ImGui::PopID();
            }
            ImGui::PopID();
        }
        EndSectionBody();

        ImGui::Dummy(ImVec2(0.f, 8.f)); // [Rift] a little space at the bottom
        break;
    }
    case TabOptions: // Config ([Rift] "Options": plain English texts with hints)
    {
    // [Rift] Read-only Bubble Builds status first: it is the setting people look up most.
    SectionLabel("Build look");
    BeginSectionBody();
    DrawBubbleBuildsStatus(CW);
    EndSectionBody();

    SectionLabel("General");
    BeginSectionBody();
    int consoleMode =
        FConfiguration::ConsoleMode.load(std::memory_order_acquire);
    const char* consoleModeItems[] = {
        "Rift console", "Original console (Unreal)"
    };
    if (LabeledCombo(
            "Which console?", "##console_mode", &consoleMode,
            consoleModeItems, IM_ARRAYSIZE(consoleModeItems),
            CW))
    {
        consoleMode = HotkeyPersist::SanitizeConsoleMode(consoleMode);
        FConfiguration::ConsoleMode.store(
            consoleMode, std::memory_order_release);
        HotkeyPersist::SaveConsoleMode(consoleMode);
        AtlasDiagnostics::WriteLine("console-mode changed=%s",
            consoleMode == static_cast<int>(EConsoleMode::Unreal)
                ? "original-unreal"
                : "atlas");

        if (consoleMode == static_cast<int>(EConsoleMode::Unreal))
            CloseConsoleSurface();
    }
    ControlHint("Open the console with F8. The Rift console knows shortcuts like /god.", CW);

    {
        // The key has a different name on different keyboards (German usually "#", US "/"),
        // so ask the system for its name.
        char slashLabel[96];
        snprintf(slashLabel, sizeof(slashLabel),
            "Open the console with the %s key###slash_key", VKName(VK_OEM_2));
        PersistentCheckbox(
            slashLabel, FConfiguration::bSlashKeyEnabled);
        ControlHint("It opens with / already typed " NB_DASH " then just type god and press Enter. Only with the Rift console.", CW, true);
    }
    TogglePreferencePersistenceCheckbox();
    ControlHint("Off = every toggle is back to normal the next time you start the game.", CW, true);
    EndSectionBody();

    // [Rift] Reset builds (QuickReset.h): aim at an edited build, press your own key, it goes
    // back to normal without edit mode. The game thread does the work; this only shows state.
    SectionLabel("Reset builds");
    BeginSectionBody();
    if (NiobiumQuickReset::EpicOwnsResetBuilding(VersionInfo.FortniteVersion))
    {
        StatusDotRow("This Fortnite version has its own Reset Building key. "
            "Set it in Fortnite: Settings > Keyboard Controls.",
            kNiobiumMutedText, false, CW);
    }
    else
    {
        PersistentCheckbox("Reset builds###reset_builds", FConfiguration::bResetBuilds);
        ControlHint("Aim at one of your edited builds and press your Reset builds key. It goes "
            "back to normal without opening edit mode. Editing and resetting the normal way "
            "still works.", CW, true);

        const int resetKey = HotkeyPersist::SanitizeResetBuildsKey(
            FConfiguration::ResetBuildsVK.load(std::memory_order_acquire));
        if (FGUI::bRebindingResetBuilds)
        {
            char waitLabel[96];
            snprintf(waitLabel, sizeof(waitLabel), "%s###rebind_reset_builds",
                FitLabel("Press the new key... (Esc = cancel)", "Press the new key...", CW));
            ImGui::PushStyleColor(ImGuiCol_Text, AccentText());
            ImGui::PushStyleColor(ImGuiCol_Button, Accent(0.18f));
            ImGui::Button(waitLabel, ImVec2(CW, 0.f));
            ImGui::PopStyleColor(2);
        }
        else
        {
            char resetKeyLabel[96];
            snprintf(resetKeyLabel, sizeof(resetKeyLabel),
                "Reset builds key [%s]###rebind_reset_builds", BindName(resetKey));
            if (ImGui::Button(resetKeyLabel, ImVec2(CW, 0.f)))
            {
                FGUI::bRebindingResetBuilds = true;
                FGUI::bRebinding = false;
                FGUI::bRebindingJoin = false;
                FGUI::RebindingCommandIndex = -2;
                FGUI::RebindingMacroIndex = -2;
                BeginBindCapture();
            }
            HoverHint("Not the left or right mouse button: they shoot and aim.");
        }
        DrawBindError(CW, 1);
        ControlHint("Tip: use the same key you use for Reset in Fortnite. Fortnite still gets the "
            "key, so pick one that does nothing else outside edit mode.", CW);

        if (FConfiguration::bResetBuilds.load(std::memory_order_acquire))
        {
            using NiobiumQuickReset::EStatus;
            const auto gameStatus = static_cast<EStatus>(
                NiobiumQuickReset::Status.load(std::memory_order_acquire));
            const char* statusText = "Join a match to use it.";
            ImVec4 statusColour = kNiobiumMutedText;
            bool statusFilled = false;
            if (resetKey == 0)
            {
                statusText = "Pick a key first.";
                statusColour = kNiobiumWarning;
            }
            else if (IsSavedActionHotkey(resetKey))
            {
                statusText = "That key is also used by one of your commands. Pick another key.";
                statusColour = kNiobiumWarning;
            }
            else if (IsReservedOverlayKey(resetKey, -1))
            {
                statusText = "That key is also your menu, join or console key. Pick another key.";
                statusColour = kNiobiumWarning;
            }
            else if (gameStatus == EStatus::Checking)
            {
                statusText = "Checking the server...";
            }
            else if (gameStatus == EStatus::Unsupported)
            {
                statusText = "This server can't do it. It needs a Rift server.";
                statusColour = kNiobiumWarning;
            }
            else if (gameStatus == EStatus::NotOnVersion)
            {
                statusText = "Not available on this version.";
                statusColour = kNiobiumWarning;
            }
            else if (gameStatus == EStatus::Ready && NiobiumQuickReset::IsGameConsoleOpen())
            {
                // Keys typed into Fortnite's own ("original") console don't count (QuickReset.h).
                statusText = "Close the original console first (Esc).";
            }
            else if (gameStatus == EStatus::Ready)
            {
                statusText = "Ready.";
                statusColour = kNiobiumSuccess;
                statusFilled = true;
            }
            StatusDotRow(statusText, statusColour, statusFilled, CW);
        }
    }
    EndSectionBody();

    SectionLabel("Keys");
    BeginSectionBody();
    // While waiting for the new key, the button keeps its id (###rebind_menu/_join).
    const char* waitForKeyText = FitLabel(
        "Press the new key... (Esc = cancel)",
        "Press the new key...", CW);
    char waitForKeyLabel[96];
    if (FGUI::bRebinding)
    {
        snprintf(waitForKeyLabel, sizeof(waitForKeyLabel), "%s###rebind_menu", waitForKeyText);
        ImGui::PushStyleColor(ImGuiCol_Text, AccentText());
        ImGui::PushStyleColor(ImGuiCol_Button, Accent(0.18f));
        ImGui::Button(waitForKeyLabel, ImVec2(CW, 0.f));
        ImGui::PopStyleColor(2);
    }
    else
    {
        char btnLabel[96];
        snprintf(btnLabel, sizeof(btnLabel), "Change menu key [%s]###rebind_menu", VKName(FGUI::HotkeyVK));
        if (ImGui::Button(btnLabel, ImVec2(CW, 0.f)))
        {
            FGUI::bRebinding = true;
            FGUI::bRebindingJoin = false;
            FGUI::bRebindingResetBuilds = false;
            FGUI::RebindingCommandIndex = -2;
            FGUI::RebindingMacroIndex = -2;
            BeginBindCapture();
        }
        HoverHint("This key opens and closes this menu.");
    }

    if (FGUI::bRebindingJoin)
    {
        snprintf(waitForKeyLabel, sizeof(waitForKeyLabel), "%s###rebind_join", waitForKeyText);
        ImGui::PushStyleColor(ImGuiCol_Text, AccentText());
        ImGui::PushStyleColor(ImGuiCol_Button, Accent(0.18f));
        ImGui::Button(waitForKeyLabel, ImVec2(CW, 0.f));
        ImGui::PopStyleColor(2);
    }
    else
    {
        char joinBtnLabel[96];
        snprintf(joinBtnLabel, sizeof(joinBtnLabel), "Change join key [%s]###rebind_join", VKName(FGUI::JoinHotkeyVK));
        if (ImGui::Button(joinBtnLabel, ImVec2(CW, 0.f)))
        {
            FGUI::bRebindingJoin = true;
            FGUI::bRebinding = false;
            FGUI::bRebindingResetBuilds = false;
            FGUI::RebindingCommandIndex = -2;
            FGUI::RebindingMacroIndex = -2;
            BeginBindCapture();
        }
        HoverHint("This key joins the server picked in \"Main\" when the menu is closed.");
    }

    DrawBindError(CW); // [Rift] same message, now wrapped at the button width

    if (ImGui::Button("Reset everything###reset_all", ImVec2(CW, 0.f)))
    {
        EndBindCapture();
        FGUI::ResetAll();
        CloseConsoleSurface();
    }
    ControlHint("Careful: resets all toggles and keys and deletes your saved commands.", CW);
    EndSectionBody();

        ImGui::Dummy(ImVec2(0.f, 8.f));
        break;
    }
    case TabHost: // [Rift] Host: the match controls of the (hidden) server window
    {
        // The content lives in RiftHostTab.cpp; the helpers here are file-static and are passed
        // in as pointers. Only the player at the server PC gets the controls (the server decides).
        static const FRiftHostTabHost RiftHost = {
            &NiobiumTabExec,
            &RiftHostTabQuery,
            &SectionLabel,
            &BeginSectionBody,
            &EndSectionBody,
            &Accent,
            &Client::GetConsoleSessionGeneration
        };
        RiftHostTab_Draw(RiftHost, CW);
        ImGui::Dummy(ImVec2(0.f, 8.f));
        break;
    }
    case TabTrickshot: // [Rift] Trickshot
    {
        // The content lives in NiobiumTrickshotTab.cpp; the helpers here are file-static and
        // are passed in as pointers.
        static const FNiobiumTabHost NiobiumHost = {
            &NiobiumTabExec,
            &SectionLabel,
            &BeginSectionBody,
            &EndSectionBody,
            &Accent,
            &Client::GetConsoleSessionGeneration
        };
        NiobiumTrickshotTab_Draw(NiobiumHost, CW);
        ImGui::Dummy(ImVec2(0.f, 8.f));
        break;
    }
    case TabCredits: // Credits
    {
        // [Rift] The credits themselves stay unchanged (license). Descriptions and the note
        // wrap so they are fully readable even in the smallest window.
        const float creditsWrapX =
            ImGui::GetCursorPosX() + CW + SectionBodyIndent;
        const auto rule = []()
        {
            ImDrawList* drawList = ImGui::GetWindowDrawList();
            const ImVec2 position = ImGui::GetCursorScreenPos();
            const float width = ImGui::GetContentRegionAvail().x;
            drawList->AddLine(
                ImVec2(position.x, position.y + 1.f),
                ImVec2(position.x + width, position.y + 1.f),
                ImGui::GetColorU32(Accent(0.40f)), 1.f);
            ImGui::Dummy(ImVec2(0.f, 9.f));
        };

        if (FGUI::LogoTexture != ImTextureID_Invalid)
        {
            ImGui::Image(FGUI::LogoTexture, ImVec2(44.f, 44.f));
            ImGui::SameLine(0.f, 12.f);
        }

        ImGui::BeginGroup();
        ImGui::PushStyleColor(ImGuiCol_Text, AccentText());
        ImGui::TextUnformatted("Rift");
        ImGui::PopStyleColor();
        ImGui::PushStyleColor(
            ImGuiCol_Text, ImVec4(0.54f, 0.56f, 0.62f, 1.f));
        {
            // [Rift] "In-game menu - version", wrapped instead of cut off at the edge
            char subtitle[160];
            snprintf(subtitle, sizeof(subtitle), "In-game menu  " NB_DASH "  %s", FConfiguration::ConsoleVersion);
            ImGui::PushTextWrapPos(creditsWrapX);
            ImGui::TextUnformatted(subtitle);
            ImGui::PopTextWrapPos();
        }
        ImGui::PopStyleColor();
        ImGui::EndGroup();

        ImGui::Dummy(ImVec2(0.f, 14.f));
        ImGui::PushStyleColor(ImGuiCol_Text, AccentText(0.85f));
        ImGui::TextUnformatted("CREDITS");
        ImGui::PopStyleColor();
        rule();

        // [Rift] short explanation for the page
        ControlHint("Rift is built on these projects. Thank you! Click a name to open its page in your browser.",
            creditsWrapX - ImGui::GetCursorPosX());
        ImGui::Spacing();

        ImGui::PushStyleColor(ImGuiCol_Text, AccentText(0.95f));
        ImGui::TextUnformatted("Erbium");
        ImGui::PopStyleColor();
        if (ImGui::IsItemHovered())
            ImGui::SetMouseCursor(ImGuiMouseCursor_Hand);
        if (ImGui::IsItemClicked())
        {
            ShellExecuteA(
                nullptr, "open",
                "https://github.com/plooshi/Erbium",
                nullptr, nullptr, SW_SHOWNORMAL);
        }
        ImGui::SameLine(0.f, 8.f);
        ImGui::PushStyleColor(
            ImGuiCol_Text, ImVec4(0.58f, 0.60f, 0.66f, 1.f));
        ImGui::PushTextWrapPos(creditsWrapX); // [Rift] wrap instead of cutting off
        ImGui::TextUnformatted("- Base of the project");
        ImGui::PopTextWrapPos();
        ImGui::PopStyleColor();

        // [Rift] Visible credit as required by the ATLAS Console Attribution License.
        ImGui::PushStyleColor(ImGuiCol_Text, AccentText(0.95f));
        ImGui::TextUnformatted("ATLAS Console");
        ImGui::PopStyleColor();
        if (ImGui::IsItemHovered())
            ImGui::SetMouseCursor(ImGuiMouseCursor_Hand);
        if (ImGui::IsItemClicked())
        {
            ShellExecuteA(
                nullptr, "open",
                "https://github.com/Ralzify/ATLAS-Client",
                nullptr, nullptr, SW_SHOWNORMAL);
        }
        ImGui::SameLine(0.f, 8.f);
        ImGui::PushStyleColor(
            ImGuiCol_Text, ImVec4(0.58f, 0.60f, 0.66f, 1.f));
        ImGui::PushTextWrapPos(creditsWrapX); // [Rift] wrap instead of cutting off
        ImGui::TextUnformatted("- Base of this in-game menu (cipherfps, ralz and contributors)");
        ImGui::PopTextWrapPos();
        ImGui::PopStyleColor();

        ImGui::Dummy(ImVec2(0.f, 18.f));
        ImGui::PushStyleColor(
            ImGuiCol_Text, ImVec4(0.42f, 0.44f, 0.50f, 1.f));
        ImGui::PushTextWrapPos(creditsWrapX); // [Rift] wrap instead of cutting off
        ImGui::TextUnformatted("Rift is based on ATLAS Console by cipherfps, ralz and contributors.");
        ImGui::PopTextWrapPos();
        ImGui::PopStyleColor();

        break;
    }
    }

    ImGui::EndChild();
    ImGui::PopStyleVar(3);
    ImGui::PopStyleColor();
    ImGui::End();

    ImGui::PopStyleVar();

    if (!open)
        CloseMenuSurface();
}
