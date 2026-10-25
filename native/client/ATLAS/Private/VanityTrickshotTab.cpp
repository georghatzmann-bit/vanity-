// [Vanity] Neue Datei (GPL-3.0, Teil von Vanity): Reiter "Trickshot" im F9-Menue und das
// Trickshot-Banner.
//
// Bewusst ohne pch.h und ohne SDK-/Spiel-Header: nur ImGui, die Standardbibliothek, nlohmann/json
// und unter Windows <windows.h>/<shlobj.h> fuer den %LOCALAPPDATA%-Pfad. So kann ein
// Vorschau-Werkzeug die Datei unter Linux kompilieren und Bildschirmfotos rendern.
// Alles, was das Spiel betrifft, laeuft ueber FVanityTabHost (Befehle) bzw. VanityToast_Push.
//
// Kodierung: UTF-8. client.vcxproj baut diese Datei mit /utf-8 (deutsche Texte fuer ImGui).
#include "../Public/VanityTrickshotTab.h"
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

// Schuetzt vor einem Build, der UTF-8-Quelltext einliest, aber in eine 8-Bit-Codepage uebersetzt:
// dann waeren die Umlaute im Menue kaputt. "ü" muss als zwei UTF-8-Bytes ankommen.
static_assert(sizeof("ü") == 3, "VanityTrickshotTab.cpp muss mit /utf-8 gebaut werden.");

namespace
{
    // ---------------------------------------------------------------- Farben (Palette aus GUI.cpp)
    constexpr ImVec4 kMuted(0.353f, 0.388f, 0.478f, 1.f);
    constexpr ImVec4 kPrimary(0.847f, 0.878f, 0.941f, 1.f);
    constexpr ImVec4 kSecondary(0.58f, 0.60f, 0.66f, 1.f);
    constexpr ImVec4 kError(1.f, 0.39f, 0.43f, 1.f);
    constexpr ImVec4 kCardBg(0.078f, 0.096f, 0.141f, 1.f);
    constexpr ImVec4 kCardBorder(0.137f, 0.165f, 0.243f, 1.f);

    constexpr float kActionButtonHeight = 28.f;
    constexpr double kStatusOkSeconds = 3.0;
    constexpr double kStatusErrorSeconds = 4.0;
    constexpr double kParkourCheckSeconds = 2.0;
    constexpr size_t kMaxParkourFileBytes = 2u * 1024u * 1024u;
    constexpr size_t kMaxParkours = 64;

    ImVec4 AccentOf(const FVanityTabHost& Host, float Alpha)
    {
        if (Host.Accent)
            return Host.Accent(Alpha);
        return ImVec4(0.f, 0.635f, 0.808f, Alpha);
    }

    // ---------------------------------------------------------------- Parkour-Datei
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
            return std::filesystem::path(localAppData) / L"Vanity" / L"server" / L"parkours.json";
        }

        wchar_t environment[MAX_PATH]{};
        const DWORD length = GetEnvironmentVariableW(L"LOCALAPPDATA", environment, MAX_PATH);
        if (length > 0 && length < MAX_PATH)
            return std::filesystem::path(environment) / L"Vanity" / L"server" / L"parkours.json";

        return std::filesystem::path(L"parkours.json");
