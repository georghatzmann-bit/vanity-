// Niobium menu preview (Windows program, runs under Wine or on Windows):
// starts the real F9 menu (GUI.cpp unchanged, plus appended preview functions) without the game,
// draws every tab with the software renderer and saves PPM images.
#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include "imgui.h"
#include "imgui_internal.h"
#include "softraster.h"
#if NIOBIUM_PREVIEW_TRICKSHOT
#include "ATLAS/Public/NiobiumTrickshotTab.h"
#endif

void GUI_Init();
void GUI_Render();
bool GUI_QueueConsoleOutput(const wchar_t* text, int length);
void Preview_SetState(int Tab, bool Menu, bool Console);
unsigned char* Preview_DecodeLogo(int* W, int* H);
void Preview_SetLogo(ImTextureID Id, int W, int H);
void Preview_SetBubbleBuilds(double FortniteVersion, const wchar_t* LauncherVersion, bool FeatureLevelES31);
void Preview_SetMeshQuality(int StartMeshQuality, int LiveMeshQuality);
void Preview_SetBubbleLook(bool On, int Strength, int State, int AppliedCount);
void Preview_SetSavedCommands(bool Filled);
void Preview_SetRebinding(bool Rebinding);
void Preview_SetEditRoutes(int EorStatus, int RorStatus, int PreStatus, int EorValue, int RorValue, int PreValue);
void Preview_SetResetBuilds(bool On, int VK, int GameStatus, bool Rebinding, bool MouseError, bool GameConsoleOpen);

#if NIOBIUM_PREVIEW_TRICKSHOT
static bool g_PreviewInLobby = false;
static bool PreviewIsInLobby() { return g_PreviewInLobby; }
#endif

static std::vector<uint8_t> LoadRgba(const char* Path, int W, int H)
{
    std::vector<uint8_t> Data(size_t(W) * H * 4, 0);
    if (FILE* F = std::fopen(Path, "rb"))
    {
        std::fread(Data.data(), 1, Data.size(), F);
        std::fclose(F);
    }
    return Data;
}

