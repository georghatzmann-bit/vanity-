// [Niobium] "Reset builds", client half: handshake, target choice and the two RPCs.
// Niobium code, GPL-3.0. Wire format and rules: ../Public/QuickReset.h.
//
// Everything here runs on the game thread only (the GetMaxTickRate pump in Client.cpp, every
// frame). WndProc only stamps NiobiumQuickReset::PendingPressAt. Every reflected lookup checks the
// property/parameter type and size first; every game access is guarded with SEH.
#include "pch.h"

#include "../Public/QuickReset.h"
#include "../Public/BuildingSMActor.h"
#include "../Public/FortPlayerControllerAthena.h"
#include "../Public/Configuration.h"
#include "../Public/Diagnostics.h"

#include <atomic>
#include <cstring>

// Client.cpp: the real placed piece behind a build preview (shared with Disable pre-edits).
AActor* Niobium_FindHighlightedPlacedBuilding(AFortPlayerControllerAthena* playerController);

namespace NiobiumQuickReset
{
namespace
{
	constexpr ULONGLONG kHelloRetryMs = 1500;
	constexpr unsigned int kMaxHelloAttempts = 5;
	constexpr ULONGLONG kPressExpiryMs = 300;      // a press the pump couldn't look at in time
	constexpr ULONGLONG kSchemaRetryMs = 2000;
	constexpr ULONGLONG kProbeIntervalMs = 500;
	constexpr unsigned int kMaxClassLookups = 3;

	constexpr uint64 kCpfParm = 0x80;
	constexpr uint64 kCpfOutParm = 0x100;
	constexpr uint64 kCpfReturnParm = 0x400;
	constexpr uint64 kCastObjectProperty = 0x10000;
	constexpr uint64 kCastBoolProperty = 0x20000;

	// Same memory layout as FString (TArray<wchar_t>), but a plain struct, so it can live in a
	// call buffer built inside an SEH-guarded function.
	struct FRawString
	{
		wchar_t* Data;
		int32 NumElements;
		int32 MaxElements;
	};
	static_assert(sizeof(FRawString) == sizeof(FString), "FString layout");

	struct FObjectField
	{
		const UClass* Class = nullptr;
		uint32 Offset = 0;
		int State = 0; // 0 = not looked up for Class, 1 = usable, -1 = missing / wrong type
	};

	struct FBoolField
	{
		const UClass* Class = nullptr;
		uint32 Offset = 0;
		uint8 Mask = 0;
		int State = 0;
	};

	struct FCheatSchema
	{
		UFunction* Function = nullptr;
		uint32 Size = 0;
	};

	struct FEditSchema
	{
		UFunction* Function = nullptr;
		uint32 Size = 0;
		uint32 ActorOffset = 0;
		uint32 ClassOffset = 0;
		uint32 RotationOffset = 0;
		uint32 RotationSize = 0;
		uint32 MirroredOffset = 0;
	};

	struct FClassLookup
	{
		const UClass* Class = nullptr;
		unsigned int Attempts = 0;
		ULONGLONG NextAttemptAt = 0;
	};

	struct FState
	{
		FObjectKey World{};
		FObjectKey Controller{};
		uint64 Session = 0;
		uint32 Sequence = 0;
		unsigned int HelloAttempts = 0;
		ULONGLONG NextHelloAt = 0;
		bool AckLogged = false;
		bool UnsupportedLogged = false;

		ULONGLONG LastEditModeSeenAt = 0;
		ULONGLONG LastFrameAt = 0;
		ULONGLONG FrameInterval = 16;
		ULONGLONG LastSendAt = 0;

		const UClass* SchemaClass = nullptr;
		ULONGLONG NextSchemaAttemptAt = 0;
		FCheatSchema Cheat{};
		FEditSchema Edit{};
		bool EditLayoutLogged = false;
		bool EditLayoutFailLogged = false;
		unsigned int SchemaFailures = 0;

		FObjectField EditBuildingActor{};
		FObjectField PendingEnterEditModeActor{};
		FObjectField TargetedBuilding{};
		FObjectField MyFortPawn{};
		FObjectField PlayerState{};
		FObjectField CurrentWeapon{};
		FObjectField EditingPlayer{};
		FBoolField ShowMouseCursor{};
		FClassLookup EditingToolClass{};

