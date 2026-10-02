using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Linq;

namespace JarvisSetup
{
    enum Zustand { Wartet, Laeuft, Fertig, Hinweis, Fehler }

    /// <summary>Einer der sechs Schritte, wie ihn die Liste zeigt.</summary>
    sealed class Schritt : INotifyPropertyChanged
    {
        public Schritt(int nr, string titel, double gewicht, double sekunden)
        {
            Nr = nr;
            Titel = titel;
            Gewicht = gewicht;
            Sekunden = sekunden;
        }

        public int Nr { get; }
        public string Titel { get; }
        /// <summary>Anteil an der ganzen Installation in Prozent (alle zusammen 100).</summary>
        public double Gewicht { get; }
        /// <summary>Wie lange der Schritt auf einem frischen PC etwa dauert.</summary>
        public double Sekunden { get; }

        public DateTime Beginn;
        /// <summary>Gemeldeter Anteil 0 bis 1.</summary>
        public double Anteil;
        public bool HatHinweis;
        public string HinweisText = "";

        Zustand zustand;
        string detail = "";

        public Zustand Zustand
        {
            get => zustand;
            set
            {
                if (zustand == value)
                    return;
                zustand = value;
                Melden(nameof(Zustand));
                Melden(nameof(Status));
                Melden(nameof(DetailSichtbar));
            }
        }

        /// <summary>Die Zeile unter dem Titel: was gerade passiert, ein Hinweis oder der Fehler.</summary>
        public string Detail
        {
            get => detail;
            set
            {
                value ??= "";
                if (detail == value)
                    return;
                detail = value;
                Melden(nameof(Detail));
                Melden(nameof(DetailSichtbar));
            }
        }

        /// <summary>Zustand als Wort, nie nur als Farbe.</summary>
        public string Status => zustand switch
        {
            Zustand.Laeuft => "läuft",
            Zustand.Fertig => "fertig",
            Zustand.Hinweis => "Hinweis",
            Zustand.Fehler => "Fehler",
            _ => "wartet",
        };

        public bool DetailSichtbar => detail.Length > 0 && (zustand == Zustand.Laeuft || zustand == Zustand.Hinweis || zustand == Zustand.Fehler);

        /// <summary>
        /// Geschätzter Anteil 0 bis 1: der gemeldete, und dazwischen kriecht er langsam weiter
        /// (nach der erwarteten Dauer), damit der Balken nie stehen bleibt.
        /// </summary>
        public double Geschaetzt(DateTime jetzt)
        {
            double t = Math.Max(0, (jetzt - Beginn).TotalSeconds);
            double kriechen = 0.9 * (1 - Math.Exp(-t / (Sekunden * 0.7)));
            if (Anteil > 0)
                kriechen = Math.Min(kriechen, Anteil + 0.15);
            return Math.Min(0.98, Math.Max(Anteil, kriechen));
        }

        public void Zuruecksetzen()
        {
            Zustand = Zustand.Wartet;
            Detail = "";
            Anteil = 0;
            HatHinweis = false;
            HinweisText = "";
        }

        public event PropertyChangedEventHandler PropertyChanged;
        void Melden(string name) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    }

    /// <summary>Der Stand der ganzen Installation: Schritte, Gesamtfortschritt, Restzeit, Fehler.</summary>
    sealed class Fortschritt
    {
        // Gewichte und Dauer grob nach einer Installation auf einem frischen PC mit gutem Internet.
        public ObservableCollection<Schritt> Schritte { get; } = new ObservableCollection<Schritt>
        {
            new Schritt(1, "Vorbereiten", 4, 10),
            new Schritt(2, "Python", 10, 45),
            new Schritt(3, "Pakete", 46, 200),
            new Schritt(4, "Spracherkennung", 18, 80),
            new Schritt(5, "Jarvis' Gehirn", 14, 60),
            new Schritt(6, "Windows-Bausteine", 8, 20),
        };

        public List<string> Hinweise { get; } = new List<string>();
        public bool Fehlgeschlagen;
        public int FehlerSchritt;
        public int FehlerCode;
        public string FehlerText = "";
        public string FehlerTipp = "";
        public bool FertigGemeldet;
        public DateTime Beginn;

        Schritt aktuell;
        double? restGlatt;

        public Schritt SchrittNr(int nr) => Schritte.FirstOrDefault(s => s.Nr == nr);

        public void Zuruecksetzen()
        {
            foreach (Schritt s in Schritte)
                s.Zuruecksetzen();
            Hinweise.Clear();
            Fehlgeschlagen = false;
            FehlerSchritt = 0;
            FehlerCode = 0;
            FehlerText = "";
            FehlerTipp = "";
            FertigGemeldet = false;
            aktuell = null;
            restGlatt = null;
        }

        public void Starten(DateTime jetzt)
        {
            Beginn = jetzt;
            Beginne(1, jetzt);
        }

