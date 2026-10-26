// NIOBIUM: "Reset builds" (server half) - Niobium's own code (GPL-3.0), not part of Magnesium.
// See ../Public/QuickReset.h for the wire format and the rules.
#include "pch.h"

#include "../Public/QuickReset.h"
#include "../Public/Configuration.h"
#include <FortniteGame/Public/FortPlayerControllerAthena.h>
#include <FortniteGame/Public/FortPlayerPawnAthena.h>
#include <FortniteGame/Public/FortPlayerStateAthena.h>
#include <FortniteGame/Public/FortGameStateAthena.h>
#include <FortniteGame/Public/FortPlaylistAthena.h>
#include <FortniteGame/Public/BuildingSMActor.h>

#include <Windows.h>
#include <cmath>
#include <cstdio>
#include <unordered_map>

// FortPlayerControllerAthena.cpp: the address FindReplaceBuildingActor() found at startup.
extern uint64_t ReplaceBuildingActor_;

namespace
{
    // ---- Wire format (must equal native/client/ATLAS/Public/QuickReset.h) ----------------------
    constexpr char kFamilyPrefix[] = "nbedit:";          // everything with this prefix is ours
    constexpr size_t kFamilyPrefixLength = 7;
    constexpr char kPrefix[] = "nbedit:v1:";
    constexpr size_t kPrefixLength = 10;
    constexpr size_t kSessionDigits = 16;
    constexpr size_t kSequenceDigits = 8;
    constexpr size_t kHelloLength = kPrefixLength + 2 + kSessionDigits;                      // 28
    constexpr size_t kArmLength = kPrefixLength + 2 + kSessionDigits + 1 + kSequenceDigits;  // 37
    static_assert(sizeof(kFamilyPrefix) - 1 == kFamilyPrefixLength, "family prefix length");
    static_assert(sizeof(kPrefix) - 1 == kPrefixLength, "prefix length");
    static_assert(kHelloLength == 28 && kArmLength == 37, "wire lengths");

    // ---- Server rules ------------------------------------------------------------------------
    constexpr ULONGLONG kArmLifetimeMs = 1000;       // the arm is one-shot and expires after this
    constexpr ULONGLONG kMinAckIntervalMs = 1000;    // one ack per controller per second
    constexpr ULONGLONG kMinResetIntervalMs = 80;    // one reset per controller every 80 ms
    constexpr double kMaxResetDistance = 2048.0;     // abuse cap only (uu); the client aims
    constexpr size_t kMaxPlayers = 256;

    // EFortBuildingType: Wall 0, Floor 1, Stairs 5, Roof 6. EFortResourceType: Wood 0, Stone 1, Metal 2.
    constexpr uint8 kTypeWall = 0;
    constexpr uint8 kTypeFloor = 1;
    constexpr uint8 kTypeStairs = 5;
    constexpr uint8 kTypeRoof = 6;
    constexpr int kTypeCount = 4;
    constexpr int kResourceCount = 3;

    int TypeSlot(uint8 BuildingType)
    {
        switch (BuildingType)
        {
        case kTypeWall: return 0;
        case kTypeFloor: return 1;
        case kTypeStairs: return 2;
        case kTypeRoof: return 3;
        default: return -1;
        }
    }

    constexpr uint8 kSlotType[kTypeCount] = { kTypeWall, kTypeFloor, kTypeStairs, kTypeRoof };
    constexpr const char* kSlotName[kTypeCount] = { "wall", "floor", "ramp", "roof" };
    constexpr const char* kResourceName[kResourceCount] = { "wood", "stone", "metal" };

    // Method A: the default edit pattern of each piece (Reboot 3.0 uses the same four).
    constexpr const wchar_t* kPatternPath[kTypeCount] = {
        L"/Game/Building/EditModePatterns/Wall/EMP_Wall_Solid.EMP_Wall_Solid",
        L"/Game/Building/EditModePatterns/Floor/EMP_Floor_Floor.EMP_Floor_Floor",
        L"/Game/Building/EditModePatterns/Stair/EMP_Stair_StairW.EMP_Stair_StairW",
        L"/Game/Building/EditModePatterns/Roof/EMP_Roof_RoofC.EMP_Roof_RoofC",
    };

