// NIOBIUM: shared base for Niobium's AI work. Credits and the rules for this file are at the top
// of FortniteGame/Public/AIBase.h:
//   - PE / unwind / LEA / layout checks and logging: moved unchanged from PlayerBots_19_10.cpp.
//   - AllocateNearPage, PatchLeaTarget: Artemis (GPL-3.0, 48dba08) Engine/.../Kismet/
//     MemoryLibrary.h (AllocateNearbyPage, Rel32Swap_Lea), moved from PlayerBots_19_10.cpp.
//   - EnsureStandaloneCheckOff: the idea of Velora (MIT, Jeremy1926, commit 67ffac0,
//     Velora/FortniteGame/Source/FortniteGame/Private/Athena/FortPlayerPawnAthena.cpp:25-33),
//     rewritten here for our scanner with strict byte checks.
//   - Instruction lengths come from MinHook's Hacker Disassembler Engine (hde64, BSD-2), which is
//     built from source in native/minhook and linked into this DLL.
#include "pch.h"
#include "../Public/AIBase.h"
#include "../Public/LivingWorld.h"
#include "../Public/PlayerBots_19_10.h"
#include <algorithm>
#include <cstdarg>
#include <string>
#include <unordered_set>
#include <vector>

#include "../../../third_party/minhook/src/hde/hde64.h"

// ---------------------------------------------------------------------- Logging

void AIBase::LogLine(const char* Tag, const std::string& Text)
{
    std::string Line = "[";
    Line += Tag ? Tag : "AIBase";
    Line += "] ";
    Line += Text;
    Line += "\n";

    bool bWritten = false;
    const HANDLE Stdout = GetStdHandle(STD_OUTPUT_HANDLE);
    if (Stdout && Stdout != INVALID_HANDLE_VALUE)
    {
        DWORD BytesWritten = 0;
        bWritten = WriteFile(Stdout, Line.data(), static_cast<DWORD>(Line.size()),
            &BytesWritten, nullptr) != FALSE && BytesWritten == Line.size();
    }
    if (!bWritten && stdout)
    {
        fwrite(Line.data(), 1, Line.size(), stdout);
        fflush(stdout);
    }
    SDK::DbgLog("%s", Line.c_str());
}

void AIBase::Logf(const char* Tag, const char* Format, ...)
{
    char Buffer[768];
    va_list Args;
    va_start(Args, Format);
    vsnprintf(Buffer, sizeof(Buffer), Format, Args);
    va_end(Args);
    LogLine(Tag, Buffer);
}

std::string AIBase::Hex(uint64_t Value)
{
    char Buffer[32];
    snprintf(Buffer, sizeof(Buffer), "0x%llX", (unsigned long long)Value);
    return Buffer;
}

// ---------------------------------------------------------------------- Objects

bool AIBase::IsLiveObject(const UObject* Object)
{
    if (!Object || !SDK::MemReadable(Object, sizeof(UObject)))
        return false;
    if (Object->Index < 0 || Object->Index >= TUObjectArray::Num())
        return false;
    auto Item = TUObjectArray::GetItemByIndex(Object->Index);
    constexpr int32 PendingKillFlag = 0x20;
    if (!Item || Item->GetObject() != Object || (Item->GetFlags() & PendingKillFlag))
        return false;
    return Object->Class && SDK::MemReadable(Object->Class, sizeof(UObject));
}

bool AIBase::IsChildOfClass(const UClass* Class, const UClass* Parent)
{
    int Guard = 0;
    for (auto Struct = (const UStruct*)Class; Struct && Guard++ < 256; Struct = Struct->GetSuper())
    {
        if (Struct == (const UStruct*)Parent)
            return true;
    }
    return false;
}

int32 AIBase::PropertyOffset(const UField* Property)
{
    return Property ? (int32)GetFromOffset<uint32>(Property, Offsets::Offset_Internal) : -1;
}

int32 AIBase::OffsetOf(const UStruct* Struct, const char* Name)
{
    return Struct ? PropertyOffset(Struct->GetProperty(Name)) : -1;
}

uint64_t AIBase::PropertyCastFlags(const UField* Property)
{
    if (!Property || !SDK::MemReadable(Property, 0x10))
        return 0;
    if (VersionInfo.FortniteVersion >= 12.10)
    {
        auto FieldClass = *(const void* const*)(__int64(Property) + 0x8);
        if (!FieldClass || !SDK::MemReadable(FieldClass, 0x18))
            return 0;
        return *(const uint64_t*)(__int64(FieldClass) + 0x10);
    }
    return Property->Class && SDK::MemReadable(Property->Class, sizeof(UObject))
        ? Property->Class->GetCastFlags() : 0;
}

bool AIBase::IsAIController(const UObject* Controller)
{
    static const UClass* ControllerClass = FindClass("Controller");
    static const UClass* PlayerControllerClass = FindClass("PlayerController");
    return ControllerClass && PlayerControllerClass && IsLiveObject(Controller) &&
        Controller->IsA(ControllerClass) && !Controller->IsA(PlayerControllerClass);
}

// ---------------------------------------------------------------------- PE image checks

