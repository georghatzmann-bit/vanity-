// NIOBIUM: "Reset builds" (server half) - Niobium's own code (GPL-3.0), not part of Magnesium.
//
// The player aims at one of their edited builds and presses their own key in the F9 menu. The
// piece goes back to its unedited form without opening edit mode. The F9 client picks the target
// and sends two RPCs back to back on its game thread:
//   1. ServerCheat("nbedit:v1:r:<session16>:<seq8>")             the "arm"
//   2. ServerEditBuildingActor(Target, Target->Class, 0, false)    the server gets the exact actor
// The next Edit from that controller, if armed and not a real edit, replaces the piece with its
// unedited class through the same ReplaceBuildingActor normal edits use.
//
// Wire format (plain ASCII, fixed width, lowercase hex; never a "cheat ..." console command):
//   hello  client -> server  ServerCheat     "nbedit:v1:h:<session16>"          28 characters
//   ack    server -> client  ClientMessage   "nbedit:v1:a:<session16>"          28 characters
//   arm    client -> server  ServerCheat     "nbedit:v1:r:<session16>:<seq8>"   37 characters
// Anything else starting with "nbedit:" is swallowed silently (never reaches the cheat parser).
//
// Rules: game thread only (both RPC hooks run there), no locks. The arm is one-shot, lasts at
// most 1000 ms and is bound to the controller and world. If the player is editing the piece
// (EditingPlayer is this player), an Edit with the request's shape is dropped (it is still ours:
// the arm and its Edit arrive back to back) and any other shape runs as a normal edit. Every
// failed check, a missing team included, is a silent no-op. The server never calls Begin/End
// editing, never touches weapons, inventory or EditingPlayer, never charges materials. Off from
// Fortnite 37.00 on, where Epic has its own "Reset Building" key.
//
// Not to be confused with the destructive "cheat resetbuilds" command, which removes builds.
#pragma once

#include <cstdint>
#include <string>

class AFortPlayerControllerAthena;
class ABuildingSMActor;

namespace SDK
{
    class UClass;
}

namespace QuickReset
{
    // Epic's own "Reset Building" key exists from Chapter 6 Season 4 (37.00).
    inline constexpr double kEpicResetBuildingSince = 37.00;

    // Probe logging (P1 Edit recording, P2 class lookup, P5 hello/ack/arm) to the server console.
    // Turn off once the in-game probes are done.
    inline constexpr bool kProbeLog = true;

    // ServerCheat bridge (FortPlayerControllerAthena.cpp, right after PlayerLoadout's bridge).
    // True when the message is ours (handled or swallowed), false for anything else.
    bool HandleBridgeMessage(AFortPlayerControllerAthena* PlayerController,
        const std::string& Message) noexcept;

    // ServerEditBuildingActor hook, after IncrementCode. True when the RPC was the armed reset
    // companion and is fully handled here (reset done or silently ignored); false means "carry on
    // with the normal edit" (no arm, expired arm, or a real edit by this player that doesn't have
    // the request's shape).
    bool TryHandleArmedEdit(AFortPlayerControllerAthena* PlayerController,
        ABuildingSMActor* Building, const SDK::UClass* NewClass, int32_t RotationIterations,
        bool bMirrored) noexcept;

    // The one ReplaceBuildingActor call (holds the < 27 / >= 27 signature split). Used by normal
    // edits and by the reset path.
    ABuildingSMActor* CallReplaceBuildingActor(ABuildingSMActor* Building,
        const SDK::UClass* NewClass, int32_t RotationIterations, bool bMirrored,
        AFortPlayerControllerAthena* PlayerController);

    // P1 probe: records what a normal edit did (old/new class, rotation, mirror, yaw, team).
    struct FEditProbe
    {
        const SDK::UClass* OldClass = nullptr;
        const SDK::UClass* NewClass = nullptr;
        double OldYaw = 0.0;
        int32_t RotationIterations = 0;
        int32_t OldTeam = -1; // TeamIndex (else Team) of the old piece, -1 = no field
        bool bMirrored = false;
        bool bValid = false;
    };

    FEditProbe CaptureEditProbe(ABuildingSMActor* Building, const SDK::UClass* NewClass,
        int32_t RotationIterations, bool bMirrored) noexcept;
    void LogEditProbe(const FEditProbe& Probe, ABuildingSMActor* NewBuild) noexcept;
}
