// NIOBIUM: control pipe for the launcher - Rift's own code (GPL-3.0). See NiobiumControl.h.
#include "pch.h"
#include "../Public/NiobiumControl.h"
#include "../Public/Configuration.h"
#include "../Public/GUI.h"
#include "../Public/AutoHosting.h"
#include "../../json.hpp"
#include <Engine/Public/NetDriver.h>
#include <FortniteGame/Public/FortPlayerControllerAthena.h>
#include <Windows.h>
#include <algorithm>
#include <atomic>
#include <cctype>
#include <deque>
#include <mutex>
#include <string>

// In FortPlayerControllerAthena.cpp: is this the player at the host PC (connected through 127.0.0.1)?
bool Niobium_IsHostController(AFortPlayerControllerAthena* PlayerController);

namespace
{
    using json = nlohmann::json;

    constexpr wchar_t kPipeName[] = L"\\\\.\\pipe\\niobium-server";
    constexpr size_t kMaxPendingCommands = 256;
    constexpr ULONGLONG kStatusIntervalMs = 2000;

    std::mutex GQueueMutex;
    std::deque<json> GPending; // filled by the pipe thread, emptied on the game thread

    std::mutex GWriteMutex;
    HANDLE GPipe = INVALID_HANDLE_VALUE; // only touch while holding GWriteMutex
    std::atomic_bool GConnected{ false };
    std::atomic_bool GEverConnected{ false }; // a launcher connected at least once since the start
    std::atomic_bool GStarted{ false };
    std::atomic_bool GReadySent{ false };
    ULONGLONG GLastStatusMs = 0;

    // Holds the playlist path FConfiguration::Playlist points to (it only stores a pointer).
    std::wstring GPlaylistStorage;

    // ---------------------------------------------------------------- Text helpers

    std::wstring Widen(const std::string& Utf8)
    {
        if (Utf8.empty())
            return L"";
        const int Needed = MultiByteToWideChar(CP_UTF8, 0, Utf8.data(), (int)Utf8.size(), nullptr, 0);
        std::wstring Out(Needed > 0 ? Needed : 0, L'\0');
        if (Needed > 0)
            MultiByteToWideChar(CP_UTF8, 0, Utf8.data(), (int)Utf8.size(), Out.data(), Needed);
        return Out;
    }

    std::string Narrow(const wchar_t* Wide)
    {
        if (!Wide || !*Wide)
            return "";
        const int Len = (int)wcslen(Wide);
        const int Needed = WideCharToMultiByte(CP_UTF8, 0, Wide, Len, nullptr, 0, nullptr, nullptr);
        std::string Out(Needed > 0 ? Needed : 0, '\0');
        if (Needed > 0)
            WideCharToMultiByte(CP_UTF8, 0, Wide, Len, Out.data(), Needed, nullptr, nullptr);
        return Out;
    }

    std::string ToLower(std::string Text)
    {
        std::transform(Text.begin(), Text.end(), Text.begin(),
            [](unsigned char c) { return (char)std::tolower(c); });
        return Text;
    }

    // ---------------------------------------------------------------- Sending

    void WriteLine(const std::string& Line)
    {
        std::lock_guard<std::mutex> Lock(GWriteMutex);
        if (GPipe == INVALID_HANDLE_VALUE)
            return;
        const std::string Data = Line + "\n";
        DWORD Written = 0;
        if (!WriteFile(GPipe, Data.data(), (DWORD)Data.size(), &Written, nullptr))
            SDK::DbgLog("[Rift] Pipe write failed error=%lu\n", GetLastError());
    }

    void Reply(long long Id, bool bOk, const std::string& Message)
    {
        json Out;
        Out["event"] = "reply";
        Out["id"] = Id;
        Out["ok"] = bOk;
        Out["message"] = Message;
        WriteLine(Out.dump());
    }

    // ---------------------------------------------------------------- Game access (game thread only)

