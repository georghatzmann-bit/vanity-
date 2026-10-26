# Phase 1 – Test checklist (UI) – archived

> **Archived.** This was the checklist for phase 1 (October 2026), when the launcher was still called
> Vanity, was in German and only showed sample data. It is kept as a record. The quoted texts below are
> English translations of the old German screens and don't all match today's app.
> **For the current app use [`03-test-checklist.md`](03-test-checklist.md)** (German:
> [`03-test-checklist.de.md`](03-test-checklist.de.md)).

In phase 1 only the **design** was finished. The buttons showed what it would look like later, but
didn't start anything yet. Fortnite, the backend and the DLLs came from phase 2 on.

## How to get the launcher (back then)

**Way A – ready-made installer (recommended):**

1. On GitHub in the repository `vanity-`, click **Actions** at the top
   (https://github.com/georghatzmann-bit/vanity-/actions).
2. Open the top run "Launcher" with a green tick (branch `claude/eloquent-wozniak-en0j35`).
3. At the very bottom under **Artifacts**, click `Vanity-Installer-…` → download the ZIP.
4. Unzip it and start `Vanity_0.1.0_x64-setup.exe`.
5. Windows may say "Windows protected your PC", because the installer isn't signed →
   **More info** → **Run anyway**. It only installs for your user, without admin rights.

Today the installer is called `Niobium-Setup.exe` and has a direct link – see `03-test-checklist.md`.

**Way B – build it yourself:** see `README.md` → "Build it yourself".

## What to test

Tick what works. If something looks odd: send me a screenshot.

### Window
- [ ] The window has no Windows frame but its own dark title bar.
- [ ] Drag the title bar at the top left → the window moves.
- [ ] Double-click the title bar → maximised / small again.
- [ ] The three buttons at the top right: minimise, maximise, close (red on hover).
- [ ] Make the window narrower at the edge → below about 1200 pixels the sidebar gets narrow (icons
      only). Hovering shows the name.

### Home
- [ ] Click **Host & Play** → the seven steps run one after another, the three service cards turn
      orange ("Starting…") and then green ("Running").
- [ ] While it runs, switch to another page and back → the sequence keeps running.
- [ ] At the end, "Lobby reached (preview)" appears at the bottom right.
- [ ] **Stop all** → everything grey again ("Stopped").
- [ ] At the bottom left of the sidebar, "Services" shows the same state.

### Click through the pages
- [ ] **Library**: a card for 19.10, "Add a build" → "Check" ticks off four points.
- [ ] **Servers & Friends**: type nonsense into the IP field → a red message; `100.101.12.7` → the
      button becomes active.
- [ ] **Match Control**: tabs Match / Bots / Trickshot, sliders and switches move.
      Under Bots, picking "Opponents" made the difficulty active and showed a hint.
- [ ] **In-game Menu**: the switches on the left change the preview on the right. Click "F9", press
      another key → it is taken over (Esc cancels).
- [ ] **Profiles**: create a "New profile" → it shows up as a new card; activating it works.
- [ ] **Live Log**: sample lines come in, the filters (Game/Server/…) and the search work, "Logged in"
      is marked in violet.
- [ ] **Crash Analysis**: three sample crashes, "Technical details" opens.
- [ ] **Settings**: "Glass effect" off → surfaces become solid. "Reduce motion" on → page changes
      without movement. Both are kept after restarting the launcher.
- [ ] **About & Credits**: clicking a project opens its page in the browser.

### Feel
- [ ] Animations feel smooth, not sluggish.
- [ ] Texts are easy to read, nothing is cut off or overlaps.
- [ ] Do you like the colour (violet)? If not: tell me which one you'd rather have.

## Feedback

Just write to me: "Phase 1 works" – or what you noticed (a screenshot is welcome).
After that, **phase 2** followed: really importing a build, starting Fortnite 19.10, a live log from
the real game.