    // Method B: the unedited player-built classes, per material and piece.
    constexpr const wchar_t* kClassPath[kResourceCount][kTypeCount] = {
        {
            L"/Game/Building/ActorBlueprints/Player/Wood/L1/PBWA_W1_Solid.PBWA_W1_Solid_C",
            L"/Game/Building/ActorBlueprints/Player/Wood/L1/PBWA_W1_Floor.PBWA_W1_Floor_C",
            L"/Game/Building/ActorBlueprints/Player/Wood/L1/PBWA_W1_StairW.PBWA_W1_StairW_C",
            L"/Game/Building/ActorBlueprints/Player/Wood/L1/PBWA_W1_RoofC.PBWA_W1_RoofC_C",
        },
        {
            L"/Game/Building/ActorBlueprints/Player/Stone/L1/PBWA_S1_Solid.PBWA_S1_Solid_C",
            L"/Game/Building/ActorBlueprints/Player/Stone/L1/PBWA_S1_Floor.PBWA_S1_Floor_C",
            L"/Game/Building/ActorBlueprints/Player/Stone/L1/PBWA_S1_StairW.PBWA_S1_StairW_C",
            L"/Game/Building/ActorBlueprints/Player/Stone/L1/PBWA_S1_RoofC.PBWA_S1_RoofC_C",
        },
        {
            L"/Game/Building/ActorBlueprints/Player/Metal/L1/PBWA_M1_Solid.PBWA_M1_Solid_C",
            L"/Game/Building/ActorBlueprints/Player/Metal/L1/PBWA_M1_Floor.PBWA_M1_Floor_C",
            L"/Game/Building/ActorBlueprints/Player/Metal/L1/PBWA_M1_StairW.PBWA_M1_StairW_C",
            L"/Game/Building/ActorBlueprints/Player/Metal/L1/PBWA_M1_RoofC.PBWA_M1_RoofC_C",
        },
    };

    // ---- Per-player state (game thread only) ---------------------------------------------------
    struct FPlayer
    {
        uint64_t ControllerIdentity = 0;
        uint64_t WorldIdentity = 0;
        uint64_t Session = 0;        // acked session, 0 = none
        uint32_t LastSequence = 0;   // last accepted arm sequence for Session
        ULONGLONG NextAckAt = 0;
        ULONGLONG ArmedAt = 0;
        uint32_t ArmedSequence = 0;
        bool bArmed = false;
        bool bLoggedRefusal = false;
        ULONGLONG LastResetAt = 0;
        ULONGLONG LastActivityAt = 0;
    };

    struct FClassCache
    {
        uint64_t WorldIdentity = 0;
        const UClass* Classes[kResourceCount][kTypeCount]{};
        uint64_t ClassIdentity[kResourceCount][kTypeCount]{};
        bool bLoadAttempted = false;
        bool bProbeLogged = false;
    };

    std::unordered_map<AFortPlayerControllerAthena*, FPlayer> GPlayers;
    FClassCache GClassCache;

    template <typename... TArgs>
    void ProbeLog(const char* Format, TArgs... Args)
    {
        if constexpr (QuickReset::kProbeLog)
        {
            printf("[reset-builds] ");
            printf(Format, Args...);
            printf("\n");
        }
    }

    // ---- Object helpers ----------------------------------------------------------------------
    uint64_t ObjectIdentityUnsafe(const UObject* Object)
    {
        if (!Object || !SDK::MemReadable(Object, sizeof(UObject)))
            return 0;
        const int32 Index = Object->Index;
        if (Index < 0 || Index >= TUObjectArray::Num())
            return 0;
        auto Item = TUObjectArray::GetItemByIndex(Index);
        constexpr int32 InvalidFlags = 0x20;
        if (!Item || Item->GetObject() != Object || (Item->GetFlags() & InvalidFlags) ||
            !Object->Class || !SDK::MemReadable(Object->Class, sizeof(UClass)))
        {
            return 0;
        }
        return (static_cast<uint64_t>(static_cast<uint32_t>(Index)) << 32) |
            static_cast<uint32_t>(Item->SerialRef());
    }

    uint64_t ObjectIdentity(const UObject* Object) noexcept
    {
        __try
        {
            return ObjectIdentityUnsafe(Object);
        }
        __except (EXCEPTION_EXECUTE_HANDLER)
        {
            return 0;
        }
    }

    bool IsLive(const UObject* Object) noexcept
    {
        return ObjectIdentity(Object) != 0;
    }

    const char* ClassName(const UObject* Object)
    {
        // Short-lived: only for one printf. Kept in a static buffer so the caller needs no string.
        static char Buffer[160];
        Buffer[0] = '\0';
        if (!IsLive(Object))
        {
            strcpy_s(Buffer, "none");
            return Buffer;
        }
        const auto Name = Object->Name.ToString();
        strncpy_s(Buffer, Name.c_str(), _TRUNCATE);
        return Buffer;
    }

    const UObject* FindLoadedObjectUnsafe(const wchar_t* Path, const UClass* Class)
    {
        return SDK::Offsets::StaticFindObject ? SDK::StaticFindObject(Path, Class) : nullptr;
    }

    // Never loads anything: only objects the game already has in memory.
    const UObject* FindLoadedObject(const wchar_t* Path, const UClass* Class) noexcept
    {
        __try
        {
            return FindLoadedObjectUnsafe(Path, Class);
        }
        __except (EXCEPTION_EXECUTE_HANDLER)
        {
            return nullptr;
        }
    }

