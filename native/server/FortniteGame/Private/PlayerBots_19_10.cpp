// NIOBIUM: Fortnite's own AI player bots ("Phoebe") on Fortnite 19.10, build CL 18675304 only.
//
// Ported from NotTacs/Artemis (https://github.com/NotTacs/Artemis, commit 48dba08 of 25 Oct 2026),
// GPL-3.0, by NotTacs and contributors. Niobium is GPL-3.0 as well. Credited in
// THIRD_PARTY_NOTICES.md. Where each part comes from (Artemis path -> function here):
//   FortniteAI/.../AthenaAIServicePlayerBots.cpp:8-29    -> GetPlaylistMaxPlayerCount
//   FortniteAI/.../AthenaAIServicePlayerBots.cpp:31-108  -> CalculateSpawnAmountAndSkill (our count)
//   FortniteAI/.../AthenaAIServicePlayerBots.cpp:110-124 -> UseFailSafeMMRInfo
//   FortniteAI/.../AthenaAIServicePlayerBots.cpp:126-238 -> InitializeMMRInfosUnsafe (our ELO)
//   FortniteAI/.../AthenaAIServicePlayerBots.cpp:240-265 -> WaitForMatchAssignmentReadyDetour
//   FortniteAI/.../AthenaAIServicePlayerBots.cpp:282-310 -> PutBotsInAircraftUnsafe
//   FortniteAI/.../AthenaAIServicePlayerBots.cpp:312-328 -> OnPlayerBotSpawnedDetour (+ AliveBots)
//   FortniteAI/.../AthenaAIServicePlayerBots.cpp:6, 330-335 -> the addresses in kRva below
//   FortniteGame/.../FortGameModeAthena.cpp:38-40        -> ApplyAISettings
//   FortniteGame/.../FortGameModeAthena.cpp:120-184      -> CachePOIsUnsafe
//   FortniteGame/.../FortGameStateAthena.cpp:6-10        -> OnAircraftPhaseStarted (called from our
//                                                           own StartAircraftPhase hook instead of a
//                                                           second PlacePlayersInAircraft hook)
//   FortniteAI/.../AthenaNavSystem.cpp:5-14              -> CreateAndConfigureNavSystemDetour
//   FortniteAI/.../FortAthenaAISpawnerDataComponent_AIBotCosmeticBase.cpp:5-15 -> GetLoadoutDetour
//   Engine/.../Kismet/MemoryLibrary.h (AllocateNearbyPage, Rel32Swap_Lea) -> AllocateNearPage,
//                                                           PatchLeaTarget (now in AIBase.cpp,
//                                                           with the PE, unwind, LEA and layout
//                                                           checks and the SEH guard this gate uses)
//   SDK/SDK/FortniteGame_classes.hpp, _structs.hpp (EnterAircraft 0x5ce165c, the unreflected
//   service fields 0xB28/0xB2C/0xB30, the MMR structs)   -> constants and structs below
//   FortniteGame/.../FortGameModeAthena.cpp:72-76, 98-99 -> FortGameMode.cpp SpawnDefaultPawnFor:
//                                                           AI bots only get their pawn, none of
//                                                           the player set-up (IsAIBotController)
// Other Niobium files that call in here: FortGameMode.cpp (SetupPlaylist, FinishWorldInitialization,
// StartAircraftPhase, SpawnDefaultPawnFor), FortPlayerControllerAthena.cpp (ServerAttemptAircraftJump_:
// AI bots use the game's own bus jump), GUI.cpp (GameThreadTick), NiobiumControl.cpp (the launcher's
// bPlayerBots / PlayerBotCount / PlayerBotTargetELO and the "playerBots" event).
// Not ported on purpose: the KickPlayer / ValidatePlayer / StoreGameSessionID patches, the engine
// rewrites (World, NetDriver, Engine, Object), the backend, and Artemis' storm, inventory and
// loadout code (Niobium has its own).
//
// Safety gate (Gate below): every address is only right for one Fortnite build. Nothing here is
// hooked or patched unless
//   - the game is 19.10 and its build number (CL, read from the engine version string) is 18675304,
//   - FortniteClient-Win64-Shipping.exe has the size of Epic's 19.10 file (198,580,704 bytes),
//   - the reflected layouts of the classes and structs used here match Artemis' 19.10 dump, and
//   - every address passes a byte check: functions must start at an unwind-table entry right
//     after the end of another function (code that is only replaced, never called, may also be a
//     stripped stub right after padding), the patched LEA must be a RIP-relative LEA inside a game
//     function that loads such a start, and the console variable must hold a sane number.
// Otherwise the match runs without bots, "[PlayerBots] disabled: <reason>" goes to the log and the
// launcher gets {"event":"playerBots","state":"unavailable","reason":"..."}.
#include "pch.h"
#include "../Public/PlayerBots_19_10.h"
#include "../Public/AIBase.h"
#include "../Public/FortGameMode.h"
#include "../Public/FortPlaylistAthena.h"
#include "../Public/BuildingFoundation.h"
#include <Engine/Public/NetDriver.h>
#include <Engine/Public/DataTable.h>
#include <Erbium/Public/Configuration.h>
#include <Erbium/Public/NiobiumControl.h>
#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <string>
#include <unordered_set>
#include <vector>

namespace
{
    // The gate tooling is shared with the other AI features (FortniteGame/Private/AIBase.cpp).
    using AIBase::CheckFunctionStart;
    using AIBase::CheckLayout;
    using AIBase::CheckLeaToFunction;
    using AIBase::FImage;
    using AIBase::Hex;
    using AIBase::IsChildOfClass;
    using AIBase::IsLiveObject;
    using AIBase::IsWritableData;
    using AIBase::OffsetOf;
    using AIBase::PatchLeaTarget;
    using AIBase::PropertyOffset;
    using AIBase::ReadGameImage;

    // ------------------------------------------------------------------ The one supported build

    constexpr double kFortniteVersion = 19.10;
    constexpr uint64_t kChangelist = 18675304;
    // FortniteGame/Binaries/Win64/FortniteClient-Win64-Shipping.exe in Epic's manifest of
    // "++Fortnite+Release-19.10-CL-18675304-Windows" (file SHA-1 e0f0f1fb94edc2268f2a2ada17e4b0d9f120d59c).
    constexpr uint64_t kShippingExeSize = 198580704ull;

    // Addresses (RVAs) from Artemis 48dba08. The same build is confirmed by two other 19.10
    // servers that hook StartNewSafeZonePhase at 0x5FA67BC like Artemis does.
    namespace kRva
    {
        constexpr uint32_t InitializeMMRInfosLea = 0x5EE0504;      // AthenaAIServicePlayerBots.cpp:332
        constexpr uint32_t WaitForMatchAssignmentReady = 0x5EE9524; // :333
        constexpr uint32_t OnPlayerBotSpawned = 0x5EDF374;          // :334
        constexpr uint32_t PlayerListFindOrAdd = 0x12E76A0;         // :320
        constexpr uint32_t PlayerListAdd = 0x12E7338;               // :321
        constexpr uint32_t BotMaxSpawnAmountCVar = 0xB1BE974;       // :6
        constexpr uint32_t CreateAndConfigureNavSystem = 0x1F96F68; // AthenaNavSystem.cpp:13
        constexpr uint32_t AIBotCosmeticGetLoadout = 0x6A41DE4;     // ..._AIBotCosmeticBase.cpp:14
        constexpr uint32_t AIBotEnterAircraft = 0x5CE165C;          // SDK AFortAthenaAIBotController::EnterAircraft
    }

    // Unreflected fields, from Artemis' SDK and AthenaAIServicePlayerBots.cpp:323-325. The gate
    // checks that the reflected fields around them sit where Artemis' dump has them.
    constexpr uint32_t kServiceSpawnFlagsByte = 0xA10;        // bSpawningAmountComputed = bit 3
    constexpr uint8_t kSpawningAmountComputedBit = 0x08;
    constexpr uint32_t kServiceCachedHumanPlayersCount = 0xB28;
    constexpr uint32_t kServiceCachedAmountOfBotsToSpawn = 0xB2C;
    constexpr uint32_t kServiceOverridenMaxSpawnAmount = 0xB30;
    constexpr uint32_t kGameStateTeamPlayerLists = 0x1678;
    constexpr uint32_t kGameStateSquadPlayerLists = 0x16B0;