#else
        if (const char* localAppData = std::getenv("LOCALAPPDATA"); localAppData && *localAppData)
            return std::filesystem::path(localAppData) / "Vanity" / "server" / "parkours.json";
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

    // Nur Kleinbuchstaben, Ziffern, '-' und '_': der Server trennt "cheat parkour <id>" an
    // Leerzeichen und schreibt alles klein. Unterbefehle duerfen keine Parkour-Id sein.
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

    // Steuerzeichen raus, auf eine sinnvolle Laenge kuerzen (ohne ein UTF-8-Zeichen zu zerschneiden).
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

    // Liest die Datei. Bei Erfolg ersetzt sie die Liste; bei einem Fehler bleibt die letzte gute
    // Liste stehen (z. B. wenn der Launcher die Datei gerade neu schreibt).
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

    // Hoechstens alle 2 s: Datei da? Neue Aenderungszeit? Dann neu einlesen.
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

    // ---------------------------------------------------------------- Zustand des Reiters
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
        std::string AnchorId; // gesetzt = Meldung erscheint in dieser Parkour-Karte
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

    // Von Client.cpp gesetzt (VanityTrickshotTab_SetLobbyCheck); nullptr = kein Lobby-Hinweis.
    std::atomic<bool (*)()> g_LobbyCheck{ nullptr };

    void ResetTogglesOnNewSession(const FVanityTabHost& Host)
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
            // Neues Match: Server-Welt und Spielfigur sind neu, also alles wieder "aus".
            g_Tab.Session = session;
            g_Tab.SlowMotion = false;
            g_Tab.StormPaused = false;
            g_Tab.ActiveParkourId.clear();
        }
    }

    // Schickt einen Befehl und merkt sich die Rueckmeldung fuer die Zeile unter dem Abschnitt
    // (oder, mit AnchorId, fuer die Zeile in der angeklickten Parkour-Karte).
    bool Send(const FVanityTabHost& Host, int Section, const char* Command, const std::string& What,
        const std::string& AnchorId = std::string())
    {
        const bool sent = Host.Exec && Command && *Command && Host.Exec(Command);
        g_Tab.Status.Section = Section;
        g_Tab.Status.AnchorId = AnchorId;
        g_Tab.Status.Error = !sent;
        g_Tab.Status.Text = sent
            ? "Gesendet: " + What
            : std::string("Geht gerade nicht – bist du schon im Match?");
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

    // WrapWidth > 0: umbrechen (in der Karte); sonst eine Zeile (unter dem Abschnitt).
    void DrawStatusText(float WrapWidth = 0.f)
    {
        ImGui::PushStyleColor(ImGuiCol_Text, g_Tab.Status.Error ? kError : kMuted);
        ImGui::PushTextWrapPos(WrapWidth > 0.f ? ImGui::GetCursorPosX() + WrapWidth : -1.f);
        ImGui::TextUnformatted(g_Tab.Status.Text.c_str());
        ImGui::PopTextWrapPos();
        ImGui::PopStyleColor();
    }

    // Eine Zeile Platz ist immer reserviert, damit nichts springt, wenn die Meldung kommt/geht.
    void DrawStatusLine(int Section)
    {
        if (!StatusVisible(Section, std::string()))
        {
            ImGui::Dummy(ImVec2(1.f, ImGui::GetTextLineHeight()));
            return;
        }
        DrawStatusText();
    }

    // ---------------------------------------------------------------- kleine Bausteine
    void Hint(const char* Text, float Width)
    {
        ImGui::PushStyleColor(ImGuiCol_Text, kMuted);
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
        bool Primary = false; // Hauptaktion: Akzent-Hintergrund
        bool Active = false;  // eingeschalteter Schalter: Akzent-Schrift
    };

    bool DrawButton(const FVanityTabHost& Host, const FButtonSpec& Spec, float Width, float Height)
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
            ImGui::PushStyleColor(ImGuiCol_Text, AccentOf(Host, 1.f));
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

    // Zwei Knoepfe nebeneinander, wenn beide Texte passen, sonst untereinander.
    // Rueckgabe: 0 = nichts, 1 = erster, 2 = zweiter Knopf geklickt.
    int DrawButtonPair(const FVanityTabHost& Host, const FButtonSpec& First, const FButtonSpec& Second, float Width)
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
        case 1: return "leicht";
        case 2: return "mittel";
        default: return "schwer";
        }
    }

    void DrawLevelDots(const FVanityTabHost& Host, int Level, float Height)
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

    // Eine Karte pro Parkour: Name, Stufe als Punkte, Beschreibung, Knopf "Laden".
    bool DrawParkourCard(const FVanityTabHost& Host, const FParkourEntry& Entry, int Index, float Width)
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

        // Zeile 1: Name, Punkte, "leicht/mittel/schwer" ... [Laden]
        ImGui::AlignTextToFramePadding();
        ImGui::PushStyleColor(ImGuiCol_Text, kPrimary);
        ImGui::TextUnformatted(Entry.Name.c_str());
        ImGui::PopStyleColor();
        ImGui::SameLine(0.f, 10.f);
        DrawLevelDots(Host, Entry.Level, ImGui::GetFrameHeight());
        ImGui::SameLine(0.f, 6.f);
        ImGui::PushStyleColor(ImGuiCol_Text, kMuted);
        ImGui::TextUnformatted(LevelWord(Entry.Level));
        ImGui::PopStyleColor();

        const char* loadLabel = "Laden";
        const float loadWidth = ImGui::CalcTextSize(loadLabel).x + style.FramePadding.x * 2.f + 28.f;
        const float loadX = rowRight - loadWidth;
        if (ImGui::GetItemRectMax().x + style.ItemSpacing.x <= loadX)
        {
            ImGui::SameLine();
            ImGui::SetCursorScreenPos(ImVec2(loadX, ImGui::GetCursorScreenPos().y));
        }
        FButtonSpec load;
        load.Label = loadLabel;
        load.Tooltip = "Baut die Strecke um dich herum auf und stellt dich an den Start.";
        load.Primary = true;
        const bool pressed = DrawButton(Host, load, loadWidth, 0.f);

        // Zeile 2: Beschreibung
        if (!Entry.Description.empty())
        {
            ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + innerWidth);
            ImGui::PushStyleColor(ImGuiCol_Text, kSecondary);
            ImGui::TextUnformatted(Entry.Description.c_str());
            ImGui::PopStyleColor();
            ImGui::PopTextWrapPos();
        }

        // Rueckmeldung zum Klick auf "Laden" direkt in der Karte, damit man sie sieht.
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

    // ---------------------------------------------------------------- Abschnitte
    void DrawParkourSection(const FVanityTabHost& Host, float Width)
    {
        Host.SectionLabel("Parkour laden");
        Host.BeginSectionBody();

        Hint("Wähle eine Strecke. Du landest am Start und bekommst eine Sniper.", Width);

        if (!g_Parkours.Entries.empty())
        {
            for (size_t index = 0; index < g_Parkours.Entries.size(); ++index)
            {
                const FParkourEntry& entry = g_Parkours.Entries[index];
                if (DrawParkourCard(Host, entry, static_cast<int>(index), Width))
                {
                    char command[96];
                    std::snprintf(command, sizeof(command), "cheat parkour %s", entry.Id.c_str());
                    if (Send(Host, SectionParkour, command, "„" + entry.Name + "“ laden", entry.Id))
                        g_Tab.ActiveParkourId = entry.Id;
                }
            }
        }
        else
        {
            Hint(g_Parkours.State == EParkourFileState::Broken
                    ? "Die Parkour-Liste ist kaputt – starte den Server neu über den Vanity-Launcher."
                    : "Keine Parkours gefunden – starte den Server über den Vanity-Launcher.",
                Width);
        }

        ImGui::Spacing();
        FButtonSpec retry;
        retry.Label = "Nochmal von vorne";
        retry.Tooltip = "Bringt dich zurück an den Start. Leben wird voll, Waffen werden nachgeladen.";
        FButtonSpec clear;
        clear.Label = "Alles wegräumen";
        clear.Tooltip = "Entfernt alle Parkour-Teile und alle Ziel-Bots.";
        switch (DrawButtonPair(Host, retry, clear, Width))
        {
        case 1:
            Send(Host, SectionParkour, "cheat parkour retry", "Nochmal von vorne");
            break;
        case 2:
            if (Send(Host, SectionParkour, "cheat parkour clear", "Alles wegräumen"))
                g_Tab.ActiveParkourId.clear();
            break;
        default:
            break;
        }

        DrawStatusLine(SectionParkour);
        Host.EndSectionBody();
    }

    void DrawTargetBotSection(const FVanityTabHost& Host, float Width)
    {
        Host.SectionLabel("Ziel-Bot");
        Host.BeginSectionBody();

        Hint("Ein Bot, der still vor dir steht – perfekt zum Zielen.", Width);

        // Zwei Regler nebeneinander: erst die Ueberschriften, dann die Regler (gleiche Hoehe).
        const float half = HalfWidth(Width);
        const float rightColumnX = ImGui::GetCursorPosX() + half + ImGui::GetStyle().ItemSpacing.x;
        ImGui::TextUnformatted("Leben");
        ImGui::SameLine(0.f, 0.f);
        ImGui::SetCursorPosX(rightColumnX);
        ImGui::TextUnformatted("Abstand");
        ImGui::SetNextItemWidth(half);
        ImGui::SliderInt("##vanity_bot_health", &g_Tab.BotHealth, 1, 200, "%d", ImGuiSliderFlags_AlwaysClamp);
        Tooltip("So viel Leben hat der Bot. Strg + Klick: Zahl eintippen.");
        ImGui::SameLine();
        ImGui::SetNextItemWidth(half);
        ImGui::SliderInt("##vanity_bot_distance", &g_Tab.BotDistance, 5, 100, "%d m", ImGuiSliderFlags_AlwaysClamp);
        Tooltip("So weit vor dir steht der Bot. Strg + Klick: Zahl eintippen.");

        g_Tab.BotHealth = (std::max)(1, (std::min)(200, g_Tab.BotHealth));
        g_Tab.BotDistance = (std::max)(5, (std::min)(100, g_Tab.BotDistance));

        FButtonSpec place;
        place.Label = "Bot vor mich stellen";
        place.Tooltip = "Stellt einen Bot mit diesem Leben in diesem Abstand vor dich.";
        place.Primary = true;
        if (DrawButton(Host, place, Width, kActionButtonHeight))
        {
            char command[64];
            std::snprintf(command, sizeof(command), "cheat targetbot %d %d", g_Tab.BotHealth, g_Tab.BotDistance);
            Send(Host, SectionBot, command,
                "Bot vor mich stellen (" + std::to_string(g_Tab.BotHealth) + " Leben, " +
                    std::to_string(g_Tab.BotDistance) + " m)");
        }

        FButtonSpec removeAll;
        removeAll.Label = "Alle Bots weg";
        removeAll.Tooltip = "Entfernt alle Bots.";
        FButtonSpec bringAll;
        bringAll.Label = "Bots zu mir";
        bringAll.Tooltip = "Holt alle Bots zu dir.";
        switch (DrawButtonPair(Host, removeAll, bringAll, Width))
        {
        case 1:
            Send(Host, SectionBot, "cheat delbot", "Alle Bots weg");
            break;
        case 2:
            Send(Host, SectionBot, "cheat tpbot", "Bots zu mir");
            break;
        default:
            break;
        }

        DrawStatusLine(SectionBot);
        Host.EndSectionBody();
    }

    void DrawGearSection(const FVanityTabHost& Host, float Width)
    {
        Host.SectionLabel("Ausrüstung");
        Host.BeginSectionBody();

        FButtonSpec sniper;
        sniper.Label = "Sniper geben";
        sniper.Tooltip = "Legt dir eine Sniper ins Inventar.";
        FButtonSpec pads;
        pads.Label = "Sprungpads geben";
        pads.Tooltip = "Gibt dir Sprungpads und andere Fallen zum Platzieren.";
        switch (DrawButtonPair(Host, sniper, pads, Width))
        {
        case 1:
            Send(Host, SectionGear, "cheat parkour sniper", "Sniper geben");
            break;
        case 2:
            Send(Host, SectionGear, "cheat givetraps", "Sprungpads geben");
            break;
        default:
            break;
        }

        FButtonSpec ammo;
        ammo.Label = "Munition auffüllen";
        ammo.Tooltip = "Füllt deine Munition auf.";
        FButtonSpec health;
        health.Label = "Leben auffüllen";
        health.Tooltip = "Macht Leben und Schild wieder voll.";
        switch (DrawButtonPair(Host, ammo, health, Width))
        {
        case 1:
            Send(Host, SectionGear, "cheat giveammo", "Munition auffüllen");
            break;
        case 2:
            Send(Host, SectionGear, "cheat regen", "Leben auffüllen");
            break;
        default:
            break;
        }

        DrawStatusLine(SectionGear);
        Host.EndSectionBody();
    }

    void DrawPracticeSection(const FVanityTabHost& Host, float Width)
    {
        Host.SectionLabel("Üben");
        Host.BeginSectionBody();

        Hint("Merk dir eine Stelle und spring mit einem Klick dorthin zurück.", Width);

        FButtonSpec save;
        save.Label = "Position merken";
        save.Tooltip = "Merkt sich, wo du gerade stehst.";
        FButtonSpec back;
        back.Label = "Zurück zur Position";
        back.Tooltip = "Bringt dich sofort zur gemerkten Stelle zurück.";
        switch (DrawButtonPair(Host, save, back, Width))
        {
        case 1:
            Send(Host, SectionPractice, "cheat s vanity o", "Position merken");
            break;
        case 2:
            Send(Host, SectionPractice, "cheat w vanity", "Zurück zur Position");
            break;
        default:
            break;
        }

        FButtonSpec launch;
        launch.Label = "Hochschießen";
        launch.Tooltip = "Schießt dich senkrecht in die Luft.";
        FButtonSpec slowMotion;
        slowMotion.Label = g_Tab.SlowMotion ? "Zeitlupe: an###vanity_slowmo" : "Zeitlupe: aus###vanity_slowmo";
        slowMotion.Tooltip = "Das ganze Match läuft halb so schnell. Nochmal klicken = normal.";
        slowMotion.Active = g_Tab.SlowMotion;
        switch (DrawButtonPair(Host, launch, slowMotion, Width))
        {
        case 1:
            Send(Host, SectionPractice, "cheat l 2500", "Hochschießen");
            break;
        case 2:
            if (g_Tab.SlowMotion)
            {
                if (Send(Host, SectionPractice, "cheat demospeed 1", "Zeitlupe aus"))
                    g_Tab.SlowMotion = false;
            }
            else if (Send(Host, SectionPractice, "cheat demospeed 0.5", "Zeitlupe an"))
            {
                g_Tab.SlowMotion = true;
            }
            break;
        default:
            break;
        }

        // Zwei feste Knoepfe statt eines Schalters: Der Server stellt die Schwerkraft nur fuer
        // deine aktuelle Spielfigur ein. Nach dem Sterben ist sie wieder normal, ohne dass das
        // Menue es merkt - ein "an/aus"-Schalter wuerde dann das Falsche anzeigen.
        FButtonSpec lowGravity;
        lowGravity.Label = "Wenig Schwerkraft";
        lowGravity.Tooltip = "Du springst höher und fällst langsamer. Nach dem Sterben ist es wieder normal.";
        FButtonSpec normalGravity;
        normalGravity.Label = "Normale Schwerkraft";
        normalGravity.Tooltip = "Stellt die Schwerkraft wieder normal ein.";
        switch (DrawButtonPair(Host, lowGravity, normalGravity, Width))
        {
        case 1:
            Send(Host, SectionPractice, "cheat gravity 0.4", "Wenig Schwerkraft");
            break;
        case 2:
            Send(Host, SectionPractice, "cheat gravity 1", "Normale Schwerkraft");
            break;
        default:
            break;
        }

        FButtonSpec god;
        god.Label = "Unverwundbar umschalten";
        god.Tooltip = "Einmal klicken: kein Schaden mehr. Nochmal klicken: wieder normal.";
        FButtonSpec storm;
        storm.Label = g_Tab.StormPaused ? "Sturm weiterlaufen lassen###vanity_storm" : "Sturm anhalten###vanity_storm";
        storm.Tooltip = "Hält den Sturm an oder lässt ihn weiterlaufen.";
        storm.Active = g_Tab.StormPaused;
        switch (DrawButtonPair(Host, god, storm, Width))
        {
        case 1:
            Send(Host, SectionPractice, "cheat god", "Unverwundbar umschalten");
            break;
        case 2:
            if (g_Tab.StormPaused)
            {
                if (Send(Host, SectionPractice, "cheat resumesafezone", "Sturm weiterlaufen lassen"))
                    g_Tab.StormPaused = false;
            }
            else if (Send(Host, SectionPractice, "cheat pausesafezone", "Sturm anhalten"))
            {
                g_Tab.StormPaused = true;
            }
            break;
        default:
            break;
        }

        Hint("Zeitlupe und Sturm gelten für alle im Match.", Width);
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

    // wchar_t ist unter Windows UTF-16, unter Linux UTF-32 (Vorschau).
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

    // "[Vanity] TRICKSHOT! Spieler – 87 m" -> Titel "TRICKSHOT!", Untertitel "Spieler – 87 m".
    void BuildToastText(const wchar_t* Text, int Length)
    {
        // Ein Gedankenstrich aus einem ohne /utf-8 gebauten Server kommt als "â€“" an.
        std::wstring repaired(Text, static_cast<size_t>(Length));
        const wchar_t broken[] = { static_cast<wchar_t>(0x00E2), static_cast<wchar_t>(0x20AC), static_cast<wchar_t>(0x201C), 0 };
        for (size_t found = repaired.find(broken); found != std::wstring::npos; found = repaired.find(broken, found + 1))
            repaired.replace(found, 3, 1, static_cast<wchar_t>(0x2013));

        std::string message = Trim(WideToUtf8(repaired.c_str(), static_cast<int>(repaired.size())));
        static const char vanityPrefix[] = "[Vanity]";
        if (message.compare(0, sizeof(vanityPrefix) - 1, vanityPrefix) == 0)
            message = Trim(message.substr(sizeof(vanityPrefix) - 1));

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

// ==================================================================== oeffentliche Funktionen

void VanityTrickshotTab_SetParkourFile(const wchar_t* Path)
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

void VanityTrickshotTab_SetLobbyCheck(bool (*IsInLobby)())
{
    g_LobbyCheck.store(IsInLobby, std::memory_order_release);
}

void VanityTrickshotTab_Draw(const FVanityTabHost& Host, float ContentWidth)
{
    if (!Host.SectionLabel || !Host.BeginSectionBody || !Host.EndSectionBody)
        return;

    const float width = (std::max)(120.f, ContentWidth);
    ResetTogglesOnNewSession(Host);
    RefreshParkoursIfNeeded();

    ImGui::PushID("VanityTrickshotTab");

    bool (*const isInLobby)() = g_LobbyCheck.load(std::memory_order_acquire);
    if (isInLobby && isInLobby())
    {
        ImGui::Spacing();
        ImGui::PushStyleColor(ImGuiCol_Text, AccentOf(Host, 1.f));
        ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + width);
        ImGui::TextUnformatted("Du bist noch in der Lobby. Starte zuerst ein Match – dann klappen die Knöpfe hier.");
        ImGui::PopTextWrapPos();
        ImGui::PopStyleColor();
    }

    DrawParkourSection(Host, width);
    DrawTargetBotSection(Host, width);
    DrawGearSection(Host, width);
    DrawPracticeSection(Host, width);

    ImGui::PopID();
}

void VanityToast_Push(const wchar_t* Text, int Length)
{
    if (!Text || Length <= 0)
        return;

    // Nur die erste Zeile; das Banner zeigt keine langen Texte.
    int count = 0;
    while (count < Length && count < kToastCapacity - 1 &&
        Text[count] != L'\0' && Text[count] != L'\n' && Text[count] != L'\r')
    {
        ++count;
    }
    if (count == 0)
        return;

    // Spiel-Thread: niemals warten. Ist das Schloss gerade belegt, faellt dieses Banner aus.
    std::unique_lock<std::mutex> lock(g_ToastMutex, std::try_to_lock);
    if (!lock.owns_lock())
        return;

    std::wmemcpy(g_ToastText, Text, static_cast<size_t>(count));
    g_ToastText[count] = L'\0';
    g_ToastLength = count;
    ++g_ToastSerial;
}

void VanityToast_Draw()
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

    // Aufpoppen (0,22 s, leicht ueberschwingend), dann stehen, in den letzten 0,6 s ausblenden.
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

    constexpr float accentR = 0.f;
    constexpr float accentG = 0.635f;
    constexpr float accentB = 0.808f;

    ImDrawList* drawList = ImGui::GetForegroundDrawList();

    // weicher Schein, dunkle Flaeche, feiner Rand, Akzent-Streifen links
    drawList->AddRectFilled(
        ImVec2(panelMin.x - 8.f, panelMin.y - 8.f), ImVec2(panelMax.x + 8.f, panelMax.y + 8.f),
        Color(accentR, accentG, accentB, 0.10f * alpha), rounding + 8.f);
    drawList->AddRectFilled(
        ImVec2(panelMin.x + 2.f, panelMin.y + 5.f), ImVec2(panelMax.x + 2.f, panelMax.y + 5.f),
        Color(0.f, 0.f, 0.f, 0.35f * alpha), rounding);
    drawList->AddRectFilled(panelMin, panelMax, Color(0.043f, 0.055f, 0.078f, 0.94f * alpha), rounding);
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
        Color(accentR, accentG, accentB, alpha), title, nullptr, 0.f, &clip);
    drawList->AddText(font, titleSize, ImVec2(titlePosition.x + bold, titlePosition.y),
        Color(accentR, accentG, accentB, alpha), title, nullptr, 0.f, &clip);

    if (hasSubtitle)
    {
        const ImVec2 subtitlePosition(
            std::floor(contentCenterX - subtitleExtent.x * 0.5f),
            std::floor(titlePosition.y + titleExtent.y + gap));
        drawList->AddText(font, subtitleSize, subtitlePosition,
            Color(0.847f, 0.878f, 0.941f, alpha), subtitle, nullptr, 0.f, &clip);
    }
}