bool AIBase::ReadGameImage(FImage& Out, std::string& Why)
{
    Out.Base = reinterpret_cast<uint8_t*>(ImageBase);
    if (!Out.Base || !SDK::MemReadable(Out.Base, sizeof(IMAGE_DOS_HEADER)))
    {
        Why = "the game module can't be read";
        return false;
    }
    auto Dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(Out.Base);
    if (Dos->e_magic != IMAGE_DOS_SIGNATURE || Dos->e_lfanew <= 0 || Dos->e_lfanew > 0x1000)
    {
        Why = "the game module has no PE header";
        return false;
    }
    Out.Nt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(Out.Base + Dos->e_lfanew);
    if (!SDK::MemReadable(Out.Nt, sizeof(IMAGE_NT_HEADERS64)) ||
        Out.Nt->Signature != IMAGE_NT_SIGNATURE ||
        Out.Nt->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64 ||
        Out.Nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC)
    {
        Why = "the game module is not a 64-bit PE file";
        return false;
    }
    const auto& Directory =
        Out.Nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXCEPTION];
    if (!Directory.VirtualAddress || Directory.Size < sizeof(RUNTIME_FUNCTION) ||
        (uint64_t)Directory.VirtualAddress + Directory.Size > Out.Nt->OptionalHeader.SizeOfImage)
    {
        Why = "the game module has no unwind table";
        return false;
    }
    Out.Functions = reinterpret_cast<const RUNTIME_FUNCTION*>(Out.Base + Directory.VirtualAddress);
    Out.FunctionCount = Directory.Size / sizeof(RUNTIME_FUNCTION);
    if (!SDK::MemReadable(Out.Functions, (size_t)Out.FunctionCount * sizeof(RUNTIME_FUNCTION)))
    {
        Why = "the unwind table can't be read";
        return false;
    }
    return true;
}

const IMAGE_SECTION_HEADER* AIBase::FindSection(const FImage& Image, uint32_t Rva, uint32_t Size)
{
    auto Section = IMAGE_FIRST_SECTION(Image.Nt);
    for (WORD Index = 0; Index < Image.Nt->FileHeader.NumberOfSections; ++Index, ++Section)
    {
        const uint32_t Start = Section->VirtualAddress;
        const uint32_t Length = (std::max)(Section->Misc.VirtualSize, Section->SizeOfRawData);
        if (Rva >= Start && (uint64_t)Rva + Size <= (uint64_t)Start + Length)
            return Section;
    }
    return nullptr;
}

bool AIBase::IsCode(const FImage& Image, uint32_t Rva, uint32_t Size)
{
    auto Section = FindSection(Image, Rva, Size);
    return Section && (Section->Characteristics & IMAGE_SCN_MEM_EXECUTE) &&
        SDK::MemReadable(Image.Base + Rva, Size);
}

bool AIBase::IsWritableData(const FImage& Image, uint32_t Rva, uint32_t Size)
{
    auto Section = FindSection(Image, Rva, Size);
    return Section && (Section->Characteristics & IMAGE_SCN_MEM_WRITE) &&
        !(Section->Characteristics & IMAGE_SCN_MEM_EXECUTE) &&
        SDK::MemReadable(Image.Base + Rva, Size);
}

bool AIBase::IsReadOnlyData(const FImage& Image, uint32_t Rva, uint32_t Size)
{
    auto Section = FindSection(Image, Rva, Size);
    return Section && (Section->Characteristics & IMAGE_SCN_MEM_READ) &&
        !(Section->Characteristics & IMAGE_SCN_MEM_WRITE) &&
        !(Section->Characteristics & IMAGE_SCN_MEM_EXECUTE) &&
        SDK::MemReadable(Image.Base + Rva, Size);
}

bool AIBase::RvaOf(const FImage& Image, const void* Address, uint32_t& OutRva)
{
    const auto Value = reinterpret_cast<const uint8_t*>(Address);
    if (!Image.Base || !Image.Nt || Value < Image.Base ||
        Value >= Image.Base + Image.Nt->OptionalHeader.SizeOfImage)
    {
        return false;
    }
    OutRva = (uint32_t)(Value - Image.Base);
    return true;
}

const RUNTIME_FUNCTION* AIBase::FindUnwindEntry(const FImage& Image, uint32_t Rva, bool bExactStart)
{
    uint32_t Low = 0;
    uint32_t High = Image.FunctionCount;
    while (Low < High)
    {
        const uint32_t Mid = Low + (High - Low) / 2;
        const auto& Entry = Image.Functions[Mid];
        if (Rva < Entry.BeginAddress)
            High = Mid;
        else if (Rva >= Entry.EndAddress)
            Low = Mid + 1;
        else
            return (!bExactStart || Entry.BeginAddress == Rva) ? &Entry : nullptr;
    }
    return nullptr;
}

bool AIBase::IsPrimaryUnwindEntry(const FImage& Image, const RUNTIME_FUNCTION& Entry)
{
    constexpr uint8_t ChainInfoFlag = 0x4; // UNW_FLAG_CHAININFO
    if (Entry.UnwindData & 1)
        return false;
    if ((uint64_t)Entry.UnwindData + 4 > Image.Nt->OptionalHeader.SizeOfImage ||
        !SDK::MemReadable(Image.Base + Entry.UnwindData, 4))
    {
        return false;
    }
    const uint8_t VersionAndFlags = *(Image.Base + Entry.UnwindData);
    const uint8_t Version = VersionAndFlags & 0x7;
    const uint8_t Flags = VersionAndFlags >> 3;
    return (Version == 1 || Version == 2) && (Flags & ChainInfoFlag) == 0;
}