		ULONGLONG NextProbeAt = 0;
		bool Faulted = false;
	};

	FState GState;
	std::atomic<uint64> GPublishedSession{ 0 };
	std::atomic<uint64> GAckedSession{ 0 };
	// The session whose hello is out and not acked yet (0 = none), and the session an old
	// server answered with its command list (help text) instead of an ack.
	std::atomic<uint64> GHelloOutstanding{ 0 };
	std::atomic<uint64> GHelpReplySession{ 0 };

	// Switch and key as the pump last saw them: turning the switch on again or picking another
	// key starts a new handshake when the last one got no ack (the user's way to retry).
	bool GWasActive = false;
	int GLastKey = 0;

	bool IsLiveUnsafe(const UObject* object)
	{
		if (!object)
			return false;
		const int32 index = object->Index;
		if (index < 0 || index >= TUObjectArray::Num())
			return false;
		const FUObjectItem* item = TUObjectArray::GetItemByIndex(index);
		return item && item->Object == object && (item->Flags & 0x20) == 0 && object->Class;
	}

	bool IsLive(const UObject* object)
	{
		__try
		{
			return IsLiveUnsafe(object);
		}
		__except (EXCEPTION_EXECUTE_HANDLER)
		{
			return false;
		}
	}

	// Pointer + index + serial (QuickReset.h, IsSameObject). Pointer 0 = not a live object.
	FObjectKey ObjectKey(const UObject* object)
	{
		FObjectKey key{};
		if (!IsLive(object))
			return key;
		const FUObjectItem* item = TUObjectArray::GetItemByIndex(object->Index);
		if (!item)
			return key;
		key.Pointer = reinterpret_cast<uintptr_t>(object);
		key.Index = object->Index;
		key.Serial = static_cast<uint32>(item->SerialNumber);
		return key;
	}

	uint64 KeySeed(const FObjectKey& key)
	{
		return static_cast<uint64>(key.Pointer) ^
			(static_cast<uint64>(static_cast<uint32>(key.Index)) << 40) ^
			(static_cast<uint64>(key.Serial) << 8);
	}

	uint64 Mix64(uint64 value)
	{
		value += 0x9e3779b97f4a7c15ULL;
		value = (value ^ (value >> 30)) * 0xbf58476d1ce4e5b9ULL;
		value = (value ^ (value >> 27)) * 0x94d049bb133111ebULL;
		return value ^ (value >> 31);
	}

	// A random 64-bit value per world and controller (never 0).
	uint64 CreateSession(const FObjectKey& world, const FObjectKey& controller)
	{
		const uint64 worldIdentity = KeySeed(world);
		const uint64 controllerIdentity = KeySeed(controller);
		LARGE_INTEGER counter{};
		QueryPerformanceCounter(&counter);
		const uint64 seed = static_cast<uint64>(counter.QuadPart) ^
			(static_cast<uint64>(GetCurrentProcessId()) << 32) ^
			GetTickCount64() ^ worldIdentity ^ (controllerIdentity << 1) ^
			reinterpret_cast<uintptr_t>(&GState) ^ 0x6e62656469747631ULL;
		const uint64 session = Mix64(seed);
		return session ? session : 1;
	}

	void ResetForController(const FObjectKey& world, const FObjectKey& controller)
	{
		const FState previous = GState;
		GState = {};
		// Layouts that only depend on classes stay; everything about the old session goes.
		GState.EditBuildingActor = previous.EditBuildingActor;
		GState.PendingEnterEditModeActor = previous.PendingEnterEditModeActor;
		GState.TargetedBuilding = previous.TargetedBuilding;
		GState.MyFortPawn = previous.MyFortPawn;
		GState.PlayerState = previous.PlayerState;
		GState.CurrentWeapon = previous.CurrentWeapon;
		GState.EditingPlayer = previous.EditingPlayer;
		GState.ShowMouseCursor = previous.ShowMouseCursor;
		GState.EditingToolClass = previous.EditingToolClass;
		GState.EditLayoutLogged = previous.EditLayoutLogged;
		GState.EditLayoutFailLogged = previous.EditLayoutFailLogged;
		GState.SchemaFailures = previous.SchemaFailures;
		GState.Faulted = previous.Faulted;

		GState.World = world;
		GState.Controller = controller;
		GAckedSession.store(0, std::memory_order_release);
		GHelloOutstanding.store(0, std::memory_order_release);
		GHelpReplySession.store(0, std::memory_order_release);
		if (world.Pointer && controller.Pointer)
		{
			GState.Session = CreateSession(world, controller);
			GPublishedSession.store(GState.Session, std::memory_order_release);
		}
		else
		{
			GPublishedSession.store(0, std::memory_order_release);
		}
	}