    constexpr wchar_t kMMRSpawningTable[] =
        L"/Game/Athena/AI/Phoebe/PhoebeSpawningTables/PhoebeMMRSpawning.PhoebeMMRSpawning";

    // What the launcher shows (short, plain English).
    constexpr const char* kReasonWrongCopy = "Bots aren't available for this copy of 19.10.";
    constexpr const char* kReasonNoBotsInVersion = "AI bots don't exist in this Fortnite version.";
    constexpr const char* kReasonNotYet = "AI bots aren't available for this version yet.";
    constexpr const char* kReasonPlaylist = "Bots aren't available in this playlist.";

    // ------------------------------------------------------------------ 19.10 memory layouts
    // From Artemis' SDK (FortniteGame_structs.hpp). Only used through pointers, never constructed.

    struct FVector3f
    {
        float X, Y, Z;
    };
    static_assert(sizeof(FVector3f) == 0xC);

    struct FMMRSpawningInfo1910 // FortniteGame.MMRSpawningInfo, 0x28
    {
        float BotSpawningDataInfoTargetELO;
        float BotSpawningDataInfoWeight;
        int32 NumBotsToSpawn;
        int32 Padding;
        const UClass* AISpawnerData;
        uint8 SpawnedCallbacks[0x10];
    };
    static_assert(sizeof(FMMRSpawningInfo1910) == 0x28);

    struct FMMRSpawningPlayerBotsRuntimeInfo1910 // FortniteGame.MMRSpawningPlayerBotsRuntimeInfo, 0x38
    {
        void* VTable;
        int32 MMRBracketLow;
        int32 MMRBracketHigh;
        uint8 MMRName[0x10]; // FString, never touched
        TArray<FMMRSpawningInfo1910> SpawningInfos;
        int32 TotalSpawningInfoWeight;
        int32 CachedTotalAmountToSpawnComputed;
    };
    static_assert(sizeof(FMMRSpawningPlayerBotsRuntimeInfo1910) == 0x38);

    struct FMMRSpawningDataTableInfo1910 // FortniteGame.MMRSpawningDataTableInfo, 0x18
    {
        const UClass* AISpawnerData;
        float Skill;
        float Weight;
        int32 SpawingItemIndex;
        int32 Padding;
    };
    static_assert(sizeof(FMMRSpawningDataTableInfo1910) == 0x18);

    struct FMMRPhaseSpawningDataTableInfo1910 // FortniteGame.MMRPhaseSpawningDataTableInfo, 0x18
    {
        int32 GamePhaseIndexToSpawn;
        int32 Padding;
        TArray<FMMRSpawningDataTableInfo1910> SpawningItems;
    };
    static_assert(sizeof(FMMRPhaseSpawningDataTableInfo1910) == 0x18);

    struct FMMRSpawningBracketBotDataTableRow1910 // FortniteGame.MMRSpawningBracketBotDataTableRow, 0x20
    {
        void* TableRowVTable;
        int32 MMRBracketLow;
        int32 MMRBracketHigh;
        TArray<FMMRPhaseSpawningDataTableInfo1910> PhaseSpawningItems;
    };
    static_assert(sizeof(FMMRSpawningBracketBotDataTableRow1910) == 0x20);

    struct FFortServerBotInfo1910 // FortniteGame.FortServerBotInfo, 0x18
    {
        UObject* BotController;
        UObject* SelectedPoiVolume;
        uint8 Padding[0x8];
    };
    static_assert(sizeof(FFortServerBotInfo1910) == 0x18);

    struct FCachedPOIVolumeLocations1910 // FortniteGame.CachedPOIVolumeLocations, 0x20
    {
        UObject* POIVolume;
        TArray<FVector3f> NavMeshLocations;
        int32 NumLocationsReserved;
        uint32 bEQSQueryPending : 1;
    };
    static_assert(sizeof(FCachedPOIVolumeLocations1910) == 0x20);

    // ------------------------------------------------------------------ Native function types

    using FWaitForMatchAssignmentReady = void (*)(UObject* Service, void* FlowHandle);
    using FOnPlayerBotSpawned = void (*)(UObject* Service, AActor* Actor, int32 SpawnRequestID,
        double PawnMMR);
    using FCreateAndConfigureNavSystem = void* (*)(UObject* Config, UObject* World);
    using FGetLoadout = void (*)(UObject* Component, void* OutLoadout);
    using FEnterAircraft = void (*)(UObject* BotController, AActor* Aircraft);
    using FPlayerListFindOrAdd = __int64 (*)(__int64 Map, int Key);
    using FPlayerListAdd = __int64 (*)(__int64 List, __int64 PlayerState);

    FWaitForMatchAssignmentReady GWaitForMatchAssignmentReadyOG = nullptr;
    FOnPlayerBotSpawned GOnPlayerBotSpawnedOG = nullptr;
    FCreateAndConfigureNavSystem GCreateAndConfigureNavSystemOG = nullptr;
    FGetLoadout GGetLoadoutOG = nullptr;

    // ------------------------------------------------------------------ State

    enum class EGate : int
    {
        Undecided = 0,
        Active = 1,
        Unavailable = 2,
    };

    std::atomic<int> GGate{ (int)EGate::Undecided };

    // Offsets the gate read from the game's reflection data (all checked against Artemis' dump).
    struct FLayout
    {
        int32 ServiceGamePhaseToStartSpawning = -1;
        int32 ServiceDefaultBotAISpawnerData = -1;
        int32 ServicePlayerBots = -1;
        int32 ServiceCachedAIPopulationTracker = -1;
        int32 ServiceMMRSpawnTable = -1;
        int32 ServiceCachedMMRSpawningInfo = -1;
        int32 ServiceCachedValidPOIVolumeLocations = -1;
        int32 ServiceCachedBuildingFoundations = -1;
        int32 ServiceOnGroundTagQueryPOIList = -1;
        int32 ServiceBattleBusTagQueryPOIList = -1;
        int32 ServiceSecondaryBattleBusTagQueryPOIList = -1;
        int32 BattleBusPOISize = 0;
        int32 BattleBusPOIFilterQuery = -1;
        int32 BattleBusPOIValidList = -1;
        int32 NavigationPOISize = 0;
        int32 NavigationPOIFilterQuery = -1;
        int32 NavigationPOIValidList = -1;
        int32 TagQueryTagDictionary = -1;
        int32 GameplayTagSize = 0;
        int32 LoadoutCharacter = -1;
        int32 NavConfigAutoSpawnByte = -1;
        uint8 NavConfigAutoSpawnMask = 0;
        int32 PlayerStateTeamIndex = -1;
        int32 PlayerStateSquadId = -1;
        int32 PlaylistAISettings = -1;
        int32 GameModeAISettings = -1;
        int32 SettingsAIServices = -1;
        const UClass* ServiceClass = nullptr;
        const UClass* SettingsClass = nullptr;
        const UClass* AIBotControllerClass = nullptr;
        const UClass* NavConfigClass = nullptr;
        const UClass* PoiVolumeClass = nullptr;
    };

    FLayout GLayout;

    struct FMatchState
    {
        UObject* AppliedGameMode = nullptr;   // AISettings set for this game mode
        TWeakObjectPtr<UObject> Service;      // the live UAthenaAIServicePlayerBots
        UObject* POIWorld = nullptr;          // POI caches filled for this world
        int32 POIAttempts = 0;
        bool bServiceStarted = false;         // the service called one of our hooks
        bool bWarnedNoService = false;
        bool bAircraftDone = false;
        bool bAllBotsOutLogged = false;
        int32 SpawnedBots = 0;
        ULONGLONG LastTickMs = 0;
        std::unordered_set<const UObject*> ListedPlayerStates;
    };

    FMatchState GMatch;

    // ------------------------------------------------------------------ Logging

    // "[PlayerBots] ..." lines go to the inherited stdout handle (the launcher's pipe, read by
    // logparse.rs), like the "[NiobiumLoot]" lines: this DLL's CRT stdout goes to stdout.log.
    void BotsLog(const char* Format, ...)
    {
        char Buffer[768];
        va_list Args;
        va_start(Args, Format);
        vsnprintf(Buffer, sizeof(Buffer), Format, Args);
        va_end(Args);
        AIBase::LogLine("PlayerBots", Buffer);
    }

    void Disable(const char* UserReason, const std::string& LogReason)
    {
        GGate.store((int)EGate::Unavailable, std::memory_order_release);
        BotsLog("disabled: %s", LogReason.c_str());
        NiobiumControl::EmitPlayerBots("unavailable", UserReason);
    }