int main(int Argc, char** Argv)
{
    const int W = 1600, H = 900;
    const char* Background = Argc > 1 ? Argv[1] : "background.rgba";
    const char* OutDir = Argc > 2 ? Argv[2] : ".";
    [[maybe_unused]] const wchar_t* ParkourFile = L"parkours.json";

    ImGui::CreateContext();
    ImGuiIO& Io = ImGui::GetIO();
    Io.DisplaySize = ImVec2((float)W, (float)H);
    Io.IniFilename = nullptr;
    Io.BackendFlags |= ImGuiBackendFlags_RendererHasTextures;
    GUI_Init();
#if NIOBIUM_PREVIEW_TRICKSHOT
    NiobiumTrickshotTab_SetParkourFile(ParkourFile);
    NiobiumTrickshotTab_SetLobbyCheck(&PreviewIsInLobby);
#endif

    SoftRaster Raster(W, H);
    int LogoW = 0, LogoH = 0;
    if (unsigned char* Pixels = Preview_DecodeLogo(&LogoW, &LogoH))
    {
        SoftTexture Logo;
        Logo.Width = LogoW;
        Logo.Height = LogoH;
        Logo.Rgba.assign(Pixels, Pixels + size_t(LogoW) * LogoH * 4);
        Preview_SetLogo(Raster.AddTexture(std::move(Logo)), LogoW, LogoH);
    }
    const std::vector<uint8_t> Bg = LoadRgba(Background, W, H);

    // Scroll: 0 = top, 1 = all the way down. Version/LauncherVersion/Es31: the game the Bubble
    // Builds row pretends to run in (version 0 = unknown, like the plain preview).
    // SizeW/SizeH: window size (0 = the large 760 x 820 used for most shots).
    // Extra: what else to show (saved commands, waiting for a key, lobby hint).
    // Bubble: the "Bubble look" switch on the Main tab (off / on and waiting for the textures /
    // on and active / not available). MeshQuality: what the game's Meshes setting reports to
    // the Options status row when the session started (-1 = unknown, 0 = Low, 1 = High);
    // MeshLive: its value now (-2 = unchanged).
    // Edit: what the Main > Editing rows report (EditDefault = nothing decided yet, which draws
    // the hook switches as before). Reset: the Options > Reset builds rows.
    enum : unsigned { ExtraNone = 0, ExtraSaved = 1, ExtraRebind = 2, ExtraLobby = 4 };
    enum : int { BubbleOff = 0, BubbleWaiting = 1, BubbleActive = 2, BubbleUnavailable = 3, BubblePaused = 4 };
    enum : int { EditDefault = 0, EditHook, EditHookFailed, EditNative1910, EditNative2530, EditNativeStates };
    enum : int { ResetOff = 0, ResetReady, ResetRebind, ResetUnsupported, ResetNoKey, ResetMouseError, ResetChecking, ResetGameConsole };
    struct Shot
    {
        const char* Name; int Tab; bool Menu; bool Console; bool Toast; float Scroll = -1.f;
        double Version = 0.0; const wchar_t* LauncherVersion = L""; bool Es31 = false;
        float SizeW = 0.f; float SizeH = 0.f; unsigned Extra = ExtraNone;
        int Bubble = BubbleOff; int MeshQuality = -1; int MeshLive = -2;
        int Edit = EditDefault; int Reset = ResetOff;
    };
#if NIOBIUM_PREVIEW_TRICKSHOT
    const Shot Shots[] = {
        { "f9-1-main", 0, true, false, false },
        { "f9-1b-main-bottom", 0, true, false, false, 1.f },
        // Bubble look on (Graphics section): active on 19.10, waiting in a small window, and a
        // version without the texture property.
        { "f9-1c-main-bubble-look", 0, true, false, false, 0.42f, 19.10, L"19.10", true, 0.f, 0.f, ExtraNone, BubbleActive },
        { "f9-1d-main-bubble-waiting-small", 0, true, false, false, 0.5f, 19.10, L"19.10", true, 500.f, 320.f, ExtraNone, BubbleWaiting },
        { "f9-1e-main-bubble-unavailable", 0, true, false, false, 0.42f, 3.5, L"3.5", false, 0.f, 0.f, ExtraNone, BubbleUnavailable },
        // Bubble look paused: 15.50 in Performance Mode with Meshes Low = Epic's own bubbles on.
        { "f9-1j-main-bubble-paused", 0, true, false, false, 0.42f, 15.50, L"15.50", true, 0.f, 0.f, ExtraNone, BubblePaused, 0 },
        // Main > Editing by route: 8.51 (all three use our hooks), 3.5 with one hook that couldn't
        // be set up, 19.10 (Edit on release and pre-edits use Fortnite's own settings, Reset on
        // release our hook), 25.30 (all three Fortnite's own), and 24.30 with the other native
        // states (waiting, not on this version, a write that didn't stick).
        { "f9-1f-main-editing-851-hook", 0, true, false, false, 0.f, 8.51, L"8.51", false, 0.f, 0.f, ExtraNone, BubbleOff, -1, -2, EditHook },
        { "f9-1g-main-editing-35-hook-failed", 0, true, false, false, 0.f, 3.5, L"3.5", false, 0.f, 0.f, ExtraNone, BubbleOff, -1, -2, EditHookFailed },
        { "f9-1h-main-editing-1910-native", 0, true, false, false, 0.f, 19.10, L"19.10", false, 0.f, 0.f, ExtraNone, BubbleOff, -1, -2, EditNative1910 },
        { "f9-1i-main-editing-2530-native", 0, true, false, false, 0.f, 25.30, L"25.30", false, 0.f, 0.f, ExtraNone, BubbleOff, -1, -2, EditNative2530 },
        { "f9-1k-main-editing-2430-unavailable", 0, true, false, false, 0.f, 24.30, L"24.30", false, 0.f, 0.f, ExtraNone, BubbleOff, -1, -2, EditNativeStates },
        { "f9-1l-main-editing-1910-small", 0, true, false, false, 0.2f, 19.10, L"19.10", false, 500.f, 320.f, ExtraNone, BubbleOff, -1, -2, EditNative1910 },
        { "f9-2-commands", 1, true, false, false },
        { "f9-2b-commands-saved", 1, true, false, false, -1.f, 0.0, L"", false, 0.f, 0.f, ExtraSaved },
        { "f9-3-options", 2, true, false, false, -1.f, 15.40, L"15.40", true },
        { "f9-3b-options-bottom", 2, true, false, false, 1.f, 15.40, L"15.40", true, 0.f, 0.f, ExtraRebind },
        { "f9-3c-options-bubble-off", 2, true, false, false, -1.f, 15.50, L"15.50", false },
        { "f9-3d-options-bubble-experimental", 2, true, false, false, -1.f, 16.20, L"16.20", true },
        { "f9-3e-options-bubble-unavailable", 2, true, false, false, -1.f, 12.41, L"12.41", false },
        // 19.x (Chapter 3 Season 1, launcher level "lowMeshes"): on, on but Meshes High, off,
        // Meshes changed during the session (both ways), Meshes not readable.
        { "f9-3f-options-bubble-19-on", 2, true, false, false, -1.f, 19.10, L"19.10", true, 0.f, 0.f, ExtraNone, BubbleOff, 0 },
        { "f9-3g-options-bubble-19-meshes-high", 2, true, false, false, -1.f, 19.10, L"19.10", true, 0.f, 0.f, ExtraNone, BubbleOff, 1 },
        { "f9-3h-options-bubble-19-off", 2, true, false, false, -1.f, 19.10, L"19.10", false },
        { "f9-3i-options-bubble-19-meshes-now-low", 2, true, false, false, -1.f, 19.10, L"19.10", true, 0.f, 0.f, ExtraNone, BubbleOff, 1, 0 },
        { "f9-3j-options-bubble-19-meshes-now-high", 2, true, false, false, -1.f, 19.10, L"19.10", true, 0.f, 0.f, ExtraNone, BubbleOff, 0, 1 },
        { "f9-3k-options-bubble-19-meshes-unknown", 2, true, false, false, -1.f, 19.10, L"19.10", true },
        // 15.40-16.00 also need Meshes Low (same rows as 19.x).
        { "f9-3p-options-bubble-1550-meshes-high", 2, true, false, false, -1.f, 15.50, L"15.50", true, 0.f, 0.f, ExtraNone, BubbleOff, 1 },
        // Options > Reset builds: ready with a key, waiting for a new key, the mouse-button message,
        // no key yet, a server without it, checking, a version with Epic's own key, and Fortnite's
        // own console open (keys typed there don't count).
        { "f9-3l-options-reset-builds-ready", 2, true, false, false, 1.f, 19.10, L"19.10", false, 0.f, 0.f, ExtraNone, BubbleOff, -1, -2, EditDefault, ResetReady },
        { "f9-3m-options-reset-builds-rebind", 2, true, false, false, 1.f, 19.10, L"19.10", false, 0.f, 0.f, ExtraNone, BubbleOff, -1, -2, EditDefault, ResetRebind },
        { "f9-3n-options-reset-builds-mouse", 2, true, false, false, 1.f, 19.10, L"19.10", false, 0.f, 0.f, ExtraNone, BubbleOff, -1, -2, EditDefault, ResetMouseError },
        { "f9-3o-options-reset-builds-nokey", 2, true, false, false, 1.f, 19.10, L"19.10", false, 0.f, 0.f, ExtraNone, BubbleOff, -1, -2, EditDefault, ResetNoKey },
        { "f9-3q-options-reset-builds-unsupported", 2, true, false, false, 1.f, 8.51, L"8.51", false, 0.f, 0.f, ExtraNone, BubbleOff, -1, -2, EditDefault, ResetUnsupported },
        { "f9-3r-options-reset-builds-checking-small", 2, true, false, false, 0.75f, 19.10, L"19.10", false, 500.f, 320.f, ExtraNone, BubbleOff, -1, -2, EditDefault, ResetChecking },
        { "f9-3s-options-reset-builds-epic-37", 2, true, false, false, 1.f, 37.00, L"37.00", false, 0.f, 0.f, ExtraNone, BubbleOff, -1, -2, EditDefault, ResetReady },
        { "f9-3t-options-reset-builds-game-console", 2, true, false, false, 1.f, 19.10, L"19.10", false, 0.f, 0.f, ExtraNone, BubbleOff, -1, -2, EditDefault, ResetGameConsole },
        { "f9-4-trickshot", 3, true, false, false },
        { "f9-4b-trickshot-middle", 3, true, false, false, 0.5f },
        { "f9-4c-trickshot-bottom", 3, true, false, false, 1.f },
        { "f9-4d-trickshot-lobby", 3, true, false, false, 0.f, 0.0, L"", false, 580.f, 410.f, ExtraLobby },
        { "f9-5-credits", 4, true, false, false },
        { "f9-6-console", 0, false, true, false },
        // Smallest window the menu allows (500 x 320) and its default size (580 x 410):
        // every text must still fit or wrap.
        { "f9-8-main-small", 0, true, false, false, -1.f, 0.0, L"", false, 500.f, 320.f },
        { "f9-8b-options-small", 2, true, false, false, -1.f, 16.20, L"16.20", true, 500.f, 320.f },
        { "f9-8g-options-bubble-19-meshes-high-small", 2, true, false, false, -1.f, 19.10, L"19.10", true, 500.f, 320.f, ExtraNone, BubbleOff, 1 },
        { "f9-8c-commands-saved-small", 1, true, false, false, 1.f, 0.0, L"", false, 500.f, 320.f, ExtraSaved },
        { "f9-8d-trickshot-default", 3, true, false, false, -1.f, 0.0, L"", false, 580.f, 410.f },
        { "f9-8e-options-rebind-small", 2, true, false, false, 1.f, 15.40, L"15.40", true, 500.f, 320.f, ExtraRebind },
        { "f9-8f-credits-small", 4, true, false, false, -1.f, 0.0, L"", false, 500.f, 320.f },
        // Last, so the banner doesn't float over the other shots while it fades out.
        { "f9-7-trickshot-banner", 0, false, false, true },
    };
#else
    const Shot Shots[] = {
        { "f9-1-main", 0, true, false, false },
        { "f9-1c-main-bubble-look", 0, true, false, false, 0.42f, 19.10, L"19.10", true, 0.f, 0.f, ExtraNone, BubbleActive },
        { "f9-2-commands", 1, true, false, false },
        { "f9-3-options", 2, true, false, false, -1.f, 15.40, L"15.40", true },
        { "f9-3f-options-bubble-19-on", 2, true, false, false, -1.f, 19.10, L"19.10", true, 0.f, 0.f, ExtraNone, BubbleOff, 0 },
        { "f9-3g-options-bubble-19-meshes-high", 2, true, false, false, -1.f, 19.10, L"19.10", true, 0.f, 0.f, ExtraNone, BubbleOff, 1 },
        { "f9-4-credits", 3, true, false, false },
        { "f9-5-console", 0, false, true, false },
    };
#endif

    for (const Shot& S : Shots)
    {
        Preview_SetState(S.Tab, S.Menu, S.Console);
        Preview_SetBubbleBuilds(S.Version, S.LauncherVersion, S.Es31);
        Preview_SetMeshQuality(S.MeshQuality, S.MeshLive == -2 ? S.MeshQuality : S.MeshLive);
        // Strength 5 (the default); "active" shows 3 of the 4 textures loaded, to check the text.
        Preview_SetBubbleLook(S.Bubble != BubbleOff, 5,
            S.Bubble == BubbleActive ? 2 : S.Bubble == BubbleWaiting ? 1 : S.Bubble == BubbleUnavailable ? 3 :
                S.Bubble == BubblePaused ? 4 : 0,
            S.Bubble == BubbleActive ? 3 : 0);
        Preview_SetSavedCommands((S.Extra & ExtraSaved) != 0);
        Preview_SetRebinding((S.Extra & ExtraRebind) != 0);
        switch (S.Edit)
        {
        case EditHook:         Preview_SetEditRoutes(1, 1, 1, -1, -1, -1); break;
        case EditHookFailed:   Preview_SetEditRoutes(1, 2, 1, -1, -1, -1); break;
        case EditNative1910:   Preview_SetEditRoutes(4, 1, 4, 1, -1, 0); break;
        case EditNative2530:   Preview_SetEditRoutes(4, 4, 4, 1, 1, 0); break;
        case EditNativeStates: Preview_SetEditRoutes(3, 5, 6, -1, -1, 1); break;
        default:               Preview_SetEditRoutes(0, 0, 0, -1, -1, -1); break;
        }
        // Key "G" (0x47) for the shots that have a key.
        switch (S.Reset)
        {
        case ResetReady:       Preview_SetResetBuilds(true, 0x47, 4, false, false, false); break;
        case ResetRebind:      Preview_SetResetBuilds(true, 0, 0, true, false, false); break;
        case ResetUnsupported: Preview_SetResetBuilds(true, 0x47, 3, false, false, false); break;
        case ResetNoKey:       Preview_SetResetBuilds(true, 0, 0, false, false, false); break;
        case ResetMouseError:  Preview_SetResetBuilds(true, 0, 0, false, true, false); break;
        case ResetChecking:    Preview_SetResetBuilds(true, 0x47, 2, false, false, false); break;
        case ResetGameConsole: Preview_SetResetBuilds(true, 0x47, 4, false, false, true); break;
        default:               Preview_SetResetBuilds(false, 0, 0, false, false, false); break;
        }
#if NIOBIUM_PREVIEW_TRICKSHOT
        g_PreviewInLobby = (S.Extra & ExtraLobby) != 0;
#endif
        if (S.Console)
        {
            const wchar_t* Lines[] = {
                L"[Niobium] Connected to your server.",
                L"[Niobium] Parkour \"First Jump\" is ready: floor, 1 trampoline, 1 target bot (50 HP).",
                L"[Niobium] You're at the start. Your sniper is in your inventory.",
                L"[Niobium] TRICKSHOT! georg – 128 m",
            };
            for (const wchar_t* Line : Lines)
                GUI_QueueConsoleOutput(Line, (int)wcslen(Line));
        }
#if NIOBIUM_PREVIEW_TRICKSHOT
        if (S.Toast)
        {
            const wchar_t* Msg = L"[Niobium] TRICKSHOT! georg – 128 m";
            NiobiumToast_Push(Msg, (int)wcslen(Msg));
        }
#endif
        const float WinW = S.SizeW > 0.f ? S.SizeW : 760.f;
        const float WinH = S.SizeH > 0.f ? S.SizeH : 820.f;
        // enough frames for the fade animations to finish (banner: middle of its display time)
        const int Frames = S.Toast ? 40 : 90;
        for (int Frame = 0; Frame < Frames; ++Frame)
        {
            Io.DeltaTime = 1.f / 60.f;
            Io.MousePos = ImVec2(-FLT_MAX, -FLT_MAX);
            ImGui::NewFrame();
            if (Frame == 1)
            {
                // In the game you can drag the window bigger with the mouse - the preview does
                // that here so more of the content is visible.
                ImGui::SetWindowSize("##atlas_main", ImVec2(WinW, WinH));
                ImGui::SetWindowPos("##atlas_main", ImVec2((W - WinW) * 0.5f, (H - WinH) * 0.5f));
            }
            GUI_Render();
            if (S.Scroll >= 0.f && Frame >= 2)
            {
                // Scroll the tab content, like with the mouse wheel
                for (ImGuiWindow* Win : GImGui->Windows)
                    if (std::strstr(Win->Name, "##content"))
                        ImGui::SetScrollY(Win, Win->ScrollMax.y * S.Scroll);
            }
            ImGui::Render();
            if (Frame + 1 == Frames)
            {
                Raster.Blit(Bg, W, H);
                Raster.Render(ImGui::GetDrawData());
                const std::string Path = std::string(OutDir) + "\\" + S.Name + ".ppm";
                Raster.SavePpm(Path);
                std::printf("written: %s\n", Path.c_str());
            }
            else
            {
                Raster.UpdateTextures(ImGui::GetDrawData());
            }
            Sleep(16); // real time passes, in case the menu animates with GetTickCount64
        }
    }
    ImGui::DestroyContext();
    return 0;
}