	// ---- Reflection ----------------------------------------------------------------------

	// A strong object pointer property (8 bytes, inside the object), looked up once per class.
	bool ResolveObjectField(FObjectField& field, const UObject* owner, const char* name)
	{
		if (field.Class == owner->Class && field.State != 0)
			return field.State > 0;
		field = {};
		field.Class = owner->Class;
		field.State = -1;

		const UField* named = owner->GetProperty(name);
		const UField* typed = owner->GetProperty(name, kCastObjectProperty);
		if (!named || named != typed)
			return false;
		const uint32 offset = GetFromOffset<uint32>(named, Offsets::Offset_Internal);
		const uint32 size = GetFromOffset<uint32>(named, Offsets::ElementSize);
		const int32 ownerSize = owner->Class->GetPropertiesSize();
		if (size != sizeof(UObject*) || ownerSize <= 0 ||
			offset > static_cast<uint32>(ownerSize) ||
			sizeof(UObject*) > static_cast<uint32>(ownerSize) - offset)
		{
			return false;
		}
		field.Offset = offset;
		field.State = 1;
		return true;
	}

	UObject* ReadObjectField(FObjectField& field, const UObject* owner, const char* name)
	{
		if (!IsLive(owner) || !ResolveObjectField(field, owner, name))
			return nullptr;
		UObject* value = *reinterpret_cast<UObject* const*>(
			reinterpret_cast<const uint8*>(owner) + field.Offset);
		return IsLive(value) ? value : nullptr;
	}

	// -1 = no such property on this class, 0/1 = its value.
	int ReadBoolField(FBoolField& field, const UObject* owner, const char* name)
	{
		if (!IsLive(owner))
			return -1;
		if (field.Class != owner->Class || field.State == 0)
		{
			field = {};
			field.Class = owner->Class;
			field.State = -1;
			const UField* typed = owner->GetProperty(name, kCastBoolProperty);
			if (typed)
			{
				const uint32 offset = GetFromOffset<uint32>(typed, Offsets::Offset_Internal);
				const int32 ownerSize = owner->Class->GetPropertiesSize();
				const uint8 mask = typed->GetFieldMask();
				if (ownerSize > 0 && offset < static_cast<uint32>(ownerSize) && mask != 0)
				{
					field.Offset = offset;
					field.Mask = mask;
					field.State = 1;
				}
			}
		}
		if (field.State <= 0)
			return -1;
		const uint8 byte = *(reinterpret_cast<const uint8*>(owner) + field.Offset);
		return (byte & field.Mask) != 0 ? 1 : 0;
	}

	// A class by short name (SDK::FindClass walks the object list once), at most a few tries.
	const UClass* ResolveClass(FClassLookup& lookup, const char* name, ULONGLONG now)
	{
		if (lookup.Class)
			return lookup.Class;
		if (lookup.Attempts >= kMaxClassLookups || now < lookup.NextAttemptAt)
			return nullptr;
		++lookup.Attempts;
		lookup.NextAttemptAt = now + kSchemaRetryMs;
		lookup.Class = SDK::FindClass(name);
		return lookup.Class;
	}

	bool BuildCheatSchema(AFortPlayerControllerAthena* controller, FCheatSchema& out)
	{
		out = {};
		UFunction* function = controller->GetFunction("ServerCheat");
		if (!IsLive(function))
			return false;
		const auto parameters = function->GetParamsNamed();
		if (parameters.Size != sizeof(FString))
			return false;
		int count = 0;
		bool found = false;
		for (const auto& parameter : parameters.NameOffsetMap)
		{
			if ((parameter.PropertyFlags & kCpfParm) == 0)
				continue;
			++count;
			if ((parameter.PropertyFlags & (kCpfOutParm | kCpfReturnParm)) != 0)
				return false;
			if (parameter.Name == "Msg" && parameter.Offset == 0 &&
				parameter.ElementSize == sizeof(FString))
			{
				found = true;
			}
		}
		if (count != 1 || !found)
			return false;
		out.Function = function;
		out.Size = parameters.Size;
		return true;
	}