    // ------------------------------------------------------------------ Object helpers

    int32 CountHumanPlayers()
    {
        auto World = UWorld::GetWorld();
        auto Driver = World ? static_cast<UNetDriver*>(World->NetDriver) : nullptr;
        if (!IsLiveObject(Driver))
            return 0;
        int32 Count = 0;
        for (auto Connection : Driver->ClientConnections)
        {
            if (Connection && Connection->PlayerController)
                ++Count;
        }
        return Count;
    }

    AFortGameMode* GetGameMode()
    {
        auto World = UWorld::GetWorld();
        auto GameMode = World ? World->AuthorityGameMode : nullptr;
        return IsLiveObject(GameMode) ? GameMode->Cast<AFortGameMode>() : nullptr;
    }

    int32 ClampedBotCount()
    {
        return std::clamp(FConfiguration::PlayerBotCount.load(std::memory_order_acquire), 1, 99);
    }

    int32 ClampedTargetELO()
    {
        return std::clamp(FConfiguration::PlayerBotTargetELO.load(std::memory_order_acquire), 0, 5000);
    }

    // ------------------------------------------------------------------ Reflection checks
    // (PE, unwind, LEA and layout checks live in AIBase.)

    bool CheckLayouts(std::string& Why)
    {
        auto& L = GLayout;
        L.ServiceClass = FindClass("AthenaAIServicePlayerBots");
        L.SettingsClass = FindClass("AthenaAISettings");
        L.AIBotControllerClass = FindClass("FortAthenaAIBotController");
        L.NavConfigClass = FindClass("NavigationSystemModuleConfig");
        L.PoiVolumeClass = FindClass("FortPoiVolume");

        // UAthenaAIServicePlayerBots (Artemis SDK FortniteGame_classes.hpp:19545, 0xBF0 bytes).
        if (!CheckLayout(L.ServiceClass, "AthenaAIServicePlayerBots", 0xBF0, {
                { "bWaitForNavmeshToBeLoaded", 0xA10, 0x40 },
                { "bDoSpawnBotFlow", 0xA10, 0x80 },
                { "GamePhaseToStartSpawning", 0xA12, 0 },
                { "DefaultBotAISpawnerData", 0xA18, 0 },
                { "CachedAIPopulationTracker", 0xA88, 0 },
                { "PlayerBots", 0xA90, 0 },
                { "NonAthenaParticipantBots", 0xAA0, 0 },
                { "MMRSpawnTable", 0xB38, 0 },
                { "CachedMMRSpawningInfo", 0xB60, 0 },
                { "OverridePOISpreadingSquadCount", 0xBB8, 0 },
                { "BattleBusTagQueryPOIList", 0x400, 0 },
                { "SecondaryBattleBusTagQueryPOIList", 0x410, 0 },
                { "OnGroundTagQueryPOIList", 0x428, 0 },
                { "CachedValidPOIVolumeLocations", 0x6D8, 0 },
                { "CachedBuildingFoundations", 0x6E8, 0 },
            }, Why))
        {
            return false;
        }
        L.ServiceGamePhaseToStartSpawning = 0xA12;
        L.ServiceDefaultBotAISpawnerData = 0xA18;
        L.ServiceCachedAIPopulationTracker = 0xA88;
        L.ServicePlayerBots = 0xA90;
        L.ServiceMMRSpawnTable = 0xB38;
        L.ServiceCachedMMRSpawningInfo = 0xB60;
        L.ServiceBattleBusTagQueryPOIList = 0x400;
        L.ServiceSecondaryBattleBusTagQueryPOIList = 0x410;
        L.ServiceOnGroundTagQueryPOIList = 0x428;
        L.ServiceCachedValidPOIVolumeLocations = 0x6D8;
        L.ServiceCachedBuildingFoundations = 0x6E8;

        if (!CheckLayout(FindStruct("MMRSpawningPlayerBotsRuntimeInfo"),
                "MMRSpawningPlayerBotsRuntimeInfo", 0x38, { { "SpawningInfos", 0x20, 0 } }, Why) ||
            !CheckLayout(FindStruct("MMRSpawningBaseRuntimeInfo"), "MMRSpawningBaseRuntimeInfo",
                0x10, {}, Why) ||
            !CheckLayout(FindStruct("MMRSpawningInfo"), "MMRSpawningInfo", 0x28, {}, Why) ||
            !CheckLayout(FindStruct("MMRSpawningBracketBotDataTableRow"),
                "MMRSpawningBracketBotDataTableRow", 0x20, {
                    { "MMRBracketLow", 0x8, 0 },
                    { "MMRBracketHigh", 0xC, 0 },
                    { "PhaseSpawningItems", 0x10, 0 },
                }, Why) ||
            !CheckLayout(FindStruct("MMRPhaseSpawningDataTableInfo"),
                "MMRPhaseSpawningDataTableInfo", 0x18, {
                    { "GamePhaseIndexToSpawn", 0x0, 0 },
                    { "SpawningItems", 0x8, 0 },
                }, Why) ||
            !CheckLayout(FindStruct("MMRSpawningDataTableInfo"), "MMRSpawningDataTableInfo", 0x18, {
                    { "AISpawnerData", 0x0, 0 },
                    { "Skill", 0x8, 0 },
                    { "Weight", 0xC, 0 },
                }, Why) ||
            !CheckLayout(FindStruct("FortServerBotInfo"), "FortServerBotInfo", 0x18, {
                    { "BotController", 0x0, 0 },
                    { "SelectedPoiVolume", 0x8, 0 },
                }, Why) ||
            !CheckLayout(FindStruct("CachedPOIVolumeLocations"), "CachedPOIVolumeLocations", 0x20, {
                    { "POIVolume", 0x0, 0 },
                }, Why))
        {
            return false;
        }

        // The game state's team and squad player lists (unreflected, Artemis :323-325) sit
        // between these two reflected fields.
        if (!CheckLayout(FindClass("FortGameStateAthena"), "FortGameStateAthena", 0, {
                { "SpectateAPartyMemberAvailable", 0x1670, 0 },
                { "GameMemberInfoArray", 0x1788, 0 },
            }, Why))
        {
            return false;
        }

        // Where the AI settings live (Artemis FortGameModeAthena.cpp:38-40) and the alive lists.
        if (!CheckLayout(FindClass("FortGameModeAthena"), "FortGameModeAthena", 0, {
                { "AlivePlayers", 0xF88, 0 },
                { "AliveBots", 0xF98, 0 },
                { "AISettings", 0x1070, 0 },
            }, Why) ||
            !CheckLayout(FindClass("FortPlaylistAthena"), "FortPlaylistAthena", 0,
                { { "AISettings", 0xCE8, 0 } }, Why) ||
            !CheckLayout(L.SettingsClass, "AthenaAISettings", 0xA0,
                { { "AIServices", 0x90, 0 } }, Why))
        {
            return false;
        }

        // Loadout.Character (GetLoadout) and the nav config bit (CreateAndConfigureNavSystem).
        if (!CheckLayout(FindStruct("FortAthenaLoadout"), "FortAthenaLoadout", 0,
                { { "Character", 0x40, 0 } }, Why) ||
            !CheckLayout(L.NavConfigClass, "NavigationSystemModuleConfig", 0,
                { { "bAutoSpawnMissingNavData", 0x50, 0x04 } }, Why))
        {
            return false;
        }
        L.LoadoutCharacter = 0x40;
        L.NavConfigAutoSpawnByte = 0x50;
        L.NavConfigAutoSpawnMask = 0x04;

        // Reflected only (no fixed numbers needed): the POI query structs and other fields.
        auto BattleBusPOI = FindStruct("BattleBusPOI");
        auto NavigationPOI = FindStruct("NavigationPOI");
        auto TagQuery = FindStruct("GameplayTagQuery");
        auto GameplayTag = FindStruct("GameplayTag");
        L.BattleBusPOISize = BattleBusPOI ? BattleBusPOI->GetPropertiesSize() : 0;
        L.BattleBusPOIFilterQuery = OffsetOf(BattleBusPOI, "POIFilterQuery");
        L.BattleBusPOIValidList = OffsetOf(BattleBusPOI, "ValidPOIVolumeList");
        L.NavigationPOISize = NavigationPOI ? NavigationPOI->GetPropertiesSize() : 0;
        L.NavigationPOIFilterQuery = OffsetOf(NavigationPOI, "POIFilterQuery");
        L.NavigationPOIValidList = OffsetOf(NavigationPOI, "ValidPOIVolumeList");
        L.TagQueryTagDictionary = OffsetOf(TagQuery, "TagDictionary");
        L.GameplayTagSize = GameplayTag ? GameplayTag->GetPropertiesSize() : 0;

        auto PlayerStateClass = FindClass("FortPlayerStateAthena");
        L.PlayerStateTeamIndex = OffsetOf(PlayerStateClass, "TeamIndex");
        L.PlayerStateSquadId = OffsetOf(PlayerStateClass, "SquadId");
        L.PlaylistAISettings = OffsetOf(FindClass("FortPlaylistAthena"), "AISettings");
        L.GameModeAISettings = OffsetOf(FindClass("FortGameModeAthena"), "AISettings");
        L.SettingsAIServices = OffsetOf(L.SettingsClass, "AIServices");

        if (!L.SettingsClass || !L.AIBotControllerClass || !L.PoiVolumeClass ||
            L.PlayerStateTeamIndex < 0 || L.PlayerStateSquadId < 0 || L.PlaylistAISettings < 0 ||
            L.GameModeAISettings < 0 || L.SettingsAIServices < 0)
        {
            Why = "an AI class or field the bots need is missing";
            return false;
        }
        return true;
    }

