// NIOBIUM: the "19.10 AI base" - what every AI feature needs on Fortnite 19.10 (build CL 18675304)
// and nothing else: the build check, the navigation set-up (CreateAndConfigureNavSystem, so the
// client build spawns the nav data it doesn't load), the AI cosmetic loadout fix (GetLoadout) and
// the brain start flag. Used by the 19.10 AI player bots (PlayerBots_19_10.cpp) and by Living world
// (LivingWorldSpawner.cpp); either one switches it on, both can share it.
//
// The nav and GetLoadout hooks were ported from NotTacs/Artemis (GPL-3.0, commit 48dba08) as part of
// PlayerBots_19_10.cpp and moved here unchanged in what they do (file:line in AIBase_19_10.cpp).
// The brain flag lookup follows the idea of Jeremy1926/Velora (MIT), commit 9674d54,
// Velora/FortniteGame/Source/FortniteGame/Private/Athena/FortServerBotManagerAthena.cpp:146-183
// (the flag is the byte RunBehaviorTree compares right after loading the controller's bot manager
// field), written fresh for MinHook's hde64 decoder. Credits: see the top of AIBase_19_10.cpp.
//
// Rule: nothing is hooked, patched or written unless every check passed; a failed check leaves the
// base off and says why. With no AI feature on, nothing in here runs.
#pragma once
#include "../../pch.h"
#include <cstdint>
#include <string>

namespace AIBase1910
{
    // The features that use the base (a bit mask).
    constexpr uint32_t UserPlayerBots = 1;
    constexpr uint32_t UserLivingWorld = 2;

    // The build check alone: 19.10, CL 18675304 read from the game, Epic's exe size.
    bool CheckBuild(std::string& Why);

    // Hook phase only (Main(), before the map loads). Checks the build, the reflected layouts and
    // the code the base needs and installs its two hooks, once; later calls return the stored
    // result. Why gets the log reason on failure, prefixed like the bot gate always did
    // ("build doesn't match: ", "layout check failed: ", "code check failed: ", or the hook error).
    // The hooks do nothing until a feature called AddUser.
    bool Ensure(std::string& Why);

    // A feature whose whole gate passed uses the base from now on (its hooks act for it).
    void AddUser(uint32_t User);
    bool IsReady();
    bool IsUsedBy(uint32_t User);

    // ------------------------------------------------------------------ Brain start
    // Only after Ensure passed. Resolves, once, the byte AFortAthenaAIBotController::RunBehaviorTree
    // checks before it starts a behaviour tree ("bCanStartBrain"): the RunBehaviorTree virtual of
    // Default__FortAthenaAIBotController must hold exactly one
    //   mov r64, [this+<CachedBotManager | CachedAIServicePlayerBots>]; test r64, r64; jz;
    //   cmp byte ptr [r64+<flag>], r8/imm8
    // and the flag must be an unreflected byte inside the owner class whose default value is 0 or 1.
    // Read-only: nothing is written here. Logs "[AIBase] 19.10 brain start flag: ...".
    enum class EBrainFlag : int
    {
        Unknown = 0,      // not resolved (base off, or not asked yet)
        Found = 1,        // the flag is known, SetBrainFlag can set it
        NotNeeded = 2,    // the AI bot controller doesn't override RunBehaviorTree: no gate
        NotFound = 3,     // the check failed (BrainFlagReason says why)
    };
    EBrainFlag ResolveBrainFlag();
    EBrainFlag GetBrainFlag();
    const std::string& BrainFlagReason();

    // Game thread. Sets the flag on the object the controller's bot-manager field points to (once
    // per object, logged). 1 = set or already set, 0 = the controller has no such object (yet),
    // -1 = no flag known.
    int SetBrainFlag(const UObject* Controller);
}
