// NIOBIUM: the "19.10 AI base" (see FortniteGame/Public/AIBase_19_10.h). Rift is GPL-3.0.
//
// Where the parts come from:
//   - CheckBuild, the nav hook (CreateAndConfigureNavSystemDetour) and the GetLoadout hook
//     (GetLoadoutDetour, default outfits) were ported from NotTacs/Artemis
//     (https://github.com/NotTacs/Artemis, GPL-3.0, commit 48dba08) in PlayerBots_19_10.cpp:
//       FortniteAI/.../AthenaNavSystem.cpp:5-14  -> CreateAndConfigureNavSystemDetour, kRva below
//       FortniteAI/.../FortAthenaAISpawnerDataComponent_AIBotCosmeticBase.cpp:5-15 -> GetLoadoutDetour
//     and moved here so Living world can use them without the bots. Rift's change: AI
//     characters and bosses whose cosmetic component is a CosmeticLoadout keep their own outfit
//     (its reflected CosmeticLoadout is copied into empty fields); the default outfits are only for
//     the AI player bots ("Phoebe").
//   - The brain flag lookup follows the idea of Jeremy1926/Velora (MIT), commit 9674d54,
//     Velora/FortniteGame/Source/FortniteGame/Private/Athena/FortServerBotManagerAthena.cpp:146-183
//     (Exec RunBehaviorTree -> "call [rax+0x*]" slot -> the AI bot controller's entry -> the
//     "mov *, [rcx+field]; test; jz; cmp *[*+flag], *" pattern). Written fresh for MinHook's
//     hde64 length disassembler (BSD-2, built from source in native/minhook); no Velora code.
// THIRD_PARTY_NOTICES.md: Artemis is listed already (its row must name this file too); Velora's row
// must add this brain flag method (commit 9674d54).
#include "pch.h"
#include "../Public/AIBase_19_10.h"
#include "../Public/AIBase.h"
#include <algorithm>
#include <atomic>
#include <climits>
#include <cmath>
#include <string>
#include <unordered_set>
#include <vector>

#include "../../../third_party/minhook/src/hde/hde64.h"

namespace
{
    using AIBase::CheckFunctionStart;
    using AIBase::CheckLayout;
    using AIBase::FImage;
    using AIBase::Hex;
    using AIBase::IsLiveObject;
    using AIBase::OffsetOf;
    using AIBase::ReadGameImage;

    constexpr double kFortniteVersion = 19.10;
    constexpr uint64_t kChangelist = 18675304;
    // FortniteGame/Binaries/Win64/FortniteClient-Win64-Shipping.exe in Epic's manifest of
    // "++Fortnite+Release-19.10-CL-18675304-Windows" (file SHA-1 e0f0f1fb94edc2268f2a2ada17e4b0d9f120d59c).
    constexpr uint64_t kShippingExeSize = 198580704ull;

    // Artemis 48dba08 (see the top of this file).
    namespace kRva
    {
        constexpr uint32_t CreateAndConfigureNavSystem = 0x1F96F68; // AthenaNavSystem.cpp:13
        constexpr uint32_t AIBotCosmeticGetLoadout = 0x6A41DE4;     // ..._AIBotCosmeticBase.cpp:14
    }

    using FCreateAndConfigureNavSystem = void* (*)(UObject* Config, UObject* World);
    using FGetLoadout = void (*)(UObject* Component, void* OutLoadout);

    FCreateAndConfigureNavSystem GCreateAndConfigureNavSystemOG = nullptr;
    FGetLoadout GGetLoadoutOG = nullptr;

    enum class EBase : int
    {
        Undecided = 0,
        Ready = 1,
        Failed = 2,
    };

    std::atomic<int> GBase{ (int)EBase::Undecided };
    std::string GBaseWhy; // written once in the hook phase
    std::atomic<uint32_t> GUsers{ 0 };

