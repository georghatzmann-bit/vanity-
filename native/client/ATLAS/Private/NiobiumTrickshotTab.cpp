// [Rift] New file (GPL-3.0, part of Rift): the "Trickshot" tab in the F9 menu and the
// trickshot banner.
//
// Deliberately without pch.h and without SDK/game headers: only ImGui, the standard library,
// nlohmann/json and, on Windows, <windows.h>/<shlobj.h> for the %LOCALAPPDATA% path. That way a
// preview tool can compile this file on Linux and render screenshots.
// Everything that touches the game goes through FNiobiumTabHost (commands) or NiobiumToast_Push.
//
// Encoding: UTF-8. client.vcxproj builds this file with /utf-8 (the en dashes in the menu
// texts must reach ImGui as UTF-8).
#include "../Public/NiobiumTrickshotTab.h"
#include "../ImGui/imgui.h"
#include "../../third_party/nlohmann/json.hpp"

#include <algorithm>
#include <atomic>
#include <cfloat>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>
#include <system_error>
#include <vector>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <shlobj.h>
#endif

// Guards against a build that reads UTF-8 source but converts it to an 8-bit code page:
// the en dashes in the menu would then be garbled. "–" must arrive as three UTF-8 bytes.
static_assert(sizeof("–") == 4, "NiobiumTrickshotTab.cpp must be built with /utf-8.");

namespace
{
    // ---------------------------------------------------------------- Colours (palette from GUI.cpp)
    constexpr ImVec4 kMuted(0.502f, 0.502f, 0.604f, 1.f); // text-faint #80809A (decoration only)
    constexpr ImVec4 kHintText(0.651f, 0.651f, 0.737f, 1.f); // text-muted #A6A6BC (hints, status)
    constexpr ImVec4 kPrimary(0.957f, 0.957f, 0.973f, 1.f); // brand text #F4F4F8
    constexpr ImVec4 kSecondary(0.58f, 0.60f, 0.66f, 1.f);
    constexpr ImVec4 kError(1.f, 0.39f, 0.43f, 1.f);
    constexpr ImVec4 kCardBg(0.071f, 0.071f, 0.125f, 1.f); // #121220
    constexpr ImVec4 kCardBorder(0.141f, 0.141f, 0.227f, 1.f); // border #24243A
    // Accent for text (brand violet-text #C4B5FD): plain violet is too dark for small text.
    constexpr ImVec4 kAccentText(0.769f, 0.710f, 0.992f, 1.f);

    constexpr float kActionButtonHeight = 28.f;
    constexpr double kStatusOkSeconds = 3.0;
    constexpr double kStatusErrorSeconds = 4.0;
    constexpr double kParkourCheckSeconds = 2.0;
    constexpr size_t kMaxParkourFileBytes = 2u * 1024u * 1024u;
    constexpr size_t kMaxParkours = 64;

    ImVec4 AccentOf(const FNiobiumTabHost& Host, float Alpha)
    {
        if (Host.Accent)
            return Host.Accent(Alpha);
        return ImVec4(0.545f, 0.361f, 0.965f, Alpha); // brand violet #8B5CF6
    }

    // ---------------------------------------------------------------- Parkour file
    struct FParkourEntry
    {
        std::string Id;
        std::string Name;
        std::string Description;
        int Level = 1;
    };

    enum class EParkourFileState
    {
        NotLoaded,
        Missing,
        Broken,
        Loaded
    };

    struct FParkourCache
    {
        std::filesystem::path OverridePath;
        bool HasOverride = false;
        std::filesystem::path DefaultPath;
        bool DefaultResolved = false;
        std::filesystem::file_time_type LastWrite{};
        bool HaveLastWrite = false;
        double NextCheckAt = 0.0;
        EParkourFileState State = EParkourFileState::NotLoaded;
        std::vector<FParkourEntry> Entries;
    };

    FParkourCache g_Parkours;

    std::filesystem::path ResolveDefaultParkourPath()
    {
#if defined(_WIN32)
        wchar_t localAppData[MAX_PATH]{};
        if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, 0, localAppData)) &&
            localAppData[0] != L'\0')
        {
            return std::filesystem::path(localAppData) / L"Rift" / L"server" / L"parkours.json";
        }

        wchar_t environment[MAX_PATH]{};
        const DWORD length = GetEnvironmentVariableW(L"LOCALAPPDATA", environment, MAX_PATH);
        if (length > 0 && length < MAX_PATH)
            return std::filesystem::path(environment) / L"Rift" / L"server" / L"parkours.json";

        return std::filesystem::path(L"parkours.json");
#else
        if (const char* localAppData = std::getenv("LOCALAPPDATA"); localAppData && *localAppData)
            return std::filesystem::path(localAppData) / "Rift" / "server" / "parkours.json";
        return std::filesystem::path("parkours.json");
