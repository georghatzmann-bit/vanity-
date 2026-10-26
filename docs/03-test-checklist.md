# Test checklist – full version

This is how you test Niobium with your real Fortnite 19.10. Please go **in this order**. For every
point that doesn't work: a screenshot + the log (see "What I need" at the end).

Niobium used to be called Vanity. If you had Vanity installed, Niobium takes over your settings by
itself – this checklist tells you what to look for.

A German copy of this list is in [`03-test-checklist.de.md`](03-test-checklist.de.md).

**New in this version** (Steps 10–15): "Classic match" profiles, picking up and swapping weapons, floor
loot and the loot list on 19.10, AI bots on 19.10 (experimental), "Download a version" (now also 21.x to 30.x)
and "Bosses & NPCs" (experimental, still being built). None of it has been tested in a real game yet – that's
what these steps are for.

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
- [ ] You can walk, build, edit and pick up weapons. Profiles now play a "Classic match" unless you
      switch something on: ammo and materials run out like back then, so farm some wood with the
      pickaxe before you build (more in Step 10).

If the game can't connect to the server: was "Server ready" already there? If not, wait and press
Play again.

## Step 5 – Get to know the server window (Magnesium)

A lot also works in the launcher: page **Match Control** (mode, Lategame, bus, storm, items, trickshot,
target dummies). The server window can do more (its texts come from Magnesium):

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
- [ ] Tab **Main** → "Editing": all three rows are there on every version – "Edit on release",
      "Reset on release", "Disable pre-edits". Switch each one on and off and check it while editing.
      On 19.10, "Edit on release" and "Disable pre-edits" say "Uses Fortnite's own … setting": then
      Fortnite's own setting (Settings → Game) changes too – check that it shows the same. "Reset on
      release" uses Niobium's own code on 19.10 (no such line under it). If a row is grey, a screenshot please.
- [ ] Tab **Main** → "Field of view": move the slider "Degrees (normal: 80)" → the picture changes at once.
      "Back to 80" sets it back to normal.
- [ ] **F8** → console; type `fov 110` → Enter.
- [ ] Tab **Options** → "Keys" → **Change menu key [F9]** → press another key → now the menu opens with the
      new key. Then set it back to F9.