    struct FBaseLayout
    {
        int32 LoadoutCharacter = -1;
        int32 NavConfigAutoSpawnByte = -1;
        uint8 NavConfigAutoSpawnMask = 0;
        const UClass* NavConfigClass = nullptr;
        // GetLoadout: the CosmeticLoadout component and the object fields of FFortAthenaLoadout.
        const UClass* CosmeticLoadoutClass = nullptr;
        int32 ComponentLoadout = -1;
        int32 LoadoutSize = 0;
        std::vector<int32> LoadoutObjectFields;
    };

    FBaseLayout GLayout;

    bool UsersAny()
    {
        return GBase.load(std::memory_order_acquire) == (int)EBase::Ready &&
            GUsers.load(std::memory_order_acquire) != 0;
    }

    // ------------------------------------------------------------------ Checks

    bool CheckBaseLayouts(std::string& Why)
    {
        auto& L = GLayout;
        L.NavConfigClass = FindClass("NavigationSystemModuleConfig");

        // Loadout.Character (GetLoadout) and the nav config bit (CreateAndConfigureNavSystem), from
        // Artemis' 19.10 dump; unchanged from the bot gate.
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

        // Optional (reflection only): the CosmeticLoadout component's own loadout. Without it AI
        // characters simply keep what the game gave them.
        auto LoadoutStruct = FindStruct("FortAthenaLoadout");
        L.CosmeticLoadoutClass = FindClass("FortAthenaAISpawnerDataComponent_CosmeticLoadout");
        L.ComponentLoadout = OffsetOf(L.CosmeticLoadoutClass, "CosmeticLoadout");
        L.LoadoutSize = LoadoutStruct ? LoadoutStruct->GetPropertiesSize() : 0;
        if (LoadoutStruct && VersionInfo.FortniteVersion >= 12.10)
        {
            int Guard = 0;
            for (auto Property = LoadoutStruct->GetChildProperties(); Property && Guard++ < 256;
                 Property = Property->FField_GetNext())
            {
                const uint64_t Flags = AIBase::PropertyCastFlags(Property);
                const int32 Offset = AIBase::PropertyOffset(Property);
                const int32 Size = GetFromOffset<int32>(Property, Offsets::ElementSize);
                // Plain object pointers only (outfit, back bling, pickaxe, glider, ...); no arrays
                // or strings, so nothing is shared between the two loadouts.
                if ((Flags & AIBase::ECastFlags::ObjectProperty) &&
                    !(Flags & (AIBase::ECastFlags::ArrayProperty | AIBase::ECastFlags::StructProperty)) &&
                    Size == 8 && Offset >= 0 && Offset + 8 <= L.LoadoutSize)
                {
                    L.LoadoutObjectFields.push_back(Offset);
                }
            }
        }
        if (!L.CosmeticLoadoutClass || L.ComponentLoadout < 0 || L.LoadoutObjectFields.empty())
        {
            AIBase::Logf("AIBase", "19.10: AI characters keep the outfit the game gives them (no "
                "CosmeticLoadout copy: %s)", !L.CosmeticLoadoutClass ? "no CosmeticLoadout component class"
                : L.ComponentLoadout < 0 ? "no CosmeticLoadout field" : "no loadout object fields");
            L.CosmeticLoadoutClass = nullptr;
        }
        return true;
    }

    bool CheckBaseCode(std::string& Why)
    {
        FImage Image;
        if (!ReadGameImage(Image, Why))
            return false;
        if (!CheckFunctionStart(Image, kRva::CreateAndConfigureNavSystem, "CreateAndConfigureNavSystem", Why))
            return false;
        // The game's GetLoadout may be a small stub with no unwind entry (Artemis never calls it).
        return CheckFunctionStart(Image, kRva::AIBotCosmeticGetLoadout, "GetLoadout", Why, true);
    }

    // ------------------------------------------------------------------ Hooks