const RUNTIME_FUNCTION* AIBase::PrimaryUnwindEntry(const FImage& Image, const RUNTIME_FUNCTION* Entry)
{
    constexpr uint8_t ChainInfoFlag = 0x4;
    for (int Guard = 0; Entry && Guard < 32; ++Guard)
    {
        uint32_t ChainedRva = 0;
        if (Entry->UnwindData & 1)
        {
            // Indirect entry: UnwindData (minus the flag bit) is the RVA of another table entry.
            ChainedRva = Entry->UnwindData & ~1u;
        }
        else
        {
            if ((uint64_t)Entry->UnwindData + 4 > Image.Nt->OptionalHeader.SizeOfImage ||
                !SDK::MemReadable(Image.Base + Entry->UnwindData, 4))
            {
                return nullptr;
            }
            const uint8_t* Info = Image.Base + Entry->UnwindData;
            const uint8_t Version = Info[0] & 0x7;
            const uint8_t Flags = Info[0] >> 3;
            if (Version != 1 && Version != 2)
                return nullptr;
            if ((Flags & ChainInfoFlag) == 0)
                return Entry;
            const uint32_t CodeCount = Info[2];
            ChainedRva = Entry->UnwindData + 4 + ((CodeCount + 1) & ~1u) * 2;
        }
        if ((uint64_t)ChainedRva + sizeof(RUNTIME_FUNCTION) > Image.Nt->OptionalHeader.SizeOfImage ||
            !SDK::MemReadable(Image.Base + ChainedRva, sizeof(RUNTIME_FUNCTION)))
        {
            return nullptr;
        }
        const auto Chained = reinterpret_cast<const RUNTIME_FUNCTION*>(Image.Base + ChainedRva);
        Entry = FindUnwindEntry(Image, Chained->BeginAddress, true);
    }
    return nullptr;
}

bool AIBase::FunctionRange(const FImage& Image, uint32_t FunctionRva, uint32_t& OutBegin,
    uint32_t& OutEnd)
{
    auto Entry = FindUnwindEntry(Image, FunctionRva, true);
    if (!Entry || !IsPrimaryUnwindEntry(Image, *Entry))
        return false;
    OutBegin = Entry->BeginAddress;
    OutEnd = Entry->EndAddress;
    for (int Guard = 0; Guard < 64; ++Guard)
    {
        auto Next = FindUnwindEntry(Image, OutEnd, true);
        if (!Next || IsPrimaryUnwindEntry(Image, *Next) || PrimaryUnwindEntry(Image, Next) != Entry)
            break;
        OutEnd = Next->EndAddress;
    }
    return OutEnd > OutBegin && IsCode(Image, OutBegin, OutEnd - OutBegin);
}

bool AIBase::CheckFunctionStart(const FImage& Image, uint32_t Rva, const char* Name, std::string& Why,
    bool bAllowStub)
{
    if (!IsCode(Image, Rva, 16) || Rva == 0)
    {
        Why = std::string(Name) + " (" + Hex(Rva) + ") is not in the game's code";
        return false;
    }
    auto Entry = FindUnwindEntry(Image, Rva, true);
    if (!Entry || !IsPrimaryUnwindEntry(Image, *Entry))
    {
        const uint8_t StubFirst = Image.Base[Rva];
        const uint8_t StubPrevious = Image.Base[Rva - 1];
        if (bAllowStub && !FindUnwindEntry(Image, Rva, false) &&
            (StubPrevious == 0xCC || StubPrevious == 0xC3) && StubFirst != 0xCC && StubFirst != 0x00)
        {
            return true;
        }
        Why = std::string(Name) + " (" + Hex(Rva) + "): no function starts there";
        return false;
    }
    const uint8_t First = Image.Base[Rva];
    const uint8_t Previous = Image.Base[Rva - 1];
    bool bAfterFunctionEnd = Previous == 0xCC || Previous == 0xC3 || Previous == 0x90;
    if (!bAfterFunctionEnd)
    {
        auto PreviousEntry = FindUnwindEntry(Image, Rva - 1, false);
        bAfterFunctionEnd = PreviousEntry && PreviousEntry->EndAddress == Rva;
    }
    if (!bAfterFunctionEnd || First == 0xCC || First == 0x00 || First == 0xC3)
    {
        Why = std::string(Name) + " (" + Hex(Rva) + "): the bytes don't look like a function start";
        return false;
    }
    return true;
}

bool AIBase::CheckLeaToFunction(const FImage& Image, uint32_t Rva, std::string& Why)
{
    if (!IsCode(Image, Rva, 7) || !FindUnwindEntry(Image, Rva, false))
    {
        Why = "the LEA at " + Hex(Rva) + " is not inside a game function";
        return false;
    }
    const uint8_t* Code = Image.Base + Rva;
    if ((Code[0] != 0x48 && Code[0] != 0x4C) || Code[1] != 0x8D || (Code[2] & 0xC7) != 0x05)
    {
        Why = "the instruction at " + Hex(Rva) + " is not a RIP-relative LEA";
        return false;
    }
    const int32_t Displacement = *reinterpret_cast<const int32_t*>(Code + 3);
    const int64_t Target = (int64_t)Rva + 7 + Displacement;
    if (Target <= 0 || Target >= (int64_t)Image.Nt->OptionalHeader.SizeOfImage)
    {
        Why = "the LEA at " + Hex(Rva) + " points outside the game";
        return false;
    }
    // The target may be a stripped stub without an unwind entry (it is only replaced, never
    // called or hooked).
    return CheckFunctionStart(Image, (uint32_t)Target, "the LEA target", Why, true);
}