    const UObject* LoadObjectOnceUnsafe(const wchar_t* Path, const UClass* Class)
    {
        return SDK::Offsets::StaticLoadObject ? SDK::StaticLoadObject(Path, Class) : nullptr;
    }

    const UObject* LoadObjectOnce(const wchar_t* Path, const UClass* Class) noexcept
    {
        __try
        {
            return LoadObjectOnceUnsafe(Path, Class);
        }
        __except (EXCEPTION_EXECUTE_HANDLER)
        {
            return nullptr;
        }
    }

    bool FortniteVersionAllowsFeature()
    {
        const double Version = VersionInfo.FortniteVersion;
        if (!(Version > 0.0))
            return false;
        return std::llround(Version * 100.0) < std::llround(QuickReset::kEpicResetBuildingSince * 100.0);
    }

    // Off when: Epic owns the key (37.00+), the replace function wasn't found, or the host
    // turned it off. The class self-test is checked separately at the hello.
    const char* UnavailableReason()
    {
        if (!FortniteVersionAllowsFeature())
            return "Fortnite 37.00+ has its own Reset Building key";
        if (!ReplaceBuildingActor_)
            return "ReplaceBuildingActor not found";
        if (!FConfiguration::bAllowResetBuilds.load(std::memory_order_acquire))
            return "turned off by the host";
        return nullptr;
    }

    AFortGameStateAthena* GetGameState()
    {
        auto World = UWorld::GetWorld();
        if (!IsLive(World))
            return nullptr;
        auto GameState = (AFortGameStateAthena*)World->GameState;
        return IsLive(GameState) ? GameState : nullptr;
    }

    // ---- Unedited class lookup -----------------------------------------------------------------
    const UObject* EditModePatternOf(const ABuildingSMActor* Default)
    {
        if (Default->HasEditModePatternData())
            return Default->EditModePatternData;
        if (!GetSparseClassData_)
            return nullptr;
        auto ClassData = Default->GetClassData();
        return ClassData ? ClassData->EditModePatternData : nullptr;
    }

    bool IsUneditedClassFor(const UClass* Class, int Resource, int Slot)
    {
        if (!IsLive(Class) || !UClass::StaticClass() || !Class->IsA(UClass::StaticClass()))
            return false;
        auto Default = (const ABuildingSMActor*)Class->GetDefaultObj();
        if (!IsLive(Default) || !Default->IsA<ABuildingSMActor>())
            return false;
        if (!Default->HasbIsPlayerBuildable() || !Default->bIsPlayerBuildable)
            return false;
        if (!Default->HasBuildingType() || Default->BuildingType != kSlotType[Slot])
            return false;
        if (!Default->HasResourceType() || static_cast<int>(Default->ResourceType) != Resource)
            return false;
        return true;
    }

    // Method A (8.x+, where the game state lists every player-buildable class): match material,
    // piece type and the default edit pattern, the same walk ServerCreateBuildingAndSpawnDeco uses.
    const UClass* ResolveByPattern(int Resource, int Slot)
    {
        auto GameState = GetGameState();
        if (!GameState || !GameState->HasAllPlayerBuildableClasses())
            return nullptr;
        const UObject* Pattern = FindLoadedObject(kPatternPath[Slot], nullptr);
        if (!IsLive(Pattern))
            return nullptr;
        for (auto& Class : GameState->AllPlayerBuildableClasses)
        {
            const UClass* Candidate = Class;
            if (!IsLive(Candidate))
                continue;
            auto Default = (const ABuildingSMActor*)Candidate->GetDefaultObj();
            if (!IsLive(Default) || !Default->IsA<ABuildingSMActor>())
                continue;
            if (static_cast<int>(Default->ResourceType) != Resource ||
                Default->BuildingType != kSlotType[Slot])
            {
                continue;
            }
            if (EditModePatternOf(Default) == Pattern)
                return Candidate;
        }
        return nullptr;
    }

    // Method B (every version): the known class path.
    const UClass* ResolveByPath(int Resource, int Slot)
    {
        if (!UClass::StaticClass())
            return nullptr;
        return (const UClass*)FindLoadedObject(kClassPath[Resource][Slot], UClass::StaticClass());
    }

    void SyncClassCacheWorld()
    {
        const uint64_t WorldIdentity = ObjectIdentity(UWorld::GetWorld());
        if (GClassCache.WorldIdentity != WorldIdentity)
        {
            GClassCache = {};
            GClassCache.WorldIdentity = WorldIdentity;
        }
    }

