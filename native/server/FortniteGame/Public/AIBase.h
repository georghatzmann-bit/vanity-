// NIOBIUM: shared base for Niobium's AI work (AI player bots, "Living world" bosses and NPCs).
//
// Niobium's own code (GPL-3.0), on Magnesium (BSD-3) / Erbium (GPL-3.0). Moved here from
// PlayerBots_19_10.cpp, whose gate tooling was ported from NotTacs/Artemis (GPL-3.0, commit
// 48dba08): AllocateNearPage / PatchLeaTarget follow Artemis Engine/.../Kismet/MemoryLibrary.h
// (AllocateNearbyPage, Rel32Swap_Lea). The PE/unwind checks, layout checks, string anchor, SEH
// helpers and fault counters are Niobium's own. The standalone-check patch follows the idea of
// Jeremy1926/Velora (MIT), commit 67ffac0, Velora/FortniteGame/Source/FortniteGame/Private/Athena/
// FortPlayerPawnAthena.cpp:25-33, rewritten for this code base (no Velora code is copied; Velora
// uses its own Anchor/Zydis scanner, this uses MinHook's hde64 length disassembler).
// Credited in THIRD_PARTY_NOTICES.md.
//
// Rule for everything in here: a failed check turns the feature off and says why. Nothing is
// patched or hooked unless every byte and layout it depends on was checked first.
#pragma once
#include "../../pch.h"
#include <atomic>
#include <cstdint>
#include <initializer_list>
#include <string>

namespace AIBase
{
    // ------------------------------------------------------------------ Logging

    // Writes "[Tag] Text" to the inherited stdout handle (the launcher's pipe, read by logparse.rs;
    // this DLL's CRT stdout goes to stdout.log), falls back to the CRT stdout, and to SDK::DbgLog.
    void LogLine(const char* Tag, const std::string& Text);

    // printf-style LogLine (at most 767 characters per line).
    void Logf(const char* Tag, const char* Format, ...);

    std::string Hex(uint64_t Value);

    // ------------------------------------------------------------------ Objects

    // A live, not pending-kill object whose class can be read.
    bool IsLiveObject(const UObject* Object);

    bool IsChildOfClass(const UClass* Class, const UClass* Parent);

    // The reflected offset of a property, -1 for none.
    int32 PropertyOffset(const UField* Property);
    int32 OffsetOf(const UStruct* Struct, const char* Name);

    // The EClassCastFlags of a property (FField class flags on 12.10+, UClass flags before).
    uint64_t PropertyCastFlags(const UField* Property);

    namespace ECastFlags
    {
        constexpr uint64_t ByteProperty = 0x40;
        constexpr uint64_t IntProperty = 0x80;
        constexpr uint64_t FloatProperty = 0x100;
        constexpr uint64_t NameProperty = 0x2000;
        constexpr uint64_t ObjectProperty = 0x10000;
        constexpr uint64_t BoolProperty = 0x20000;
        constexpr uint64_t StructProperty = 0x100000;
        constexpr uint64_t ArrayProperty = 0x200000;
        constexpr uint64_t WeakObjectProperty = 0x8000000;
        constexpr uint64_t SoftObjectProperty = 0x20000000;
    }

    // True for a live controller that is no player controller (an AIController: Phoebe bots,
    // bosses, guards, NPCs, wildlife). Such controllers have no WorldInventory, XPComponent, ...
    bool IsAIController(const UObject* Controller);

    // ------------------------------------------------------------------ PE image of the game

    struct FImage
    {
        uint8_t* Base = nullptr;
        const IMAGE_NT_HEADERS64* Nt = nullptr;
        const RUNTIME_FUNCTION* Functions = nullptr;
        uint32_t FunctionCount = 0;
    };

    bool ReadGameImage(FImage& Out, std::string& Why);
    const IMAGE_SECTION_HEADER* FindSection(const FImage& Image, uint32_t Rva, uint32_t Size);
    bool IsCode(const FImage& Image, uint32_t Rva, uint32_t Size);
    bool IsWritableData(const FImage& Image, uint32_t Rva, uint32_t Size);
    bool IsReadOnlyData(const FImage& Image, uint32_t Rva, uint32_t Size);
    // The RVA of an address inside the game image; false for addresses outside it.
    bool RvaOf(const FImage& Image, const void* Address, uint32_t& OutRva);

    // The unwind entry that starts exactly at Rva, or the one whose range holds Rva.
    const RUNTIME_FUNCTION* FindUnwindEntry(const FImage& Image, uint32_t Rva, bool bExactStart);
    // A function's own (primary) unwind entry, not a chained one for a split-off part.
    bool IsPrimaryUnwindEntry(const FImage& Image, const RUNTIME_FUNCTION& Entry);
    // Follows chained unwind info back to the function's primary entry (nullptr if broken).
    const RUNTIME_FUNCTION* PrimaryUnwindEntry(const FImage& Image, const RUNTIME_FUNCTION* Entry);
    // [Begin, End) of the function that starts at FunctionRva: its primary entry plus the chained
    // parts that directly follow it.
    bool FunctionRange(const FImage& Image, uint32_t FunctionRva, uint32_t& OutBegin, uint32_t& OutEnd);

