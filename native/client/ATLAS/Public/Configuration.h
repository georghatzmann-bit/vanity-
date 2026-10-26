// [Niobium] Modified version. Original: ATLAS Console (https://github.com/Ralzify/ATLAS-Client),
// (c) ralz, cipherfps and contributors, ATLAS Console Attribution License v1.0 (LICENSE-ATLAS.txt).
// Niobium changes: data paths, visible names/credit, MinHook via project reference.
#pragma once

#include "../../SDK/Engine.h"
#include <atomic>

enum class EConsoleMode : int
{
	Atlas = 0,
	Unreal = 1
};

struct FConfiguration
{
	static inline const char* ConsoleVersion = "Niobium 0.1 (ATLAS Console v2.1.0)"; // [Niobium] keeps the ATLAS credit

	static inline std::atomic_int ConsoleMode =
		static_cast<int>(EConsoleMode::Atlas);
	static inline std::atomic_bool bSaveTogglePreferences = true;
	static inline std::atomic_bool bSlashKeyEnabled = true;
	static inline std::atomic_bool bForceRespawns = true;
	static inline bool bEnableIris = true;
	static inline std::atomic_bool bEOREnabled = true;
	static inline std::atomic_bool bROREnabled = true;
	static inline std::atomic_bool bMobileBuilds = false;
	// [Niobium] "Bubble look" (Main > Graphics): lowers the detail of the four build blueprint
	// textures by BubbleStrength (1-8) levels. Applied on the game thread (Client.cpp,
	// MaintainBubbleLook). bBubbleProbe is a debug-only switch ("bubbleProbe": true in
	// client.json) that logs what the game reports for those textures; it never writes.
	static inline std::atomic_bool bBubbleLook = false;
	static inline std::atomic_int BubbleStrength = 5;
	static inline std::atomic_bool bBubbleProbe = false;
	static inline std::atomic_bool bGameplayFog = true;
	static inline std::atomic_bool bFirstPerson = false;
	static inline std::atomic_bool bDebugCamera = false;
	static inline std::atomic_bool bTargetInfo = false;
	static inline std::atomic_bool bDisablePreEdits = true;
	static inline int RespawnTime = 3;
	static inline int RespawnHeight = 20000;
	static inline std::atomic_int FOV = 80;
	static inline std::atomic_int MipMapLODBias = 0;
};
