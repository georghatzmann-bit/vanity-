// [Vanity] Steuer-Pipe für den Launcher – eigener Vanity-Code (GPL-3.0). Siehe VanityControl.h.
#include "pch.h"
#include "../Public/VanityControl.h"
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

namespace
{
    using json = nlohmann::json;

    constexpr wchar_t kPipeName[] = L"\\\\.\\pipe\\vanity-server";
    constexpr size_t kMaxPendingCommands = 256;
    constexpr ULONGLONG kStatusIntervalMs = 2000;

    std::mutex GQueueMutex;
    std::deque<json> GPending; // vom Pipe-Thread befüllt, im Spiel-Takt geleert

    std::mutex GWriteMutex;
    HANDLE GPipe = INVALID_HANDLE_VALUE; // nur unter GWriteMutex anfassen
    std::atomic_bool GConnected{ false };
    std::atomic_bool GStarted{ false };
    std::atomic_bool GReadySent{ false };
    ULONGLONG GLastStatusMs = 0;

    // Hält den Playlist-Pfad, auf den FConfiguration::Playlist zeigt (dort steht nur ein Zeiger).
    std::wstring GPlaylistStorage;

    // ---------------------------------------------------------------- Text-Hilfen

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

    // ---------------------------------------------------------------- Senden

