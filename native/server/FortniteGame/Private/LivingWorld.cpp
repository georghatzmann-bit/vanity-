// NIOBIUM: "Living world" plumbing (see FortniteGame/Public/LivingWorld.h). Rift's own code
// (GPL-3.0).
//
// The AI death drop follows the logic of Jeremy1926/Velora (MIT), Velora/FortniteGame/Source/
// FortniteGame/Private/AI/FortAthenaAIBotController.cpp:383-438
// (AFortAthenaAIBotController::DropInventoryItems, as of dfa12c2): every inventory item whose
// definition can be dropped and whose DropBehavior is not DestroyOnDrop (DropAsPickupDestroyOnEmpty
// only with items left) becomes a pickup. Written fresh for reflection only: no native hook, no
// address, no Velora code copied. Credited in THIRD_PARTY_NOTICES.md.
//
// Safety: all of this runs on the game thread, at most every 500 ms, inside AIBase::Guarded; a
// fault is counted (AIBase::FFaultCounter) and the part that faulted is off for the rest of the
// match. Nothing runs unless an AI feature is active (AIBase::IsAnyAIFeatureActive: the 19.10 bot
// gate passed, or Living world spawns), Living world was asked for (LivingWorldSpawner), or
// bLivingWorldDump is on. The raw switches alone do nothing.
//
// Spawning itself ("Lager-lite") lives in LivingWorldSpawner.cpp; this file starts it at
// "Start match" and ticks it. NPCs (not AI player bots) also drop the loot tiers of their AI loot
// info on death, through Rift's loot tables (LivingWorldSpawner::DropLootTiers).
#include "pch.h"
#include "../Public/LivingWorld.h"
#include "../Public/LivingWorldSpawner.h"
#include "../Public/AIBase.h"
#include "../Public/FortGameMode.h"
#include "../Public/FortInventory.h"
#include "../Public/FortPlayerPawnAthena.h"
#include "../Public/GameplayTagContainer.h"
#include <Engine/Public/CurveTable.h>
#include <Engine/Public/DataTable.h>
#include <Erbium/Public/Configuration.h>
#include <Erbium/Public/NiobiumControl.h>
#include <algorithm>
#include <atomic>
#include <cstdarg>
#include <deque>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace
{
    constexpr const char* kTag = "LivingWorld";

    constexpr ULONGLONG kPollIntervalMs = 500;
    constexpr ULONGLONG kDumpFallbackDelayMs = 120000; // playlists without a bus
    constexpr int32 kDumpLineCap = 400;
    constexpr size_t kDumpLinesPerTick = 40; // written per poll, so the pipe never blocks a frame long
    // The death drop and the dump: the builds with the AI spawner / Lager classes (about 13/14 on).
    constexpr double kFirstAIVersion = 13.00;
    constexpr double kEndAIVersion = 31.00;
    constexpr int32 kMaxPawnsPerPoll = 4096;
    constexpr int32 kMaxPickupsPerPoll = 96;
    constexpr int32 kMaxEntriesPerInventory = 64;
    constexpr int32 kMaxLoggedDrops = 30;
    constexpr int32 kGamePhaseAircraft = 3; // EAthenaGamePhase::Aircraft
    constexpr double kNativeDropRadiusCm = 300.0; // pickups this close to a dead NPC = the game dropped

    // ------------------------------------------------------------------ Match state

    struct FTrackedAI
    {
        TWeakObjectPtr<UObject> Pawn;
        TWeakObjectPtr<UObject> Inventory;
        bool bPlayerBot = false;
        bool bNPC = false; // a Living world NPC (LivingWorldSpawner::IsNPCController)
        LivingWorldSpawner::FLootInfo Loot;
    };

    struct FMatch
    {
        const UObject* World = nullptr;
        ULONGLONG GameModeSeenMs = 0;
        bool bDumped = false;
        bool bDropUnsupported = false;
        bool bWarmupNoticeLogged = false;
        int32 LoggedDrops = 0;
        int32 DroppedPawns = 0;
        std::unordered_map<uint64, FTrackedAI> Tracked; // key: IdentityOf(pawn)
        std::unordered_set<uint64> Handled;              // pawns whose death was handled
    };

    FMatch GMatch;
    ULONGLONG GLastPollMs = 0;
    // Dump lines waiting for the pipe (at most kDumpLinesPerTick per poll). Kept across a world
    // change, so a dump that is still being written finishes.
    std::deque<std::string> GDumpQueue;
    AIBase::FFaultCounter GDropFaults("the AI death drop", 3);
    AIBase::FFaultCounter GDumpFaults("the Living world dump", 1);

    // Per-match identity of an object: its GUObjectArray index and serial number. The serial is
    // only read, never written (the SDK's FWeakObjectPtr constructor would store one of its own,
    // racing the engine's serial allocation). An object without a serial yet falls back to its
    // index plus pointer bits; bit 31 keeps those keys apart from serial keys.
    uint64 IdentityOf(const UObject* Object)
    {
        if (!Object)
            return 0;
        const int32 Index = Object->Index;
        auto Item = Index >= 0 && Index < TUObjectArray::Num() ? TUObjectArray::GetItemByIndex(Index)
            : nullptr;
        const int32 Serial = Item && Item->GetObject() == Object ? Item->SerialNumber : 0;
        const uint32 Low = Serial > 0 ? (uint32)Serial
            : 0x80000000u | ((uint32)((uintptr_t)Object >> 4) & 0x7FFFFFFFu);
        return ((uint64)(uint32)Index << 32) | Low;
    }

    std::string NameOf(const UObject* Object)
    {
        return Object ? std::string(Object->Name.ToString().c_str()) : std::string("none");
    }

    std::string ClassNameOf(const UObject* Object)
    {
        return Object && Object->Class ? NameOf(Object->Class) : std::string("none");
    }

    // ------------------------------------------------------------------ Reflection readers

    struct FBit
    {
        int32 Offset = -1;
        uint8 Mask = 0;
    };

    FBit ResolveBit(const UStruct* Struct, const char* Name)
    {
        FBit Bit;
        auto Property = Struct ? Struct->GetProperty(Name, AIBase::ECastFlags::BoolProperty) : nullptr;
        if (Property)
        {
            Bit.Offset = AIBase::PropertyOffset(Property);
            Bit.Mask = Property->GetFieldMask();
        }
        return Bit;
    }

    bool ReadBit(const UObject* Object, const FBit& Bit)
    {
        return Object && Bit.Offset >= 0 && Bit.Mask &&
            (GetFromOffset<uint8>(Object, Bit.Offset) & Bit.Mask) != 0;
    }

    // An object reached through an object, weak or soft property (a soft one only if it is
    // loaded: nothing is loaded here). bNotLoaded is set for a soft reference that isn't.
    const UObject* ReadObjectRef(const UStruct* Struct, const void* Base, const char* Name,
        bool* bNotLoaded = nullptr)
    {
        if (bNotLoaded)
            *bNotLoaded = false;
        auto Property = Struct && Base ? Struct->GetProperty(Name) : nullptr;
        const int32 Offset = AIBase::PropertyOffset(Property);
        if (Offset < 0)
            return nullptr;
        const uint64_t Flags = AIBase::PropertyCastFlags(Property);
        const uint8* Address = static_cast<const uint8*>(Base) + Offset;
        if (!SDK::MemReadable(Address, sizeof(void*)))
            return nullptr;

        const UObject* Result = nullptr;
        if (Flags & (AIBase::ECastFlags::SoftObjectProperty | AIBase::ECastFlags::WeakObjectProperty))
        {
            // FSoftObjectPtr starts with its FWeakObjectPtr.
            Result = reinterpret_cast<const FWeakObjectPtr*>(Address)->Get();
            if (!Result && bNotLoaded && (Flags & AIBase::ECastFlags::SoftObjectProperty))
                *bNotLoaded = true;
        }
        else if (Flags & AIBase::ECastFlags::ObjectProperty)
        {
            Result = *reinterpret_cast<const UObject* const*>(Address);
        }
        return AIBase::IsLiveObject(Result) ? Result : nullptr;
    }

    // Number of elements of an array property, -1 if there is none.
    int32 ReadArrayNum(const UStruct* Struct, const void* Base, const char* Name,
        const uint8** OutData = nullptr)
    {
        auto Property = Struct && Base ? Struct->GetProperty(Name, AIBase::ECastFlags::ArrayProperty)
            : nullptr;
        const int32 Offset = AIBase::PropertyOffset(Property);
        if (Offset < 0)
            return -1;
        const auto Array = reinterpret_cast<const TArray<uint8>*>(static_cast<const uint8*>(Base) + Offset);
        if (!SDK::MemReadable(Array, sizeof(TArray<uint8>)))
            return -1;
        const int32 Num = Array->Num();
        if (Num < 0 || Num > 1000000)
            return -1;
        if (OutData)
            *OutData = reinterpret_cast<const uint8*>(Array->GetData());
        return Num;
    }

    // An int, float, double, byte or bool property as text ("-" if there is none).
    std::string ReadNumberText(const UStruct* Struct, const void* Base, const char* Name)
    {
        auto Property = Struct && Base ? Struct->GetProperty(Name) : nullptr;
        const int32 Offset = AIBase::PropertyOffset(Property);
        if (Offset < 0)
            return "-";
        const uint64_t Flags = AIBase::PropertyCastFlags(Property);
        const uint8* Address = static_cast<const uint8*>(Base) + Offset;
        if (!SDK::MemReadable(Address, sizeof(double)))
            return "-";
        char Buffer[48];
        constexpr uint64_t DoubleProperty = 0x100000000ull;
        if (Flags & AIBase::ECastFlags::BoolProperty)
            snprintf(Buffer, sizeof(Buffer), "%s", (*Address & Property->GetFieldMask()) ? "true" : "false");
        else if (Flags & AIBase::ECastFlags::IntProperty)
            snprintf(Buffer, sizeof(Buffer), "%d", *reinterpret_cast<const int32*>(Address));
        else if (Flags & AIBase::ECastFlags::FloatProperty)
            snprintf(Buffer, sizeof(Buffer), "%g", (double)*reinterpret_cast<const float*>(Address));
        else if (Flags & DoubleProperty)
            snprintf(Buffer, sizeof(Buffer), "%g", *reinterpret_cast<const double*>(Address));
        else if (Flags & AIBase::ECastFlags::ByteProperty)
            snprintf(Buffer, sizeof(Buffer), "%u", (unsigned)*Address);
        else
            return "?";
        return Buffer;
    }

    // An FScalableFloat property: "<value>" or "<value> (curve <evaluated>)".
    std::string ReadScalableFloatText(const UStruct* Struct, const void* Base, const char* Name)
    {
        auto Property = Struct && Base ? Struct->GetProperty(Name, AIBase::ECastFlags::StructProperty)
            : nullptr;
        const int32 Offset = AIBase::PropertyOffset(Property);
        if (Offset < 0 || GetFromOffset<int32>(Property, Offsets::ElementSize) < 0x18)
            return "-";
        auto Scalable = reinterpret_cast<FScalableFloat*>(const_cast<uint8*>(
            static_cast<const uint8*>(Base) + Offset));
        if (!SDK::MemReadable(Scalable, 0x18))
            return "-";
        char Buffer[64];
        if (AIBase::IsLiveObject(reinterpret_cast<const UObject*>(Scalable->Curve.CurveTable)) &&
            Scalable->Curve.RowName.IsValid())
        {
            snprintf(Buffer, sizeof(Buffer), "%g (curve %g)", (double)Scalable->Value,
                (double)Scalable->Evaluate(0.f));
        }
        else
        {
            snprintf(Buffer, sizeof(Buffer), "%g", (double)Scalable->Value);
        }
        return Buffer;
    }

    std::string TagsText(const FGameplayTagContainer& Container, int32 Max)
    {
        std::string Out;
        const int32 Num = Container.GameplayTags.Num();
        if (Num <= 0 || Num > 4096 ||
            !SDK::MemReadable(Container.GameplayTags.GetData(), (size_t)Num * FGameplayTag::Size()))
        {
            return "none";
        }
        for (int32 Index = 0; Index < Num && Index < Max; ++Index)
        {
            if (!Out.empty())
                Out += ", ";
            Out += Container.GameplayTags.Get(Index, FGameplayTag::Size()).TagName.ToString().c_str();
        }
        if (Num > Max)
            Out += ", +" + std::to_string(Num - Max);
        return Out;
    }

    std::string TagsOf(const UStruct* Struct, const void* Base, const char* Name, int32 Max)
    {
        auto Property = Struct && Base ? Struct->GetProperty(Name, AIBase::ECastFlags::StructProperty)
            : nullptr;
        const int32 Offset = AIBase::PropertyOffset(Property);
        if (Offset < 0)
            return "-";
        auto Container = reinterpret_cast<const FGameplayTagContainer*>(static_cast<const uint8*>(Base) + Offset);
        return SDK::MemReadable(Container, sizeof(FGameplayTagContainer)) ? TagsText(*Container, Max) : "-";
    }

    // ------------------------------------------------------------------ AI death drop

    struct FDropLayout
    {
        bool bResolved = false;
        const UClass* FortPawnClass = nullptr;
        const UClass* PlayerPawnClass = nullptr;
        const UClass* InventoryClass = nullptr;
        const UClass* WorldItemDefinitionClass = nullptr;
        int32 PawnController = -1;
        int32 PawnPlayerState = -1;
        FBit IsDying;
        FBit PlayedDying;
        FBit ShouldDropItemsOnDeath; // FortPlayerPawnAthena only
        FBit PlayerStateIsABot;
        int32 DropBehavior = -1;
        int64 DestroyOnDrop = -1;
        std::unordered_map<const UClass*, int32> InventoryOffsets; // per AI controller class
    };

    FDropLayout GDrop;

    void ResolveDropLayout()
    {
        auto& L = GDrop;
        if (L.bResolved)
            return;
        L.bResolved = true;
        L.FortPawnClass = FindClass("FortPawn");
        L.PlayerPawnClass = FindClass("FortPlayerPawnAthena");
        L.InventoryClass = FindClass("FortInventory");
        L.WorldItemDefinitionClass = FindClass("FortWorldItemDefinition");
        auto PawnClass = FindClass("Pawn");
        L.PawnController = AIBase::OffsetOf(PawnClass, "Controller");
        L.PawnPlayerState = AIBase::OffsetOf(PawnClass, "PlayerState");
        L.IsDying = ResolveBit(L.FortPawnClass, "bIsDying");
        L.PlayedDying = ResolveBit(L.FortPawnClass, "bPlayedDying");
        L.ShouldDropItemsOnDeath = ResolveBit(L.PlayerPawnClass, "bShouldDropItemsOnDeath");
        L.PlayerStateIsABot = ResolveBit(FindClass("PlayerState"), "bIsABot");
        L.DropBehavior = AIBase::OffsetOf(L.WorldItemDefinitionClass, "DropBehavior");
        if (auto Enum = FindEnum("EWorldItemDropBehavior"))
            L.DestroyOnDrop = Enum->GetValue("DestroyOnDrop");
    }

    // The inventory an AI controller owns (AFortAthenaAIBotController::Inventory), if any.
    UObject* ReadControllerInventory(const UObject* Controller)
    {
        auto& L = GDrop;
        if (!L.InventoryClass)
            return nullptr;
        auto It = L.InventoryOffsets.find(Controller->Class);
        if (It == L.InventoryOffsets.end())
        {
            auto Property = Controller->Class->GetProperty("Inventory", AIBase::ECastFlags::ObjectProperty);
            It = L.InventoryOffsets.emplace(Controller->Class, AIBase::PropertyOffset(Property)).first;
        }
        if (It->second < 0)
            return nullptr;
        auto Inventory = GetFromOffset<UObject*>(Controller, It->second);
        return AIBase::IsLiveObject(Inventory) && Inventory->IsA(L.InventoryClass) ? Inventory : nullptr;
    }

    bool IsPlayerBot(const UObject* Pawn)
    {
        auto& L = GDrop;
        if (L.PawnPlayerState < 0)
            return false;
        auto PlayerState = GetFromOffset<UObject*>(Pawn, L.PawnPlayerState);
        return AIBase::IsLiveObject(PlayerState) && ReadBit(PlayerState, L.PlayerStateIsABot);
    }

    bool IsDying(const UObject* Pawn)
    {
        return ReadBit(Pawn, GDrop.IsDying) || ReadBit(Pawn, GDrop.PlayedDying);
    }

    // Velora FortAthenaAIBotController.cpp:405-421: bCanBeDropped, then DropBehavior. Empty stacks
    // never become pickups here, so DropAsPickupDestroyOnEmpty and DropAsPickupEvenWhenEmpty both
    // drop what is left and only DestroyOnDrop keeps an item back.
    bool CanDropItem(const UFortItemDefinition* Definition, int32 Count)
    {
        auto& L = GDrop;
        if (Count <= 0)
            return false;
        if (Definition->HasbCanBeDropped() && !Definition->bCanBeDropped)
            return false;
        if (L.DropBehavior >= 0 && L.DestroyOnDrop >= 0 && L.WorldItemDefinitionClass &&
            Definition->IsA(L.WorldItemDefinitionClass) &&
            GetFromOffset<uint8>(Definition, L.DropBehavior) == (uint8)L.DestroyOnDrop)
        {
            return false;
        }
        return true;
    }

    bool SameGuid(const FGuid& First, const FGuid& Second)
    {
        return First.A == Second.A && First.B == Second.B && First.C == Second.C && First.D == Second.D;
    }

    // AFortInventory::Remove(Guid) takes the first entry with that GUID: only an entry with a
    // non-zero GUID that no earlier entry shares can be dropped and then removed exactly.
    bool IsFirstWithGuid(TArray<FFortItemEntry>& Entries, int32 Index, const FGuid& Guid, int32 EntrySize)
    {
        if (!Guid.A && !Guid.B && !Guid.C && !Guid.D)
            return false;
        for (int32 Other = 0; Other < Index; ++Other)
        {
            if (SameGuid(Entries.Get(Other, EntrySize).ItemGuid, Guid))
                return false;
        }
        return true;
    }

    // Drops what is still in a dead AI's inventory and removes each dropped entry from it, so an
    // inventory the game's own drop already emptied gives no duplicate and nothing is dropped
    // twice (the same controller dying again only drops what it holds then). Only inventories
    // owned by a live AI controller are touched, never a player's. OutKept says why nothing was.
    int32 DropInventory(AActor* Pawn, UObject* InventoryObject, bool bPlayerBot, int32 Budget,
        const char*& OutKept)
    {
        auto& L = GDrop;
        OutKept = nullptr;
        if (!AIBase::IsLiveObject(InventoryObject) || !InventoryObject->IsA(L.InventoryClass))
        {
            OutKept = "its inventory is gone";
            return 0;
        }
        auto Inventory = static_cast<AFortInventory*>(InventoryObject);
        // Remove() hands the owner's inventory interface to the removed item.
        AActor* Owner = Inventory->Owner;
        if (!AIBase::IsAIController(Owner) ||
            !Owner->GetInterface(IFortInventoryOwnerInterface::StaticClass()))
        {
            OutKept = "its inventory has no AI owner with an inventory interface";
            return 0;
        }
        const bool bPlayerPawn = L.PlayerPawnClass && Pawn->IsA(L.PlayerPawnClass);
        if (bPlayerPawn && L.ShouldDropItemsOnDeath.Offset >= 0 && !ReadBit(Pawn, L.ShouldDropItemsOnDeath))
        {
            OutKept = "the pawn doesn't drop items on death";
            return 0;
        }

        auto& Entries = Inventory->Inventory.ReplicatedEntries;
        const int32 Num = Entries.Num();
        const int32 EntrySize = FFortItemEntry::Size();
        if (Num < 0 || Num > 512 || EntrySize <= 0 ||
            (Num > 0 && !SDK::MemReadable(Entries.GetData(), (size_t)Num * EntrySize)))
        {
            OutKept = "its inventory can't be read";
            return 0;
        }
        if (Num == 0)
            return 0; // nothing left: the game dropped it already, or it had nothing

        const FVector Location = Pawn->K2_GetActorLocation();
        auto DroppedBy = bPlayerPawn ? static_cast<AFortPlayerPawnAthena*>(Pawn) : nullptr;
        const long long SourceType = EFortPickupSourceTypeFlag::HasAI()
            ? EFortPickupSourceTypeFlag::GetAI() : EFortPickupSourceTypeFlag::GetOther();
        long long SpawnSource = EFortPickupSpawnSource::GetUnset();
        if (bPlayerBot && EFortPickupSpawnSource::HasBotElimination())
            SpawnSource = EFortPickupSpawnSource::GetBotElimination();
        else if (!bPlayerBot && EFortPickupSpawnSource::HasNPCElimination())
            SpawnSource = EFortPickupSpawnSource::GetNPCElimination();

        // A dropped entry is removed at once, so the next one moves to the same index.
        int32 Spawned = 0;
        int32 Index = 0;
        for (int32 Visited = 0; Visited < kMaxEntriesPerInventory && Spawned < Budget; ++Visited)
        {
            const int32 Before = Entries.Num();
            if (Index >= Before)
                break;
            auto& Entry = Entries.Get(Index, EntrySize);
            auto Definition = Entry.ItemDefinition;
            const FGuid Guid = Entry.ItemGuid;
            if (!AIBase::IsLiveObject(Definition) || !CanDropItem(Definition, Entry.Count) ||
                !IsFirstWithGuid(Entries, Index, Guid, EntrySize) ||
                !AFortInventory::SpawnPickup(Location, Entry, SourceType, SpawnSource, DroppedBy, -1,
                    true, true, true))
            {
                ++Index;
                continue;
            }
            ++Spawned;
            Inventory->Remove(Guid);
            if (Entries.Num() >= Before)
                ++Index; // not removed after all: never look at it twice
        }
        return Spawned;
    }

    // At most kMaxLoggedDrops lines per match, then one note.
    void LogDrop(const std::string& Text)
    {
        const int32 Logged = GMatch.LoggedDrops++;
        if (Logged < kMaxLoggedDrops)
            AIBase::LogLine(kTag, "AI death drop: " + Text);
        else if (Logged == kMaxLoggedDrops)
            AIBase::LogLine(kTag, "AI death drop: further drops are not logged");
    }

    struct FPollContext
    {
        int32 GamePhase = -1;
    };

    struct FDeadAI
    {
        AActor* Pawn;
        UObject* Inventory;
        bool bPlayerBot;
        bool bNPC;
        LivingWorldSpawner::FLootInfo Loot;
    };

    // Pickups near a place (FortPickup actors), to tell whether the game already dropped something
    // for a dead NPC.
    int32 PickupsNear(const FVector& Place, TArray<AActor*>& Pickups, bool& bLoaded)
    {
        if (!bLoaded)
        {
            bLoaded = true;
            static const UClass* PickupClass = FindClass("FortPickup");
            if (PickupClass)
                Utils::GetAll(PickupClass, Pickups);
        }
        int32 Count = 0;
        for (int32 Index = 0; Index < Pickups.Num(); ++Index)
        {
            auto Pickup = Pickups[Index];
            if (Pickup && AIBase::IsLiveObject(Pickup) &&
                FVector::Dist(Pickup->K2_GetActorLocation(), Place) < kNativeDropRadiusCm)
            {
                ++Count;
            }
        }
        return Count;
    }

    void PollDeathDropsUnsafe(void* RawContext)
    {
        const auto& Poll = *static_cast<const FPollContext*>(RawContext);
        ResolveDropLayout();
        auto& L = GDrop;
        if (!L.FortPawnClass || !L.InventoryClass || L.PawnController < 0 ||
            (L.IsDying.Offset < 0 && L.PlayedDying.Offset < 0))
        {
            GMatch.bDropUnsupported = true;
            AIBase::Logf(kTag, "AI death drop off: this build has no %s",
                !L.FortPawnClass ? "FortPawn class" : !L.InventoryClass ? "FortInventory class" :
                L.PawnController < 0 ? "Pawn.Controller" : "bIsDying/bPlayedDying");
            return;
        }

        std::vector<FDeadAI> Dead;
        TArray<AActor*> Pawns;
        Utils::GetAll(L.FortPawnClass, Pawns);
        const int32 PawnCount = (std::min)(Pawns.Num(), kMaxPawnsPerPoll);
        for (int32 Index = 0; Index < PawnCount; ++Index)
        {
            AActor* Pawn = Pawns[Index];
            if (!Pawn || !Pawn->Class)
                continue;
            const uint64 Key = IdentityOf(Pawn);
            if (GMatch.Handled.count(Key))
                continue;

            auto Controller = GetFromOffset<UObject*>(Pawn, L.PawnController);
            auto Tracked = GMatch.Tracked.find(Key);
            if (Controller && AIBase::IsAIController(Controller))
            {
                if (Tracked == GMatch.Tracked.end())
                    Tracked = GMatch.Tracked.emplace(Key, FTrackedAI{}).first;
                Tracked->second.Pawn = TWeakObjectPtr<UObject>(static_cast<UObject*>(Pawn));
                if (auto Inventory = ReadControllerInventory(Controller))
                    Tracked->second.Inventory = TWeakObjectPtr<UObject>(Inventory);
                Tracked->second.bPlayerBot = IsPlayerBot(Pawn);
                // Living world NPCs: their loot info, once the game set it.
                if (!Tracked->second.bNPC && LivingWorldSpawner::IsNPCController(Controller))
                    Tracked->second.bNPC = true;
                if (Tracked->second.bNPC && !Tracked->second.Loot.bResolved)
                    LivingWorldSpawner::ReadLootInfo(Controller, Tracked->second.Loot);
            }
            if (Tracked == GMatch.Tracked.end() || !IsDying(Pawn))
                continue; // players, uncontrolled actors and living AI

            GMatch.Handled.insert(Key);
            Dead.push_back(FDeadAI{ Pawn, const_cast<UObject*>(Tracked->second.Inventory.Get()),
                Tracked->second.bPlayerBot, Tracked->second.bNPC, Tracked->second.Loot });
            GMatch.Tracked.erase(Tracked);
        }
        Pawns.Free();

        for (auto It = GMatch.Tracked.begin(); It != GMatch.Tracked.end();)
        {
            if (!It->second.Pawn.Get())
                It = GMatch.Tracked.erase(It);
            else
                ++It;
        }
        if (Dead.empty())
            return;

        // Builds where the game still drops AI items itself (before 16.00): DropInventory only drops
        // what is still in the inventory and removes it, so an inventory the game emptied gives
        // nothing twice.
        int32 Budget = kMaxPickupsPerPoll;
        TArray<AActor*> Pickups;
        bool bPickupsLoaded = false;
        for (const auto& Entry : Dead)
        {
            if (!AIBase::IsLiveObject(Entry.Pawn))
                continue;
            const std::string PawnClass = ClassNameOf(Entry.Pawn);
            // Bots killed in warmup come back with their inventory.
            if (Entry.bPlayerBot && Poll.GamePhase >= 0 && Poll.GamePhase < kGamePhaseAircraft)
            {
                if (!GMatch.bWarmupNoticeLogged)
                {
                    GMatch.bWarmupNoticeLogged = true;
                    AIBase::LogLine(kTag, "AI death drop: bots killed in warmup keep their items");
                }
                continue;
            }
            // A Living world NPC also drops its loot tiers, unless the game already dropped
            // something there (counted before our own inventory drop).
            const bool bLootTiers = Entry.bNPC && Entry.Loot.Table && Budget > 0;
            const int32 NativePickups = bLootTiers
                ? PickupsNear(Entry.Pawn->K2_GetActorLocation(), Pickups, bPickupsLoaded) : 0;
            if ((!Entry.Inventory && !bLootTiers) || Budget <= 0)
                continue;
            const char* Kept = nullptr;
            int32 Spawned = 0;
            if (Entry.Inventory)
            {
                Spawned = DropInventory(Entry.Pawn, Entry.Inventory, Entry.bPlayerBot, Budget, Kept);
                Budget -= Spawned;
            }
            else
                Kept = "it has no inventory";
            ++GMatch.DroppedPawns;
            if (!bLootTiers)
            {
                if (Kept)
                    LogDrop(PawnClass + " dropped nothing: " + Kept);
                else
                    LogDrop(PawnClass + " dropped " + std::to_string(Spawned) + " item(s)");
                continue;
            }
            const char* NoLoot = nullptr;
            int32 LootSpawned = 0;
            if (NativePickups > 0)
                NoLoot = "the game dropped loot there already";
            else
            {
                LootSpawned = LivingWorldSpawner::DropLootTiers(Entry.Pawn, Entry.Loot, Budget, NoLoot);
                Budget -= LootSpawned;
            }
            LogDrop(PawnClass + " dropped " + std::to_string(Spawned) + " item(s)" +
                (Kept ? std::string(" (inventory: ") + Kept + ")" : std::string()) + " and " +
                std::to_string(LootSpawned) + " loot pickup(s)" +
                (NoLoot ? std::string(" (loot: ") + NoLoot + ")" : std::string()));
        }
        Pickups.Free();
    }

    // ------------------------------------------------------------------ Diagnostic dump

    struct FDumpContext
    {
        UWorld* World = nullptr;
        AFortGameMode* GameMode = nullptr;
        int32 GamePhase = -1;
        int32 Lines = 0;
        bool bCapped = false;
    };

    // The dump only queues its lines; GameThreadTick writes at most kDumpLinesPerTick of them per
    // poll, so up to kDumpLineCap pipe writes don't block one frame.
    void QueueDumpLine(std::string Text)
    {
        GDumpQueue.push_back(std::move(Text));
    }

    void FlushDumpLines()
    {
        for (size_t Written = 0; Written < kDumpLinesPerTick && !GDumpQueue.empty(); ++Written)
        {
            AIBase::LogLine(kTag, GDumpQueue.front());
            GDumpQueue.pop_front();
        }
    }

    bool Line(FDumpContext& Dump, const char* Format, ...)
    {
        if (Dump.bCapped)
            return false;
        if (Dump.Lines >= kDumpLineCap)
        {
            Dump.bCapped = true;
            QueueDumpLine("dump capped at " + std::to_string(kDumpLineCap) + " lines");
            return false;
        }
        char Buffer[640];
        va_list Args;
        va_start(Args, Format);
        vsnprintf(Buffer, sizeof(Buffer), Format, Args);
        va_end(Args);
        ++Dump.Lines;
        QueueDumpLine(std::string("dump ") + Buffer);
        return true;
    }

    const UDataTable* ReadTable(const UStruct* Struct, const void* Base, const char* Name,
        std::string& OutText)
    {
        bool bNotLoaded = false;
        auto Table = ReadObjectRef(Struct, Base, Name, &bNotLoaded);
        static const UClass* DataTableClass = FindClass("DataTable");
        if (Table && DataTableClass && Table->IsA(DataTableClass))
        {
            OutText = NameOf(Table);
            return static_cast<const UDataTable*>(Table);
        }
        OutText = bNotLoaded ? "not loaded" : "none";
        return nullptr;
    }

    const UStruct* RowStructOf(const UDataTable* Table)
    {
        auto RowStruct = ReadObjectRef(Table->Class, Table, "RowStruct");
        return RowStruct ? static_cast<const UStruct*>(RowStruct) : nullptr;
    }

    void DumpEvents(FDumpContext& Dump, const std::string& Category, const UDataTable* Events)
    {
        auto RowStruct = RowStructOf(Events);
        int32 Rows = 0;
        for (auto& Pair : Events->RowMap)
        {
            if (++Rows > 40)
            {
                Line(Dump, "lager: event %s/... more rows not shown", Category.c_str());
                return;
            }
            const uint8* Row = Pair.Value();
            if (!Row || !RowStruct)
                continue;
            bool bNotLoaded = false;
            auto EventData = ReadObjectRef(RowStruct, Row, "EventData", &bNotLoaded);
            if (!Line(Dump, "lager: event %s/%s enabled=%s weight=%s data=%s", Category.c_str(),
                    Pair.Key().ToString().c_str(), ReadScalableFloatText(RowStruct, Row, "IsEnabled").c_str(),
                    ReadNumberText(RowStruct, Row, "Weight").c_str(),
                    EventData ? NameOf(EventData).c_str() : (bNotLoaded ? "not loaded" : "none")))
            {
                return;
            }
        }
    }

    void DumpLagerManager(FDumpContext& Dump, const UObject* Manager)
    {
        auto Class = Manager->Class;
        Line(Dump, "lager: manager %s (class %s, outer %s), LagerEnabled=%s", NameOf(Manager).c_str(),
            ClassNameOf(Manager).c_str(), NameOf(Manager->Outer).c_str(),
            ReadScalableFloatText(Class, Manager, "LagerEnabled").c_str());

        bool bDefaultNotLoaded = false;
        const char* ConfigSource = "CachedConfig";
        auto Config = ReadObjectRef(Class, Manager, "CachedConfig");
        if (!Config)
        {
            ConfigSource = "DefaultLagerConfig";
            Config = ReadObjectRef(Class, Manager, "DefaultLagerConfig", &bDefaultNotLoaded);
        }
        Line(Dump, "lager: config %s (%s), overrides %d, point providers %d, runtime providers %d",
            Config ? NameOf(Config).c_str() : (bDefaultNotLoaded ? "not loaded" : "none"), ConfigSource,
            ReadArrayNum(Class, Manager, "LagerConfigOverrides"),
            ReadArrayNum(Class, Manager, "PointProviders"),
            ReadArrayNum(Class, Manager, "RuntimePointProviderList"));

        const uint8* LoadedData = nullptr;
        const int32 Loaded = ReadArrayNum(Class, Manager, "LoadedSpawnerDataClass", &LoadedData);
        Line(Dump, "lager: loaded spawner data classes %d", Loaded);
        if (Loaded > 0 && LoadedData && SDK::MemReadable(LoadedData, (size_t)Loaded * sizeof(void*)))
        {
            for (int32 Index = 0; Index < Loaded && Index < 40; ++Index)
            {
                auto LoadedClass = reinterpret_cast<const UObject* const*>(LoadedData)[Index];
                if (!Line(Dump, "lager: loaded %s",
                        AIBase::IsLiveObject(LoadedClass) ? NameOf(LoadedClass).c_str() : "none"))
                {
                    return;
                }
            }
        }

        if (!Config)
            return;
        std::string CategoryTableText;
        auto Categories = ReadTable(Config->Class, Config, "CategoryTable", CategoryTableText);
        Line(Dump, "lager: config MaxActorCount=%s MaxEventSpawnPerTick=%s, category table %s",
            ReadScalableFloatText(Config->Class, Config, "MaxActorCount").c_str(),
            ReadScalableFloatText(Config->Class, Config, "MaxEventSpawnPerTick").c_str(),
            CategoryTableText.c_str());
        if (!Categories)
            return;

        auto RowStruct = RowStructOf(Categories);
        int32 Rows = 0;
        for (auto& Pair : Categories->RowMap)
        {
            if (++Rows > 60)
            {
                Line(Dump, "lager: more categories not shown");
                return;
            }
            const uint8* Row = Pair.Value();
            if (!Row || !RowStruct)
                continue;
            const std::string Category = Pair.Key().ToString().c_str();
            std::string EventTableText;
            auto Events = ReadTable(RowStruct, Row, "EventTable", EventTableText);
            if (!Line(Dump, "lager: category %s enabled=%s max=%s priority=%s events=%s", Category.c_str(),
                    ReadScalableFloatText(RowStruct, Row, "IsEnabled").c_str(),
                    ReadNumberText(RowStruct, Row, "MaxCount").c_str(),
                    ReadNumberText(RowStruct, Row, "Priority").c_str(), EventTableText.c_str()))
            {
                return;
            }
            if (Events)
                DumpEvents(Dump, Category, Events);
        }
    }

    int32 CountActors(const UClass* Class)
    {
        static const UClass* ActorClass = FindClass("Actor");
        if (!Class || !ActorClass || !AIBase::IsChildOfClass(Class, ActorClass))
            return -1;
        TArray<AActor*> Actors;
        Utils::GetAll(Class, Actors);
        const int32 Num = Actors.Num();
        Actors.Free();
        return Num;
    }

    void DumpUnsafe(void* RawContext)
    {
        auto& Dump = *static_cast<FDumpContext*>(RawContext);

        // Only on builds that have at least one of the classes this dump is about.
        const UClass* LagerClass = FindClass("FortAthenaLivingWorldManager");
        const UClass* PatrolClass = FindClass("FortAthenaPatrolPath");
        const UClass* SpawnerBase = FindClass("FortAthenaSpawnerDataBase");
        if (!SpawnerBase)
            SpawnerBase = FindClass("FortAthenaAISpawnerData");
        if (!LagerClass && !PatrolClass && !SpawnerBase)
        {
            Line(Dump, "skipped: Fortnite %.2f has no Living world manager, patrol path or AI spawner "
                "data class", VersionInfo.FortniteVersion);
            return;
        }

        Line(Dump, "begin: Fortnite %.2f CL %llu, bots=%d livingWorld=%d dumpFlag=%d, game phase %d",
            VersionInfo.FortniteVersion, (unsigned long long)VersionInfo.FortniteChangelist,
            (int)FConfiguration::bPlayerBots.load(), (int)FConfiguration::bLivingWorld.load(),
            (int)FConfiguration::bLivingWorldDump.load(), Dump.GamePhase);

        // One pass over all objects: Lager managers, spawner data classes, point provider classes.
        const UClass* ActorClass = FindClass("Actor");
        const UClass* ClassClass = UClass::StaticClass();
        std::vector<const UObject*> Managers;
        std::vector<const UClass*> SpawnerClasses;
        std::vector<const UClass*> ProviderClasses;
        const int32 ObjectCount = TUObjectArray::Num();
        for (int32 Index = 0; Index < ObjectCount; ++Index)
        {
            auto Object = TUObjectArray::GetObjectByIndex(Index);
            if (!Object || !Object->Class)
                continue;
            if (LagerClass && !Object->IsDefaultObject() && Managers.size() < 8 && Object->IsA(LagerClass))
            {
                Managers.push_back(Object);
                continue;
            }
            if (!ClassClass || !Object->IsA(ClassClass))
                continue;
            auto Class = static_cast<const UClass*>(Object);
            if (SpawnerBase && AIBase::IsChildOfClass(Class, SpawnerBase))
            {
                if (SpawnerClasses.size() < 160)
                    SpawnerClasses.push_back(Class);
                continue;
            }
            if (ActorClass && ProviderClasses.size() < 40 && AIBase::IsChildOfClass(Class, ActorClass))
            {
                const std::string Name = NameOf(Class);
                const bool bBlueprint = Name.size() > 2 && Name.compare(Name.size() - 2, 2, "_C") == 0;
                if (!bBlueprint && (Name.find("PointProvider") != std::string::npos ||
                        Name.find("PointAroundPlayerProvider") != std::string::npos ||
                        Name.find("LivingWorldVolume") != std::string::npos))
                {
                    ProviderClasses.push_back(Class);
                }
            }
        }

        // Lager / Living World manager.
        if (!LagerClass)
            Line(Dump, "lager: this build has no FortAthenaLivingWorldManager class");
        else
        {
            Line(Dump, "lager: FortAthenaLivingWorldManager present, %d instance(s)", (int)Managers.size());
            for (size_t Index = 0; Index < Managers.size() && Index < 4 && !Dump.bCapped; ++Index)
            {
                if (AIBase::IsLiveObject(Managers[Index]))
                    DumpLagerManager(Dump, Managers[Index]);
            }
        }

        // Patrol paths and their tags.
        if (PatrolClass)
        {
            TArray<AActor*> Paths;
            Utils::GetAll(PatrolClass, Paths);
            Line(Dump, "patrol: %d path(s)", Paths.Num());
            for (int32 Index = 0; Index < Paths.Num() && Index < 60 && !Dump.bCapped; ++Index)
            {
                auto Path = Paths[Index];
                if (!AIBase::IsLiveObject(Path))
                    continue;
                Line(Dump, "patrol: %s points=%d tags=%s", NameOf(Path).c_str(),
                    ReadArrayNum(Path->Class, Path, "PatrolPoints"),
                    TagsOf(Path->Class, Path, "GameplayTags", 6).c_str());
            }
            if (Paths.Num() > 60)
                Line(Dump, "patrol: %d more path(s) not shown", Paths.Num() - 60);
            Paths.Free();
        }
        else
            Line(Dump, "patrol: this build has no FortAthenaPatrolPath class");

        // Point providers by class (counts include subclasses).
        Line(Dump, "providers: %d point provider class(es)", (int)ProviderClasses.size());
        for (auto Class : ProviderClasses)
        {
            if (!Line(Dump, "providers: %s %d", NameOf(Class).c_str(), CountActors(Class)))
                break;
        }

        // Loaded spawner data classes and their DescriptorTag.
        Line(Dump, "spawnerdata: %d loaded class(es) under %s", (int)SpawnerClasses.size(),
            SpawnerBase ? NameOf(SpawnerBase).c_str() : "none");
        for (auto Class : SpawnerClasses)
        {
            auto Default = Class->GetDefaultObj();
            const std::string Tags = AIBase::IsLiveObject(Default)
                ? TagsOf(Class, Default, "DescriptorTag", 4) : std::string("-");
            if (!Line(Dump, "spawnerdata: %s tag=%s", NameOf(Class).c_str(), Tags.c_str()))
                break;
        }

        // AI system and spawner.
        auto World = Dump.World;
        auto AISystem = ReadObjectRef(World->Class, World, "AISystem");
        auto AISpawner = AISystem ? ReadObjectRef(AISystem->Class, AISystem, "AISpawner") : nullptr;
        Line(Dump, "ai: AISystem %s, AISpawner %s, AIControllers %d, spawners %d",
            ClassNameOf(AISystem).c_str(), ClassNameOf(AISpawner).c_str(),
            AISystem ? ReadArrayNum(AISystem->Class, AISystem, "AIControllers") : -1,
            AISystem ? ReadArrayNum(AISystem->Class, AISystem, "RegisteredAISpawners") : -1);

        // Navigation.
        auto NavigationSystem = ReadObjectRef(World->Class, World, "NavigationSystem");
        auto MainNavData = NavigationSystem ? ReadObjectRef(NavigationSystem->Class, NavigationSystem,
            "MainNavData") : nullptr;
        Line(Dump, "nav: NavigationSystem %s, MainNavData %s, NavDataSet %d, nav data actors %d",
            ClassNameOf(NavigationSystem).c_str(), ClassNameOf(MainNavData).c_str(),
            NavigationSystem ? ReadArrayNum(NavigationSystem->Class, NavigationSystem, "NavDataSet") : -1,
            CountActors(FindClass("NavigationData")));

        if (!Dump.bCapped)
            Line(Dump, "end (%d lines)", Dump.Lines + 1);
    }

    void ResetMatch(const UObject* World)
    {
        GMatch = FMatch{};
        GMatch.World = World;
        GDropFaults.Reset();
        GDumpFaults.Reset();
    }
}