    UNetDriver* GetDriver()
    {
        auto World = UWorld::GetWorld();
        return World ? static_cast<UNetDriver*>(World->NetDriver) : nullptr;
    }

    // Who launcher commands are for: the player at the host PC if connected,
    // otherwise the first connected player.
    AFortPlayerControllerAthena* FirstConnectedController()
    {
        auto Driver = GetDriver();
        if (!Driver)
            return nullptr;
        AFortPlayerControllerAthena* First = nullptr;
        for (auto Connection : Driver->ClientConnections)
        {
            if (!Connection || !Connection->PlayerController)
                continue;
            auto Controller = static_cast<AFortPlayerControllerAthena*>(Connection->PlayerController);
            if (Niobium_IsHostController(Controller))
                return Controller;
            if (!First)
                First = Controller;
        }
        return First;
    }

    int ConnectedPlayers()
    {
        auto Driver = GetDriver();
        if (!Driver)
            return 0;
        int Count = 0;
        for (auto Connection : Driver->ClientConnections)
        {
            if (Connection && Connection->PlayerController)
                ++Count;
        }
        return Count;
    }

    // No C++ objects in here, so __try is allowed.
    bool GuardedProcessEvent(UObject* Object, UFunction* Function, void* Params) noexcept
    {
        __try
        {
            Object->ProcessEvent(Function, Params);
            return true;
        }
        __except (EXCEPTION_EXECUTE_HANDLER)
        {
            return false;
        }
    }

    // Runs a cheat command as if the first connected player had typed it into the console
    // ("cheat ..."). So the same checks apply as in the game.
    bool RunCheat(const std::string& Text, std::string& Error)
    {
        auto Controller = FirstConnectedController();
        if (!Controller)
        {
            // Shown like this in the launcher: short and without technical words.
            Error = "Nobody is in the game yet. Join the match first, then try again.";
            return false;
        }
        auto Function = Controller->GetFunction("ServerCheat");
        if (!Function)
        {
            Error = "This game version doesn't accept commands.";
            return false;
        }

        // Build it right in the parameter block (no copy): FString frees its memory in the destructor,
        // assigning from a temporary would free the buffer too early.
        const std::wstring Wide = Widen(Text);
        struct FParams
        {
            FString Msg;
        } Params{ FString(Wide.c_str()) };

        if (!GuardedProcessEvent(Controller, Function, &Params))
        {
            Error = "The command caused an error in the game.";
            return false;
        }
        return true;
    }

    // ---------------------------------------------------------------- Playlists

    struct FPlaylistEntry
    {
        const char* Key;
        const wchar_t* Path;
        Playlist Value;
        double MinVersion; // first Fortnite version that has the playlist (like the buttons in the server window)
    };

