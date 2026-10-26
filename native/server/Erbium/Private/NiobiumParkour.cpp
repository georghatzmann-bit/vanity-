// NIOBIUM: trickshot parkours, target bots and trickshot detection - Niobium's own code (GPL-3.0),
// not part of Magnesium. See NiobiumParkour.h.
//
// The parkours live in %LOCALAPPDATA%\Niobium\server\parkours.json (written by the launcher, same file
// as launcher/src/data/parkours.json). All values there are metres relative to the player:
// at = [forward, right, up]. One floor tile is 5.12 m.
//
// Steps of "parkour <id>" (on the game thread, from ServerCheat):
//   1. remove the old Niobium parkour
//   2. round the view direction to 90 degrees, feet F = player - 90 cm + height
//   3. start floor (w x d tiles) around F, then jump objects (+ their own floors), then target bots on a floor each
//   4. put the player on the start, facing forward, give a sniper rifle, remember the start
//
// Floors are made like when a trickshot preset is loaded (GUI.cpp) and stay "forcibly supported",
// so floors in the air never collapse. Bots are made with the existing "bot X Y Z" command.
#include "pch.h"
#include "../Public/NiobiumParkour.h"
#include "../Public/NiobiumControl.h"
#include "../Public/Configuration.h"
#include "../Public/GUI.h"
#include "../../json.hpp"
#include <Engine/Public/NetDriver.h>
#include <FortniteGame/Public/FortPlayerControllerAthena.h>
#include <FortniteGame/Public/FortGameMode.h>
#include <FortniteGame/Public/BuildingSMActor.h>
#include <FortniteGame/Public/FortInventory.h>
#include <Windows.h>
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <string>
#include <unordered_set>
#include <vector>

namespace
{
    using json = nlohmann::json;

    constexpr double kTileCm = 512.0;             // one floor tile
    constexpr double kCapsuleHalfHeightCm = 90.0; // player centre to feet
    constexpr double kStandAboveTileCm = 100.0;   // put player/bot this far above the floor
    constexpr int kMaxTilesPerSide = 9;
    constexpr size_t kMaxElements = 48;
    constexpr size_t kMaxBots = 12;
    constexpr size_t kMaxParkours = 256;
    constexpr long long kMaxFileBytes = 2LL * 1024 * 1024;
    constexpr double kMaxOffsetMeters = 1000.0;
    constexpr ULONGLONG kTrickshotRepeatMs = 1500;
    constexpr double kReuseMarginCm = kTileCm;     // this far beside the old start floor still counts as "on it"
    constexpr double kReuseBelowStartCm = 300.0;   // this far below the old start floor still counts as "on it"
    constexpr double kReuseMinRaiseCm = 100.0;     // only if the old start was this high above the ground

    // ---------------------------------------------------------------- Data

    struct FVec3
    {
        double X = 0.0;
        double Y = 0.0;
        double Z = 0.0;
    };

    struct FKindDef
    {
        std::string Label;
        std::vector<std::string> Summon;
    };

    struct FElementDef
    {
        std::string Kind;
        FVec3 At;
        int PlatformW = 0;
        int PlatformD = 0;
    };

    struct FBotDef
    {
        FVec3 At;
        int Hp = 50;
        int PlatformW = 1;
        int PlatformD = 1;
    };

    struct FParkourDef
    {
        std::string Id;
        std::string Name;
        int Level = 1;
        double HeightMeters = 0.0;
        int PlatformW = 0;
        int PlatformD = 0;
        std::vector<FElementDef> Elements;
        std::vector<FBotDef> Bots;
    };

    struct FParkourFile
    {
        std::map<std::string, FKindDef> Kinds; // keys in lower case
        std::vector<std::string> Snipers;
        std::vector<FParkourDef> Parkours;
    };

    struct FBotSlot
    {
        TWeakObjectPtr<AFortPlayerControllerAthena> Controller;
        FVec3 Where; // bot centre (floor + 1 m)
        int Hp = 50;
    };

    struct FSpawnedSet
    {
        std::vector<TWeakObjectPtr<AActor>> Actors; // floors and objects
        std::vector<FBotSlot> Bots;
    };

    struct FAxes
    {
        double Yaw = 0.0; // degrees
        double FwdX = 1.0;
        double FwdY = 0.0;
    };

    // Only touch on the game thread.
    TWeakObjectPtr<UWorld> GTrackedWorld;
    FSpawnedSet GParkourSpawned; // from "parkour <id>"
    FSpawnedSet GTargetSpawned;  // from "targetbot"
    bool GHasStart = false;
    FVec3 GStart;
    double GStartYaw = 0.0;
    std::string GStartName;
    bool GHasBase = false; // ground point (feet without height) the last parkour was built from
    FVec3 GBase;
    FAxes GStartAxes;               // view direction of the last parkour
    double GStartHalfFwdCm = 0.0;   // half length of the last start floor (forward)
    double GStartHalfRightCm = 0.0; // half width of the last start floor (right)

    const void* GLastTrickshotVictim = nullptr;
    ULONGLONG GLastTrickshotMs = 0;

    // ---------------------------------------------------------------- Text

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

    std::string ToLower(std::string Text)
    {
        std::transform(Text.begin(), Text.end(), Text.begin(),
            [](unsigned char c) { return (char)std::tolower(c); });
        return Text;
    }

    std::string Quote(const std::string& Text)
    {
        return "\"" + Text + "\"";
    }

    // One line to one player, always starting with "[Niobium] ".
    void Say(AFortPlayerControllerAthena* PlayerController, const std::string& Utf8)
    {
        if (!PlayerController)
            return;
        const std::wstring Wide = L"[Niobium] " + Widen(Utf8);
        PlayerController->ClientMessage(FString(Wide.c_str()), FName(), 1.f);
    }

    // ---------------------------------------------------------------- Game access

    bool IsLive(const UObject* Object)
    {
        if (!Object || !SDK::MemReadable(Object, sizeof(UObject)))
            return false;
        if (Object->Index < 0 || Object->Index >= TUObjectArray::Num())
            return false;
        auto Item = TUObjectArray::GetItemByIndex(Object->Index);
        constexpr int32 InvalidObjectFlags = 0x20;
        if (!Item || Item->GetObject() != Object || (Item->GetFlags() & InvalidObjectFlags))
            return false;
        return Object->Class != nullptr;
    }

    AFortGameMode* GetGameMode()
    {
        auto World = UWorld::GetWorld();
        return World ? (AFortGameMode*)World->AuthorityGameMode : nullptr;
    }

