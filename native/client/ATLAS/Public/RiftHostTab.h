// [Rift] New file (GPL-3.0, part of Rift): the "Host" tab in the F9 menu.
// Everything the host needs during a match (bus, storm, match rules, items, health, teleport,
// target dummies, AI status) in the one Rift menu, instead of the separate server window, which
// is hidden now (server GUI.cpp). Every button sends one of the server's cheat commands; the
// server only lets the host change the match rules (FortPlayerControllerAthena.cpp).
//
// Like NiobiumTrickshotTab.h: no pch.h, SDK or game headers, so the menu preview tool can build
// this file on Linux with plain ImGui. This header stays plain ASCII.
#pragma once

#include "../ImGui/imgui.h"

#include <cstdint>

// What the tab needs from GUI.cpp. GUI.cpp fills the pointers with its file-static helpers.
struct FRiftHostTabHost
{
    // Queues a console command and shows "> command" in the console log (buttons).
    // false = can't be sent right now.
    bool (*Exec)(const char* Command);
    // Queues a console command without the echo (the status question every few seconds).
    bool (*Query)(const char* Command);
    // Section header and indentation, same as in the other tabs.
    void (*SectionLabel)(const char* Label);
    void (*BeginSectionBody)();
    void (*EndSectionBody)();
    // Menu accent colour (brand violet #8B5CF6) with the given alpha.
    ImVec4 (*Accent)(float Alpha);

    // Optional (may be nullptr): changes as soon as a new match / PlayerController exists ->
    // the tab forgets the old answer and asks again.
    uint64_t (*SessionGeneration)();
};

// Optional: Client.cpp registers how the tab can tell that you are still in the lobby
// (true = lobby -> short hint instead of the controls). Thread-safe.
void RiftHostTab_SetLobbyCheck(bool (*IsInLobby)());

// Draws the content of the "Host" tab into the current window/child and, while it is shown,
// asks the server for the match state ("cheat hoststatus") every few seconds.
// ContentWidth = usable width for buttons (CW in GUI_Render). Call from the render thread only.
void RiftHostTab_Draw(const FRiftHostTabHost& Host, float ContentWidth);

// The server's answer to "cheat hoststatus" arrives as a ClientMessage that starts with
// "[Rift] HOSTSTATE ". Client.cpp hands such lines here (game thread) and keeps them out of the
// console. Returns true when Text is such a line (it is then consumed). Never blocks (try_lock).
bool RiftHostTab_PushState(const wchar_t* Text, int Length);