    // ------------------------------------------------------------------ The bot service

    FMMRSpawningPlayerBotsRuntimeInfo1910& MMRInfo(UObject* Service)
    {
        return GetFromOffset<FMMRSpawningPlayerBotsRuntimeInfo1910>(Service,
            GLayout.ServiceCachedMMRSpawningInfo);
    }

    int32& ServiceInt(UObject* Service, uint32_t Offset)
    {
        return GetFromOffset<int32>(Service, Offset);
    }

    void RememberService(UObject* Service)
    {
        if (GMatch.Service.Get() != Service)
            GMatch.Service = TWeakObjectPtr<UObject>(Service);
        if (!GMatch.bServiceStarted)
        {
            GMatch.bServiceStarted = true;
            BotsLog("bot service started");
        }
    }

    // Artemis :8-29.
    int32 GetPlaylistMaxPlayerCount()
    {
        auto GameMode = GetGameMode();
        auto GameState = GameMode && IsLiveObject(GameMode->GameState) ? GameMode->GameState : nullptr;
        auto Playlist = GameState ? AFortGameMode::GetActivePlaylist(GameState) : nullptr;
        if (!IsLiveObject(Playlist))
            return 0;
        auto OverrideProperty = Playlist->GetProperty("bOverrideMaxPlayers");
        const int32 OverrideOffset = PropertyOffset(OverrideProperty);
        const uint8 OverrideMask = OverrideProperty && OverrideProperty->GetFieldMask()
            ? OverrideProperty->GetFieldMask() : 0xFF;
        const int32 HumanAndBotOffset = (int32)Playlist->GetOffset("MaxHumanAndBotParticipants");
        if (OverrideOffset >= 0 && HumanAndBotOffset >= 0 &&
            (GetFromOffset<uint8>(Playlist, OverrideOffset) & OverrideMask) != 0)
        {
            const int32 HumanAndBot = GetFromOffset<int32>(Playlist, HumanAndBotOffset);
            if (HumanAndBot > 0)
                return HumanAndBot;
        }
        return Playlist->HasMaxPlayers() ? Playlist->MaxPlayers : 0;
    }

    // Artemis :31-108, with Niobium's bot count instead of "max players minus humans".
    void CalculateSpawnAmountAndSkill(UObject* Service)
    {
        auto& Flags = GetFromOffset<uint8>(Service, kServiceSpawnFlagsByte);
        if (Flags & kSpawningAmountComputedBit)
            return;

        auto& Info = MMRInfo(Service);
        if (!(Info.MMRBracketLow > -99999 && Info.MMRBracketLow < Info.MMRBracketHigh &&
                Info.SpawningInfos.Num() > 0 && Info.TotalSpawningInfoWeight > 0))
        {
            BotsLog("Error: can't work out the bot count, the MMR bracket is not valid");
            return;
        }

        int32 Count = ClampedBotCount();
        const int32 MaxPlayers = GetPlaylistMaxPlayerCount();
        const int32 Humans = (std::max)(1, CountHumanPlayers());
        if (MaxPlayers > 1)
            Count = (std::min)(Count, (std::max)(1, MaxPlayers - Humans));

        ServiceInt(Service, kServiceOverridenMaxSpawnAmount) = Count;
        ServiceInt(Service, kServiceCachedAmountOfBotsToSpawn) = Count;

        Info.CachedTotalAmountToSpawnComputed = 0;
        for (int32 Index = 0; Index < Info.SpawningInfos.Num(); ++Index)
        {
            auto& SpawningInfo = Info.SpawningInfos[Index];
            const float Weight = Info.TotalSpawningInfoWeight > 0
                ? SpawningInfo.BotSpawningDataInfoWeight / (float)Info.TotalSpawningInfoWeight : 0.f;
            const int32 Amount = (std::max)(0, (int32)((float)Count * Weight));
            SpawningInfo.NumBotsToSpawn = Amount;
            Info.CachedTotalAmountToSpawnComputed += Amount;
        }

        for (int32 Index = 0; Index < Info.SpawningInfos.Num() &&
             Info.CachedTotalAmountToSpawnComputed < Count; ++Index)
        {
            Info.SpawningInfos[Index].NumBotsToSpawn++;
            Info.CachedTotalAmountToSpawnComputed++;
        }

        if (Info.CachedTotalAmountToSpawnComputed != Count)
        {
            Info.CachedTotalAmountToSpawnComputed = 0;
            BotsLog("Error: the bot count doesn't add up (%d wanted)", Count);
        }

        Flags |= kSpawningAmountComputedBit;
        BotsLog("spawn amount: %d bots (max players %d, humans %d)", Count, MaxPlayers, Humans);
    }

    // Artemis :110-124, with Niobium's target ELO.
    void UseFailSafeMMRInfo(UObject* Service, float TargetELO, const char* Why)
    {
        BotsLog("using the fallback spawn info (%s), ELO %d", Why, (int)TargetELO);
        auto& Info = MMRInfo(Service);
        Info.MMRBracketLow = -1000;
        Info.MMRBracketHigh = 4000;
        Info.TotalSpawningInfoWeight = 100;
        Info.SpawningInfos.Free();

        FMMRSpawningInfo1910 Item{};
        Item.BotSpawningDataInfoWeight = 100.f;
        Item.BotSpawningDataInfoTargetELO = TargetELO;
        Item.NumBotsToSpawn = 0;
        Item.AISpawnerData = GetFromOffset<const UClass*>(Service, GLayout.ServiceDefaultBotAISpawnerData);
        Info.SpawningInfos.Add(Item);
        CalculateSpawnAmountAndSkill(Service);
    }

