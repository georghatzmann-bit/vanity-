// NIOBIUM: "Living world" (bosses, guards, NPCs, wildlife) - Niobium's own code (GPL-3.0).
//
// This file holds the parts every version shares; spawning is not built yet:
//   - the launcher event {"event":"livingWorld","state":"active"|"unavailable"|"off",...},
//   - a generic death drop for AI (13.x-30.x, reflection only): dead non-player AI pawns drop
//     what is still in their inventory as pickups (logic after Velora, MIT,
//     FortAthenaAIBotController.cpp:383-438),
//   - a one-time "[LivingWorld] dump ..." of what the build has (Lager / Living World manager,
//     patrol paths, point providers, spawner data, AI system, navigation).
// The death drop runs only while an AI feature is active (AIBase::IsAnyAIFeatureActive), the dump
// only with bLivingWorldDump or while Living world is active. With the defaults nothing here runs.
#pragma once
#include "../../pch.h"

namespace LivingWorld
{
    // True only while Living world actually spawns AI this match. Always false for now: spawning
    // is not built for any version yet. The phase that builds it sets this when spawning starts
    // and then calls AIBase::EnsureStandaloneCheckOff() before its first spawn request.
    bool IsActive();

    // Game thread, every frame (GUI::SafeZoneMapGameTick). Rate-limited to about 500 ms.
    void GameThreadTick();
}
