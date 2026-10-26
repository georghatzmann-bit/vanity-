// [Niobium] Edit on release, Reset on release and Disable pre-edits on every Fortnite version,
// without ever running our hook and Epic's own setting together. Niobium code, GPL-3.0.
//
// Each feature takes exactly one "route" per game process:
//   Hook        - our detour does the work (old versions). Epic's setting is never touched.
//   Native      - the F9 switch reads and writes Epic's own setting. Our detour does nothing.
//   Unavailable - neither works here; the F9 row is greyed out with a reason.
//
// The boundary for each feature is the version where Epic's setting starts to work on PC:
//   Edit on release    11.00  (10.x has the setting, but only for mobile: never written there)
//   Disable pre-edits  15.20  (15.10's option only reset edits when you left build mode)
//   Reset on release   24.30  ("Auto Confirm Edits": Off / Edit / Reset / Both)
// Below it the hook is used (that is also where the byte search is known to work, so it stays a
// hard ceiling for the hook). From it on only Epic's setting is used, and only when its getter and
// setter were really found (fail closed: otherwise the row says why it is unavailable).
//
// Plain atomics and pure functions only (standard library), so the menu, the game thread, the
// startup code and a small Linux test can all use this header.
#pragma once

#include <atomic>
#include <cmath>

namespace NiobiumEditRoutes
{
    enum class EFeature : int
    {
        EditOnRelease = 0,
        ResetOnRelease = 1,
        PreEdits = 2
    };
    static constexpr int FeatureCount = 3;

    enum class ERoute : int
    {
        Hook = 0,
        Native = 1,
        Unavailable = 2
    };

    // Fortnite version as whole hundredths, so 15.2 and 15.20 are the same build. 0 = unknown.
    inline long long VersionHundredths(double fortniteVersion)
    {
        if (!(fortniteVersion > 0.0) || fortniteVersion > 1000.0)
            return 0;
        return std::llround(fortniteVersion * 100.0);
    }

    // First version (hundredths) where Epic's own setting is used instead of our hook.
    inline long long EpicSettingSince(EFeature feature)
    {
        switch (feature)
        {
        case EFeature::EditOnRelease:
            return 1100;
        case EFeature::ResetOnRelease:
            return 2430;
        case EFeature::PreEdits:
            return 1520;
        }
        return 0;
    }

    // The route the version alone allows. An unknown version (0) keeps the old behaviour (hook).
    inline ERoute PlannedRoute(EFeature feature, long long versionHundredths)
    {
        return versionHundredths < EpicSettingSince(feature) ? ERoute::Hook : ERoute::Native;
    }

    // The route that is really used. nativePresent: Epic's getter and setter were found by name
    // with the expected parameters. hookInstalled: our detour was created and enabled.
    inline ERoute ResolveRoute(
        EFeature feature, long long versionHundredths, bool nativePresent, bool hookInstalled)
    {
        if (PlannedRoute(feature, versionHundredths) == ERoute::Hook)
            return hookInstalled ? ERoute::Hook : ERoute::Unavailable;
        return nativePresent ? ERoute::Native : ERoute::Unavailable;
    }

    // Epic's getter/setter on UFortClientSettingsRecord (same names from 10.40 to 30.x).
    inline const char* NativeGetterName(EFeature feature)
    {
        switch (feature)
        {
        case EFeature::EditOnRelease:
            return "GetEditConfirmOnReleaseEnabled";
        case EFeature::ResetOnRelease:
            return "GetResetConfirmOnReleaseEnabled";
        case EFeature::PreEdits:
            return "GetDisablePreEditsWhenPlacingBuilding";
        }
        return "";
    }

    inline const char* NativeSetterName(EFeature feature)
    {
        switch (feature)
        {
        case EFeature::EditOnRelease:
            return "SetEditConfirmOnReleaseEnabled";
        case EFeature::ResetOnRelease:
            return "SetResetConfirmOnReleaseEnabled";
        case EFeature::PreEdits:
            return "SetDisablePreEditsWhenPlacingBuilding";
        }
        return "";
    }

    // Short name for the diagnostics log.
    inline const char* FeatureLogName(EFeature feature)
    {
        switch (feature)
        {
        case EFeature::EditOnRelease:
            return "eor";
        case EFeature::ResetOnRelease:
            return "ror";
        case EFeature::PreEdits:
            return "pre";
        }
        return "?";
    }

    // What the F9 row shows. Written by the startup code (hook routes) and the game thread
    // (native routes); the menu only reads it.
    enum class EStatus : int
    {
        Unknown = 0,       // startup has not decided yet
        HookActive = 1,    // our detour is installed and does the work
        HookFailed = 2,    // "Couldn't be set up on this version"
        NativeWaiting = 3, // "Waiting for Fortnite's settings..." (settings object not found yet)
        NativeReady = 4,   // Epic's value is in NativeValue
        NativeMissing = 5, // this version has no such setting: "Not available on <version>"
        NativeFailed = 6   // a write didn't stick (or crashed): off for the rest of the session
    };

    inline std::atomic_int Status[FeatureCount]{};
    // Epic's own value, read about once a second on the game thread. -1 = unknown, 0 = off, 1 = on.
    inline std::atomic_int NativeValue[FeatureCount] = { -1, -1, -1 };
    // A click in F9 waiting for the game thread: -1 = none, 0 = turn off, 1 = turn on.
    inline std::atomic_int PendingWrite[FeatureCount] = { -1, -1, -1 };

    inline int Index(EFeature feature)
    {
        return static_cast<int>(feature);
    }

    inline EStatus GetStatus(EFeature feature)
    {
        return static_cast<EStatus>(Status[Index(feature)].load(std::memory_order_acquire));
    }

    inline void SetStatus(EFeature feature, EStatus status)
    {
        Status[Index(feature)].store(static_cast<int>(status), std::memory_order_release);
    }

    // The route the published status stands for (Unknown counts as the planned route).
    inline ERoute RouteForStatus(EFeature feature, long long versionHundredths, EStatus status)
    {
        switch (status)
        {
        case EStatus::HookActive:
            return ERoute::Hook;
        case EStatus::NativeReady:
            return ERoute::Native;
        case EStatus::HookFailed:
        case EStatus::NativeMissing:
        case EStatus::NativeFailed:
            return ERoute::Unavailable;
        case EStatus::NativeWaiting:
        case EStatus::Unknown:
        default:
            return PlannedRoute(feature, versionHundredths);
        }
    }

    // Second guard inside our detours: only act while this feature really uses the hook.
    inline bool IsHookRouteActive(EFeature feature)
    {
        return GetStatus(feature) == EStatus::HookActive;
    }

    // F9 click on a native row: the game thread calls Epic's setter, then reads the value back.
    inline void RequestNativeWrite(EFeature feature, bool value)
    {
        PendingWrite[Index(feature)].store(value ? 1 : 0, std::memory_order_release);
    }

    // The value the native checkbox shows: a click that is still on its way wins, so the box
    // doesn't flicker back for the up-to-one-second until the game thread has written it.
    inline int DisplayedNativeValue(EFeature feature)
    {
        const int pending = PendingWrite[Index(feature)].load(std::memory_order_acquire);
        if (pending == 0 || pending == 1)
            return pending;
        return NativeValue[Index(feature)].load(std::memory_order_acquire);
    }
}