bool LivingWorld::IsActive()
{
    return LivingWorldSpawner::IsActive();
}

void LivingWorld::GameThreadTick()
{
    // Not the raw switches: bots count once their gate passed, Living world once it spawns (or was
    // asked for at "Start match" and this build has an AI spawner).
    const bool bAIActive = AIBase::IsAnyAIFeatureActive();
    const bool bRequested = LivingWorldSpawner::IsRequested();
    const bool bDumpWanted = FConfiguration::bLivingWorldDump.load(std::memory_order_acquire) ||
        LivingWorld::IsActive();
    if (!bAIActive && !bDumpWanted && !bRequested && GDumpQueue.empty())
        return; // today's behaviour: nothing runs

    const ULONGLONG Now = GetTickCount64();
    if (Now - GLastPollMs < kPollIntervalMs)
        return;
    GLastPollMs = Now;

    FlushDumpLines();

    auto World = UWorld::GetWorld();
    if (!World)
        return;
    if (GMatch.World != World)
        ResetMatch(World);

    auto GameModeActor = World->AuthorityGameMode;
    auto GameMode = AIBase::IsLiveObject(GameModeActor) ? GameModeActor->Cast<AFortGameMode>() : nullptr;
    if (!GameMode)
        return; // the frontend, or the map is still loading
    if (!GMatch.GameModeSeenMs)
        GMatch.GameModeSeenMs = Now;
    auto GameState = AIBase::IsLiveObject(GameMode->GameState) ? GameMode->GameState : nullptr;
    const int32 GamePhase = GameState && GameState->HasGamePhase() ? (int32)GameState->GamePhase : -1;

    // Living world spawning ("Lager-lite"): its own guards, fault counters and rate limits.
    if (bRequested)
    {
        LivingWorldSpawner::FTickInput In;
        In.World = World;
        In.GameMode = GameMode;
        In.GameState = GameState ? static_cast<AFortGameStateAthena*>(GameState) : nullptr;
        In.GamePhase = GamePhase;
        In.NowMs = Now;
        In.GameModeSeenMs = GMatch.GameModeSeenMs;
        LivingWorldSpawner::Tick(In);
    }

    const double Version = VersionInfo.FortniteVersion;
    const bool bAIVersion = Version >= kFirstAIVersion && Version < kEndAIVersion;
    if (AIBase::IsAnyAIFeatureActive() && bAIVersion && !GMatch.bDropUnsupported && !GDropFaults.IsTripped())
    {
        FPollContext Poll;
        Poll.GamePhase = GamePhase;
        if (!AIBase::Guarded(&PollDeathDropsUnsafe, &Poll))
            GDropFaults.Record("the AI death drop poll");
    }

    // Once per match, after warmup (from the bus on), or 2 minutes in on playlists without a bus.
    // Only with bLivingWorldDump or while Living world is active (not just because bots run), and
    // only on builds that can have these classes (DumpUnsafe checks them by reflection too).
    if (bDumpWanted && !GMatch.bDumped && !GDumpFaults.IsTripped() &&
        (GamePhase >= kGamePhaseAircraft || Now - GMatch.GameModeSeenMs >= kDumpFallbackDelayMs))
    {
        GMatch.bDumped = true;
        if (!bAIVersion)
        {
            char Text[96];
            snprintf(Text, sizeof(Text), "dump skipped: Fortnite %.2f (the dump needs %.2f up to "
                "below %.2f)", Version, kFirstAIVersion, kEndAIVersion);
            QueueDumpLine(Text);
            return;
        }
        FDumpContext Dump;
        Dump.World = World;
        Dump.GameMode = GameMode;
        Dump.GamePhase = GamePhase;
        if (!AIBase::Guarded(&DumpUnsafe, &Dump))
        {
            GDumpFaults.Record("the Living world dump");
            QueueDumpLine("dump stopped after " + std::to_string(Dump.Lines) + " lines");
        }
    }
}

class FLivingWorldHooks
{
public:
    InitHooks;
};

// Runs in Main() after "Start match", when the launcher's settings are final, and before the map
// loads (on 19.10 the AI base's nav hook must be in before the world is created). The spawner
// decides what this build can do and tells the launcher ("off", "active" with the reason, or
// "unavailable"). When it starts spawning it sets LivingWorld::IsActive() and then calls
// AIBase::EnsureStandaloneCheckOff() before its first spawn request: on 17.00-19.99 an AI that
// possesses a pawn closes the host 5 s later unless that check is off (no spawning if it stays on).
void FLivingWorldHooks::Hook()
{
    LivingWorldSpawner::OnStartMatch();
}