#endif
    }

    const std::filesystem::path& CurrentParkourPath()
    {
        if (g_Parkours.HasOverride)
            return g_Parkours.OverridePath;
        if (!g_Parkours.DefaultResolved)
        {
            g_Parkours.DefaultPath = ResolveDefaultParkourPath();
            g_Parkours.DefaultResolved = true;
        }
        return g_Parkours.DefaultPath;
    }

    // Only lowercase letters, digits, '-' and '_': the server splits "cheat parkour <id>" at
    // spaces and lowercases everything. Sub-commands can't be parkour ids.
    bool SanitizeParkourId(const std::string& Input, std::string& Output)
    {
        Output.clear();
        if (Input.empty() || Input.size() > 48)
            return false;

        for (char character : Input)
        {
            if (character >= 'A' && character <= 'Z')
                character = static_cast<char>(character - 'A' + 'a');
            const bool allowed =
                (character >= 'a' && character <= 'z') ||
                (character >= '0' && character <= '9') ||
                character == '-' || character == '_';
            if (!allowed)
                return false;
            Output.push_back(character);
        }

        return Output != "retry" && Output != "clear" &&
            Output != "sniper" && Output != "list";
    }

    // Removes control characters and cuts to a sensible length (without splitting a UTF-8 character).
    std::string CleanText(const std::string& Input, size_t MaxBytes, bool KeepNewlines)
    {
        std::string output;
        output.reserve((std::min)(Input.size(), MaxBytes) + 3);
        for (char character : Input)
        {
            const unsigned char byte = static_cast<unsigned char>(character);
            if (byte == '\r')
                continue;
            if (byte == '\n' && KeepNewlines)
            {
                output.push_back('\n');
                continue;
            }
            output.push_back(byte < 0x20 || byte == 0x7F ? ' ' : character);
        }

        if (output.size() > MaxBytes)
        {
            size_t cut = MaxBytes;
            while (cut > 0 && (static_cast<unsigned char>(output[cut]) & 0xC0) == 0x80)
                --cut;
            output.resize(cut);
            output += "...";
        }

        return output;
    }

    std::string StringField(const nlohmann::json& Object, const char* Key)
    {
        const auto found = Object.find(Key);
        if (found == Object.end() || !found->is_string())
            return {};
        return found->get<std::string>();
    }

    int IntField(const nlohmann::json& Object, const char* Key, int Default)
    {
        const auto found = Object.find(Key);
        if (found == Object.end())
            return Default;
        if (found->is_number_integer())
        {
            const long long value = found->get<long long>();
            return static_cast<int>((std::max)(-1000LL, (std::min)(1000LL, value)));
        }
        if (found->is_number_float())
        {
            const double value = found->get<double>();
            if (!std::isfinite(value))
                return Default;
            return static_cast<int>(std::lround((std::max)(-1000.0, (std::min)(1000.0, value))));
        }
        return Default;
    }

    bool ReadWholeFile(const std::filesystem::path& Path, std::string& Output)
    {
        Output.clear();
        std::ifstream input(Path, std::ios::binary);
        if (!input)
            return false;

        char buffer[8192];
        while (input.read(buffer, sizeof(buffer)) || input.gcount() > 0)
        {
            Output.append(buffer, static_cast<size_t>(input.gcount()));
            if (Output.size() > kMaxParkourFileBytes)
                return false;
        }
        return !input.bad();
    }

    // Reads the file. On success it replaces the list; on an error the last good list
    // stays (e.g. while the launcher is rewriting the file).
    void LoadParkours(const std::filesystem::path& Path)
    {
        std::string text;
        if (!ReadWholeFile(Path, text))
        {
            g_Parkours.State = EParkourFileState::Broken;
            return;
        }

        std::vector<FParkourEntry> entries;
        try
        {
            const nlohmann::json root = nlohmann::json::parse(text, nullptr, false);
            if (root.is_discarded() || !root.is_object())
            {
                g_Parkours.State = EParkourFileState::Broken;
                return;
            }

            const auto list = root.find("parkours");
            if (list == root.end() || !list->is_array())
            {
                g_Parkours.State = EParkourFileState::Broken;
                return;
            }

            for (const nlohmann::json& item : *list)
            {
                if (!item.is_object())
                    continue;

                FParkourEntry entry;
                if (!SanitizeParkourId(StringField(item, "id"), entry.Id))
                    continue;

                const bool duplicate = std::any_of(
                    entries.begin(), entries.end(),
                    [&entry](const FParkourEntry& other) { return other.Id == entry.Id; });
                if (duplicate)
                    continue;

                entry.Name = CleanText(StringField(item, "name"), 64, false);
                if (entry.Name.empty())
                    entry.Name = entry.Id;
                entry.Description = CleanText(StringField(item, "description"), 400, true);
                entry.Level = (std::max)(1, (std::min)(3, IntField(item, "level", 1)));

                entries.push_back(std::move(entry));
                if (entries.size() >= kMaxParkours)
                    break;
            }
        }
        catch (...)
        {
            g_Parkours.State = EParkourFileState::Broken;
            return;
        }

        g_Parkours.Entries = std::move(entries);
        g_Parkours.State = EParkourFileState::Loaded;
    }

    // At most every 2 s: does the file exist? New modification time? Then read it again.
    void RefreshParkoursIfNeeded()
    {
        const double now = ImGui::GetTime();
        if (g_Parkours.State != EParkourFileState::NotLoaded && now < g_Parkours.NextCheckAt)
            return;
        g_Parkours.NextCheckAt = now + kParkourCheckSeconds;

        const std::filesystem::path& path = CurrentParkourPath();
        std::error_code error;
        const std::filesystem::file_time_type writeTime =
            std::filesystem::last_write_time(path, error);
        if (error)
        {
            g_Parkours.State = EParkourFileState::Missing;
            g_Parkours.Entries.clear();
            g_Parkours.HaveLastWrite = false;
            return;
        }

        if (g_Parkours.State == EParkourFileState::Loaded &&
            g_Parkours.HaveLastWrite && writeTime == g_Parkours.LastWrite)
        {
            return;
        }

        g_Parkours.LastWrite = writeTime;
        g_Parkours.HaveLastWrite = true;
        LoadParkours(path);
    }

    // ---------------------------------------------------------------- Tab state
    enum ESection
    {
        SectionParkour = 0,
        SectionBot,
        SectionGear,
        SectionPractice
    };

    struct FStatusLine
    {
        int Section = -1;
        std::string AnchorId; // set = the message shows inside this parkour card
        bool Error = false;
        std::string Text;
        double Until = 0.0;
    };

    struct FTabState
    {
        int BotHealth = 50;
        int BotDistance = 30;
        bool SlowMotion = false;
        bool StormPaused = false;
        std::string ActiveParkourId;
        bool HaveSession = false;
        uint64_t Session = 0;
        FStatusLine Status;
    };

    FTabState g_Tab;

    // Set by Client.cpp (NiobiumTrickshotTab_SetLobbyCheck); nullptr = no lobby hint.
    std::atomic<bool (*)()> g_LobbyCheck{ nullptr };

    void ResetTogglesOnNewSession(const FNiobiumTabHost& Host)
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

        if (session != g_Tab.Session)
        {
            // New match: the server world and your character are new, so everything is "off" again.
            g_Tab.Session = session;
            g_Tab.SlowMotion = false;
            g_Tab.StormPaused = false;
            g_Tab.ActiveParkourId.clear();
        }
    }

    // Sends a command and remembers the feedback for the line below the section
    // (or, with AnchorId, for the line inside the clicked parkour card).
    bool Send(const FNiobiumTabHost& Host, int Section, const char* Command, const std::string& What,
        const std::string& AnchorId = std::string())
    {
        const bool sent = Host.Exec && Command && *Command && Host.Exec(Command);
        g_Tab.Status.Section = Section;
        g_Tab.Status.AnchorId = AnchorId;
        g_Tab.Status.Error = !sent;
        g_Tab.Status.Text = sent
            ? "Sent: " + What
            : std::string("Can't do that right now – are you in a match?");
        g_Tab.Status.Until = ImGui::GetTime() + (sent ? kStatusOkSeconds : kStatusErrorSeconds);
        return sent;
    }

    bool StatusVisible(int Section, const std::string& AnchorId)
    {
        const FStatusLine& status = g_Tab.Status;
        return status.Section == Section &&
            status.AnchorId == AnchorId &&
            !status.Text.empty() &&
            ImGui::GetTime() < status.Until;
    }

    // WrapWidth > 0: wrap (inside the card); otherwise one line (below the section).
    void DrawStatusText(float WrapWidth = 0.f)
    {
        ImGui::PushStyleColor(ImGuiCol_Text, g_Tab.Status.Error ? kError : kHintText);
        ImGui::PushTextWrapPos(WrapWidth > 0.f ? ImGui::GetCursorPosX() + WrapWidth : -1.f);
        ImGui::TextUnformatted(g_Tab.Status.Text.c_str());
        ImGui::PopTextWrapPos();
        ImGui::PopStyleColor();
    }

    // One line of space is always reserved so nothing jumps when the message comes or goes.
    void DrawStatusLine(int Section)
    {
        if (!StatusVisible(Section, std::string()))
        {
            ImGui::Dummy(ImVec2(1.f, ImGui::GetTextLineHeight()));
            return;
        }
        DrawStatusText();
    }

    // ---------------------------------------------------------------- Small building blocks
    void Hint(const char* Text, float Width)
    {
        ImGui::PushStyleColor(ImGuiCol_Text, kHintText);
        ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + Width);
        ImGui::TextUnformatted(Text);
        ImGui::PopTextWrapPos();
        ImGui::PopStyleColor();
    }

    void Tooltip(const char* Text)
    {
        if (!Text || !*Text)
            return;
        if (ImGui::BeginItemTooltip())
        {
            ImGui::PushTextWrapPos(ImGui::GetFontSize() * 18.f);
            ImGui::TextUnformatted(Text);
            ImGui::PopTextWrapPos();
            ImGui::EndTooltip();
        }
    }

    float HalfWidth(float Width)
    {
        return (std::max)(1.f, (Width - ImGui::GetStyle().ItemSpacing.x) * 0.5f);
    }

    struct FButtonSpec
    {
        const char* Label = "";
        const char* Tooltip = nullptr;
        bool Primary = false; // main action: accent background
        bool Active = false;  // toggle that is on: accent text
    };

    bool DrawButton(const FNiobiumTabHost& Host, const FButtonSpec& Spec, float Width, float Height)
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

        const bool pressed = ImGui::Button(Spec.Label, ImVec2(Width, Height));
        if (pushed > 0)
            ImGui::PopStyleColor(pushed);
        Tooltip(Spec.Tooltip);
        return pressed;
    }

    bool LabelFits(const char* Label, float Width)
    {
        const ImGuiStyle& style = ImGui::GetStyle();
        return ImGui::CalcTextSize(Label, nullptr, true).x + style.FramePadding.x * 2.f + 8.f <= Width;
    }

    // Two buttons side by side if both labels fit, otherwise stacked.
    // Returns: 0 = nothing, 1 = first, 2 = second button clicked.
    int DrawButtonPair(const FNiobiumTabHost& Host, const FButtonSpec& First, const FButtonSpec& Second, float Width)
    {
        const float half = HalfWidth(Width);
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

    const char* LevelWord(int Level)
    {
        switch (Level)
        {
        case 1: return "easy";
        case 2: return "medium";
        default: return "hard";
        }
    }

    void DrawLevelDots(const FNiobiumTabHost& Host, int Level, float Height)
    {
        constexpr float radius = 4.f;
        constexpr float gap = 5.f;
        const float width = radius * 2.f * 3.f + gap * 2.f;
        const ImVec2 position = ImGui::GetCursorScreenPos();
        ImGui::Dummy(ImVec2(width, Height));

        ImDrawList* drawList = ImGui::GetWindowDrawList();
        const float centerY = position.y + Height * 0.5f;
        for (int index = 0; index < 3; ++index)
        {
            const ImVec2 center(position.x + radius + index * (radius * 2.f + gap), centerY);
            if (index < Level)
                drawList->AddCircleFilled(center, radius, ImGui::GetColorU32(AccentOf(Host, 1.f)));
            else
                drawList->AddCircle(center, radius - 0.5f, ImGui::GetColorU32(kMuted), 0, 1.3f);
        }
    }

    // One card per parkour: name, level as dots, description, "Load" button.
    bool DrawParkourCard(const FNiobiumTabHost& Host, const FParkourEntry& Entry, int Index, float Width)
    {
        ImGui::PushID(Index);

        constexpr float padding = 10.f;
        const ImGuiStyle& style = ImGui::GetStyle();
        const float innerWidth = (std::max)(60.f, Width - padding * 2.f);
        const ImVec2 start = ImGui::GetCursorScreenPos();
        const bool active = !g_Tab.ActiveParkourId.empty() && g_Tab.ActiveParkourId == Entry.Id;

        ImDrawList* drawList = ImGui::GetWindowDrawList();
        drawList->ChannelsSplit(2);
        drawList->ChannelsSetCurrent(1);

        ImGui::SetCursorScreenPos(ImVec2(start.x + padding, start.y + padding));
        ImGui::BeginGroup();
        const float rowRight = start.x + padding + innerWidth;

        // Row 1: name, dots, "easy/medium/hard" ... [Load]
        ImGui::AlignTextToFramePadding();
        ImGui::PushStyleColor(ImGuiCol_Text, kPrimary);
        ImGui::TextUnformatted(Entry.Name.c_str());
        ImGui::PopStyleColor();
        ImGui::SameLine(0.f, 10.f);
        DrawLevelDots(Host, Entry.Level, ImGui::GetFrameHeight());
        ImGui::SameLine(0.f, 6.f);
        ImGui::PushStyleColor(ImGuiCol_Text, kHintText);
        ImGui::TextUnformatted(LevelWord(Entry.Level));
        ImGui::PopStyleColor();

        const char* loadLabel = "Load";
        const float loadWidth = ImGui::CalcTextSize(loadLabel).x + style.FramePadding.x * 2.f + 28.f;
        const float loadX = rowRight - loadWidth;
        if (ImGui::GetItemRectMax().x + style.ItemSpacing.x <= loadX)
        {
            ImGui::SameLine();
            ImGui::SetCursorScreenPos(ImVec2(loadX, ImGui::GetCursorScreenPos().y));
        }
        FButtonSpec load;
        load.Label = loadLabel;
        load.Tooltip = "Builds the course around you and puts you at the start.";
        load.Primary = true;
        const bool pressed = DrawButton(Host, load, loadWidth, 0.f);

        // Row 2: description
        if (!Entry.Description.empty())
        {
            ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + innerWidth);
            ImGui::PushStyleColor(ImGuiCol_Text, kSecondary);
            ImGui::TextUnformatted(Entry.Description.c_str());
            ImGui::PopStyleColor();
            ImGui::PopTextWrapPos();
        }

        // Feedback for the "Load" click right inside the card, so you see it.
        if (StatusVisible(SectionParkour, Entry.Id))
            DrawStatusText(innerWidth);
        ImGui::EndGroup();

        const float bottom = ImGui::GetItemRectMax().y + padding;
        const ImVec2 end(start.x + Width, bottom);
        drawList->ChannelsSetCurrent(0);
        drawList->AddRectFilled(start, end, ImGui::GetColorU32(kCardBg), 6.f);
        drawList->AddRect(
            start, end,
            ImGui::GetColorU32(active ? AccentOf(Host, 0.70f) : kCardBorder),
            6.f, 0, active ? 1.5f : 1.f);
        drawList->ChannelsMerge();

        ImGui::SetCursorScreenPos(ImVec2(start.x, bottom));
        ImGui::Dummy(ImVec2(Width, 0.f));

        ImGui::PopID();
        return pressed;
    }

    // ---------------------------------------------------------------- Sections
    void DrawParkourSection(const FNiobiumTabHost& Host, float Width)
    {
        Host.SectionLabel("Load a parkour");
        Host.BeginSectionBody();

        Hint("Pick a course. You start at the beginning and get a sniper.", Width);

        if (!g_Parkours.Entries.empty())
        {
            for (size_t index = 0; index < g_Parkours.Entries.size(); ++index)
            {
                const FParkourEntry& entry = g_Parkours.Entries[index];
                if (DrawParkourCard(Host, entry, static_cast<int>(index), Width))
                {
                    char command[96];
                    std::snprintf(command, sizeof(command), "cheat parkour %s", entry.Id.c_str());
                    if (Send(Host, SectionParkour, command, "load \"" + entry.Name + "\"", entry.Id))
                        g_Tab.ActiveParkourId = entry.Id;
                }
            }
        }
        else
        {
            Hint(g_Parkours.State == EParkourFileState::Broken
                    ? "The parkour list is broken – restart the server from the Rift launcher."
                    : "No parkours found – start the server from the Rift launcher.",
                Width);
        }

        ImGui::Spacing();
        FButtonSpec retry;
        retry.Label = "Start over";
        retry.Tooltip = "Takes you back to the start. Refills your health and reloads your weapons.";
        FButtonSpec clear;
        clear.Label = "Clear everything";
        clear.Tooltip = "Removes all parkour pieces and all target bots.";
        switch (DrawButtonPair(Host, retry, clear, Width))
        {
        case 1:
            Send(Host, SectionParkour, "cheat parkour retry", "Start over");
            break;
        case 2:
            if (Send(Host, SectionParkour, "cheat parkour clear", "Clear everything"))
                g_Tab.ActiveParkourId.clear();
            break;
        default:
            break;
        }

        DrawStatusLine(SectionParkour);
        Host.EndSectionBody();
    }

    void DrawTargetBotSection(const FNiobiumTabHost& Host, float Width)
    {
        Host.SectionLabel("Target bot");
        Host.BeginSectionBody();

        Hint("A bot that stands still in front of you – great for aiming.", Width);

        // Two sliders side by side: first the headings, then the sliders (same height).
        const float half = HalfWidth(Width);
        const float rightColumnX = ImGui::GetCursorPosX() + half + ImGui::GetStyle().ItemSpacing.x;
        ImGui::TextUnformatted("Health");
        ImGui::SameLine(0.f, 0.f);
        ImGui::SetCursorPosX(rightColumnX);
        ImGui::TextUnformatted("Distance");
        ImGui::SetNextItemWidth(half);
        ImGui::SliderInt("##rift_bot_health", &g_Tab.BotHealth, 1, 200, "%d", ImGuiSliderFlags_AlwaysClamp);
        Tooltip("How much health the bot has. Ctrl + click: type a number.");
        ImGui::SameLine();
        ImGui::SetNextItemWidth(half);
        ImGui::SliderInt("##rift_bot_distance", &g_Tab.BotDistance, 5, 100, "%d m", ImGuiSliderFlags_AlwaysClamp);
        Tooltip("How far in front of you the bot stands. Ctrl + click: type a number.");

        g_Tab.BotHealth = (std::max)(1, (std::min)(200, g_Tab.BotHealth));
        g_Tab.BotDistance = (std::max)(5, (std::min)(100, g_Tab.BotDistance));

        FButtonSpec place;
        place.Label = "Place bot in front of me";
        place.Tooltip = "Places a bot with this health at this distance in front of you.";
        place.Primary = true;
        if (DrawButton(Host, place, Width, kActionButtonHeight))
        {
            char command[64];
            std::snprintf(command, sizeof(command), "cheat targetbot %d %d", g_Tab.BotHealth, g_Tab.BotDistance);
            Send(Host, SectionBot, command,
                "place bot (" + std::to_string(g_Tab.BotHealth) + " health, " +
                    std::to_string(g_Tab.BotDistance) + " m)");
        }

        FButtonSpec removeAll;
        removeAll.Label = "Remove all bots";
        removeAll.Tooltip = "Removes all bots.";
        FButtonSpec bringAll;
        bringAll.Label = "Bring bots to me";
        bringAll.Tooltip = "Brings all bots to you.";
        switch (DrawButtonPair(Host, removeAll, bringAll, Width))
        {
        case 1:
            Send(Host, SectionBot, "cheat delbot", "Remove all bots");
            break;
        case 2:
            Send(Host, SectionBot, "cheat tpbot", "Bring bots to me");
            break;
        default:
            break;
        }

        DrawStatusLine(SectionBot);
        Host.EndSectionBody();
    }

    void DrawGearSection(const FNiobiumTabHost& Host, float Width)
    {
        Host.SectionLabel("Gear");
        Host.BeginSectionBody();

        FButtonSpec sniper;
        sniper.Label = "Give sniper";
        sniper.Tooltip = "Puts a sniper in your inventory.";
        FButtonSpec pads;
        pads.Label = "Give launch pads";
        pads.Tooltip = "Gives you launch pads and other traps to place.";
        switch (DrawButtonPair(Host, sniper, pads, Width))
        {
        case 1:
            Send(Host, SectionGear, "cheat parkour sniper", "Give sniper");
            break;
        case 2:
            Send(Host, SectionGear, "cheat givetraps", "Give launch pads");
            break;
        default:
            break;
        }

        FButtonSpec ammo;
        ammo.Label = "Refill ammo";
        ammo.Tooltip = "Refills your ammo.";
        FButtonSpec health;
        health.Label = "Refill health";
        health.Tooltip = "Fills your health and shield back up.";
        switch (DrawButtonPair(Host, ammo, health, Width))
        {
        case 1:
            Send(Host, SectionGear, "cheat giveammo", "Refill ammo");
            break;
        case 2:
            Send(Host, SectionGear, "cheat regen", "Refill health");
            break;
        default:
            break;
        }

        DrawStatusLine(SectionGear);
        Host.EndSectionBody();
    }

    void DrawPracticeSection(const FNiobiumTabHost& Host, float Width)
    {
        Host.SectionLabel("Practice");
        Host.BeginSectionBody();

        Hint("Save a spot and jump back to it with one click.", Width);

        FButtonSpec save;
        save.Label = "Save spot";
        save.Tooltip = "Remembers where you are standing right now.";
        FButtonSpec back;
        back.Label = "Back to spot";
        back.Tooltip = "Takes you straight back to the saved spot.";
        // The waypoint name "rift" is shared with the launcher's match page (MatchPage.tsx),
        // so a spot saved there can be reached from here and the other way round. Change both
        // together. "s"/"w" are Magnesium's waypoint cheats; the phrase is just a free name.
        switch (DrawButtonPair(Host, save, back, Width))
        {
        case 1:
            Send(Host, SectionPractice, "cheat s rift o", "Save spot");
            break;
        case 2:
            Send(Host, SectionPractice, "cheat w rift", "Back to spot");
            break;
        default:
            break;
        }

        FButtonSpec launch;
        launch.Label = "Launch me up";
        launch.Tooltip = "Shoots you straight up into the air.";
        FButtonSpec slowMotion;
        slowMotion.Label = g_Tab.SlowMotion ? "Slow motion: on###rift_slowmo" : "Slow motion: off###rift_slowmo";
        slowMotion.Tooltip = "The whole match runs at half speed. Click again for normal speed.";
        slowMotion.Active = g_Tab.SlowMotion;
        switch (DrawButtonPair(Host, launch, slowMotion, Width))
        {
        case 1:
            Send(Host, SectionPractice, "cheat l 2500", "Launch me up");
            break;
        case 2:
            if (g_Tab.SlowMotion)
            {
                if (Send(Host, SectionPractice, "cheat demospeed 1", "Slow motion off"))
                    g_Tab.SlowMotion = false;
            }
            else if (Send(Host, SectionPractice, "cheat demospeed 0.5", "Slow motion on"))
            {
                g_Tab.SlowMotion = true;
            }
            break;
        default:
            break;
        }

        // Two fixed buttons instead of a toggle: the server sets gravity only for your
        // current character. After you die it is normal again without the menu
        // noticing - an "on/off" toggle would then show the wrong state.
        FButtonSpec lowGravity;
        lowGravity.Label = "Low gravity";
        lowGravity.Tooltip = "You jump higher and fall slower. Back to normal after you die.";
        FButtonSpec normalGravity;
        normalGravity.Label = "Normal gravity";
        normalGravity.Tooltip = "Sets gravity back to normal.";
        switch (DrawButtonPair(Host, lowGravity, normalGravity, Width))
        {
        case 1:
            Send(Host, SectionPractice, "cheat gravity 0.4", "Low gravity");
            break;
        case 2:
            Send(Host, SectionPractice, "cheat gravity 1", "Normal gravity");
            break;
        default:
            break;
        }

        FButtonSpec god;
        god.Label = "Invincible on/off";
        god.Tooltip = "Click once: you take no damage. Click again: back to normal.";
        FButtonSpec storm;
        storm.Label = g_Tab.StormPaused ? "Resume storm###rift_storm" : "Pause storm###rift_storm";
        storm.Tooltip = "Pauses the storm or lets it move again.";
        storm.Active = g_Tab.StormPaused;
        switch (DrawButtonPair(Host, god, storm, Width))
        {
        case 1:
            Send(Host, SectionPractice, "cheat god", "Invincible on/off");
            break;
        case 2:
            if (g_Tab.StormPaused)
            {
                if (Send(Host, SectionPractice, "cheat resumesafezone", "Resume storm"))
                    g_Tab.StormPaused = false;
            }
            else if (Send(Host, SectionPractice, "cheat pausesafezone", "Pause storm"))
            {
                g_Tab.StormPaused = true;
            }
            break;
        default:
            break;
        }

        Hint("Slow motion and the storm affect everyone in the match.", Width);
        DrawStatusLine(SectionPractice);
        Host.EndSectionBody();
    }

    // ---------------------------------------------------------------- Banner
    constexpr int kToastCapacity = 256;
    constexpr float kToastSeconds = 3.5f;

    std::mutex g_ToastMutex;
    wchar_t g_ToastText[kToastCapacity]{};
    int g_ToastLength = 0;
    uint32_t g_ToastSerial = 0;

    struct FToastView
    {
        uint32_t SeenSerial = 0;
        bool Active = false;
        double StartTime = 0.0;
        std::string Title;
        std::string Subtitle;
    };

    FToastView g_Toast;

    void AppendUtf8(std::string& Output, uint32_t CodePoint)
    {
        if (CodePoint < 0x80)
        {
            Output.push_back(static_cast<char>(CodePoint));
        }
        else if (CodePoint < 0x800)
        {
            Output.push_back(static_cast<char>(0xC0 | (CodePoint >> 6)));
            Output.push_back(static_cast<char>(0x80 | (CodePoint & 0x3F)));
        }
        else if (CodePoint < 0x10000)
        {
            Output.push_back(static_cast<char>(0xE0 | (CodePoint >> 12)));
            Output.push_back(static_cast<char>(0x80 | ((CodePoint >> 6) & 0x3F)));
            Output.push_back(static_cast<char>(0x80 | (CodePoint & 0x3F)));
        }
        else
        {
            Output.push_back(static_cast<char>(0xF0 | (CodePoint >> 18)));
            Output.push_back(static_cast<char>(0x80 | ((CodePoint >> 12) & 0x3F)));
            Output.push_back(static_cast<char>(0x80 | ((CodePoint >> 6) & 0x3F)));
            Output.push_back(static_cast<char>(0x80 | (CodePoint & 0x3F)));
        }
    }

    // wchar_t is UTF-16 on Windows and UTF-32 on Linux (preview).
    std::string WideToUtf8(const wchar_t* Text, int Length)
    {
        std::string output;
        output.reserve(static_cast<size_t>(Length) * 3);
        for (int index = 0; index < Length; ++index)
        {
            uint32_t codePoint = static_cast<uint32_t>(Text[index]);
            if constexpr (sizeof(wchar_t) == 2)
            {
                codePoint &= 0xFFFF;
                if (codePoint >= 0xD800 && codePoint <= 0xDBFF && index + 1 < Length)
                {
                    const uint32_t low = static_cast<uint32_t>(Text[index + 1]) & 0xFFFF;
                    if (low >= 0xDC00 && low <= 0xDFFF)
                    {
                        codePoint = 0x10000 + ((codePoint - 0xD800) << 10) + (low - 0xDC00);
                        ++index;
                    }
                }
            }
            if (codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF))
                codePoint = 0xFFFD;
            if (codePoint < 0x20 || codePoint == 0x7F)
                codePoint = ' ';
            AppendUtf8(output, codePoint);
        }
        return output;
    }

    std::string Trim(const std::string& Text)
    {
        const size_t first = Text.find_first_not_of(' ');
        if (first == std::string::npos)
            return {};
        const size_t last = Text.find_last_not_of(' ');
        return Text.substr(first, last - first + 1);
    }

    // "[Rift] TRICKSHOT! player – 87 m" -> title "TRICKSHOT!", subtitle "player – 87 m".
    void BuildToastText(const wchar_t* Text, int Length)
    {
        // An en dash from a server built without /utf-8 arrives as "â€“".
        std::wstring repaired(Text, static_cast<size_t>(Length));
        const wchar_t broken[] = { static_cast<wchar_t>(0x00E2), static_cast<wchar_t>(0x20AC), static_cast<wchar_t>(0x201C), 0 };
        for (size_t found = repaired.find(broken); found != std::wstring::npos; found = repaired.find(broken, found + 1))
            repaired.replace(found, 3, 1, static_cast<wchar_t>(0x2013));

        std::string message = Trim(WideToUtf8(repaired.c_str(), static_cast<int>(repaired.size())));
        static const char niobiumPrefix[] = "[Rift]";
        if (message.compare(0, sizeof(niobiumPrefix) - 1, niobiumPrefix) == 0)
            message = Trim(message.substr(sizeof(niobiumPrefix) - 1));

        static const char trickshot[] = "TRICKSHOT";
        if (message.compare(0, sizeof(trickshot) - 1, trickshot) == 0)
        {
            std::string rest = message.substr(sizeof(trickshot) - 1);
            size_t skip = 0;
            while (skip < rest.size() && (rest[skip] == '!' || rest[skip] == ' ' || rest[skip] == ':'))
                ++skip;
            g_Toast.Title = "TRICKSHOT!";
            g_Toast.Subtitle = CleanText(Trim(rest.substr(skip)), 96, false);
        }
        else
        {
            g_Toast.Title = CleanText(message, 96, false);
            g_Toast.Subtitle.clear();
        }
    }

    float Clamp01(float Value)
    {
        return Value < 0.f ? 0.f : (Value > 1.f ? 1.f : Value);
    }

    float EaseOutBack(float Value)
    {
        constexpr float c1 = 1.70158f;
        constexpr float c3 = c1 + 1.f;
        const float x = Value - 1.f;
        return 1.f + c3 * x * x * x + c1 * x * x;
    }

    ImU32 Color(float R, float G, float B, float A)
    {
        return ImGui::ColorConvertFloat4ToU32(ImVec4(R, G, B, Clamp01(A)));
    }
}

