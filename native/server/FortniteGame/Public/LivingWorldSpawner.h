// NIOBIUM: "Lager-lite" - Living world spawning (bosses, guards, creatures, characters) from the
// game's own Living World data, by reflection only. Niobium's own code (GPL-3.0); structure after
// Jeremy1926/Velora (MIT) Plugins/GameFeatures/Lager (see LivingWorldSpawner.cpp for credits).
//
// What it does, once per match (details at the top of LivingWorldSpawner.cpp):
//   - when the bus starts (or 2 minutes in on playlists without one) it finds the Living World
//     manager (Lager) on the game state, reads its config, categories, enabled events and their
//     actor descriptions, matches them to the map's point providers through the game's own
//     gameplay tag queries, and spawns them through the game's AI spawner (CreateComponentListFromClass
//     + RequestSpawn) - bosses first, then guards, creatures and characters;
//   - keeps them going: inventory for AI that has none, brain start (19.10), slow respawn of bosses
//     and guards, NPCs out of the alive player/bot lists;
//   - reports {"event":"livingWorld","state":"active",...,"spawned":N} (rate-limited) or
//     "unavailable" with the reason, and "[LivingWorld] ..." log lines (capped).
// No address is used for spawning; 19.10-only pieces (navigation, brain flag) come from the 19.10
// AI base (AIBase_19_10.h). Everything runs on the game thread inside AIBase::Guarded; faults are
// counted and switch the part that faulted off.
#pragma once
#include "../../pch.h"

class AFortGameMode;
class AFortGameStateAthena;

namespace LivingWorldSpawner
{
    // Hook phase (FLivingWorldHooks::Hook, after "Start match"): with bLivingWorld on, decides what
    // this build can do (AI spawner classes by reflection; on 19.10 the AI base for navigation and
    // brains), logs it and tells the launcher. With the switch off it sends "off".
    void OnStartMatch();

    // Living world was asked for at "Start match" and this build has the AI spawner classes.
    bool IsRequested();

    // True from the first spawn request of a match on (LivingWorld::IsActive()).
    bool IsActive();

    struct FTickInput
    {
        UWorld* World = nullptr;
        AFortGameMode* GameMode = nullptr;
        AFortGameStateAthena* GameState = nullptr;
        int32 GamePhase = -1;
        ULONGLONG NowMs = 0;
        ULONGLONG GameModeSeenMs = 0;
    };

    // Game thread, every poll (about 500 ms) of LivingWorld::GameThreadTick, only while IsRequested().
    void Tick(const FTickInput& In);

    // A live AI controller Living world treats as an NPC (boss, guard, creature, character): an AI
    // controller that is no AI player bot. False while Living world is not active.
    bool IsNPCController(const UObject* Controller);

    // ------------------------------------------------------------------ Loot on death
    // What an NPC drops besides its inventory: the row of the game's AI loot info table its
    // spawner data gave it (UFortAthenaAIRuntimeParameters_Inventory::LootInfo, 19.x layout; found by
    // reflection, absent on builds without it).
    struct FLootInfo
    {
        const UObject* Table = nullptr; // UDataTable (FortAthenaAILootInfoDataTableRow rows)
        FName Row;
        bool bResolved = false;
    };

    // Reads the loot info of an NPC controller (once it is set; false = not yet / none).
    bool ReadLootInfo(const UObject* Controller, FLootInfo& Out);

    // Drops the loot tiers of every row entry with bShouldDropLootOnDeath at the dead pawn, through
    // Niobium's loot tables like PickLootDrops (tier-group redirect, the pawn's gameplay tags as
    // OptionalLootTags; an entry's OptionalTagQuery must match the pawn's tags). Returns the number
    // of pickups; OutWhy says why none were dropped. At most Budget pickups.
    int32 DropLootTiers(AActor* Pawn, const FLootInfo& Info, int32 Budget, const char*& OutWhy);
}