    constexpr FPlaylistEntry kPlaylists[] = {
        { "solo", L"/Game/Athena/Playlists/Playlist_DefaultSolo.Playlist_DefaultSolo", Playlist::Solos, 0.00 },
        { "duo", L"/Game/Athena/Playlists/Playlist_DefaultDuo.Playlist_DefaultDuo", Playlist::Duos, 0.00 },
        { "trio", L"/Game/Athena/Playlists/Trios/Playlist_Trios.Playlist_Trios", Playlist::Trios, 7.40 },
        { "squad", L"/Game/Athena/Playlists/Playlist_DefaultSquad.Playlist_DefaultSquad", Playlist::Squads, 0.00 },
        { "arena_solo", L"/Game/Athena/Playlists/Showdown/Playlist_ShowdownAlt_Solo.Playlist_ShowdownAlt_Solo", Playlist::ArenaSolos, 8.20 },
        { "arena_duo", L"/Game/Athena/Playlists/Showdown/Playlist_ShowdownAlt_Duos.Playlist_ShowdownAlt_Duos", Playlist::ArenaDuos, 8.20 },
        { "arena_trio", L"/Game/Athena/Playlists/Showdown/Playlist_ShowdownAlt_Trios.Playlist_ShowdownAlt_Trios", Playlist::ArenaTrios, 8.20 },
        { "arena_squad", L"/Game/Athena/Playlists/Showdown/Playlist_ShowdownAlt_Squads.Playlist_ShowdownAlt_Squads", Playlist::ArenaSquads, 8.20 },
        { "tournament_solo", L"/Game/Athena/Playlists/Showdown/Playlist_Showdown_Solo.Playlist_Showdown_Solo", Playlist::TournamentSolos, 6.10 },
        { "tournament_duo", L"/Game/Athena/Playlists/Showdown/Playlist_Showdown_Duos.Playlist_Showdown_Duos", Playlist::TournamentDuos, 6.10 },
        { "tournament_trio", L"/Game/Athena/Playlists/Showdown/Playlist_Showdown_Trios.Playlist_Showdown_Trios", Playlist::TournamentTrios, 6.10 },
        { "tournament_squad", L"/Game/Athena/Playlists/Showdown/Playlist_Showdown_Squads.Playlist_Showdown_Squads", Playlist::TournamentSquads, 6.10 },
        { "zb_solo", L"/Game/Athena/Playlists/NoBuildBR/Playlist_NoBuildBR_Solo.Playlist_NoBuildBR_Solo", Playlist::ZBSolos, 20.00 },
        { "zb_duo", L"/Game/Athena/Playlists/NoBuildBR/Playlist_NoBuildBR_Duo.Playlist_NoBuildBR_Duo", Playlist::ZBDuos, 20.00 },
        { "zb_trio", L"/Game/Athena/Playlists/NoBuildBR/Playlist_NoBuildBR_Trio.Playlist_NoBuildBR_Trio", Playlist::ZBTrios, 20.00 },
        { "zb_squad", L"/Game/Athena/Playlists/NoBuildBR/Playlist_NoBuildBR_Squad.Playlist_NoBuildBR_Squad", Playlist::ZBSquads, 20.00 },
        { "arena_zb_solo", L"/Game/Athena/Playlists/NoBuildBR/Competitive/Playlist_ShowdownAlt_NoBuildBR_Solo.Playlist_ShowdownAlt_NoBuildBR_Solo", Playlist::ArenaZBSolos, 20.00 },
        { "arena_zb_duo", L"/Game/Athena/Playlists/NoBuildBR/Competitive/Playlist_ShowdownAlt_NoBuildBR_Duos.Playlist_ShowdownAlt_NoBuildBR_Duos", Playlist::ArenaZBDuos, 20.00 },
        { "arena_zb_trio", L"/Game/Athena/Playlists/NoBuildBR/Competitive/Playlist_ShowdownAlt_NoBuildBR_Trios.Playlist_ShowdownAlt_NoBuildBR_Trios", Playlist::ArenaZBTrios, 20.00 },
        { "arena_zb_squad", L"/Game/Athena/Playlists/NoBuildBR/Competitive/Playlist_ShowdownAlt_NoBuildBR_Squads.Playlist_ShowdownAlt_NoBuildBR_Squads", Playlist::ArenaZBSquads, 20.00 },
        { "playground", L"/Game/Athena/Playlists/Playground/Playlist_Playground.Playlist_Playground", Playlist::Playground, 4.50 },
    };

    std::string ShortName(const wchar_t* Path)
    {
        const std::string Full = Narrow(Path);
        const auto Dot = Full.rfind('.');
        return Dot == std::string::npos ? Full : Full.substr(Dot + 1);
    }

    std::string KnownPlaylistKeys()
    {
        std::string Out;
        for (const auto& Entry : kPlaylists)
        {
            if (!Out.empty())
                Out += ", ";
            Out += Entry.Key;
        }
        return Out;
    }