// ---------------------------------------------------------------------- String anchor

namespace
{
    std::string Printable(const wchar_t* Text)
    {
        std::string Out;
        for (; Text && *Text && Out.size() < 96; ++Text)
            Out += (*Text >= 0x20 && *Text < 0x7F) ? (char)*Text : '?';
        return Out;
    }
}

bool AIBase::FindStringAnchor(const FImage& Image, const wchar_t* Text, uint32_t& OutFunctionRva,
    uint32_t& OutReferenceRva, std::string& Why)
{
    OutFunctionRva = 0;
    OutReferenceRva = 0;
    const size_t Chars = Text ? wcslen(Text) : 0;
    const std::string Shown = "\"" + Printable(Text) + "\"";
    if (Chars < 4)
    {
        Why = "the anchor text " + Shown + " is too short";
        return false;
    }
    const size_t PatternSize = (Chars + 1) * sizeof(wchar_t); // with the terminating zero
    const uint16_t FirstChar = (uint16_t)Text[0];

    // 1. Where the whole string sits in the game's read-only data (start of a string only).
    std::vector<uint32_t> Strings;
    auto Section = IMAGE_FIRST_SECTION(Image.Nt);
    for (WORD Index = 0; Index < Image.Nt->FileHeader.NumberOfSections; ++Index, ++Section)
    {
        if ((Section->Characteristics & IMAGE_SCN_MEM_EXECUTE) ||
            !(Section->Characteristics & IMAGE_SCN_MEM_READ))
        {
            continue;
        }
        const uint32_t Start = Section->VirtualAddress;
        const uint32_t Length = Section->Misc.VirtualSize;
        if (Length < PatternSize || !SDK::MemReadable(Image.Base + Start, Length))
            continue;
        const uint8_t* Data = Image.Base + Start;
        for (uint32_t Offset = 0; Offset + PatternSize <= Length; Offset += 2)
        {
            if (*reinterpret_cast<const uint16_t*>(Data + Offset) != FirstChar ||
                memcmp(Data + Offset, Text, PatternSize) != 0)
            {
                continue;
            }
            if (Offset >= 2 && *reinterpret_cast<const uint16_t*>(Data + Offset - 2) != 0)
                continue; // the tail of a longer string
            Strings.push_back(Start + Offset);
            if (Strings.size() > 16)
            {
                Why = "the text " + Shown + " is in the game more than 16 times";
                return false;
            }
        }
    }
    if (Strings.empty())
    {
        Why = "the text " + Shown + " is not in this game build";
        return false;
    }

    // 2. RIP-relative LEAs (REX.W 8D, mod 00 rm 101) in the game's code that load one of them.
    uint32_t References = 0;
    uint32_t ReferenceRva = 0;
    Section = IMAGE_FIRST_SECTION(Image.Nt);
    for (WORD Index = 0; Index < Image.Nt->FileHeader.NumberOfSections; ++Index, ++Section)
    {
        if (!(Section->Characteristics & IMAGE_SCN_MEM_EXECUTE))
            continue;
        const uint32_t Start = Section->VirtualAddress;
        const uint32_t Length = Section->Misc.VirtualSize;
        if (Length < 7 || !SDK::MemReadable(Image.Base + Start, Length))
            continue;
        const uint8_t* Code = Image.Base + Start;
        for (uint32_t Offset = 0; Offset + 7 <= Length; ++Offset)
        {
            if (Code[Offset + 1] != 0x8D || (Code[Offset] & 0xFA) != 0x48 ||
                (Code[Offset + 2] & 0xC7) != 0x05)
            {
                continue;
            }
            const int32_t Displacement = *reinterpret_cast<const int32_t*>(Code + Offset + 3);
            const int64_t Target = (int64_t)Start + Offset + 7 + Displacement;
            if (std::find(Strings.begin(), Strings.end(), (uint32_t)Target) == Strings.end() ||
                Target < 0)
            {
                continue;
            }
            ++References;
            ReferenceRva = Start + Offset;
        }
    }
    if (References != 1)
    {
        Why = "the text " + Shown + " is used " + std::to_string(References) +
            " times in the game's code, the anchor needs exactly one";
        return false;
    }

    // 3. The function around that reference must have a valid start.
    auto Entry = PrimaryUnwindEntry(Image, FindUnwindEntry(Image, ReferenceRva, false));
    if (!Entry)
    {
        Why = "the use of " + Shown + " at " + Hex(ReferenceRva) + " is in no game function";
        return false;
    }
    if (!CheckFunctionStart(Image, Entry->BeginAddress, "the anchor's function", Why))
        return false;
    OutFunctionRva = Entry->BeginAddress;
    OutReferenceRva = ReferenceRva;
    return true;
}

// ---------------------------------------------------------------------- Reflection layouts