// ==================================================================== Public functions

void NiobiumTrickshotTab_SetParkourFile(const wchar_t* Path)
{
    if (Path && *Path)
    {
        g_Parkours.OverridePath = std::filesystem::path(Path);
        g_Parkours.HasOverride = true;
    }
    else
    {
        g_Parkours.OverridePath.clear();
        g_Parkours.HasOverride = false;
    }

    g_Parkours.State = EParkourFileState::NotLoaded;
    g_Parkours.HaveLastWrite = false;
    g_Parkours.Entries.clear();
}

void NiobiumTrickshotTab_SetLobbyCheck(bool (*IsInLobby)())
{
    g_LobbyCheck.store(IsInLobby, std::memory_order_release);
}

void NiobiumTrickshotTab_Draw(const FNiobiumTabHost& Host, float ContentWidth)
{
    if (!Host.SectionLabel || !Host.BeginSectionBody || !Host.EndSectionBody)
        return;

    const float width = (std::max)(120.f, ContentWidth);
    ResetTogglesOnNewSession(Host);
    RefreshParkoursIfNeeded();

    ImGui::PushID("NiobiumTrickshotTab");

    bool (*const isInLobby)() = g_LobbyCheck.load(std::memory_order_acquire);
    if (isInLobby && isInLobby())
    {
        ImGui::Spacing();
        ImGui::PushStyleColor(ImGuiCol_Text, kAccentText);
        ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + width);
        ImGui::TextUnformatted("You're still in the lobby. Start a match first – then these buttons work.");
        ImGui::PopTextWrapPos();
        ImGui::PopStyleColor();
    }

    DrawParkourSection(Host, width);
    DrawTargetBotSection(Host, width);
    DrawGearSection(Host, width);
    DrawPracticeSection(Host, width);

    ImGui::PopID();
}

