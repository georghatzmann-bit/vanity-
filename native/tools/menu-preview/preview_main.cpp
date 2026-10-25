// Vanity Menü-Vorschau (Windows-Programm, läuft unter Wine oder Windows):
// startet das echte F9-Menü (GUI.cpp unverändert, plus angehängte Vorschau-Funktionen) ohne Spiel,
// zeichnet jeden Reiter mit dem Software-Renderer und speichert PPM-Bilder.
#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include "imgui.h"
#include "softraster.h"
#if VANITY_PREVIEW_TRICKSHOT
#include "ATLAS/Public/VanityTrickshotTab.h"
#endif

void GUI_Init();
void GUI_Render();
bool GUI_QueueConsoleOutput(const wchar_t* text, int length);
void Preview_SetState(int Tab, bool Menu, bool Console);
unsigned char* Preview_DecodeLogo(int* W, int* H);
void Preview_SetLogo(ImTextureID Id, int W, int H);

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
#if VANITY_PREVIEW_TRICKSHOT
    VanityTrickshotTab_SetParkourFile(ParkourFile);
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

    struct Shot { const char* Name; int Tab; bool Menu; bool Console; bool Toast; };
#if VANITY_PREVIEW_TRICKSHOT
    const Shot Shots[] = {
        { "f9-1-main", 0, true, false, false },
        { "f9-2-commands", 1, true, false, false },
        { "f9-3-config", 2, true, false, false },
        { "f9-4-trickshot", 3, true, false, false },
        { "f9-5-credits", 4, true, false, false },
        { "f9-6-konsole", 0, false, true, false },
        { "f9-7-trickshot-banner", 0, false, false, true },
    };
#else
    const Shot Shots[] = {
        { "f9-1-main", 0, true, false, false },
        { "f9-2-commands", 1, true, false, false },
        { "f9-3-config", 2, true, false, false },
        { "f9-4-credits", 3, true, false, false },
        { "f9-5-konsole", 0, false, true, false },
    };
#endif

    for (const Shot& S : Shots)
    {
        Preview_SetState(S.Tab, S.Menu, S.Console);
        if (S.Console)
        {
            const wchar_t* Lines[] = {
                L"[Vanity] Verbunden mit deinem Server.",
                L"[Vanity] Parkour \u201EErster Sprung\u201C steht: Boden, 1 Trampolin, 1 Ziel-Bot (50 HP).",
                L"[Vanity] Du stehst am Start. Sniper liegt im Inventar.",
                L"[Vanity] TRICKSHOT! georg \u2013 128 m",
            };
            for (const wchar_t* Line : Lines)
                GUI_QueueConsoleOutput(Line, (int)wcslen(Line));
        }
#if VANITY_PREVIEW_TRICKSHOT
        if (S.Toast)
        {
            const wchar_t* Msg = L"[Vanity] TRICKSHOT! georg \u2013 128 m";
            VanityToast_Push(Msg, (int)wcslen(Msg));
        }
#endif
        // genug Bilder, damit Ein-/Ausblend-Animationen fertig sind (Banner: Mitte der Anzeigezeit)
        const int Frames = S.Toast ? 40 : 90;
        for (int Frame = 0; Frame < Frames; ++Frame)
        {
            Io.DeltaTime = 1.f / 60.f;
            Io.MousePos = ImVec2(-FLT_MAX, -FLT_MAX);
            ImGui::NewFrame();
            if (Frame == 1)
            {
                // Im Spiel kann man das Fenster mit der Maus größer ziehen – für die Bilder machen wir das hier,
                // damit mehr vom Inhalt sichtbar ist.
                ImGui::SetWindowSize("##atlas_main", ImVec2(760.f, 820.f));
                ImGui::SetWindowPos("##atlas_main", ImVec2((W - 760.f) * 0.5f, (H - 820.f) * 0.5f));
            }
            GUI_Render();
            ImGui::Render();
            if (Frame + 1 == Frames)
            {
                Raster.Blit(Bg, W, H);
                Raster.Render(ImGui::GetDrawData());
                const std::string Path = std::string(OutDir) + "\\" + S.Name + ".ppm";
                Raster.SavePpm(Path);
                std::printf("geschrieben: %s\n", Path.c_str());
            }
            else
            {
                Raster.UpdateTextures(ImGui::GetDrawData());
            }
            Sleep(16); // echte Zeit vergeht, falls das Menü mit GetTickCount64 animiert
        }
    }
    ImGui::DestroyContext();
    return 0;
}