    // Artemis :126-238. The game's own version is stripped; Artemis swaps the LEA that hands its
    // address to the service. Niobium uses the PlayerBotTargetELO from the launcher both to pick
    // the MMR bracket and as the skill of every bot.
    void InitializeMMRInfosUnsafe(UObject* Service)
    {
        RememberService(Service);
        const int32 TargetELO = ClampedTargetELO();

        auto Table = FindObject<UDataTable>(kMMRSpawningTable);
        if (!IsLiveObject(Table))
        {
            UseFailSafeMMRInfo(Service, (float)TargetELO, "no PhoebeMMRSpawning table");
            return;
        }
        Table->AddToRoot();

        // Like Artemis: remember the table in the service for the game's later phases.
        auto& SpawnTable = GetFromOffset<TSoftObjectPtr<UDataTable>>(Service, GLayout.ServiceMMRSpawnTable);
        if (SpawnTable.ObjectID.AssetPathName.ComparisonIndex == 0)
            SpawnTable.ObjectID.AssetPathName = FName(kMMRSpawningTable);

        const FMMRSpawningBracketBotDataTableRow1910* FoundRow = nullptr;
        for (auto& Pair : Table->RowMap)
        {
            auto Row = reinterpret_cast<const FMMRSpawningBracketBotDataTableRow1910*>(Pair.Value());
            if (!Row || !SDK::MemReadable(Row, sizeof(*Row)))
                continue;
            const bool bValidBracket = Row->MMRBracketLow > -99999 &&
                Row->MMRBracketLow < Row->MMRBracketHigh;
            if (bValidBracket && TargetELO >= Row->MMRBracketLow && TargetELO <= Row->MMRBracketHigh)
            {
                FoundRow = Row;
                break;
            }
        }

        if (!FoundRow || FoundRow->PhaseSpawningItems.Num() <= 0)
        {
            UseFailSafeMMRInfo(Service, (float)TargetELO, "no MMR bracket for this ELO");
            return;
        }

        auto& Info = MMRInfo(Service);
        Info.MMRBracketLow = FoundRow->MMRBracketLow;
        Info.MMRBracketHigh = FoundRow->MMRBracketHigh;
        Info.SpawningInfos.Free();
        Info.TotalSpawningInfoWeight = 0;

        const auto& FirstPhase = FoundRow->PhaseSpawningItems[0];
        float TotalWeight = 0.f;
        for (int32 Index = 0; Index < FirstPhase.SpawningItems.Num(); ++Index)
        {
            const auto& Item = FirstPhase.SpawningItems[Index];
            if (!IsLiveObject(Item.AISpawnerData) || !(Item.Weight > 0.f))
                continue;
            Item.AISpawnerData->AddToRoot();

            FMMRSpawningInfo1910 SpawnInfo{};
            SpawnInfo.AISpawnerData = Item.AISpawnerData;
            SpawnInfo.BotSpawningDataInfoTargetELO = (float)TargetELO;
            SpawnInfo.BotSpawningDataInfoWeight = Item.Weight;
            Info.SpawningInfos.Add(SpawnInfo);
            TotalWeight += Item.Weight;
        }
        Info.TotalSpawningInfoWeight = (int32)TotalWeight;

        if (Info.SpawningInfos.Num() <= 0 || Info.TotalSpawningInfoWeight <= 0)
        {
            UseFailSafeMMRInfo(Service, (float)TargetELO, "the MMR bracket has no bot types");
            return;
        }

        BotsLog("MMR bracket %d to %d, %d bot types, ELO %d", Info.MMRBracketLow,
            Info.MMRBracketHigh, Info.SpawningInfos.Num(), TargetELO);
        CalculateSpawnAmountAndSkill(Service);
    }

    bool InitializeMMRInfosGuarded(UObject* Service) noexcept
    {
        return AIBase::Guarded([](void* Context) { InitializeMMRInfosUnsafe(static_cast<UObject*>(Context)); },
            Service);
    }

    void InitializeMMRInfosReplacement(UObject* Service)
    {
        if (!IsLiveObject(Service))
            return;
        if (!InitializeMMRInfosGuarded(Service))
            BotsLog("Error: setting up the bot skill failed");
    }

    // Artemis :240-265, without the wait for a matchmaking backend: Niobium knows its humans.
    void PrepareMatchAssignmentUnsafe(UObject* Service)
    {
        RememberService(Service);
        GetFromOffset<uint8>(Service, GLayout.ServiceGamePhaseToStartSpawning) = 2; // EAthenaGamePhase::Warmup
        ServiceInt(Service, kServiceCachedHumanPlayersCount) = (std::max)(1, CountHumanPlayers());
        ServiceInt(Service, kServiceOverridenMaxSpawnAmount) = ClampedBotCount();
    }

    bool PrepareMatchAssignmentGuarded(UObject* Service) noexcept
    {
        return AIBase::Guarded([](void* Context) { PrepareMatchAssignmentUnsafe(static_cast<UObject*>(Context)); },
            Service);
    }

    void WaitForMatchAssignmentReadyDetour(UObject* Service, void* FlowHandle)
    {
        if (GGate.load(std::memory_order_acquire) == (int)EGate::Active && IsLiveObject(Service) &&
            !PrepareMatchAssignmentGuarded(Service))
            BotsLog("Error: preparing the bot service failed");
        GWaitForMatchAssignmentReadyOG(Service, FlowHandle);
    }

    // Artemis :312-328: put the bot in the game state's team and squad lists. Niobium also adds
    // the bot's controller to GameMode->AliveBots (if the game didn't), which our victory,
    // player-count and targeting code reads.
    void RegisterSpawnedBotUnsafe(UObject* Service, AActor* Actor)
    {
        RememberService(Service);
        auto Pawn = IsLiveObject(Actor) ? Actor->Cast<AFortPlayerPawnAthena>() : nullptr;
        if (!Pawn)
            return;

        auto PlayerState = IsLiveObject(Pawn->PlayerState) ? Pawn->PlayerState : nullptr;
        auto World = UWorld::GetWorld();
        auto GameState = World && IsLiveObject(World->GameState) ? World->GameState : nullptr;
        if (PlayerState && GameState && PlayerState->IsA(FindClass("FortPlayerStateAthena")) &&
            GMatch.ListedPlayerStates.insert(PlayerState).second)
        {
            static auto FindOrAdd = reinterpret_cast<FPlayerListFindOrAdd>(ImageBase + kRva::PlayerListFindOrAdd);
            static auto ListAdd = reinterpret_cast<FPlayerListAdd>(ImageBase + kRva::PlayerListAdd);
            const uint8 TeamIndex = GetFromOffset<uint8>(PlayerState, GLayout.PlayerStateTeamIndex);
            const uint8 SquadId = GetFromOffset<uint8>(PlayerState, GLayout.PlayerStateSquadId);

            const __int64 TeamList = FindOrAdd(__int64(GameState) + kGameStateTeamPlayerLists, TeamIndex);
            if (TeamList)
                ListAdd(TeamList, __int64(PlayerState));
            const __int64 SquadList = FindOrAdd(__int64(GameState) + kGameStateSquadPlayerLists, SquadId);
            if (SquadList)
                ListAdd(SquadList, __int64(PlayerState));
        }

        auto Controller = IsLiveObject(Pawn->Controller) ? Pawn->Controller : nullptr;
        auto GameMode = GetGameMode();
        if (Controller && Controller->IsA(GLayout.AIBotControllerClass) && GameMode &&
            GameMode->HasAliveBots())
        {
            bool bListed = false;
            for (auto Alive : GameMode->AliveBots)
            {
                if (Alive == Controller)
                {
                    bListed = true;
                    break;
                }
            }
            if (!bListed)
                GameMode->AliveBots.Add(Controller);
        }

        ++GMatch.SpawnedBots;
        if (GMatch.SpawnedBots == 1 || GMatch.SpawnedBots % 10 == 0)
            BotsLog("%d bots spawned", GMatch.SpawnedBots);
    }

    bool RegisterSpawnedBotGuarded(UObject* Service, AActor* Actor) noexcept
    {
        struct FArgs
        {
            UObject* Service;
            AActor* Actor;
        } Args{ Service, Actor };
        return AIBase::Guarded([](void* Context)
            {
                auto& A = *static_cast<FArgs*>(Context);
                RegisterSpawnedBotUnsafe(A.Service, A.Actor);
            }, &Args);
    }

    void OnPlayerBotSpawnedDetour(UObject* Service, AActor* Actor, int32 SpawnRequestID, double PawnMMR)
    {
        GOnPlayerBotSpawnedOG(Service, Actor, SpawnRequestID, PawnMMR);
        if (GGate.load(std::memory_order_acquire) == (int)EGate::Active &&
            !RegisterSpawnedBotGuarded(Service, Actor))
            BotsLog("Error: registering a spawned bot failed");
    }

    // Artemis AthenaNavSystem.cpp:5-9: let the navigation system create the missing nav data the
    // client build doesn't load, so the bots can walk. The original returns the nav system.
    void* CreateAndConfigureNavSystemDetour(UObject* Config, UObject* World)
    {
        if (GGate.load(std::memory_order_acquire) == (int)EGate::Active && IsLiveObject(Config) &&
            Config->IsA(GLayout.NavConfigClass))
        {
            GetFromOffset<uint8>(Config, GLayout.NavConfigAutoSpawnByte) |= GLayout.NavConfigAutoSpawnMask;
        }
        return GCreateAndConfigureNavSystemOG(Config, World);
    }