bool AIBase::CheckLayout(const UStruct* Struct, const char* StructName, int32 ExpectedSize,
    std::initializer_list<FExpectedField> Fields, std::string& Why)
{
    if (!Struct)
    {
        Why = std::string(StructName) + " is missing";
        return false;
    }
    if (ExpectedSize > 0 && Struct->GetPropertiesSize() != ExpectedSize)
    {
        Why = std::string(StructName) + " has size " + Hex(Struct->GetPropertiesSize()) +
            ", expected " + Hex(ExpectedSize);
        return false;
    }
    for (const auto& Field : Fields)
    {
        auto Property = Struct->GetProperty(Field.Name);
        const int32 Offset = PropertyOffset(Property);
        if (Offset != Field.Offset)
        {
            Why = std::string(StructName) + "." + Field.Name + " is at " +
                (Offset < 0 ? std::string("<missing>") : Hex(Offset)) + ", expected " +
                Hex(Field.Offset);
            return false;
        }
        if (Field.FieldMask && Property->GetFieldMask() != Field.FieldMask)
        {
            Why = std::string(StructName) + "." + Field.Name + " has an unexpected bit";
            return false;
        }
    }
    return true;
}

// ---------------------------------------------------------------------- Code patching

uint8_t* AIBase::AllocateNearPage(const void* Target)
{
    SYSTEM_INFO SystemInfo;
    GetSystemInfo(&SystemInfo);
    const uint64_t PageSize = SystemInfo.dwAllocationGranularity;
    const uint64_t Start = reinterpret_cast<uint64_t>(Target) & ~(PageSize - 1);
    const uint64_t MinAddress = (std::max)(Start > 0x7FFF0000ull ? Start - 0x7FFF0000ull : 0ull,
        (uint64_t)SystemInfo.lpMinimumApplicationAddress);
    const uint64_t MaxAddress = (std::min)(Start + 0x7FFF0000ull,
        (uint64_t)SystemInfo.lpMaximumApplicationAddress);

    for (uint64_t Step = 1; Step < 0x10000; ++Step)
    {
        const uint64_t Delta = Step * PageSize;
        if (Start + Delta < MaxAddress)
        {
            if (auto Page = VirtualAlloc(reinterpret_cast<void*>(Start + Delta), PageSize,
                    MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE))
            {
                return static_cast<uint8_t*>(Page);
            }
        }
        if (Start > Delta && Start - Delta > MinAddress)
        {
            if (auto Page = VirtualAlloc(reinterpret_cast<void*>(Start - Delta), PageSize,
                    MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE))
            {
                return static_cast<uint8_t*>(Page);
            }
        }
        if (Start + Delta >= MaxAddress && (Start <= Delta || Start - Delta <= MinAddress))
            break;
    }
    return nullptr;
}

bool AIBase::PatchLeaTarget(uint8_t* Lea, void* Detour)
{
    auto Page = AllocateNearPage(Lea);
    if (!Page)
        return false;

    uint8_t Stub[14] = { 0xFF, 0x25, 0x00, 0x00, 0x00, 0x00 };
    memcpy(Stub + 6, &Detour, sizeof(Detour));
    memcpy(Page, Stub, sizeof(Stub));
    FlushInstructionCache(GetCurrentProcess(), Page, sizeof(Stub));

    const int64_t Distance = (int64_t)(Page - (Lea + 7));
    if (Distance < INT32_MIN || Distance > INT32_MAX)
    {
        VirtualFree(Page, 0, MEM_RELEASE);
        return false;
    }
    const int32_t Displacement = (int32_t)Distance;

    DWORD OldProtect = 0;
    if (!VirtualProtect(Lea + 3, sizeof(Displacement), PAGE_EXECUTE_READWRITE, &OldProtect))
    {
        VirtualFree(Page, 0, MEM_RELEASE);
        return false;
    }
    memcpy(Lea + 3, &Displacement, sizeof(Displacement));
    VirtualProtect(Lea + 3, sizeof(Displacement), OldProtect, &OldProtect);
    FlushInstructionCache(GetCurrentProcess(), Lea, 7);
    return true;
}

bool AIBase::WriteCodeBytes(uint8_t* Address, const uint8_t* Expected, const uint8_t* Bytes,
    size_t Size, std::string& Why)
{
    if (!Address || !Size || Size > 16 || !SDK::MemReadable(Address, Size))
    {
        Why = "the code to patch can't be read";
        return false;
    }
    if (memcmp(Address, Expected, Size) != 0)
    {
        Why = "the bytes at the patch site changed";
        return false;
    }
    DWORD OldProtect = 0;
    if (!VirtualProtect(Address, Size, PAGE_EXECUTE_READWRITE, &OldProtect))
    {
        Why = "the code page can't be made writable";
        return false;
    }
    memcpy(Address, Bytes, Size);
    VirtualProtect(Address, Size, OldProtect, &OldProtect);
    FlushInstructionCache(GetCurrentProcess(), Address, Size);
    return true;
}

// ---------------------------------------------------------------------- SEH guards

// No C++ object with a destructor may live in this function (MSVC C2712).
bool AIBase::Guarded(FGuardedFunction Function, void* Context) noexcept
{
    if (!Function)
        return false;
    __try
    {
        Function(Context);
        return true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        return false;
    }
}

bool AIBase::FFaultCounter::Record(const char* Where)
{
    const int32 Now = Faults.fetch_add(1, std::memory_order_acq_rel) + 1;
    Logf("AIBase", "%s faulted in %s (%d of %d)%s", Name ? Name : "a feature",
        Where ? Where : "?", Now, Limit, Now >= Limit ? ", it is off for this match" : "");
    return Now >= Limit;
}

bool AIBase::IsAnyAIFeatureActive()
{
    return PlayerBots1910::IsActive() || LivingWorld::IsActive();
}

