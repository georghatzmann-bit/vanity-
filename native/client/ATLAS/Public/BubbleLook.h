// [Niobium] Shared state for "Bubble look" (F9 > Main > Graphics) and the Bubble Builds status
// row (F9 > Options). Niobium code, GPL-3.0 like the rest of Niobium.
//
// The game thread (Client.cpp, MaintainBubbleLook) writes these values about once per second;
// the menu (GUI.cpp, render thread) only reads them. Plain atomics, no UObject pointers, so
// the menu never touches game objects.
#pragma once

#include <atomic>
#include <cmath>
#include <cwchar>
#include <cwctype>

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

    // Launcher Bubble Builds level for a version. Same rules as VersionRules in
    // launcher/core/src/launchargs.rs (and launcher/src/lib/bubble.ts): supported
    // 15.40 <= v < 16.10, experimental 15.30 and 16.10 <= v < 16.50, "lowMeshes" 19.x,
    // everything else unavailable. Whole hundredths, so "15.4" can't be mixed up.
    enum class ELevel : int
    {
        Supported,
        Experimental,
        LowMeshes, // 19.x: Performance Mode + Meshes Low (launcher level "lowMeshes")
        Unavailable
    };

    inline ELevel LevelFor(double fortniteVersion)
    {
        if (!(fortniteVersion > 0.0) || fortniteVersion > 1000.0)
            return ELevel::Unavailable;

        const long long hundredths = std::llround(fortniteVersion * 100.0);
        if (hundredths >= 1540 && hundredths < 1610)
            return ELevel::Supported;
        if (hundredths == 1530 || (hundredths >= 1610 && hundredths < 1650))
            return ELevel::Experimental;
        if (IsLowMeshesVersion(fortniteVersion))
            return ELevel::LowMeshes;
        return ELevel::Unavailable;
    }

    // Case-insensitive search for a whole command line switch ("-name", "-name=value" or "-name"
    // in quotes). Never matches inside a longer switch such as "-namex".
    inline const wchar_t* FindCommandLineSwitch(const wchar_t* commandLine, const wchar_t* name)
    {
        if (!commandLine || !name || !*name)
            return nullptr;

        const size_t nameLength = std::wcslen(name);
        for (const wchar_t* at = commandLine; *at; ++at)
        {
            size_t matched = 0;
            while (matched < nameLength && at[matched] &&
                std::towlower(static_cast<std::wint_t>(at[matched])) ==
                    std::towlower(static_cast<std::wint_t>(name[matched])))
            {
                ++matched;
            }
            if (matched != nameLength)
                continue;

            const wchar_t before = at == commandLine ? L' ' : at[-1];
            const wchar_t after = at[nameLength];
            const bool startsToken = before == L' ' || before == L'\t' || before == L'"';
            const bool endsToken = after == L'\0' || after == L' ' || after == L'\t' ||
                after == L'"' || after == L'=';
            if (startsToken && endsToken)
                return at;
        }
        return nullptr;
    }

    // The launcher starts Performance Mode with -FeatureLevelES31 (both spellings count, like
    // is_feature_level_es31 in launchargs.rs).
    inline bool HasFeatureLevelES31(const wchar_t* commandLine)
    {
        return FindCommandLineSwitch(commandLine, L"-FeatureLevelES31") != nullptr ||
            FindCommandLineSwitch(commandLine, L"-FeatureLevelES3_1") != nullptr;
    }

    // Epic's own bubbles are really on: started in Performance Mode, on a Supported or LowMeshes
    // version, and Meshes was Low when this session started. Then Bubble look pauses (it would only
    // blur them more). startMeshQuality: -1 unknown, 0 Low, 1+ High.
    inline bool EpicBubblesOn(ELevel level, bool featureLevelES31, int startMeshQuality)
    {
        return featureLevelES31 &&
            (level == ELevel::Supported || level == ELevel::LowMeshes) &&
            startMeshQuality == 0;
    }

    // The Meshes setting exists from 15.40 on.
    inline bool HasMeshesSetting(double fortniteVersion)
    {
        if (!(fortniteVersion > 0.0) || fortniteVersion > 1000.0)
            return false;
        return std::llround(fortniteVersion * 100.0) >= 1540;
    }

    enum class EState : int
    {
        Off = 0,         // Bubble look is off and nothing is changed
        Waiting = 1,     // on, but none of the textures is loaded yet (or the game isn't ready)
        Active = 2,      // on, AppliedCount textures are changed
        Unavailable = 3, // no usable CachedCombinedLODBias property, every texture found can't
                         // be changed (NeverStream, value out of range), or the textures never
                         // showed up in a match
        Paused = 4       // on, but Epic's own Bubble Builds are on (EpicBubblesOn): the original
                         // values are back and nothing is changed while that lasts
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