void NiobiumToast_Push(const wchar_t* Text, int Length)
{
    if (!Text || Length <= 0)
        return;

    // First line only; the banner never shows long texts.
    int count = 0;
    while (count < Length && count < kToastCapacity - 1 &&
        Text[count] != L'\0' && Text[count] != L'\n' && Text[count] != L'\r')
    {
        ++count;
    }
    if (count == 0)
        return;

    // Game thread: never wait. If the lock is busy right now, this banner is skipped.
    std::unique_lock<std::mutex> lock(g_ToastMutex, std::try_to_lock);
    if (!lock.owns_lock())
        return;

    std::wmemcpy(g_ToastText, Text, static_cast<size_t>(count));
    g_ToastText[count] = L'\0';
    g_ToastLength = count;
    ++g_ToastSerial;
}

void NiobiumToast_Draw()
{
    wchar_t pending[kToastCapacity];
    int pendingLength = 0;
    bool fresh = false;
    {
        std::unique_lock<std::mutex> lock(g_ToastMutex, std::try_to_lock);
        if (lock.owns_lock() && g_ToastSerial != g_Toast.SeenSerial)
        {
            g_Toast.SeenSerial = g_ToastSerial;
            pendingLength = (std::max)(0, (std::min)(g_ToastLength, kToastCapacity - 1));
            std::wmemcpy(pending, g_ToastText, static_cast<size_t>(pendingLength));
            fresh = pendingLength > 0;
        }
    }

    const double now = ImGui::GetTime();
    if (fresh)
    {
        BuildToastText(pending, pendingLength);
        g_Toast.StartTime = now;
        g_Toast.Active = !g_Toast.Title.empty();
    }
    if (!g_Toast.Active)
        return;

    const float elapsed = static_cast<float>(now - g_Toast.StartTime);
    if (elapsed < 0.f || elapsed >= kToastSeconds)
    {
        g_Toast.Active = false;
        return;
    }

    const ImGuiIO& io = ImGui::GetIO();
    const ImVec2 display = io.DisplaySize;
    ImFont* font = ImGui::GetFont();
    if (!font || display.x < 64.f || display.y < 64.f)
        return;

    // Pop in (0.22 s, slight overshoot), then hold, fade out during the last 0.6 s.
    const float appear = Clamp01(elapsed / 0.22f);
    const float scale = 0.70f + 0.30f * EaseOutBack(appear);
    float alpha = Clamp01(elapsed / 0.15f);
    alpha = alpha * alpha * (3.f - 2.f * alpha);
    if (elapsed > kToastSeconds - 0.6f)
        alpha *= Clamp01((kToastSeconds - elapsed) / 0.6f);
    if (alpha <= 0.f)
        return;

    const float base = (std::max)(36.f, (std::min)(84.f, display.y * 0.065f));
    const float titleSize = base * scale;
    const float subtitleSize = (std::max)(16.f, base * 0.40f) * scale;
    const char* title = g_Toast.Title.c_str();
    const char* subtitle = g_Toast.Subtitle.c_str();
    const bool hasSubtitle = !g_Toast.Subtitle.empty();

    const ImVec2 titleExtent = font->CalcTextSizeA(titleSize, FLT_MAX, 0.f, title);
    const ImVec2 subtitleExtent = hasSubtitle
        ? font->CalcTextSizeA(subtitleSize, FLT_MAX, 0.f, subtitle)
        : ImVec2(0.f, 0.f);

    const float strip = (std::max)(3.f, 6.f * scale);
    const float padX = base * 0.60f * scale;
    const float padY = base * 0.26f * scale;
    const float gap = hasSubtitle ? base * 0.06f * scale : 0.f;
    float panelWidth = (std::max)(titleExtent.x, subtitleExtent.x) + padX * 2.f + strip;
    panelWidth = (std::max)(panelWidth, base * 6.f * scale);
    panelWidth = (std::min)(panelWidth, display.x - 32.f);
    const float panelHeight = padY * 2.f + titleExtent.y + gap + subtitleExtent.y;

    const ImVec2 center(display.x * 0.5f, display.y * 0.26f);
    const ImVec2 panelMin(std::floor(center.x - panelWidth * 0.5f), std::floor(center.y - panelHeight * 0.5f));
    const ImVec2 panelMax(panelMin.x + panelWidth, panelMin.y + panelHeight);
    const float rounding = 10.f * scale;

    // Brand colours: violet #8B5CF6 for glow, border and strip, a neon cyan #22D3EE glow underneath
    // and cyan-text #67E8F9 for the title (the "light" colour of the brand, 13:1 on the panel).
    constexpr float accentR = 0.545f;
    constexpr float accentG = 0.361f;
    constexpr float accentB = 0.965f;
    constexpr float blueR = 0.133f;
    constexpr float blueG = 0.827f;
    constexpr float blueB = 0.933f;
    constexpr float goldR = 0.404f;
    constexpr float goldG = 0.910f;
    constexpr float goldB = 0.976f;

    ImDrawList* drawList = ImGui::GetForegroundDrawList();

    // soft glow, dark panel, thin border, accent strip on the left
    drawList->AddRectFilled(
        ImVec2(panelMin.x - 14.f, panelMin.y - 10.f), ImVec2(panelMax.x + 14.f, panelMax.y + 14.f),
        Color(blueR, blueG, blueB, 0.07f * alpha), rounding + 12.f);
    drawList->AddRectFilled(
        ImVec2(panelMin.x - 8.f, panelMin.y - 8.f), ImVec2(panelMax.x + 8.f, panelMax.y + 8.f),
        Color(accentR, accentG, accentB, 0.12f * alpha), rounding + 8.f);
    drawList->AddRectFilled(
        ImVec2(panelMin.x + 2.f, panelMin.y + 5.f), ImVec2(panelMax.x + 2.f, panelMax.y + 5.f),
        Color(0.f, 0.f, 0.f, 0.35f * alpha), rounding);
    drawList->AddRectFilled(panelMin, panelMax, Color(0.027f, 0.027f, 0.047f, 0.94f * alpha), rounding);
    drawList->AddRect(panelMin, panelMax, Color(accentR, accentG, accentB, 0.55f * alpha), rounding, 0, 1.5f);
    drawList->AddRectFilled(
        panelMin, ImVec2(panelMin.x + strip, panelMax.y),
        Color(accentR, accentG, accentB, alpha), rounding, ImDrawFlags_RoundCornersLeft);

    const float contentCenterX = (panelMin.x + strip + panelMax.x) * 0.5f;
    const ImVec4 clip(panelMin.x + strip, panelMin.y, panelMax.x, panelMax.y);

    const ImVec2 titlePosition(std::floor(contentCenterX - titleExtent.x * 0.5f), std::floor(panelMin.y + padY));
    const float bold = (std::max)(1.f, titleSize * 0.02f);
    drawList->AddText(font, titleSize, ImVec2(titlePosition.x, titlePosition.y + 2.f),
        Color(0.f, 0.f, 0.f, 0.55f * alpha), title, nullptr, 0.f, &clip);
    drawList->AddText(font, titleSize, titlePosition,
        Color(goldR, goldG, goldB, alpha), title, nullptr, 0.f, &clip);
    drawList->AddText(font, titleSize, ImVec2(titlePosition.x + bold, titlePosition.y),
        Color(goldR, goldG, goldB, alpha), title, nullptr, 0.f, &clip);

    if (hasSubtitle)
    {
        const ImVec2 subtitlePosition(
            std::floor(contentCenterX - subtitleExtent.x * 0.5f),
            std::floor(titlePosition.y + titleExtent.y + gap));
        drawList->AddText(font, subtitleSize, subtitlePosition,
            Color(0.957f, 0.957f, 0.973f, alpha), subtitle, nullptr, 0.f, &clip);
    }
}