        public void Anwenden(Meldung m, DateTime jetzt)
        {
            switch (m.Art)
            {
                case "SCHRITT":
                    Beginne(m.Schritt, jetzt);
                    break;
                case "DETAIL":
                    if (aktuell != null && aktuell.Zustand == Zustand.Laeuft)
                        aktuell.Detail = m.Text;
                    break;
                case "ANTEIL":
                    if (aktuell != null)
                        aktuell.Anteil = Math.Max(aktuell.Anteil, m.Wert / 100.0);
                    break;
                case "OK":
                    Abschliessen(SchrittNr(m.Schritt) ?? aktuell);
                    break;
                case "WARNUNG":
                {
                    Schritt s = SchrittNr(m.Schritt) ?? aktuell;
                    if (s != null)
                    {
                        s.HatHinweis = true;
                        s.HinweisText = m.Text;
                    }
                    if (m.Text.Length > 0 && !Hinweise.Contains(m.Text))
                        Hinweise.Add(m.Text);
                    break;
                }
                case "FEHLER":
                {
                    Fehlgeschlagen = true;
                    FehlerCode = m.Wert;
                    FehlerText = m.Text;
                    Schritt s = SchrittNr(m.Schritt) ?? aktuell;
                    FehlerSchritt = s?.Nr ?? 0;
                    if (s != null)
                    {
                        s.Zustand = Zustand.Fehler;
                        s.Detail = m.Text;
                    }
                    break;
                }
                case "TIPP":
                    FehlerTipp = m.Text;
                    break;
                case "FERTIG":
                    FertigGemeldet = true;
                    AllesFertig();
                    break;
            }
        }

        /// <summary>Schritt nr beginnt, alle davor sind fertig.</summary>
        void Beginne(int nr, DateTime jetzt)
        {
            Schritt s = SchrittNr(nr);
            if (s == null)
                return;
            foreach (Schritt vorher in Schritte)
                if (vorher.Nr < nr && (vorher.Zustand == Zustand.Wartet || vorher.Zustand == Zustand.Laeuft))
                    Abschliessen(vorher);
            if (s.Zustand != Zustand.Laeuft)
            {
                s.Beginn = jetzt;
                s.Anteil = 0;
                s.Detail = "";
                s.Zustand = Zustand.Laeuft;
            }
            aktuell = s;
        }

        static void Abschliessen(Schritt s)
        {
            if (s == null || s.Zustand == Zustand.Fehler)
                return;
            s.Anteil = 1;
            s.Zustand = s.HatHinweis ? Zustand.Hinweis : Zustand.Fertig;
            s.Detail = s.HatHinweis ? s.HinweisText : "";
        }

        /// <summary>Am Ende ohne Fehler: alles, was noch offen ist, gilt als fertig.</summary>
        public void AllesFertig()
        {
            foreach (Schritt s in Schritte)
                if (s.Zustand == Zustand.Wartet || s.Zustand == Zustand.Laeuft)
                    Abschliessen(s);
        }

        /// <summary>Markiert einen Schritt als gescheitert (wenn der Kern selbst scheitert).</summary>
        public void FehlerAn(int nr, string text)
        {
            Schritt s = SchrittNr(nr) ?? aktuell ?? Schritte[0];
            FehlerSchritt = s.Nr;
            s.Zustand = Zustand.Fehler;
            s.Detail = text;
        }

        /// <summary>Gesamtfortschritt 0 bis 1.</summary>
        public double Gesamt(DateTime jetzt)
        {
            double summe = 0;
            foreach (Schritt s in Schritte)
            {
                switch (s.Zustand)
                {
                    case Zustand.Fertig:
                    case Zustand.Hinweis:
                        summe += s.Gewicht;
                        break;
                    case Zustand.Laeuft:
                        summe += s.Gewicht * s.Geschaetzt(jetzt);
                        break;
                    case Zustand.Fehler:
                        summe += s.Gewicht * s.Anteil;
                        break;
                }
            }
            return Math.Max(0, Math.Min(1, summe / 100.0));
        }

        /// <summary>Grobe Restzeit als Text. Etwa alle zwei Sekunden aufrufen (geglättet).</summary>
        public string Restzeit(DateTime jetzt, double gesamt)
        {
            double t = (jetzt - Beginn).TotalSeconds;
            if (gesamt >= 0.995)
                return "gleich fertig";
            if (t < 10 || gesamt < 0.05)
                return "Restzeit wird berechnet";
            double rest = t / gesamt * (1 - gesamt);
            restGlatt = restGlatt == null ? rest : restGlatt.Value * 0.7 + rest * 0.3;
            return RestzeitText(restGlatt.Value);
        }

        public static string RestzeitText(double sekunden)
        {
            if (sekunden < 45)
                return "gleich fertig";
            int minuten = (int)Math.Round(sekunden / 60);
            return minuten <= 1 ? "noch etwa 1 Minute" : "noch etwa " + minuten + " Minuten";
        }
    }
}
