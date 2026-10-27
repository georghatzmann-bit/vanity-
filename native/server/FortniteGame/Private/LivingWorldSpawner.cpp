// NIOBIUM: "Lager-lite" - Living world spawning (see FortniteGame/Public/LivingWorldSpawner.h).
// Niobium's own code (GPL-3.0).
//
// Credits (ideas and structure; no code is copied):
//   - Jeremy1926/Velora (MIT), dfa12c2, Velora/FortniteGame/Plugins/GameFeatures/Lager/Source/
//     LagerRuntime/Private/FortAthenaLivingWorldManager.cpp: GetRandomPointProvider :1180-1275
//     (an empty provider query matches every provider; ProviderFiltersEntries), RequestSpawnToAISpawnerSystem
//     :1277-1440 (one actor per ActorDescription index, bSpawnAroundDefaultPoint, actor spawner
//     data -> SpawnActor(ActorClass), CreateComponentListFromClass + AISpawner->RequestSpawn,
//     INDEX_NONE = failed), GetSpawnerDataClass :1458-1478 (fall back to LoadedSpawnerDataClass by
//     SpawnerDataTagQuery); FortAthenaLivingWorldCategory.cpp:70-94 and FortAthenaLivingWorldEvent.cpp
//     :70-77 (when a category / event is active); FortAthenaPatrolPathPointProvider.cpp:109-129
//     (spawn on a patrol point of the associated patrol path); Private/AI/FortAthenaAIBotController.cpp
//     :98-160 (an AI without an inventory gets one with its StartupInventory items and full clips).
//   - andr1ww/Cubed (GPL-3.0), 72905b1, Cubed/.../Athena/AI/Systems/AthenaAISystem.cpp:5-41:
//     a patrol path whose tags match is a spawn place (used here only as a fallback when no
//     Lager point provider matches; Cubed's random index bug is not repeated).
// THIRD_PARTY_NOTICES.md: Velora's row must add these Lager methods; Cubed (GPL-3.0, andr1ww) needs
// a row for the patrol path fallback idea.
//
// The flow, once per match (game thread, every ~500 ms poll of LivingWorld::GameThreadTick):
//   1. Waiting: until the bus starts (game phase Aircraft), or 2 minutes in without game phases.
//   2. Resolve: the FortAthenaLivingWorldManager component on the game state; its config (a
//      matching LagerConfigOverrides entry, else CachedConfig, else DefaultLagerConfig); the
//      CategoryTable; for every active category (IsEnabled, RequirePlaylistTagQuery/-Tags, MaxCount)
//      its EventTable; for every active event (IsEnabled, RequirePlaylistTags, no calendar event
//      it waits for, MaxCount, RandomActivationChance) its EventData with ActorDescriptions. Also
//      every point provider of the map (patrol path providers, Living World volumes, static
//      providers, the manager's own lists) with its FiltersTags. Any of this missing -> "unavailable".
//   3. Plan (a budget of tag-query calls per poll): events by priority bucket - bosses, guards,
//      creatures, characters, others (vehicles are left to Niobium's own vehicle spawner) - each
//      matched to free point providers through BlueprintGameplayTagLibrary.DoesContainerMatchTagQuery
//      (ProcessEvent); instances = min(event MaxCount, category budget, places), all within
//      LivingWorldMaxAI.
//   4. Spawn: at most 2 groups / 4 actors per poll while the AI alive (plus requests in flight)
//      stay under LivingWorldMaxAI. Before the first request: LivingWorld::IsActive() turns true
//      and AIBase::EnsureStandaloneCheckOff() must succeed (17.00-19.99), else nothing spawns.
//   5. Upkeep (every second): new NPC pawns are counted and tied to their request; NPCs without
//      an inventory get one (StartupInventory, or the spawner data's inventory component items),
//      full clips, first weapon equipped; on 19.10 with the AI base their brain is started (brain
//      flag + RunBehaviorTree, at most 3 tries); NPC controllers never stay in AlivePlayers /
//      AliveBots. Every 20 s: a boss or guard group with nobody left near its place and no player
//      within 80 m respawns after its event's MinRespawnTime (else 5 min), at most 3 times.
// Left out on purpose: density grid, despawn, encounters, EQS, patrols, conversations.
#include "pch.h"
#include "../Public/LivingWorldSpawner.h"
#include "../Public/LivingWorld.h"
#include "../Public/AIBase.h"
#include "../Public/AIBase_19_10.h"
#include "../Public/FortGameMode.h"
#include "../Public/FortInventory.h"
#include "../Public/FortLootPackage.h"
#include "../Public/FortPlayerPawnAthena.h"
#include "../Public/FortPlaylistAthena.h"
#include "../Public/GameplayTagContainer.h"
#include <Engine/Public/CurveTable.h>
#include <Engine/Public/DataTable.h>
#include <Erbium/Public/Configuration.h>
#include <Erbium/Public/NiobiumControl.h>
#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstdarg>
#include <random>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace
{
    constexpr const char* kTag = "LivingWorld";

    // The AI spawner data classes exist from about 13.x; Lager data from about 14.40.
    constexpr double kMinVersion = 13.00;
    constexpr int32 kGamePhaseAircraft = 3; // EAthenaGamePhase::Aircraft
    constexpr ULONGLONG kNoBusDelayMs = 120000;
    constexpr ULONGLONG kUpkeepIntervalMs = 1000;
    constexpr ULONGLONG kRespawnCheckIntervalMs = 20000;
    constexpr ULONGLONG kPendingRequestLifetimeMs = 60000;
    constexpr ULONGLONG kNoPawnGiveUpMs = 90000;
    constexpr ULONGLONG kEmitIntervalMs = 30000;
    constexpr ULONGLONG kBrainDelayMs = 3000;
    constexpr ULONGLONG kBrainGiveUpMs = 60000;
    constexpr int32 kEmitStep = 5;
    constexpr int32 kGroupsPerTick = 2;
    constexpr int32 kActorsPerTick = 4;
    constexpr int32 kMatchCallsPerTick = 2500;
    constexpr int32 kMaxCategories = 64;
    constexpr int32 kMaxEventsPerCategory = 128;
    constexpr int32 kMaxEvents = 512;
    constexpr int32 kMaxProviders = 4096;
    constexpr int32 kMaxActorsPerGroup = 6;
    constexpr int32 kMaxRespawnsPerGroup = 3;
    constexpr int32 kBrainAttempts = 3;
    constexpr int32 kInventoryAttempts = 20;
    constexpr int32 kMaxItemsPerInventory = 16;
    constexpr int32 kMaxPawnsPerScan = 4096;
    constexpr float kDefaultRespawnSeconds = 300.f;
    constexpr double kGroupRadiusCm = 3000.0;  // an NPC within 30 m of a group's place belongs to it
    constexpr double kPlayerNearCm = 8000.0;   // no respawn while a player is within 80 m
    constexpr double kRequestMatchCm = 2500.0; // a new NPC within 25 m of a request came from it
    constexpr int32 kLogCap = 150;             // "[LivingWorld]" lines per match (state lines excepted)

    // What the launcher shows.
    constexpr const char* kReasonNoNavVersion = "standing only (no navigation on this version yet)";

    // ------------------------------------------------------------------ Logging

    int32 GLogLines = 0;

    void LogV(bool bAlways, const char* Format, va_list Args)
    {
        if (!bAlways)
        {
            if (GLogLines > kLogCap)
                return;
            if (GLogLines++ == kLogCap)
            {
                AIBase::LogLine(kTag, "further lines of this match are not shown");
                return;
            }
        }
        char Buffer[768];
        vsnprintf(Buffer, sizeof(Buffer), Format, Args);
        AIBase::LogLine(kTag, Buffer);
    }

    void Log(const char* Format, ...)
    {
        va_list Args;
        va_start(Args, Format);
        LogV(false, Format, Args);
        va_end(Args);
    }

    void LogAlways(const char* Format, ...)
    {
        va_list Args;
        va_start(Args, Format);
        LogV(true, Format, Args);
        va_end(Args);
    }

    std::string NameOf(const UObject* Object)
    {
        return Object ? std::string(Object->Name.ToString().c_str()) : std::string("none");
    }

    std::string Lower(std::string Text)
    {
        for (auto& Char : Text)
            Char = (char)tolower((unsigned char)Char);
        return Text;
    }

    // ------------------------------------------------------------------ Object references

    // An object kept across polls by its GUObjectArray slot: only handed back while the slot still
    // holds the same object (and, if it had one when it was kept, the same serial number; serials
    // are only read here, never allocated).
    struct FObjectRef
    {
        const UObject* Object = nullptr;
        int32 Index = -1;
        int32 Serial = 0;

        static FObjectRef Of(const UObject* InObject)
        {
            FObjectRef Ref;
            if (!InObject || !AIBase::IsLiveObject(InObject))
                return Ref;
            auto Item = TUObjectArray::GetItemByIndex(InObject->Index);
            Ref.Object = InObject;
            Ref.Index = InObject->Index;
            Ref.Serial = Item ? Item->SerialNumber : 0;
            return Ref;
        }

        const UObject* Get() const
        {
            if (!Object || Index < 0 || Index >= TUObjectArray::Num())
                return nullptr;
            auto Item = TUObjectArray::GetItemByIndex(Index);
            if (!Item || Item->GetObject() != Object || (Serial != 0 && Item->SerialNumber != Serial))
                return nullptr;
            return AIBase::IsLiveObject(Object) ? Object : nullptr;
        }
    };

    // A key for one object while it lives: its slot and its address (stable even when the engine
    // gives it a serial number later; entries are dropped once FObjectRef::Get fails).
    uint64 KeyOf(const UObject* Object)
    {
        if (!Object)
            return 0;
        return ((uint64)(uint32)Object->Index << 32) | (uint32)((uintptr_t)Object >> 4);
    }

    // ------------------------------------------------------------------ Reflection readers

    struct FBit
    {
        int32 Offset = -1;
        uint8 Mask = 0;
    };

    int32 Off(const UStruct* Struct, const char* Name)
    {
        return Struct ? AIBase::OffsetOf(Struct, Name) : -1;
    }

    FBit BitOf(const UStruct* Struct, const char* Name)
    {
        FBit Bit;
        auto Property = Struct ? Struct->GetProperty(Name, AIBase::ECastFlags::BoolProperty) : nullptr;
        if (Property)
        {
            Bit.Offset = AIBase::PropertyOffset(Property);
            Bit.Mask = Property->GetFieldMask();
            if (!Bit.Mask)
                Bit.Mask = 0xFF;
        }
        return Bit;
    }

    bool ReadBool(const void* Base, const FBit& Bit, bool bDefault)
    {
        if (!Base || Bit.Offset < 0)
            return bDefault;
        return (*(static_cast<const uint8*>(Base) + Bit.Offset) & Bit.Mask) != 0;
    }

    template <typename T>
    const T* At(const void* Base, int32 Offset)
    {
        return Base && Offset >= 0 ? reinterpret_cast<const T*>(static_cast<const uint8*>(Base) + Offset) : nullptr;
    }

    // A TArray at Base+Offset: its element count (0 for none/broken) and data.
    int32 ArrayAt(const void* Base, int32 Offset, const uint8** OutData, int32 Max = 100000)
    {
        *OutData = nullptr;
        auto Array = At<TArray<uint8>>(Base, Offset);
        if (!Array)
            return 0;
        const int32 Num = Array->Num();
        if (Num <= 0 || Num > Max || !Array->GetData())
            return 0;
        *OutData = reinterpret_cast<const uint8*>(Array->GetData());
        return Num;
    }

    const UObject* ObjectAt(const void* Base, int32 Offset)
    {
        auto Pointer = At<const UObject*>(Base, Offset);
        return Pointer && *Pointer && AIBase::IsLiveObject(*Pointer) ? *Pointer : nullptr;
    }

    bool SameName(const FName& First, const FName& Second)
    {
        return First.ComparisonIndex == Second.ComparisonIndex &&
            (VersionInfo.FortniteVersion >= 20.00 || First.Number == Second.Number);
    }

    // FScalableFloat at Base+Offset, like the engine's GetValueAtLevel(0): Value times the curve
    // row when the curve table has that row, else Value. Default when there's no such field.
    float ScalableAt(const void* Base, int32 Offset, float Default)
    {
        auto Scalable = At<FScalableFloat>(Base, Offset);
        if (!Scalable)
            return Default;
        auto Table = Scalable->Curve.CurveTable;
        if (!Table || !AIBase::IsLiveObject(reinterpret_cast<const UObject*>(Table)) || !Scalable->Curve.RowName.IsValid())
            return Scalable->Value;
        bool bFound = false;
        int32 Guard = 0;
        for (auto& Pair : Table->RowMap)
        {
            if (++Guard > 100000)
                break;
            if (SameName(Pair.Key(), Scalable->Curve.RowName))
            {
                bFound = true;
                break;
            }
        }
        if (!bFound)
            return Scalable->Value;
        auto Copy = *const_cast<FScalableFloat*>(Scalable);
        const float Result = Copy.Evaluate(0.f);
        return std::isfinite(Result) ? Result : Scalable->Value;
    }

    // A number field that is an int, a float or an array of floats (per storm phase, the first
    // entry is the start of the match): its value, Default when there is no such field or entry.
    float NumberAt(const UStruct* Struct, const void* Base, const char* Name, float Default)
    {
        auto Property = Struct && Base ? Struct->GetProperty(Name) : nullptr;
        const int32 Offset = AIBase::PropertyOffset(Property);
        if (Offset < 0)
            return Default;
        const uint64_t Flags = AIBase::PropertyCastFlags(Property);
        if (Flags & AIBase::ECastFlags::ArrayProperty)
        {
            const uint8* Data = nullptr;
            return ArrayAt(Base, Offset, &Data, 64) > 0 ? *reinterpret_cast<const float*>(Data) : Default;
        }
        if (Flags & AIBase::ECastFlags::IntProperty)
            return (float)*At<int32>(Base, Offset);
        if (Flags & AIBase::ECastFlags::FloatProperty)
            return *At<float>(Base, Offset);
        return Default;
    }

    // ------------------------------------------------------------------ Soft references

    // The path a TSoftObjectPtr / TSoftClassPtr at Address points to (the SDK's InternalGet layout,
    // read only).
    std::wstring SoftPath(const uint8* Address)
    {
        if (!Address)
            return L"";
        auto Soft = reinterpret_cast<const FSoftObjectPtr*>(Address);
        if (VersionInfo.EngineVersion <= 4.16)
        {
            auto& LongName = *reinterpret_cast<const FString*>(Address + offsetof(FSoftObjectPtr, ObjectID));
            return LongName.Num() > 0 && LongName.CStr() ? std::wstring(LongName.CStr()) : L"";
        }
        if (VersionInfo.FortniteVersion >= 23)
        {
            const bool bOld = VersionInfo.EngineVersion < 5.3;
            auto& PackageName = *reinterpret_cast<const FName*>(Address + (bOld ? 0x10 : 0x8));
            auto& AssetName = *reinterpret_cast<const FName*>(Address + (bOld ? 0x14 : 0xC));
            auto& SubPath = *reinterpret_cast<const FString*>(Address + (bOld ? 0x18 : 0x10));
            if (!PackageName.IsValid())
                return L"";
            std::wstring Path = PackageName.ToWString().c_str();
            if (AssetName.IsValid())
                Path += L"." + std::wstring(AssetName.ToWString().c_str());
            if (SubPath.Num() > 0 && SubPath.CStr())
                Path += L":" + std::wstring(SubPath.CStr());
            return Path;
        }
        if (!Soft->ObjectID.AssetPathName.IsValid())
            return L"";
        std::wstring Path = Soft->ObjectID.AssetPathName.ToWString().c_str();
        if (Soft->ObjectID.SubPathString.Num() > 0 && Soft->ObjectID.SubPathString.CStr())
            Path += L":" + std::wstring(Soft->ObjectID.SubPathString.CStr());
        return Path;
    }

    std::string Narrow(const std::wstring& Text)
    {
        std::string Out;
        Out.reserve(Text.size());
        for (auto Char : Text)
            Out += (Char >= 0x20 && Char < 0x7F) ? (char)Char : '?';
        return Out;
    }

    // "BP_AIBotSpawnerData_IO_Guard_C" from ".../BP_AIBotSpawnerData_IO_Guard.BP_AIBotSpawnerData_IO_Guard_C".
    std::string ShortName(const std::string& Path)
    {
        size_t Start = Path.find_last_of("./");
        std::string Name = Start == std::string::npos ? Path : Path.substr(Start + 1);
        if (Name.size() > 2 && Name.compare(Name.size() - 2, 2, "_C") == 0)
            Name.resize(Name.size() - 2);
        return Name;
    }

    // Loads what a soft reference points to (already loaded objects are only found). No write to
    // the game's soft pointer. What Living world keeps using (config, tables, event data, spawner
    // classes) is added to the root set: soft references don't keep an asset loaded, and pointers
    // into it are used across polls.
    const UObject* LoadSoft(const uint8* Address, const UClass* Class)
    {
        if (!Address)
            return nullptr;
        auto Soft = reinterpret_cast<const FSoftObjectPtr*>(Address);
        const UObject* Object = Soft->WeakPtr.Get();
        if (!Object)
        {
            const std::wstring Path = SoftPath(Address);
            if (Path.empty())
                return nullptr;
            Object = FindObject(Path.c_str(), Class);
        }
        if (!Object || !AIBase::IsLiveObject(Object) || (Class && !Object->IsA(Class)))
            return nullptr;
        Object->AddToRoot();
        return Object;
    }

    const UClass* LoadSoftClass(const uint8* Address)
    {
        auto Object = LoadSoft(Address, UClass::StaticClass());
        return Object ? static_cast<const UClass*>(Object) : nullptr;
    }

    // ------------------------------------------------------------------ Reflected calls

    struct FTagQueryCall
    {
        bool bResolved = false;
        const UObject* Library = nullptr;
        UFunction* Function = nullptr;
        int32 ContainerParam = -1;
        int32 QueryParam = -1;
        int32 ReturnParam = -1;
        int32 ParamsSize = 0;
        int32 ContainerSize = 0;
        int32 QuerySize = 0;
        int32 TokenStream = -1; // FGameplayTagQuery::QueryTokenStream
        int32 Calls = 0;        // this poll
    };

    FTagQueryCall GTagQuery;

    bool ResolveTagQuery()
    {
        auto& Q = GTagQuery;
        if (Q.bResolved)
            return Q.Function != nullptr;
        Q.bResolved = true;
        auto LibraryClass = FindClass("BlueprintGameplayTagLibrary");
        Q.Library = LibraryClass ? LibraryClass->GetDefaultObj() : nullptr;
        if (!AIBase::IsLiveObject(Q.Library))
            return false;
        Q.Function = Q.Library->GetFunction("DoesContainerMatchTagQuery");
        if (!Q.Function)
            Q.Function = Q.Library->GetFunction("DoesTagContainerMatchTagQuery");
        auto ContainerStruct = FindStruct("GameplayTagContainer");
        auto QueryStruct = FindStruct("GameplayTagQuery");
        Q.ContainerSize = ContainerStruct ? ContainerStruct->GetPropertiesSize() : 0;
        Q.QuerySize = QueryStruct ? QueryStruct->GetPropertiesSize() : 0;
        Q.TokenStream = Off(QueryStruct, "QueryTokenStream");
        if (Q.Function)
        {
            Q.ContainerParam = Off(Q.Function, "TagContainer");
            Q.QueryParam = Off(Q.Function, "TagQuery");
            Q.ReturnParam = Off(Q.Function, "ReturnValue");
            Q.ParamsSize = Q.Function->GetPropertiesSize();
        }
        if (!Q.Function || Q.ContainerParam < 0 || Q.QueryParam < 0 || Q.ReturnParam < 0 ||
            Q.ParamsSize <= 0 || Q.ParamsSize > 0x200 || Q.ContainerSize < 0x20 || Q.QuerySize < 0x20 ||
            Q.TokenStream < 0 || Q.ContainerParam + Q.ContainerSize > Q.ParamsSize ||
            Q.QueryParam + Q.QuerySize > Q.ParamsSize || Q.ReturnParam >= Q.ParamsSize)
        {
            Q.Function = nullptr;
            return false;
        }
        return true;
    }

    // UE's FGameplayTagQuery::IsEmpty: no tokens.
    bool IsQueryEmpty(const uint8* Query)
    {
        if (!Query || GTagQuery.TokenStream < 0)
            return true;
        const uint8* Data = nullptr;
        return ArrayAt(Query, GTagQuery.TokenStream, &Data) == 0;
    }

    // The game's own DoesContainerMatchTagQuery through ProcessEvent. The container and the query
    // are copied flat into the parameters and only read by the game (never freed here or there).
    bool QueryMatches(const uint8* Container, const uint8* Query)
    {
        auto& Q = GTagQuery;
        if (!Q.Function || !Container || !Query)
            return false;
        ++Q.Calls;
        alignas(16) uint8 Params[0x200] = {};
        memcpy(Params + Q.ContainerParam, Container, Q.ContainerSize);
        memcpy(Params + Q.QueryParam, Query, Q.QuerySize);
        Q.Library->ProcessEvent(Q.Function, Params);
        return Params[Q.ReturnParam] != 0;
    }

    struct FCalls
    {
        bool bResolved = false;
        // UFortAthenaAISpawnerData::CreateComponentListFromClass (static)
        const UObject* SpawnerDataDefault = nullptr;
        UFunction* CreateComponentList = nullptr;
        int32 CCLClass = -1, CCLOuter = -1, CCLReturn = -1, CCLSize = 0;
        // UAthenaAISpawner::RequestSpawn
        UFunction* RequestSpawn = nullptr;
        int32 RSList = -1, RSTransform = -1, RSReturn = -1, RSSize = 0;
        // AAIController::RunBehaviorTree, UBrainComponent::IsRunning
        UFunction* RunBehaviorTree = nullptr;
        int32 RBTAsset = -1, RBTReturn = -1, RBTSize = 0;
        UFunction* IsRunning = nullptr;
        int32 IRReturn = -1, IRSize = 0;
        int32 BrainComponent = -1; // AAIController::BrainComponent
        // UKismetSystemLibrary::LineTraceSingle
        const UObject* KismetSystem = nullptr;
        UFunction* LineTrace = nullptr;
        int32 LTWorld = -1, LTStart = -1, LTEnd = -1, LTChannel = -1, LTHit = -1, LTIgnoreSelf = -1,
            LTReturn = -1, LTSize = 0, HitImpactPoint = -1, HitSize = 0;
    };

    FCalls GCalls;

    struct FClasses
    {
        bool bResolved = false;
        const UClass* SpawnerDataBase = nullptr;   // FortAthenaSpawnerDataBase (or AI spawner data)
        const UClass* AISpawnerData = nullptr;     // FortAthenaAISpawnerData
        const UClass* ActorSpawnerData = nullptr;  // FortAthenaActorSpawnerData (18.00+)
        const UClass* AISpawner = nullptr;         // AthenaAISpawner
        const UClass* AIBotController = nullptr;   // FortAthenaAIBotController
        const UClass* FortPawn = nullptr;
        const UClass* PlayerPawn = nullptr;        // FortPlayerPawn
        const UClass* Inventory = nullptr;         // FortInventory
        const UClass* InventoryItems = nullptr;    // FortAthenaAIBotInventoryItems
        const UClass* RangedWeapon = nullptr;      // FortWeaponRangedItemDefinition
        const UClass* Weapon = nullptr;            // FortWeaponItemDefinition
        const UClass* Vehicle = nullptr;           // FortAthenaVehicle
        int32 PawnController = -1;
        int32 ControllerPawn = -1;
        // AFortAthenaAIBotController
        int32 BotInventory = -1;
        int32 BotStartupInventory = -1;
        int32 BotBehaviorTree = -1;
        FBit BotParticipant;
        FBit PawnIsDying;
        FBit PawnPlayedDying;
        int32 InventoryItemsList = -1;              // UFortAthenaAIBotInventoryItems::Items
        int32 ItemAndCountSize = 0, ItemAndCountItem = -1, ItemAndCountCount = -1;
        int32 InventoryType = -1;                   // AFortInventory::InventoryType
        int64 InventoryTypeWorld = -1;
        int32 SpawnerInventoryComponent = -1;       // UFortAthenaAISpawnerData::InventoryComponent
        int32 SpawnerDescriptorTag = -1;            // UFortAthenaSpawnerDataBase::DescriptorTag
        int32 ActorSpawnerActorClass = -1;          // UFortAthenaActorSpawnerData::ActorClass
        int32 WorldAISystem = -1;
        int32 GameStateAI = -1;
    };

    FClasses GClasses;

    void ResolveClasses()
    {
        auto& C = GClasses;
        if (C.bResolved)
            return;
        C.bResolved = true;
        C.AISpawnerData = FindClass("FortAthenaAISpawnerData");
        C.SpawnerDataBase = FindClass("FortAthenaSpawnerDataBase");
        if (!C.SpawnerDataBase)
            C.SpawnerDataBase = C.AISpawnerData;
        C.ActorSpawnerData = FindClass("FortAthenaActorSpawnerData");
        C.AISpawner = FindClass("AthenaAISpawner");
        C.AIBotController = FindClass("FortAthenaAIBotController");
        C.FortPawn = FindClass("FortPawn");
        C.PlayerPawn = FindClass("FortPlayerPawn");
        C.Inventory = FindClass("FortInventory");
        C.InventoryItems = FindClass("FortAthenaAIBotInventoryItems");
        C.RangedWeapon = FindClass("FortWeaponRangedItemDefinition");
        C.Weapon = FindClass("FortWeaponItemDefinition");
        C.Vehicle = FindClass("FortAthenaVehicle");
        C.PawnController = Off(FindClass("Pawn"), "Controller");
        C.ControllerPawn = Off(FindClass("Controller"), "Pawn");
        C.BotInventory = Off(C.AIBotController, "Inventory");
        C.BotStartupInventory = Off(C.AIBotController, "StartupInventory");
        C.BotBehaviorTree = Off(C.AIBotController, "BehaviorTree");
        C.BotParticipant = BitOf(C.AIBotController, "bIsAnAthenaGameParticipant");
        C.PawnIsDying = BitOf(C.FortPawn, "bIsDying");
        C.PawnPlayedDying = BitOf(C.FortPawn, "bPlayedDying");
        C.InventoryItemsList = Off(C.InventoryItems, "Items");
        auto ItemAndCount = FindStruct("ItemAndCount");
        C.ItemAndCountSize = ItemAndCount ? ItemAndCount->GetPropertiesSize() : 0;
        C.ItemAndCountItem = Off(ItemAndCount, "Item");
        C.ItemAndCountCount = Off(ItemAndCount, "Count");
        C.InventoryType = Off(C.Inventory, "InventoryType");
        if (auto Enum = FindEnum("EFortInventoryType"))
            C.InventoryTypeWorld = Enum->GetValue("World");
        C.SpawnerInventoryComponent = Off(C.AISpawnerData, "InventoryComponent");
        C.SpawnerDescriptorTag = Off(C.SpawnerDataBase, "DescriptorTag");
        C.ActorSpawnerActorClass = Off(C.ActorSpawnerData, "ActorClass");
        C.WorldAISystem = Off(FindClass("World"), "AISystem");

        auto& F = GCalls;
        F.bResolved = true;
        F.SpawnerDataDefault = C.AISpawnerData ? C.AISpawnerData->GetDefaultObj() : nullptr;
        if (AIBase::IsLiveObject(F.SpawnerDataDefault))
            F.CreateComponentList = F.SpawnerDataDefault->GetFunction("CreateComponentListFromClass");
        if (F.CreateComponentList)
        {
            F.CCLClass = Off(F.CreateComponentList, "AISpawnerDataClass");
            F.CCLOuter = Off(F.CreateComponentList, "OuterObject");
            F.CCLReturn = Off(F.CreateComponentList, "ReturnValue");
            F.CCLSize = F.CreateComponentList->GetPropertiesSize();
        }
        auto SpawnerDefault = C.AISpawner ? C.AISpawner->GetDefaultObj() : nullptr;
        if (AIBase::IsLiveObject(SpawnerDefault))
            F.RequestSpawn = SpawnerDefault->GetFunction("RequestSpawn");
        if (F.RequestSpawn)
        {
            F.RSList = Off(F.RequestSpawn, "AISpawnerComponentList");
            F.RSTransform = Off(F.RequestSpawn, "SpawnTransform");
            F.RSReturn = Off(F.RequestSpawn, "ReturnValue");
            F.RSSize = F.RequestSpawn->GetPropertiesSize();
        }
        auto AIControllerClass = FindClass("AIController");
        auto AIControllerDefault = AIControllerClass ? AIControllerClass->GetDefaultObj() : nullptr;
        if (AIBase::IsLiveObject(AIControllerDefault))
            F.RunBehaviorTree = AIControllerDefault->GetFunction("RunBehaviorTree");
        if (F.RunBehaviorTree)
        {
            F.RBTAsset = Off(F.RunBehaviorTree, "BTAsset");
            F.RBTReturn = Off(F.RunBehaviorTree, "ReturnValue");
            F.RBTSize = F.RunBehaviorTree->GetPropertiesSize();
        }
        F.BrainComponent = Off(AIControllerClass, "BrainComponent");
        auto BrainClass = FindClass("BrainComponent");
        auto BrainDefault = BrainClass ? BrainClass->GetDefaultObj() : nullptr;
        if (AIBase::IsLiveObject(BrainDefault))
            F.IsRunning = BrainDefault->GetFunction("IsRunning");
        if (F.IsRunning)
        {
            F.IRReturn = Off(F.IsRunning, "ReturnValue");
            F.IRSize = F.IsRunning->GetPropertiesSize();
        }
        auto KismetClass = FindClass("KismetSystemLibrary");
        F.KismetSystem = KismetClass ? KismetClass->GetDefaultObj() : nullptr;
        if (AIBase::IsLiveObject(F.KismetSystem))
            F.LineTrace = F.KismetSystem->GetFunction("LineTraceSingle");
        if (F.LineTrace)
        {
            F.LTWorld = Off(F.LineTrace, "WorldContextObject");
            F.LTStart = Off(F.LineTrace, "Start");
            F.LTEnd = Off(F.LineTrace, "End");
            F.LTChannel = Off(F.LineTrace, "TraceChannel");
            F.LTHit = Off(F.LineTrace, "OutHit");
            F.LTIgnoreSelf = Off(F.LineTrace, "bIgnoreSelf");
            F.LTReturn = Off(F.LineTrace, "ReturnValue");
            F.LTSize = F.LineTrace->GetPropertiesSize();
            auto HitResult = FindStruct("HitResult");
            F.HitImpactPoint = Off(HitResult, "ImpactPoint");
            F.HitSize = HitResult ? HitResult->GetPropertiesSize() : 0;
        }
    }

    bool CanSpawnAI()
    {
        const auto& F = GCalls;
        return F.CreateComponentList && F.CCLClass >= 0 && F.CCLOuter >= 0 && F.CCLReturn >= 0 &&
            F.CCLSize > 0 && F.CCLSize <= 0x100 && F.RequestSpawn && F.RSList >= 0 && F.RSTransform >= 0 &&
            F.RSReturn >= 0 && F.RSSize > 0 && F.RSSize <= 0x200 &&
            F.RSTransform + FTransform::Size() <= F.RSSize && F.RSReturn + 4 <= F.RSSize;
    }

    // UFortAthenaAISpawnerData::CreateComponentListFromClass(Class, Outer).
    const UObject* CreateComponentList(const UClass* SpawnerClass, const UObject* Outer)
    {
        const auto& F = GCalls;
        alignas(16) uint8 Params[0x100] = {};
        *reinterpret_cast<const UClass**>(Params + F.CCLClass) = SpawnerClass;
        *reinterpret_cast<const UObject**>(Params + F.CCLOuter) = Outer;
        F.SpawnerDataDefault->ProcessEvent(F.CreateComponentList, Params);
        auto List = *reinterpret_cast<const UObject**>(Params + F.CCLReturn);
        return List && AIBase::IsLiveObject(List) ? List : nullptr;
    }

    // UAthenaAISpawner::RequestSpawn(ComponentList, Transform): the request ID, -1 = refused.
    int32 RequestSpawn(const UObject* Spawner, const UObject* List, const FVector& Location, const FRotator& Rotation)
    {
        const auto& F = GCalls;
        alignas(16) uint8 Params[0x200] = {};
        *reinterpret_cast<const UObject**>(Params + F.RSList) = List;
        FRotator Rot = Rotation;
        FTransform Transform(Location, (FQuat)Rot, FVector(1, 1, 1));
        memcpy(Params + F.RSTransform, &Transform, FTransform::Size());
        *reinterpret_cast<int32*>(Params + F.RSReturn) = -1;
        Spawner->ProcessEvent(F.RequestSpawn, Params);
        return *reinterpret_cast<const int32*>(Params + F.RSReturn);
    }

    // The brain component of an AI controller runs (UBrainComponent::IsRunning).
    bool IsBrainRunning(const UObject* Controller)
    {
        const auto& F = GCalls;
        if (!F.IsRunning || F.BrainComponent < 0 || F.IRReturn < 0 || F.IRSize <= 0 || F.IRSize > 0x40)
            return false;
        auto Brain = ObjectAt(Controller, F.BrainComponent);
        if (!Brain)
            return false;
        alignas(16) uint8 Params[0x40] = {};
        Brain->ProcessEvent(F.IsRunning, Params);
        return Params[F.IRReturn] != 0;
    }

    bool RunBehaviorTree(const UObject* Controller, const UObject* Tree)
    {
        const auto& F = GCalls;
        if (!F.RunBehaviorTree || F.RBTAsset < 0 || F.RBTReturn < 0 || F.RBTSize <= 0 || F.RBTSize > 0x40)
            return false;
        alignas(16) uint8 Params[0x40] = {};
        *reinterpret_cast<const UObject**>(Params + F.RBTAsset) = Tree;
        Controller->ProcessEvent(F.RunBehaviorTree, Params);
        return Params[F.RBTReturn] != 0;
    }

    // Where a straight trace down from Start hits the world (UKismetSystemLibrary::LineTraceSingle).
    bool TraceDown(const UObject* World, const FVector& Start, FVector& OutPoint)
    {
        const auto& F = GCalls;
        const int32 VectorSize = FVector::Size();
        if (!F.LineTrace || F.LTWorld < 0 || F.LTStart < 0 || F.LTEnd < 0 || F.LTHit < 0 || F.LTReturn < 0 ||
            F.HitImpactPoint < 0 || F.LTSize <= 0 || F.LTSize > 0x400 || F.LTHit + F.HitSize > F.LTSize ||
            F.HitImpactPoint + VectorSize > F.HitSize)
        {
            return false;
        }
        alignas(16) uint8 Params[0x400] = {};
        *reinterpret_cast<const UObject**>(Params + F.LTWorld) = World;
        FVector From = Start;
        FVector To(Start.X, Start.Y, Start.Z - 100000.0);
        memcpy(Params + F.LTStart, &From, VectorSize);
        memcpy(Params + F.LTEnd, &To, VectorSize);
        if (F.LTChannel >= 0)
            Params[F.LTChannel] = 0; // ETraceTypeQuery::TraceTypeQuery1 (visibility)
        if (F.LTIgnoreSelf >= 0)
            Params[F.LTIgnoreSelf] = 1;
        F.KismetSystem->ProcessEvent(F.LineTrace, Params);
        if (!Params[F.LTReturn])
            return false;
        FVector Point;
        memcpy(&Point, Params + F.LTHit + F.HitImpactPoint, VectorSize);
        if (!std::isfinite((double)Point.X) || !std::isfinite((double)Point.Y) || !std::isfinite((double)Point.Z))
            return false;
        OutPoint = Point;
        return true;
    }

    // ------------------------------------------------------------------ Lager layout (per match)

    struct FLager
    {
        const UClass* ManagerClass = nullptr;
        const UClass* ConfigClass = nullptr;
        const UClass* EventDataClass = nullptr;
        const UClass* DataTableClass = nullptr;
        // Manager
        int32 DefaultLagerConfig = -1, LagerConfigOverrides = -1, CachedConfig = -1, LagerEnabled = -1;
        int32 PointProviders = -1, RuntimePointProviderList = -1, LoadedSpawnerDataClass = -1;
        // FFortLivingWorldConfigOverride
        int32 OverrideSize = 0, OverrideWorld = -1, OverridePlaylistTag = -1, OverrideConfig = -1;
        // Config
        int32 CategoryTable = -1, MaxActorCount = -1;
        // EventData
        int32 ProviderQuery = -1, ProviderEntries = -1, EntrySize = 0, EntryQuery = -1;
        int32 MinActors = -1, MaxActors = -1, Descriptions = -1;
        // FFortAthenaLivingWorldEventDataActorSpawnDescription
        int32 DescSize = 0, DescActorClass = -1, DescSpawnerData = -1, DescSpawnerQuery = -1,
            DescQueryOverride = -1;
        FBit DescUseOverride;
        FBit DescAroundDefault;
        // FLivingWorldCalendarEventCondition(s)
        int32 CalendarConditions = -1, ConditionSize = 0;
        FBit ConditionShouldBeActive;
        // The playlist's tags.
        const FGameplayTagContainer* PlaylistTags = nullptr;
    };

    // ------------------------------------------------------------------ Match state

    enum class EBucket : int
    {
        Boss = 0,
        Guard = 1,
        Wildlife = 2,
        Character = 3,
        Other = 4,
        Skip = 5, // vehicles (Niobium's vehicle spawner owns them)
    };

    const char* BucketName(EBucket Bucket)
    {
        switch (Bucket)
        {
        case EBucket::Boss: return "boss";
        case EBucket::Guard: return "guard";
        case EBucket::Wildlife: return "creature";
        case EBucket::Character: return "character";
        case EBucket::Other: return "other";
        default: return "skipped";
        }
    }

    struct FProvider
    {
        FObjectRef Actor;
        FVector Location;
        FRotator Rotation;
        int32 TagsOffset = -1; // FGameplayTagContainer inside the actor
        bool bEnabled = true;
        bool bPatrolPath = false; // a raw patrol path (fallback only)
        bool bUsed = false;
    };

    struct FEvent
    {
        std::string Category;
        std::string Name;
        std::string DataName;
        std::string FirstSpawner; // short name of the first description's spawner data, for logs
        EBucket Bucket = EBucket::Other;
        int32 CategoryIndex = -1;
        float CategoryPriority = 0.f;
        FObjectRef EventData;
        int32 MaxInstances = 0;
        int32 MinActors = 1;
        int32 MaxActors = 1;
        int32 Descriptions = 0;
        float RespawnSeconds = kDefaultRespawnSeconds;
        // Matching state.
        const uint8* Query = nullptr;          // into EventData, valid while it lives
        std::vector<const uint8*> EntryQueries;
        bool bMatchAll = false;
        int32 Cursor = 0;
        bool bMatched = false;
        std::vector<int32> Places;             // provider indices
    };

    struct FCategory
    {
        std::string Name;
        int32 MaxCount = 0;
        int32 Planned = 0;
    };

    struct FGroup
    {
        int32 Event = -1;
        int32 Provider = -1;
        int32 ActorCount = 1;
        FVector Location;
        FRotator Rotation;
        int32 Spawns = 0;
        int32 Requests = 0;
        ULONGLONG NextRespawnMs = 0;
        bool bFailed = false;
    };

    struct FPending
    {
        FVector Location;
        ULONGLONG TimeMs = 0;
        int32 Group = -1;
        const UClass* SpawnerClass = nullptr;
    };

    struct FTrackedNPC
    {
        FObjectRef Pawn;
        FObjectRef Controller;
        int32 Group = -1;
        const UClass* SpawnerClass = nullptr;
        ULONGLONG FirstSeenMs = 0;
        int32 InventoryAttempts = 0;
        bool bInventoryDone = false;
        int32 BrainAttempts = 0;
        ULONGLONG LastBrainMs = 0;
        bool bBrainRunning = false;
        bool bBrainGivenUp = false;
        bool bAlive = true;
    };

    enum class EStage : int
    {
        Waiting = 0,
        Resolve,
        Plan,
        Spawn,
        Done,
        Failed,
    };

    struct FMatch
    {
        const UObject* World = nullptr;
        EStage Stage = EStage::Waiting;
        FLager L;
        FObjectRef Manager;
        FObjectRef Config;
        FObjectRef AISpawner;
        std::vector<FCategory> Categories;
        std::vector<FEvent> Events;
        std::vector<int32> Order;     // events by priority
        int32 PlanCursor = 0;
        std::vector<FProvider> Providers;
        std::vector<FProvider> PatrolPaths;
        std::vector<FGroup> Groups;
        int32 SpawnCursor = 0;
        int32 PlannedActors = 0;
        std::vector<FPending> Pending;
        std::unordered_map<uint64, FTrackedNPC> NPCs;
        std::unordered_set<uint64> NPCControllers; // every tracked NPC's controller
        std::unordered_set<uint64> OwnControllers; // NPCs that came from our own spawn requests
        std::vector<FVector> AliveNPCLocations;
        std::vector<FVector> PlayerLocations;
        int32 AliveNPCs = 0;
        int32 SeenNPCs = 0;
        int32 ActorSpawns = 0;
        int32 Requests = 0;
        int32 RefusedRequests = 0;
        int32 RunningBrains = 0;
        int32 GivenUpBrains = 0;
        ULONGLONG FirstRequestMs = 0;
        ULONGLONG LastUpkeepMs = 0;
        ULONGLONG LastRespawnCheckMs = 0;
        ULONGLONG LastEmitMs = 0;
        int32 LastEmitSpawned = -1;
        std::string LastEmitReason = "-";
        bool bActivated = false;
        bool bRemovedFromAliveLogged = false;
        int32 SkippedCalendar = 0;
        int32 SkippedVehicles = 0;
        std::mt19937 Random{ 0 };
    };

    FMatch GMatch;

    // Process-wide state.
    std::atomic<bool> GRequested{ false };
    std::atomic<bool> GActive{ false };
    int32 GMaxAI = 40;
    bool GNavigation = false;         // 19.10 AI base passed and Living world uses it
    std::string GNoNavigationReason;  // the "standing only" reason when GNavigation is false
    AIBase::FFaultCounter GTickFaults("Living world spawning", 3);
    AIBase::FFaultCounter GUpkeepFaults("Living world upkeep", 3);

    // ------------------------------------------------------------------ Events to the launcher

    int32 SpawnedCount()
    {
        return GMatch.SeenNPCs + GMatch.ActorSpawns;
    }

    std::string CurrentReason()
    {
        if (!GNavigation)
            return GNoNavigationReason;
        const auto Flag = AIBase1910::GetBrainFlag();
        if (Flag != AIBase1910::EBrainFlag::Found && Flag != AIBase1910::EBrainFlag::NotNeeded)
            return "standing only (brain start flag not found)";
        if (GMatch.RunningBrains == 0 && GMatch.GivenUpBrains > 0)
            return "standing only (the AI brains did not start)";
        return "";
    }

    void Emit(bool bForce)
    {
        auto& M = GMatch;
        const ULONGLONG Now = GetTickCount64();
        const int32 Spawned = SpawnedCount();
        const std::string Reason = CurrentReason();
        const bool bChanged = Spawned != M.LastEmitSpawned;
        if (!bForce && Reason == M.LastEmitReason &&
            !(bChanged && (std::abs(Spawned - M.LastEmitSpawned) >= kEmitStep || Now - M.LastEmitMs >= kEmitIntervalMs)))
        {
            return;
        }
        M.LastEmitSpawned = Spawned;
        M.LastEmitReason = Reason;
        M.LastEmitMs = Now;
        NiobiumControl::EmitLivingWorld("active", Reason, Spawned);
    }

    void Fail(const std::string& Reason)
    {
        auto& M = GMatch;
        M.Stage = EStage::Failed;
        const int32 Spawned = SpawnedCount();
        if (Spawned > 0)
        {
            LogAlways("stopped spawning: %s (%d spawned so far)", Reason.c_str(), Spawned);
            NiobiumControl::EmitLivingWorld("active", "stopped spawning: " + Reason, Spawned);
            return;
        }
        GActive.store(false, std::memory_order_release);
        LogAlways("unavailable: %s", Reason.c_str());
        NiobiumControl::EmitLivingWorld("unavailable", Reason, 0);
    }

    // ------------------------------------------------------------------ Classification

    EBucket Classify(const std::string& RawText)
    {
        const std::string Text = Lower(RawText);
        auto Has = [&](std::initializer_list<const char*> Words)
        {
            for (auto Word : Words)
            {
                if (Text.find(Word) != std::string::npos)
                    return true;
            }
            return false;
        };
        if (Has({ "vehicle", "valet", "taxi", "_car", "car_", "truck", "boat", "ufo", "saucer", "helicopter", "choppa" }))
            return EBucket::Skip;
        if (Has({ "boss", "tamefoot", "foundation", "mythic" }))
            return EBucket::Boss;
        if (Has({ "guard", "henchman", "henchmen", "sentr", "seven", "io_", "_io", "ioguard", "trooper", "grunt",
                "minion", "marauder", "trespasser", "sideways", "monster", "cube", "elite", "enemy", "hostile" }))
        {
            return EBucket::Guard;
        }
        if (Has({ "wildlife", "klombo", "wolf", "boar", "chicken", "frog", "raptor", "crow", "shark", "animal",
                "fauna", "dino", "creature", "parasite" }))
        {
            return EBucket::Wildlife;
        }
        if (Has({ "npc", "character", "conversation", "cosmos", "tandem", "hunter", "hireable", "vendor", "service" }))
            return EBucket::Character;
        return EBucket::Other;
    }

    // ------------------------------------------------------------------ Resolve

    bool IsLive(const UObject* Object)
    {
        return Object && AIBase::IsLiveObject(Object);
    }

    const UObject* FindManager(const UObject* GameState, const UClass* ManagerClass)
    {
        const UObject* Fallback = nullptr;
        const int32 Count = TUObjectArray::Num();
        for (int32 Index = 0; Index < Count; ++Index)
        {
            auto Object = TUObjectArray::GetObjectByIndex(Index);
            if (!Object || !Object->Class || Object->IsDefaultObject() || !Object->IsA(ManagerClass))
                continue;
            if (!IsLive(Object))
                continue;
            if (Object->Outer == GameState)
                return Object;
            if (!Fallback)
                Fallback = Object;
        }
        return Fallback;
    }

    bool ResolveLagerLayout(FLager& L, std::string& Why)
    {
        L.ManagerClass = FindClass("FortAthenaLivingWorldManager");
        L.ConfigClass = FindClass("FortAthenaLivingWorldConfigData");
        L.EventDataClass = FindClass("FortAthenaLivingWorldEventData");
        L.DataTableClass = FindClass("DataTable");
        if (!L.ManagerClass || !L.ConfigClass || !L.EventDataClass || !L.DataTableClass)
        {
            Why = !L.ManagerClass ? "this version has no Living World manager (Lager)" :
                !L.ConfigClass ? "this version has no Living World config class" :
                !L.EventDataClass ? "this version has no Living World event data class" : "no DataTable class";
            return false;
        }
        L.DefaultLagerConfig = Off(L.ManagerClass, "DefaultLagerConfig");
        L.LagerConfigOverrides = Off(L.ManagerClass, "LagerConfigOverrides");
        L.CachedConfig = Off(L.ManagerClass, "CachedConfig");
        L.LagerEnabled = Off(L.ManagerClass, "LagerEnabled");
        L.PointProviders = Off(L.ManagerClass, "PointProviders");
        L.RuntimePointProviderList = Off(L.ManagerClass, "RuntimePointProviderList");
        L.LoadedSpawnerDataClass = Off(L.ManagerClass, "LoadedSpawnerDataClass");
        auto Override = FindStruct("FortLivingWorldConfigOverride");
        L.OverrideSize = Override ? Override->GetPropertiesSize() : 0;
        L.OverrideWorld = Off(Override, "SourceWorld");
        L.OverridePlaylistTag = Off(Override, "PlaylistTag");
        L.OverrideConfig = Off(Override, "LagerConfig");
        L.CategoryTable = Off(L.ConfigClass, "CategoryTable");
        L.MaxActorCount = Off(L.ConfigClass, "MaxActorCount");
        L.ProviderQuery = Off(L.EventDataClass, "ProviderFiltersTagQuery");
        L.ProviderEntries = Off(L.EventDataClass, "ProviderFiltersEntries");
        auto Entry = FindStruct("PointProviderFilterEntry");
        L.EntrySize = Entry ? Entry->GetPropertiesSize() : 0;
        L.EntryQuery = Off(Entry, "ProviderFiltersTagQuery");
        L.MinActors = Off(L.EventDataClass, "MinActorCountToSpawn");
        L.MaxActors = Off(L.EventDataClass, "MaxActorCountToSpawn");
        L.Descriptions = Off(L.EventDataClass, "ActorDescriptions");
        auto Description = FindStruct("FortAthenaLivingWorldEventDataActorSpawnDescription");
        L.DescSize = Description ? Description->GetPropertiesSize() : 0;
        L.DescActorClass = Off(Description, "ActorClass");
        L.DescSpawnerData = Off(Description, "SpawnerData");
        L.DescSpawnerQuery = Off(Description, "SpawnerDataTagQuery");
        L.DescQueryOverride = Off(Description, "ProviderFiltersTagQueryOverride");
        L.DescUseOverride = BitOf(Description, "bUseProviderTagOverrides");
        L.DescAroundDefault = BitOf(Description, "bSpawnAroundDefaultPoint");
        auto Conditions = FindStruct("LivingWorldCalendarEventConditions");
        auto Condition = FindStruct("LivingWorldCalendarEventCondition");
        L.CalendarConditions = Off(Conditions, "Conditions");
        L.ConditionSize = Condition ? Condition->GetPropertiesSize() : 0;
        L.ConditionShouldBeActive = BitOf(Condition, "ShouldEventBeActive");

        if (L.DefaultLagerConfig < 0 && L.CachedConfig < 0)
            Why = "the Living World manager has no config field";
        else if (L.CategoryTable < 0)
            Why = "the Living World config has no CategoryTable";
        else if (L.Descriptions < 0 || L.DescSize <= 0 || (L.DescSpawnerData < 0 && L.DescActorClass < 0))
            Why = "the Living World event data has no ActorDescriptions";
        else
            return true;
        return false;
    }

    const UObject* PickConfig(const UObject* Manager, const UObject* World, FLager& L)
    {
        // A LagerConfigOverrides entry for this playlist (and world, when it names one).
        const uint8* Data = nullptr;
        const int32 Overrides = L.OverrideSize > 0 ? ArrayAt(Manager, L.LagerConfigOverrides, &Data, 64) : 0;
        const std::string WorldName = Lower(NameOf(World));
        for (int32 Index = 0; Index < Overrides && L.PlaylistTags; ++Index)
        {
            const uint8* Entry = Data + (size_t)Index * L.OverrideSize;
            auto Tags = At<FGameplayTagContainer>(Entry, L.OverridePlaylistTag);
            if (!Tags || Tags->GameplayTags.Num() <= 0 || !L.PlaylistTags->HasAny(*Tags))
                continue;
            if (L.OverrideWorld >= 0)
            {
                const std::string Path = Lower(Narrow(SoftPath(Entry + L.OverrideWorld)));
                if (!Path.empty() && Lower(ShortName(Path)) != WorldName)
                    continue;
            }
            if (auto Config = L.OverrideConfig >= 0 ? LoadSoft(Entry + L.OverrideConfig, L.ConfigClass) : nullptr)
            {
                Log("config override %d of %d for this playlist: %s", Index + 1, Overrides, NameOf(Config).c_str());
                return Config;
            }
        }
        if (auto Cached = ObjectAt(Manager, L.CachedConfig))
        {
            if (Cached->IsA(L.ConfigClass))
            {
                Cached->AddToRoot();
                return Cached;
            }
        }
        return L.DefaultLagerConfig >= 0 ? LoadSoft(At<uint8>(Manager, L.DefaultLagerConfig), L.ConfigClass) : nullptr;
    }

    const UStruct* RowStructOf(const UObject* Table)
    {
        auto RowStruct = ObjectAt(Table, Off(Table->Class, "RowStruct"));
        return RowStruct ? static_cast<const UStruct*>(RowStruct) : nullptr;
    }

    const UObject* LoadTable(const uint8* SoftAddress, const UClass* DataTableClass)
    {
        return SoftAddress ? LoadSoft(SoftAddress, DataTableClass) : nullptr;
    }

    // Whether an event waits for a calendar event (Winterfest, ...): any condition that wants an
    // event to be active. We can't evaluate the calendar, so those events stay off.
    bool WaitsForCalendarEvent(const uint8* Row, int32 ConditionsOffset, const FLager& L)
    {
        if (ConditionsOffset < 0 || L.CalendarConditions < 0 || L.ConditionSize <= 0)
            return false;
        const uint8* Data = nullptr;
        const int32 Num = ArrayAt(Row + ConditionsOffset, L.CalendarConditions, &Data, 64);
        for (int32 Index = 0; Index < Num; ++Index)
        {
            if (ReadBool(Data + (size_t)Index * L.ConditionSize, L.ConditionShouldBeActive, true))
                return true;
        }
        return false;
    }

    void AddEventsOfCategory(FMatch& M, int32 CategoryIndex, const UObject* EventTable, float Priority)
    {
        const auto& L = M.L;
        auto RowStruct = RowStructOf(EventTable);
        if (!RowStruct)
            return;
        const int32 EventDataOffset = Off(RowStruct, "EventData");
        const int32 IsEnabled = Off(RowStruct, "IsEnabled");
        const int32 RequireTags = Off(RowStruct, "RequirePlaylistTags");
        const int32 Calendar = Off(RowStruct, "CalendarEventConditions");
        if (EventDataOffset < 0)
            return;
        auto Table = static_cast<const UDataTable*>(EventTable);
        int32 Rows = 0;
        for (auto& Pair : Table->RowMap)
        {
            if (++Rows > kMaxEventsPerCategory || (int32)M.Events.size() >= kMaxEvents)
                break;
            const uint8* Row = Pair.Value();
            if (!Row)
                continue;
            const std::string RowName = Pair.Key().ToString().c_str();
            if (ScalableAt(Row, IsEnabled, 1.f) <= 0.f)
                continue;
            if (auto Tags = At<FGameplayTagContainer>(Row, RequireTags))
            {
                if (Tags->GameplayTags.Num() > 0 && (!L.PlaylistTags || !L.PlaylistTags->HasAny(*Tags)))
                    continue;
            }
            if (WaitsForCalendarEvent(Row, Calendar, L))
            {
                ++M.SkippedCalendar;
                continue;
            }
            // MaxCount per storm phase: the first entry is the start of the match. None = no budget
            // (Velora FortAthenaLivingWorldManager.cpp:1097-1099).
            const int32 Budget = (int32)NumberAt(RowStruct, Row, "MaxCount", 0.f);
            if (Budget <= 0)
                continue;
            const float Chance = NumberAt(RowStruct, Row, "RandomActivationChance", 1.f);
            if (Chance > 0.f && Chance < 1.f && std::uniform_real_distribution<float>(0.f, 1.f)(M.Random) > Chance)
                continue;
            auto EventData = LoadSoft(Row + EventDataOffset, L.EventDataClass);
            if (!EventData)
                continue;
            const uint8* Descriptions = nullptr;
            const int32 DescriptionCount = ArrayAt(EventData, L.Descriptions, &Descriptions, 64);
            if (DescriptionCount <= 0)
                continue;

            FEvent Event;
            Event.Category = M.Categories[CategoryIndex].Name;
            Event.Name = RowName;
            Event.DataName = NameOf(EventData);
            Event.CategoryIndex = CategoryIndex;
            Event.CategoryPriority = Priority;
            Event.EventData = FObjectRef::Of(EventData);
            Event.MaxInstances = (std::min)(Budget, 64);
            Event.Descriptions = DescriptionCount;
            const int32 MinActors = (int32)std::lround(ScalableAt(EventData, L.MinActors, 1.f));
            const int32 MaxActors = (int32)std::lround(ScalableAt(EventData, L.MaxActors, (float)MinActors));
            Event.MinActors = std::clamp(MinActors, 1, DescriptionCount);
            Event.MaxActors = std::clamp(MaxActors, Event.MinActors, DescriptionCount);
            const float RespawnSeconds = NumberAt(RowStruct, Row, "MinRespawnTime", 0.f);
            if (RespawnSeconds > 0.f && RespawnSeconds < 3600.f)
                Event.RespawnSeconds = RespawnSeconds;
            std::string SpawnerPath;
            if (L.DescSpawnerData >= 0)
                SpawnerPath = Narrow(SoftPath(Descriptions + L.DescSpawnerData));
            if (SpawnerPath.empty() && L.DescActorClass >= 0)
                SpawnerPath = Narrow(SoftPath(Descriptions + L.DescActorClass));
            Event.FirstSpawner = SpawnerPath.empty() ? std::string("(tag query)") : ShortName(SpawnerPath);
            Event.Bucket = Classify(Event.Category + " " + Event.Name + " " + Event.DataName + " " + SpawnerPath);
            if (Event.Bucket == EBucket::Skip)
            {
                ++M.SkippedVehicles;
                continue;
            }

            // The provider filter: the first description's override, else the event data's query,
            // else its weighted entries; all empty = every provider (Velora :1269).
            const uint8* Query = nullptr;
            if (ReadBool(Descriptions, L.DescUseOverride, false) && L.DescQueryOverride >= 0)
                Query = Descriptions + L.DescQueryOverride;
            else if (L.ProviderQuery >= 0)
                Query = At<uint8>(EventData, L.ProviderQuery);
            if (Query && !IsQueryEmpty(Query))
                Event.Query = Query;
            else if (L.ProviderEntries >= 0 && L.EntrySize > 0 && L.EntryQuery >= 0)
            {
                const uint8* Entries = nullptr;
                const int32 EntryCount = ArrayAt(EventData, L.ProviderEntries, &Entries, 32);
                for (int32 Index = 0; Index < EntryCount; ++Index)
                {
                    const uint8* EntryQuery = Entries + (size_t)Index * L.EntrySize + L.EntryQuery;
                    if (!IsQueryEmpty(EntryQuery))
                        Event.EntryQueries.push_back(EntryQuery);
                }
            }
            Event.bMatchAll = !Event.Query && Event.EntryQueries.empty();
            M.Events.push_back(std::move(Event));
        }
    }

    void ReadCategories(FMatch& M, const UObject* Config)
    {
        const auto& L = M.L;
        auto CategoryTable = LoadTable(At<uint8>(Config, L.CategoryTable), L.DataTableClass);
        if (!CategoryTable)
            return;
        auto RowStruct = RowStructOf(CategoryTable);
        if (!RowStruct)
            return;
        const int32 EventTable = Off(RowStruct, "EventTable");
        const int32 Variations = Off(RowStruct, "EventTableVariations");
        auto Variation = FindStruct("FortLivingWorldEventTableVariation");
        const int32 VariationSize = Variation ? Variation->GetPropertiesSize() : 0;
        const int32 VariationTable = Off(Variation, "EventTableVariation");
        const int32 IsEnabled = Off(RowStruct, "IsEnabled");
        const int32 RequireQuery = Off(RowStruct, "RequirePlaylistTagQuery");
        const int32 RequireTags = Off(RowStruct, "RequirePlaylistTags");
        if (EventTable < 0)
            return;

        auto Table = static_cast<const UDataTable*>(CategoryTable);
        int32 Rows = 0;
        int32 Active = 0;
        for (auto& Pair : Table->RowMap)
        {
            if (++Rows > kMaxCategories)
                break;
            const uint8* Row = Pair.Value();
            if (!Row)
                continue;
            const std::string Name = Pair.Key().ToString().c_str();
            const char* SkipReason = nullptr;
            if (ScalableAt(Row, IsEnabled, 1.f) <= 0.f)
                SkipReason = "disabled";
            else if (RequireQuery >= 0 && !IsQueryEmpty(Row + RequireQuery) &&
                (!L.PlaylistTags || !QueryMatches(reinterpret_cast<const uint8*>(L.PlaylistTags), Row + RequireQuery)))
            {
                SkipReason = "not for this playlist";
            }
            else if (RequireQuery < 0 && RequireTags >= 0)
            {
                auto Tags = At<FGameplayTagContainer>(Row, RequireTags);
                if (Tags && Tags->GameplayTags.Num() > 0 && (!L.PlaylistTags || !L.PlaylistTags->HasAny(*Tags)))
                    SkipReason = "not for this playlist";
            }
            // Velora FortAthenaLivingWorldManager.cpp:611: the category budget is MaxCount.
            const int32 Budget = (int32)NumberAt(RowStruct, Row, "MaxCount", 64.f);
            const float Priority = NumberAt(RowStruct, Row, "Priority", 0.f);
            if (!SkipReason && Budget <= 0)
                SkipReason = "MaxCount 0";
            if (SkipReason)
            {
                Log("category %s: off (%s)", Name.c_str(), SkipReason);
                continue;
            }
            auto Events = LoadTable(Row + EventTable, L.DataTableClass);
            if (!Events && Variations >= 0 && VariationSize > 0 && VariationTable >= 0)
            {
                const uint8* Data = nullptr;
                if (ArrayAt(Row, Variations, &Data, 16) > 0)
                    Events = LoadTable(Data + VariationTable, L.DataTableClass);
            }
            if (!Events)
            {
                Log("category %s: its event table can't be loaded", Name.c_str());
                continue;
            }
            FCategory Category;
            Category.Name = Name;
            Category.MaxCount = (std::min)(Budget, 256);
            M.Categories.push_back(Category);
            const size_t Before = M.Events.size();
            AddEventsOfCategory(M, (int32)M.Categories.size() - 1, Events, Priority);
            ++Active;
            Log("category %s: %d enabled event(s), max %d, priority %g", Name.c_str(),
                (int)(M.Events.size() - Before), Category.MaxCount, (double)Priority);
        }
        Log("%d of %d categories used, %d events (%d wait for a calendar event, %d are vehicles)", Active, Rows,
            (int)M.Events.size(), M.SkippedCalendar, M.SkippedVehicles);
    }

    // ------------------------------------------------------------------ Point providers

    void AddProvider(FMatch& M, const UObject* Actor, const UObject* World, std::unordered_set<uint64>& Known)
    {
        if (!IsLive(Actor) || M.Providers.size() >= (size_t)kMaxProviders || !Known.insert(KeyOf(Actor)).second)
            return;
        auto Class = Actor->Class;
        const int32 Tags = Off(Class, "FiltersTags");
        const std::string ClassName = Lower(NameOf(Class));
        if (Tags < 0 || ClassName.find("aroundplayer") != std::string::npos)
            return; // points around players come from EQS (stripped)
        auto ProviderActor = static_cast<const AActor*>(Actor);
        FProvider Provider;
        Provider.Actor = FObjectRef::Of(Actor);
        Provider.TagsOffset = Tags;
        Provider.Location = ProviderActor->K2_GetActorLocation();
        Provider.Rotation = ProviderActor->K2_GetActorRotation();
        Provider.bEnabled = ReadBool(Actor, BitOf(Class, "bStartEnabled"), true);

        if (ClassName.find("patrolpath") != std::string::npos)
        {
            // Velora FortAthenaPatrolPathPointProvider.cpp:109-129: spawn on a patrol point.
            auto Path = ObjectAt(Actor, Off(Class, "AssociatedPatrolPath"));
            if (Path && ReadBool(Actor, BitOf(Class, "bSpawnOnPatrolPath"), true))
            {
                const uint8* Points = nullptr;
                const int32 Num = ArrayAt(Path, Off(Path->Class, "PatrolPoints"), &Points, 256);
                if (Num > 0)
                {
                    const bool bRandom = ReadBool(Path, BitOf(Path->Class, "bUseRandomStartupPatrolPoint"), false);
                    const int32 Pick = bRandom ? std::uniform_int_distribution<int32>(0, Num - 1)(M.Random) : 0;
                    auto Point = reinterpret_cast<AActor* const*>(Points)[Pick];
                    if (Point && IsLive(Point))
                        Provider.Location = Point->K2_GetActorLocation();
                }
            }
        }
        else if (ClassName.find("volume") != std::string::npos)
        {
            // A volume gives points through EQS (stripped): its middle, put on the ground.
            FVector Ground;
            const FVector Start(Provider.Location.X, Provider.Location.Y, Provider.Location.Z + 20000.0);
            if (!TraceDown(World, Start, Ground))
                return;
            Provider.Location = FVector(Ground.X, Ground.Y, Ground.Z + 100.0);
        }
        M.Providers.push_back(Provider);
    }

    void CollectProviders(FMatch& M, const UObject* Manager, const UObject* World)
    {
        std::unordered_set<uint64> Known;
        static const char* const ClassNames[] = {
            "FortAthenaPatrolPathPointProvider",
            "FortAthenaLivingWorldVolume",
            "FortAthenaLivingWorldStaticPointProvider",
        };
        for (auto ClassName : ClassNames)
        {
            auto Class = FindClass(ClassName);
            if (!Class)
                continue;
            TArray<AActor*> Actors;
            Utils::GetAll(Class, Actors);
            for (int32 Index = 0; Index < Actors.Num(); ++Index)
                AddProvider(M, Actors[Index], World, Known);
            Log("providers: %d %s", Actors.Num(), ClassName);
            Actors.Free();
        }
        // The manager's own lists (registered providers; TScriptInterface = object + interface).
        const uint8* Data = nullptr;
        const int32 Registered = ArrayAt(Manager, M.L.PointProviders, &Data, kMaxProviders);
        for (int32 Index = 0; Index < Registered; ++Index)
            AddProvider(M, *reinterpret_cast<const UObject* const*>(Data + (size_t)Index * 0x10), World, Known);
        const int32 Runtime = ArrayAt(Manager, M.L.RuntimePointProviderList, &Data, kMaxProviders);
        for (int32 Index = 0; Index < Runtime; ++Index)
            AddProvider(M, *reinterpret_cast<const UObject* const*>(Data + (size_t)Index * sizeof(void*)), World, Known);

        // Raw patrol paths with tags, a fallback for events no provider matches (Cubed's idea).
        if (auto PatrolClass = FindClass("FortAthenaPatrolPath"))
        {
            const int32 Tags = Off(PatrolClass, "GameplayTags");
            const int32 PointsOffset = Off(PatrolClass, "PatrolPoints");
            TArray<AActor*> Paths;
            Utils::GetAll(PatrolClass, Paths);
            for (int32 Index = 0; Index < Paths.Num() && Tags >= 0; ++Index)
            {
                auto Path = Paths[Index];
                if (!IsLive(Path) || M.PatrolPaths.size() >= (size_t)kMaxProviders)
                    continue;
                FProvider Provider;
                Provider.Actor = FObjectRef::Of(Path);
                Provider.TagsOffset = Off(Path->Class, "GameplayTags");
                Provider.bPatrolPath = true;
                Provider.Location = Path->K2_GetActorLocation();
                Provider.Rotation = Path->K2_GetActorRotation();
                const uint8* Points = nullptr;
                if (ArrayAt(Path, PointsOffset, &Points, 256) > 0)
                {
                    auto Point = *reinterpret_cast<AActor* const*>(Points);
                    if (Point && IsLive(Point))
                        Provider.Location = Point->K2_GetActorLocation();
                }
                M.PatrolPaths.push_back(Provider);
            }
            Paths.Free();
        }
        Log("providers: %d places with filter tags (%d registered, %d runtime), %d patrol paths",
            (int)M.Providers.size(), Registered, Runtime, (int)M.PatrolPaths.size());
    }

    const uint8* ProviderTags(const FProvider& Provider)
    {
        auto Actor = Provider.Actor.Get();
        return Actor && Provider.TagsOffset >= 0 ? reinterpret_cast<const uint8*>(Actor) + Provider.TagsOffset : nullptr;
    }

    bool ProviderMatches(const FEvent& Event, const FProvider& Provider)
    {
        if (Event.bMatchAll)
            return Provider.Actor.Get() != nullptr;
        auto Tags = ProviderTags(Provider);
        if (!Tags)
            return false;
        if (Event.Query)
            return QueryMatches(Tags, Event.Query);
        for (auto Query : Event.EntryQueries)
        {
            if (QueryMatches(Tags, Query))
                return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ Resolve stage

    void Resolve(const LivingWorldSpawner::FTickInput& In)
    {
        auto& M = GMatch;
        std::string Why;
        if (!In.GameState || !AIBase::IsLiveObject(In.GameState))
            return Fail("the match has no game state");
        if (!ResolveLagerLayout(M.L, Why))
            return Fail(Why);
        if (!ResolveTagQuery())
            return Fail("BlueprintGameplayTagLibrary.DoesContainerMatchTagQuery is missing");
        if (!CanSpawnAI())
            return Fail("the AI spawner functions (CreateComponentListFromClass, RequestSpawn) are missing");

        auto AISystem = ObjectAt(In.World, GClasses.WorldAISystem);
        auto AISpawner = AISystem ? ObjectAt(AISystem, Off(AISystem->Class, "AISpawner")) : nullptr;
        if (!AISpawner || !AISpawner->IsA(GClasses.AISpawner))
            return Fail(!AISystem ? "the world has no AI system" : "the AI system has no AI spawner");
        M.AISpawner = FObjectRef::Of(AISpawner);

        auto Manager = FindManager(In.GameState, M.L.ManagerClass);
        if (!Manager)
            return Fail("the Living World manager (Lager) is not on the game state");
        M.Manager = FObjectRef::Of(Manager);
        LogAlways("found the Living World manager %s (class %s)", NameOf(Manager).c_str(), NameOf(Manager->Class).c_str());

        if (M.L.LagerEnabled >= 0 && ScalableAt(Manager, M.L.LagerEnabled, 1.f) <= 0.f)
            return Fail("the playlist switches the Living World off (LagerEnabled = 0)");

        auto Playlist = AFortGameMode::GetActivePlaylist(In.GameState);
        if (IsLive(Playlist))
        {
            const int32 Tags = Off(Playlist->Class, "GameplayTagContainer");
            M.L.PlaylistTags = Tags >= 0 ? At<FGameplayTagContainer>(Playlist, Tags) : nullptr;
        }

        auto Config = PickConfig(Manager, In.World, M.L);
        if (!Config)
            return Fail("the Living World manager has no config (DefaultLagerConfig can't be loaded)");
        M.Config = FObjectRef::Of(Config);
        Log("config %s, game max actors %g", NameOf(Config).c_str(), (double)ScalableAt(Config, M.L.MaxActorCount, -1.f));

        ReadCategories(M, Config);
        if (M.Events.empty())
            return Fail("no Living World event is enabled for this playlist");

        CollectProviders(M, Manager, In.World);
        if (M.Providers.empty() && M.PatrolPaths.empty())
            return Fail("the map has no Living World point providers");

        // Bosses first, then guards, creatures, characters, others; higher category priority first.
        M.Order.resize(M.Events.size());
        for (size_t Index = 0; Index < M.Events.size(); ++Index)
            M.Order[Index] = (int32)Index;
        std::stable_sort(M.Order.begin(), M.Order.end(), [&](int32 A, int32 B)
            {
                const auto& First = M.Events[A];
                const auto& Second = M.Events[B];
                if (First.Bucket != Second.Bucket)
                    return (int)First.Bucket < (int)Second.Bucket;
                return First.CategoryPriority > Second.CategoryPriority;
            });
        M.Stage = EStage::Plan;
    }

    // ------------------------------------------------------------------ Plan stage

    void PlanEvent(FMatch& M, FEvent& Event)
    {
        // Free places, enabled ones first, in random order.
        std::vector<int32> Enabled;
        std::vector<int32> Disabled;
        for (auto Index : Event.Places)
        {
            if (M.Providers[Index].bUsed)
                continue;
            (M.Providers[Index].bEnabled ? Enabled : Disabled).push_back(Index);
        }
        std::shuffle(Enabled.begin(), Enabled.end(), M.Random);
        std::shuffle(Disabled.begin(), Disabled.end(), M.Random);
        Enabled.insert(Enabled.end(), Disabled.begin(), Disabled.end());

        auto& Category = M.Categories[Event.CategoryIndex];
        int32 Instances = (std::min)(Event.MaxInstances, Category.MaxCount - Category.Planned);
        bool bPatrolFallback = false;
        std::vector<int32> Fallback;
        if (Enabled.empty() && !Event.bMatchAll)
        {
            // No Lager provider: a raw patrol path with matching tags (bounded by the budget).
            for (int32 Index = 0; Index < (int32)M.PatrolPaths.size() && GTagQuery.Calls < kMatchCallsPerTick * 2; ++Index)
            {
                auto& Path = M.PatrolPaths[Index];
                if (!Path.bUsed && ProviderMatches(Event, Path))
                    Fallback.push_back(Index);
            }
            std::shuffle(Fallback.begin(), Fallback.end(), M.Random);
            bPatrolFallback = !Fallback.empty();
        }
        const auto& Places = bPatrolFallback ? Fallback : Enabled;
        Instances = (std::min)(Instances, (int32)Places.size());
        int32 Planned = 0;
        for (int32 Index = 0; Index < Instances && M.PlannedActors < GMaxAI; ++Index)
        {
            auto& Place = bPatrolFallback ? M.PatrolPaths[Places[Index]] : M.Providers[Places[Index]];
            Place.bUsed = true;
            FGroup Group;
            Group.Event = (int32)(&Event - M.Events.data());
            Group.Provider = Places[Index];
            Group.ActorCount = std::uniform_int_distribution<int32>(Event.MinActors, Event.MaxActors)(M.Random);
            Group.ActorCount = (std::min)(Group.ActorCount, (std::min)(kMaxActorsPerGroup, GMaxAI - M.PlannedActors));
            Group.Location = Place.Location;
            Group.Rotation = Place.Rotation;
            M.PlannedActors += Group.ActorCount;
            M.Groups.push_back(Group);
            ++Planned;
        }
        Category.Planned += Planned;
        if (Planned > 0)
        {
            Log("plan: %s %s/%s x%d (%s, %d place(s)%s)", BucketName(Event.Bucket), Event.Category.c_str(),
                Event.Name.c_str(), Planned, Event.FirstSpawner.c_str(), (int)Places.size(),
                bPatrolFallback ? " on tagged patrol paths" : "");
        }
        else
        {
            Log("plan: %s %s/%s has no free place (%d matching)", BucketName(Event.Bucket), Event.Category.c_str(),
                Event.Name.c_str(), (int)Event.Places.size());
        }
    }

    // Matches providers to events with a budget of tag-query calls per poll, in priority order.
    // Returns true once every event is planned.
    bool PlanStep(FMatch& M)
    {
        GTagQuery.Calls = 0;
        while (M.PlanCursor < (int32)M.Order.size())
        {
            if (M.PlannedActors >= GMaxAI)
            {
                Log("plan: the AI limit (%d) is reached, %d event(s) left out", GMaxAI,
                    (int)M.Order.size() - M.PlanCursor);
                M.PlanCursor = (int32)M.Order.size();
                break;
            }
            auto& Event = M.Events[M.Order[M.PlanCursor]];
            if (!Event.EventData.Get())
            {
                ++M.PlanCursor;
                continue;
            }
            while (Event.Cursor < (int32)M.Providers.size())
            {
                if (GTagQuery.Calls >= kMatchCallsPerTick)
                    return false;
                const int32 Index = Event.Cursor++;
                if (!M.Providers[Index].bUsed && ProviderMatches(Event, M.Providers[Index]))
                    Event.Places.push_back(Index);
            }
            PlanEvent(M, Event);
            ++M.PlanCursor;
        }
        return true;
    }

    // ------------------------------------------------------------------ Spawn

    bool IsVehicleClass(const UClass* Class)
    {
        if (!Class)
            return true;
        if (GClasses.Vehicle && AIBase::IsChildOfClass(Class, GClasses.Vehicle))
            return true;
        const std::string Name = Lower(NameOf(Class));
        return Name.find("vehicle") != std::string::npos;
    }

    // The spawner data class of a description: its SpawnerData, else a loaded spawner data class
    // whose DescriptorTag matches its SpawnerDataTagQuery (Velora GetSpawnerDataClass).
    const UClass* SpawnerClassOf(FMatch& M, const uint8* Description)
    {
        const auto& L = M.L;
        if (L.DescSpawnerData >= 0)
        {
            if (auto Class = LoadSoftClass(Description + L.DescSpawnerData))
                return Class;
        }
        if (L.DescSpawnerQuery < 0 || IsQueryEmpty(Description + L.DescSpawnerQuery) ||
            GClasses.SpawnerDescriptorTag < 0)
        {
            return nullptr;
        }
        auto Manager = M.Manager.Get();
        const uint8* Data = nullptr;
        const int32 Num = Manager ? ArrayAt(Manager, L.LoadedSpawnerDataClass, &Data, 1024) : 0;
        std::vector<const UClass*> Matches;
        for (int32 Index = 0; Index < Num; ++Index)
        {
            auto Class = reinterpret_cast<const UClass* const*>(Data)[Index];
            auto Default = Class && IsLive(Class) ? Class->GetDefaultObj() : nullptr;
            if (!IsLive(Default))
                continue;
            if (QueryMatches(reinterpret_cast<const uint8*>(Default) + GClasses.SpawnerDescriptorTag,
                    Description + L.DescSpawnerQuery))
            {
                Matches.push_back(Class);
            }
        }
        if (Matches.empty())
            return nullptr;
        auto Picked = Matches[std::uniform_int_distribution<size_t>(0, Matches.size() - 1)(M.Random)];
        Picked->AddToRoot();
        return Picked;
    }

    // Spawns one group (one event instance at its place). Returns the number of actors requested.
    int32 SpawnGroup(FMatch& M, FGroup& Group, const UObject* World, ULONGLONG Now)
    {
        const auto& L = M.L;
        auto& Event = M.Events[Group.Event];
        auto EventData = Event.EventData.Get();
        auto Spawner = M.AISpawner.Get();
        if (!EventData || !Spawner)
        {
            Group.bFailed = true;
            return 0;
        }
        const uint8* Descriptions = nullptr;
        const int32 Count = (std::min)(Group.ActorCount, ArrayAt(EventData, L.Descriptions, &Descriptions, 64));
        int32 Requested = 0;
        for (int32 Index = 0; Index < Count; ++Index)
        {
            const uint8* Description = Descriptions + (size_t)Index * L.DescSize;
            // Further actors stand around the first one.
            FVector Location = Group.Location;
            if (Index > 0)
            {
                const double Angle = 2.0 * 3.14159265358979 * (double)Index / (double)Count;
                Location = FVector(Location.X + std::cos(Angle) * 180.0, Location.Y + std::sin(Angle) * 180.0, Location.Z);
            }

            auto SpawnerClass = SpawnerClassOf(M, Description);
            const UClass* ActorClass = nullptr;
            if (SpawnerClass && GClasses.ActorSpawnerData && AIBase::IsChildOfClass(SpawnerClass, GClasses.ActorSpawnerData))
            {
                auto Default = SpawnerClass->GetDefaultObj();
                ActorClass = IsLive(Default) && GClasses.ActorSpawnerActorClass >= 0
                    ? *At<const UClass*>(Default, GClasses.ActorSpawnerActorClass) : nullptr;
                SpawnerClass = nullptr;
                if (!ActorClass)
                    continue;
            }
            else if (!SpawnerClass && L.DescActorClass >= 0)
            {
                ActorClass = LoadSoftClass(Description + L.DescActorClass);
            }

            if (SpawnerClass)
            {
                if (!GClasses.AISpawnerData || !AIBase::IsChildOfClass(SpawnerClass, GClasses.AISpawnerData))
                {
                    Log("skipped %s: %s is no AI spawner data", Event.Name.c_str(), NameOf(SpawnerClass).c_str());
                    continue;
                }
                auto List = CreateComponentList(SpawnerClass, World);
                const int32 RequestID = List ? RequestSpawn(Spawner, List, Location, Group.Rotation) : -1;
                ++M.Requests;
                if (RequestID == -1)
                {
                    ++M.RefusedRequests;
                    Log("the AI spawner refused %s (%s/%s)", NameOf(SpawnerClass).c_str(), Event.Category.c_str(),
                        Event.Name.c_str());
                    continue;
                }
                if (!M.FirstRequestMs)
                    M.FirstRequestMs = Now;
                M.Pending.push_back(FPending{ Location, Now, (int32)(&Group - M.Groups.data()), SpawnerClass });
                ++Requested;
                Log("spawned %s %s at (%.0f, %.0f, %.0f) (%s/%s)", BucketName(Event.Bucket),
                    NameOf(SpawnerClass).c_str(), (double)Location.X, (double)Location.Y, (double)Location.Z,
                    Event.Category.c_str(), Event.Name.c_str());
            }
            else if (ActorClass && IsLive(ActorClass) && !IsVehicleClass(ActorClass))
            {
                auto Actor = UWorld::SpawnActor(ActorClass, Location, Group.Rotation);
                if (!Actor)
                    continue;
                ++M.ActorSpawns;
                ++Requested;
                Log("spawned actor %s at (%.0f, %.0f, %.0f) (%s/%s)", NameOf(ActorClass).c_str(),
                    (double)Location.X, (double)Location.Y, (double)Location.Z, Event.Category.c_str(), Event.Name.c_str());
            }
        }
        ++Group.Spawns;
        Group.Requests += Requested;
        Group.NextRespawnMs = Now + (ULONGLONG)((std::max)(Event.RespawnSeconds, 120.f) * 1000.f);
        if (!Requested)
            Group.bFailed = true;
        return Requested;
    }

    int32 InFlight(const FMatch& M, ULONGLONG Now)
    {
        int32 Count = 0;
        for (const auto& Request : M.Pending)
        {
            if (Now - Request.TimeMs < kPendingRequestLifetimeMs)
                ++Count;
        }
        return Count;
    }

    bool Activate()
    {
        auto& M = GMatch;
        if (M.bActivated)
            return true;
        // LivingWorld::IsActive() turns true before the check (it only runs while an AI feature is
        // active) and before the first spawn request.
        GActive.store(true, std::memory_order_release);
        if (!AIBase::EnsureStandaloneCheckOff())
        {
            GActive.store(false, std::memory_order_release);
            Fail("the game's standalone check could not be switched off on this version, an AI would close the server");
            return false;
        }
        M.bActivated = true;
        LogAlways("spawning: %d group(s), %d actor(s) planned (max AI %d)%s%s", (int)M.Groups.size(), M.PlannedActors,
            GMaxAI, CurrentReason().empty() ? "" : ", ", CurrentReason().c_str());
        Emit(true);
        return true;
    }

    void SpawnStep(FMatch& M, const UObject* World, ULONGLONG Now)
    {
        int32 Groups = 0;
        int32 Actors = 0;
        while (M.SpawnCursor < (int32)M.Groups.size() && Groups < kGroupsPerTick && Actors < kActorsPerTick)
        {
            if (M.AliveNPCs + InFlight(M, Now) >= GMaxAI)
                return; // the cap; the rest waits
            auto& Group = M.Groups[M.SpawnCursor++];
            Actors += SpawnGroup(M, Group, World, Now);
            ++Groups;
        }
        if (M.SpawnCursor >= (int32)M.Groups.size() && M.Stage == EStage::Spawn)
        {
            M.Stage = EStage::Done;
            LogAlways("first pass done: %d request(s) (%d refused), %d actor(s) spawned directly", M.Requests,
                M.RefusedRequests, M.ActorSpawns);
            if (M.Requests > 0 && M.Requests == M.RefusedRequests && M.ActorSpawns == 0)
                Fail("the game's AI spawner refused every request");
        }
    }

    // ------------------------------------------------------------------ Upkeep

    // An AI player bot: it takes part in the match (bIsAnAthenaGameParticipant).
    bool IsParticipant(const UObject* Controller)
    {
        const auto& C = GClasses;
        return C.AIBotController && C.BotParticipant.Offset >= 0 && Controller->IsA(C.AIBotController) &&
            ReadBool(Controller, C.BotParticipant, false);
    }

    bool IsListedAsBot(const UObject* Controller, AFortGameMode* GameMode)
    {
        if (!GameMode || !GameMode->HasAliveBots())
            return false;
        for (auto Bot : GameMode->AliveBots)
        {
            if (Bot == Controller)
                return true;
        }
        return false;
    }

    bool IsPawnDying(const UObject* Pawn)
    {
        return ReadBool(Pawn, GClasses.PawnIsDying, false) || ReadBool(Pawn, GClasses.PawnPlayedDying, false);
    }

    // Items for an NPC without an inventory: the controller's StartupInventory, else the inventory
    // component of the spawner data it came from.
    int32 StartupItems(const UObject* Controller, const UClass* SpawnerClass, const uint8** OutData)
    {
        const auto& C = GClasses;
        *OutData = nullptr;
        if (C.ItemAndCountSize <= 0 || C.ItemAndCountItem < 0 || C.ItemAndCountCount < 0)
            return 0;
        auto Startup = ObjectAt(Controller, C.BotStartupInventory);
        if (Startup && C.InventoryItems && Startup->IsA(C.InventoryItems))
        {
            const int32 Num = ArrayAt(Startup, C.InventoryItemsList, OutData, 256);
            if (Num > 0)
                return Num;
        }
        if (!SpawnerClass || C.SpawnerInventoryComponent < 0)
            return 0;
        auto SpawnerDefault = SpawnerClass->GetDefaultObj();
        auto ComponentClass = IsLive(SpawnerDefault) ? *At<const UClass*>(SpawnerDefault, C.SpawnerInventoryComponent) : nullptr;
        auto ComponentDefault = ComponentClass && IsLive(ComponentClass) ? ComponentClass->GetDefaultObj() : nullptr;
        if (!IsLive(ComponentDefault))
            return 0;
        return ArrayAt(ComponentDefault, Off(ComponentDefault->Class, "Items"), OutData, 256);
    }

    void EquipWeapon(AActor* Pawn, const UFortItemDefinition* Weapon, UFortWorldItem* Item)
    {
        auto Function = Pawn->GetFunction("EquipWeaponDefinition");
        if (!Function || !Item)
            return;
        const int32 WeaponData = Off(Function, "WeaponData");
        const int32 ItemGuid = Off(Function, "ItemEntryGuid");
        const int32 TrackerGuid = Off(Function, "TrackerGuid");
        const int32 NoAnimation = Off(Function, "bDisableEquipAnimation");
        const int32 Size = Function->GetPropertiesSize();
        if (WeaponData < 0 || ItemGuid < 0 || Size <= 0 || Size > 0x100 || ItemGuid + 16 > Size ||
            (TrackerGuid >= 0 && TrackerGuid + 16 > Size))
        {
            return;
        }
        alignas(16) uint8 Params[0x100] = {};
        *reinterpret_cast<const UFortItemDefinition**>(Params + WeaponData) = Weapon;
        auto& Entry = Item->ItemEntry;
        const FGuid Guid = Entry.ItemGuid;
        memcpy(Params + ItemGuid, &Guid, 16);
        if (TrackerGuid >= 0 && FFortItemEntry::HasTrackerGuid())
        {
            const FGuid Tracker = Entry.TrackerGuid;
            memcpy(Params + TrackerGuid, &Tracker, 16);
        }
        if (NoAnimation >= 0)
            Params[NoAnimation] = 1;
        Pawn->ProcessEvent(Function, Params);
    }

    // Velora FortAthenaAIBotController.cpp:98-160 (CreateInventory / GiveInventory), without the
    // native hook: an AI bot controller without an inventory gets one owned by it, with its
    // startup items (full clips); the first weapon is equipped.
    // Returns true when this NPC needs no further inventory work.
    bool GiveInventory(FTrackedNPC& NPC, UObject* Controller, AActor* Pawn)
    {
        const auto& C = GClasses;
        if (!C.AIBotController || !Controller->IsA(C.AIBotController) || C.BotInventory < 0 || !C.Inventory)
            return true;
        if (ObjectAt(Controller, C.BotInventory))
            return true; // the game made one
        const uint8* Items = nullptr;
        const int32 Num = StartupItems(Controller, NPC.SpawnerClass, &Items);
        if (Num <= 0)
            return false; // not initialised yet (or nothing to give): try again later

        auto Inventory = (AFortInventory*)UWorld::SpawnActor(C.Inventory, FVector(), FRotator(), (AActor*)Controller);
        if (!Inventory || !IsLive(Inventory))
            return true;
        if (C.InventoryType >= 0 && C.InventoryTypeWorld >= 0)
            GetFromOffset<uint8>(Inventory, C.InventoryType) = (uint8)C.InventoryTypeWorld;
        GetFromOffset<UObject*>(Controller, C.BotInventory) = Inventory;

        int32 Given = 0;
        const UFortItemDefinition* FirstWeapon = nullptr;
        UFortWorldItem* FirstWeaponItem = nullptr;
        bool bFirstIsRanged = false;
        for (int32 Index = 0; Index < Num && Index < kMaxItemsPerInventory; ++Index)
        {
            const uint8* Entry = Items + (size_t)Index * C.ItemAndCountSize;
            auto Definition = *reinterpret_cast<const UFortItemDefinition* const*>(Entry + C.ItemAndCountItem);
            const int32 Count = std::clamp(*reinterpret_cast<const int32*>(Entry + C.ItemAndCountCount), 0, 9999);
            if (!Definition || Count <= 0 || !IsLive(Definition))
                continue;
            const bool bRanged = C.RangedWeapon && Definition->IsA(C.RangedWeapon);
            int32 LoadedAmmo = 0;
            if (bRanged)
            {
                if (auto Stats = AFortInventory::GetStats((const UFortWeaponItemDefinition*)Definition))
                    LoadedAmmo = std::clamp(Stats->ClipSize, 0, 1000);
            }
            const int32 Level = Definition->HasMinLevel() ? (std::max)(Definition->MinLevel, 0) : 0;
            auto Item = Inventory->GiveItem(Definition, Count, LoadedAmmo, Level, false, true);
            if (!Item)
                continue;
            ++Given;
            const bool bWeapon = C.Weapon && Definition->IsA(C.Weapon);
            if (bWeapon && (!FirstWeapon || (bRanged && !bFirstIsRanged)))
            {
                FirstWeapon = Definition;
                FirstWeaponItem = Item;
                bFirstIsRanged = bRanged;
            }
        }
        if (FirstWeapon && Pawn && C.FortPawn && Pawn->IsA(C.FortPawn))
            EquipWeapon(Pawn, FirstWeapon, FirstWeaponItem);
        static int32 Logged = 0;
        if (Logged++ < 10)
        {
            Log("inventory for %s: %d item(s)%s%s", NameOf(Controller->Class).c_str(), Given,
                FirstWeapon ? ", equipped " : "", FirstWeapon ? NameOf(FirstWeapon).c_str() : "");
        }
        return true;
    }

    void BrainUpkeep(FTrackedNPC& NPC, const UObject* Controller, ULONGLONG Now)
    {
        auto& M = GMatch;
        if (NPC.bBrainRunning || NPC.bBrainGivenUp || Now - NPC.FirstSeenMs < kBrainDelayMs ||
            Now - NPC.LastBrainMs < kBrainDelayMs)
        {
            return;
        }
        if (IsBrainRunning(Controller))
        {
            NPC.bBrainRunning = true;
            ++M.RunningBrains;
            return;
        }
        const auto& C = GClasses;
        auto Tree = ObjectAt(Controller, C.BotBehaviorTree);
        if (NPC.BrainAttempts >= kBrainAttempts || !Tree || Now - NPC.FirstSeenMs > kBrainGiveUpMs)
        {
            NPC.bBrainGivenUp = true;
            ++M.GivenUpBrains;
            if (M.GivenUpBrains <= 3)
            {
                Log("brain of %s did not start (%s)", NameOf(Controller).c_str(),
                    !Tree ? "no behaviour tree" : "RunBehaviorTree gave up");
            }
            return;
        }
        ++NPC.BrainAttempts;
        NPC.LastBrainMs = Now;
        if (AIBase1910::GetBrainFlag() == AIBase1910::EBrainFlag::Found)
            AIBase1910::SetBrainFlag(Controller);
        if (RunBehaviorTree(Controller, Tree) && IsBrainRunning(Controller))
        {
            NPC.bBrainRunning = true;
            ++M.RunningBrains;
            if (M.RunningBrains <= 3)
                Log("brain of %s started (%s)", NameOf(Controller).c_str(), NameOf(Tree).c_str());
        }
    }

    // The NPCs Living world spawned itself never count as alive players or bots (victory, kill
    // feed, player counts). Only controllers tied to one of our own spawn requests are taken out,
    // never an AI player bot (bIsAnAthenaGameParticipant) or anything else.
    void KeepNPCsOutOfAliveLists(AFortGameMode* GameMode)
    {
        auto& M = GMatch;
        if (M.OwnControllers.empty())
            return;
        int32 Removed = 0;
        auto Prune = [&](TArray<AActor*>& List)
        {
            for (int32 Index = List.Num() - 1; Index >= 0; --Index)
            {
                auto Controller = List[Index];
                if (Controller && M.OwnControllers.count(KeyOf(Controller)) && !IsParticipant(Controller))
                {
                    List.Remove(Index);
                    ++Removed;
                }
            }
        };
        if (GameMode->HasAliveBots())
            Prune(GameMode->GetAliveBots());
        if (GameMode->HasAlivePlayers())
            Prune(GameMode->GetAlivePlayers());
        if (Removed > 0 && !M.bRemovedFromAliveLogged)
        {
            M.bRemovedFromAliveLogged = true;
            Log("kept %d NPC controller(s) out of the alive player/bot lists", Removed);
        }
    }

    void Upkeep(FMatch& M, const LivingWorldSpawner::FTickInput& In)
    {
        const auto& C = GClasses;
        const ULONGLONG Now = In.NowMs;
        if (!C.FortPawn || C.PawnController < 0)
            return;
        M.AliveNPCLocations.clear();
        M.PlayerLocations.clear();
        for (auto& Pair : M.NPCs)
            Pair.second.bAlive = false;
        int32 Alive = 0;

        TArray<AActor*> Pawns;
        Utils::GetAll(C.FortPawn, Pawns);
        const int32 Count = (std::min)(Pawns.Num(), kMaxPawnsPerScan);
        for (int32 Index = 0; Index < Count; ++Index)
        {
            AActor* Pawn = Pawns[Index];
            if (!Pawn || !IsLive(Pawn))
                continue;
            auto Controller = GetFromOffset<UObject*>(Pawn, C.PawnController);
            if (!Controller || !IsLive(Controller))
                continue;
            if (!AIBase::IsAIController(Controller))
            {
                if (!IsPawnDying(Pawn))
                    M.PlayerLocations.push_back(Pawn->K2_GetActorLocation());
                continue;
            }
            // AI player bots are never Living world's.
            if (IsParticipant(Controller) || IsPawnDying(Pawn))
                continue;
            const FVector Location = Pawn->K2_GetActorLocation();
            const uint64 Key = KeyOf(Pawn);
            auto It = M.NPCs.find(Key);
            if (It == M.NPCs.end())
            {
                // The request it came from: the nearest pending one close enough.
                int32 Best = -1;
                double BestDistance = kRequestMatchCm;
                for (int32 Request = 0; Request < (int32)M.Pending.size(); ++Request)
                {
                    const double Distance = FVector::Dist(M.Pending[Request].Location, Location);
                    if (Distance < BestDistance)
                    {
                        BestDistance = Distance;
                        Best = Request;
                    }
                }
                // An AI in the alive bot list that none of our requests made is an AI player bot.
                if (Best < 0 && IsListedAsBot(Controller, In.GameMode))
                    continue;
                FTrackedNPC NPC;
                NPC.Pawn = FObjectRef::Of(Pawn);
                NPC.Controller = FObjectRef::Of(Controller);
                NPC.FirstSeenMs = Now;
                if (Best >= 0)
                {
                    NPC.Group = M.Pending[Best].Group;
                    NPC.SpawnerClass = M.Pending[Best].SpawnerClass;
                    M.Pending.erase(M.Pending.begin() + Best);
                }
                ++M.SeenNPCs;
                It = M.NPCs.emplace(Key, NPC).first;
            }
            auto& NPC = It->second;
            NPC.bAlive = true;
            ++Alive;
            M.AliveNPCLocations.push_back(Location);
            if (NPC.Controller.Get() != Controller)
                NPC.Controller = FObjectRef::Of(Controller);
            M.NPCControllers.insert(KeyOf(Controller));
            if (NPC.Group >= 0)
                M.OwnControllers.insert(KeyOf(Controller));

            if (!NPC.bInventoryDone && NPC.InventoryAttempts < kInventoryAttempts)
            {
                ++NPC.InventoryAttempts;
                NPC.bInventoryDone = GiveInventory(NPC, Controller, Pawn);
            }
            if (GNavigation && C.AIBotController && Controller->IsA(C.AIBotController))
                BrainUpkeep(NPC, Controller, Now);
        }
        Pawns.Free();
        M.AliveNPCs = Alive;

        // Forget dead NPCs (their death drop is LivingWorld.cpp's), and old requests.
        for (auto It = M.NPCs.begin(); It != M.NPCs.end();)
        {
            if (!It->second.bAlive && !It->second.Pawn.Get())
                It = M.NPCs.erase(It);
            else
                ++It;
        }
        M.Pending.erase(std::remove_if(M.Pending.begin(), M.Pending.end(), [&](const FPending& Request)
            { return Now - Request.TimeMs >= kPendingRequestLifetimeMs; }), M.Pending.end());

        if (In.GameMode)
            KeepNPCsOutOfAliveLists(In.GameMode);

        if (M.SeenNPCs == 0 && M.Requests > M.RefusedRequests && M.FirstRequestMs && Now - M.FirstRequestMs >= kNoPawnGiveUpMs &&
            M.Stage != EStage::Failed)
        {
            Fail("the game's AI spawner took " + std::to_string(M.Requests - M.RefusedRequests) +
                " request(s), but no AI appeared");
        }
    }

    // ------------------------------------------------------------------ Respawn

    bool AnyNear(const std::vector<FVector>& Locations, const FVector& Place, double Radius)
    {
        for (const auto& Location : Locations)
        {
            if (FVector::Dist(Location, Place) < Radius)
                return true;
        }
        return false;
    }

    void RespawnStep(FMatch& M, const UObject* World, ULONGLONG Now)
    {
        int32 Respawned = 0;
        for (auto& Group : M.Groups)
        {
            if (Respawned >= kGroupsPerTick)
                break;
            if (Group.bFailed || Group.Spawns <= 0 || Group.Spawns > kMaxRespawnsPerGroup || Now < Group.NextRespawnMs)
                continue;
            const auto Bucket = M.Events[Group.Event].Bucket;
            if (Bucket != EBucket::Boss && Bucket != EBucket::Guard)
                continue;
            if (AnyNear(M.AliveNPCLocations, Group.Location, kGroupRadiusCm))
            {
                Group.NextRespawnMs = Now + kRespawnCheckIntervalMs;
                continue; // still someone there
            }
            if (AnyNear(M.PlayerLocations, Group.Location, kPlayerNearCm))
                continue; // not in front of a player
            if (M.AliveNPCs + InFlight(M, Now) + Group.ActorCount > GMaxAI)
                return;
            const auto& Event = M.Events[Group.Event];
            Log("respawn %s %s/%s (%d of %d)", BucketName(Bucket), Event.Category.c_str(), Event.Name.c_str(),
                Group.Spawns, kMaxRespawnsPerGroup);
            SpawnGroup(M, Group, World, Now);
            ++Respawned;
        }
    }

    // ------------------------------------------------------------------ Tick

    void ResetMatch(const UObject* World)
    {
        GMatch = FMatch{};
        GMatch.World = World;
        GMatch.Random.seed((uint32_t)GetTickCount64());
        GLogLines = 0;
        GActive.store(false, std::memory_order_release);
        GTickFaults.Reset();
        GUpkeepFaults.Reset();
    }

    void TickUnsafe(void* Raw)
    {
        const auto& In = *static_cast<const LivingWorldSpawner::FTickInput*>(Raw);
        auto& M = GMatch;
        switch (M.Stage)
        {
        case EStage::Waiting:
            if (In.GamePhase >= kGamePhaseAircraft ||
                (In.GamePhase < 0 && In.NowMs - In.GameModeSeenMs >= kNoBusDelayMs))
            {
                M.Stage = EStage::Resolve;
                Resolve(In);
            }
            return;
        case EStage::Resolve:
            // Resolve runs in one poll; still here means it faulted half-way.
            return Fail("reading the Living World data faulted");
        case EStage::Plan:
            if (!PlanStep(M))
                return;
            if (M.Groups.empty())
                return Fail("no Living World event found a place on this map");
            LogAlways("plan ready: %d group(s), %d actor(s)", (int)M.Groups.size(), M.PlannedActors);
            M.Stage = EStage::Spawn;
            if (!Activate())
                return;
            SpawnStep(M, In.World, In.NowMs);
            return;
        case EStage::Spawn:
            SpawnStep(M, In.World, In.NowMs);
            return;
        case EStage::Done:
            if (In.NowMs - M.LastRespawnCheckMs >= kRespawnCheckIntervalMs)
            {
                M.LastRespawnCheckMs = In.NowMs;
                RespawnStep(M, In.World, In.NowMs);
            }
            return;
        default:
            return;
        }
    }

    void UpkeepUnsafe(void* Raw)
    {
        const auto& In = *static_cast<const LivingWorldSpawner::FTickInput*>(Raw);
        Upkeep(GMatch, In);
    }

    // Spawning off, why, and whether navigation/brains can work on this build (hook phase).
    void DecideNavigation()
    {
        const double Version = VersionInfo.FortniteVersion;
        GNavigation = false;
        if (std::fabs(Version - 19.10) > 0.001)
        {
            GNoNavigationReason = kReasonNoNavVersion;
            return;
        }
        std::string Why;
        if (!AIBase1910::Ensure(Why))
        {
            GNoNavigationReason = "standing only (the 19.10 checks failed)";
            AIBase::Logf(kTag, "no navigation: the 19.10 AI base is off (%s)", Why.c_str());
            return;
        }
        AIBase1910::AddUser(AIBase1910::UserLivingWorld);
        GNavigation = true;
        AIBase1910::ResolveBrainFlag();
    }
}

void LivingWorldSpawner::OnStartMatch()
{
    GRequested.store(false, std::memory_order_release);
    if (!FConfiguration::bLivingWorld.load(std::memory_order_acquire))
    {
        NiobiumControl::EmitLivingWorld("off", "", 0);
        return;
    }
    GMaxAI = std::clamp(FConfiguration::LivingWorldMaxAI.load(std::memory_order_acquire), 1, 100);
    const double Version = VersionInfo.FortniteVersion;
    if (Version < kMinVersion)
    {
        const char* Reason = "this Fortnite version has no AI spawner (Living world needs about 14.40 to 20.x)";
        AIBase::Logf(kTag, "unavailable: %s (Fortnite %.2f)", Reason, Version);
        NiobiumControl::EmitLivingWorld("unavailable", Reason, 0);
        return;
    }
    ResolveClasses();
    if (!GClasses.AISpawnerData || !GClasses.AISpawner || !CanSpawnAI())
    {
        const char* Reason = !GClasses.AISpawnerData || !GClasses.AISpawner
            ? "this Fortnite version has no AI spawner (Living world needs about 14.40 to 20.x)"
            : "the AI spawner functions (CreateComponentListFromClass, RequestSpawn) are missing";
        AIBase::Logf(kTag, "unavailable: %s (Fortnite %.2f)", Reason, Version);
        NiobiumControl::EmitLivingWorld("unavailable", Reason, 0);
        return;
    }
    DecideNavigation();
    GRequested.store(true, std::memory_order_release);
    const std::string Reason = CurrentReason();
    AIBase::Logf(kTag, "requested: Fortnite %.2f, max AI %d, %s; spawning starts with the bus", Version, GMaxAI,
        GNavigation ? "navigation on (19.10 AI base)" : Reason.c_str());
    NiobiumControl::EmitLivingWorld("active", Reason, 0);
}

bool LivingWorldSpawner::IsRequested()
{
    return GRequested.load(std::memory_order_acquire);
}

bool LivingWorldSpawner::IsActive()
{
    return GActive.load(std::memory_order_acquire);
}

void LivingWorldSpawner::Tick(const FTickInput& In)
{
    if (!IsRequested() || !In.World)
        return;
    if (GMatch.World != In.World)
        ResetMatch(In.World);
    auto& M = GMatch;

    if (!GTickFaults.IsTripped() && M.Stage != EStage::Failed)
    {
        FTickInput Copy = In;
        if (!AIBase::Guarded(&TickUnsafe, &Copy) && GTickFaults.Record("the Living world spawner"))
            Fail("the spawner faulted 3 times");
    }
    if (M.bActivated && !GUpkeepFaults.IsTripped() && In.NowMs - M.LastUpkeepMs >= kUpkeepIntervalMs)
    {
        M.LastUpkeepMs = In.NowMs;
        FTickInput Copy = In;
        if (!AIBase::Guarded(&UpkeepUnsafe, &Copy))
            GUpkeepFaults.Record("the Living world upkeep");
    }
    if (M.bActivated && M.Stage != EStage::Failed)
        Emit(false);
}

bool LivingWorldSpawner::IsNPCController(const UObject* Controller)
{
    return IsActive() && Controller && GMatch.NPCControllers.count(KeyOf(Controller)) != 0;
}

// ---------------------------------------------------------------------- Loot on death

namespace
{
    struct FLootLayout
    {
        bool bResolved = false;
        int32 RuntimeParameters = -1;      // AFortAthenaAIBotController::CachedAIRuntimeParametersComponent
        int32 Extracted = -1;              // UFortAthenaAIRuntimeParametersComponent::ExtractedRuntimeParameters
        const UClass* InventoryParameters = nullptr; // UFortAthenaAIRuntimeParameters_Inventory
        int32 LootInfo = -1;               // its FDataTableRowHandle LootInfo
        int32 Behaviors = -1;              // FFortAthenaAILootInfoDataTableRow::LootDroppingBehaviors
        int32 EntrySize = 0;               // FAILootInfoRowEntry
        FBit ShouldDropLoot;               // bShouldDropLootOnDeath
        int32 EntryQuery = -1;             // OptionalTagQuery
        int32 LootTiers = -1;              // TArray<FName>
        const UObject* TagLibrary = nullptr;
        UFunction* OwnedTags = nullptr;    // BlueprintGameplayTagLibrary::GetOwnedGameplayTags
        int32 OwnedTagsActor = -1, OwnedTagsReturn = -1, OwnedTagsSize = 0;
        int32 WorldLevel = -1;             // AFortGameStateAthena::WorldLevel
    };

    FLootLayout GLoot;

    void ResolveLoot()
    {
        auto& L = GLoot;
        if (L.bResolved)
            return;
        L.bResolved = true;
        auto BotController = FindClass("FortAthenaAIBotController");
        L.RuntimeParameters = Off(BotController, "CachedAIRuntimeParametersComponent");
        L.Extracted = Off(FindClass("FortAthenaAIRuntimeParametersComponent"), "ExtractedRuntimeParameters");
        L.InventoryParameters = FindClass("FortAthenaAIRuntimeParameters_Inventory");
        L.LootInfo = Off(L.InventoryParameters, "LootInfo");
        L.Behaviors = Off(FindStruct("FortAthenaAILootInfoDataTableRow"), "LootDroppingBehaviors");
        auto Entry = FindStruct("AILootInfoRowEntry");
        L.EntrySize = Entry ? Entry->GetPropertiesSize() : 0;
        L.ShouldDropLoot = BitOf(Entry, "bShouldDropLootOnDeath");
        L.EntryQuery = Off(Entry, "OptionalTagQuery");
        L.LootTiers = Off(Entry, "LootTiers");
        auto LibraryClass = FindClass("BlueprintGameplayTagLibrary");
        L.TagLibrary = LibraryClass ? LibraryClass->GetDefaultObj() : nullptr;
        if (AIBase::IsLiveObject(L.TagLibrary))
            L.OwnedTags = L.TagLibrary->GetFunction("GetOwnedGameplayTags");
        if (L.OwnedTags)
        {
            L.OwnedTagsActor = Off(L.OwnedTags, "Actor");
            L.OwnedTagsReturn = Off(L.OwnedTags, "ReturnValue");
            L.OwnedTagsSize = L.OwnedTags->GetPropertiesSize();
        }
        L.WorldLevel = Off(FindClass("FortGameStateAthena"), "WorldLevel");
    }

    bool HasLootLayout()
    {
        const auto& L = GLoot;
        return L.RuntimeParameters >= 0 && L.Extracted >= 0 && L.InventoryParameters && L.LootInfo >= 0 &&
            L.Behaviors >= 0 && L.EntrySize > 0 && L.ShouldDropLoot.Offset >= 0 && L.LootTiers >= 0;
    }

    // The pawn's owned gameplay tags (BlueprintGameplayTagLibrary::GetOwnedGameplayTags); the
    // arrays are the game's allocations and are freed by the caller.
    bool OwnedTagsOf(const AActor* Pawn, FGameplayTagContainer& Out)
    {
        const auto& L = GLoot;
        const int32 ContainerSize = GTagQuery.ContainerSize;
        if (!L.OwnedTags || L.OwnedTagsActor < 0 || L.OwnedTagsReturn < 0 || L.OwnedTagsSize <= 0 ||
            L.OwnedTagsSize > 0x100 || ContainerSize != (int32)sizeof(FGameplayTagContainer) ||
            L.OwnedTagsReturn + ContainerSize > L.OwnedTagsSize)
        {
            return false;
        }
        alignas(16) uint8 Params[0x100] = {};
        *reinterpret_cast<const AActor**>(Params + L.OwnedTagsActor) = Pawn;
        L.TagLibrary->ProcessEvent(L.OwnedTags, Params);
        memcpy(&Out, Params + L.OwnedTagsReturn, sizeof(FGameplayTagContainer));
        return true;
    }

    const uint8* FindRow(const UObject* Table, const FName& Row)
    {
        int32 Guard = 0;
        for (auto& Pair : static_cast<const UDataTable*>(Table)->RowMap)
        {
            if (++Guard > 100000)
                break;
            if (SameName(Pair.Key(), Row))
                return Pair.Value();
        }
        return nullptr;
    }
}

bool LivingWorldSpawner::ReadLootInfo(const UObject* Controller, FLootInfo& Out)
{
    ResolveLoot();
    const auto& L = GLoot;
    if (!HasLootLayout() || !Controller || !AIBase::IsLiveObject(Controller))
        return false;
    auto Component = ObjectAt(Controller, L.RuntimeParameters);
    if (!Component)
        return false;
    const uint8* Data = nullptr;
    const int32 Num = ArrayAt(Component, L.Extracted, &Data, 64);
    for (int32 Index = 0; Index < Num; ++Index)
    {
        auto Parameters = reinterpret_cast<const UObject* const*>(Data)[Index];
        if (!Parameters || !AIBase::IsLiveObject(Parameters) || !Parameters->IsA(L.InventoryParameters))
            continue;
        auto Handle = At<uint8>(Parameters, L.LootInfo);
        auto Table = ObjectAt(Handle, 0);
        static const UClass* DataTableClass = FindClass("DataTable");
        Out.bResolved = true;
        if (!Table || !DataTableClass || !Table->IsA(DataTableClass))
            return false;
        Out.Table = Table;
        Out.Row = *reinterpret_cast<const FName*>(Handle + sizeof(void*));
        if (VersionInfo.FortniteVersion >= 20.00)
            Out.Row.Number = 0;
        return Out.Row.IsValid();
    }
    return false;
}

int32 LivingWorldSpawner::DropLootTiers(AActor* Pawn, const FLootInfo& Info, int32 Budget, const char*& OutWhy)
{
    OutWhy = nullptr;
    ResolveLoot();
    ResolveTagQuery();
    const auto& L = GLoot;
    if (!HasLootLayout())
    {
        OutWhy = "this build has no AI loot info";
        return 0;
    }
    if (!Info.Table || !AIBase::IsLiveObject(Info.Table) || !Pawn || !AIBase::IsLiveObject(Pawn))
    {
        OutWhy = "its loot table is gone";
        return 0;
    }
    auto Row = FindRow(Info.Table, Info.Row);
    if (!Row)
    {
        OutWhy = "its loot row is missing";
        return 0;
    }
    const uint8* Entries = nullptr;
    const int32 EntryCount = ArrayAt(Row, L.Behaviors, &Entries, 32);

    FGameplayTagContainer Tags{};
    const bool bHasTags = OwnedTagsOf(Pawn, Tags);
    const FVector Location = Pawn->K2_GetActorLocation();
    auto World = UWorld::GetWorld();
    auto GameState = World ? World->GameState : nullptr;
    const int32 WorldLevel = GameState && L.WorldLevel >= 0 && AIBase::IsLiveObject(GameState)
        ? (std::max)(GetFromOffset<int32>(GameState, L.WorldLevel), 0) : 0;
    const int32 NameSize = FGameplayTag::Size();
    const long long SourceType = EFortPickupSourceTypeFlag::HasAI()
        ? EFortPickupSourceTypeFlag::GetAI() : EFortPickupSourceTypeFlag::GetOther();
    const long long SpawnSource = EFortPickupSpawnSource::HasNPCElimination()
        ? EFortPickupSpawnSource::GetNPCElimination() : EFortPickupSpawnSource::GetUnset();

    int32 Spawned = 0;
    int32 Tiers = 0;
    for (int32 Index = 0; Index < EntryCount && Spawned < Budget; ++Index)
    {
        const uint8* Entry = Entries + (size_t)Index * L.EntrySize;
        if (!ReadBool(Entry, L.ShouldDropLoot, false))
            continue;
        if (L.EntryQuery >= 0 && !IsQueryEmpty(Entry + L.EntryQuery) &&
            (!bHasTags || !QueryMatches(reinterpret_cast<const uint8*>(&Tags), Entry + L.EntryQuery)))
        {
            continue;
        }
        const uint8* Names = nullptr;
        const int32 NameCount = ArrayAt(Entry, L.LootTiers, &Names, 16);
        for (int32 Tier = 0; Tier < NameCount && Spawned < Budget; ++Tier)
        {
            FName TierGroup;
            TierGroup.ComparisonIndex = *reinterpret_cast<const int32*>(Names + (size_t)Tier * NameSize);
            TierGroup.Number = NameSize >= 8 ? *reinterpret_cast<const int32*>(Names + (size_t)Tier * NameSize + 4) : 0;
            if (!TierGroup.IsValid())
                continue;
            ++Tiers;
            // PickLootDrops' logic (FortKismetLibrary.cpp): the game mode's redirect, then the tier
            // group's rows; an unknown group is logged once there.
            const FName RealGroup = UFortLootPackage::RedirectTierGroup(TierGroup);
            const auto TierData = TierDataMap.find(RealGroup.ComparisonIndex);
            if (TierData == TierDataMap.end() || TierData->second.Num() <= 0)
            {
                static std::unordered_set<int32> Logged;
                if (Logged.insert(RealGroup.ComparisonIndex).second)
                    Log("AI loot: unknown tier group %s", RealGroup.ToString().c_str());
                continue;
            }
            TArray<FFortItemEntry*> Drops{};
            UFortLootPackage::ChooseLootForContainer(Drops, RealGroup, -1, WorldLevel, nullptr,
                bHasTags ? &Tags : nullptr);
            for (auto Drop : Drops)
            {
                if (Drop && Spawned < Budget && Drop->ItemDefinition &&
                    AFortInventory::SpawnPickup(Location, *Drop, SourceType, SpawnSource, nullptr, -1, true, true, true))
                {
                    ++Spawned;
                }
                free(Drop);
            }
            Drops.Free();
        }
    }
    if (bHasTags)
    {
        Tags.GameplayTags.Free();
        Tags.ParentTags.Free();
    }
    if (!Spawned)
        OutWhy = Tiers ? "its loot tiers rolled nothing" : "its loot row drops no loot tiers";
    return Spawned;
}