    // Artemis AthenaNavSystem.cpp:5-9: let the navigation system create the missing nav data the
    // client build doesn't load, so AI can walk. The original returns the nav system.
    void* CreateAndConfigureNavSystemDetour(UObject* Config, UObject* World)
    {
        if (UsersAny() && IsLiveObject(Config) && Config->IsA(GLayout.NavConfigClass))
            GetFromOffset<uint8>(Config, GLayout.NavConfigAutoSpawnByte) |= GLayout.NavConfigAutoSpawnMask;
        return GCreateAndConfigureNavSystemOG(Config, World);
    }

    // A CosmeticLoadout component (bosses, guards, characters) gives its own outfit: its reflected
    // CosmeticLoadout fills the object fields the game left empty. Plain pointer copies only.
    void FillFromComponentLoadout(const UObject* Component, uint8* OutLoadout)
    {
        const auto& L = GLayout;
        const uint8* Source = reinterpret_cast<const uint8*>(Component) + L.ComponentLoadout;
        int32 Copied = 0;
        for (const int32 Offset : L.LoadoutObjectFields)
        {
            auto& Target = *reinterpret_cast<const UObject**>(OutLoadout + Offset);
            auto Value = *reinterpret_cast<const UObject* const*>(Source + Offset);
            if (!Target && Value && IsLiveObject(Value))
            {
                Target = Value;
                ++Copied;
            }
        }
        static int32 Logged = 0;
        if (Copied > 0 && Logged < 5)
        {
            ++Logged;
            auto Character = *reinterpret_cast<const UObject* const*>(OutLoadout + L.LoadoutCharacter);
            AIBase::Logf("AIBase", "19.10: an AI kept its own outfit %s (%d field(s) from its CosmeticLoadout)",
                Character && IsLiveObject(Character) ? Character->Name.ToString().c_str() : "none", Copied);
        }
    }

