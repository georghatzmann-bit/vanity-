
// ===== Appended only for the Niobium menu preview (not part of the game build) =====
void Preview_SetState(int Tab, bool Menu, bool Console)
{
    FGUI::ActiveTab = Tab;
    FGUI::bVisible = Menu;
    FGUI::bConsoleVisible = Console;
    g_ConsoleUi.Expanded = Console; // second press of the console key: the large view
}
unsigned char* Preview_DecodeLogo(int* W, int* H)
{
    int Channels = 0;
    return stbi_load_from_memory(Icon, (int)sizeof(Icon), W, H, &Channels, 4);
}
void Preview_SetLogo(ImTextureID Id, int W, int H)
{
    FGUI::LogoTexture = Id;
    FGUI::LogoW = W;
    FGUI::LogoH = H;
}
void Preview_AddConsoleLine(const char* Text)
{
    AppendConsoleLine(EConsoleLineKind::Output, Text);
}

// Bubble Builds status row: pretend to be a game with this Fortnite version, started by the
// launcher with or without -FeatureLevelES31. Version 0 = unknown (as in the plain preview).
static wchar_t g_PreviewCommandLine[256] = L"menu-preview.exe";
static LPWSTR WINAPI Preview_GetCommandLine() { return g_PreviewCommandLine; }
void Preview_SetBubbleBuilds(double FortniteVersion, const wchar_t* LauncherVersion, bool FeatureLevelES31)
{
    VersionInfo.FortniteVersion = FortniteVersion;
    swprintf(g_PreviewCommandLine, 256,
        L"FortniteClient-Win64-Shipping.exe -epicapp=Fortnite%ls%ls%ls",
        LauncherVersion && *LauncherVersion ? L" -niobiumversion=" : L"",
        LauncherVersion && *LauncherVersion ? LauncherVersion : L"",
        FeatureLevelES31 ? L" -FeatureLevelES31" : L"");
    g_BubbleBuildsCommandLine = &Preview_GetCommandLine;
}

// What the game's Meshes setting reports to the status row (-1 = unknown, 0 = Low, 1 = High):
// the value the session started with, and the live value (differs after a change in Video
// settings). In the game the game thread reads both (Client.cpp); the preview just sets them.
void Preview_SetMeshQuality(int StartMeshQuality, int LiveMeshQuality)
{
    NiobiumBubbleLook::StartMeshQuality.store(StartMeshQuality);
    NiobiumBubbleLook::MeshQuality.store(LiveMeshQuality);
}

// "Bubble look" on the Main tab: on/off, strength, and the state the game thread would report
// (0 = off, 1 = waiting for the textures, 2 = active, 3 = not available on this version).
void Preview_SetBubbleLook(bool On, int Strength, int State, int AppliedCount)
{
    FConfiguration::bBubbleLook.store(On);
    FConfiguration::BubbleStrength.store(NiobiumBubbleLook::SanitizeStrength(Strength));
    NiobiumBubbleLook::State.store(State);
    NiobiumBubbleLook::AppliedCount.store(AppliedCount);
}

// A few saved commands and one chain, to check that the row buttons fit (never saved to disk).
void Preview_SetSavedCommands(bool Filled)
{
    FGUI::Commands.clear();
    FGUI::Macros.clear();
    if (!Filled)
        return;

    HotkeyPersist::CommandBind Ammo{};
    Ammo.Command = "cheat giveammo";
    Ammo.VK = VK_F6;
    Ammo.DefaultVK = VK_F6;
    FGUI::Commands.push_back(Ammo);

    HotkeyPersist::CommandBind Bot{};
    Bot.Command = "cheat targetbot 50 30";
    FGUI::Commands.push_back(Bot);

    HotkeyPersist::CommandMacro Chain{};
    Chain.Name = "cheat parkour first-jump";
    Chain.VK = VK_XBUTTON2;
    Chain.DefaultVK = VK_XBUTTON2;
    HotkeyPersist::MacroStep First{};
    First.Command = "cheat parkour first-jump";
    First.DelayMs = 1500;
    HotkeyPersist::MacroStep Second{};
    Second.Command = "cheat parkour sniper";
    Chain.Steps = { First, Second };
    FGUI::Macros.push_back(Chain);
}

// Shows the "Press the new key..." state of the menu key button in the Options tab.
void Preview_SetRebinding(bool Rebinding)
{
    FGUI::bRebinding = Rebinding;
}

// Stand-ins for the few game functions the menu calls (in the game Client.cpp/dllmain.cpp
// return the real values; fixed answers are enough for screenshots).
bool ATLAS_PrepareReplicationForOpen(const char*, wchar_t*, unsigned __int64) { return true; }
bool Client::HasReceivedServerCommandList() { return true; }
bool Client::IsConsoleCaptureReady() { return true; }
uint64_t Client::GetConsoleSessionGeneration() { return 1; }