    // Accepts short names (solo, arena_solo, ...), asset names (Playlist_ShowdownAlt_Solo) or full /Game/ paths.
    bool SetPlaylist(const std::string& Wanted, std::string& Error)
    {
        if (FConfiguration::bReadyToStart.load(std::memory_order_acquire))
        {
            Error = "The server is already running. You can only change the playlist before the start.";
            return false;
        }

        const std::string Lower = ToLower(Wanted);
        const FPlaylistEntry* Found = nullptr;
        for (const auto& Entry : kPlaylists)
        {
            if (Lower == Entry.Key || Lower == ToLower(ShortName(Entry.Path)) || Lower == ToLower(Narrow(Entry.Path)))
            {
                Found = &Entry;
                break;
            }
        }

        if (Found && VersionInfo.FortniteVersion + 0.001 < Found->MinVersion)
        {
            char Buffer[160];
            snprintf(Buffer, sizeof(Buffer), "Playlist \"%s\" needs version %.2f or newer (this build: %.2f).", Found->Key,
                Found->MinVersion, VersionInfo.FortniteVersion);
            Error = Buffer;
            return false;
        }

        if (Found)
            GPlaylistStorage = Found->Path;
        else if (Wanted.rfind("/Game/", 0) == 0 && Wanted.find('.') != std::string::npos)
            GPlaylistStorage = Widen(Wanted);
        else
        {
            Error = "Unknown playlist \"" + Wanted + "\". Known: " + KnownPlaylistKeys() + ", or a full /Game/ path.";
            return false;
        }

        FConfiguration::Playlist = GPlaylistStorage.c_str();
        const int Selected = Found ? (int)Found->Value : (int)Playlist::Custom;
        GUI::SelectedPlaylist = Selected;
        GUI::PublishSelectedPlaylist(Selected);
        SDK::DbgLog("[Rift] Playlist set: %ls\n", GPlaylistStorage.c_str());
        return true;
    }

    // ---------------------------------------------------------------- Settings

    bool SetBool(std::atomic_bool& Target, const json& Value, std::string& Error)
    {
        if (!Value.is_boolean())
        {
            Error = "Expected true or false.";
            return false;
        }
        Target.store(Value.get<bool>(), std::memory_order_release);
        return true;
    }

    bool SetInt(std::atomic_int& Target, const json& Value, int Min, int Max, std::string& Error)
    {
        if (!Value.is_number())
        {
            Error = "Expected a number.";
            return false;
        }
        const int Number = (int)Value.get<double>();
        if (Number < Min || Number > Max)
        {
            Error = "Value must be between " + std::to_string(Min) + " and " + std::to_string(Max) + ".";
            return false;
        }
        Target.store(Number, std::memory_order_release);
        return true;
    }

    bool SetFloat(std::atomic<float>& Target, const json& Value, float Min, float Max, std::string& Error)
    {
        if (!Value.is_number())
        {
            Error = "Expected a number.";
            return false;
        }
        const float Number = Value.get<float>();
        if (Number < Min || Number > Max)
        {
            Error = "Value is out of range.";
            return false;
        }
        Target.store(Number, std::memory_order_release);
        return true;
    }

    // Like SetInt, but out-of-range numbers are clamped instead of refused.
    bool SetClampedInt(std::atomic_int& Target, const json& Value, int Min, int Max, std::string& Error)
    {
        if (!Value.is_number())
        {
            Error = "Expected a number.";
            return false;
        }
        const double Number = Value.get<double>();
        if (!(Number == Number))
        {
            Error = "Expected a number.";
            return false;
        }
        const double Clamped = Number < Min ? Min : (Number > Max ? Max : Number);
        Target.store((int)Clamped, std::memory_order_release);
        return true;
    }