    // A function starts at Rva: a primary unwind entry starts there, right after the end of
    // another function or padding. bAllowStub also accepts a stripped stub without an unwind
    // entry right after padding (for code that is only replaced, never called).
    bool CheckFunctionStart(const FImage& Image, uint32_t Rva, const char* Name, std::string& Why,
        bool bAllowStub = false);

    // "lea r64, [rip+disp32]" inside a game function that loads a function start (or stub).
    bool CheckLeaToFunction(const FImage& Image, uint32_t Rva, std::string& Why);

    // String anchor: the UTF-16 string Text (whole string, zero-terminated) must be referenced by
    // exactly one RIP-relative LEA in the game's code, and that LEA must sit in a function with a
    // valid start. Anything else (no match, several matches, no function) fails with Why.
    bool FindStringAnchor(const FImage& Image, const wchar_t* Text, uint32_t& OutFunctionRva,
        uint32_t& OutReferenceRva, std::string& Why);

    // ------------------------------------------------------------------ Reflection layouts

    struct FExpectedField
    {
        const char* Name;
        int32 Offset;
        uint8 FieldMask; // 0 = not a bit field
    };

    // Struct must exist, have ExpectedSize (if > 0) and every field at its expected offset.
    bool CheckLayout(const UStruct* Struct, const char* StructName, int32 ExpectedSize,
        std::initializer_list<FExpectedField> Fields, std::string& Why);

    // ------------------------------------------------------------------ Code patching

    // A page within +-2 GB of Target, for a jump stub (Artemis AllocateNearbyPage).
    uint8_t* AllocateNearPage(const void* Target);
    // Points a RIP-relative LEA at a near "jmp [rip+0]; dq Detour" stub (Artemis Rel32Swap_Lea).
    bool PatchLeaTarget(uint8_t* Lea, void* Detour);
    // Writes Bytes over Address only if the Size bytes there are exactly Expected.
    bool WriteCodeBytes(uint8_t* Address, const uint8_t* Expected, const uint8_t* Bytes, size_t Size,
        std::string& Why);

    // ------------------------------------------------------------------ SEH guards

    using FGuardedFunction = void (*)(void* Context);

    // Runs Function(Context) inside __try. False when it faulted. Function must not rely on C++
    // destructors running after a fault (an access violation skips them under /EHsc).
    bool Guarded(FGuardedFunction Function, void* Context) noexcept;

    // Counts faults of one feature. After Limit faults the feature should turn itself off.
    class FFaultCounter
    {
    public:
        constexpr FFaultCounter(const char* InName, int32 InLimit)
            : Name(InName), Limit(InLimit)
        {
        }

        // Records one fault and logs it; true once the limit is reached.
        bool Record(const char* Where);
        bool IsTripped() const { return Faults.load(std::memory_order_acquire) >= Limit; }
        int32 Count() const { return Faults.load(std::memory_order_acquire); }
        void Reset() { Faults.store(0, std::memory_order_release); }

    private:
        const char* Name;
        int32 Limit;
        std::atomic<int32> Faults{ 0 };
    };

    // ------------------------------------------------------------------ Game-internal checks

    // True only while an AI feature actually runs: the 19.10 AI player bots passed their gate
    // (PlayerBots1910::IsActive()) or Living world spawns (LivingWorld::IsActive()). The raw
    // switches bPlayerBots / bLivingWorld are not enough: the launcher sends them for every
    // version, and a failed gate leaves them on.
    bool IsAnyAIFeatureActive();

    // 17.00-19.99, only while IsAnyAIFeatureActive(): makes the game-internal
    // "PerformAntiCheatStandaloneCheckNDF" return at once (see AIBase.cpp), so an AI that
    // possesses a pawn doesn't close the host. Idempotent: the search runs at most once per
    // process, later calls return at once. It must run before the first AI possesses a pawn:
    //   - the 19.10 bot gate calls it right after it passed (hook phase in Main(), before the map
    //     loads);
    //   - Living world must call it when it starts spawning, after LivingWorld::IsActive() turned
    //     true and before its first spawn request.
    // Logs "[AIBase] standalone check off" or why it was left alone.
    // Returns true when an AI may possess a pawn without closing the host: the build has no such
    // check (before 17.00, 20.00 and later) or the check is off. False on 17.00-19.99 when it could
    // not be switched off (or no AI feature is active yet): then no AI may be spawned.
    bool EnsureStandaloneCheckOff();
}