	// ServerEditBuildingActor(BuildingActorToEdit, NewBuildingClass, RotationIterations, bMirrored),
	// parameters by name with their sizes checked: 8, 8, 4 (int32 before 8.x) or 1, 1.
	bool BuildEditSchema(AFortPlayerControllerAthena* controller, FEditSchema& out)
	{
		out = {};
		UFunction* function = controller->GetFunction("ServerEditBuildingActor");
		if (!IsLive(function))
			return false;
		const auto parameters = function->GetParamsNamed();
		if (parameters.Size == 0 || parameters.Size > 0x40)
			return false;

		bool actor = false, newClass = false, rotation = false, mirrored = false;
		int count = 0;
		for (const auto& parameter : parameters.NameOffsetMap)
		{
			if ((parameter.PropertyFlags & kCpfParm) == 0)
				continue;
			++count;
			if ((parameter.PropertyFlags & (kCpfOutParm | kCpfReturnParm)) != 0 ||
				parameter.Offset >= parameters.Size ||
				parameter.ElementSize > parameters.Size - parameter.Offset)
			{
				return false;
			}
			if (parameter.Name == "BuildingActorToEdit" && parameter.ElementSize == 8)
			{
				out.ActorOffset = parameter.Offset;
				actor = true;
			}
			else if (parameter.Name == "NewBuildingClass" && parameter.ElementSize == 8)
			{
				out.ClassOffset = parameter.Offset;
				newClass = true;
			}
			else if (parameter.Name == "RotationIterations" &&
				(parameter.ElementSize == 4 || parameter.ElementSize == 1))
			{
				out.RotationOffset = parameter.Offset;
				out.RotationSize = parameter.ElementSize;
				rotation = true;
			}
			else if (parameter.Name == "bMirrored" && parameter.ElementSize == 1)
			{
				out.MirroredOffset = parameter.Offset;
				mirrored = true;
			}
		}
		if (count != 4 || !actor || !newClass || !rotation || !mirrored)
			return false;
		out.Function = function;
		out.Size = parameters.Size;
		return true;
	}

	// ---- Edit mode and target ------------------------------------------------------------

	AFortPlayerPawnAthena* GetPawn(AFortPlayerControllerAthena* controller)
	{
		return static_cast<AFortPlayerPawnAthena*>(
			ReadObjectField(GState.MyFortPawn, controller, "MyFortPawn"));
	}

	// Edit mode: the controller edits a piece, is about to (waiting for the server), or holds
	// the edit tool.
	bool IsInEditMode(AFortPlayerControllerAthena* controller, ULONGLONG now)
	{
		if (ReadObjectField(GState.EditBuildingActor, controller, "EditBuildingActor"))
			return true;
		if (ReadObjectField(GState.PendingEnterEditModeActor, controller, "PendingEnterEditModeActor"))
			return true;
		AFortPlayerPawnAthena* pawn = GetPawn(controller);
		if (!pawn)
			return false;
		UObject* weapon = ReadObjectField(GState.CurrentWeapon, pawn, "CurrentWeapon");
		const UClass* editingTool = ResolveClass(GState.EditingToolClass, "FortWeap_EditingTool", now);
		return weapon && editingTool && weapon->IsA(editingTool);
	}

	int TeamOf(ABuildingSMActor* building)
	{
		if (building->HasTeamIndex())
			return building->TeamIndex;
		if (building->HasTeam())
			return building->Team;
		return -1;
	}