    // Never loads assets. Cached per (material, piece) for this world.
    const UClass* ResolveUneditedClass(int Resource, int Slot)
    {
        if (Resource < 0 || Resource >= kResourceCount || Slot < 0 || Slot >= kTypeCount)
            return nullptr;
        SyncClassCacheWorld();

        const UClass* Cached = GClassCache.Classes[Resource][Slot];
        if (Cached && ObjectIdentity(Cached) == GClassCache.ClassIdentity[Resource][Slot])
            return Cached;
        GClassCache.Classes[Resource][Slot] = nullptr;
        GClassCache.ClassIdentity[Resource][Slot] = 0;

        const UClass* Result = ResolveByPattern(Resource, Slot);
        if (!IsUneditedClassFor(Result, Resource, Slot))
            Result = ResolveByPath(Resource, Slot);
        if (!IsUneditedClassFor(Result, Resource, Slot))
            return nullptr;

        GClassCache.Classes[Resource][Slot] = Result;
        GClassCache.ClassIdentity[Resource][Slot] = ObjectIdentity(Result);
        return Result;
    }

    // Hello-time only, once per world: if a default class isn't in memory yet (old builds load
    // them on first use), load it now so the reset path never has to.
    void EnsureDefaultClassesLoadedOnce()
    {
        SyncClassCacheWorld();
        if (GClassCache.bLoadAttempted || !UClass::StaticClass())
            return;
        GClassCache.bLoadAttempted = true;
        for (int Resource = 0; Resource < kResourceCount; ++Resource)
        {
            for (int Slot = 0; Slot < kTypeCount; ++Slot)
            {
                if (ResolveUneditedClass(Resource, Slot))
                    continue;
                LoadObjectOnce(kClassPath[Resource][Slot], UClass::StaticClass());
            }
        }
    }

    // P2: method A vs method B for 3 materials x 4 pieces, once per world at the first hello.
    void LogClassProbeOnce()
    {
        if constexpr (!QuickReset::kProbeLog)
            return;
        SyncClassCacheWorld();
        if (GClassCache.bProbeLogged)
            return;
        GClassCache.bProbeLogged = true;

        auto GameState = GetGameState();
        ProbeLog("P2 class lookup: method A %s", GameState && GameState->HasAllPlayerBuildableClasses()
            ? "available" : "not available on this version");
        for (int Resource = 0; Resource < kResourceCount; ++Resource)
        {
            for (int Slot = 0; Slot < kTypeCount; ++Slot)
            {
                const UClass* ByPattern = ResolveByPattern(Resource, Slot);
                const UClass* ByPath = ResolveByPath(Resource, Slot);
                const UClass* Chosen = ResolveUneditedClass(Resource, Slot);
                int Type = -1, Res = -1, Buildable = -1;
                if (IsLive(Chosen))
                {
                    auto Default = (const ABuildingSMActor*)Chosen->GetDefaultObj();
                    if (IsLive(Default) && Default->IsA<ABuildingSMActor>())
                    {
                        Type = Default->BuildingType;
                        Res = static_cast<int>(Default->ResourceType);
                        Buildable = Default->HasbIsPlayerBuildable() ? (Default->bIsPlayerBuildable ? 1 : 0) : -1;
                    }
                }
                char NameA[160], NameB[160];
                strcpy_s(NameA, ClassName(ByPattern));
                strcpy_s(NameB, ClassName(ByPath));
                ProbeLog("P2 %s %s: A=%s B=%s agree=%d chosen=%s type=%d resource=%d buildable=%d",
                    kResourceName[Resource], kSlotName[Slot], NameA, NameB,
                    ByPattern && ByPattern == ByPath ? 1 : 0, ClassName(Chosen), Type, Res, Buildable);
            }
        }
    }

    // ---- Parsing -----------------------------------------------------------------------------
    // Lowercase hex only, exactly Digits characters.
    bool ParseLowerHex(const char* Text, size_t Digits, uint64_t& Value)
    {
        Value = 0;
        for (size_t Index = 0; Index < Digits; ++Index)
        {
            const char Character = Text[Index];
            int Digit = -1;
            if (Character >= '0' && Character <= '9')
                Digit = Character - '0';
            else if (Character >= 'a' && Character <= 'f')
                Digit = 10 + (Character - 'a');
            if (Digit < 0)
                return false;
            Value = (Value << 4) | static_cast<uint64_t>(Digit);
        }
        return true;
    }

    bool IsNewerSequence(uint32_t Candidate, uint32_t Previous)
    {
        const uint32_t Distance = Candidate - Previous;
        return Distance != 0 && Distance < 0x80000000u;
    }

    void BuildAck(uint64_t Session, wchar_t (&Ack)[kHelloLength + 1])
    {
        static constexpr wchar_t Hex[] = L"0123456789abcdef";
        wchar_t* Write = Ack;
        for (size_t Index = 0; Index < kPrefixLength; ++Index)
            *Write++ = static_cast<wchar_t>(kPrefix[Index]);
        *Write++ = L'a';
        *Write++ = L':';
        for (size_t Index = 0; Index < kSessionDigits; ++Index)
        {
            const size_t Shift = (kSessionDigits - Index - 1) * 4;
            *Write++ = Hex[(Session >> Shift) & 0xF];
        }
        *Write = L'\0';
    }

