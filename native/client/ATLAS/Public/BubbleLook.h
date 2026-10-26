// [Niobium] Shared state for "Bubble look" (F9 > Main > Graphics) and the Bubble Builds status
// row (F9 > Options). Niobium code, GPL-3.0 like the rest of Niobium.
//
// The game thread (Client.cpp, MaintainBubbleLook) writes these values about once per second;
// the menu (GUI.cpp, render thread) only reads them. Plain atomics, no UObject pointers, so
// the menu never touches game objects.
#pragma once

#include <atomic>
#include <cmath>

namespace NiobiumBubbleLook
{
    // "Bubble strength" slider range and default.
    static constexpr int MinStrength = 1;
    static constexpr int MaxStrength = 8;
    static constexpr int DefaultStrength = 5;

    // Number of build blueprint textures Bubble look changes (see Client.cpp for the paths).
    static constexpr int TextureCount = 4;

    inline int SanitizeStrength(int value)
    {
        if (value < MinStrength)
            return MinStrength;
        if (value > MaxStrength)
            return MaxStrength;
        return value;
    }

    // Chapter 3 Season 1 (19.00 <= v < 20.00): the launcher's "lowMeshes" Bubble Builds level
    // (Performance Mode, Meshes Low). Whole hundredths, so 19.1 and 19.10 are the same.
    inline bool IsLowMeshesVersion(double fortniteVersion)
    {
        if (!(fortniteVersion > 0.0) || fortniteVersion > 1000.0)
            return false;
        const long long hundredths = std::llround(fortniteVersion * 100.0);
        return hundredths >= 1900 && hundredths < 2000;
    }

    enum class EState : int
    {
        Off = 0,         // Bubble look is off and nothing is changed
        Waiting = 1,     // on, but none of the textures is loaded yet (or the game isn't ready)
        Active = 2,      // on, AppliedCount textures are changed
        Unavailable = 3  // no usable CachedCombinedLODBias property, every texture found can't
                         // be changed (NeverStream, value out of range), or the textures never
                         // showed up in a match
    };

    inline std::atomic_int State{ static_cast<int>(EState::Off) };
    inline std::atomic_int AppliedCount{ 0 };

    // What FortGameUserSettings reports (read on the game thread on 19.x, or with the probe).
    // -1 = unknown / not readable. MeshQuality: 0 = Low, 1 or more = High (live value, changes
    // when the player changes Video settings). StartMeshQuality: the first reading of this
    // session, which is what the game runs with until a restart.
    inline std::atomic_int MeshQuality{ -1 };
    inline std::atomic_int StartMeshQuality{ -1 };
    inline std::atomic_int PerformanceMode{ -1 };
}