    // Artemis FortAthenaAISpawnerDataComponent_AIBotCosmeticBase.cpp:5-11, which replaces the
    // native version. Niobium calls the game's version first and only fills in one of the default
    // outfits when bots are active and the game left the outfit empty; otherwise it is untouched.
    void GetLoadoutDetour(UObject* Component, void* OutLoadout)
    {
        GGetLoadoutOG(Component, OutLoadout);
        if (!OutLoadout || GGate.load(std::memory_order_acquire) != (int)EGate::Active)
            return;
        static std::vector<const UObject*> Characters;
        static bool bLoaded = false;
        if (!bLoaded)
        {
            bLoaded = true;
            static const wchar_t* const Paths[] = {
                L"/Game/Athena/Items/Cosmetics/Characters/CID_001_Athena_Commando_F_Default.CID_001_Athena_Commando_F_Default",
                L"/Game/Athena/Items/Cosmetics/Characters/CID_002_Athena_Commando_F_Default.CID_002_Athena_Commando_F_Default",
                L"/Game/Athena/Items/Cosmetics/Characters/CID_003_Athena_Commando_F_Default.CID_003_Athena_Commando_F_Default",
                L"/Game/Athena/Items/Cosmetics/Characters/CID_004_Athena_Commando_F_Default.CID_004_Athena_Commando_F_Default",
                L"/Game/Athena/Items/Cosmetics/Characters/CID_005_Athena_Commando_M_Default.CID_005_Athena_Commando_M_Default",
                L"/Game/Athena/Items/Cosmetics/Characters/CID_006_Athena_Commando_M_Default.CID_006_Athena_Commando_M_Default",
                L"/Game/Athena/Items/Cosmetics/Characters/CID_007_Athena_Commando_M_Default.CID_007_Athena_Commando_M_Default",
                L"/Game/Athena/Items/Cosmetics/Characters/CID_008_Athena_Commando_M_Default.CID_008_Athena_Commando_M_Default",
            };
            auto CharacterClass = FindClass("AthenaCharacterItemDefinition");
            for (auto Path : Paths)
            {
                if (auto Character = CharacterClass ? FindObject(Path, CharacterClass) : nullptr)
                    Characters.push_back(Character);
            }
            BotsLog("%d default outfits for bots", (int)Characters.size());
        }
        auto& Character = GetFromOffset<const UObject*>(OutLoadout, GLayout.LoadoutCharacter);
        if (!Character && !Characters.empty())
            Character = Characters[(size_t)rand() % Characters.size()];
    }

    // ------------------------------------------------------------------ Gate and hooks

    bool CheckBuild(std::string& Why)
    {
        if (!VersionInfo.bExactBuildIdentity || VersionInfo.FortniteChangelist != kChangelist)
        {
            Why = "build CL " + std::to_string(VersionInfo.FortniteChangelist) +
                (VersionInfo.bExactBuildIdentity ? "" : " (not read from the game)") +
                ", bots need " + std::to_string(kChangelist);
            return false;
        }

        wchar_t Path[MAX_PATH * 2] = {};
        const DWORD Length = GetModuleFileNameW(nullptr, Path, (DWORD)(sizeof(Path) / sizeof(Path[0])));
        WIN32_FILE_ATTRIBUTE_DATA Attributes{};
        if (!Length || Length >= sizeof(Path) / sizeof(Path[0]) ||
            !GetFileAttributesExW(Path, GetFileExInfoStandard, &Attributes))
        {
            Why = "the game file can't be checked";
            return false;
        }
        const uint64_t Size = ((uint64_t)Attributes.nFileSizeHigh << 32) | Attributes.nFileSizeLow;
        if (Size != kShippingExeSize)
        {
            Why = "the game file has " + std::to_string(Size) + " bytes, Epic's 19.10 file has " +
                std::to_string(kShippingExeSize);
            return false;
        }
        return true;
    }

    bool CheckCode(std::string& Why)
    {
        FImage Image;
        if (!ReadGameImage(Image, Why))
            return false;

        struct FFunctionCheck
        {
            uint32_t Rva;
            const char* Name;
        };
        const FFunctionCheck Functions[] = {
            { kRva::WaitForMatchAssignmentReady, "WaitForMatchAssignmentReady" },
            { kRva::OnPlayerBotSpawned, "OnPlayerBotSpawned" },
            { kRva::PlayerListFindOrAdd, "the team list lookup" },
            { kRva::PlayerListAdd, "the team list add" },
            { kRva::CreateAndConfigureNavSystem, "CreateAndConfigureNavSystem" },
            { kRva::AIBotEnterAircraft, "EnterAircraft" },
        };
        for (const auto& Function : Functions)
        {
            if (!CheckFunctionStart(Image, Function.Rva, Function.Name, Why))
                return false;
        }
        // The game's GetLoadout may be a small stub with no unwind entry (Artemis never calls it).
        if (!CheckFunctionStart(Image, kRva::AIBotCosmeticGetLoadout, "GetLoadout", Why, true))
            return false;
        if (!CheckLeaToFunction(Image, kRva::InitializeMMRInfosLea, Why))
            return false;

        if (!IsWritableData(Image, kRva::BotMaxSpawnAmountCVar, sizeof(int32)))
        {
            Why = "the bot limit setting (" + Hex(kRva::BotMaxSpawnAmountCVar) + ") is not in the game's data";
            return false;
        }
        const int32 BotMaxSpawnAmount = *reinterpret_cast<const int32*>(Image.Base + kRva::BotMaxSpawnAmountCVar);
        if (BotMaxSpawnAmount < -1 || BotMaxSpawnAmount > 1000)
        {
            Why = "the bot limit setting holds " + std::to_string(BotMaxSpawnAmount);
            return false;
        }
        return true;
    }

    bool InstallHooks(std::string& Why)
    {
        struct FHook
        {
            uint32_t Rva;
            void* Detour;
            void** Original;
            const char* Name;
        };
        const FHook Hooks[] = {
            { kRva::WaitForMatchAssignmentReady, reinterpret_cast<void*>(WaitForMatchAssignmentReadyDetour),
                reinterpret_cast<void**>(&GWaitForMatchAssignmentReadyOG), "WaitForMatchAssignmentReady" },
            { kRva::OnPlayerBotSpawned, reinterpret_cast<void*>(OnPlayerBotSpawnedDetour),
                reinterpret_cast<void**>(&GOnPlayerBotSpawnedOG), "OnPlayerBotSpawned" },
            { kRva::CreateAndConfigureNavSystem, reinterpret_cast<void*>(CreateAndConfigureNavSystemDetour),
                reinterpret_cast<void**>(&GCreateAndConfigureNavSystemOG), "CreateAndConfigureNavSystem" },
            { kRva::AIBotCosmeticGetLoadout, reinterpret_cast<void*>(GetLoadoutDetour),
                reinterpret_cast<void**>(&GGetLoadoutOG), "GetLoadout" },
        };

        std::vector<LPVOID> Created;
        auto Rollback = [&]()
        {
            for (auto Target : Created)
                MH_RemoveHook(Target);
        };

        for (const auto& Hook : Hooks)
        {
            const auto Target = reinterpret_cast<LPVOID>(ImageBase + Hook.Rva);
            const MH_STATUS Status = MH_CreateHook(Target, Hook.Detour, Hook.Original);
            if (Status != MH_OK || (Hook.Original && !*Hook.Original))
            {
                Why = std::string("hooking ") + Hook.Name + " failed (" + MH_StatusToString(Status) + ")";
                if (Status == MH_OK)
                    MH_RemoveHook(Target);
                Rollback();
                return false;
            }
            Created.push_back(Target);
        }

        if (!PatchLeaTarget(reinterpret_cast<uint8_t*>(ImageBase + kRva::InitializeMMRInfosLea),
                reinterpret_cast<void*>(InitializeMMRInfosReplacement)))
        {
            Why = "patching InitializeMMRInfos failed";
            Rollback();
            return false;
        }
        // Main() enables every created hook with MH_EnableHook(MH_ALL_HOOKS) after this.
        return true;
    }

    void Gate()
    {
        if (!FConfiguration::bPlayerBots.load(std::memory_order_acquire))
            return; // bots off: today's behaviour, nothing is touched and nothing is sent

        char Version[32];
        snprintf(Version, sizeof(Version), "%.2f", VersionInfo.FortniteVersion);
        if (std::fabs(VersionInfo.FortniteVersion - kFortniteVersion) > 0.001)
        {
            Disable(VersionInfo.FortniteVersion < 11.00 ? kReasonNoBotsInVersion : kReasonNotYet,
                std::string("this is Fortnite ") + Version + ", bots need 19.10");
            return;
        }

        std::string Why;
        if (!CheckBuild(Why))
        {
            Disable(kReasonWrongCopy, "build doesn't match: " + Why);
            return;
        }
        if (!CheckLayouts(Why))
        {
            Disable(kReasonWrongCopy, "layout check failed: " + Why);
            return;
        }
        if (!CheckCode(Why))
        {
            Disable(kReasonWrongCopy, "code check failed: " + Why);
            return;
        }
        if (!InstallHooks(Why))
        {
            Disable(kReasonWrongCopy, Why);
            return;
        }

        GGate.store((int)EGate::Active, std::memory_order_release);
        BotsLog("checks passed for 19.10 CL %llu, hooks installed; %d bots, ELO %d",
            (unsigned long long)kChangelist, ClampedBotCount(), ClampedTargetELO());
        // Still in the hook phase, before the map loads: no bot can possess a pawn yet. Needs the
        // gate to be Active (AIBase::IsAnyAIFeatureActive), so it comes after the store above.
        AIBase::EnsureStandaloneCheckOff();
    }

