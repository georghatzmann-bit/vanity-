// NIOBIUM: trickshot parkours, target bots and trickshot detection - Rift's own code (GPL-3.0),
// not part of Magnesium.
//
// Commands (typed in game as "cheat ...", sent by the F9 menu or through the launcher pipe):
//   parkour <id>        builds the parkour from %LOCALAPPDATA%\Rift\server\parkours.json around you,
//                       puts you on the start, gives you a sniper rifle and remembers the start
//                       (if you still stand on the old parkour, the new one is built from the same ground point)
//   parkour retry       back to the start (facing forward, full health, weapons reloaded);
//                       eliminated target bots of the parkour come back to their spots
//   parkour clear       removes everything (floors, objects, target bots - also those from "targetbot")
//   parkour sniper      only gives the sniper rifle
//   parkour list        all parkour ids
//   targetbot <hp> <m>  one standing target bot <m> metres in front of you, on a floor, with <hp> health
//
// Trickshot detection: when a real player eliminates someone (bots too) while in the air,
// every player gets "[Rift] TRICKSHOT! <name> – <metres> m" (en dash) and the launcher gets the
// "trickshot" event.
//
// Everything here runs on the game thread (from ServerCheat or ClientOnPawnDied) and never throws.
#pragma once
#include <string>
#include <vector>

class AFortPlayerControllerAthena;
class AFortPlayerStateAthena;
class AFortPlayerPawnAthena;
class UFortItemDefinition;

namespace SDK
{
    class UClass;
}

namespace NiobiumParkour
{
    // "cheat parkour ..." - Args are the words after "parkour" (already lower case).
    void HandleParkourCommand(AFortPlayerControllerAthena* PlayerController,
        const std::vector<std::string>& Args) noexcept;

    // "cheat targetbot <hp> <m>" - Args are the words after "targetbot".
    void HandleTargetBotCommand(AFortPlayerControllerAthena* PlayerController,
        const std::vector<std::string>& Args) noexcept;

    // From ClientOnPawnDied for every elimination (bots too). Checks by itself whether it was a trickshot.
    void OnElimination(AFortPlayerControllerAthena* VictimController, AFortPlayerStateAthena* VictimState,
        AFortPlayerPawnAthena* VictimPawn, AFortPlayerControllerAthena* KillerController,
        AFortPlayerStateAthena* KillerState, AFortPlayerPawnAthena* KillerPawn) noexcept;
}

// Thin bridges to the static helpers in FortniteGame/Private/FortPlayerControllerAthena.cpp
// (defined there so "parkour" uses exactly the same resolvers as "summon" and "give").
const SDK::UClass* Niobium_FindActorClass(const std::string& Arg);
const UFortItemDefinition* Niobium_FindItemDefinition(const std::string& Arg);
int Niobium_GiveItem(AFortPlayerControllerAthena* PlayerController, const UFortItemDefinition* Definition,
    int Count);
// Removes exactly one still-alive bot made with "bot" - the same way "delbot" does it for every bot.
bool Niobium_RemoveSpawnedBot(AFortPlayerControllerAthena* BotController);
// While true, "bot" sends no success line per bot (the parkour builder reports by itself).
void Niobium_SetQuietBotSpawn(bool bQuiet);
