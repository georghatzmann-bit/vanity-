# Test checklist – full version

This is how you test Niobium with your real Fortnite 19.10. Please go **in this order**. For every
point that doesn't work: a screenshot + the log (see "What I need" at the end).

Niobium used to be called Vanity. If you had Vanity installed, Niobium takes over your settings by
itself – this checklist tells you what to look for.

A German copy of this list is in [`03-test-checklist.de.md`](03-test-checklist.de.md).

## Download

Direct link (always the latest build):
**https://github.com/georghatzmann-bit/vanity-/releases/download/niobium-test/Niobium-Setup.exe**

Windows may say "Windows protected your PC", because the installer isn't signed → **More info** →
**Run anyway**. It only installs for your Windows user, without admin rights. If your antivirus blocks
the DLLs: add `%LOCALAPPDATA%\Niobium` as an exception (Niobium installs into this folder and also keeps
its logs and server data there). All OG launchers need this, because the DLLs are loaded into Fortnite.

## Before you start

- Close Reboot Launcher, the old Vanity launcher and Fortnite completely (Task Manager: no
  `FortniteClient-Win64-Shipping.exe`).
- Is port 80 free? If Skype, IIS or something else uses it, set Niobium → **Settings** → **Network** →
  **Matchmaker port** to e.g. 8080.
- **Backend port** shows 3551 and **Game server port** 7777. Both are fixed (the DLLs always use them),
  so you can't change them.
- Windows Firewall: on the first start Windows asks about `node.exe` and Fortnite – **Allow** (private
  networks are enough).

## Step 0 – Install

- [ ] Start `Niobium-Setup.exe`. First a small dark Niobium card fades in and out.
- [ ] Then the dark installer: "Welcome to Niobium", with the logo on the left. **Next** → leave the folder
      as it is → **Install**.
- [ ] Only if you had Vanity installed: the installer removes the old Vanity program quietly – you don't
      have to do anything. Afterwards the Start menu has "Niobium" and no "Vanity" any more. Your Vanity
      settings are not deleted.
- [ ] After installing, the Finish page comes up by itself: "You're ready to drop.", with the checkboxes
      "Create desktop shortcut" and **"Launch Niobium now"** and the link "Source code and help (GitHub)".
      On Windows 11 the title bar of the installer is dark, too.
- [ ] Leave "Launch Niobium now" ticked → **Finish**.

## Step 1 – First start

- [ ] A small card with the Niobium logo, "old seasons, new shine." and a moving line appears in the
      middle of the screen. Shortly after, the big window opens and the card goes away (at the latest after
      8 seconds).
- **If you used Vanity before:**
  - [ ] A card **"What's new"** appears: "Vanity is now Niobium", "Bubble Builds", "A fresh look",
        "Everything in English" → **Got it**.
  - [ ] **Library** still has your 19.10 build. **Profiles** still has your profiles (the profile
        "Standard" is now called "Default").
  - [ ] **Live Log**, source **Niobium**: a line "Copied your settings from Vanity to Niobium (…). The old
        Vanity folders were left as they are."
- **If Niobium is new on this PC:**
  - [ ] A full-window welcome: "Welcome to Niobium" → **Let's set it up** → "What should we call you?"
        (3–16 letters or numbers) → **Next** → "Add your Fortnite build" → **Browse** → your 19.10 folder →
        **Check** → **Add build** → "You're all set" → **Let's go**.
  - [ ] Doing it later is fine too: **Skip setup** (top right) closes the welcome.
- [ ] Close Niobium and open it again → no welcome and no "What's new" any more.
- [ ] Everything you see is in English, also the buttons and pop-up messages.

## Step 2 – Add a build (without starting Fortnite)

Skip this if you added the build in the welcome or it came over from Vanity.