    // ---- Player state ------------------------------------------------------------------------
    void PrunePlayers(uint64_t WorldIdentity)
    {
        for (auto It = GPlayers.begin(); It != GPlayers.end();)
        {
            if (It->second.WorldIdentity != WorldIdentity)
                It = GPlayers.erase(It);
            else
                ++It;
        }
        while (GPlayers.size() >= kMaxPlayers)
        {
            auto Oldest = GPlayers.begin();
            for (auto It = GPlayers.begin(); It != GPlayers.end(); ++It)
            {
                if (It->second.LastActivityAt < Oldest->second.LastActivityAt)
                    Oldest = It;
            }
            GPlayers.erase(Oldest);
        }
    }

    // The state for this controller in this world; a reused pointer or a new world starts fresh.
    FPlayer* GetPlayer(AFortPlayerControllerAthena* PlayerController, bool bCreate)
    {
        const uint64_t ControllerIdentity = ObjectIdentity(PlayerController);
        const uint64_t WorldIdentity = ObjectIdentity(UWorld::GetWorld());
        if (!ControllerIdentity || !WorldIdentity)
            return nullptr;

        auto It = GPlayers.find(PlayerController);
        if (It != GPlayers.end() && (It->second.ControllerIdentity != ControllerIdentity ||
                It->second.WorldIdentity != WorldIdentity))
        {
            GPlayers.erase(It);
            It = GPlayers.end();
        }
        if (It == GPlayers.end())
        {
            if (!bCreate)
                return nullptr;
            PrunePlayers(WorldIdentity);
            FPlayer Fresh{};
            Fresh.ControllerIdentity = ControllerIdentity;
            Fresh.WorldIdentity = WorldIdentity;
            It = GPlayers.emplace(PlayerController, Fresh).first;
        }
        return &It->second;
    }

    void OnHello(AFortPlayerControllerAthena* PlayerController, uint64_t Session)
    {
        FPlayer* Player = GetPlayer(PlayerController, true);
        if (!Player)
            return;
        const ULONGLONG Now = GetTickCount64();
        Player->LastActivityAt = Now;

        if (const char* Reason = UnavailableReason())
        {
            if (!Player->bLoggedRefusal)
                ProbeLog("hello session=%016llx not acked: %s", Session, Reason);
            Player->bLoggedRefusal = true;
            return;
        }

        if (Now < Player->NextAckAt)
            return;
        Player->NextAckAt = Now + kMinAckIntervalMs;

        // Self-test: at least the unedited wood wall must resolve, or this server can't do it.
        EnsureDefaultClassesLoadedOnce();
        LogClassProbeOnce();
        if (!ResolveUneditedClass(0, 0))
        {
            if (!Player->bLoggedRefusal)
                ProbeLog("hello session=%016llx not acked: unedited wood wall class not found", Session);
            Player->bLoggedRefusal = true;
            return;
        }

        if (Player->Session != Session)
        {
            Player->Session = Session;
            Player->LastSequence = 0;
            Player->bArmed = false;
        }

        wchar_t Ack[kHelloLength + 1]{};
        BuildAck(Session, Ack);
        PlayerController->ClientMessage(FString(Ack), FName(), 1.f);
        ProbeLog("hello session=%016llx acked", Session);
    }

    void OnArm(AFortPlayerControllerAthena* PlayerController, uint64_t Session, uint32_t Sequence)
    {
        if (UnavailableReason())
            return;
        FPlayer* Player = GetPlayer(PlayerController, false);
        if (!Player || !Player->Session || Player->Session != Session)
            return;
        if (!IsNewerSequence(Sequence, Player->LastSequence))
            return;

        const ULONGLONG Now = GetTickCount64();
        Player->LastSequence = Sequence;
        Player->ArmedSequence = Sequence;
        Player->ArmedAt = Now;
        Player->bArmed = true;
        Player->LastActivityAt = Now;
    }

    void HandleMessageUnsafe(AFortPlayerControllerAthena* PlayerController, const char* Text,
        size_t Length)
    {
        if (Length < kPrefixLength + 2 || memcmp(Text, kPrefix, kPrefixLength) != 0 ||
            Text[kPrefixLength + 1] != ':')
        {
            return;
        }

        const char Kind = Text[kPrefixLength];
        uint64_t Session = 0;
        if (Kind == 'h' && Length == kHelloLength)
        {
            if (ParseLowerHex(Text + kPrefixLength + 2, kSessionDigits, Session) && Session)
                OnHello(PlayerController, Session);
            return;
        }

        if (Kind == 'r' && Length == kArmLength && Text[kPrefixLength + 2 + kSessionDigits] == ':')
        {
            uint64_t Sequence = 0;
            if (ParseLowerHex(Text + kPrefixLength + 2, kSessionDigits, Session) && Session &&
                ParseLowerHex(Text + kPrefixLength + 3 + kSessionDigits, kSequenceDigits, Sequence) &&
                Sequence && Sequence <= 0xFFFFFFFFull)
            {
                OnArm(PlayerController, Session, static_cast<uint32_t>(Sequence));
            }
        }
    }

