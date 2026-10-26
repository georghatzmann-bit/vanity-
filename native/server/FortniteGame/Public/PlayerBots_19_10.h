// NIOBIUM: Fortnite's own AI player bots, for Fortnite 19.10 (build CL 18675304) only.
//
// Ported from NotTacs/Artemis (https://github.com/NotTacs/Artemis, commit 48dba08), GPL-3.0,
// by NotTacs and contributors. The file:line map and the safety gate are described at the top of
// FortniteGame/Private/PlayerBots_19_10.cpp. Credited in THIRD_PARTY_NOTICES.md.
//
// With bots off (FConfiguration::bPlayerBots = false, the default) none of this does anything:
// no hook is installed, no memory is patched and every function below returns right away.
#pragma once
#include "../../pch.h"

class AFortGameMode;
class AFortGameStateAthena;
class UFortPlaylistAthena;

namespace PlayerBots1910
{
    // True once the safety gate passed and the hooks are in for this match.
    bool IsActive();

    // True only while the bots are active and Controller is a live AI bot controller
    // (FortAthenaAIBotController). Such controllers are no player controllers, so the player code
    // paths (SpawnDefaultPawnFor, the bus jump) hand them to their bot branch or to the game.
    bool IsAIBotController(const UObject* Controller);

    // FortGameMode.cpp SetupPlaylist: gives the game mode the playlist's AI settings with the
    // player bot service (Artemis FortGameModeAthena.cpp:38-40).
    void OnSetupPlaylist(AFortGameMode* GameMode, const UFortPlaylistAthena* Playlist);

    // FortGameMode.cpp FinishWorldInitialization, before the native code runs (where Artemis sets
    // the AI settings). Same work as OnSetupPlaylist; it only runs once per game mode.
    void OnFinishWorldInitialization(AFortGameMode* GameMode);

    // FortGameMode.cpp StartAircraftPhase, after the native code put the players in the bus:
    // puts the bots in the bus too (Artemis FortGameStateAthena.cpp:6-10, 48dba08).
    void OnAircraftPhaseStarted(AFortGameMode* GameMode, AFortGameStateAthena* GameState);

    // Game thread, every frame (GUI::SafeZoneMapGameTick): POI caches, removes dead and destroyed
    // bots from GameMode->AliveBots, checks.
    void GameThreadTick();
}