    void WriteLine(const std::string& Line)
    {
        std::lock_guard<std::mutex> Lock(GWriteMutex);
        if (GPipe == INVALID_HANDLE_VALUE)
            return;
        const std::string Data = Line + "\n";
        DWORD Written = 0;
        if (!WriteFile(GPipe, Data.data(), (DWORD)Data.size(), &Written, nullptr))
            SDK::DbgLog("[Vanity] Pipe-Schreiben fehlgeschlagen error=%lu\n", GetLastError());
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

    // ---------------------------------------------------------------- Spiel-Zugriffe (nur Spiel-Takt)

    UNetDriver* GetDriver()
    {
        auto World = UWorld::GetWorld();
        return World ? static_cast<UNetDriver*>(World->NetDriver) : nullptr;
    }

    AFortPlayerControllerAthena* FirstConnectedController()
    {
        auto Driver = GetDriver();
        if (!Driver)
            return nullptr;
        for (auto Connection : Driver->ClientConnections)
        {
            if (Connection && Connection->PlayerController)
                return static_cast<AFortPlayerControllerAthena*>(Connection->PlayerController);
        }
        return nullptr;
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

    // Ohne C++-Objekte, damit __try erlaubt ist.
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

    // Führt einen Cheat-Befehl so aus, als hätte ihn der erste verbundene Spieler in die Konsole getippt
    // („cheat …“). Dadurch gelten dieselben Prüfungen wie im Spiel.
    bool RunCheat(const std::string& Text, std::string& Error)
    {
        auto Controller = FirstConnectedController();
        if (!Controller)
        {
            Error = "Kein Spieler verbunden – Befehle laufen über den ersten verbundenen Spieler";
            return false;
        }
        auto Function = Controller->GetFunction("ServerCheat");
        if (!Function)
        {
            Error = "ServerCheat nicht gefunden";
            return false;
        }

        // Direkt im Parameterblock aufbauen (keine Kopie): FString gibt seinen Speicher im Destruktor frei,
        // eine Zuweisung aus einem Zwischenwert würde den Puffer zu früh freigeben.
        const std::wstring Wide = Widen(Text);
        struct FParams
        {
            FString Msg;
        } Params{ FString(Wide.c_str()) };

        if (!GuardedProcessEvent(Controller, Function, &Params))
        {
            Error = "Befehl hat einen Fehler im Spiel ausgelöst";
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
        double MinVersion; // ab welcher Fortnite-Version es die Playlist gibt (wie die Knöpfe im Server-Fenster)
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

    // Akzeptiert Kurznamen (solo, arena_solo, …), Asset-Namen (Playlist_ShowdownAlt_Solo) oder volle /Game/-Pfade.
    bool SetPlaylist(const std::string& Wanted, std::string& Error)
    {
        if (FConfiguration::bReadyToStart.load(std::memory_order_acquire))
        {
            Error = "Der Server läuft schon – die Playlist gilt nur vor dem Start";
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
            snprintf(Buffer, sizeof(Buffer), "Playlist „%s“ gibt es erst ab Version %.2f (dieser Build: %.2f)", Found->Key,
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
            Error = "Unbekannte Playlist „" + Wanted + "“. Bekannt: " + KnownPlaylistKeys() + " oder ein voller /Game/-Pfad";
            return false;
        }

        FConfiguration::Playlist = GPlaylistStorage.c_str();
        const int Selected = Found ? (int)Found->Value : (int)Playlist::Custom;
        GUI::SelectedPlaylist = Selected;
        GUI::PublishSelectedPlaylist(Selected);
        SDK::DbgLog("[Vanity] Playlist gesetzt: %ls\n", GPlaylistStorage.c_str());
        return true;
    }

    // ---------------------------------------------------------------- Einstellungen

    bool SetBool(std::atomic_bool& Target, const json& Value, std::string& Error)
    {
        if (!Value.is_boolean())
        {
            Error = "erwartet true oder false";
            return false;
        }
        Target.store(Value.get<bool>(), std::memory_order_release);
        return true;
    }

    bool SetInt(std::atomic_int& Target, const json& Value, int Min, int Max, std::string& Error)
    {
        if (!Value.is_number())
        {
            Error = "erwartet eine Zahl";
            return false;
        }
        const int Number = (int)Value.get<double>();
        if (Number < Min || Number > Max)
        {
            Error = "Wert außerhalb von " + std::to_string(Min) + "–" + std::to_string(Max);
            return false;
        }
        Target.store(Number, std::memory_order_release);
        return true;
    }

    bool SetFloat(std::atomic<float>& Target, const json& Value, float Min, float Max, std::string& Error)
    {
        if (!Value.is_number())
        {
            Error = "erwartet eine Zahl";
            return false;
        }
        const float Number = Value.get<float>();
        if (Number < Min || Number > Max)
        {
            Error = "Wert außerhalb des erlaubten Bereichs";
            return false;
        }
        Target.store(Number, std::memory_order_release);
        return true;
    }

    bool ApplyConfig(const std::string& Key, const json& Value, std::string& Error)
    {
        if (Key == "playlist")
        {
            if (!Value.is_string())
            {
                Error = "erwartet einen Playlist-Namen";
                return false;
            }
            return SetPlaylist(Value.get<std::string>(), Error);
        }
        if (Key == "bLateGame")
        {
            if (!Value.is_boolean())
            {
                Error = "erwartet true oder false";
                return false;
            }
            FConfiguration::SetLateGameEnabled(Value.get<bool>());
            return true;
        }
        if (Key == "bTrickshotDetection" || Key == "bEnableTrickshotTab")
        {
            if (!Value.is_boolean())
            {
                Error = "erwartet true oder false";
                return false;
            }
            FConfiguration::SetTrickshotTabEnabled(Value.get<bool>());
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

        Error = "Einstellung „" + Key + "“ kennt der Server nicht";
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

    // ---------------------------------------------------------------- Befehle (Spiel-Takt)

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
                Reply(Id, false, "Leerer Befehl");
                return;
            }
            if (RunCheat(Text, Error))
                Reply(Id, true, "Ausgeführt: " + Text);
            else
                Reply(Id, false, Error);
            return;
        }

        if (Name == "config")
        {
            const std::string Key = Command.value("key", std::string());
            const json Value = Command.contains("value") ? Command["value"] : json();
            if (ApplyConfig(Key, Value, Error))
                Reply(Id, true, Key + " gesetzt");
            else
                Reply(Id, false, Error);
            return;
        }

        if (Name == "startmatch")
        {
            if (FConfiguration::bReadyToStart.load(std::memory_order_acquire))
            {
                Reply(Id, false, "Der Server läuft schon");
                return;
            }
            // Gleiche Schritte wie der START-SERVER-Knopf im Server-Fenster.
            AutoHosting::CancelCountdown();
            AutoHosting::SaveNow(true);
            FConfiguration::bReadyToStart.store(true, std::memory_order_release);
            SDK::DbgLog("[Vanity] Start über den Launcher\n");
            Reply(Id, true, "Server startet – Karte wird geladen");
            return;
        }

        if (Name == "status")
        {
            json Out = StatusJson();
            Out["id"] = Id;
            WriteLine(Out.dump());
            return;
        }

        Reply(Id, false, "Unbekannter Befehl „" + Name + "“");
    }

    // ---------------------------------------------------------------- Pipe-Thread

    DWORD WINAPI PipeThread(LPVOID)
    {
        for (;;)
        {
            HANDLE Pipe = CreateNamedPipeW(kPipeName, PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 64 * 1024, 64 * 1024, 0, nullptr);
            if (Pipe == INVALID_HANDLE_VALUE)
            {
                SDK::DbgLog("[Vanity] CreateNamedPipe fehlgeschlagen error=%lu\n", GetLastError());
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
            SDK::DbgLog("[Vanity] Launcher über die Steuer-Pipe verbunden\n");

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
                    Buffer.clear(); // Schutz vor endlosen Zeilen
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
            SDK::DbgLog("[Vanity] Launcher getrennt – warte auf neue Verbindung\n");
        }
    }
}

namespace VanityControl
{
    void Start()
    {
        if (GStarted.exchange(true))
            return;
        HANDLE Thread = CreateThread(nullptr, 0, PipeThread, nullptr, 0, nullptr);
        if (Thread)
            CloseHandle(Thread);
        else
            SDK::DbgLog("[Vanity] Pipe-Thread konnte nicht gestartet werden\n");
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
}