    // ------------------------------------------------------------------ Game mode work

    // Artemis FortGameModeAthena.cpp:38-40.
    void ApplyAISettings(AFortGameMode* GameMode, const UFortPlaylistAthena* Playlist)
    {
        if (GMatch.AppliedGameMode == GameMode)
            return;
        GMatch = FMatchState{}; // a new match (the server can restart matches in one process)
        GMatch.AppliedGameMode = GameMode;

        const auto& L = GLayout;
        auto& GameModeSettings = GetFromOffset<UObject*>(GameMode, L.GameModeAISettings);
        UObject* Settings = IsLiveObject(Playlist)
            ? GetFromOffset<UObject*>(Playlist, L.PlaylistAISettings) : nullptr;
        if (!IsLiveObject(Settings))
            Settings = IsLiveObject(GameModeSettings) ? GameModeSettings : nullptr;
        if (!Settings || !Settings->IsA(L.SettingsClass))
        {
            Disable(kReasonPlaylist, "the playlist has no AI settings");
            return;
        }

        auto& Services = GetFromOffset<TArray<const UClass*>>(Settings, L.SettingsAIServices);
        if (Services.Num() < 0 || Services.Num() > 64)
        {
            Disable(kReasonPlaylist, "the playlist's AI service list is broken");
            return;
        }
        bool bHasPlayerBots = false;
        for (int32 Index = 0; Index < Services.Num(); ++Index)
        {
            if (IsLiveObject(Services[Index]) && IsChildOfClass(Services[Index], L.ServiceClass))
                bHasPlayerBots = true;
        }
        if (!bHasPlayerBots)
        {
            if (Services.Num() >= 2)
            {
                BotsLog("AI service slot 2 was %s, now AthenaAIServicePlayerBots",
                    IsLiveObject(Services[1]) ? Services[1]->Name.ToString().c_str() : "empty");
                Services[1] = L.ServiceClass;
            }
            else
            {
                Services.Add(L.ServiceClass);
            }
        }
        GameModeSettings = Settings;

        BotsLog("service set up, %d bots, ELO %d (playlist %s)", ClampedBotCount(),
            ClampedTargetELO(), IsLiveObject(Playlist) ? Playlist->Name.ToString().c_str() : "?");
        NiobiumControl::EmitPlayerBots("active", "");
    }

    bool ApplyAISettingsGuarded(AFortGameMode* GameMode, const UFortPlaylistAthena* Playlist) noexcept
    {
        struct FArgs
        {
            AFortGameMode* GameMode;
            const UFortPlaylistAthena* Playlist;
        } Args{ GameMode, Playlist };
        return AIBase::Guarded([](void* Context)
            {
                auto& A = *static_cast<FArgs*>(Context);
                ApplyAISettings(A.GameMode, A.Playlist);
            }, &Args);
    }

    bool ContainsLocationTag(UObject* Volume, const uint8* Tag)
    {
        static UFunction* Function = nullptr;
        static int32 TagOffset = -1;
        static int32 ReturnOffset = -1;
        static int32 ParamsSize = 0;
        if (!Function)
        {
            Function = Volume->GetFunction("ContainsLocationTag");
            if (!Function)
                return false;
            TagOffset = OffsetOf(Function, "Tag");
            ReturnOffset = OffsetOf(Function, "ReturnValue");
            ParamsSize = Function->GetPropertiesSize();
        }
        if (TagOffset < 0 || ReturnOffset < 0 || ParamsSize <= ReturnOffset || ParamsSize > 0x100 ||
            GLayout.GameplayTagSize <= 0 || TagOffset + GLayout.GameplayTagSize > ParamsSize)
        {
            return false;
        }
        uint8 Params[0x100] = {};
        memcpy(Params + TagOffset, Tag, GLayout.GameplayTagSize);
        Volume->ProcessEvent(Function, Params);
        return Params[ReturnOffset] != 0;
    }

    // Artemis FortGameModeAthena.cpp:120-184: the bus and on-foot POI lists the service picks
    // landing spots from, and the building foundations. Done once per match, when the POI
    // volumes exist.
    bool CachePOIsUnsafe(UObject* Service)
    {
        const auto& L = GLayout;
        TArray<AActor*> Volumes;
        Utils::GetAll(L.PoiVolumeClass, Volumes);
        if (Volumes.Num() <= 0)
        {
            Volumes.Free();
            return false;
        }

        // Lists the game already filled are left alone, so nothing is added twice.
        auto& Cached = GetFromOffset<TArray<FCachedPOIVolumeLocations1910>>(Service,
            L.ServiceCachedValidPOIVolumeLocations);
        const bool bFillLocations = Cached.Num() == 0;
        for (auto Volume : Volumes)
        {
            if (!bFillLocations || !IsLiveObject(Volume))
                continue;
            FCachedPOIVolumeLocations1910 Location{};
            Location.bEQSQueryPending = 0;
            auto Position = Volume->K2_GetActorLocation();
            Location.NavMeshLocations.Add(FVector3f{ (float)Position.X, (float)Position.Y, (float)Position.Z });
            Location.POIVolume = Volume;
            Cached.Add(Location);
        }

        auto FillList = [&](int32 ListOffset, int32 ElementSize, int32 QueryOffset, int32 ValidOffset)
        {
            if (ListOffset < 0 || ElementSize <= 0 || QueryOffset < 0 || ValidOffset < 0 ||
                L.TagQueryTagDictionary < 0)
            {
                return;
            }
            auto& List = GetFromOffset<TArray<uint8>>(Service, ListOffset);
            for (int32 Index = 0; Index < List.Num(); ++Index)
            {
                auto Entry = reinterpret_cast<uint8*>(List.GetData()) + (size_t)Index * ElementSize;
                auto& Tags = GetFromOffset<TArray<uint8>>(Entry + QueryOffset, L.TagQueryTagDictionary);
                if (Tags.Num() <= 0 || !Tags.GetData())
                    continue;
                auto& Valid = GetFromOffset<TArray<AActor*>>(Entry, ValidOffset);
                if (Valid.Num() != 0)
                    continue;
                for (auto Volume : Volumes)
                {
                    if (IsLiveObject(Volume) && ContainsLocationTag(Volume, Tags.GetData()))
                        Valid.Add(Volume);
                }
            }
        };
        FillList(L.ServiceOnGroundTagQueryPOIList, L.NavigationPOISize, L.NavigationPOIFilterQuery,
            L.NavigationPOIValidList);
        FillList(L.ServiceBattleBusTagQueryPOIList, L.BattleBusPOISize, L.BattleBusPOIFilterQuery,
            L.BattleBusPOIValidList);
        FillList(L.ServiceSecondaryBattleBusTagQueryPOIList, L.BattleBusPOISize,
            L.BattleBusPOIFilterQuery, L.BattleBusPOIValidList);

        TArray<AActor*> Foundations;
        Utils::GetAll(ABuildingFoundation::StaticClass(), Foundations);
        auto& CachedFoundations = GetFromOffset<TArray<AActor*>>(Service, L.ServiceCachedBuildingFoundations);
        const bool bFillFoundations = CachedFoundations.Num() == 0;
        for (auto Foundation : Foundations)
        {
            if (bFillFoundations && IsLiveObject(Foundation))
                CachedFoundations.Add(Foundation);
        }

        BotsLog("cached %d POI volumes and %d foundations", Volumes.Num(), Foundations.Num());
        Volumes.Free();
        Foundations.Free();
        return true;
    }

