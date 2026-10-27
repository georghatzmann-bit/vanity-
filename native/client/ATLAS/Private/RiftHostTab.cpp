// [Rift] New file (GPL-3.0, part of Rift): the "Host" tab in the F9 menu.
//
// The one place for the host during a match: start the bus, storm, match rules, items, health,
// teleport, target dummies and the AI status. The separate server window is hidden now (server
// GUI.cpp, launcher setting "Show the server window (for troubleshooting)").
//
// Every button sends one of the server's cheat commands (FortPlayerControllerAthena.cpp):
//   startaircraft, pausesafezone, resumesafezone, skipsafezone, startshrinksafezone,
//   infiniteammo on|off, infinitemats on|off, respawns on|off (host only), giveitem <name>,
//   giveammo, givemats, giveall, regen, regenall, mark, tp, s host o, w host, targetbot, tpbot,
//   delbot. While the tab is open it asks "cheat hoststatus" every few seconds; the answer
//   ("[Rift] HOSTSTATE v1 host=1 phase=3 ...") says whether you are the host and what is on.
//
// Like NiobiumTrickshotTab.cpp: only ImGui and the standard library, so the menu preview tool can
// build it on Linux. Encoding: UTF-8, client.vcxproj builds this file with /utf-8.
#include "../Public/RiftHostTab.h"
#include "../ImGui/imgui.h"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <mutex>
#include <string>

// The en dashes in the texts must reach ImGui as UTF-8 (three bytes).
static_assert(sizeof("–") == 4, "RiftHostTab.cpp must be built with /utf-8.");

namespace
{
    // ---------------------------------------------------------------- Colours (palette from GUI.cpp)
    constexpr ImVec4 kHintText(0.651f, 0.651f, 0.737f, 1.f); // text-muted #A6A6BC
    constexpr ImVec4 kFaintText(0.502f, 0.502f, 0.604f, 1.f); // text-faint #80809A
    constexpr ImVec4 kPrimary(0.957f, 0.957f, 0.973f, 1.f); // text #F4F4F8
    constexpr ImVec4 kError(1.f, 0.39f, 0.43f, 1.f);
    constexpr ImVec4 kCardBg(0.071f, 0.071f, 0.125f, 1.f); // #121220, like the parkour cards
    constexpr ImVec4 kCardBorder(0.141f, 0.141f, 0.227f, 1.f); // border #24243A
    constexpr ImVec4 kAccentText(0.769f, 0.710f, 0.992f, 1.f); // violet-text #C4B5FD
    constexpr ImVec4 kCyanText(0.404f, 0.910f, 0.976f, 1.f); // cyan-text #67E8F9
    constexpr ImVec4 kSuccess(0.133f, 0.773f, 0.369f, 1.f); // #22C55E
    constexpr ImVec4 kWarning(0.961f, 0.620f, 0.043f, 1.f); // #F59E0B

    constexpr float kActionButtonHeight = 28.f;
    constexpr double kPollSeconds = 2.5; // status question while the tab is open
    constexpr double kAfterActionPollSeconds = 0.6; // ask again soon after a change
    // Slower: a joined player (the answer won't change) and a server that never answered (an older
    // server answers an unknown command with its whole command list).
    constexpr double kSlowPollSeconds = 10.0;
    constexpr double kNoAnswerPollSeconds = 15.0;
    constexpr int kFastPollsWithoutAnswer = 3;
    constexpr double kNoAnswerSeconds = 6.0; // then: "No answer from the server yet"
    constexpr double kHoldSeconds = 2.0; // a clicked switch keeps its new value this long
    constexpr double kStatusOkSeconds = 3.0;
    constexpr double kStatusErrorSeconds = 4.0;

    // Server phases (server GUI.h, EGSStatus).
    enum : int { PhaseNotReady = 0, PhaseReady = 1, PhaseJoinable = 2, PhaseStarted = 3, PhaseEnded = 4 };

    struct FHostState
    {
        bool Valid = false;
        int Host = 0;
        int Phase = 0;
        int LateGame = 0;
        int Respawn = 0;
        int RespawnLive = 1;
        int Ammo = 0;
        int Mats = 0;
        int Storm = 0; // 1 = paused
        int Bots = 0; // 0 off, 1 on but not running, 2 running
        int BotCount = 0;
        int Living = 0; // same as Bots
        int LivingMax = 0;
        int Mark = 0; // 0 off, 1 on, 2 not on this version
    };

    // Written by the game thread (RiftHostTab_PushState), read by the render thread.
    std::mutex g_IncomingMutex;
    FHostState g_Incoming;
    uint32_t g_IncomingSerial = 0;

