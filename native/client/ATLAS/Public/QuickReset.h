// [Rift] "Reset builds" (F9 > Options): aim at one of your edited builds, press your own key,
// and the piece goes back to its unedited form without opening edit mode. Rift code, GPL-3.0.
//
// Client half only. The Rift server does the actual reset; this side picks the target from
// the game's own TargetedBuilding on the game thread and sends two RPCs back to back:
//   1. ServerCheat("nbedit:v1:r:<session16>:<seq8>")            (the "arm" message)
//   2. ServerEditBuildingActor(Target, Target->Class, 0, false)  (the server gets the exact actor)
// A server that doesn't know the arm rejects that Edit (nobody started an edit on the piece), and
// we only send after this server acknowledged our hello for this world and controller anyway.
//
// Wire format (plain ASCII, fixed width, lowercase hex, never a "cheat ..." console command):
//   hello  client -> server  ServerCheat     "nbedit:v1:h:<session16>"          28 characters
//   ack    server -> client  ClientMessage   "nbedit:v1:a:<session16>"          28 characters
//   arm    client -> server  ServerCheat     "nbedit:v1:r:<session16>:<seq8>"   37 characters
//
// Rules: WndProc only stamps an atomic (OnKeyDown). Everything that touches the game runs in the
// game-thread pump (QuickReset.cpp), never on Present, WndProc or the worker-thread fallback. The
// key is never swallowed and never goes through the command/macro bind system, so Fortnite still
// gets it (the normal Edit -> Reset path keeps working). Never the left or right mouse button.
// Off from Fortnite 37.00 on, where Epic has its own "Reset Building" key.
//
// Plain atomics and pure helpers only (standard library), so the menu (and its preview tool) and a
// small Linux test can use this header without the game SDK.
#pragma once

#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace SDK
{
    class UWorld;
}
class AFortPlayerControllerAthena;

namespace NiobiumQuickReset
{
    // Epic's own "Reset Building" key exists from Chapter 6 Season 4 (37.00, hundredths).
    static constexpr long long kEpicResetBuildingSince = 3700;

    inline bool EpicOwnsResetBuilding(double fortniteVersion)
    {
        if (!(fortniteVersion > 0.0) || fortniteVersion > 1000.0)
            return false;
        return std::llround(fortniteVersion * 100.0) >= kEpicResetBuildingSince;
    }

    // Left mouse shoots and right mouse aims (and is Fortnite's default "Reset Building Edit"
    // key): neither can ever be the Reset builds key.
    static constexpr int kVkLeftButton = 0x01;  // VK_LBUTTON
    static constexpr int kVkRightButton = 0x02; // VK_RBUTTON

    inline bool IsMouseShootOrAimButton(int vk)
    {
        return vk == kVkLeftButton || vk == kVkRightButton;
    }

    // A key the feature may use at all (range and mouse rule; the menu checks the other binds).
    inline bool IsUsableKey(int vk)
    {
        return vk > 0 && vk <= 0xFE && !IsMouseShootOrAimButton(vk);
    }

    // ---- Wire format -----------------------------------------------------------------------
    static constexpr char kPrefix[] = "nbedit:v1:";
    static constexpr size_t kPrefixLength = 10;
    static constexpr size_t kSessionDigits = 16;
    static constexpr size_t kSequenceDigits = 8;
    static constexpr size_t kHelloLength = kPrefixLength + 2 + kSessionDigits;                       // 28
    static constexpr size_t kAckLength = kHelloLength;                                               // 28
    static constexpr size_t kArmLength = kPrefixLength + 2 + kSessionDigits + 1 + kSequenceDigits;   // 37
    static_assert(sizeof(kPrefix) - 1 == kPrefixLength, "prefix length");
    static_assert(kHelloLength == 28 && kArmLength == 37, "wire lengths");

    inline void AppendLowerHex(char*& write, uint64_t value, size_t digits)
    {
        static constexpr char hex[] = "0123456789abcdef";
        for (size_t index = 0; index < digits; ++index)
        {
            const size_t shift = (digits - index - 1) * 4;
            *write++ = hex[(value >> shift) & 0xF];
        }
    }

    // out must hold kHelloLength + 1 characters. Returns the length (0 on a bad session).
    inline size_t FormatHello(uint64_t session, char* out)
    {
        if (!out || session == 0)
            return 0;
        char* write = out;
        for (size_t i = 0; i < kPrefixLength; ++i)
            *write++ = kPrefix[i];
        *write++ = 'h';
        *write++ = ':';
        AppendLowerHex(write, session, kSessionDigits);
        *write = '\0';
        return static_cast<size_t>(write - out);
    }