    bool HandleMessageCatching(AFortPlayerControllerAthena* PlayerController, const char* Text,
        size_t Length) noexcept
    {
        try
        {
            HandleMessageUnsafe(PlayerController, Text, Length);
        }
        catch (...)
        {
        }
        return true;
    }

    // ---- Reset path ----------------------------------------------------------------------------
    AActor* VehicleOf(AFortPlayerPawnAthena* Pawn)
    {
        auto Function = Pawn->GetFunction("GetVehicleActor");
        if (!Function)
            Function = Pawn->GetFunction("GetVehicle");
        if (!Function)
            Function = Pawn->GetFunction("BP_GetVehicle");
        return Function ? Pawn->Call<AActor*>(Function) : nullptr;
    }

    const char* CheckPawn(AFortPlayerControllerAthena* PlayerController, AFortPlayerPawnAthena*& OutPawn)
    {
        OutPawn = nullptr;
        auto Pawn = PlayerController->MyFortPawn;
        if (!IsLive(Pawn) || !AFortPlayerPawnAthena::StaticClass() || !Pawn->IsA<AFortPlayerPawnAthena>())
            return "no character";
        if ((AActor*)PlayerController->Pawn != (AActor*)Pawn)
            return "controlling something else (vehicle, mech or missile)";
        if (Pawn->GetHealth() <= 0.f)
            return "dead";
        if (Pawn->HasbIsDying() && Pawn->bIsDying)
            return "dying";
        if (Pawn->HasbPlayedDying() && Pawn->bPlayedDying)
            return "dying";
        if (Pawn->HasbIsDBNO() && Pawn->bIsDBNO)
            return "knocked";
        if ((Pawn->HasbIsSkydiving() && Pawn->bIsSkydiving) ||
            (Pawn->HasbIsSkydivingFromBus() && Pawn->bIsSkydivingFromBus))
        {
            return "skydiving or gliding";
        }
        if (IsLive(VehicleOf(Pawn)))
            return "in a vehicle";
        OutPawn = Pawn;
        return nullptr;
    }

    bool PlaylistAllowsEditingEnemyWalls()
    {
        auto GameState = GetGameState();
        if (!GameState)
            return false;
        const UFortPlaylistAthena* Playlist = nullptr;
        if (GameState->HasCurrentPlaylistInfo() && FPlaylistPropertyArray::HasBasePlaylist())
            Playlist = GameState->CurrentPlaylistInfo.BasePlaylist;
        else if (GameState->HasCurrentPlaylistData())
            Playlist = GameState->CurrentPlaylistData;
        if (!IsLive(Playlist) || !Playlist->HasbAllowEditingEnemyWalls())
            return false;
        return Playlist->bAllowEditingEnemyWalls;
    }

    // The building's team: TeamIndex where it exists (7.40+), else Team (4.1). -1 = neither field.
    int BuildingTeamOf(const ABuildingSMActor* Building, const char** Field = nullptr)
    {
        if (Field)
            *Field = "none";
        if (Building->HasTeamIndex())
        {
            if (Field)
                *Field = "TeamIndex";
            return Building->TeamIndex;
        }
        if (Building->HasTeam())
        {
            if (Field)
                *Field = "Team";
            return Building->Team;
        }
        return -1;
    }

    // Fails closed: without a team on either side nothing happens (the build path writes
    // Team = PlayerState->TeamIndex on every version, so both fields are expected to exist).
    const char* CheckTeam(ABuildingSMActor* Building, AFortPlayerStateAthena* PlayerState)
    {
        if (!PlayerState->HasTeamIndex())
            return "unknown team (player)";
        const int BuildingTeam = BuildingTeamOf(Building);
        if (BuildingTeam < 0)
            return "unknown team (build)";
        if (BuildingTeam == static_cast<int>(PlayerState->TeamIndex) || PlaylistAllowsEditingEnemyWalls())
            return nullptr;
        return "enemy build";
    }

