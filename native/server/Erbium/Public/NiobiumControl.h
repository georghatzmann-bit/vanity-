// NIOBIUM: control pipe for the launcher - Niobium's own code (GPL-3.0), not part of Magnesium.
//
// The launcher connects to \\.\pipe\niobium-server and sends one JSON command per line
// ({"id":1,"cmd":"exec","text":"startaircraft"}, {"cmd":"config","key":"playlist","value":"solo"},
// {"cmd":"startmatch"}, {"cmd":"status"}). The server answers with events
// ({"event":"reply","id":1,"ok":true,"message":"..."}, "hello", "status", "ready", "matchEnd").
//
// Everything that touches game objects runs on the game thread (GameThreadTick). The pipe thread
// only receives lines and puts them in a queue.
#pragma once
#include <string>

namespace NiobiumControl
{
    // Starts the pipe server on its own thread (once, from Main()). Without the launcher nothing happens.
    void Start();

    // Call on the game thread: runs queued commands and sends a status every 2 s.
    void GameThreadTick();

    // Sends an event without extra fields to the launcher. Thread-safe.
    void Emit(const char* Event);

    // Called by the net code when the match is over.
    void EmitMatchEnd();

    // Trickshot detected (NiobiumParkour): {"event":"trickshot","player":...,"victim":...,"meters":N}. Thread-safe.
    void EmitTrickshot(const std::string& Player, const std::string& Victim, int Meters);

    // AI bot decision (PlayerBots_19_10.cpp), sent once per match:
    // {"event":"playerBots","state":"active"|"unavailable","reason":"<plain English>"}. Thread-safe.
    void EmitPlayerBots(const char* State, const std::string& Reason);

    // "Living world" state (LivingWorld.cpp, LivingWorldSpawner.cpp): sent at "Start match", again
    // when spawning starts or fails, and while it runs when the spawned count changed by 5 or more
    // (at most every 30 s otherwise) or the reason changed:
    // {"event":"livingWorld","state":"active"|"unavailable"|"off","reason":"<plain English>",
    //  "spawned":N}. "active" may carry a reason such as "standing only (...)". Thread-safe.
    void EmitLivingWorld(const char* State, const std::string& Reason, int Spawned);
}
