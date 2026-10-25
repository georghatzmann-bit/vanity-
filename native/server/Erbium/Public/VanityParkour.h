// [Vanity] Trickshot-Parkours, Ziel-Bots und Trickshot-Erkennung – eigener Vanity-Code (GPL-3.0),
// kein Bestandteil von Magnesium.
//
// Befehle (im Spiel als „cheat …“ getippt, vom F9-Menü oder über die Launcher-Pipe):
//   parkour <id>        baut den Parkour aus %LOCALAPPDATA%\Vanity\server\parkours.json um dich herum,
//                       stellt dich auf den Start, gibt dir ein Scharfschützengewehr und merkt sich den Start
//                       (stehst du noch auf dem alten Parkour, baut der neue vom selben Boden-Punkt aus)
//   parkour retry       zurück zum Start (Blick nach vorne, volle Leben, Waffen nachgeladen);
//                       erledigte Ziel-Bots des Parkours kommen an ihren Platz zurück
//   parkour clear       alles wieder weg (Böden, Objekte, Ziel-Bots – auch die von „targetbot“)
//   parkour sniper      nur das Scharfschützengewehr geben
//   parkour list        alle Parkour-Namen
//   targetbot <hp> <m>  ein stehender Ziel-Bot <m> Meter vor dir, auf einem Boden, mit <hp> Leben
//
// Trickshot-Erkennung: Erledigt ein echter Spieler jemanden (auch Bots), während er in der Luft ist,
// bekommen alle Spieler „[Vanity] TRICKSHOT! <Name> – <Meter> m“ und der Launcher das Ereignis „trickshot“.
//
// Alles hier läuft im Spiel-Takt (aus ServerCheat bzw. ClientOnPawnDied) und wirft nie eine Ausnahme.
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

namespace VanityParkour
{
    // „cheat parkour …“ – Args sind die Wörter nach „parkour“ (schon klein geschrieben).
    void HandleParkourCommand(AFortPlayerControllerAthena* PlayerController,
        const std::vector<std::string>& Args) noexcept;

    // „cheat targetbot <hp> <m>“ – Args sind die Wörter nach „targetbot“.
    void HandleTargetBotCommand(AFortPlayerControllerAthena* PlayerController,
        const std::vector<std::string>& Args) noexcept;

    // Aus ClientOnPawnDied für jedes Ausscheiden (auch von Bots). Prüft selbst, ob es ein Trickshot war.
    void OnElimination(AFortPlayerControllerAthena* VictimController, AFortPlayerStateAthena* VictimState,
        AFortPlayerPawnAthena* VictimPawn, AFortPlayerControllerAthena* KillerController,
        AFortPlayerStateAthena* KillerState, AFortPlayerPawnAthena* KillerPawn) noexcept;
}

// Dünne Brücken zu den statischen Helfern in FortniteGame/Private/FortPlayerControllerAthena.cpp
// (dort definiert, damit „parkour“ genau dieselben Auflöser wie „summon“ und „give“ benutzt).
const SDK::UClass* Vanity_FindActorClass(const std::string& Arg);
const UFortItemDefinition* Vanity_FindItemDefinition(const std::string& Arg);
int Vanity_GiveItem(AFortPlayerControllerAthena* PlayerController, const UFortItemDefinition* Definition,
    int Count);
// Entfernt genau einen mit „bot“ erzeugten, noch lebenden Bot – so wie „delbot“ es für jeden Bot tut.
bool Vanity_RemoveSpawnedBot(AFortPlayerControllerAthena* BotController);
// Solange true, schickt „bot“ keine englische Erfolgsmeldung pro Bot (Parkour-Aufbau meldet selbst).
void Vanity_SetQuietBotSpawn(bool bQuiet);