	// The piece the game itself targets, if it may be reset: a placed (not preview) player build,
	// not destroyed, nobody editing it, a wall/floor/stair/roof of our team. The server checks
	// all of this again; this only avoids pointless sends.
	ABuildingSMActor* PickTarget(AFortPlayerControllerAthena* controller, const char** reason)
	{
		*reason = "no-target";
		UObject* targeted = ReadObjectField(GState.TargetedBuilding, controller, "TargetedBuilding");
		if (!targeted)
			return nullptr;

		const UClass* buildingClass = ABuildingSMActor::StaticClass();
		const UClass* previewClass = ABuildingPlayerPrimitivePreview::StaticClass();
		if (previewClass && targeted->IsA(previewClass))
		{
			// TargetedBuilding can lag one update behind the highlight right after placing.
			targeted = Niobium_FindHighlightedPlacedBuilding(controller);
			if (!IsLive(targeted))
			{
				*reason = "preview";
				return nullptr;
			}
		}
		if (!buildingClass || !targeted->IsA(buildingClass) ||
			(previewClass && targeted->IsA(previewClass)))
		{
			*reason = "not-a-build";
			return nullptr;
		}

		auto building = static_cast<ABuildingSMActor*>(targeted);
		if (!building->HasbPlayerPlaced() || !building->bPlayerPlaced)
		{
			*reason = "not-player-placed";
			return nullptr;
		}
		if (building->HasbDestroyed() && building->bDestroyed)
		{
			*reason = "destroyed";
			return nullptr;
		}
		if (ReadObjectField(GState.EditingPlayer, building, "EditingPlayer"))
		{
			*reason = "being-edited";
			return nullptr;
		}
		if (!building->HasBuildingType())
		{
			*reason = "no-type";
			return nullptr;
		}
		const uint8 type = building->BuildingType;
		if (type != 0 && type != 1 && type != 5 && type != 6) // Wall, Floor, Stairs, Roof
		{
			*reason = "type";
			return nullptr;
		}

		// Same team as the local PlayerState->TeamIndex. A team we can't read on either side
		// counts as "not ours" (the server checks again; this never sends on a guess).
		const int buildingTeam = TeamOf(building);
		auto playerState = static_cast<AFortPlayerStateAthena*>(
			ReadObjectField(GState.PlayerState, controller, "PlayerState"));
		if (buildingTeam < 0 || !playerState || !playerState->HasTeamIndex())
		{
			*reason = "team-unknown";
			return nullptr;
		}
		if (playerState->TeamIndex != buildingTeam)
		{
			*reason = "other-team";
			return nullptr;
		}
		*reason = "ok";
		return building;
	}

	// ---- Sending -------------------------------------------------------------------------

	bool AsciiToWide(const char* text, size_t length, wchar_t* out, size_t capacity)
	{
		if (!text || !out || length + 1 > capacity)
			return false;
		for (size_t index = 0; index < length; ++index)
		{
			const unsigned char character = static_cast<unsigned char>(text[index]);
			if (character < 0x20 || character > 0x7e)
				return false;
			out[index] = static_cast<wchar_t>(character);
		}
		out[length] = L'\0';
		return true;
	}

	bool SendCheat(AFortPlayerControllerAthena* controller, const char* text, size_t length)
	{
		if (!GState.Cheat.Function || !IsLive(GState.Cheat.Function))
			return false;
		wchar_t wide[64]{};
		if (!AsciiToWide(text, length, wide, 64))
			return false;
		FRawString message{ wide, static_cast<int32>(length + 1), static_cast<int32>(length + 1) };
		alignas(16) uint8 parameters[0x40]{};
		memcpy(parameters, &message, sizeof(message));
		controller->ProcessEvent(GState.Cheat.Function, parameters);
		return true;
	}

	bool SendHello(AFortPlayerControllerAthena* controller)
	{
		char hello[kHelloLength + 1]{};
		return FormatHello(GState.Session, hello) == kHelloLength &&
			SendCheat(controller, hello, kHelloLength);
	}

	// Builds both RPC buffers first, then sends the arm and the Edit back to back. If either
	// buffer can't be built, nothing is sent (never an arm without its Edit).
	bool SendReset(AFortPlayerControllerAthena* controller, ABuildingSMActor* target)
	{
		const FEditSchema& edit = GState.Edit;
		if (!GState.Cheat.Function || !IsLive(GState.Cheat.Function) ||
			!edit.Function || !IsLive(edit.Function) || !IsLive(target) || !target->Class)
		{
			return false;
		}
		const uint32 sequence = GState.Sequence + 1;
		if (sequence == 0)
			return false;

		char arm[kArmLength + 1]{};
		wchar_t wideArm[64]{};
		if (FormatArm(GState.Session, sequence, arm) != kArmLength ||
			!AsciiToWide(arm, kArmLength, wideArm, 64))
		{
			return false;
		}
		FRawString message{ wideArm, static_cast<int32>(kArmLength + 1), static_cast<int32>(kArmLength + 1) };
		alignas(16) uint8 cheatParameters[0x40]{};
		memcpy(cheatParameters, &message, sizeof(message));

		alignas(16) uint8 editParameters[0x40]{};
		UObject* actor = target;
		const UClass* actorClass = target->Class;
		memcpy(editParameters + edit.ActorOffset, &actor, sizeof(actor));
		memcpy(editParameters + edit.ClassOffset, &actorClass, sizeof(actorClass));
		// RotationIterations = 0 and bMirrored = false: the buffer is already zero.

		controller->ProcessEvent(GState.Cheat.Function, cheatParameters);
		controller->ProcessEvent(edit.Function, editParameters);
		GState.Sequence = sequence;
		return true;
	}