    // NIOBIUM: AI player bots (PlayerBots_19_10.cpp). The server decides at "Start match" whether
    // bots run, so these keys are only taken before that.
    bool ApplyBotConfig(const std::string& Key, const json& Value, std::string& Error)
    {
        if (FConfiguration::bReadyToStart.load(std::memory_order_acquire))
        {
            Error = "Bot settings take effect next match.";
            return false;
        }
        if (Key == "bPlayerBots")
            return SetBool(FConfiguration::bPlayerBots, Value, Error);
        if (Key == "PlayerBotCount")
            return SetClampedInt(FConfiguration::PlayerBotCount, Value, 1, 99, Error);
        return SetClampedInt(FConfiguration::PlayerBotTargetELO, Value, 0, 5000, Error);
    }

    // NIOBIUM: "Living world" (LivingWorld.cpp). Like the bot keys, only taken before the start.
    bool ApplyLivingWorldConfig(const std::string& Key, const json& Value, std::string& Error)
    {
        if (FConfiguration::bReadyToStart.load(std::memory_order_acquire))
        {
            Error = "Bosses & NPCs settings take effect next match.";
            return false;
        }
        if (Key == "bLivingWorld")
            return SetBool(FConfiguration::bLivingWorld, Value, Error);
        if (Key == "LivingWorldMaxAI")
            return SetClampedInt(FConfiguration::LivingWorldMaxAI, Value, 1, 100, Error);
        return SetBool(FConfiguration::bLivingWorldDump, Value, Error);
    }

