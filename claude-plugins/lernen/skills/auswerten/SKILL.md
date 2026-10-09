---
description: Geht mit dem Nutzer durch, was das Plugin Lernen beobachtet hat (Korrekturen, Vorlieben, Lob), und macht daraus mit seinem Ja feste Regeln oder bessere Skills. Nimm diese Anleitung bei /lernen:auswerten, bei "Was hast du gelernt?", "Werte die Beobachtungen aus" oder wenn der Hinweis vom Plugin Lernen das anbietet.
---

# Beobachtungen auswerten

Ziel: Aus den Stellen, an denen der Nutzer dich korrigiert oder gelobt hat, wird dauerhaft etwas Besseres. Du änderst
nichts ohne sein ausdrückliches Ja.

## Ablauf

1. Hol die neuen Beobachtungen mit dem Werkzeug `mcp__lernen__beobachtungen`. Gibt es keine, sag das in einem Satz und
   hör auf.
2. Lies auch die geltenden Regeln (`mcp__lernen__regeln`), damit du nichts doppelt vorschlägst.
3. Fass ähnliche Beobachtungen zusammen. Eine einzelne Laune ist noch keine Regel: Vorschläge nur, wenn etwas
   mindestens zweimal vorkam oder der Nutzer es ausdrücklich als Wunsch gesagt hat ("immer", "nie", "ab jetzt").
4. Mach höchstens fünf Vorschläge, jeder in genau einer dieser Formen:
   - **Regel**: ein kurzer Satz, der künftig immer gilt, zum Beispiel „Antworte auf Deutsch und in höchstens drei
     Sätzen, außer ich frage nach Details.“
   - **Skill verbessern**: welcher Skill (Pfad zur SKILL.md), welche Stelle, was genau sich ändert. Skills liegen unter
     `~/.claude/skills/<name>/SKILL.md` (unter Windows `%USERPROFILE%\.claude\skills\...`) oder im Projekt unter
     `.claude/skills/`. Skills aus installierten Plugins änderst du nicht, dort schlägst du eine Regel vor.
   - **Neuer Skill**: wenn der Nutzer etwas immer wieder von Hand erklärt hat. Name, wann er passt, die Schritte.
     Ist das Plugin `skill-creator` installiert, nutze es zum Anlegen.
   Zu jedem Vorschlag: die Beobachtung dahinter in einem halben Satz („Du hast zweimal gesagt, dass ...“).
5. Frag einmal gesammelt, welche Vorschläge er will (zum Beispiel „1 und 3“). Setz nur die um, die er bestätigt:
   Regeln mit `mcp__lernen__regel`, Skill-Änderungen mit dem Edit-Werkzeug, neue Skills als eigener Ordner mit SKILL.md.
6. Markiere danach alle besprochenen Beobachtungen mit `mcp__lernen__erledigt` als ausgewertet, auch die abgelehnten.
7. Zum Schluss ein Satz, was jetzt anders ist.

## Was du nie tust

- Regeln oder Skills ohne Ja ändern oder anlegen.
- Passwörter, Schlüssel oder private Daten in Regeln oder Skills schreiben.
- Lob in Regeln verwandeln, die etwas verbieten. Lob heißt: das beibehalten.
- Eine Regel, die einer bestehenden widerspricht, still dazulegen. Dann fragst du, welche gelten soll, und löschst die
  alte mit `mcp__lernen__regel_loeschen`.