// ---------------------------------------------------------------------- Standalone check
//
// OWNER APPROVED (2026-10-26). PerformAntiCheatStandaloneCheckNDF is a check inside the game
// itself, not EAC or BattlEye, and has no online effect: AFortPlayerPawnAthena::PossessedBy and
// AFortPlayerPawn::TickAuthority call it, and when an AI possesses a pawn on a client build that
// runs as a server it arms a 5 s RequestExit(true) timer, which closes the host. Private servers
// on old builds only. Its 20.00 body returns at once; on 17.00-19.99 we make its early "no object"
// exit unconditional, the way Velora (MIT) commit 67ffac0 does:
//   1. a virtual of Default__FortPlayerPawnAthena holds "inc al; mov rcx, *; and al, 0x3;
//      mov [rip+*], al" (Velora: .Virtual(...).Has(...).Find(...)); we need at least two distinct
//      virtuals (PossessedBy, TickAuthority) with it, from a capped walk of the pawn's vtable;
//   2. the last direct call before that sequence is the check (.Last("call 0x*").Target());
//   3. the check starts with "test rcx, rcx; jz <ret>" (.Is(...)), and the jz becomes a jmp
//      (.Find("jz 0x*").Jump()).
// Every step must match exactly (one call target for every place, a valid function start, the jz
// landing on a plain return inside the same function, the expected bytes right before writing).
// Otherwise nothing is written and the log says why. AIBase::EnsureStandaloneCheckOff runs this
// only while an AI feature is active.

namespace
{
    struct FDecoded
    {
        hde64s Info;
        uint32_t Rva;
        uint32_t Length;
    };

    // Callers checked that [Rva, End) is readable game code (FunctionRange); only the last bytes
    // of a range, where the decoder may look past End, are checked again.
    uint32_t DecodeAt(const AIBase::FImage& Image, uint32_t Rva, uint32_t End, hde64s& Out)
    {
        if (Rva >= End || (End - Rva < 15 && !SDK::MemReadable(Image.Base + Rva, 15)))
            return 0;
        const uint32_t Length = hde64_disasm(Image.Base + Rva, &Out);
        if (!Length || (Out.flags & F_ERROR) || Rva + Length > End)
            return 0;
        return Length;
    }

    bool IsIncAl(const hde64s& I)
    {
        return I.opcode == 0xFE && I.modrm == 0xC0 && !I.p_66 && !I.p_67;
    }

    bool IsMovRcx(const hde64s& I)
    {
        if (!I.rex_w || I.p_66 || I.p_67)
            return false;
        if (I.opcode == 0x8B) // mov rcx, r/m64
            return I.modrm_reg == 1 && !I.rex_r;
        if (I.opcode == 0x89) // mov r/m64 (rcx), r64
            return I.modrm_mod == 3 && I.modrm_rm == 1 && !I.rex_b;
        if (I.opcode == 0xB9) // mov rcx, imm64
            return !I.rex_b;
        if (I.opcode == 0xC7) // mov r/m64 (rcx), imm32
            return I.modrm_mod == 3 && I.modrm_reg == 0 && I.modrm_rm == 1 && !I.rex_b;
        return false;
    }

    bool IsAndAl3(const hde64s& I)
    {
        if (I.p_66 || I.p_67)
            return false;
        if (I.opcode == 0x24)
            return (I.flags & F_IMM8) && I.imm.imm8 == 0x03;
        return I.opcode == 0x80 && I.modrm == 0xE0 && (I.flags & F_IMM8) && I.imm.imm8 == 0x03 &&
            !I.rex_b;
    }

    bool IsStoreAlRipRelative(const hde64s& I)
    {
        return I.opcode == 0x88 && I.modrm_mod == 0 && I.modrm_rm == 5 && I.modrm_reg == 0 &&
            !I.rex_r && !I.p_66 && !I.p_67 && (I.flags & F_DISP32);
    }

    bool IsDirectCall(const hde64s& I)
    {
        return I.opcode == 0xE8 && (I.flags & F_IMM32) && (I.flags & F_RELATIVE);
    }

    struct FStandaloneMatch
    {
        uint32_t FunctionRva;
        uint32_t SequenceRva;
        uint32_t CallTarget; // 0 = no direct call before the sequence
        int32 Slot;
    };

    // Linear decode of one function, collecting every place of the sequence and the last direct
    // call before it.
    void ScanFunctionForSequence(const AIBase::FImage& Image, uint32_t FunctionRva, int32 Slot,
        std::vector<FStandaloneMatch>& Out)
    {
        uint32_t Begin = 0;
        uint32_t End = 0;
        if (!AIBase::FunctionRange(Image, FunctionRva, Begin, End) || End - Begin > 0x40000)
            return;

        FDecoded Window[4] = {};
        int32 Filled = 0;
        uint32_t LastCallTarget = 0;
        uint32_t CallBeforeWindow[4] = {};
        for (uint32_t Rva = Begin; Rva < End;)
        {
            hde64s Info;
            const uint32_t Length = DecodeAt(Image, Rva, End, Info);
            if (!Length)
            {
                Filled = 0;
                ++Rva;
                continue;
            }

            // Shift the window of the last four instructions.
            if (Filled == 4)
            {
                for (int32 Index = 0; Index < 3; ++Index)
                {
                    Window[Index] = Window[Index + 1];
                    CallBeforeWindow[Index] = CallBeforeWindow[Index + 1];
                }
                Filled = 3;
            }
            Window[Filled] = FDecoded{ Info, Rva, Length };
            CallBeforeWindow[Filled] = LastCallTarget;
            ++Filled;

            if (Filled == 4 && IsIncAl(Window[0].Info) && IsMovRcx(Window[1].Info) &&
                IsAndAl3(Window[2].Info) && IsStoreAlRipRelative(Window[3].Info))
            {
                Out.push_back(FStandaloneMatch{ FunctionRva, Window[0].Rva, CallBeforeWindow[0], Slot });
                if (Out.size() > 64)
                    return;
            }

            if (IsDirectCall(Info))
            {
                const int64_t Target = (int64_t)Rva + Length + (int32_t)Info.imm.imm32;
                LastCallTarget = Target > 0 && Target < (int64_t)Image.Nt->OptionalHeader.SizeOfImage
                    ? (uint32_t)Target : 0;
            }
            Rva += Length;
        }
    }

