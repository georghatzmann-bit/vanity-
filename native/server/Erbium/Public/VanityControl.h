// [Vanity] Steuer-Pipe für den Launcher – eigener Vanity-Code (GPL-3.0), kein Bestandteil von Magnesium.
//
// Der Launcher verbindet sich mit \\.\pipe\vanity-server und schickt zeilenweise JSON-Befehle
// ({"id":1,"cmd":"exec","text":"startaircraft"}, {"cmd":"config","key":"playlist","value":"solo"},
// {"cmd":"startmatch"}, {"cmd":"status"}). Der Server antwortet mit Ereignissen
// ({"event":"reply","id":1,"ok":true,"message":"…"}, "hello", "status", "ready", "matchEnd").
//
// Alles, was Spiel-Objekte anfasst, läuft im Spiel-Takt (GameThreadTick). Der Pipe-Thread
// nimmt nur Zeilen an und legt sie in eine Warteschlange.
#pragma once
#include <string>

namespace VanityControl
{
    // Pipe-Server in eigenem Thread starten (einmalig, aus Main()). Fehlt der Launcher, passiert nichts.
    void Start();

    // Im Spiel-Takt aufrufen: arbeitet eingegangene Befehle ab, schickt alle 2 s einen Status.
    void GameThreadTick();

    // Ereignis ohne weitere Felder an den Launcher schicken. Thread-sicher.
    void Emit(const char* Event);

    // Vom Netz-Code gerufen, wenn das Match zu Ende ist.
    void EmitMatchEnd();
}
