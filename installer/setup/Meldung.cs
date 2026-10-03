using System;

namespace JarvisSetup
{
    /// <summary>
    /// Eine Fortschritts-Zeile vom Inno-Kern (installer\jarvis.iss) oder von
    /// werkzeuge\installieren.ps1. Sie stehen in der Datei aus JARVIS_FORTSCHRITT und im Protokoll:
    ///   JARVIS-SCHRITT 3/6 Pakete       Schritt 3 beginnt (die davor sind fertig)
    ///   JARVIS-DETAIL Text              was gerade passiert (Zeile unter dem Schritt)
    ///   JARVIS-ANTEIL 40                Anteil am laufenden Schritt in Prozent
    ///   JARVIS-OK 3 [Text]              Schritt 3 ist fertig
    ///   JARVIS-WARNUNG 5 Text           Schritt 5 geht weiter, aber mit Hinweis
    ///   JARVIS-FEHLER 3 14 Text         Schritt 3 ist gescheitert (Code 14)
    ///   JARVIS-TIPP Text                was der Nutzer jetzt tun kann
    ///   JARVIS-FERTIG                   alles fertig
    /// </summary>
    sealed class Meldung
    {
        public string Art = "";
        public int Schritt;
        public int Wert;
        public string Text = "";

        public static Meldung Lesen(string zeile)
        {
            if (zeile == null)
                return null;
            zeile = zeile.Trim().TrimStart('﻿');
            const string vorne = "JARVIS-";
            if (!zeile.StartsWith(vorne, StringComparison.Ordinal))
                return null;
            int leer = zeile.IndexOf(' ');
            string art = (leer < 0 ? zeile : zeile.Substring(0, leer)).Substring(vorne.Length);
            string rest = leer < 0 ? "" : zeile.Substring(leer + 1).Trim();
            var m = new Meldung { Art = art };
            switch (art)
            {
                case "SCHRITT":
                {
                    string[] teile = rest.Split(new[] { ' ' }, 2);
                    int.TryParse(teile[0].Split('/')[0], out m.Schritt);
                    m.Text = teile.Length > 1 ? teile[1].Trim() : "";
                    break;
                }
                case "ANTEIL":
                    int.TryParse(rest, out m.Wert);
                    m.Wert = Math.Max(0, Math.Min(100, m.Wert));
                    break;
                case "OK":
                case "WARNUNG":
                {
                    string[] teile = rest.Split(new[] { ' ' }, 2);
                    if (!int.TryParse(teile[0], out m.Schritt))
                    {
                        m.Text = rest;
                        break;
                    }
                    m.Text = teile.Length > 1 ? teile[1].Trim() : "";
                    break;
                }
                case "FEHLER":
                {
                    string[] teile = rest.Split(new[] { ' ' }, 3);
                    int.TryParse(teile[0], out m.Schritt);
                    if (teile.Length > 1)
                        int.TryParse(teile[1], out m.Wert);
                    m.Text = teile.Length > 2 ? teile[2].Trim() : "";
                    break;
                }
                case "DETAIL":
                case "TIPP":
                case "FERTIG":
                    m.Text = rest;
                    break;
                default:
                    return null;
            }
            return m;
        }
    }
}