    bool IsPlainReturn(const AIBase::FImage& Image, uint32_t Rva)
    {
        if (!AIBase::IsCode(Image, Rva, 3))
            return false;
        const uint8_t* Code = Image.Base + Rva;
        return Code[0] == 0xC3 || (Code[0] == 0xF3 && Code[1] == 0xC3) || Code[0] == 0xC2;
    }

    struct FStandaloneContext
    {
        std::string Result;
        bool bPatched = false;
    };

    void NeutraliseStandaloneCheckUnsafe(void* RawContext)
    {
        auto& Context = *static_cast<FStandaloneContext*>(RawContext);
        std::string Why;
        AIBase::FImage Image;
        if (!AIBase::ReadGameImage(Image, Why))
        {
            Context.Result = "not found: " + Why;
            return;
        }

        auto PawnClass = FindClass("FortPlayerPawnAthena");
        auto Default = PawnClass ? PawnClass->GetDefaultObj() : nullptr;
        if (!AIBase::IsLiveObject(Default))
        {
            Context.Result = "not found: Default__FortPlayerPawnAthena is missing";
            return;
        }
        void** VTable = Default->Vft;
        uint32_t VTableRva = 0;
        if (!AIBase::RvaOf(Image, VTable, VTableRva) || AIBase::IsCode(Image, VTableRva, 8))
        {
            Context.Result = "not found: the pawn's vtable is not in the game's data";
            return;
        }

        // The walk stops at the first entry that is no pointer into the game's executable section
        // (the end of the vtable), and after kMaxPawnVTableSlots at the latest: on builds without
        // RTTI nothing separates this vtable from the next one. The only exception are our own
        // vtable hooks (Utils::Hook<AFortPlayerPawnAthena>, e.g. ProcessEvent): they point into
        // this DLL, are counted and skipped, because stopping there would cut the walk short
        // depending on which hook phase ran first.
        constexpr int32 kMaxPawnVTableSlots = 1024; // the 15.30 pawn already uses slot 487
        static const char SelfMarker = 0;
        HMODULE Self = nullptr;
        GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
            GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(&SelfMarker), &Self);
        const uint8_t* SelfBase = reinterpret_cast<const uint8_t*>(Self);
        uint64_t SelfSize = 0;
        if (SelfBase && SDK::MemReadable(SelfBase, sizeof(IMAGE_DOS_HEADER)))
        {
            auto SelfDos = reinterpret_cast<const IMAGE_DOS_HEADER*>(SelfBase);
            auto SelfNt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(SelfBase + SelfDos->e_lfanew);
            if (SelfDos->e_magic == IMAGE_DOS_SIGNATURE && SelfDos->e_lfanew > 0 &&
                SDK::MemReadable(SelfNt, sizeof(IMAGE_NT_HEADERS64)) && SelfNt->Signature == IMAGE_NT_SIGNATURE)
            {
                SelfSize = SelfNt->OptionalHeader.SizeOfImage;
            }
        }

        std::vector<FStandaloneMatch> Matches;
        std::unordered_set<uint32_t> Seen;
        int32 Slots = 0;
        for (int32 Slot = 0; Slot < kMaxPawnVTableSlots; ++Slot)
        {
            if (!SDK::MemReadable(&VTable[Slot], sizeof(void*)))
                break;
            const void* Entry = VTable[Slot];
            uint32_t EntryRva = 0;
            if (AIBase::RvaOf(Image, Entry, EntryRva) && AIBase::IsCode(Image, EntryRva, 1))
            {
                ++Slots;
                if (!Seen.insert(EntryRva).second)
                    continue;
                auto Unwind = AIBase::FindUnwindEntry(Image, EntryRva, true);
                if (!Unwind || !AIBase::IsPrimaryUnwindEntry(Image, *Unwind))
                    continue; // leaf stubs never call anything
                ScanFunctionForSequence(Image, EntryRva, Slot, Matches);
                continue;
            }
            const auto Address = reinterpret_cast<const uint8_t*>(Entry);
            if (SelfSize && Address >= SelfBase && Address < SelfBase + SelfSize)
            {
                ++Slots;
                continue;
            }
            break;
        }

