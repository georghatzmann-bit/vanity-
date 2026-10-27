// NIOBIUM: "Living world" (bosses, guards, NPCs, wildlife) - Niobium's own code (GPL-3.0).
//
// This file holds the parts every version shares:
//   - the launcher event {"event":"livingWorld","state":"active"|"unavailable"|"off",...} at
//     "Start match" (the spawner sends the later "active" updates with the spawned count),
//   - a generic death drop for AI (13.x-30.x, reflection only): dead non-player AI pawns drop
//     what is still in their inventory as pickups (logic after Velora, MIT,
//     FortAthenaAIBotController.cpp:383-438); Living world NPCs also drop the loot tiers of
//     their AI loot info,
//   - a one-time "[LivingWorld] dump ..." of what the build has (Lager / Living World manager,
//     patrol paths, point providers, spawner data, AI system, navigation).
// Spawning ("Lager-lite", reflection only) is LivingWorldSpawner.h/.cpp; on 19.10 navigation and
// the brain start come from the 19.10 AI base (AIBase_19_10.h).
// The death drop runs only while an AI feature is active (AIBase::IsAnyAIFeatureActive), the dump
// only with bLivingWorldDump or while Living world is active. With the defaults nothing here runs.
#pragma once
#include "../../pch.h"

namespace LivingWorld
{
    // True only while Living world actually spawns AI this match (from its first spawn request on,
    // see LivingWorldSpawner::IsActive). Before that first request the spawner calls
    // AIBase::EnsureStandaloneCheckOff() and spawns nothing when that fails.
    bool IsActive();

    // Game thread, every frame (GUI::SafeZoneMapGameTick). Rate-limited to about 500 ms.
    void GameThreadTick();
}