    bool ApplyConfig(const std::string& Key, const json& Value, std::string& Error)
    {
        if (Key == "bPlayerBots" || Key == "PlayerBotCount" || Key == "PlayerBotTargetELO")
            return ApplyBotConfig(Key, Value, Error);
        if (Key == "bLivingWorld" || Key == "LivingWorldMaxAI" || Key == "bLivingWorldDump")
            return ApplyLivingWorldConfig(Key, Value, Error);

        if (Key == "playlist")
        {
            if (!Value.is_string())
            {
                Error = "Expected a playlist name.";
                return false;
            }
            return SetPlaylist(Value.get<std::string>(), Error);
        }
        if (Key == "bLateGame")
        {
            if (!Value.is_boolean())
            {
                Error = "Expected true or false.";
                return false;
            }
            FConfiguration::SetLateGameEnabled(Value.get<bool>());
            return true;
        }
        if (Key == "bEnableTrickshotTab")
        {
            if (!Value.is_boolean())
            {
                Error = "Expected true or false.";
                return false;
            }
            // Careful: false resets all trickshot switches (reload, ice, jump fatigue, auto god mode ...).
            FConfiguration::SetTrickshotTabEnabled(Value.get<bool>());
            return true;
        }
        // Trickshot detection (elimination in the air -> message to everyone), see NiobiumParkour.cpp.
        if (Key == "bTrickshotDetection") return SetBool(FConfiguration::bNiobiumTrickshotDetection, Value, Error);
        if (Key == "bAutoReloadOnWaypointTP") return SetBool(FConfiguration::bAutoReloadOnWaypointTP, Value, Error);
        if (Key == "bRemoveIceOnWaypointTP") return SetBool(FConfiguration::bRemoveIceOnWaypointTP, Value, Error);
        if (Key == "bDisableJumpFatigue") return SetBool(FConfiguration::bDisableJumpFatigue, Value, Error);
        if (Key == "AutoGodModeType") return SetInt(FConfiguration::AutoGodModeType, Value, 0, 1, Error);
        if (Key == "bPlayerMapIcons") return SetBool(FConfiguration::bPlayerMapIcons, Value, Error);
        if (Key == "bAutoBusStart")
        {
            if (!SetBool(FConfiguration::bAutoBusStart, Value, Error))
                return false;
            // Like the switch in the server window: your own choice wins over the playlist default.
            FConfiguration::bBusSettingsUserOverride.store(true, std::memory_order_release);
            return true;
        }

        if (Key == "LateGameZone") return SetInt(FConfiguration::LateGameZone, Value, 1, 12, Error);
        if (Key == "bLateGameLongZone") return SetBool(FConfiguration::bLateGameLongZone, Value, Error);
        if (Key == "bForceRespawns") return SetBool(FConfiguration::bForceRespawns, Value, Error);
        if (Key == "bKeepInventory") return SetBool(FConfiguration::bKeepInventory, Value, Error);
        if (Key == "bMidZoneRespawning") return SetBool(FConfiguration::bMidZoneRespawning, Value, Error);
        if (Key == "PermanentRespawn") return SetBool(FConfiguration::PermanentRespawn, Value, Error);
        if (Key == "RespawnTime") return SetInt(FConfiguration::RespawnTime, Value, 1, 60, Error);
        if (Key == "RespawnHeight") return SetInt(FConfiguration::RespawnHeight, Value, 1000, 50000, Error);
        if (Key == "bInfiniteAmmo") return SetBool(FConfiguration::bInfiniteAmmo, Value, Error);
        if (Key == "bInfiniteMats") return SetBool(FConfiguration::bInfiniteMats, Value, Error);
        if (Key == "bMovingBus") return SetBool(FConfiguration::bMovingBus, Value, Error);
        if (Key == "BusStartDelay") return SetFloat(FConfiguration::BusStartDelay, Value, 0.f, 600.f, Error);
        if (Key == "bSiphon") return SetBool(FConfiguration::bSiphon, Value, Error);
        if (Key == "SiphonAmount") return SetInt(FConfiguration::SiphonAmount, Value, 0, 200, Error);
        if (Key == "bHasPickaxe") return SetBool(FConfiguration::bHasPickaxe, Value, Error);
        if (Key == "BotHealth") return SetInt(FConfiguration::BotHealth, Value, 1, 1000, Error);
        if (Key == "BotShield") return SetInt(FConfiguration::BotShield, Value, 0, 1000, Error);
        if (Key == "UseCustomBotNames") return SetBool(FConfiguration::UseCustomBotNames, Value, Error);
        if (Key == "bAutoGodMode") return SetBool(FConfiguration::bAutoGodMode, Value, Error);
        if (Key == "bEnableCheats") return SetBool(FConfiguration::bEnableCheats, Value, Error);
        if (Key == "bGliderRedeploy") return SetBool(FConfiguration::bGliderRedeploy, Value, Error);
        if (Key == "bAutoStartEvent") return SetBool(FConfiguration::bAutoStartEvent, Value, Error);
        if (Key == "bJoinInProgress") return SetBool(FConfiguration::bJoinInProgress, Value, Error);
        // Shows or hides the (otherwise hidden) server window; GUI.cpp applies it on its own thread.
        if (Key == "bShowServerWindow") return SetBool(FConfiguration::bShowServerWindow, Value, Error);

        Error = "The server doesn't know the setting \"" + Key + "\".";
        return false;
    }

    // ---------------------------------------------------------------- Status

    const char* PhaseName(EGSStatus Status)
    {
        switch (Status)
        {
        case NotReady: return "notReady";
        case Ready: return "ready";
        case Joinable: return "joinable";
        case StartedMatch: return "started";
        case Ended: return "ended";
        }
        return "unknown";
    }

    json StatusJson()
    {
        json Out;
        Out["event"] = "status";
        Out["phase"] = PhaseName(GUI::gsStatus.load(std::memory_order_acquire));
        Out["ready"] = FConfiguration::bReadyToStart.load(std::memory_order_acquire);
        Out["players"] = ConnectedPlayers();
        Out["lategame"] = FConfiguration::bLateGame.load(std::memory_order_acquire);
        Out["playlist"] = Narrow(FConfiguration::Playlist);
        Out["port"] = FConfiguration::Port.load(std::memory_order_acquire);
        return Out;
    }

    // ---------------------------------------------------------------- Commands (game thread)