        if (Matches.empty())
        {
            Context.Result = "not found: no pawn virtual (" + std::to_string(Slots) +
                " slots) has the check's counter sequence";
            return;
        }
        // PossessedBy and TickAuthority both call the check: at least two distinct pawn virtuals
        // must hold the sequence, and every place of it must lead to the same direct call. One
        // virtual alone could be any "if (!p) return;" function next to such a counter.
        std::vector<FStandaloneMatch> Functions; // the first match of each distinct virtual
        for (const auto& Match : Matches)
        {
            const bool bKnown = std::any_of(Functions.begin(), Functions.end(),
                [&](const FStandaloneMatch& Known) { return Known.FunctionRva == Match.FunctionRva; });
            if (!bKnown)
                Functions.push_back(Match);
        }
        const uint32_t Target = Matches[0].CallTarget;
        for (const auto& Match : Matches)
        {
            if (!Match.CallTarget || Match.CallTarget != Target)
            {
                Context.Result = "kept: " + std::to_string(Matches.size()) +
                    " places of the counter sequence in " + std::to_string(Functions.size()) +
                    " pawn virtual(s) lead to different calls";
                return;
            }
        }
        if (Functions.size() < 2)
        {
            Context.Result = "kept: only one pawn virtual (slot " + std::to_string(Matches[0].Slot) +
                ", " + std::to_string(Slots) + " slots walked) has the check's counter sequence, "
                "two must agree on the call";
            return;
        }
        std::string FoundSlots;
        for (size_t Index = 0; Index < Functions.size() && Index < 4; ++Index)
            FoundSlots += (Index ? ", " : "") + std::to_string(Functions[Index].Slot);
        if (Functions.size() > 4)
            FoundSlots += ", ...";

        if (!AIBase::CheckFunctionStart(Image, Target, "the check", Why))
        {
            Context.Result = "not found: " + Why;
            return;
        }
        uint32_t Begin = 0;
        uint32_t End = 0;
        if (!AIBase::FunctionRange(Image, Target, Begin, End) || End - Begin < 8)
        {
            Context.Result = "not found: the check at " + AIBase::Hex(Target) + " has no usable range";
            return;
        }

        // "test rcx, rcx" then "jz short" (74 rel8) or "jz near" (0F 84 rel32).
        const uint8_t* Code = Image.Base + Target;
        if (Code[0] != 0x48 || Code[1] != 0x85 || Code[2] != 0xC9)
        {
            Context.Result = "kept: the check at " + AIBase::Hex(Target) +
                " doesn't start with test rcx, rcx";
            return;
        }
        const uint32_t BranchRva = Target + 3;
        uint32_t Destination = 0;
        const bool bShort = Code[3] == 0x74;
        const bool bNear = Code[3] == 0x0F && Code[4] == 0x84;
        if (bShort)
            Destination = (uint32_t)((int64_t)BranchRva + 2 + (int8_t)Code[4]);
        else if (bNear)
            Destination = (uint32_t)((int64_t)BranchRva + 6 + *reinterpret_cast<const int32_t*>(Code + 5));
        else if (Code[3] == 0xEB || (Code[3] == 0x90 && Code[4] == 0xE9))
        {
            Context.Result = "already off (" + AIBase::Hex(Target) + ")";
            return;
        }
        else
        {
            Context.Result = "kept: the check at " + AIBase::Hex(Target) +
                " has no early exit after test rcx, rcx";
            return;
        }

        // The early exit must be a plain return of the same function.
        auto DestinationEntry = AIBase::PrimaryUnwindEntry(Image,
            AIBase::FindUnwindEntry(Image, Destination, false));
        if (!DestinationEntry || DestinationEntry->BeginAddress != Target ||
            !IsPlainReturn(Image, Destination))
        {
            Context.Result = "kept: the early exit of the check (" + AIBase::Hex(Destination) +
                ") is not a plain return";
            return;
        }

        uint8_t* Branch = Image.Base + BranchRva;
        if (bShort)
        {
            const uint8_t Expected[1] = { 0x74 };
            const uint8_t Patched[1] = { 0xEB };
            if (!AIBase::WriteCodeBytes(Branch, Expected, Patched, 1, Why))
            {
                Context.Result = "kept: " + Why;
                return;
            }
        }
        else
        {
            const uint8_t Expected[2] = { 0x0F, 0x84 };
            const uint8_t Patched[2] = { 0x90, 0xE9 };
            if (!AIBase::WriteCodeBytes(Branch, Expected, Patched, 2, Why))
            {
                Context.Result = "kept: " + Why;
                return;
            }
        }

        Context.bPatched = true;
        Context.Result = "PerformAntiCheatStandaloneCheckNDF at " + AIBase::Hex(Target) +
            " returns at once (found through pawn vtable slots " + FoundSlots + ", " +
            std::to_string(Matches.size()) + " call site(s), " + std::to_string(Slots) +
            " slots walked)";
    }

    std::atomic<bool> GStandaloneCheckDone{ false };
}

void AIBase::EnsureStandaloneCheckOff()
{
    const double Version = VersionInfo.FortniteVersion;
    if (Version < 17.00 || Version >= 20.00 || !IsAnyAIFeatureActive())
        return; // other builds don't have the check (or return at once), and without AI nothing possesses pawns
    if (GStandaloneCheckDone.exchange(true, std::memory_order_acq_rel))
        return; // searched (and patched, if it could be) already; the patch stays for the process

    FStandaloneContext Context;
    if (!Guarded(&NeutraliseStandaloneCheckUnsafe, &Context))
    {
        LogLine("AIBase", "standalone check not found: the search faulted, nothing was changed");
        return;
    }
    if (Context.bPatched)
        LogLine("AIBase", "standalone check off: " + Context.Result);
    else if (Context.Result.rfind("already off", 0) == 0)
        LogLine("AIBase", "standalone check off: " + Context.Result);
    else
        LogLine("AIBase", "standalone check " + Context.Result);
}
