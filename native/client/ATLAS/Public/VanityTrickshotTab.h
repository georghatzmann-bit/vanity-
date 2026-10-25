// [Vanity] Neue Datei (GPL-3.0, Teil von Vanity): Trickshot-Reiter im F9-Menue und das
// Trickshot-Banner. Bewusst ohne pch.h, SDK- oder Spiel-Header, damit ein Vorschau-Werkzeug
// unter Linux die Datei mit reinem ImGui kompilieren und Bildschirmfotos rendern kann.
// Diese Datei bleibt reines ASCII, weil GUI.cpp und Client.cpp ohne /utf-8 gebaut werden.
#pragma once

#include "../ImGui/imgui.h"

#include <cstdint>

// Was der Reiter von GUI.cpp braucht. GUI.cpp fuellt die Zeiger mit seinen file-static Helfern.
struct FVanityTabHost
{
    // Reiht einen Konsolenbefehl ein (z. B. "cheat parkour retry"). false = geht gerade nicht.
    bool (*Exec)(const char* Command);
    // Abschnitts-Kopf und Einrueckung wie in den anderen Reitern.
    void (*SectionLabel)(const char* Label);
    void (*BeginSectionBody)();
    void (*EndSectionBody)();
    // Akzentfarbe #00A2CE mit Deckkraft.
    ImVec4 (*Accent)(float Alpha);

    // Optional (darf nullptr sein):
    // Aendert sich, sobald ein neues Match/ein neuer PlayerController da ist -> lokale
    // Schalter (Zeitlupe, Sturm) springen zurueck auf "aus".
    uint64_t (*SessionGeneration)();
};

// Optional: Client.cpp meldet hier einmal beim Start, woran der Reiter erkennt, dass du noch in
// der Lobby bist (true = Lobby -> kurzer Hinweis oben im Reiter). nullptr = kein Hinweis.
// Thread-sicher. Laeuft bewusst nicht ueber GUI.cpp, damit GUI.cpp keine weitere
// Client::-Funktion braucht (das Vorschau-Werkzeug baut GUI.cpp ohne Client.cpp).
void VanityTrickshotTab_SetLobbyCheck(bool (*IsInLobby)());

// Zeichnet den Inhalt des Reiters "Trickshot" in das aktuelle Fenster/Child.
// ContentWidth = nutzbare Breite fuer Knoepfe (CW in GUI_Render). Nur vom Render-Thread aufrufen.
void VanityTrickshotTab_Draw(const FVanityTabHost& Host, float ContentWidth);

// Optional: andere Parkour-Datei (Vorschau-Werkzeug). nullptr oder "" = Standardpfad
// %LOCALAPPDATA%\Vanity\server\parkours.json. Nur vom Render-Thread aufrufen.
void VanityTrickshotTab_SetParkourFile(const wchar_t* Path);

// Merkt sich eine Nachricht fuer das Banner. Thread-sicher, blockiert nie (try_lock),
// darf vom Spiel-Thread aufgerufen werden. Text beginnt mit "[Vanity] TRICKSHOT" -> grosses
// "TRICKSHOT!" und darunter der Rest der ersten Zeile (Spieler und Meter).
void VanityToast_Push(const wchar_t* Text, int Length);

// Jeden Frame aus GUI_Render aufrufen (auch wenn das Menue zu ist). Zeichnet ueber
// ImGui::GetForegroundDrawList(), blendet nach 3,5 s aus.
void VanityToast_Draw();