    void Handle(const json& Command)
    {
        const long long Id = Command.value("id", 0LL);
        const std::string Name = Command.value("cmd", std::string());
        std::string Error;

        if (Name == "exec")
        {
            std::string Text = Command.value("text", std::string());
            if (Text.rfind("cheat ", 0) == 0)
                Text = Text.substr(6);
            if (Text.empty())
            {
                Reply(Id, false, "Empty command.");
                return;
            }
            if (RunCheat(Text, Error))
                Reply(Id, true, "Done: " + Text);
            else
                Reply(Id, false, Error);
            return;
        }

        if (Name == "config")
        {
            const std::string Key = Command.value("key", std::string());
            const json Value = Command.contains("value") ? Command["value"] : json();
            if (ApplyConfig(Key, Value, Error))
                Reply(Id, true, "Saved: " + Key);
            else
                Reply(Id, false, Error);
            return;
        }

        if (Name == "startmatch")
        {
            if (FConfiguration::bReadyToStart.load(std::memory_order_acquire))
            {
                Reply(Id, false, "The server is already running.");
                return;
            }
            // Same steps as the START SERVER button in the server window.
            AutoHosting::CancelCountdown();
            AutoHosting::SaveNow(true);
            FConfiguration::bReadyToStart.store(true, std::memory_order_release);
            SDK::DbgLog("[Rift] Start requested by the launcher\n");
            Reply(Id, true, "Server is starting. Loading the map...");
            return;
        }

        if (Name == "status")
        {
            json Out = StatusJson();
            Out["id"] = Id;
            WriteLine(Out.dump());
            return;
        }

        Reply(Id, false, "Unknown command \"" + Name + "\".");
    }

    // ---------------------------------------------------------------- Pipe thread

    DWORD WINAPI PipeThread(LPVOID)
    {
        for (;;)
        {
            HANDLE Pipe = CreateNamedPipeW(kPipeName, PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 64 * 1024, 64 * 1024, 0, nullptr);
            if (Pipe == INVALID_HANDLE_VALUE)
            {
                SDK::DbgLog("[Rift] CreateNamedPipe failed error=%lu\n", GetLastError());
                Sleep(3000);
                continue;
            }

            const BOOL bConnected = ConnectNamedPipe(Pipe, nullptr) ? TRUE : (GetLastError() == ERROR_PIPE_CONNECTED);
            if (!bConnected)
            {
                CloseHandle(Pipe);
                Sleep(500);
                continue;
            }

            {
                std::lock_guard<std::mutex> Lock(GWriteMutex);
                GPipe = Pipe;
            }
            GConnected.store(true, std::memory_order_release);
            GEverConnected.store(true, std::memory_order_release);
            SDK::DbgLog("[Rift] Launcher connected to the control pipe\n");

            {
                json Hello;
                Hello["event"] = "hello";
                Hello["fortnite"] = VersionInfo.FortniteVersion;
                Hello["engine"] = VersionInfo.EngineVersion;
                WriteLine(Hello.dump());
            }

            std::string Buffer;
            char Chunk[4096];
            DWORD Read = 0;
            while (ReadFile(Pipe, Chunk, sizeof(Chunk), &Read, nullptr) && Read > 0)
            {
                Buffer.append(Chunk, Read);
                size_t NewLine;
                while ((NewLine = Buffer.find('\n')) != std::string::npos)
                {
                    std::string Line = Buffer.substr(0, NewLine);
                    Buffer.erase(0, NewLine + 1);
                    if (Line.empty() || Line == "\r")
                        continue;
                    json Parsed = json::parse(Line, nullptr, false);
                    if (Parsed.is_discarded() || !Parsed.is_object())
                        continue;
                    std::lock_guard<std::mutex> Lock(GQueueMutex);
                    if (GPending.size() < kMaxPendingCommands)
                        GPending.push_back(std::move(Parsed));
                }
                if (Buffer.size() > 1024 * 1024)
                    Buffer.clear(); // guard against endless lines
            }

            GConnected.store(false, std::memory_order_release);
            {
                std::lock_guard<std::mutex> Lock(GWriteMutex);
                GPipe = INVALID_HANDLE_VALUE;
            }
            FlushFileBuffers(Pipe);
            DisconnectNamedPipe(Pipe);
            CloseHandle(Pipe);
            GReadySent.store(false, std::memory_order_release);
            SDK::DbgLog("[Rift] Launcher disconnected - waiting for a new connection\n");
        }
    }
}