    // Switches that the tab changes itself: their new value is kept for a moment, so an answer
    // that was already on its way doesn't flip them back.
    enum EField { FieldAmmo, FieldMats, FieldRespawn, FieldStorm, FieldMark, FieldCount };

    // Sections (for the feedback line below the section that was used).
    enum ESection { SectionMatch, SectionStorm, SectionRules, SectionItems, SectionHealth,
        SectionTeleport, SectionDummies, SectionNone };

    struct FTabState
    {
        FHostState State;
        uint32_t SeenSerial = 0;
        bool HaveSession = false;
        uint64_t Session = 0;
        double FirstAskAt = -1.0;
        double NextPollAt = 0.0;
        int UnansweredPolls = 0;
        double HoldUntil[FieldCount]{};
        int StatusSection = SectionNone;
        std::string StatusText;
        bool StatusError = false;
        double StatusUntil = 0.0;
        char ItemName[96] = "";
    };

    FTabState g_Tab;

    std::atomic<bool (*)()> g_LobbyCheck{ nullptr };

    // ---------------------------------------------------------------- Server answer
    // "[Rift] HOSTSTATE v1 host=1 phase=3 lategame=0 ..." -> FHostState. false = no "host=" field.
    bool ParseState(const wchar_t* Text, int Length, int PrefixLength, FHostState& Out)
    {
        char buffer[400];
        int used = 0;
        for (int index = PrefixLength; index < Length && used < static_cast<int>(sizeof(buffer)) - 1; ++index)
        {
            const wchar_t c = Text[index];
            if (c == 0)
                break;
            buffer[used++] = (c >= 0x20 && c < 0x7F) ? static_cast<char>(c) : ' ';
        }
        buffer[used] = '\0';

        FHostState state;
        bool sawHost = false;
        char* cursor = buffer;
        while (*cursor)
        {
            while (*cursor == ' ')
                ++cursor;
            if (!*cursor)
                break;
            char* token = cursor;
            while (*cursor && *cursor != ' ')
                ++cursor;
            if (*cursor)
                *cursor++ = '\0';
            char* equals = std::strchr(token, '=');
            if (!equals)
                continue;
            *equals = '\0';
            const int value = std::atoi(equals + 1);
            struct FKey { const char* Name; int FHostState::* Field; };
            static const FKey keys[] = {
                { "host", &FHostState::Host }, { "phase", &FHostState::Phase },
                { "lategame", &FHostState::LateGame }, { "respawn", &FHostState::Respawn },
                { "respawnlive", &FHostState::RespawnLive }, { "ammo", &FHostState::Ammo },
                { "mats", &FHostState::Mats }, { "storm", &FHostState::Storm },
                { "bots", &FHostState::Bots }, { "botcount", &FHostState::BotCount },
                { "living", &FHostState::Living }, { "livingmax", &FHostState::LivingMax },
                { "mark", &FHostState::Mark },
            };
            for (const FKey& key : keys)
            {
                if (std::strcmp(token, key.Name) == 0)
                {
                    state.*(key.Field) = value;
                    if (key.Field == &FHostState::Host)
                        sawHost = true;
                    break;
                }
            }
        }
        if (!sawHost)
            return false;
        state.Valid = true;
        Out = state;
        return true;
    }

    // Takes a new answer from the game thread (keeps the switches that were just clicked).
    void TakeIncomingState(double Now)
    {
        FHostState incoming;
        {
            std::lock_guard<std::mutex> lock(g_IncomingMutex);
            if (g_IncomingSerial == g_Tab.SeenSerial)
                return;
            g_Tab.SeenSerial = g_IncomingSerial;
            incoming = g_Incoming;
        }
        const FHostState previous = g_Tab.State;
        g_Tab.State = incoming;
        g_Tab.UnansweredPolls = 0;
        if (!previous.Valid)
            return;
        int FHostState::* const held[FieldCount] = {
            &FHostState::Ammo, &FHostState::Mats, &FHostState::Respawn, &FHostState::Storm, &FHostState::Mark
        };
        for (int field = 0; field < FieldCount; ++field)
        {
            if (Now < g_Tab.HoldUntil[field])
                g_Tab.State.*(held[field]) = previous.*(held[field]);
        }
    }