- [ ] **Library** → **Add a build** → **Browse** → `C:\Users\georg\Downloads\windows-19.10` → **Check**.
- [ ] Four green ticks: "Found FortniteClient-Win64-Shipping.exe", "Version: 19.10 (CL-18675304)",
      "Game files found (… .pak files)", "Version 19.10: Tested". Below that: "Fortnite 19.10",
      "Chapter 3 · Season 1 · Unreal Engine 5.0" (if it says "Unreal Engine (unknown)", that's fine too).
- [ ] **Add build** → a card appears with "Tested" and "Active". Its row "Bubble Builds" shows "—"
      (19.10 has no Bubble Builds). The profile "Default" was created by itself (page **Profiles**).
- [ ] On the card, **Open folder** → Explorer opens the build folder.
- [ ] Close Niobium and open it again → the build and the profile are still there.

## Step 3 – Host & Play: backend and server

On **Home**, press **Host & Play**. The panel "Launch steps" shows seven steps (Backend, Server, Redirect,
Login, Your game, Game server, Lobby). Also watch the page **Live Log** (in the sidebar). Expected order:

- [ ] "Backend is listening on 127.0.0.1:3551" (step *Backend*).
- [ ] "Starting the server Fortnite: …" and "Redirect loaded" (steps *Server*, *Redirect*).
      The server Fortnite runs **without a window** (`-nullrhi`). You only see it in Task Manager.
- [ ] In the server log, a line with `ContinueLoggingIn`, marked **"Logged in"** (step *Login*).
      → If you get "Can't reach the backend" or "Build damaged" instead: send me the log.
- [ ] Shortly after: "niobium_server.dll loaded" and a **new window "Magnesium (FN 19.10, UE 5.0)"**.
      That is the server window – it stays open while the server runs. Don't close it.
- [ ] At the same time **your game** starts ("Starting your game: …", step *Your game*) – a normal
      Fortnite start up to the lobby. Don't log in, there is no login: Niobium logs you in with the
      player name of your profile.
- [ ] Shortly after the server window, the pop-up **"The server is waiting for you"** appears (the
      control pipe is connected). Now go to **Match Control** → tab **Game** → **Start match** – or press
      **START SERVER** at the bottom left of the server window.
      If you want, set "Mode" and "Lategame" in "Game mode" on the same page first – that only works
      before the start.
- [ ] After 1–3 minutes (map loading): the server log shows `IpNetDriver listening on port 7777`, and
      the pop-up **"Server ready"** appears (step *Lobby*). Home says "You're in. Press Play in Fortnite."

If you get "The game server isn't answering": look at the Live Log (source **Server**) and at **Crash
Analysis**. It says in plain words what happened.

## Step 4 – Join the match

- [ ] In the game: the lobby is there, your name is at the top, the skin is the default one (the backend
      has everything it needs).
- [ ] The game mode doesn't matter (Solo is enough) → press **Play**.
- [ ] The matchmaker sends you to 127.0.0.1:7777 → loading screen → you stand on the spawn island or
      in the bus (depends on the server settings).
- [ ] You can walk, build, edit and pick up weapons.

If the game can't connect to the server: was "Server ready" already there? If not, wait and press
Play again.

## Step 5 – Get to know the server window (Magnesium)

A lot also works in the launcher: page **Match Control** (mode, Lategame, bus, storm, items, trickshot,
bots). The server window can do more (its texts come from Magnesium):

- [ ] **Playlist**: buttons such as "Solos", "Duos", "Tournament Solos" (Arena), "Zero Build …". Pick one
      before the start, then start the match.
- [ ] Tick **Late Game** → Lategame mode (loadouts, small zone).
- [ ] **Bots**: enter a number and spawn them; "Use Custom Bot Names" for your own names.
- [ ] **Trickshot**: tick "Enable Trickshot Tab" → a new tab with waypoints, slow motion ("Toggle Crown
      Slomo"), "Negate Velocity on Win", "Auto Reload on Waypoint TP" and more.
- [ ] **Handy for testing**: "Infinite Materials", "Infinite Ammo", "Infinite Respawns", "Siphon".
- [ ] Tick "Save Settings" → the settings are saved in `%LOCALAPPDATA%\Niobium\server\`.

## Step 6 – In-game menu (F9)

Whether the DLL is loaded you can see in the Live Log: "niobium_client.dll loaded" (source **Game**).

- [ ] In the game, press **F9** → the menu "Niobium | Menu" opens and the mouse is free.
      On the left there are five tabs: **Main**, **Commands**, **Options**, **Trickshot**, **Credits**.
      Everything is in English.
- [ ] Tab **Main** → "Editing": switch "Reset on release" on and off and check it while editing in the game.
      In 19.10 this is the only toggle there. "Edit on release" only exists up to 10.40,
      "Disable pre-edits" only up to 15.10.
- [ ] Tab **Main** → "Field of view": move the slider "Degrees (normal: 80)" → the picture changes at once.
      "Back to 80" sets it back to normal.
- [ ] **F8** → console; type `fov 110` → Enter.
- [ ] Tab **Options** → "Keys" → **Change menu key [F9]** → press another key → now the menu opens with the
      new key. Then set it back to F9.
- [ ] Tab **Options** → "Build look": on 19.10 it says "Bubble Builds: Not available on 19.10".
- [ ] Tab **Trickshot**: it has four sections.
      - "Load a parkour": one card per course (name, easy/medium/hard, short description, button
        **Load**), below that "Start over" and "Clear everything".
      - "Target bot": sliders "Health" and "Distance", plus "Place bot in front of me", "Remove all bots",
        "Bring bots to me".
      - "Gear": "Give sniper", "Give launch pads", "Refill ammo", "Refill health".
      - "Practice": "Save spot", "Back to spot", "Launch me up", "Slow motion", "Low gravity",
        "Normal gravity", "Invincible on/off", "Pause storm".
      If you are still in the lobby, a hint at the top says: "You're still in the lobby. Start a match
      first – then these buttons work."
- [ ] In the match, try it quickly: "Save spot", walk a bit away, "Back to spot" → you are back at the old
      spot. After every click, the section shows "Sent: …" for a moment.
- [ ] The same spot works from the launcher too: "Save spot" in F9, then **Match Control** → tab
      **Trickshot** → "Spot & gear" → **Back to spot** → you are back at the spot.
- [ ] Tab **Credits**: at the bottom it says "Niobium is based on ATLAS Console by cipherfps, ralz and
      contributors."
- [ ] Your settings are saved in `%APPDATA%\Niobium\client.json`.

## Step 7 – Test the trickshot parkours

A parkour is a ready-made trickshot course: a platform in the air, jump objects and target bots that
stand still. Test it in a Solo match. You must already stand on the island – not in the lobby, not in
the bus.

The server's answers appear in the console (**F8**). They start with "[Niobium]".

- [ ] **Load:** **F9** → tab **Trickshot** → at "First Jump" click **Load**.
      Or in the launcher: **Match Control** → tab **Trickshot** → card "First Jump" → **Load**.
      The launcher buttons act on you (the player at this PC). If you're not in the match, on the first
      other player.
- [ ] This should happen:
      - You stand in the middle of a wooden platform (3 × 3 tiles), about 25 m above where you were.
      - The course lies in your view direction, and you look forward.
      - 9 m in front of you, just past the edge of the platform and 1 m lower, is a trampoline
        (depending on the version a stack of tyres or a bouncy umbrella).
      - 40 m in front of you a bot stands on a single tile. It doesn't move and has 50 health, no shield.
      - You have a sniper in your inventory.
      - The console says: "[Niobium] "First Jump" is ready! Built: 10 floors, 1 jump objects, 1 target bots."
- [ ] **Trickshot:** run onto the trampoline and hit the bot while you are in the air.
      → At the top centre of the screen a big **TRICKSHOT!** appears, below it your name and the distance
      in metres (for about 3.5 seconds). At the same time the launcher shows "TRICKSHOT! <your name>".
      If you hit it while standing, there is no banner – that's correct.
      No banner even though you jumped? In the launcher: **Match Control** → **Trickshot** → "Trickshot
      banner" → **Banner on** must be on.
- [ ] **Start over** (in F9 or in the launcher): you stand at the start again and look forward.
      Health and shield are full, the weapons are loaded. If you eliminated the bot, it is back.
      The console says: "[Niobium] Back at the start of "First Jump". Full health, weapons reloaded. …"
- [ ] **Target bot:** F9 → Trickshot → "Target bot": Health 50, Distance 30 m → **Place bot in front of me**
      (in the launcher the button is called **Place bot**).
      → A bot appears exactly in your view direction, 30 m away, at your height, on a tile.
      The console says: "[Niobium] Target bot is 30 m in front of you (50 health). Remove it: parkour clear"
- [ ] **Clear everything** (in F9 or in the launcher): platforms, trampoline and all target bots are gone –
      also the bot from "Place bot in front of me". The console says: "[Niobium] Removed … pieces and …
      target bots."
      Careful: if you stand on the platform at that moment, you fall down.
- [ ] Feel free to load the other courses too, e.g. "Geyser Shot" or "Ground Course".
      A new parkour clears the old one by itself.

**If something is wrong, please send me this:**

- **A platform is half off.** After loading you stand at the edge of the platform instead of the middle
  (or fall down right away), or a bot stands next to its tile.
  Then send a screenshot from above at an angle: in the Trickshot tab press "Launch me up", then look down.
  Write which way the tiles moved – left, right, forward or back (as you look at the start) – and roughly
  how far: half a tile (about 2.5 m) or a whole one (about 5 m). Plus the Fortnite version.
  Why: Niobium must know at which point Fortnite "holds" a floor tile. That was only checked with real
  builds from 10.40. Your picture shows whether it is right in your version too.
- **An object is missing.** The console then says for example "[Niobium] Not in this version (left out):
  Trampoline." Send exactly this line and the Fortnite version. Then I look for a replacement that exists
  in your version.
- **Another message**, for example "None of the listed sniper rifles exist in this version.",
  "… jump objects couldn't be placed.", "… target bots couldn't spawn." or "The parkour list is missing.
  Please start the game from the Niobium launcher.": copy the line or take a photo of it.

## Step 8 – Bubble Builds (needs a 15.40 – 16.00 build)

Bubble Builds is the see-through "bubble wrap" build look of Chapter 2 Seasons 5–6. It only exists in
Performance Mode on Fortnite 15.40 – 16.00. On 15.30 and 16.10 – 16.40 it is "Experimental" (may or may
not show up). You can't switch it while playing – it applies on the next launch.

If you don't have such a build: only do the part "On 19.10" at the end.

**Get the build ready.** Right now a new profile always uses the *first* build in the Library. So:

- [ ] **Library** → on the 19.10 card **…** → **Remove from list** (your files stay untouched).
- [ ] **Add a build** → your 15.40 – 16.00 folder → **Check** → **Add build**.
- [ ] The card's row "Bubble Builds" shows **Supported** (or **Experimental** on 15.30 / 16.10 – 16.40);
      hovering over it shows the explanation. The number "Bubble Builds ready" at the top counts it.
- [ ] **Profiles** → **New profile** → a name such as "Bubble test", your player name → **Create** → on the
      new card **Use this profile**. The card says "Build: Fortnite 15.…".
- [ ] Later you add 19.10 again the same way; the profile "Default" then works again by itself.

**Switch it on and play:**

- [ ] **Settings** → the "Bubble Builds" card at the top → switch it on ("On"). Below the text it says
      "Works on your active build, Fortnite 15.…" (or the "Experimental" text).
- [ ] **Home**: next to "Active build" there is a "Bubble Builds" chip.
- [ ] **Host & Play.** The Live Log says "Bubble Builds on: starting in Performance Mode
      (-FeatureLevelES31)". The line "Starting your game: …" contains `-FeatureLevelES31`; the line
      "Starting the server Fortnite: …" does **not**.
- [ ] In the game, the graphics are simpler (Performance Mode). In a match, build a few walls and floors →
      they have the see-through "bubble wrap" look. Please send a screenshot.
- [ ] **F9** → **Options** → "Build look": "Bubble Builds: On (set in the launcher)" with a green dot.
- [ ] **Stop all.** If Fortnite saved Performance Mode as its default, a window "Performance Mode is now
      saved" appears: "Fortnite saved Performance Mode as your default. This also affects your other builds.
      Reset it?" → **Reset** → the pop-up "Performance Mode reset". (If no window appears, Fortnite didn't
      change the setting – that's fine too.) **Keep** leaves it as it is.
- [ ] Switch Bubble Builds off → **Host & Play** again → no `-FeatureLevelES31` in the log; F9 → Options says
      "Bubble Builds: Off – turn it on in the launcher, then restart the game."

**On 19.10** (with the switch on):

- [ ] The Settings card says "Your active build is Fortnite 19.10. Only on Fortnite 15.40 – 16.00 (Chapter 2,
      Seasons 5–6). Try Mobile Builds in the F9 menu."
- [ ] **Host & Play** → the Live Log says "Bubble Builds are on, but Fortnite 19.10 can't show them –
      starting normally". The game starts exactly as without the switch.
- [ ] F9 → **Main** → "Graphics" → **Mobile Builds**: works on every version, right away.

## Step 9 – Stop

- [ ] Home → **Stop all** → game, server Fortnite, server window and backend are gone (Task Manager: no
      `FortniteClient-Win64-Shipping.exe`, no `node.exe` from Niobium).
- [ ] Also look for `FortniteLauncher.exe` and `FortniteClient-Win64-Shipping_EAC.exe` in Task Manager. If
      they are still there (paused), please tell me.
- [ ] **Host & Play** again → it works a second time without restarting Niobium.

## Testing other versions (untested, but they start)

Niobium starts every version from 1.7 to 30.x. For everything except 19.10: the same steps as above,
only the build card shows "Untested" and the log has a note. If it doesn't work, these three files matter:

- `%LOCALAPPDATA%\Niobium\logs\redirect.log` – was the redirect in place? ("Ready - …" or a line with "ERROR:")
- `%LOCALAPPDATA%\Niobium\logs\client-diagnostics.log` – did the in-game menu start?
- `<build>\FortniteGame\Binaries\Win64\stdout.log` and the folder `MagnesiumCrashes` next to it – what the
  game server says.

Known limits: 9.40–10.40 without party/XMPP; "Edit on release" only up to 10.40; 31.00 and newer don't
start yet. For trickshot parkours there may be other objects depending on the version – if one is
missing, the server says so in the console (see Step 7).

## What I need when something doesn't work

1. **Which step** of this list (e.g. "Step 3, 'Logged in' doesn't come").
2. **Screenshot** of the launcher (launch steps + Live Log) and, if it helps, of the game or server window.
3. **Logs**: page **Live Log** → **Copy** (or the files from `%LOCALAPPDATA%\Niobium\logs\`; the button
   **Folder** opens it).
4. If Fortnite crashed: page **Crash Analysis** → the newest entry → **Copy report**.
5. For trickshot things: the lines from the console (**F8**) that start with "[Niobium]".
6. For Bubble Builds: a screenshot of your builds in the game and the "Starting your game: …" line.

Short and honest: I can't start Fortnite here. Everything up to the loading screen is rebuilt 1:1 from
the source projects (Reboot launch flow, LawinServer, Tellurium, Magnesium) and checked against how they
behave – whether it runs on your PC, only this test shows.
