
// ===== Nur für die Vanity Menü-Vorschau angehängt (nicht Teil des Spiel-Builds) =====
void Preview_SetState(int Tab, bool Menu, bool Console)
{
    FGUI::ActiveTab = Tab;
    FGUI::bVisible = Menu;
    FGUI::bConsoleVisible = Console;
    g_ConsoleUi.Expanded = Console; // zweiter Druck auf die Konsolen-Taste: große Ansicht
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

// Platzhalter für die wenigen Spiel-Funktionen, die das Menü aufruft (im Spiel liefern
// Client.cpp/dllmain.cpp die echten Werte; für Screenshots reichen feste Antworten).
bool ATLAS_PrepareReplicationForOpen(const char*, wchar_t*, unsigned __int64) { return true; }
bool Client::HasReceivedServerCommandList() { return true; }
bool Client::IsConsoleCaptureReady() { return true; }
uint64_t Client::GetConsoleSessionGeneration() { return 1; }
