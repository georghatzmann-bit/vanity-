// [Niobium] New file (GPL-3.0, part of Niobium): the "Trickshot" tab in the F9 menu and the
// trickshot banner. Deliberately without pch.h, SDK or game headers, so a preview tool can
// compile this file on Linux with plain ImGui and render screenshots.
// This file stays plain ASCII because GUI.cpp and Client.cpp are built without /utf-8.
#pragma once

#include "../ImGui/imgui.h"

#include <cstdint>

// What the tab needs from GUI.cpp. GUI.cpp fills the pointers with its file-static helpers.
struct FNiobiumTabHost
{
    // Queues a console command (e.g. "cheat parkour retry"). false = can't be sent right now.
    bool (*Exec)(const char* Command);
    // Section header and indentation, same as in the other tabs.
    void (*SectionLabel)(const char* Label);
    void (*BeginSectionBody)();
    void (*EndSectionBody)();
    // Menu accent colour (brand violet #7A3CFF) with the given alpha.
    ImVec4 (*Accent)(float Alpha);

    // Optional (may be nullptr):
    // Changes as soon as a new match / a new PlayerController exists -> local
    // toggles (slow motion, storm) jump back to "off".
    uint64_t (*SessionGeneration)();
};

// Optional: Client.cpp registers once at startup how the tab can tell that you are still in the
// lobby (true = lobby -> short hint at the top of the tab). nullptr = no hint.
// Thread-safe. Deliberately not routed through GUI.cpp, so GUI.cpp needs no further
// Client:: function (the preview tool builds GUI.cpp without Client.cpp).
void NiobiumTrickshotTab_SetLobbyCheck(bool (*IsInLobby)());

// Draws the content of the "Trickshot" tab into the current window/child.
// ContentWidth = usable width for buttons (CW in GUI_Render). Call from the render thread only.
void NiobiumTrickshotTab_Draw(const FNiobiumTabHost& Host, float ContentWidth);

// Optional: a different parkour file (preview tool). nullptr or "" = default path
// %LOCALAPPDATA%\Niobium\server\parkours.json. Call from the render thread only.
void NiobiumTrickshotTab_SetParkourFile(const wchar_t* Path);

// Remembers a message for the banner. Thread-safe, never blocks (try_lock),
// may be called from the game thread. Text starts with "[Niobium] TRICKSHOT" -> big
// "TRICKSHOT!" and below it the rest of the first line (player and metres).
void NiobiumToast_Push(const wchar_t* Text, int Length);

// Call every frame from GUI_Render (even when the menu is closed). Draws on
// ImGui::GetForegroundDrawList() and fades out after 3.5 s.
void NiobiumToast_Draw();