    // out must hold kArmLength + 1 characters. Returns the length (0 on a bad session).
    inline size_t FormatArm(uint64_t session, uint32_t sequence, char* out)
    {
        if (!out || session == 0)
            return 0;
        char* write = out;
        for (size_t i = 0; i < kPrefixLength; ++i)
            *write++ = kPrefix[i];
        *write++ = 'r';
        *write++ = ':';
        AppendLowerHex(write, session, kSessionDigits);
        *write++ = ':';
        AppendLowerHex(write, sequence, kSequenceDigits);
        *write = '\0';
        return static_cast<size_t>(write - out);
    }

    // Exact ack: "nbedit:v1:a:" + 16 lowercase hex digits, nothing else (the ClientMessage text
    // may come with its terminating zero already removed). session = 0 when it isn't one.
    template <typename TChar>
    inline bool TryParseAck(const TChar* text, size_t length, uint64_t* session)
    {
        if (session)
            *session = 0;
        if (!text || length != kAckLength)
            return false;
        for (size_t i = 0; i < kPrefixLength; ++i)
        {
            if (text[i] != static_cast<TChar>(kPrefix[i]))
                return false;
        }
        if (text[kPrefixLength] != static_cast<TChar>('a') ||
            text[kPrefixLength + 1] != static_cast<TChar>(':'))
        {
            return false;
        }
        uint64_t value = 0;
        for (size_t i = 0; i < kSessionDigits; ++i)
        {
            const TChar c = text[kPrefixLength + 2 + i];
            int digit = -1;
            if (c >= static_cast<TChar>('0') && c <= static_cast<TChar>('9'))
                digit = static_cast<int>(c - static_cast<TChar>('0'));
            else if (c >= static_cast<TChar>('a') && c <= static_cast<TChar>('f'))
                digit = 10 + static_cast<int>(c - static_cast<TChar>('a'));
            if (digit < 0)
                return false;
            value = (value << 4) | static_cast<uint64_t>(digit);
        }
        if (value == 0)
            return false;
        if (session)
            *session = value;
        return true;
    }

    // ---- Edit-mode window --------------------------------------------------------------------
    // A press only counts when edit mode wasn't seen shortly before it: then the game's own
    // Reset (and our Reset on release) handle the key. The window grows on slow frames so one
    // missed sample can't make a press inside edit mode look like one outside it.
    static constexpr unsigned long long kEditModeGraceMs = 50;
    static constexpr unsigned long long kMaxEditModeGraceMs = 250;

    inline unsigned long long EditModeGraceMs(unsigned long long frameIntervalMs)
    {
        unsigned long long grace = frameIntervalMs * 3;
        if (grace < kEditModeGraceMs)
            grace = kEditModeGraceMs;
        if (grace > kMaxEditModeGraceMs)
            grace = kMaxEditModeGraceMs;
        return grace;
    }

    // lastEditModeSeenAt = 0: never seen.
    inline bool PressIsOutsideEditMode(
        unsigned long long pressedAt, unsigned long long lastEditModeSeenAt,
        unsigned long long frameIntervalMs)
    {
        if (lastEditModeSeenAt == 0)
            return true;
        const unsigned long long grace = EditModeGraceMs(frameIntervalMs);
        return pressedAt > grace && lastEditModeSeenAt < pressedAt - grace;
    }

    // Client side: at least this long between two resets (the server allows one per 80 ms).
    static constexpr unsigned long long kMinSendIntervalMs = 100;

    // ---- World / controller identity ---------------------------------------------------------
    // Pointer and object index, plus the serial number once Unreal has assigned one. Unreal only
    // assigns it the first time something takes a weak pointer to the object, so a serial that
    // goes from 0 to N on the same pointer and index is still the same object (and the session
    // and its ack stay). Any other change is a new object.
    struct FObjectKey
    {
        std::uintptr_t Pointer = 0;
        std::int32_t Index = -1;
        std::uint32_t Serial = 0;
    };

    // Updates stored.Serial on a 0 -> N change. False for a different (or no) object.
    inline bool IsSameObject(FObjectKey& stored, const FObjectKey& current)
    {
        if (current.Pointer == 0 || stored.Pointer != current.Pointer || stored.Index != current.Index)
            return false;
        if (stored.Serial == current.Serial)
            return true;
        if (stored.Serial == 0)
        {
            stored.Serial = current.Serial;
            return true;
        }
        return false;
    }