    void ResetOnNewSession(const FRiftHostTabHost& Host)
    {
        if (!Host.SessionGeneration)
            return;
        const uint64_t session = Host.SessionGeneration();
        if (!g_Tab.HaveSession)
        {
            g_Tab.HaveSession = true;
            g_Tab.Session = session;
            return;
        }
        if (session == g_Tab.Session)
            return;
        // New match: forget the old answer and ask again.
        g_Tab.Session = session;
        g_Tab.State = FHostState();
        g_Tab.FirstAskAt = -1.0;
        g_Tab.NextPollAt = 0.0;
        g_Tab.UnansweredPolls = 0;
        for (double& hold : g_Tab.HoldUntil)
            hold = 0.0;
        g_Tab.StatusSection = SectionNone;
    }

    void Poll(const FRiftHostTabHost& Host, double Now)
    {
        if (Now < g_Tab.NextPollAt)
            return;
        const FHostState& state = g_Tab.State;
        g_Tab.NextPollAt = Now + (state.Valid
            ? (state.Host == 1 ? kPollSeconds : kSlowPollSeconds)
            : (g_Tab.UnansweredPolls >= kFastPollsWithoutAnswer ? kNoAnswerPollSeconds : kPollSeconds));
        bool (*const query)(const char*) = Host.Query ? Host.Query : Host.Exec;
        if (!query || !query("cheat hoststatus"))
            return;
        if (g_Tab.FirstAskAt < 0.0)
            g_Tab.FirstAskAt = Now;
        if (!state.Valid)
            ++g_Tab.UnansweredPolls;
    }

    // ---------------------------------------------------------------- Sending + feedback
    bool Send(const FRiftHostTabHost& Host, int Section, const char* Command, const char* What)
    {
        const bool sent = Host.Exec && Command && *Command && Host.Exec(Command);
        g_Tab.StatusSection = Section;
        g_Tab.StatusError = !sent;
        g_Tab.StatusText = sent ? std::string("Sent: ") + What
                                : std::string("Can't do that right now – are you in a match?");
        g_Tab.StatusUntil = ImGui::GetTime() + (sent ? kStatusOkSeconds : kStatusErrorSeconds);
        if (sent)
            g_Tab.NextPollAt = (std::min)(g_Tab.NextPollAt, ImGui::GetTime() + kAfterActionPollSeconds);
        return sent;
    }

    // One line is always reserved, so nothing jumps when the message comes or goes.
    void DrawStatusLine(int Section)
    {
        if (g_Tab.StatusSection != Section || g_Tab.StatusText.empty() || ImGui::GetTime() >= g_Tab.StatusUntil)
        {
            ImGui::Dummy(ImVec2(1.f, ImGui::GetTextLineHeight()));
            return;
        }
        ImGui::PushStyleColor(ImGuiCol_Text, g_Tab.StatusError ? kError : kHintText);
        ImGui::TextUnformatted(g_Tab.StatusText.c_str());
        ImGui::PopStyleColor();
    }

    // ---------------------------------------------------------------- Building blocks
    ImVec4 AccentOf(const FRiftHostTabHost& Host, float Alpha)
    {
        if (Host.Accent)
            return Host.Accent(Alpha);
        return ImVec4(0.545f, 0.361f, 0.965f, Alpha); // brand violet #8B5CF6
    }