	void PublishStatus(EStatus status)
	{
		Status.store(static_cast<int>(status), std::memory_order_release);
	}

	void LogProbe(AFortPlayerControllerAthena* controller, ULONGLONG now)
	{
		if (now < GState.NextProbeAt)
			return;
		GState.NextProbeAt = now + kProbeIntervalMs;
		AFortPlayerPawnAthena* pawn = GetPawn(controller);
		UObject* weapon = pawn ? ReadObjectField(GState.CurrentWeapon, pawn, "CurrentWeapon") : nullptr;
		UObject* editing = ReadObjectField(GState.EditBuildingActor, controller, "EditBuildingActor");
		UObject* pending = ReadObjectField(GState.PendingEnterEditModeActor, controller, "PendingEnterEditModeActor");
		UObject* targeted = ReadObjectField(GState.TargetedBuilding, controller, "TargetedBuilding");
		AActor* highlighted = Niobium_FindHighlightedPlacedBuilding(controller);
		const int cursor = ReadBoolField(GState.ShowMouseCursor, controller, "bShowMouseCursor");
		AtlasDiagnostics::WriteLine(
			"reset-builds probe weapon=%p weapon-class=%p edit=%p pending=%p targeted=%p highlighted=%p cursor=%d",
			weapon, weapon ? weapon->Class : nullptr, editing, pending, targeted, highlighted, cursor);
	}