    // When the world changes (new match), everything remembered is invalid.
    void EnsureTrackedWorld()
    {
        auto World = UWorld::GetWorld();
        if (GTrackedWorld.Get() == World)
            return;
        GParkourSpawned = FSpawnedSet();
        GTargetSpawned = FSpawnedSet();
        GHasStart = false;
        GStartName.clear();
        GHasBase = false;
        GTrackedWorld = TWeakObjectPtr<UWorld>(World);
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

    // Runs an existing cheat command as this player (like NiobiumControl::RunCheat).
    bool RunCheatAs(AFortPlayerControllerAthena* PlayerController, const std::string& Text)
    {
        auto Function = PlayerController ? PlayerController->GetFunction("ServerCheat") : nullptr;
        if (!Function)
            return false;
        // Build it right in the parameter block (no copy), FString frees its own memory.
        const std::wstring Wide = Widen(Text);
        struct FParams
        {
            FString Msg;
        } Params{ FString(Wide.c_str()) };
        return GuardedProcessEvent(PlayerController, Function, &Params);
    }

    // The player's view direction (camera), otherwise the pawn's rotation.
    double GetViewYaw(AFortPlayerControllerAthena* PlayerController, AFortPlayerPawnAthena* Pawn)
    {
        double Yaw = 0.0;
        if (PlayerController->GetFunction("GetControlRotation"))
        {
            const FRotator Control = PlayerController->GetControlRotation();
            Yaw = Control.Yaw;
        }
        else
        {
            const FRotator PawnRotation = Pawn->K2_GetActorRotation();
            Yaw = PawnRotation.Yaw;
        }
        return std::isfinite(Yaw) ? Yaw : 0.0;
    }

    // Rounded to 90 degrees: 0 = +X, 1 = +Y, 2 = -X, 3 = -Y.
    int SnapQuarter(double Yaw)
    {
        int Quarter = (int)std::fmod(std::round(Yaw / 90.0), 4.0);
        if (Quarter < 0)
            Quarter += 4;
        return Quarter;
    }

    FAxes SnappedAxes(double Yaw)
    {
        static constexpr double kFwd[4][2] = { { 1.0, 0.0 }, { 0.0, 1.0 }, { -1.0, 0.0 }, { 0.0, -1.0 } };
        const int Quarter = SnapQuarter(Yaw);
        FAxes Axes;
        Axes.Yaw = Quarter * 90.0;
        Axes.FwdX = kFwd[Quarter][0];
        Axes.FwdY = kFwd[Quarter][1];
        return Axes;
    }

    // Origin + forward*Forward + right*Right + up*Up (all in cm). Right = (-FwdY, FwdX).
    FVec3 ShiftCm(const FVec3& Origin, const FAxes& Axes, double ForwardCm, double RightCm, double UpCm)
    {
        FVec3 Out;
        Out.X = Origin.X + ForwardCm * Axes.FwdX - RightCm * Axes.FwdY;
        Out.Y = Origin.Y + ForwardCm * Axes.FwdY + RightCm * Axes.FwdX;
        Out.Z = Origin.Z + UpCm;
        return Out;
    }

    FVec3 ShiftMeters(const FVec3& Origin, const FAxes& Axes, const FVec3& AtMeters)
    {
        return ShiftCm(Origin, Axes, AtMeters.X * 100.0, AtMeters.Y * 100.0, AtMeters.Z * 100.0);
    }

    // Like ApplyLoadedBuildOwnership when a trickshot preset is loaded (GUI.cpp).
    void ApplyBuildOwnership(ABuildingSMActor* Build, AFortPlayerControllerAthena* Controller)
    {
        Build->bPlayerPlaced = true;
        auto PlayerState = Controller->PlayerState;
        if (PlayerState)
        {
            if (Build->HasTeam() && PlayerState->HasTeamIndex())
                Build->Team = PlayerState->TeamIndex;
            if (Build->HasTeamIndex() && PlayerState->HasTeamIndex())
                Build->TeamIndex = PlayerState->TeamIndex;
            if (Build->HasOwnerPersistentID() && PlayerState->HasWorldPlayerId())
                Build->OwnerPersistentID = PlayerState->WorldPlayerId;
            if (PlayerState->HasTeamIndex())
                Build->SetTeam(PlayerState->TeamIndex);
        }
        Build->ForceNetUpdate();
    }

    // A Fortnite floor does NOT have its origin in the middle: it sits at walking height in the middle of its
    // left edge (local -Y), and the plate reaches 512 cm to the right (local +Y) and 256 cm forward and back
    // from there. Proof: the bundled preset Erbium/Resources/TrickshotPresets/BlockWinner_15Bandit.json
    // (real player builds from FN 10.40, saved with K2_GetActorLocation). Only with this origin do all
    // 219 floors and 67 stairs/roofs in it sit centred in the 512 grid without overlaps (the three other
    // edges give 17-37 double-used cells, "middle" gives no common grid). All build pieces
    // sit on multiples of 384 cm, so the origin is the bottom edge of the storey = walking height.
    constexpr double kFloorOriginLeftOfCenterCm = kTileCm / 2.0;

    // One floor tile centred on Center. Same recipe as preset loading, but the support always
    // stays on.
    AActor* SpawnFloorTile(AFortPlayerControllerAthena* Controller, const UClass* FloorClass,
        const FVec3& Center, double Yaw)
    {
        // Middle -> origin: half a plate to the left. Local -Y in the world is (sin Yaw, -cos Yaw).
        const double YawRadians = Yaw * 3.14159265358979323846 / 180.0;
        const FVector Location(Center.X + kFloorOriginLeftOfCenterCm * std::sin(YawRadians),
            Center.Y - kFloorOriginLeftOfCenterCm * std::cos(YawRadians), Center.Z);
        const FRotator Rotation(0.0, Yaw, 0.0);
        auto Build = UWorld::SpawnActorUnfinished<ABuildingSMActor>(FloorClass, Location, Rotation, Controller);
        if (Build)
        {
            if (Build->HasbForciblyStructurallySupported())
                Build->bForciblyStructurallySupported = true;
            Build->InitializeKismetSpawnedBuildingActor(Build, Controller, true, nullptr, false);
            UWorld::FinishSpawnActor(Build, Location, Rotation);
            if (Build->HasbForciblyStructurallySupported())
                Build->bForciblyStructurallySupported = true;
            ApplyBuildOwnership(Build, Controller);
            return Build;
        }

        auto Plain = UWorld::SpawnActor(FloorClass, Location, Rotation, nullptr);
        if (Plain)
            Plain->ForceNetUpdate();
        return Plain;
    }

    // W (right) x D (forward) tiles, centred on Center. Returns the count.
    int SpawnFloorGrid(AFortPlayerControllerAthena* Controller, const UClass* FloorClass, const FVec3& Center,
        const FAxes& Axes, int W, int D, FSpawnedSet& Set)
    {
        if (!FloorClass || W <= 0 || D <= 0)
            return 0;
        int Spawned = 0;
        for (int Right = 0; Right < W; ++Right)
        {
            for (int Forward = 0; Forward < D; ++Forward)
            {
                const double ForwardCm = (Forward - (D - 1) / 2.0) * kTileCm;
                const double RightCm = (Right - (W - 1) / 2.0) * kTileCm;
                const FVec3 TileCenter = ShiftCm(Center, Axes, ForwardCm, RightCm, 0.0);
                if (auto Tile = SpawnFloorTile(Controller, FloorClass, TileCenter, Axes.Yaw))
                {
                    Set.Actors.emplace_back(Tile);
                    ++Spawned;
                }
            }
        }
        return Spawned;
    }

    // Like "summon": tire piles belong to the player.
    AActor* SpawnObject(AFortPlayerControllerAthena* Controller, const UClass* Class, const FVec3& Where,
        double Yaw)
    {
        static const FName TireClassName(L"Prop_TirePile_Tower_C");
        AActor* Owner = Class->Name == TireClassName ? static_cast<AActor*>(Controller) : nullptr;
        auto Actor = UWorld::SpawnActor(Class, FVector(Where.X, Where.Y, Where.Z), FRotator(0.0, Yaw, 0.0), Owner);
        if (Actor)
            Actor->ForceNetUpdate();
        return Actor;
    }

    // Sets BotHealth/BotShield for one bot only and restores them afterwards.
    struct FBotStatsOverride
    {
        int OldHealth;
        int OldShield;

        explicit FBotStatsOverride(int Health)
            : OldHealth(FConfiguration::BotHealth.load(std::memory_order_acquire)),
              OldShield(FConfiguration::BotShield.load(std::memory_order_acquire))
        {
            FConfiguration::BotHealth.store(Health, std::memory_order_release);
            FConfiguration::BotShield.store(0, std::memory_order_release);
            Niobium_SetQuietBotSpawn(true);
        }

        ~FBotStatsOverride()
        {
            Niobium_SetQuietBotSpawn(false);
            FConfiguration::BotHealth.store(OldHealth, std::memory_order_release);
            FConfiguration::BotShield.store(OldShield, std::memory_order_release);
        }

        FBotStatsOverride(const FBotStatsOverride&) = delete;
        FBotStatsOverride& operator=(const FBotStatsOverride&) = delete;
    };

    // Exactly one standing bot through the existing "bot X Y Z" command. Returns its controller.
    AFortPlayerControllerAthena* SpawnStillBot(AFortPlayerControllerAthena* Controller, const FVec3& Where, int Hp)
    {
        auto GameMode = GetGameMode();
        if (!GameMode || !GameMode->HasAlivePlayers())
            return nullptr;

        std::unordered_set<const void*> Before;
        for (auto Alive : GameMode->AlivePlayers)
            Before.insert(Alive);

        // Whole centimetres: "bot" safely reads three numbers in a row as a location (before count/size).
        char Command[128];
        snprintf(Command, sizeof(Command), "bot %lld %lld %lld", std::llround(Where.X), std::llround(Where.Y),
            std::llround(Where.Z));

        {
            FBotStatsOverride Override(std::clamp(Hp, 1, 500));
            if (!RunCheatAs(Controller, Command))
                return nullptr;
        }

        GameMode = GetGameMode();
        if (!GameMode || !GameMode->HasAlivePlayers())
            return nullptr;
        for (auto Alive : GameMode->AlivePlayers)
        {
            if (!Alive || Before.count(Alive))
                continue;
            auto BotController = (AFortPlayerControllerAthena*)Alive;
            if (AFortPlayerControllerAthena::IsCheatSpawnedBotController(BotController))
                return BotController;
        }
        return nullptr;
    }

    bool IsBotStillAlive(const FBotSlot& Slot)
    {
        auto BotController = Slot.Controller.Get();
        if (!BotController || !AFortPlayerControllerAthena::IsCheatSpawnedBotController(BotController))
            return false;
        auto GameMode = GetGameMode();
        if (!GameMode || !GameMode->HasAlivePlayers())
            return false;
        for (auto Alive : GameMode->AlivePlayers)
        {
            if (Alive == BotController)
                return true;
        }
        return false;
    }

    void DestroyTrackedActor(AActor* Actor)
    {
        if (!IsLive(Actor))
            return;
        if (Actor->HasbActorIsBeingDestroyed() && Actor->bActorIsBeingDestroyed)
            return;
        auto BuildClass = ABuildingSMActor::StaticClass();
        if (BuildClass && Actor->IsA(BuildClass))
        {
            auto Build = (ABuildingSMActor*)Actor;
            if (Build->HasbDestroyed() && Build->bDestroyed)
                return;
            if (Build->GetFunction("SilentDie"))
                Build->SilentDie(true);
            else
                Build->K2_DestroyActor();
            return;
        }
        Actor->K2_DestroyActor();
    }

    struct FClearResult
    {
        int Objects = 0;
        int Bots = 0;
    };

    // Bots first (they stand on the floors), then floors and objects.
    void ClearSet(FSpawnedSet& Set, FClearResult& Result)
    {
        for (const auto& Slot : Set.Bots)
        {
            auto BotController = Slot.Controller.Get();
            if (BotController && Niobium_RemoveSpawnedBot(BotController))
                ++Result.Bots;
        }
        for (const auto& Weak : Set.Actors)
        {
            auto Actor = Weak.Get();
            if (!Actor)
                continue;
            DestroyTrackedActor(Actor);
            ++Result.Objects;
        }
        Set.Actors.clear();
        Set.Bots.clear();
    }

    bool HasItem(AFortPlayerControllerAthena* Controller, const UFortItemDefinition* Definition)
    {
        auto Inventory = Controller->WorldInventory;
        if (!Inventory || !Definition)
            return false;
        auto& Entries = Inventory->Inventory.ReplicatedEntries;
        for (int32 Index = 0; Index < Entries.Num(); ++Index)
        {
            auto& Entry = Entries.Get(Index, FFortItemEntry::Size());
            if (Entry.ItemDefinition == Definition)
                return true;
        }
        return false;
    }

    enum class ESniperResult
    {
        Given, AlreadyHad, NotFound
    };

    // First name from "snipers" this version knows (same resolver as "give").
    ESniperResult GiveSniper(AFortPlayerControllerAthena* Controller, const std::vector<std::string>& Names)
    {
        for (const auto& Name : Names)
        {
            if (Name.empty())
                continue;
            auto Definition = Niobium_FindItemDefinition(Name);
            if (!Definition)
                continue;
            if (HasItem(Controller, Definition))
                return ESniperResult::AlreadyHad;
            if (Niobium_GiveItem(Controller, Definition, 1) > 0)
                return ESniperResult::Given;
        }
        return ESniperResult::NotFound;
    }

    // Puts the player on a point, facing Yaw, with no leftover speed.
    void PlacePlayer(AFortPlayerControllerAthena* Controller, AFortPlayerPawnAthena* Pawn, const FVec3& Where,
        double Yaw)
    {
        const FRotator Rotation(0.0, Yaw, 0.0);
        if (!Pawn->K2_TeleportTo(FVector(Where.X, Where.Y, Where.Z), Rotation))
            Pawn->K2_SetActorLocation(FVector(Where.X, Where.Y, Where.Z), false, nullptr, true);
        if (Pawn->HasCharacterMovement() && Pawn->CharacterMovement)
            Pawn->CharacterMovement->Velocity = FVector();
        Controller->SetControlRotation(Rotation);
        Controller->ClientSetRotation(Rotation, true);
    }

    void RefillPlayer(AFortPlayerControllerAthena* Controller, AFortPlayerPawnAthena* Pawn)
    {
        const float MaxHealth = Pawn->GetMaxHealth();
        if (std::isfinite(MaxHealth) && MaxHealth > 0.f)
            Pawn->SetHealth(MaxHealth);
        const float MaxShield = Pawn->GetMaxShield();
        if (std::isfinite(MaxShield) && MaxShield > 0.f)
            Pawn->SetShield(MaxShield);
        Pawn->ForceNetUpdate();
        AFortInventory::ReloadAllWeaponAmmo(Controller);
    }

    AFortPlayerPawnAthena* RequirePawn(AFortPlayerControllerAthena* Controller)
    {
        auto Pawn = Controller->Pawn;
        if (!IsLive(Pawn))
        {
            Say(Controller, "You need your character for this. Wait until you're in the game.");
            return nullptr;
        }
        return Pawn;
    }

    // ---------------------------------------------------------------- Reading the file

    std::wstring ParkourFilePath()
    {
        wchar_t Buffer[1024];
        const DWORD Length = GetEnvironmentVariableW(L"LOCALAPPDATA", Buffer, (DWORD)(sizeof(Buffer) / sizeof(Buffer[0])));
        if (Length == 0 || Length >= sizeof(Buffer) / sizeof(Buffer[0]))
            return L"";
        return std::wstring(Buffer, Length) + L"\\Niobium\\server\\parkours.json";
    }

    bool ReadWholeFile(const std::wstring& Path, std::string& Out)
    {
        if (Path.empty())
            return false;
        HANDLE File = CreateFileW(Path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (File == INVALID_HANDLE_VALUE)
            return false;
        LARGE_INTEGER Size{};
        if (!GetFileSizeEx(File, &Size) || Size.QuadPart <= 0 || Size.QuadPart > kMaxFileBytes)
        {
            CloseHandle(File);
            return false;
        }
        Out.assign((size_t)Size.QuadPart, '\0');
        DWORD Read = 0;
        const BOOL bRead = ReadFile(File, Out.data(), (DWORD)Out.size(), &Read, nullptr);
        CloseHandle(File);
        if (!bRead)
            return false;
        Out.resize(Read);
        if (Out.size() >= 3 && (unsigned char)Out[0] == 0xEF && (unsigned char)Out[1] == 0xBB &&
            (unsigned char)Out[2] == 0xBF)
        {
            Out.erase(0, 3); // UTF-8 BOM
        }
        return !Out.empty();
    }

    std::string ReadString(const json& Object, const char* Key, const std::string& Fallback)
    {
        auto It = Object.find(Key);
        return (It != Object.end() && It->is_string()) ? It->get<std::string>() : Fallback;
    }

    bool ReadNumber(const json& Object, const char* Key, double& Out)
    {
        auto It = Object.find(Key);
        if (It == Object.end() || !It->is_number())
            return false;
        const double Value = It->get<double>();
        if (!std::isfinite(Value))
            return false;
        Out = Value;
        return true;
    }

    bool ReadVec3(const json& Object, const char* Key, FVec3& Out)
    {
        auto It = Object.find(Key);
        if (It == Object.end() || !It->is_array() || It->size() != 3)
            return false;
        double Values[3] = {};
        for (size_t Index = 0; Index < 3; ++Index)
        {
            const json& Item = (*It)[Index];
            if (!Item.is_number())
                return false;
            Values[Index] = Item.get<double>();
            if (!std::isfinite(Values[Index]) || std::fabs(Values[Index]) > kMaxOffsetMeters)
                return false;
        }
        Out.X = Values[0];
        Out.Y = Values[1];
        Out.Z = Values[2];
        return true;
    }

    // [w, d] -> whole numbers 0..9. Without the entry the default stays.
    void ReadPlatform(const json& Object, int& W, int& D)
    {
        auto It = Object.find("platform");
        if (It == Object.end() || !It->is_array() || It->size() != 2)
            return;
        const json& First = (*It)[0];
        const json& Second = (*It)[1];
        if (!First.is_number() || !Second.is_number())
            return;
        const double Wide = First.get<double>();
        const double Deep = Second.get<double>();
        if (!std::isfinite(Wide) || !std::isfinite(Deep))
            return;
        W = (int)std::lround(std::clamp(Wide, 0.0, (double)kMaxTilesPerSide));
        D = (int)std::lround(std::clamp(Deep, 0.0, (double)kMaxTilesPerSide));
    }

    bool ParseParkourFile(const std::string& Text, FParkourFile& Out)
    {
        const json Root = json::parse(Text, nullptr, false);
        if (Root.is_discarded() || !Root.is_object())
            return false;

        auto Kinds = Root.find("kinds");
        if (Kinds != Root.end() && Kinds->is_object())
        {
            for (auto It = Kinds->begin(); It != Kinds->end(); ++It)
            {
                const json& Value = It.value();
                if (!Value.is_object())
                    continue;
                FKindDef Kind;
                Kind.Label = ReadString(Value, "label", It.key());
                auto Summon = Value.find("summon");
                if (Summon != Value.end() && Summon->is_array())
                {
                    for (const auto& Name : *Summon)
                    {
                        if (Name.is_string())
                            Kind.Summon.push_back(Name.get<std::string>());
                    }
                }
                Out.Kinds[ToLower(It.key())] = Kind;
            }
        }

        auto Snipers = Root.find("snipers");
        if (Snipers != Root.end() && Snipers->is_array())
        {
            for (const auto& Name : *Snipers)
            {
                if (Name.is_string())
                    Out.Snipers.push_back(Name.get<std::string>());
            }
        }

        auto Parkours = Root.find("parkours");
        if (Parkours == Root.end() || !Parkours->is_array())
            return false;
        for (const auto& Entry : *Parkours)
        {
            if (Out.Parkours.size() >= kMaxParkours)
                break;
            if (!Entry.is_object())
                continue;
            FParkourDef Parkour;
            Parkour.Id = ToLower(ReadString(Entry, "id", ""));
            if (Parkour.Id.empty())
                continue;
            Parkour.Name = ReadString(Entry, "name", Parkour.Id);
            double Number = 0.0;
            if (ReadNumber(Entry, "level", Number))
                Parkour.Level = (int)std::lround(std::clamp(Number, 1.0, 3.0));
            if (ReadNumber(Entry, "height", Number))
                Parkour.HeightMeters = std::clamp(Number, -50.0, 300.0);
            // Not set: one tile under you in the air, none on the ground.
            Parkour.PlatformW = Parkour.HeightMeters > 0.0 ? 1 : 0;
            Parkour.PlatformD = Parkour.PlatformW;
            ReadPlatform(Entry, Parkour.PlatformW, Parkour.PlatformD);

            auto Elements = Entry.find("elements");
            if (Elements != Entry.end() && Elements->is_array())
            {
                for (const auto& Item : *Elements)
                {
                    if (Parkour.Elements.size() >= kMaxElements)
                        break;
                    if (!Item.is_object())
                        continue;
                    FElementDef Element;
                    Element.Kind = ReadString(Item, "kind", "");
                    if (Element.Kind.empty() || !ReadVec3(Item, "at", Element.At))
                        continue;
                    ReadPlatform(Item, Element.PlatformW, Element.PlatformD);
                    Parkour.Elements.push_back(Element);
                }
            }

            auto Bots = Entry.find("bots");
            if (Bots != Entry.end() && Bots->is_array())
            {
                for (const auto& Item : *Bots)
                {
                    if (Parkour.Bots.size() >= kMaxBots)
                        break;
                    if (!Item.is_object())
                        continue;
                    FBotDef Bot;
                    if (!ReadVec3(Item, "at", Bot.At))
                        continue;
                    if (ReadNumber(Item, "hp", Number))
                        Bot.Hp = (int)std::lround(std::clamp(Number, 1.0, 500.0));
                    ReadPlatform(Item, Bot.PlatformW, Bot.PlatformD);
                    Parkour.Bots.push_back(Bot);
                }
            }

            Out.Parkours.push_back(Parkour);
        }
        return true;
    }

    // Reads the file. On an error the player gets a clear message and it returns false.
    bool LoadParkours(AFortPlayerControllerAthena* Controller, FParkourFile& Out)
    {
        std::string Text;
        if (!ReadWholeFile(ParkourFilePath(), Text))
        {
            Say(Controller, "The parkour list is missing. Please start the game from the Niobium launcher.");
            return false;
        }
        bool bParsed = false;
        try
        {
            bParsed = ParseParkourFile(Text, Out);
        }
        catch (...)
        {
            bParsed = false;
        }
        if (!bParsed)
        {
            Say(Controller, "The parkour list is broken. Restart the Niobium launcher to write it again.");
            return false;
        }
        if (Out.Parkours.empty())
        {
            Say(Controller, "The parkour list is empty.");
            return false;
        }
        return true;
    }

    std::string JoinIds(const FParkourFile& File)
    {
        std::string Ids;
        for (const auto& Parkour : File.Parkours)
        {
            if (!Ids.empty())
                Ids += ", ";
            Ids += Parkour.Id;
        }
        return Ids;
    }

    // ---------------------------------------------------------------- Commands

    void SayParkourHelp(AFortPlayerControllerAthena* Controller)
    {
        Say(Controller, "How it works: parkour <id> builds a parkour around you.");
        Say(Controller, "parkour retry = back to the start | parkour clear = remove all | "
            "parkour sniper = sniper rifle | parkour list = all ids");
    }

    void SaySniperResult(AFortPlayerControllerAthena* Controller, ESniperResult Result)
    {
        switch (Result)
        {
        case ESniperResult::Given:
            Say(Controller, "A sniper rifle is now in your inventory.");
            break;
        case ESniperResult::AlreadyHad:
            Say(Controller, "You already have a sniper rifle.");
            break;
        case ESniperResult::NotFound:
            Say(Controller, "None of the listed sniper rifles exist in this version.");
            break;
        }
    }

    void DoClear(AFortPlayerControllerAthena* Controller)
    {
        FClearResult Result;
        ClearSet(GParkourSpawned, Result);
        ClearSet(GTargetSpawned, Result);
        GHasStart = false;
        GStartName.clear();
        GHasBase = false;
        if (Result.Objects == 0 && Result.Bots == 0)
        {
            Say(Controller, "Nothing to remove.");
            return;
        }
        Say(Controller, "Removed " + std::to_string(Result.Objects) + " pieces and " +
            std::to_string(Result.Bots) + " target bots.");
    }

    void DoRetry(AFortPlayerControllerAthena* Controller)
    {
        if (!GHasStart)
        {
            Say(Controller, "You haven't built a parkour yet. Pick one first.");
            return;
        }
        auto Pawn = RequirePawn(Controller);
        if (!Pawn)
            return;

        PlacePlayer(Controller, Pawn, GStart, GStartYaw);
        RefillPlayer(Controller, Pawn);

        // Eliminated target bots come back to their spots.
        int Revived = 0;
        for (auto& Slot : GParkourSpawned.Bots)
        {
            if (IsBotStillAlive(Slot))
                continue;
            if (auto BotController = SpawnStillBot(Controller, Slot.Where, Slot.Hp))
            {
                Slot.Controller = TWeakObjectPtr<AFortPlayerControllerAthena>(BotController);
                ++Revived;
            }
        }

        std::string Message = "Back at the start" + (GStartName.empty() ? std::string() : " of " + Quote(GStartName)) +
            ". Full health, weapons reloaded.";
        if (Revived > 0)
            Message += " " + std::to_string(Revived) + (Revived == 1 ? " target bot is" : " target bots are") +
                " back.";
        Say(Controller, Message);
    }

    void DoSniper(AFortPlayerControllerAthena* Controller)
    {
        if (!RequirePawn(Controller))
            return;
        FParkourFile File;
        if (!LoadParkours(Controller, File))
            return;
        SaySniperResult(Controller, GiveSniper(Controller, File.Snipers));
    }

    void DoList(AFortPlayerControllerAthena* Controller)
    {
        FParkourFile File;
        if (!LoadParkours(Controller, File))
            return;
        Say(Controller, "Parkours: " + JoinIds(File));
    }

    void DoBuild(AFortPlayerControllerAthena* Controller, const std::string& Id)
    {
        auto Pawn = RequirePawn(Controller);
        if (!Pawn)
            return;
        FParkourFile File;
        if (!LoadParkours(Controller, File))
            return;

        const FParkourDef* Parkour = nullptr;
        for (const auto& Candidate : File.Parkours)
        {
            if (Candidate.Id == Id)
            {
                Parkour = &Candidate;
                break;
            }
        }
        if (!Parkour)
        {
            Say(Controller, "There is no parkour " + Quote(Id) + ". Pick one of these: " + JoinIds(File));
            return;
        }

        const FVector PawnLocation = Pawn->K2_GetActorLocation();
        FVec3 Ground;
        Ground.X = PawnLocation.X;
        Ground.Y = PawnLocation.Y;
        Ground.Z = PawnLocation.Z - kCapsuleHalfHeightCm;
        if (!std::isfinite(Ground.X) || !std::isfinite(Ground.Y) || !std::isfinite(Ground.Z))
        {
            Say(Controller, "Can't find your position right now. Try again in a moment.");
            return;
        }

        // If you still stand on the old, raised start floor (or fly right above it), the new parkour is
        // built from the old ground height - otherwise parkours would end up a bit higher with every switch.
        // It is still built exactly where you stand (only the height comes from the old ground).
        if (GHasStart && GHasBase)
        {
            const double StartFloorZ = GStart.Z - kStandAboveTileCm;
            const double RaiseCm = StartFloorZ - GBase.Z;
            const double Dx = Ground.X - GStart.X;
            const double Dy = Ground.Y - GStart.Y;
            const double AlongFwd = Dx * GStartAxes.FwdX + Dy * GStartAxes.FwdY;
            const double AlongRight = -Dx * GStartAxes.FwdY + Dy * GStartAxes.FwdX;
            const bool bOverStartFloor = std::fabs(AlongFwd) <= GStartHalfFwdCm + kReuseMarginCm &&
                std::fabs(AlongRight) <= GStartHalfRightCm + kReuseMarginCm;
            const double BelowToleranceCm = RaiseCm * 0.5 < kReuseBelowStartCm ? RaiseCm * 0.5 : kReuseBelowStartCm;
            const bool bAtStartHeight = Ground.Z >= StartFloorZ - BelowToleranceCm;
            if (RaiseCm >= kReuseMinRaiseCm && bOverStartFloor && bAtStartHeight)
                Ground.Z = GBase.Z;
        }

        // Remove the old Niobium parkour first.
        {
            FClearResult Ignored;
            ClearSet(GParkourSpawned, Ignored);
            GHasStart = false;
            GStartName.clear();
            GHasBase = false;
        }

        FVec3 Feet = Ground;
        Feet.Z += Parkour->HeightMeters * 100.0;
        const FAxes Axes = SnappedAxes(GetViewYaw(Controller, Pawn));

        auto FloorClass = Niobium_FindActorClass("woodfloor");
        const bool bNeedsStartFloor = Parkour->PlatformW > 0 && Parkour->PlatformD > 0;
        if (!FloorClass && (bNeedsStartFloor || Parkour->HeightMeters > 0.0))
        {
            Say(Controller, "This version can't build floors, so this parkour doesn't work here.");
            return;
        }

        // 1. Start floor
        int Floors = SpawnFloorGrid(Controller, FloorClass, Feet, Axes, Parkour->PlatformW, Parkour->PlatformD,
            GParkourSpawned);
        if (bNeedsStartFloor && Floors == 0)
        {
            FClearResult Ignored;
            ClearSet(GParkourSpawned, Ignored);
            Say(Controller, "The start floor couldn't be built, so the parkour was cancelled.");
            return;
        }

        // 2. Jump objects
        std::map<std::string, const UClass*> ClassByKind;
        std::vector<std::string> MissingLabels;
        int Objects = 0;
        int FailedObjects = 0;
        for (const auto& Element : Parkour->Elements)
        {
            const std::string KindKey = ToLower(Element.Kind);
            auto KindIt = File.Kinds.find(KindKey);
            const std::string Label = KindIt != File.Kinds.end() ? KindIt->second.Label : Element.Kind;

            auto Cached = ClassByKind.find(KindKey);
            const UClass* Class = nullptr;
            if (Cached != ClassByKind.end())
            {
                Class = Cached->second;
            }
            else
            {
                if (KindIt != File.Kinds.end())
                {
                    for (const auto& Name : KindIt->second.Summon)
                    {
                        if (!Name.empty() && (Class = Niobium_FindActorClass(Name)) != nullptr)
                            break;
                    }
                }
                ClassByKind[KindKey] = Class;
            }

            if (!Class)
            {
                if (std::find(MissingLabels.begin(), MissingLabels.end(), Label) == MissingLabels.end())
                    MissingLabels.push_back(Label);
                continue;
            }

            const FVec3 Where = ShiftMeters(Feet, Axes, Element.At);
            Floors += SpawnFloorGrid(Controller, FloorClass, Where, Axes, Element.PlatformW, Element.PlatformD,
                GParkourSpawned);
            if (auto Actor = SpawnObject(Controller, Class, Where, Axes.Yaw))
            {
                GParkourSpawned.Actors.emplace_back(Actor);
                ++Objects;
            }
            else
            {
                ++FailedObjects;
            }
        }

        // 3. Target bots, each on its own floor
        int Bots = 0;
        int FailedBots = 0;
        for (const auto& BotDef : Parkour->Bots)
        {
            const FVec3 TileCenter = ShiftMeters(Feet, Axes, BotDef.At);
            Floors += SpawnFloorGrid(Controller, FloorClass, TileCenter, Axes, BotDef.PlatformW, BotDef.PlatformD,
                GParkourSpawned);
            FBotSlot Slot;
            Slot.Where = ShiftCm(TileCenter, Axes, 0.0, 0.0, kStandAboveTileCm);
            Slot.Hp = BotDef.Hp;
            if (auto BotController = SpawnStillBot(Controller, Slot.Where, Slot.Hp))
            {
                Slot.Controller = TWeakObjectPtr<AFortPlayerControllerAthena>(BotController);
                ++Bots;
            }
            else
            {
                ++FailedBots;
            }
            // Remember it even without a bot: "parkour retry" tries again then.
            GParkourSpawned.Bots.push_back(Slot);
        }

        // 4. Player onto the start, facing forward
        const FVec3 Start = ShiftCm(Feet, Axes, 0.0, 0.0, kStandAboveTileCm);
        Pawn = Controller->Pawn;
        if (IsLive(Pawn))
            PlacePlayer(Controller, Pawn, Start, Axes.Yaw);
        GHasStart = true;
        GStart = Start;
        GStartYaw = Axes.Yaw;
        GStartName = Parkour->Name;
        GHasBase = true;
        GBase = Ground;
        GStartAxes = Axes;
        GStartHalfFwdCm = Parkour->PlatformD * kTileCm * 0.5;
        GStartHalfRightCm = Parkour->PlatformW * kTileCm * 0.5;

        Say(Controller, Quote(Parkour->Name) + " is ready! Built: " + std::to_string(Floors) + " floors, " +
            std::to_string(Objects) + " jump objects, " + std::to_string(Bots) + " target bots.");
        if (!MissingLabels.empty())
        {
            std::string Missing;
            for (const auto& Label : MissingLabels)
            {
                if (!Missing.empty())
                    Missing += ", ";
                Missing += Label;
            }
            Say(Controller, "Not in this version (left out): " + Missing + ".");
        }
        if (FailedObjects > 0)
            Say(Controller, std::to_string(FailedObjects) + " jump objects couldn't be placed.");
        if (FailedBots > 0)
            Say(Controller, std::to_string(FailedBots) + " target bots couldn't spawn.");

        if (IsLive(Controller->Pawn))
            SaySniperResult(Controller, GiveSniper(Controller, File.Snipers));
        Say(Controller, "Again: parkour retry | Remove all: parkour clear");

        SDK::DbgLog("[Niobium] parkour %s built: floors=%d objects=%d bots=%d missingKinds=%d\n", Parkour->Id.c_str(),
            Floors, Objects, Bots, (int)MissingLabels.size());
    }

    bool ParseOptionalNumber(const std::vector<std::string>& Args, size_t Index, double Default, double& Out)
    {
        Out = Default;
        if (Index >= Args.size())
            return true;
        const std::string& Text = Args[Index];
        char* End = nullptr;
        const double Value = std::strtod(Text.c_str(), &End);
        if (End == Text.c_str() || (End && *End != '\0') || !std::isfinite(Value))
            return false;
        Out = Value;
        return true;
    }

    void DoTargetBot(AFortPlayerControllerAthena* Controller, const std::vector<std::string>& Args)
    {
        double HpValue = 50.0;
        double Meters = 30.0;
        if (!ParseOptionalNumber(Args, 0, 50.0, HpValue) || !ParseOptionalNumber(Args, 1, 30.0, Meters))
        {
            Say(Controller, "Type it like this: targetbot 50 30 (health, metres in front of you).");
            return;
        }
        const int Hp = (int)std::lround(std::clamp(HpValue, 1.0, 500.0));
        Meters = std::clamp(Meters, 5.0, 200.0);

        auto Pawn = RequirePawn(Controller);
        if (!Pawn)
            return;

        const FVector PawnLocation = Pawn->K2_GetActorLocation();
        FVec3 Feet;
        Feet.X = PawnLocation.X;
        Feet.Y = PawnLocation.Y;
        Feet.Z = PawnLocation.Z - kCapsuleHalfHeightCm;
        if (!std::isfinite(Feet.X) || !std::isfinite(Feet.Y) || !std::isfinite(Feet.Z))
        {
            Say(Controller, "Can't find your position right now. Try again in a moment.");
            return;
        }

        // Direction: exactly your view direction. The floor lies straight in the 90-degree grid.
        const double Yaw = GetViewYaw(Controller, Pawn);
        const double Radians = Yaw * 3.14159265358979323846 / 180.0;
        FAxes Exact;
        Exact.Yaw = Yaw;
        Exact.FwdX = std::cos(Radians);
        Exact.FwdY = std::sin(Radians);
        const FVec3 TileCenter = ShiftCm(Feet, Exact, Meters * 100.0, 0.0, 0.0);

        auto FloorClass = Niobium_FindActorClass("woodfloor");
        const int Floors = SpawnFloorGrid(Controller, FloorClass, TileCenter, SnappedAxes(Yaw), 1, 1, GTargetSpawned);

        FBotSlot Slot;
        Slot.Where = ShiftCm(TileCenter, Exact, 0.0, 0.0, kStandAboveTileCm);
        Slot.Hp = Hp;
        auto BotController = SpawnStillBot(Controller, Slot.Where, Hp);
        if (!BotController)
        {
            Say(Controller, "The target bot couldn't spawn.");
            return;
        }
        Slot.Controller = TWeakObjectPtr<AFortPlayerControllerAthena>(BotController);
        GTargetSpawned.Bots.push_back(Slot);

        Say(Controller, "Target bot is " + std::to_string((int)std::lround(Meters)) + " m in front of you (" +
            std::to_string(Hp) + " health)." + (Floors == 0 ? " No floor, this version can't build one." : "") +
            " Remove it: parkour clear");
    }

    // ---------------------------------------------------------------- Trickshot

    bool IsAirborne(AFortPlayerPawnAthena* Pawn)
    {
        if (Pawn->HasbIsSkydiving() && Pawn->bIsSkydiving)
            return true;
        if (Pawn->HasbIsSkydivingFromBus() && Pawn->bIsSkydivingFromBus)
            return true;
        auto Movement = Pawn->HasCharacterMovement() ? Pawn->CharacterMovement : nullptr;
        if (!Movement)
            return false;
        // UCharacterMovementComponent::IsFalling: MovementMode == MOVE_Falling.
        return Movement->GetFunction("IsFalling") && Movement->IsFalling();
    }

    UNetConnection* FindConnection(AFortPlayerStateAthena* PlayerState)
    {
        auto World = UWorld::GetWorld();
        auto Driver = World ? (UNetDriver*)World->NetDriver : nullptr;
        if (!Driver || !PlayerState)
            return nullptr;
        for (auto Connection : Driver->ClientConnections)
        {
            if (Connection && Connection->PlayerController && Connection->PlayerController->PlayerState == PlayerState)
                return Connection;
        }
        return nullptr;
    }

    void SayToEveryone(const std::wstring& Wide)
    {
        auto World = UWorld::GetWorld();
        auto Driver = World ? (UNetDriver*)World->NetDriver : nullptr;
        if (!Driver)
            return;
        for (auto Connection : Driver->ClientConnections)
        {
            if (Connection && Connection->PlayerController)
                Connection->PlayerController->ClientMessage(FString(Wide.c_str()), FName(), 1.f);
        }
    }

    void DetectTrickshot(AFortPlayerControllerAthena* VictimController, AFortPlayerStateAthena* VictimState,
        AFortPlayerPawnAthena* VictimPawn, AFortPlayerControllerAthena* KillerController,
        AFortPlayerStateAthena* KillerState, AFortPlayerPawnAthena* KillerPawn)
    {
        if (!IsLive(KillerState) || !IsLive(KillerPawn) || KillerState == VictimState)
            return;
        if (VictimPawn && VictimPawn == KillerPawn)
            return;
        // Real players only: no bot PlayerState, no "bot" controller, a real connection.
        if (KillerState->HasbIsABot() && KillerState->bIsABot)
            return;
        if (KillerController && AFortPlayerControllerAthena::IsCheatSpawnedBotController(KillerController))
            return;
        auto KillerConnection = FindConnection(KillerState);
        if (!KillerConnection)
            return;
        if (!IsAirborne(KillerPawn))
            return;

        // Report the same elimination only once.
        const void* VictimKey = VictimPawn ? (const void*)VictimPawn : (const void*)VictimController;
        const ULONGLONG Now = GetTickCount64();
        if (VictimKey == GLastTrickshotVictim && Now - GLastTrickshotMs < kTrickshotRepeatMs)
            return;
        GLastTrickshotVictim = VictimKey;
        GLastTrickshotMs = Now;

        int Meters = 0;
        if (IsLive(VictimPawn))
        {
            const float DistanceCm = KillerPawn->GetDistanceTo(VictimPawn);
            if (std::isfinite(DistanceCm) && DistanceCm > 0.f)
                Meters = (int)std::lround(DistanceCm / 100.0);
        }

        std::string KillerName = GUI::GetPlayerNameGameThread(KillerState, KillerConnection);
        if (KillerName.empty())
            KillerName = "Someone";
        std::string VictimName = IsLive(VictimState)
            ? GUI::GetPlayerNameGameThread(VictimState, FindConnection(VictimState)) : std::string();
        if (VictimName.empty())
            VictimName = "Opponent";

        // "[Niobium] TRICKSHOT! <killer> \u2013 <metres> m" (en dash). The F9 menu shows its banner for
        // messages that start with L"[Niobium] TRICKSHOT".
        SayToEveryone(L"[Niobium] TRICKSHOT! " + Widen(KillerName) + L" \u2013 " + std::to_wstring(Meters) + L" m");
        NiobiumControl::EmitTrickshot(KillerName, VictimName, Meters);
        SDK::DbgLog("[Niobium] Trickshot: %s -> %s (%d m)\n", KillerName.c_str(), VictimName.c_str(), Meters);
    }
}

// ---------------------------------------------------------------- public

namespace NiobiumParkour
{
    void HandleParkourCommand(AFortPlayerControllerAthena* PlayerController,
        const std::vector<std::string>& Args) noexcept
    {
        if (!PlayerController)
            return;
        try
        {
            EnsureTrackedWorld();

            std::vector<std::string> Words;
            for (const auto& Arg : Args)
            {
                if (!Arg.empty())
                    Words.push_back(ToLower(Arg));
            }

            if (Words.empty())
            {
                SayParkourHelp(PlayerController);
                return;
            }

            const std::string& Action = Words[0];
            if (Action == "retry")
                DoRetry(PlayerController);
            else if (Action == "clear")
                DoClear(PlayerController);
            else if (Action == "sniper")
                DoSniper(PlayerController);
            else if (Action == "list")
                DoList(PlayerController);
            else
                DoBuild(PlayerController, Action);
        }
        catch (...)
        {
            SDK::DbgLog("[Niobium] parkour: caught an unexpected error\n");
            Say(PlayerController, "Something went wrong. Please try again.");
        }
    }

    void HandleTargetBotCommand(AFortPlayerControllerAthena* PlayerController,
        const std::vector<std::string>& Args) noexcept
    {
        if (!PlayerController)
            return;
        try
        {
            EnsureTrackedWorld();

            std::vector<std::string> Words;
            for (const auto& Arg : Args)
            {
                if (!Arg.empty())
                    Words.push_back(Arg);
            }
            DoTargetBot(PlayerController, Words);
        }
        catch (...)
        {
            SDK::DbgLog("[Niobium] targetbot: caught an unexpected error\n");
            Say(PlayerController, "Something went wrong. Please try again.");
        }
    }

    void OnElimination(AFortPlayerControllerAthena* VictimController, AFortPlayerStateAthena* VictimState,
        AFortPlayerPawnAthena* VictimPawn, AFortPlayerControllerAthena* KillerController,
        AFortPlayerStateAthena* KillerState, AFortPlayerPawnAthena* KillerPawn) noexcept
    {
        if (!FConfiguration::bNiobiumTrickshotDetection.load(std::memory_order_acquire))
            return;
        try
        {
            DetectTrickshot(VictimController, VictimState, VictimPawn, KillerController, KillerState, KillerPawn);
        }
        catch (...)
        {
            SDK::DbgLog("[Niobium] Trickshot detection: caught an unexpected error\n");
        }
    }
}