    // nullptr = reset done; otherwise why nothing happened (debug log only).
    const char* RunReset(AFortPlayerControllerAthena* PlayerController, FPlayer& Player,
        ABuildingSMActor* Building, const UClass* NewClass, int32_t RotationIterations,
        bool bMirrored)
    {
        const ULONGLONG Now = GetTickCount64();
        if (Player.LastResetAt && Now - Player.LastResetAt < kMinResetIntervalMs)
            return "too fast";
        Player.LastResetAt = Now;

        if (!IsLive(Building) || !Building->IsA<ABuildingSMActor>())
            return "no building";
        // The companion Edit always names the piece's own class, no rotation, no mirror.
        if (!NewClass || NewClass != Building->Class || RotationIterations != 0 || bMirrored)
            return "not a reset request";
        if (Building->bDestroyed)
            return "destroyed";
        if (!Building->HasbPlayerPlaced() || !Building->bPlayerPlaced)
            return "not built by a player";
        if (Building->EditingPlayer)
            return "someone is editing it";
        if (!Building->HasBuildingType())
            return "unknown piece";
        const int Slot = TypeSlot(Building->BuildingType);
        if (Slot < 0)
            return "not a wall, floor, ramp or roof";
        const int Resource = Building->HasResourceType() ? static_cast<int>(Building->ResourceType) : -1;
        if (Resource < 0 || Resource >= kResourceCount)
            return "unknown material";

        auto PlayerState = (AFortPlayerStateAthena*)PlayerController->PlayerState;
        if (!IsLive(PlayerState))
            return "no player state";
        AFortPlayerPawnAthena* Pawn = nullptr;
        if (const char* Why = CheckPawn(PlayerController, Pawn))
            return Why;
        if (const char* Why = CheckTeam(Building, PlayerState))
            return Why;

        const FVector PawnLocation = Pawn->K2_GetActorLocation();
        const FVector BuildingLocation = Building->K2_GetActorLocation();
        const double DX = BuildingLocation.X - PawnLocation.X;
        const double DY = BuildingLocation.Y - PawnLocation.Y;
        const double DZ = BuildingLocation.Z - PawnLocation.Z;
        if (DX * DX + DY * DY + DZ * DZ > kMaxResetDistance * kMaxResetDistance)
            return "too far away";

        const UClass* Unedited = ResolveUneditedClass(Resource, Slot);
        if (!Unedited)
            return "unedited class not found";
        if (Unedited == Building->Class)
            return "already unedited";

        ABuildingSMActor* NewBuild = QuickReset::CallReplaceBuildingActor(Building, Unedited, 0, false,
            PlayerController);
        if (!NewBuild)
            return "replace failed";
        NewBuild->bPlayerPlaced = true;
        return nullptr;
    }

    bool TryHandleArmedEditUnsafe(AFortPlayerControllerAthena* PlayerController,
        ABuildingSMActor* Building, const UClass* NewClass, int32_t RotationIterations, bool bMirrored)
    {
        if (!PlayerController)
            return false;
        auto It = GPlayers.find(PlayerController);
        if (It == GPlayers.end() || !It->second.bArmed)
            return false;

        FPlayer& Player = It->second;
        Player.bArmed = false; // one-shot: whatever happens next, the arm is gone
        const ULONGLONG Now = GetTickCount64();
        const ULONGLONG Waited = Now - Player.ArmedAt;
        if (Player.ControllerIdentity != ObjectIdentity(PlayerController) ||
            Player.WorldIdentity != ObjectIdentity(UWorld::GetWorld()) || Waited > kArmLifetimeMs)
        {
            ProbeLog("arm seq=%u dropped after %llu ms (expired or new world)", Player.ArmedSequence, Waited);
            return false;
        }

        // The client sends the arm and its Edit back to back on one reliable channel, so the Edit
        // right after an arm is always our reset request - even when a Begin edit for this piece got
        // there first (edit key and Reset builds key pressed within a frame or two). Running it as a
        // normal edit would replace the piece and end the player's edit on the server only, so an
        // Edit with the request's shape is dropped. Any other shape (Fortnite never sends one right
        // after an arm) is passed on as a real edit.
        auto PlayerState = PlayerController->PlayerState;
        if (PlayerState && IsLive(Building) && Building->IsA<ABuildingSMActor>() &&
            Building->EditingPlayer == PlayerState)
        {
            if (NewClass && NewClass == Building->Class && RotationIterations == 0 && !bMirrored)
            {
                ProbeLog("arm seq=%u waited %llu ms: nothing done (player is editing it)",
                    Player.ArmedSequence, Waited);
                return true;
            }
            ProbeLog("arm seq=%u waited %llu ms: real edit, passed on", Player.ArmedSequence, Waited);
            return false;
        }

        if (UnavailableReason())
            return true;

        const char* Why = RunReset(PlayerController, Player, Building, NewClass, RotationIterations, bMirrored);
        if (Why)
            ProbeLog("arm seq=%u waited %llu ms: nothing done (%s)", Player.ArmedSequence, Waited, Why);
        else
            ProbeLog("arm seq=%u waited %llu ms: reset done", Player.ArmedSequence, Waited);
        return true;
    }

    // 0 = normal edit, 1 = handled here, 2 = faulted (treated as handled: never fall into the
    // normal edit with half-checked state).
    int TryHandleArmedEditCatching(AFortPlayerControllerAthena* PlayerController,
        ABuildingSMActor* Building, const UClass* NewClass, int32_t RotationIterations, bool bMirrored)
    {
        try
        {
            return TryHandleArmedEditUnsafe(PlayerController, Building, NewClass, RotationIterations,
                bMirrored) ? 1 : 0;
        }
        catch (...)
        {
            return 2;
        }
    }