	void PumpUnsafe(UWorld* world, AFortPlayerControllerAthena* controller, bool frontendActive,
		bool clientMessageHookReady)
	{
		const ULONGLONG now = GetTickCount64();
		if (GState.LastFrameAt != 0 && now >= GState.LastFrameAt)
		{
			const ULONGLONG delta = now - GState.LastFrameAt;
			GState.FrameInterval = delta > 1000 ? 1000 : delta;
		}
		GState.LastFrameAt = now;

		const bool enabled = FConfiguration::bResetBuilds.load(std::memory_order_acquire);
		const int key = FConfiguration::ResetBuildsVK.load(std::memory_order_acquire);
		if (!enabled || !IsUsableKey(key) || EpicOwnsResetBuilding(VersionInfo.FortniteVersion))
		{
			GWasActive = false;
			GHelloOutstanding.store(0, std::memory_order_release);
			PendingPressAt.store(0, std::memory_order_release);
			PublishStatus(EStatus::Idle);
			return;
		}
		const bool userRetry = !GWasActive || key != GLastKey;
		GWasActive = true;
		GLastKey = key;

		const FObjectKey worldKey = ObjectKey(world);
		const FObjectKey controllerKey = ObjectKey(controller);
		if (frontendActive || !worldKey.Pointer || !controllerKey.Pointer)
		{
			GHelloOutstanding.store(0, std::memory_order_release);
			PendingPressAt.store(0, std::memory_order_release);
			PublishStatus(EStatus::NotInMatch);
			return;
		}
		if (!IsSameObject(GState.World, worldKey) || !IsSameObject(GState.Controller, controllerKey))
		{
			ResetForController(worldKey, controllerKey);
			AtlasDiagnostics::WriteLine(
				"reset-builds session-started session=%016llx",
				static_cast<unsigned long long>(GState.Session));
		}
		else if (userRetry && GState.Session != 0 && GState.HelloAttempts >= kMaxHelloAttempts &&
			GAckedSession.load(std::memory_order_acquire) != GState.Session)
		{
			// The switch was turned on again or the key changed after "This server can't do it":
			// ask this server once more (same session, so a late ack still counts).
			GState.HelloAttempts = 0;
			GState.NextHelloAt = 0;
			GState.UnsupportedLogged = false;
			GHelpReplySession.store(0, std::memory_order_release);
			AtlasDiagnostics::WriteLine(
				"reset-builds handshake-restarted session=%016llx",
				static_cast<unsigned long long>(GState.Session));
		}

		// Edit mode is sampled every frame, also while nothing is pressed.
		if (IsInEditMode(controller, now))
			GState.LastEditModeSeenAt = now;
		if (FConfiguration::bResetBuildsProbe.load(std::memory_order_acquire))
			LogProbe(controller, now);

		if ((!GState.Cheat.Function || !GState.Edit.Function || GState.SchemaClass != controller->Class) &&
			now >= GState.NextSchemaAttemptAt)
		{
			GState.NextSchemaAttemptAt = now + kSchemaRetryMs;
			FCheatSchema cheat{};
			FEditSchema edit{};
			const bool cheatOk = BuildCheatSchema(controller, cheat);
			const bool editOk = BuildEditSchema(controller, edit);
			if (cheatOk && editOk)
			{
				GState.Cheat = cheat;
				GState.Edit = edit;
				GState.SchemaClass = controller->Class;
				if (!GState.EditLayoutLogged)
				{
					GState.EditLayoutLogged = true;
					AtlasDiagnostics::WriteLine(
						"reset-builds edit-rpc layout size=%u actor=%u class=%u rotation=%u/%u mirrored=%u",
						edit.Size, edit.ActorOffset, edit.ClassOffset, edit.RotationOffset,
						edit.RotationSize, edit.MirroredOffset);
				}
			}
			else
			{
				++GState.SchemaFailures;
				if (!GState.EditLayoutFailLogged)
				{
					GState.EditLayoutFailLogged = true;
					AtlasDiagnostics::WriteLine(
						"reset-builds rpc-layout-unusable server-cheat=%d server-edit=%d",
						cheatOk ? 1 : 0, editOk ? 1 : 0);
				}
			}
		}
		if (!GState.Cheat.Function || !GState.Edit.Function || !clientMessageHookReady)
		{
			GHelloOutstanding.store(0, std::memory_order_release);
			PendingPressAt.store(0, std::memory_order_release);
			// The RPCs were looked up a few times and don't have the expected layout here.
			PublishStatus(GState.SchemaFailures >= 3 ? EStatus::NotOnVersion : EStatus::Checking);
			return;
		}

		// Handshake: only after an ack from this server for this world and controller.
		const bool acknowledged = GState.Session != 0 &&
			GAckedSession.load(std::memory_order_acquire) == GState.Session;
		if (!acknowledged)
		{
			PendingPressAt.store(0, std::memory_order_release);
			const bool helpReply = GState.Session != 0 &&
				GHelpReplySession.load(std::memory_order_acquire) == GState.Session;
			if (helpReply)
			{
				// An old Niobium server: it answered the hello with its command list. No more
				// hellos for this world (each one would print the whole list again).
				GState.HelloAttempts = kMaxHelloAttempts;
				GState.NextHelloAt = 0;
			}
			if (GState.HelloAttempts < kMaxHelloAttempts)
			{
				if (now >= GState.NextHelloAt)
				{
					++GState.HelloAttempts;
					GState.NextHelloAt = now + kHelloRetryMs;
					GHelloOutstanding.store(GState.Session, std::memory_order_release);
					const bool sent = SendHello(controller);
					AtlasDiagnostics::WriteLine(
						"reset-builds hello attempt=%u sent=%d session=%016llx",
						GState.HelloAttempts, sent ? 1 : 0,
						static_cast<unsigned long long>(GState.Session));
				}
				PublishStatus(EStatus::Checking);
			}
			else if (now < GState.NextHelloAt)
			{
				PublishStatus(EStatus::Checking); // the last hello can still be answered
			}
			else
			{
				GHelloOutstanding.store(0, std::memory_order_release);
				if (!GState.UnsupportedLogged)
				{
					GState.UnsupportedLogged = true;
					if (helpReply)
						AtlasDiagnostics::WriteLine(
							"reset-builds unsupported-server (old server: command list instead of an ack)");
					else
						AtlasDiagnostics::WriteLine(
							"reset-builds unsupported-server (no ack after %u hellos)", kMaxHelloAttempts);
				}
				PublishStatus(EStatus::Unsupported);
			}
			return;
		}
		GHelloOutstanding.store(0, std::memory_order_release);
		if (!GState.AckLogged)
		{
			GState.AckLogged = true;
			AtlasDiagnostics::WriteLine(
				"reset-builds acknowledged session=%016llx",
				static_cast<unsigned long long>(GState.Session));
		}
		PublishStatus(EStatus::Ready);

		const ULONGLONG pressedAt = PendingPressAt.exchange(0, std::memory_order_acq_rel);
		if (pressedAt == 0)
			return;

		const char* skip = nullptr;
		if (now > pressedAt + kPressExpiryMs)
			skip = "late";
		else if (!PressIsOutsideEditMode(pressedAt, GState.LastEditModeSeenAt, GState.FrameInterval))
			skip = "edit-mode"; // the game's own Reset (and Reset on release) handle this key
		else if (ReadBoolField(GState.ShowMouseCursor, controller, "bShowMouseCursor") == 1)
			skip = "cursor"; // a game menu, the map, the inventory or chat is open
		else if (GState.LastSendAt != 0 && now < GState.LastSendAt + kMinSendIntervalMs)
			skip = "cooldown";
		if (skip)
		{
			if (FConfiguration::bResetBuildsProbe.load(std::memory_order_acquire))
				AtlasDiagnostics::WriteLine("reset-builds press-ignored reason=%s", skip);
			return;
		}

		const char* reason = nullptr;
		ABuildingSMActor* target = PickTarget(controller, &reason);
		if (!target)
		{
			if (FConfiguration::bResetBuildsProbe.load(std::memory_order_acquire))
				AtlasDiagnostics::WriteLine("reset-builds press-ignored reason=%s", reason);
			return;
		}
		if (SendReset(controller, target))
		{
			GState.LastSendAt = now;
			AtlasDiagnostics::WriteLine(
				"reset-builds sent seq=%u target=%p class=%p",
				GState.Sequence, target, target->Class);
		}
	}