    void Hint(const char* Text, float Width, const ImVec4& Colour = kHintText)
    {
        ImGui::PushStyleColor(ImGuiCol_Text, Colour);
        ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + (std::max)(40.f, Width));
        ImGui::TextUnformatted(Text);
        ImGui::PopTextWrapPos();
        ImGui::PopStyleColor();
    }

    // Grey line right below a checkbox, lined up with its label (same as ControlHint in GUI.cpp).
    void CheckboxHint(const char* Text, float Width)
    {
        const float indent = ImGui::GetFrameHeight() + ImGui::GetStyle().ItemInnerSpacing.x;
        ImGui::SetCursorPosY(ImGui::GetCursorPosY() - 3.f);
        ImGui::Indent(indent);
        Hint(Text, Width - indent);
        ImGui::Unindent(indent);
    }

    void Tooltip(const char* Text)
    {
        if (!Text || !*Text || !ImGui::BeginItemTooltip())
            return;
        ImGui::PushTextWrapPos(ImGui::GetFontSize() * 18.f);
        ImGui::TextUnformatted(Text);
        ImGui::PopTextWrapPos();
        ImGui::EndTooltip();
    }

    struct FButtonSpec
    {
        const char* Label = "";
        const char* Tooltip = nullptr;
        bool Primary = false; // main action: accent background
        bool Active = false; // switch that is on: accent text
        bool Disabled = false;
    };

    // Same look as the Trickshot tab's buttons.
    bool DrawButton(const FRiftHostTabHost& Host, const FButtonSpec& Spec, float Width, float Height)
    {
        int pushed = 0;
        if (Spec.Primary)
        {
            ImGui::PushStyleColor(ImGuiCol_Button, AccentOf(Host, 0.22f));
            ImGui::PushStyleColor(ImGuiCol_ButtonHovered, AccentOf(Host, 0.36f));
            ImGui::PushStyleColor(ImGuiCol_ButtonActive, AccentOf(Host, 0.50f));
            pushed += 3;
        }
        else if (Spec.Active)
        {
            ImGui::PushStyleColor(ImGuiCol_Text, kAccentText);
            ImGui::PushStyleColor(ImGuiCol_Button, AccentOf(Host, 0.18f));
            ImGui::PushStyleColor(ImGuiCol_ButtonHovered, AccentOf(Host, 0.26f));
            pushed += 3;
        }
        ImGui::BeginDisabled(Spec.Disabled);
        const bool pressed = ImGui::Button(Spec.Label, ImVec2(Width, Height));
        ImGui::EndDisabled();
        if (pushed > 0)
            ImGui::PopStyleColor(pushed);
        if (!Spec.Disabled)
            Tooltip(Spec.Tooltip);
        return pressed && !Spec.Disabled;
    }

    bool LabelFits(const char* Label, float Width)
    {
        return ImGui::CalcTextSize(Label, nullptr, true).x + ImGui::GetStyle().FramePadding.x * 2.f + 8.f <= Width;
    }

    // Two buttons side by side if both labels fit, otherwise stacked.
    // 0 = nothing, 1 = first, 2 = second button clicked.
    int DrawButtonPair(const FRiftHostTabHost& Host, const FButtonSpec& First, const FButtonSpec& Second, float Width)
    {
        const float half = (std::max)(1.f, (Width - ImGui::GetStyle().ItemSpacing.x) * 0.5f);
        const bool sideBySide = LabelFits(First.Label, half) && LabelFits(Second.Label, half);
        int clicked = 0;
        if (DrawButton(Host, First, sideBySide ? half : Width, kActionButtonHeight))
            clicked = 1;
        if (sideBySide)
            ImGui::SameLine();
        if (DrawButton(Host, Second, sideBySide ? half : Width, kActionButtonHeight))
            clicked = 2;
        return clicked;
    }

    // Read-only line: dot + text (filled dot = on), like the Bubble Builds status row.
    void StateRow(const char* Text, bool On, const ImVec4& DotColour, float Width)
    {
        const float lineHeight = ImGui::GetTextLineHeight();
        const float radius = 4.5f;
        const float dotSpace = radius * 2.f + 8.f;
        const ImVec2 position = ImGui::GetCursorScreenPos();
        const ImVec2 centre(position.x + radius + 1.f, position.y + lineHeight * 0.5f);
        ImDrawList* drawList = ImGui::GetWindowDrawList();
        if (On)
        {
            drawList->AddCircleFilled(centre, radius + 3.f,
                ImGui::GetColorU32(ImVec4(DotColour.x, DotColour.y, DotColour.z, 0.18f)));
            drawList->AddCircleFilled(centre, radius, ImGui::GetColorU32(DotColour));
        }
        else
        {
            drawList->AddCircle(centre, radius - 0.5f, ImGui::GetColorU32(DotColour), 0, 1.4f);
        }
        ImGui::Indent(dotSpace);
        ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + (std::max)(40.f, Width - dotSpace));
        ImGui::TextUnformatted(Text);
        ImGui::PopTextWrapPos();
        ImGui::Unindent(dotSpace);
    }

    // Framed card with a title and a sentence (lobby, waiting, joined player).
    void NoticeCard(const FRiftHostTabHost& Host, const char* Title, const char* Text, float Width, bool Accent)
    {
        constexpr float padding = 12.f;
        const ImVec2 start = ImGui::GetCursorScreenPos();
        ImDrawList* drawList = ImGui::GetWindowDrawList();
        drawList->ChannelsSplit(2);
        drawList->ChannelsSetCurrent(1);
        ImGui::SetCursorScreenPos(ImVec2(start.x + padding, start.y + padding));
        ImGui::BeginGroup();
        ImGui::PushStyleColor(ImGuiCol_Text, Accent ? kAccentText : kPrimary);
        ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + (std::max)(40.f, Width - padding * 2.f));
        ImGui::TextUnformatted(Title);
        ImGui::PopTextWrapPos();
        ImGui::PopStyleColor();
        Hint(Text, Width - padding * 2.f);
        ImGui::EndGroup();
        const float bottom = ImGui::GetItemRectMax().y + padding;
        drawList->ChannelsSetCurrent(0);
        drawList->AddRectFilled(start, ImVec2(start.x + Width, bottom), ImGui::GetColorU32(kCardBg), 6.f);
        drawList->AddRect(start, ImVec2(start.x + Width, bottom),
            ImGui::GetColorU32(Accent ? AccentOf(Host, 0.55f) : kCardBorder), 6.f, 0, 1.f);
        drawList->ChannelsMerge();
        ImGui::SetCursorScreenPos(ImVec2(start.x, bottom + 8.f));
        ImGui::Dummy(ImVec2(Width, 0.f));
    }

    // Switch backed by the server's state: sends "<Command> on|off", keeps the new value briefly.
    void ServerSwitch(const FRiftHostTabHost& Host, const char* Label, int FHostState::* Field, EField Hold,
        const char* Command, const char* WhatOn, const char* WhatOff, bool Disabled)
    {
        bool value = g_Tab.State.*Field == 1;
        ImGui::BeginDisabled(Disabled);
        const bool changed = ImGui::Checkbox(Label, &value);
        ImGui::EndDisabled();
        if (!changed || Disabled)
            return;
        char command[96];
        std::snprintf(command, sizeof(command), "%s %s", Command, value ? "on" : "off");
        if (Send(Host, SectionRules, command, value ? WhatOn : WhatOff))
        {
            g_Tab.State.*Field = value ? 1 : 0;
            g_Tab.HoldUntil[Hold] = ImGui::GetTime() + kHoldSeconds;
        }
    }

    // ---------------------------------------------------------------- Sections
    void DrawMatchSection(const FRiftHostTabHost& Host, float Width)
    {
        Host.SectionLabel("Match");
        Host.BeginSectionBody();
        const int phase = g_Tab.State.Phase;
        const char* phaseText =
            phase == PhaseJoinable ? "Everyone is on the island – the bus hasn't left yet."
            : phase == PhaseStarted ? "The match is running."
            : phase == PhaseEnded ? "The match is over."
            : "The server is still loading the map.";
        const ImVec4 dot = phase == PhaseStarted ? kSuccess : (phase == PhaseJoinable ? kWarning : kFaintText);
        StateRow(phaseText, phase == PhaseJoinable || phase == PhaseStarted, dot, Width);

        FButtonSpec bus;
        bus.Label = "Start the bus###rift_host_bus";
        bus.Tooltip = "Everyone gets on the battle bus and the match begins.";
        bus.Primary = true;
        bus.Disabled = phase != PhaseJoinable;
        if (DrawButton(Host, bus, Width, kActionButtonHeight))
            Send(Host, SectionMatch, "cheat startaircraft", "Start the bus");
        Hint(phase == PhaseJoinable ? "Wait until your friends are in, then start the bus."
            : "Only while everyone waits on the island before the bus.", Width);
        DrawStatusLine(SectionMatch);
        Host.EndSectionBody();
    }

    void DrawStormSection(const FRiftHostTabHost& Host, float Width)
    {
        Host.SectionLabel("Storm");
        Host.BeginSectionBody();
        const bool running = g_Tab.State.Phase == PhaseStarted;
        const bool paused = g_Tab.State.Storm == 1;

        FButtonSpec pause;
        pause.Label = paused ? "Resume storm###rift_host_storm" : "Pause storm###rift_host_storm";
        pause.Tooltip = "Stops the storm where it is, or lets it move again.";
        pause.Active = paused;
        pause.Disabled = !running;
        FButtonSpec skip;
        skip.Label = "Skip to next zone";
        skip.Tooltip = "The current circle closes right away and the next one starts.";
        skip.Disabled = !running;
        switch (DrawButtonPair(Host, pause, skip, Width))
        {
        case 1:
            if (Send(Host, SectionStorm, paused ? "cheat resumesafezone" : "cheat pausesafezone",
                    paused ? "Resume storm" : "Pause storm"))
            {
                g_Tab.State.Storm = paused ? 0 : 1;
                g_Tab.HoldUntil[FieldStorm] = ImGui::GetTime() + kHoldSeconds;
            }
            break;
        case 2:
            Send(Host, SectionStorm, "cheat skipsafezone", "Skip to next zone");
            break;
        default:
            break;
        }

        FButtonSpec shrink;
        shrink.Label = "Start shrinking now";
        shrink.Tooltip = "The storm starts moving in now instead of waiting.";
        shrink.Disabled = !running;
        if (DrawButton(Host, shrink, Width, kActionButtonHeight))
            Send(Host, SectionStorm, "cheat startshrinksafezone", "Start shrinking now");
        Hint(running ? "Affects everyone in the match." : "Works once the bus has left.", Width);
        DrawStatusLine(SectionStorm);
        Host.EndSectionBody();
    }

    void DrawRulesSection(const FRiftHostTabHost& Host, float Width)
    {
        Host.SectionLabel("Match rules");
        Host.BeginSectionBody();
        const FHostState& state = g_Tab.State;

        ServerSwitch(Host, "Infinite ammo###rift_host_ammo", &FHostState::Ammo, FieldAmmo,
            "cheat infiniteammo", "Infinite ammo on", "Infinite ammo off", false);
        CheckboxHint("Nobody runs out of ammo. For everyone, right away.", Width);
        ServerSwitch(Host, "Infinite materials###rift_host_mats", &FHostState::Mats, FieldMats,
            "cheat infinitemats", "Infinite materials on", "Infinite materials off", false);
        CheckboxHint("Building costs nothing. For everyone, right away.", Width);
        ServerSwitch(Host, "Respawn###rift_host_respawn", &FHostState::Respawn, FieldRespawn,
            "cheat respawns", "Respawn on", "Respawn off", state.RespawnLive == 0);
        CheckboxHint(state.RespawnLive == 0
                ? "On this version it can only change before the match – set it in the launcher profile."
                : "Eliminated players come back after a few seconds.", Width);

        ImGui::Spacing();
        StateRow(state.LateGame ? "Lategame: on" : "Lategame: off", state.LateGame == 1, kCyanText, Width);
        Hint("Change it in the launcher profile before the match.", Width, kFaintText);
        DrawStatusLine(SectionRules);
        Host.EndSectionBody();
    }

    // Item names the server accepts: short names (pump, scar, minis), WIDs and /Game/ paths.
    bool CleanItemName(const char* Input, std::string& Out)
    {
        Out.clear();
        for (const char* c = Input; *c; ++c)
        {
            const unsigned char ch = static_cast<unsigned char>(*c);
            if (ch == ' ' && Out.empty())
                continue;
            if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
                ch == '_' || ch == '.' || ch == '/' || ch == '-')
            {
                Out.push_back(static_cast<char>(ch));
                continue;
            }
            if (ch == ' ')
                break;
            return false;
        }
        return !Out.empty();
    }

    void DrawItemsSection(const FRiftHostTabHost& Host, float Width)
    {
        Host.SectionLabel("Items");
        Host.BeginSectionBody();

        struct FQuickItem { const char* Label; const char* Name; };
        static const FQuickItem items[] = {
            { "Pump shotgun", "pump" }, { "Assault rifle", "scar" },
            { "Tactical shotgun", "tac" }, { "Sniper", "bolt" },
            { "Small shields", "minis" }, { "Bandages", "bandages" },
        };
        for (size_t index = 0; index + 1 < sizeof(items) / sizeof(items[0]); index += 2)
        {
            FButtonSpec first;
            first.Label = items[index].Label;
            FButtonSpec second;
            second.Label = items[index + 1].Label;
            const int clicked = DrawButtonPair(Host, first, second, Width);
            if (clicked != 0)
            {
                const FQuickItem& item = items[index + (clicked - 1)];
                char command[96];
                std::snprintf(command, sizeof(command), "cheat giveitem %s", item.Name);
                Send(Host, SectionItems, command, item.Label);
            }
        }

        // Any item by name.
        const ImGuiStyle& style = ImGui::GetStyle();
        const char* giveLabel = "Give###rift_host_give";
        const float giveWidth = ImGui::CalcTextSize("Give").x + style.FramePadding.x * 2.f + 28.f;
        ImGui::SetNextItemWidth((std::max)(60.f, Width - giveWidth - style.ItemSpacing.x));
        const bool entered = ImGui::InputTextWithHint("##rift_host_item", "Item: pump, scar, minis or a WID",
            g_Tab.ItemName, sizeof(g_Tab.ItemName), ImGuiInputTextFlags_EnterReturnsTrue);
        ImGui::SameLine();
        FButtonSpec give;
        give.Label = giveLabel;
        give.Primary = true;
        if (DrawButton(Host, give, giveWidth, 0.f) || entered)
        {
            std::string name;
            if (!CleanItemName(g_Tab.ItemName, name))
            {
                g_Tab.StatusSection = SectionItems;
                g_Tab.StatusError = true;
                g_Tab.StatusText = "Type a short name like pump, or a WID.";
                g_Tab.StatusUntil = ImGui::GetTime() + kStatusErrorSeconds;
            }
            else
            {
                const std::string command = "cheat giveitem " + name;
                Send(Host, SectionItems, command.c_str(), name.c_str());
            }
        }

        FButtonSpec ammo;
        ammo.Label = "Ammo";
        ammo.Tooltip = "999 of every ammo type.";
        FButtonSpec mats;
        mats.Label = "Materials";
        mats.Tooltip = "500 wood, brick and metal.";
        switch (DrawButtonPair(Host, ammo, mats, Width))
        {
        case 1: Send(Host, SectionItems, "cheat giveammo", "Ammo"); break;
        case 2: Send(Host, SectionItems, "cheat givemats", "Materials"); break;
        default: break;
        }
        FButtonSpec all;
        all.Label = "Ammo, materials and traps";
        if (DrawButton(Host, all, Width, kActionButtonHeight))
            Send(Host, SectionItems, "cheat giveall", "Ammo, materials and traps");
        Hint("Goes to you. An item this version doesn't have is skipped.", Width);
        DrawStatusLine(SectionItems);
        Host.EndSectionBody();
    }

    void DrawHealthSection(const FRiftHostTabHost& Host, float Width)
    {
        Host.SectionLabel("Health");
        Host.BeginSectionBody();
        FButtonSpec me;
        me.Label = "Heal me";
        me.Tooltip = "Full health and full shield for you.";
        me.Primary = true;
        FButtonSpec everyone;
        everyone.Label = "Heal everyone";
        everyone.Tooltip = "Full health and full shield for every player.";
        switch (DrawButtonPair(Host, me, everyone, Width))
        {
        case 1: Send(Host, SectionHealth, "cheat regen", "Heal me"); break;
        case 2: Send(Host, SectionHealth, "cheat regenall", "Heal everyone"); break;
        default: break;
        }
        Hint("Health and shield go back to full.", Width);
        DrawStatusLine(SectionHealth);
        Host.EndSectionBody();
    }

    void DrawTeleportSection(const FRiftHostTabHost& Host, float Width)
    {
        Host.SectionLabel("Teleport");
        Host.BeginSectionBody();
        const bool markAvailable = g_Tab.State.Mark != 2;
        bool mark = g_Tab.State.Mark == 1;
        ImGui::BeginDisabled(!markAvailable);
        if (ImGui::Checkbox("Teleport to my map marker###rift_host_mark", &mark) && markAvailable)
        {
            // "cheat mark" switches it for you only (on <-> off).
            if (Send(Host, SectionTeleport, "cheat mark", mark ? "Marker teleport on" : "Marker teleport off"))
            {
                g_Tab.State.Mark = mark ? 1 : 0;
                g_Tab.HoldUntil[FieldMark] = ImGui::GetTime() + kHoldSeconds;
            }
        }
        ImGui::EndDisabled();
        CheckboxHint(markAvailable ? "Place a marker on the map – you land right there."
                                   : "Not on this Fortnite version.", Width);

        FButtonSpec aim;
        aim.Label = "Teleport where I aim";
        aim.Tooltip = "Takes you to the spot under your crosshair.";
        aim.Primary = true;
        if (DrawButton(Host, aim, Width, kActionButtonHeight))
            Send(Host, SectionTeleport, "cheat tp", "Teleport where I aim");

        FButtonSpec save;
        save.Label = "Save this spot";
        save.Tooltip = "Remembers where you stand now.";
        FButtonSpec back;
        back.Label = "Back to saved spot";
        back.Tooltip = "Takes you back to the saved spot.";
        switch (DrawButtonPair(Host, save, back, Width))
        {
        case 1: Send(Host, SectionTeleport, "cheat s host o", "Save this spot"); break;
        case 2: Send(Host, SectionTeleport, "cheat w host", "Back to saved spot"); break;
        default: break;
        }
        DrawStatusLine(SectionTeleport);
        Host.EndSectionBody();
    }

    void DrawDummySection(const FRiftHostTabHost& Host, float Width)
    {
        Host.SectionLabel("Target dummies");
        Host.BeginSectionBody();
        FButtonSpec place;
        place.Label = "Place a dummy in front of me";
        place.Tooltip = "A standing target bot 30 m in front of you (50 HP).";
        place.Primary = true;
        if (DrawButton(Host, place, Width, kActionButtonHeight))
            Send(Host, SectionDummies, "cheat targetbot", "Place a dummy");

        FButtonSpec bring;
        bring.Label = "Bring dummies to me";
        FButtonSpec remove;
        remove.Label = "Remove all dummies";
        switch (DrawButtonPair(Host, bring, remove, Width))
        {
        case 1: Send(Host, SectionDummies, "cheat tpbot", "Bring dummies to me"); break;
        case 2: Send(Host, SectionDummies, "cheat delbot", "Remove all dummies"); break;
        default: break;
        }
        Hint("Distance and health: Trickshot tab > Target bot.", Width);
        DrawStatusLine(SectionDummies);
        Host.EndSectionBody();
    }

    void DrawAiSection(const FRiftHostTabHost& Host, float Width)
    {
        Host.SectionLabel("AI");
        Host.BeginSectionBody();
        const FHostState& state = g_Tab.State;
        char line[160];

        if (state.Bots == 0)
            std::snprintf(line, sizeof(line), "AI bots: off");
        else if (state.Bots == 2)
            std::snprintf(line, sizeof(line), "AI bots: on – %d bots", state.BotCount);
        else
            std::snprintf(line, sizeof(line), "AI bots: on, but not running in this match");
        StateRow(line, state.Bots != 0, state.Bots == 2 ? kSuccess : (state.Bots == 1 ? kWarning : kFaintText), Width);

        if (state.Living == 0)
            std::snprintf(line, sizeof(line), "Bosses & NPCs: off");
        else if (state.Living == 2)
            std::snprintf(line, sizeof(line), "Bosses & NPCs: on – up to %d at once", state.LivingMax);
        else
            std::snprintf(line, sizeof(line), "Bosses & NPCs: on, not spawning (yet)");
        StateRow(line, state.Living != 0,
            state.Living == 2 ? kSuccess : (state.Living == 1 ? kWarning : kFaintText), Width);

        Hint("Set these in the launcher profile before the match. Why something isn't running: "
             "launcher > Match Control.", Width, kFaintText);
        Host.EndSectionBody();
    }
}