    // ---- P1 probe ------------------------------------------------------------------------------
    QuickReset::FEditProbe CaptureEditProbeUnsafe(ABuildingSMActor* Building, const UClass* NewClass,
        int32_t RotationIterations, bool bMirrored)
    {
        QuickReset::FEditProbe Probe{};
        if (!IsLive(Building))
            return Probe;
        Probe.OldClass = Building->Class;
        Probe.NewClass = NewClass;
        Probe.RotationIterations = RotationIterations;
        Probe.bMirrored = bMirrored;
        Probe.OldYaw = Building->K2_GetActorRotation().Yaw;
        Probe.OldTeam = BuildingTeamOf(Building);
        Probe.bValid = true;
        return Probe;
    }

    void LogEditProbeUnsafe(const QuickReset::FEditProbe& Probe, ABuildingSMActor* NewBuild)
    {
        double NewYaw = 0.0;
        int NewTeam = -1;
        const char* TeamField = "none";
        const bool bHasNew = IsLive(NewBuild);
        if (bHasNew)
        {
            NewYaw = NewBuild->K2_GetActorRotation().Yaw;
            // Shows whether the game's own replace keeps the team (the reset path's team check
            // reads the same field on the edited piece).
            NewTeam = BuildingTeamOf(NewBuild, &TeamField);
        }
        char OldName[160], RequestedName[160];
        strcpy_s(OldName, ClassName(Probe.OldClass));
        strcpy_s(RequestedName, ClassName(Probe.NewClass));
        ProbeLog("P1 edit old=%s requested=%s new=%s rotation=%d mirrored=%d yaw=%.1f->%.1f %s=%d->%d",
            OldName, RequestedName, bHasNew ? ClassName(NewBuild->Class) : "none",
            Probe.RotationIterations, Probe.bMirrored ? 1 : 0, Probe.OldYaw, NewYaw, TeamField,
            Probe.OldTeam, NewTeam);
    }
}

namespace QuickReset
{
bool HandleBridgeMessage(AFortPlayerControllerAthena* PlayerController,
    const std::string& Message) noexcept
{
    if (Message.size() < kFamilyPrefixLength ||
        memcmp(Message.data(), kFamilyPrefix, kFamilyPrefixLength) != 0)
    {
        return false;
    }
    if (!PlayerController)
        return true;

    const char* Text = Message.data();
    const size_t Length = Message.size();
    __try
    {
        HandleMessageCatching(PlayerController, Text, Length);
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
    }
    return true;
}

bool TryHandleArmedEdit(AFortPlayerControllerAthena* PlayerController, ABuildingSMActor* Building,
    const SDK::UClass* NewClass, int32_t RotationIterations, bool bMirrored) noexcept
{
    int Result = 2;
    __try
    {
        Result = TryHandleArmedEditCatching(PlayerController, Building, NewClass, RotationIterations,
            bMirrored);
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        Result = 2;
    }
    return Result != 0;
}

ABuildingSMActor* CallReplaceBuildingActor(ABuildingSMActor* Building, const SDK::UClass* NewClass,
    int32_t RotationIterations, bool bMirrored, AFortPlayerControllerAthena* PlayerController)
{
    if (!ReplaceBuildingActor_ || !Building || !NewClass)
        return nullptr;

    TSubclassOf<AActor> Class = NewClass;
    auto ReplaceBuildingActor = (ABuildingSMActor * (*&)(ABuildingSMActor*, unsigned int,
        TSubclassOf<AActor>, unsigned int, int, bool,
        AFortPlayerControllerAthena*)) ReplaceBuildingActor_;
    auto ReplaceBuildingActor__New = (ABuildingSMActor * (*&)(ABuildingSMActor*, unsigned int,
        TSubclassOf<AActor>&, unsigned int, int, bool,
        AFortPlayerControllerAthena*)) ReplaceBuildingActor_;

    if (VersionInfo.FortniteVersion < 27)
        return ReplaceBuildingActor(Building, 1, Class, Building->CurrentBuildingLevel,
            RotationIterations, bMirrored, PlayerController);
    return ReplaceBuildingActor__New(Building, 1, Class, Building->CurrentBuildingLevel,
        RotationIterations, bMirrored, PlayerController);
}

FEditProbe CaptureEditProbe(ABuildingSMActor* Building, const SDK::UClass* NewClass,
    int32_t RotationIterations, bool bMirrored) noexcept
{
    FEditProbe Probe{};
    if constexpr (!kProbeLog)
        return Probe;
    __try
    {
        Probe = CaptureEditProbeUnsafe(Building, NewClass, RotationIterations, bMirrored);
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        Probe.bValid = false;
    }
    return Probe;
}

void LogEditProbe(const FEditProbe& Probe, ABuildingSMActor* NewBuild) noexcept
{
    if constexpr (!kProbeLog)
        return;
    if (!Probe.bValid)
        return;
    __try
    {
        LogEditProbeUnsafe(Probe, NewBuild);
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
    }
}
}