	void PumpGuarded(UWorld* world, AFortPlayerControllerAthena* controller, bool frontendActive,
		bool clientMessageHookReady)
	{
		__try
		{
			PumpUnsafe(world, controller, frontendActive, clientMessageHookReady);
		}
		__except (EXCEPTION_EXECUTE_HANDLER)
		{
			// Off for the rest of this game process: never retry something that crashed.
			GState.Faulted = true;
		}
	}
}

bool IsWaitingForAck() noexcept
{
	return GHelloOutstanding.load(std::memory_order_acquire) != 0;
}

void NoteCommandListReply() noexcept
{
	const uint64 session = GHelloOutstanding.load(std::memory_order_acquire);
	if (session != 0 && GAckedSession.load(std::memory_order_acquire) != session)
		GHelpReplySession.store(session, std::memory_order_release);
}

bool HandleClientMessage(const wchar_t* text, int length) noexcept
{
	if (!text || length <= 0)
		return false;
	uint64 session = 0;
	if (!TryParseAck(text, static_cast<size_t>(length), &session))
		return false;
	// Private transport: an exact ack never reaches the console. It only counts for the session
	// this client published for its current world and controller.
	const uint64 current = GPublishedSession.load(std::memory_order_acquire);
	if (current != 0 && session == current)
		GAckedSession.store(session, std::memory_order_release);
	return true;
}

void GameThreadPump(
	SDK::UWorld* world,
	AFortPlayerControllerAthena* controller,
	bool frontendActive,
	bool clientMessageHookReady,
	unsigned long gameThreadId) noexcept
{
	if (gameThreadId == 0 || gameThreadId != GetCurrentThreadId())
		return;
	if (GState.Faulted)
	{
		PendingPressAt.store(0, std::memory_order_release);
		PublishStatus(EStatus::NotOnVersion);
		return;
	}
	PumpGuarded(world, controller, frontendActive, clientMessageHookReady);
	if (GState.Faulted)
	{
		PendingPressAt.store(0, std::memory_order_release);
		AtlasDiagnostics::WriteLine("reset-builds faulted; off for this game session");
	}
}
}