namespace NiobiumControl
{
    void Start()
    {
        if (GStarted.exchange(true))
            return;
        HANDLE Thread = CreateThread(nullptr, 0, PipeThread, nullptr, 0, nullptr);
        if (Thread)
            CloseHandle(Thread);
        else
            SDK::DbgLog("[Rift] Could not start the pipe thread\n");
    }

    bool HasLauncherConnected()
    {
        return GEverConnected.load(std::memory_order_acquire);
    }

    void GameThreadTick()
    {
        if (!GStarted.load(std::memory_order_acquire))
            return;

        std::deque<json> Batch;
        {
            std::lock_guard<std::mutex> Lock(GQueueMutex);
            Batch.swap(GPending);
        }
        for (const auto& Command : Batch)
            Handle(Command);

        if (!GConnected.load(std::memory_order_acquire))
            return;

        if (!GReadySent.load(std::memory_order_acquire) &&
            GUI::gsStatus.load(std::memory_order_acquire) >= Joinable)
        {
            GReadySent.store(true, std::memory_order_release);
            json Out;
            Out["event"] = "ready";
            Out["port"] = FConfiguration::Port.load(std::memory_order_acquire);
            WriteLine(Out.dump());
        }

        const ULONGLONG Now = GetTickCount64();
        if (Now - GLastStatusMs >= kStatusIntervalMs)
        {
            GLastStatusMs = Now;
            WriteLine(StatusJson().dump());
        }
    }

    void Emit(const char* Event)
    {
        if (!GConnected.load(std::memory_order_acquire))
            return;
        json Out;
        Out["event"] = Event ? Event : "";
        WriteLine(Out.dump());
    }

    void EmitMatchEnd()
    {
        Emit("matchEnd");
    }

    void EmitTrickshot(const std::string& Player, const std::string& Victim, int Meters)
    {
        if (!GConnected.load(std::memory_order_acquire))
            return;
        try
        {
            json Out;
            Out["event"] = "trickshot";
            Out["player"] = Player;
            Out["victim"] = Victim;
            Out["meters"] = Meters;
            // Names come from the game: replace broken UTF-8 instead of throwing.
            WriteLine(Out.dump(-1, ' ', false, json::error_handler_t::replace));
        }
        catch (...)
        {
            SDK::DbgLog("[Rift] Could not send the trickshot event\n");
        }
    }

    void EmitPlayerBots(const char* State, const std::string& Reason)
    {
        if (!GConnected.load(std::memory_order_acquire))
            return;
        try
        {
            json Out;
            Out["event"] = "playerBots";
            Out["state"] = State ? State : "";
            Out["reason"] = Reason;
            WriteLine(Out.dump(-1, ' ', false, json::error_handler_t::replace));
        }
        catch (...)
        {
            SDK::DbgLog("[Rift] Could not send the playerBots event\n");
        }
    }

    void EmitLivingWorld(const char* State, const std::string& Reason, int Spawned)
    {
        if (!GConnected.load(std::memory_order_acquire))
            return;
        try
        {
            json Out;
            Out["event"] = "livingWorld";
            Out["state"] = State ? State : "";
            Out["reason"] = Reason;
            Out["spawned"] = Spawned;
            WriteLine(Out.dump(-1, ' ', false, json::error_handler_t::replace));
        }
        catch (...)
        {
            SDK::DbgLog("[Rift] Could not send the livingWorld event\n");
        }
    }
}