- [ ] Tab **Main** → "Graphics" → **Bubble look** on → in a match, build a few walls → the see-through part
      looks soft and bubbly. The line below says "Bubble look: on (4 of 4 build textures)" (or "waiting for
      the build textures. Place one build piece."). Move "Bubble strength" → it changes right away.
      Screenshot please, with Bubble look on and off.
- [ ] Tab **Options** → "Build look": on 19.10 it shows the Bubble Builds status (see Step 8).
- [ ] **Reset builds** (Tab **Options** → "Reset builds"):
      - Switch "Reset builds" on → **Reset builds key [none]** → press a key (for example the key you use
        for Reset in Fortnite; not the left or right mouse button).
      - Join a match → the status turns from "Checking the server..." to **"Ready."** (green dot).
      - Build a wall, edit it (e.g. a window or a door), confirm. Then look at it **without** pressing the
        edit key and press your Reset builds key → the wall is a full wall again.
      - The normal way still works: edit key → Reset in edit mode.
      - While you are editing a piece and press the Reset builds key: nothing strange happens, your edit
        just keeps going.
      - Try it from far away (more than about 20 m): nothing happens.
      - Server window: switch "Allow Reset Builds Key" off → start a new match → the status says "This
        server can't do it. It needs a Niobium server."
      - If something is wrong: the lines with `[reset-builds]` from the server's `stdout.log`.
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

## Step 8 – Bubble Builds (15.40 – 16.00, and as an experiment on 19.10)

Bubble Builds is the see-through "bubble wrap" build look of Chapter 2 Seasons 5–6. It only exists in
Performance Mode on Fortnite 15.40 – 16.00. On 15.30 and 16.10 – 16.40 it is "Experimental" (may or may
not show up). On **19.x** it is also "Experimental": Performance Mode plus **Meshes: Low** – close to the
old look, not the same. You can't switch it while playing – it applies on the next launch.

With Bubble Builds on, Niobium changes three lines in Fortnite's own settings file for this one game and
**puts them back by itself afterwards** (you agreed to that). Before you start, please make a copy of
`%LOCALAPPDATA%\FortniteGame\Saved\Config\WindowsClient\GameUserSettings.ini` (for example on the desktop),
so you can compare it at the end.

**On 19.10** (no other build needed):

- [ ] **Settings** → the "Bubble Builds" card at the top → switch it on. It has the badge "Experimental" and
      says "Works as an experiment on your active build, Fortnite 19.10. It's not the exact Chapter 2 look."
- [ ] **Library**: the 19.10 card shows "Bubble Builds: Experimental".
- [ ] **Host & Play.** The Live Log says:
      - "Backed up Fortnite's graphics settings. They are put back when the game closes."
      - "Meshes set to Low for this game (it was …)." – or "Meshes is already Low."
      - "Bubble Builds on: starting in Performance Mode (-FeatureLevelES31)"
      - The line "Starting your game: …" contains `-FeatureLevelES31`; the line "Starting the server
        Fortnite: …" does **not**.
- [ ] While the game runs there is a file `%LOCALAPPDATA%\Niobium\gus-backup.json`.
- [ ] In the game the graphics are simpler. In a match, build a few walls and floors → while they go up,
      they look whiter and more see-through. Screenshot please.
- [ ] **F9** → **Options** → "Build look": "Bubble Builds: On (Performance Mode, Meshes Low)" with a green dot.
- [ ] **Stop all.** A moment after the game has closed: the Live Log and a pop-up say **"Fortnite's graphics
      settings were put back."** The file `gus-backup.json` is gone.
- [ ] Compare `GameUserSettings.ini` with your copy: the lines `bPreferFeatureLevelES31`,
      `PreferredFeatureLevel` and `MeshQuality` are like before. (Other lines Fortnite itself saved during
      the game, such as the last played time, may differ – that's normal.)
- [ ] **Crash test (optional):** Host & Play with Bubble Builds on → while the game runs, end `Niobium.exe`
      in Task Manager → close Fortnite too → start Niobium again → the Live Log says the settings were put
      back.
- [ ] Switch Bubble Builds off → **Host & Play** again → no `-FeatureLevelES31` and no "Backed up …" line
      in the log; F9 → Options says "Bubble Builds: Off – turn it on in the launcher, then restart the game."

**On 15.40 – 16.00** (only if you have such a build):

- [ ] **Library** → on the 19.10 card **…** → **Remove from list** (your files stay untouched). Right now a
      new profile always uses the *first* build in the Library.
- [ ] **Add a build** → your 15.40 – 16.00 folder → **Check** → **Add build**. The card's row "Bubble
      Builds" shows **Supported** (or **Experimental** on 15.30 / 16.10 – 16.40).
- [ ] **Profiles** → **New profile** → a name such as "Bubble test" → **Create** → **Use this profile**.
- [ ] **Host & Play** → the same log lines as above. In a match, the builds have the see-through "bubble
      wrap" look. Screenshot please. F9 → Options → "Build look" with a green dot.
- [ ] **Stop all** → "Fortnite's graphics settings were put back."
- [ ] Later you add 19.10 again the same way; the profile "Default" then works again by itself.

**Other versions:** the Settings card says "Not available for <version>. … try Bubble look in the F9 menu."
**Host & Play** → "Bubble Builds are on, but Fortnite <version> can't show them – starting normally", and
Fortnite's settings file is not touched. F9 → Main → "Graphics" → **Bubble look** and **Mobile Builds**
work on every version, right away.

## Step 9 – Stop

- [ ] Home → **Stop all** → game, server Fortnite, server window and backend are gone (Task Manager: no
      `FortniteClient-Win64-Shipping.exe`, no `node.exe` from Niobium).
- [ ] Also look for `FortniteLauncher.exe` and `FortniteClient-Win64-Shipping_EAC.exe` in Task Manager. If
      they are still there (paused), please tell me.
- [ ] **Host & Play** again → it works a second time without restarting Niobium.

## Step 10 – Match rules ("Classic match")

"Classic match" means like back then: no Lategame, normal ammo, normal materials. Before, ammo and
materials were always infinite. Now each profile decides.

- [ ] **Profiles** → on your 19.10 profile **…** → **Edit**. On the right, under "Match rules", there are
      three switches: "Lategame", "Infinite ammo", "Infinite materials". On a profile from before this
      version, "Infinite ammo" and "Infinite materials" are now **off**; "Lategame" is as you left it.
- [ ] With all three off, a gold badge says **Classic match**, and below the switches: "Classic match =
      like back then: full map, normal ammo and materials."
- [ ] Switch "Infinite ammo" on → the badge says **Custom** and a button **Classic** appears. Press
      **Classic** → all three are off again. **Save**.
- [ ] The profile card shows "Rules: Classic match" (if something is on, it lists that instead, e.g.
      "Lategame · Infinite ammo").
- [ ] **New profile** → the three switches start off.
- [ ] **Host & Play** with "Classic match" → **Start match** → in the match:
      - when you shoot, the ammo goes down and can run out;
      - building uses up your materials (farm some with the pickaxe first);
      - **Match Control** → **Game** → "Infinite": "Infinite ammo" and "Infinite materials" are off.
- [ ] On **Match Control** switch "Infinite ammo" on → from now on your ammo stays full. Switch it off again.
- [ ] Edit the profile: "Infinite ammo" and "Infinite materials" on → **Save** → **Stop all** →
      **Host & Play** → ammo and materials never run out, and both switches on Match Control are on.

## Step 11 – Picking up and swapping weapons

Before, picking up could get stuck: after one swap, ammo and materials fell back to the ground, a weapon
couldn't be picked up while you held the pickaxe, or your weapon was swapped out although you had a free
slot. Test it in a Solo match on 19.10 (the spawn island before the bus is fine). Pick things up the way
you always do.

- [ ] **Free slot, pickaxe in hand:** pick up a weapon from the ground → it goes into a free slot.
- [ ] **Free slot, weapon in hand:** pick up another weapon → it goes into a free slot. Your weapon is not
      dropped.
- [ ] **All 5 slots full, weapon in hand:** fill your slots (pick up weapons, or in the launcher
      **Match Control** → **Game** → "Give items" → pick a weapon → **Give to me**, with different weapons).
      Hold a weapon (not the pickaxe) and pick up a weapon from the ground → your weapon lands in front of
      you, the new one is in your hand.
- [ ] **Right after that swap:** walk over ammo and wood, stone or metal → they go into your inventory and
      do **not** fall back to the ground.
- [ ] **All 5 slots full, pickaxe in hand:** try to pick up a weapon → it stays on the ground (or lands there
      again). Then take a weapon in your hand and pick it up → now it swaps.
- [ ] **A stack with room:** if you carry a stack that isn't full (e.g. "Small Shield Potion" from "Give
      items") and pick up more of the same → the stack grows, nothing is swapped.
- [ ] In all of this, **nothing disappears**: every item is either in your inventory or on the ground.

## Step 12 – Floor loot and the loot list (19.10)

Before, the server removed the floor loot spots on 19.10 without filling them. Now it fills each spot once
per match. A few empty spots are normal (back then, some spots were empty too).

- [ ] Solo match with "Classic match" → **Start match**. On the spawn island and after you land (for example
      in a named place), weapons, ammo and items lie on the floor in houses.
- [ ] Chests still open and drop loot.
- [ ] **Loot list:** right after **Start match** (while the map loads), go to **Live Log** → **Server** →
      type `loot` in "Search the log…". You see lines with the category "loot":
      - "features: …" (the season's game features that add loot),
      - "items: …" (how many different items can drop),
      - many lines "item …" (one item each, at most 400).
      Press **Copy** and send it to me. Then I can see which Chapter 3 Season 1 items are in the pool.
- [ ] Do season items show up in the match (for example Spider-Man's Web-Shooters)? Write down what you
      found and whether it works.
- [ ] After the match: open `<your 19.10 folder>\FortniteGame\Binaries\Win64\stdout.log` with Notepad, search
      for `[FloorLoot]` and send me those lines (one per kind of spot, `Tiered_Athena_FloorLoot_Warmup_C` and
      `Tiered_Athena_FloorLoot_01_C`). They look like this:
      `[FloorLoot] Tiered_Athena_FloorLoot_01_C: … spots, … filled now, … empty now, … already rolled`.
      No such line on 19.10 → please tell me. (Do this before the next **Host & Play** – the file starts
      fresh with every server start.)

## Step 13 – AI bots (19.10, experimental)

Fortnite's own AI players, meant to drop from the bus, loot and fight like real players. Only on 19.10 with
CL-18675304, and only experimental: nobody has tested them in a game yet. They are not the target dummies
on **Match Control** → **Target dummies**, which stand still.

**Before you start:** the server only switches bots on if your game file is exactly Epic's 19.10 file.
Explorer → `<your 19.10 folder>\FortniteGame\Binaries\Win64\FortniteClient-Win64-Shipping.exe` → right-click →
**Properties** → "Size" should say **198,580,704 bytes**. If it doesn't, bots will be off – please still do the
test and send me the size.

- [ ] **Profiles** → your 19.10 profile **…** → **Edit**. Section "AI bots" with the badge "Experimental ·
      19.10 only". Switch "Play with AI bots" on, "Number of bots" e.g. 30, "Bot skill" **Easy** → **Save**.
      The card shows "AI bots: 30 · Easy" and the tag "AI bots".
- [ ] (If you have another build, e.g. one you downloaded in Step 14:) a profile for it shows the "AI bots"
      section greyed out with e.g. "Fortnite 18.30: AI bots aren't available for this version yet."
- [ ] **Host & Play**. **Match Control** → **Game**: the start card shows "Mode Solo", "Lategame Off" and
      "AI bots 30 · Easy". Press **Start match**.
- [ ] **Live Log**, type `bots` in the search. Expected while the map loads:
      - "checks passed for 19.10 CL 18675304, hooks installed; 30 bots, ELO 500",
      - "service set up, 30 bots, ELO 500 (playlist …)",
      - source **Niobium**: "AI bots are on for this match."
      Later, for example: "bot service started", "spawn amount: 30 bots (…)", "1 bots spawned",
      "10 bots spawned", "cached … POI volumes and … foundations".
- [ ] **If bots are off:** a pop-up "AI bots are off for this match" with the reason (e.g. "Bots aren't
      available for this copy of 19.10."), and in the Live Log a line "disabled: …". The match runs without
      bots. Please send me that "disabled: …" line.
- [ ] In the game, please watch and write down:
      - Do bots appear (before the bus or when it starts)? They may wear default outfits.
      - The bus: the Live Log says "… bots got on the bus". Do the bots jump and glide down?
      - Do they land, pick up weapons, shoot at you, build?
      - How good are they on **Easy**?
      - The storm: do bots outside the storm lose health and get eliminated?
      - Eliminate bots: does the "players left" number go down? When you are the last one: **Victory Royale**?
        (The Live Log then says "all bots are out".)
      - Frame rate and stability: please play 3 matches with 30 bots. Any freezes or crashes? Roughly how many
        FPS?
- [ ] Try **Normal** and **Hard**: **Stop all** → edit the profile → "Bot skill" → **Save** → **Host & Play**
      (the bot settings count from the next start). How do they feel compared to Easy? The Live Log says ELO
      1000 (Normal) or 2000 (Hard).
- [ ] Switch "Play with AI bots" off → **Host & Play** → no "bots" lines, no pop-up, the match is as before.

## Step 14 – Download a version (optional – 18.30 needs about 50 GB and 2 hours, Chapter 5 up to 120 GB)

Niobium can download some old builds. The file list comes from a public GitHub archive, and every game file
comes straight from Epic's own download servers – never from re-uploads. Epic has deleted parts of many old
seasons, so those can't be downloaded. **Chapter 3 Season 1 (19.10) is one of them** – your 19.10 keeps
working. **New:** Chapter 3 Seasons 3 and 4, all of Chapter 4 (with Season OG) and Chapter 5 Seasons 1–3
(21.x to 30.x) can be downloaded now. They are big: about 40 GB (21.x, 22.x) up to about 120 GB (30.x) on disk.

**Look around (nothing is downloaded):**

- [ ] **Library** → **Download a version** (button at the top, or the tile under "Add a build"). The page
      "Download a version" opens; in the sidebar "Library" stays lit.
- [ ] At the top: tabs "Chapter 1" to "Chapter 5". Green numbers: "Chapter 2" 5, "Chapter 3" 2, "Chapter 4" 5,
      "Chapter 5" 3. "Chapter 1" has none.
- [ ] **Chapter 1:** a note "All of Chapter 1 · Not available from Epic." with the explanation, and every
      card says "Not available from Epic".
- [ ] **Chapter 3:** only the note "Seasons 1 and 2 · Not available from Epic." The "Season 1" card says "Epic
      deleted some of its files." and, in green, "Your 19.10 keeps working." "Season 3" and "Season 4" are
      "Available"; "Season 3" says "3 builds · from 35.0 GB" and a short line "Vibin': Reality Tree, Ballers, Darth
      Vader and Indiana Jones. Dragon Ball from 21.40."
- [ ] **Chapter 4:** all five seasons are "Available", no note at the top. "Season OG" says "3 builds · from
      74.2 GB" and "The Chapter 1 map comes back: Season 5 (27.00), Seasons 7–8 (27.10), Seasons 9–X (27.11)."
- [ ] **Chapter 5:** Seasons 1, 2 and 3 are "Available". Click **Season 3** → the newest build is at the top:
      "30.40" with "107.8 GB download · 116.0 GB on disk · about 4 h 50 min at 50 Mbit/s" and, in orange, "Very
      big: about 116 GB on disk. Last Chapter 5 Season 3 update: Fall Guys event (Where We Fallin')." Pick 30.10 →
      below the folder: "Needs about 121.9 GB free on that drive." Then **Cancel**.
- [ ] **Chapter 2:** "Season 3", "Season 5", "Season 6", "Season 7" and "Season 8" are "Available"; "Season 8"
      says "7 builds · from 40.1 GB".
- [ ] Click **Season 8** → a window "Chapter 2 · Season 8". The newest build is at the top: "18.30", with
      "41.1 GB download · 45.4 GB on disk · about 1 h 50 min at 50 Mbit/s" and "Experimental". "Download to" is
      already filled in (e.g. `D:\Niobium\Builds\18.30-CL-17882303`), below it "Needs about 47.5 GB free on
      that drive."
- [ ] **Folder checks** (each time: type the folder into "Download to" and press **Download 18.30** – the red
      text appears under the field, nothing starts):
      - a folder with files in it, e.g. `C:\Users\georg\Downloads` → "This folder already has other files in
        it. Pick an empty folder."
      - if you use OneDrive: a folder in it → "This folder is synced by OneDrive. Pick a folder outside
        OneDrive, or it will try to upload the whole game (up to about 120 GB)."
      - if you have a USB stick with FAT32: a folder on it → "Drive E: can't hold files bigger than 4 GB
        (FAT32). Pick a folder on another drive." (with your drive letter)
      - a drive with too little space → "There isn't enough free space on drive D:. This version needs
        47.5 GB and … GB is free. Free up space or pick another folder." (with your drive letter)
      Then **Cancel**.

**A real download** (only if you have the time and the space; 18.30 is a good choice):

- [ ] Pick 18.30, keep the folder → **Download 18.30**. A card appears at the top with four steps: "Check at
      Epic", "Download", "Check files", "Add to Library". First "Checking that Epic still has every file…
      (a few minutes)", then the percent, the current file, "Downloaded", "Speed", "Time left" and "Files … of
      785". A small progress pill shows in the sidebar, also on other pages ("Checking at Epic, a few minutes").
- [ ] **Pause** → "Pausing…" → "Paused – everything downloaded so far is kept." → **Resume** → it continues
      (first a short "Check at Epic" again, then the percent goes on from where it was).
- [ ] Close Niobium while it downloads → "Close Niobium?" lists "Download (18.30)" → **Stop & close**. Open
      Niobium → **Library** → **Download a version** → the card says "Paused" → **Resume** → it continues.
- [ ] **Cancel** → "Cancel the download of 18.30?" – "Delete the downloaded files? If you keep them,
      downloading 18.30 into the same folder again continues where it stopped." → **Keep files**. Start 18.30
      again into the same folder → it continues instead of starting over.
- [ ] Let it finish: "Check files" → "Add to Library" → "Fortnite 18.30 is ready" – "It's in your Library now.
      Press Play to use it.", the pop-up "18.30 is ready", and in the Live Log "Download of 18.30 finished and
      added to your Library".
- [ ] **Play** → you are on Home, pop-up "Fortnite 18.30 is set" (a profile "Fortnite 18.30" with "Classic
      match" was made, if you had none for this build). **Library** shows an 18.30 card with "Untested".
- [ ] **Host & Play** → does 18.30 start, and can you play a match?
- [ ] If an error card appears: a screenshot of it, plus the Live Log line that starts with "Download of".
- [ ] (Optional, if you have the space) a newer season, e.g. **Chapter 4 → Season OG → 27.11** (87.3 GB on disk)
      or **Chapter 3 → Season 3 → 21.50** (40.1 GB). The steps are the same; "Check at Epic" can take a few
      minutes on the big ones. Then **Host & Play** with it and tell me: does it start, can you play a match?

## Step 15 – Bosses & NPCs (experimental, still being built)

The goal: the season's bosses, guards and creatures walk around, like back then. This is still being built:
the game server gets it season by season (19.10 first). Until your season is built, the server answers "Not
available" – that is fine and expected. Both answers help me, so please send yours. Try 19.10 first, then any
other build you have (e.g. one from Step 14).

- [ ] **Profiles** → your profile **…** → **Edit**. In the box "Match rules" there is a switch "Bosses & NPCs"
      with the badge "Experimental" and the text "Bosses, guards and creatures of this season walk around, like
      back then. Still being built: not every season has them yet." Switch it on. "Max. bosses & NPCs" shows 40
      – leave it → **Save**. The card gets the tag "Bosses & NPCs"; "Rules" still says "Classic match".
- [ ] **Host & Play**. **Match Control** → **Game** → box "Game mode": "Bosses & NPCs" is on, "Max. bosses &
      NPCs" 40. Press **Start match**.
- [ ] While the map loads, a row "This match" appears in the same box with a chip. Both of these are fine –
      write down which one you got:
      - orange "Not available: …" with the reason (today most likely "Not available: not built yet for this
        version"), and one pop-up "Bosses & NPCs aren't available this match", or
      - green "Active" or "Active · N spawned".
- [ ] **Live Log** → click the filter **Bosses & NPCs** (next to Info/Warning/Error). You see the server's
      `[LivingWorld]` lines (shown without the tag, category "livingWorld"), and from source **Niobium** one line
      like "Bosses & NPCs aren't available: …" or "Bosses & NPCs are on: N spawned." → **Copy** and send me these
      lines. Click **Bosses & NPCs** again to see everything.
- [ ] Only if the chip said "Active": in the game, write down what you see. Do bosses, guards or animals show
      up? Where? Any freezes or crashes?
- [ ] When the match is over, the row "This match" goes away.
- [ ] Switch "Bosses & NPCs" off in the profile → **Host & Play** → **Start match**: no row "This match", no
      pop-up, no "Bosses & NPCs" line from **Niobium** in the Live Log – the match is as before.

## Testing other versions (untested, but they start)

Niobium starts every version from 1.7 to 30.x. For everything except 19.10: the same steps as above,
only the build card shows "Untested" and the log has a note. If it doesn't work, these three files matter:

- `%LOCALAPPDATA%\Niobium\logs\redirect.log` – was the redirect in place? ("Ready - …" or a line with "ERROR:")
- `%LOCALAPPDATA%\Niobium\logs\client-diagnostics.log` – did the in-game menu start?
- `<build>\FortniteGame\Binaries\Win64\stdout.log` and the folder `MagnesiumCrashes` next to it – what the
  game server says.

Known limits: 9.40–10.40 without party/XMPP; 31.00 and newer don't
start yet; AI bots only on 19.10 (CL-18675304). For trickshot parkours there may be other objects
depending on the version – if one is missing, the server says so in the console (see Step 7). A build you
downloaded in Step 14 is tested the same way.

## What I need when something doesn't work

1. **Which step** of this list (e.g. "Step 3, 'Logged in' doesn't come").
2. **Screenshot** of the launcher (launch steps + Live Log) and, if it helps, of the game or server window.
3. **Logs**: page **Live Log** → **Copy** (or the files from `%LOCALAPPDATA%\Niobium\logs\`; the button
   **Folder** opens it).
4. If Fortnite crashed: page **Crash Analysis** → the newest entry → **Copy report**.
5. For trickshot things: the lines from the console (**F8**) that start with "[Niobium]".
6. For Bubble Builds: a screenshot of your builds in the game, the "Starting your game: …" line and the
   lines with "graphics settings" or "Meshes".
7. For Reset builds: a screenshot of F9 → Options → "Reset builds" and the `[reset-builds]` lines from
   the server's `stdout.log`.
8. For AI bots: Live Log → search `bots` → **Copy**, plus what you saw in the game (Step 13).
9. For loot: Live Log → search `loot` → **Copy**, plus the `[FloorLoot]` lines from `stdout.log` (Step 12).
10. For a download: a screenshot of the download card and the Live Log lines that start with "Download of".
11. For Bosses & NPCs: the text on the chip, the build version, and the Live Log lines of the filter **Bosses &
    NPCs** (**Copy**) (Step 15).

Short and honest: I can't start Fortnite here. Everything up to the loading screen is rebuilt 1:1 from
the source projects (Reboot launch flow, LawinServer, Tellurium, Magnesium) and checked against how they
behave – whether it runs on your PC, only this test shows. The same goes for the new parts: the AI bots,
the pickup and floor loot fixes only passed a test compile here, and the downloader only fetched three
small files from Epic's servers in a test – a full download, the bots and the loot have never run in a
real game. The new seasons 21.x–30.x haven't run in a real game either, and Bosses & NPCs are still being built
(today the server answers "Not available").