    // Artemis FortAthenaAISpawnerDataComponent_AIBotCosmeticBase.cpp:5-11, which replaces the
    // native version. Rift calls the game's version first. Then:
    //   - a CosmeticLoadout component (AI characters, bosses) fills what the game left empty from
    //     its own CosmeticLoadout, so they keep their own outfit;
    //   - only while the AI player bots run, an AI still without an outfit gets one of the default
    //     outfits, as before (Living world alone never hands out default outfits);
    //   - otherwise the loadout is untouched.
    void GetLoadoutDetour(UObject* Component, void* OutLoadout)
    {
        GGetLoadoutOG(Component, OutLoadout);
        if (!OutLoadout || !UsersAny() || !IsLiveObject(Component))
            return;
        if (GLayout.CosmeticLoadoutClass && Component->IsA(GLayout.CosmeticLoadoutClass))
            FillFromComponentLoadout(Component, static_cast<uint8*>(OutLoadout));
        if (!AIBase1910::IsUsedBy(AIBase1910::UserPlayerBots))
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
            AIBase::Logf("PlayerBots", "%d default outfits for bots", (int)Characters.size());
        }
        auto& Character = GetFromOffset<const UObject*>(OutLoadout, GLayout.LoadoutCharacter);
        if (!Character && !Characters.empty())
            Character = Characters[(size_t)rand() % Characters.size()];
    }

    bool InstallBaseHooks(std::string& Why)
    {
        struct FHook
        {
            uint32_t Rva;
            void* Detour;
            void** Original;
            const char* Name;
        };
        const FHook Hooks[] = {
            { kRva::CreateAndConfigureNavSystem, reinterpret_cast<void*>(CreateAndConfigureNavSystemDetour),
                reinterpret_cast<void**>(&GCreateAndConfigureNavSystemOG), "CreateAndConfigureNavSystem" },
            { kRva::AIBotCosmeticGetLoadout, reinterpret_cast<void*>(GetLoadoutDetour),
                reinterpret_cast<void**>(&GGetLoadoutOG), "GetLoadout" },
        };

        std::vector<LPVOID> Created;
        for (const auto& Hook : Hooks)
        {
            const auto Target = reinterpret_cast<LPVOID>(ImageBase + Hook.Rva);
            const MH_STATUS Status = MH_CreateHook(Target, Hook.Detour, Hook.Original);
            if (Status != MH_OK || !*Hook.Original)
            {
                Why = std::string("hooking ") + Hook.Name + " failed (" + MH_StatusToString(Status) + ")";
                if (Status == MH_OK)
                    MH_RemoveHook(Target);
                for (auto Done : Created)
                    MH_RemoveHook(Done);
                return false;
            }
            Created.push_back(Target);
        }
        // Main() enables every created hook with MH_EnableHook(MH_ALL_HOOKS) after the hook phase.
        return true;
    }

    // ------------------------------------------------------------------ Brain flag

    struct FBrainFlagState
    {
        std::atomic<int> State{ (int)AIBase1910::EBrainFlag::Unknown };
        bool bTried = false;
        std::string Reason = "not resolved";
        int32 FieldOffset = -1;
        int32 FlagOffset = -1;
        const UClass* OwnerClass = nullptr;
        std::string FieldName;
        std::unordered_set<uint64> SetOwners; // objects whose flag we set (index << 32 | serial)
    };

    FBrainFlagState GBrain;

    uint32_t DecodeOne(const FImage& Image, uint32_t Rva, uint32_t End, hde64s& Out)
    {
        if (Rva >= End || (End - Rva < 15 && !SDK::MemReadable(Image.Base + Rva, 15)))
            return 0;
        const uint32_t Length = hde64_disasm(Image.Base + Rva, &Out);
        if (!Length || (Out.flags & F_ERROR) || Rva + Length > End)
            return 0;
        return Length;
    }

    int32 Displacement(const hde64s& I)
    {
        if (I.modrm_mod == 1 && (I.flags & F_DISP8))
            return (int32)(int8_t)I.disp.disp8;
        if (I.modrm_mod == 2 && (I.flags & F_DISP32))
            return (int32)I.disp.disp32;
        return INT32_MIN;
    }

    // [reg+disp] memory operand without SIB: the 0-15 base register, or -1.
    int BaseRegister(const hde64s& I)
    {
        if ((I.modrm_mod != 1 && I.modrm_mod != 2) || I.modrm_rm == 4)
            return -1;
        return I.modrm_rm | (I.rex_b ? 8 : 0);
    }

    // The range [Begin, End) of a function: its unwind entry, or (for a leaf without one) at most
    // Max bytes up to the first ret.
    bool CodeRange(const FImage& Image, uint32_t Rva, uint32_t Max, uint32_t& Begin, uint32_t& End)
    {
        if (AIBase::FunctionRange(Image, Rva, Begin, End))
        {
            if (End - Begin > Max)
                End = Begin + Max;
            return true;
        }
        return false;
    }

    // The vtable slot of the virtual the exec thunk calls: every "call [reg+disp]" in it must use
    // the same displacement.
    bool FindThunkVirtualSlot(const FImage& Image, uint32_t ThunkRva, int32& OutSlot, std::string& Why)
    {
        uint32_t Begin = 0;
        uint32_t End = 0;
        if (!CodeRange(Image, ThunkRva, 0x400, Begin, End))
        {
            Why = "the RunBehaviorTree exec (" + Hex(ThunkRva) + ") has no function range";
            return false;
        }
        int32 Found = INT32_MIN;
        int32 Calls = 0;
        for (uint32_t Rva = Begin; Rva < End;)
        {
            hde64s I;
            const uint32_t Length = DecodeOne(Image, Rva, End, I);
            if (!Length)
            {
                Why = "the RunBehaviorTree exec can't be decoded at " + Hex(Rva);
                return false;
            }
            if (I.opcode == 0xFF && I.modrm_reg == 2 && BaseRegister(I) >= 0 && BaseRegister(I) != 4 &&
                !I.p_66 && !I.p_67)
            {
                const int32 Disp = Displacement(I);
                if (Disp == INT32_MIN || Disp < 0 || (Disp % 8) != 0 || Disp / 8 >= 2048)
                {
                    Why = "the RunBehaviorTree exec makes an indirect call at " + Hex(Rva) + " that is no vtable call";
                    return false;
                }
                if (Found != INT32_MIN && Found != Disp)
                {
                    Why = "the RunBehaviorTree exec calls two different virtuals";
                    return false;
                }
                Found = Disp;
                ++Calls;
            }
            Rva += Length;
        }
        if (Found == INT32_MIN)
        {
            Why = "the RunBehaviorTree exec makes no virtual call";
            return false;
        }
        OutSlot = Found / 8;
        return true;
    }

    struct FBrainPattern
    {
        uint32_t Rva = 0;
        int32 FieldOffset = -1;
        int32 FlagOffset = -1;
    };

    // "mov r64, [this+field]; test r64, r64; jz; cmp byte ptr [r64+flag], r8|imm8" in the override.
    // "this" is rcx at the start, or a register rcx was copied to.
    void ScanBrainPattern(const FImage& Image, uint32_t Begin, uint32_t End,
        const std::vector<int32>& Fields, std::vector<FBrainPattern>& Out)
    {
        uint32_t ThisRegisters = 1u << 1; // rcx
        hde64s Window[4] = {};
        uint32_t WindowRva[4] = {};
        int32 Filled = 0;
        for (uint32_t Rva = Begin; Rva < End;)
        {
            hde64s I;
            const uint32_t Length = DecodeOne(Image, Rva, End, I);
            if (!Length)
            {
                Filled = 0;
                ++Rva;
                continue;
            }
            // mov r64, rcx (8B /r mod 3 rm=rcx) or mov r/m64, rcx (89 /r mod 3 reg=rcx).
            if (I.rex_w && I.modrm_mod == 3)
            {
                if (I.opcode == 0x8B && (I.modrm_rm | (I.rex_b ? 8 : 0)) == 1)
                    ThisRegisters |= 1u << (I.modrm_reg | (I.rex_r ? 8 : 0));
                else if (I.opcode == 0x89 && (I.modrm_reg | (I.rex_r ? 8 : 0)) == 1)
                    ThisRegisters |= 1u << (I.modrm_rm | (I.rex_b ? 8 : 0));
            }

            if (Filled == 4)
            {
                for (int32 Index = 0; Index < 3; ++Index)
                {
                    Window[Index] = Window[Index + 1];
                    WindowRva[Index] = WindowRva[Index + 1];
                }
                Filled = 3;
            }
            Window[Filled] = I;
            WindowRva[Filled] = Rva;
            ++Filled;

            if (Filled == 4)
            {
                const hde64s& Mov = Window[0];
                const hde64s& Test = Window[1];
                const hde64s& Jz = Window[2];
                const hde64s& Cmp = Window[3];
                const int MovBase = BaseRegister(Mov);
                const int Dest = Mov.modrm_reg | (Mov.rex_r ? 8 : 0);
                const int32 Field = Displacement(Mov);
                const bool bMov = Mov.opcode == 0x8B && Mov.rex_w && !Mov.p_66 && !Mov.p_67 &&
                    MovBase >= 0 && (ThisRegisters & (1u << MovBase)) &&
                    std::find(Fields.begin(), Fields.end(), Field) != Fields.end();
                const bool bTest = Test.opcode == 0x85 && Test.rex_w && Test.modrm_mod == 3 &&
                    (Test.modrm_reg | (Test.rex_r ? 8 : 0)) == Dest &&
                    (Test.modrm_rm | (Test.rex_b ? 8 : 0)) == Dest;
                const bool bJz = Jz.opcode == 0x74 || (Jz.opcode == 0x0F && Jz.opcode2 == 0x84);
                const int CmpBase = BaseRegister(Cmp);
                const bool bCmp = CmpBase == Dest && !Cmp.p_66 && !Cmp.p_67 &&
                    (Cmp.opcode == 0x38 || Cmp.opcode == 0x3A ||
                        (Cmp.opcode == 0x80 && Cmp.modrm_reg == 7));
                const int32 Flag = bCmp ? Displacement(Cmp) : INT32_MIN;
                if (bMov && bTest && bJz && bCmp && Flag > 0)
                {
                    Out.push_back(FBrainPattern{ WindowRva[0], Field, Flag });
                    if (Out.size() > 8)
                        return;
                }
            }
            Rva += Length;
        }
    }

    // A reflected property of the class chain that covers [Offset, Offset + 1).
    bool IsReflectedByte(const UStruct* Struct, int32 Offset)
    {
        int SuperGuard = 0;
        for (auto Current = Struct; Current && SuperGuard++ < 64; Current = Current->GetSuper())
        {
            int Guard = 0;
            for (auto Property = Current->GetChildProperties(); Property && Guard++ < 4096;
                 Property = Property->FField_GetNext())
            {
                const int32 Start = AIBase::PropertyOffset(Property);
                const int32 Size = GetFromOffset<int32>(Property, Offsets::ElementSize);
                if (Start >= 0 && Size > 0 && Offset >= Start && Offset < Start + Size)
                    return true;
            }
        }
        return false;
    }

    void ResolveBrainFlagUnsafe(void*)
    {
        auto& B = GBrain;
        std::string Why;
        FImage Image;
        if (!ReadGameImage(Image, Why))
        {
            B.Reason = Why;
            B.State.store((int)AIBase1910::EBrainFlag::NotFound, std::memory_order_release);
            return;
        }

        auto AIControllerClass = FindClass("AIController");
        auto BotControllerClass = FindClass("FortAthenaAIBotController");
        auto AIControllerDefault = AIControllerClass ? AIControllerClass->GetDefaultObj() : nullptr;
        auto BotDefault = BotControllerClass ? BotControllerClass->GetDefaultObj() : nullptr;
        auto Function = IsLiveObject(AIControllerDefault) ? AIControllerDefault->GetFunction("RunBehaviorTree")
            : nullptr;
        auto fail = [&](const std::string& Reason)
        {
            B.Reason = Reason;
            B.State.store((int)AIBase1910::EBrainFlag::NotFound, std::memory_order_release);
        };
        if (!Function || !IsLiveObject(BotDefault))
            return fail(!Function ? "AIController:RunBehaviorTree is missing" : "Default__FortAthenaAIBotController is missing");

        uint32_t ThunkRva = 0;
        if (!AIBase::RvaOf(Image, Function->GetNativeFunc(), ThunkRva) || !AIBase::IsCode(Image, ThunkRva, 16))
            return fail("the RunBehaviorTree exec is not in the game's code");
        int32 Slot = -1;
        if (!FindThunkVirtualSlot(Image, ThunkRva, Slot, Why))
            return fail(Why);

        void** BotTable = BotDefault->Vft;
        void** BaseTable = AIControllerDefault->Vft;
        if (!SDK::MemReadable(&BotTable[Slot], sizeof(void*)) || !SDK::MemReadable(&BaseTable[Slot], sizeof(void*)))
            return fail("vtable slot " + std::to_string(Slot) + " can't be read");
        uint32_t OverrideRva = 0;
        uint32_t BaseRva = 0;
        if (!AIBase::RvaOf(Image, BotTable[Slot], OverrideRva) || !AIBase::RvaOf(Image, BaseTable[Slot], BaseRva))
            return fail("vtable slot " + std::to_string(Slot) + " points outside the game");
        if (OverrideRva == BaseRva)
        {
            B.Reason = "FortAthenaAIBotController doesn't override RunBehaviorTree (slot " +
                std::to_string(Slot) + "): brains have no start gate";
            B.State.store((int)AIBase1910::EBrainFlag::NotNeeded, std::memory_order_release);
            return;
        }
        if (!CheckFunctionStart(Image, OverrideRva, "RunBehaviorTree of the AI bot controller", Why))
            return fail(Why);
        uint32_t Begin = 0;
        uint32_t End = 0;
        if (!CodeRange(Image, OverrideRva, 0x2000, Begin, End))
            return fail("RunBehaviorTree of the AI bot controller has no function range");

        // The bot-manager field the flag lives on (Velora: CachedBotManager; 18.00+ the player bot
        // service took that role).
        struct FCandidate
        {
            const char* Field;
            const char* OwnerClass;
        };
        const FCandidate Candidates[] = {
            { "CachedBotManager", "FortServerBotManagerAthena" },
            { "CachedAIServicePlayerBots", "AthenaAIServicePlayerBots" },
        };
        std::vector<int32> Fields;
        for (const auto& Candidate : Candidates)
        {
            const int32 Offset = OffsetOf(BotControllerClass, Candidate.Field);
            if (Offset > 0)
                Fields.push_back(Offset);
        }
        if (Fields.empty())
            return fail("the AI bot controller has no CachedBotManager / CachedAIServicePlayerBots field");

        std::vector<FBrainPattern> Matches;
        ScanBrainPattern(Image, Begin, End, Fields, Matches);
        if (Matches.size() != 1)
        {
            return fail("RunBehaviorTree of the AI bot controller (" + Hex(OverrideRva) + ") has " +
                std::to_string(Matches.size()) + " places of the brain gate pattern, exactly one is needed");
        }
        const auto& Match = Matches[0];
        const FCandidate* Owner = nullptr;
        for (const auto& Candidate : Candidates)
        {
            if (OffsetOf(BotControllerClass, Candidate.Field) == Match.FieldOffset)
                Owner = &Candidate;
        }
        auto OwnerClass = Owner ? FindClass(Owner->OwnerClass) : nullptr;
        if (!Owner || !OwnerClass)
            return fail("the brain gate reads a field whose class is missing");
        const int32 OwnerSize = OwnerClass->GetPropertiesSize();
        if (Match.FlagOffset <= 0x28 || Match.FlagOffset >= OwnerSize)
        {
            return fail(std::string("the brain flag ") + Hex(Match.FlagOffset) + " is outside " +
                Owner->OwnerClass + " (" + Hex(OwnerSize) + " bytes)");
        }
        if (IsReflectedByte(OwnerClass, Match.FlagOffset))
        {
            return fail(std::string("the brain flag ") + Hex(Match.FlagOffset) + " overlaps a reflected field of " +
                Owner->OwnerClass);
        }
        auto OwnerDefault = OwnerClass->GetDefaultObj();
        if (!IsLiveObject(OwnerDefault))
            return fail(std::string("Default__") + Owner->OwnerClass + " is missing");
        const uint8 DefaultValue = GetFromOffset<uint8>(OwnerDefault, Match.FlagOffset);
        if (DefaultValue > 1)
        {
            return fail(std::string("the brain flag ") + Hex(Match.FlagOffset) + " holds " +
                std::to_string(DefaultValue) + " in Default__" + Owner->OwnerClass + ", not a bool");
        }

        B.FieldOffset = Match.FieldOffset;
        B.FlagOffset = Match.FlagOffset;
        B.OwnerClass = OwnerClass;
        B.FieldName = Owner->Field;
        B.Reason = std::string(Owner->OwnerClass) + "+" + Hex(Match.FlagOffset) + " (read through " +
            Owner->Field + " at " + Hex(Match.FieldOffset) + ", RunBehaviorTree " + Hex(OverrideRva) +
            " slot " + std::to_string(Slot) + ", gate at " + Hex(Match.Rva) + ")";
        B.State.store((int)AIBase1910::EBrainFlag::Found, std::memory_order_release);
    }
}