    int CachePOIsGuarded(UObject* Service) noexcept
    {
        struct FArgs
        {
            UObject* Service;
            int Result;
        } Args{ Service, 0 };
        if (!AIBase::Guarded([](void* Context)
                {
                    auto& A = *static_cast<FArgs*>(Context);
                    A.Result = CachePOIsUnsafe(A.Service) ? 1 : 0;
                }, &Args))
        {
            return -1;
        }
        return Args.Result;
    }

    // Artemis AthenaAIServicePlayerBots.cpp:282-293 (48dba08, "ais jumping from bus").
    void PutBotsInAircraftUnsafe(AFortGameStateAthena* GameState)
    {
        auto Service = GMatch.Service.Get();
        if (!IsLiveObject(Service))
        {
            BotsLog("Error: no bot service when the bus started");
            return;
        }
        if (!IsLiveObject(GetFromOffset<UObject*>(Service, GLayout.ServiceCachedAIPopulationTracker)))
        {
            BotsLog("Error: the bot service has no population tracker, bots stay on the island");
            return;
        }
        if (!GameState->HasAircrafts() || GameState->Aircrafts.Num() <= 0 ||
            !IsLiveObject(GameState->Aircrafts[0]))
        {
            BotsLog("Error: no bus found for the bots");
            return;
        }

        static auto EnterAircraft = reinterpret_cast<FEnterAircraft>(ImageBase + kRva::AIBotEnterAircraft);
        auto Aircraft = (AActor*)GameState->Aircrafts[0];
        auto& Bots = GetFromOffset<TArray<FFortServerBotInfo1910>>(Service, GLayout.ServicePlayerBots);
        int32 Boarded = 0;
        for (int32 Index = 0; Index < Bots.Num(); ++Index)
        {
            auto Controller = Bots[Index].BotController;
            if (!IsLiveObject(Controller) || !Controller->IsA(GLayout.AIBotControllerClass))
                continue;
            EnterAircraft(Controller, Aircraft);
            ++Boarded;
        }
        BotsLog("%d bots got on the bus", Boarded);
    }

    bool PutBotsInAircraftGuarded(AFortGameStateAthena* GameState) noexcept
    {
        return AIBase::Guarded([](void* Context)
            { PutBotsInAircraftUnsafe(static_cast<AFortGameStateAthena*>(Context)); }, GameState);
    }

    // AController::Pawn, read through reflection (AI bot controllers are no player controllers).
    UObject* GetControllerPawn(const UObject* Controller)
    {
        static int32 PawnOffset = -2;
        if (PawnOffset == -2)
            PawnOffset = OffsetOf(FindClass("Controller"), "Pawn");
        if (PawnOffset < 0 || !IsLiveObject(Controller))
            return nullptr;
        auto Pawn = GetFromOffset<UObject*>(Controller, PawnOffset);
        return IsLiveObject(Pawn) ? Pawn : nullptr;
    }

    // A bot whose pawn is dying. Bots on the bus or between two pawns have no pawn and count as
    // alive.
    bool IsBotDead(const UObject* Controller)
    {
        auto Pawn = GetControllerPawn(Controller);
        auto PlayerPawn = Pawn ? Pawn->Cast<AFortPlayerPawnAthena>() : nullptr;
        if (!PlayerPawn)
            return false;
        return (PlayerPawn->HasbIsDying() && PlayerPawn->bIsDying) ||
            (PlayerPawn->HasbPlayedDying() && PlayerPawn->bPlayedDying);
    }

    // Removes destroyed bot controllers from GameMode->AliveBots and, once the bus has started
    // (bots killed in warmup come back), bots whose pawn is dying, in case the game's own
    // elimination code doesn't (our player-count and match-end code reads this list).
    void PruneAliveBotsUnsafe(AFortGameMode* GameMode, bool bRemoveDying)
    {
        if (!GameMode->HasAliveBots())
            return;
        auto& AliveBots = GameMode->AliveBots;
        const int32 Before = AliveBots.Num();
        for (int32 Index = AliveBots.Num() - 1; Index >= 0; --Index)
        {
            auto Bot = AliveBots[Index];
            if (!IsLiveObject(Bot) || (bRemoveDying && IsBotDead(Bot)))
                AliveBots.Remove(Index);
        }
        if (GMatch.SpawnedBots > 0 && Before > 0 && AliveBots.Num() == 0 && !GMatch.bAllBotsOutLogged)
        {
            GMatch.bAllBotsOutLogged = true;
            BotsLog("all bots are out");
        }
    }

    bool PruneAliveBotsGuarded(AFortGameMode* GameMode, bool bRemoveDying) noexcept
    {
        struct FArgs
        {
            AFortGameMode* GameMode;
            bool bRemoveDying;
        } Args{ GameMode, bRemoveDying };
        return AIBase::Guarded([](void* Context)
            {
                auto& A = *static_cast<FArgs*>(Context);
                PruneAliveBotsUnsafe(A.GameMode, A.bRemoveDying);
            }, &Args);
    }
}

class FPlayerBots1910Hooks
{
public:
    InitHooks;
};

// Runs in Main() after "Start match", when the launcher's bot settings are final, and before the
// map loads (the nav system hook must be in before the world is created).
void FPlayerBots1910Hooks::Hook()
{
    Gate();
}

namespace PlayerBots1910
{
    bool IsActive()
    {
        return GGate.load(std::memory_order_acquire) == (int)EGate::Active;
    }

    bool IsAIBotController(const UObject* Controller)
    {
        return IsActive() && GLayout.AIBotControllerClass && IsLiveObject(Controller) &&
            Controller->IsA(GLayout.AIBotControllerClass);
    }

    void OnSetupPlaylist(AFortGameMode* GameMode, const UFortPlaylistAthena* Playlist)
    {
        if (!IsActive() || !IsLiveObject(GameMode))
            return;
        if (!ApplyAISettingsGuarded(GameMode, Playlist))
            Disable(kReasonWrongCopy, "setting up the bot service failed");
    }

    void OnFinishWorldInitialization(AFortGameMode* GameMode)
    {
        if (!IsActive() || !IsLiveObject(GameMode) || GMatch.AppliedGameMode == GameMode)
            return;
        // The same playlist SetupPlaylist (FortGameMode.cpp) publishes.
        auto Playlist = FindObject<UFortPlaylistAthena>(FConfiguration::Playlist);
        if (!Playlist)
            Playlist = FindObject<UFortPlaylistAthena>(
                L"/Game/Athena/Playlists/Playlist_DefaultSolo.Playlist_DefaultSolo");
        OnSetupPlaylist(GameMode, Playlist);
    }

    void OnAircraftPhaseStarted(AFortGameMode* GameMode, AFortGameStateAthena* GameState)
    {
        if (!IsActive() || GMatch.bAircraftDone || !IsLiveObject(GameState))
            return;
        GMatch.bAircraftDone = true;
        if (!PutBotsInAircraftGuarded(GameState))
            BotsLog("Error: putting the bots on the bus failed");
    }

    void GameThreadTick()
    {
        if (!IsActive())
            return;
        const ULONGLONG Now = GetTickCount64();
        if (Now - GMatch.LastTickMs < 500)
            return;
        GMatch.LastTickMs = Now;

        auto GameMode = GetGameMode();
        if (!GameMode)
            return;

        auto World = UWorld::GetWorld();
        auto Service = GMatch.Service.Get();
        auto GameState = IsLiveObject(GameMode->GameState) ? GameMode->GameState : nullptr;
        const int32 GamePhase = GameState && GameState->HasGamePhase() ? GameState->GamePhase : -1;

        // EAthenaGamePhase::Aircraft = 3: from the bus on, a dying bot is out for good.
        if (!PruneAliveBotsGuarded(GameMode, GamePhase >= 3))
            BotsLog("Error: cleaning up the alive bot list failed");
        // Like Artemis (first player spawn): once warmup runs, when the POI levels are in.
        const bool bWarmupOrLater = GamePhase < 0 || GamePhase >= 2;
        if (IsLiveObject(Service) && bWarmupOrLater && GMatch.POIWorld != World &&
            GMatch.POIAttempts < 120)
        {
            ++GMatch.POIAttempts;
            const int Result = CachePOIsGuarded(Service);
            if (Result != 0)
                GMatch.POIWorld = World;
            if (Result < 0)
                BotsLog("Error: caching the POIs for the bots failed");
        }

        if (GamePhase >= 3 && !GMatch.bServiceStarted && !GMatch.bWarnedNoService)
        {
            GMatch.bWarnedNoService = true;
            BotsLog("Error: the bus started but the bot service never ran, so no bots spawned");
        }
    }
}
