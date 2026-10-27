
// ===== Appended only for the Rift menu preview (not part of the game build) =====
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

// Main > Editing: the state the startup code / game thread would publish for each feature
// (NiobiumEditRoutes::EStatus: 0 unknown, 1 hook, 2 hook failed, 3 waiting for Fortnite's
// settings, 4 Fortnite's own setting, 5 not on this version, 6 a write didn't stick) and
// Fortnite's own value for the native rows (-1 unknown, 0 off, 1 on). The version comes from
// Preview_SetBubbleBuilds.
void Preview_SetEditRoutes(int EorStatus, int RorStatus, int PreStatus, int EorValue, int RorValue, int PreValue)
{
    const int Statuses[3] = { EorStatus, RorStatus, PreStatus };
    const int Values[3] = { EorValue, RorValue, PreValue };
    for (int Index = 0; Index < NiobiumEditRoutes::FeatureCount; ++Index)
    {
        NiobiumEditRoutes::Status[Index].store(Statuses[Index]);
        NiobiumEditRoutes::NativeValue[Index].store(Values[Index]);
        NiobiumEditRoutes::PendingWrite[Index].store(-1);
    }
}

// Options > Reset builds: on/off, the key (0 = none), what the game thread reports
// (NiobiumQuickReset::EStatus: 0 idle, 1 not in a match, 2 checking, 3 unsupported, 4 ready),
// waiting for a new key, the "mouse buttons can't be used" message, and Fortnite's own console
// being open (one-line console).
void Preview_SetResetBuilds(bool On, int VK, int GameStatus, bool Rebinding, bool MouseError, bool GameConsoleOpen)
{
    FConfiguration::bResetBuilds.store(On);
    FConfiguration::ResetBuildsVK.store(VK);
    NiobiumQuickReset::Status.store(GameStatus);
    NiobiumQuickReset::GameConsoleState.store(GameConsoleOpen ? 1 : 0);
    // Fortnite's console only opens with "Which console?" = Fortnite's (every other shot: ours).
    FConfiguration::ConsoleMode.store(static_cast<int>(
        GameConsoleOpen ? EConsoleMode::Unreal : EConsoleMode::Atlas));
    FGUI::bRebindingResetBuilds = Rebinding;
    g_BindError.clear();
    g_BindErrorUntil = 0;
    if (MouseError)
        SetBindError(kBindMouseText, kBindMouseReason, 1);
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
// The "match" the menu thinks it is in; Preview_NextSession starts a new one (the Host tab
// forgets its last server answer, like after joining a new match).
static uint64_t g_PreviewSession = 1;
uint64_t Client::GetConsoleSessionGeneration() { return g_PreviewSession; }
void Preview_NextSession() { ++g_PreviewSession; }
uint64_t Client::GetWorldGeneration() { return 1; }