bool AIBase1910::CheckBuild(std::string& Why)
{
    if (std::fabs(VersionInfo.FortniteVersion - kFortniteVersion) > 0.001)
    {
        char Version[32];
        snprintf(Version, sizeof(Version), "%.2f", VersionInfo.FortniteVersion);
        Why = std::string("this is Fortnite ") + Version + ", the 19.10 AI base needs 19.10";
        return false;
    }
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

bool AIBase1910::Ensure(std::string& Why)
{
    const int State = GBase.load(std::memory_order_acquire);
    if (State == (int)EBase::Ready)
        return true;
    if (State == (int)EBase::Failed)
    {
        Why = GBaseWhy;
        return false;
    }

    std::string Reason;
    if (!CheckBuild(Reason))
        GBaseWhy = "build doesn't match: " + Reason;
    else if (!CheckBaseLayouts(Reason))
        GBaseWhy = "layout check failed: " + Reason;
    else if (!CheckBaseCode(Reason))
        GBaseWhy = "code check failed: " + Reason;
    else if (!InstallBaseHooks(Reason))
        GBaseWhy = Reason;
    else
    {
        GBase.store((int)EBase::Ready, std::memory_order_release);
        AIBase::LogLine("AIBase", "19.10 AI base ready: build CL " + std::to_string(kChangelist) +
            ", navigation and AI outfit hooks installed");
        return true;
    }
    GBase.store((int)EBase::Failed, std::memory_order_release);
    AIBase::LogLine("AIBase", "19.10 AI base off: " + GBaseWhy);
    Why = GBaseWhy;
    return false;
}

void AIBase1910::AddUser(uint32_t User)
{
    if (GBase.load(std::memory_order_acquire) == (int)EBase::Ready)
        GUsers.fetch_or(User, std::memory_order_acq_rel);
}

bool AIBase1910::IsReady()
{
    return GBase.load(std::memory_order_acquire) == (int)EBase::Ready;
}

bool AIBase1910::IsUsedBy(uint32_t User)
{
    return IsReady() && (GUsers.load(std::memory_order_acquire) & User) != 0;
}

AIBase1910::EBrainFlag AIBase1910::ResolveBrainFlag()
{
    auto& B = GBrain;
    if (B.bTried)
        return (EBrainFlag)B.State.load(std::memory_order_acquire);
    B.bTried = true;
    if (!IsReady())
    {
        B.Reason = "the 19.10 AI base is off";
        B.State.store((int)EBrainFlag::NotFound, std::memory_order_release);
    }
    else if (!AIBase::Guarded(&ResolveBrainFlagUnsafe, nullptr))
    {
        B.Reason = "the search faulted";
        B.State.store((int)EBrainFlag::NotFound, std::memory_order_release);
    }
    const auto Result = (EBrainFlag)B.State.load(std::memory_order_acquire);
    AIBase::LogLine("AIBase", std::string("19.10 brain start flag: ") +
        (Result == EBrainFlag::Found ? "found, " : Result == EBrainFlag::NotNeeded ? "not needed, " : "not found, ") +
        B.Reason);
    return Result;
}

AIBase1910::EBrainFlag AIBase1910::GetBrainFlag()
{
    return (EBrainFlag)GBrain.State.load(std::memory_order_acquire);
}

const std::string& AIBase1910::BrainFlagReason()
{
    return GBrain.Reason;
}

int AIBase1910::SetBrainFlag(const UObject* Controller)
{
    auto& B = GBrain;
    if (GetBrainFlag() != EBrainFlag::Found || !IsLiveObject(Controller))
        return -1;
    auto Owner = GetFromOffset<UObject*>(Controller, B.FieldOffset);
    if (!Owner || !IsLiveObject(Owner) || !Owner->IsA(B.OwnerClass))
        return 0;
    auto& Flag = GetFromOffset<uint8>(Owner, B.FlagOffset);
    if (Flag == 0)
    {
        Flag = 1;
        const auto Item = TUObjectArray::GetItemByIndex(Owner->Index);
        const uint64 Key = ((uint64)(uint32)Owner->Index << 32) | (uint32)(Item ? Item->SerialNumber : 0);
        if (B.SetOwners.insert(Key).second && B.SetOwners.size() <= 4)
        {
            AIBase::Logf("AIBase", "19.10 brain start flag set on %s (%s)", Owner->Name.ToString().c_str(),
                B.FieldName.c_str());
        }
    }
    return 1;
}