// ==================================================================== Public functions

void RiftHostTab_SetLobbyCheck(bool (*IsInLobby)())
{
    g_LobbyCheck.store(IsInLobby, std::memory_order_release);
}

bool RiftHostTab_PushState(const wchar_t* Text, int Length)
{
    static constexpr wchar_t prefix[] = L"[Rift] HOSTSTATE ";
    constexpr int prefixLength = static_cast<int>(sizeof(prefix) / sizeof(prefix[0])) - 1;
    if (!Text || Length < prefixLength || std::wmemcmp(Text, prefix, static_cast<size_t>(prefixLength)) != 0)
        return false;

    FHostState parsed;
    if (!ParseState(Text, Length, prefixLength, parsed))
        return true; // ours, but broken: still keep it out of the console

    std::unique_lock<std::mutex> lock(g_IncomingMutex, std::try_to_lock);
    if (!lock.owns_lock())
        return true; // the next answer comes in a few seconds
    g_Incoming = parsed;
    ++g_IncomingSerial;
    return true;
}

void RiftHostTab_Draw(const FRiftHostTabHost& Host, float ContentWidth)
{
    if (!Host.SectionLabel || !Host.BeginSectionBody || !Host.EndSectionBody)
        return;

    const float width = (std::max)(120.f, ContentWidth);
    const double now = ImGui::GetTime();
    ResetOnNewSession(Host);
    TakeIncomingState(now);

    ImGui::PushID("RiftHostTab");
    ImGui::Spacing();

    bool (*const isInLobby)() = g_LobbyCheck.load(std::memory_order_acquire);
    if (isInLobby && isInLobby())
    {
        NoticeCard(Host, "You're still in the lobby",
            "Press \"Start match\" on the launcher's Match Control page and join your server. "
            "The host controls show up here once you're in.", width, true);
        ImGui::PopID();
        return;
    }

    Poll(Host, now);

    if (!g_Tab.State.Valid)
    {
        const bool waitedLong = g_Tab.FirstAskAt >= 0.0 && now - g_Tab.FirstAskAt >= kNoAnswerSeconds;
        NoticeCard(Host, waitedLong ? "No answer from the server yet" : "Asking the server...",
            waitedLong ? "The Host tab works in a match on a Rift server. Join your server, then open this tab again."
                       : "One moment – checking whether you're the host of this match.",
            width, false);
        ImGui::PopID();
        return;
    }

    if (g_Tab.State.Host != 1)
    {
        NoticeCard(Host, "Only the host can use this",
            "The host is the player on the PC that runs the server. They can start the bus, change "
            "the storm and the match rules here. Your own tools: the Trickshot tab.",
            width, true);
        ImGui::PopID();
        return;
    }

    DrawMatchSection(Host, width);
    DrawStormSection(Host, width);
    DrawRulesSection(Host, width);
    DrawItemsSection(Host, width);
    DrawHealthSection(Host, width);
    DrawTeleportSection(Host, width);
    DrawDummySection(Host, width);
    DrawAiSection(Host, width);

    ImGui::PopID();
}