    // ---- Fortnite's own console --------------------------------------------------------------
    // With F9 > Options > "Which console?" set to Fortnite's, typing in Unreal's console still
    // passes WndProc, so the Reset builds key must not count while that console is open. Unreal
    // doesn't expose its console state, so it is followed from the keys that reach the game:
    //   console key: closed -> one line -> full console -> closed
    //   Enter: closes the one-line console; the full console only when its line is empty
    //   Esc: clears a typed line first, closes an empty console
    // "Typed" means a character key, Up/Down (history), Tab or Ctrl+V since the last Enter/Esc.
    // Backspace keeps it, so when unsure the console counts as open a bit too long, not too short.
    enum class EGameConsoleKey : int
    {
        Other = 0,
        ConsoleKey = 1,
        Escape = 2,
        Enter = 3,
        Text = 4
    };

    // Packed state: bits 0-1 = 0 closed, 1 one line, 2 full console; bit 2 = a line is typed.
    static constexpr int kGameConsoleModeMask = 0x3;
    static constexpr int kGameConsoleTextBit = 0x4;

    inline int NextGameConsoleState(int state, EGameConsoleKey key)
    {
        int mode = state & kGameConsoleModeMask;
        bool text = (state & kGameConsoleTextBit) != 0;
        switch (key)
        {
        case EGameConsoleKey::ConsoleKey:
            mode = mode == 0 ? 1 : mode == 1 ? 2 : 0; // Unreal may keep a typed line: text stays
            break;
        case EGameConsoleKey::Escape:
            if (mode != 0)
            {
                if (text)
                    text = false;
                else
                    mode = 0;
            }
            break;
        case EGameConsoleKey::Enter:
            if (mode == 1 || (mode == 2 && !text))
            {
                mode = 0;
                text = false;
            }
            else if (mode == 2)
            {
                text = false; // the typed line ran; the full console stays open
            }
            break;
        case EGameConsoleKey::Text:
            if (mode != 0)
                text = true;
            break;
        case EGameConsoleKey::Other:
        default:
            break;
        }
        return mode | (text ? kGameConsoleTextBit : 0);
    }

    // Written by WndProc only (keys that reach the game while the overlay is closed).
    inline std::atomic_int GameConsoleState{ 0 };

    inline bool IsGameConsoleOpen()
    {
        return (GameConsoleState.load(std::memory_order_acquire) & kGameConsoleModeMask) != 0;
    }

    inline void OnGameConsoleKey(EGameConsoleKey key)
    {
        if (key == EGameConsoleKey::Other)
            return;
        const int current = GameConsoleState.load(std::memory_order_acquire);
        GameConsoleState.store(NextGameConsoleState(current, key), std::memory_order_release);
    }

    // ---- Menu state --------------------------------------------------------------------------
    // What the game thread reports (the menu adds NoKey / Conflict / EpicOwns itself).
    enum class EStatus : int
    {
        Idle = 0,        // switch off or no key: nothing is sent
        NotInMatch = 1,  // "Join a match to use it."
        Checking = 2,    // hello sent, waiting for the server: "Checking the server..."
        Unsupported = 3, // no ack after every hello: "This server can't do it..."
        Ready = 4,       // acked: "Ready."
        NotOnVersion = 5 // the RPC layout isn't usable on this version, or something crashed:
                         // "Not available on <version>."
    };

    inline std::atomic_int Status{ static_cast<int>(EStatus::Idle) };

    // Stamped by WndProc (GetTickCount64 of the key-down), taken by the game-thread pump.
    inline std::atomic<unsigned long long> PendingPressAt{ 0 };

    // WndProc thread. blocked: the overlay/console (ours or Fortnite's) is open, a key is being
    // bound, or the key is owned by the menu (menu, join, console or a saved command key). Never
    // swallows the key.
    inline void OnKeyDown(int vk, int boundVk, bool enabled, bool blocked, unsigned long long now)
    {
        if (!enabled || blocked || vk != boundVk || !IsUsableKey(vk) || now == 0)
            return;
        PendingPressAt.store(now, std::memory_order_release);
    }

    // ---- Game side (QuickReset.cpp) ------------------------------------------------------------
    // Client.cpp's ClientMessage capture: true for an exact "nbedit:v1:a:" ack (always hidden from
    // the console; it only counts when it matches this world's session).
    bool HandleClientMessage(const wchar_t* text, int length) noexcept;

    // True while a hello is out and not acked yet. Client.cpp then reports a server command list
    // (an old Rift server answers an unknown command with its help text) through
    // NoteCommandListReply, and the hellos stop for this world: one help text, not five.
    bool IsWaitingForAck() noexcept;
    void NoteCommandListReply() noexcept;

    // Called every frame from the game-thread pump (GetMaxTickRate hook) with the controller the
    // client tick last saw. Returns at once on any other thread.
    void GameThreadPump(
        SDK::UWorld* world,
        AFortPlayerControllerAthena* controller,
        bool frontendActive,
        bool clientMessageHookReady,
        unsigned long gameThreadId) noexcept;
}
