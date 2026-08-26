-- Tests for scripts/vanity-toolkit.lua
-- Run: lua5.4 test/vanity-toolkit_test.lua

local H = dofile("test/stubs.lua")
local w = H.world

local passed, failed = 0, 0

local function check(name, ok, detail)
    if ok then
        passed = passed + 1
        H.realPrint(("  ok    %s"):format(name))
    else
        failed = failed + 1
        H.realPrint(("  FAIL  %s%s"):format(name, detail and ("  -> " .. detail) or ""))
    end
end

local function eq(name, got, want)
    check(name, got == want, ("got %s, want %s"):format(tostring(got), tostring(want)))
end

local function section(t) H.realPrint("\n" .. t) end

local function clearCalls()
    H.calls = {}
    H.recordCall = H.recordCall
end

-- The button/func for an entry inside a flat or tabbed submenu.
local function submenuFunc(menuName, itemName)
    local menu = H.ui[menuName]
    if not menu or not menu.items then return nil end
    for _, item in ipairs(menu.items) do
        if item.options then
            for _, opt in ipairs(item.options) do
                if opt.name == itemName then return opt.func end
            end
        elseif item.name == itemName then
            return item.func
        end
    end
    return nil
end

local function lastPrompt()
    for i = #H.ui, 1, -1 do
        if H.ui[i].kind == "prompt" then return H.ui[i] end
    end
end

local function callCount(name) return H.calls[name] or 0 end

local function lastCall(name)
    for i = #H.calls, 1, -1 do
        if H.calls[i].name == name then return H.calls[i].args end
    end
end

local function logText()
    local out = {}
    for _, p in ipairs(H.prints) do out[#out + 1] = p end
    return table.concat(out, "\n")
end

--------------------------------------------------------------------------------
dofile("scripts/vanity-toolkit.lua")

section("UI registration")
local kinds = {}
for _, e in ipairs(H.ui) do kinds[e.kind] = (kinds[e.kind] or 0) + 1 end
check("many toggles",   (kinds.toggle or 0)   >= 15, tostring(kinds.toggle))
check("many sliders",   (kinds.slider or 0)   >= 12, tostring(kinds.slider))
check("many buttons",   (kinds.button or 0)   >= 12, tostring(kinds.button))
check("several selectors", (kinds.selector or 0) >= 5, tostring(kinds.selector))
check("text inputs",    (kinds.textinput or 0) >= 5, tostring(kinds.textinput))
check("submenus",       (kinds.submenu or 0)  >= 6, tostring(kinds.submenu))
check("separators group the menu", (kinds.separator or 0) >= 8, tostring(kinds.separator))
check("every control has a description", (function()
    local missing = {}
    for _, e in ipairs(H.ui) do
        local needs = e.kind == "toggle" or e.kind == "slider" or e.kind == "button"
            or e.kind == "selector" or e.kind == "textinput" or e.kind == "submenu"
        if needs and (not e.desc or e.desc == "") then missing[#missing + 1] = e.name end
    end
    return #missing == 0, table.concat(missing, ", ")
end)())

section("Excluded features are absent")
local source = io.open("scripts/vanity-toolkit.lua"):read("a")
for _, banned in ipairs({ "aimBot", "setAimbotFov", "spoofTeleport", "speedSpoof",
                          "pedSpoof", "spoofAllVisible", "camBypass", "lockEventLogger" }) do
    -- The header comment names them; no call site may.
    local calls = select(2, source:gsub('ham%("' .. banned .. '"', ""))
        + select(2, source:gsub("Ham%." .. banned .. "%(", ""))
    eq("no call to " .. banned, calls, 0)
end

section("Overlay")
H.frames(3)
H.clearDraws()
H.frame()
check("panel is drawn", (function()
    for _, d in ipairs(H.draws) do if d.fn == "drawRectFilled" then return true end end
    return false
end)())
check("status rows present", H.hasText("Pos") and H.hasText("Health"))
check("action log heading present", H.hasText("ACTION LOG"))

for _, corner in ipairs({ "Top Left", "Top Right", "Bottom Left", "Bottom Right" }) do
    for _, size in ipairs({ 10, 14, 26 }) do
        H.ui["Overlay Corner"].cb(corner)
        H.ui["Overlay Font Size"].cb(size)
        H.clearDraws()
        H.frame()
        local panel
        for _, d in ipairs(H.draws) do
            if d.fn == "drawRectFilled" then panel = d; break end
        end
        local r = panel.rect
        check(("panel fits (%s, font %d)"):format(corner, size),
            r[1] >= 0 and r[2] >= 0 and r[1] + r[3] <= 1920 and r[2] + r[4] <= 1080,
            ("x=%.0f y=%.0f w=%.0f h=%.0f"):format(r[1], r[2], r[3], r[4]))
    end
end
H.ui["Overlay Corner"].cb("Top Right")
H.ui["Overlay Font Size"].cb(14)

H.ui["Show Overlay"].cb({ toggleState = false })
H.clearDraws()
H.frame()
eq("master switch stops all drawing", #H.draws, 0)
H.ui["Show Overlay"].cb({ toggleState = true })

section("Shape demo")
H.ui["Shape Demo"].cb({ toggleState = true })
local shapeFns = {
    ["Rect Outline"] = "drawRect", ["Rect Filled"] = "drawRectFilled",
    ["Gradient"] = "drawRectGradient", ["Circle"] = "drawCircle",
    ["Circle Filled"] = "drawCircle", ["Line"] = "drawLine",
}
for shape, fn in pairs(shapeFns) do
    H.ui["Demo Shape"].cb(shape)
    H.clearDraws()
    H.frame()
    local found = false
    for _, d in ipairs(H.draws) do if d.fn == fn then found = true end end
    check(("shape '%s' calls %s"):format(shape, fn), found)
end
H.ui["Shape Demo"].cb({ toggleState = false })

section("Self toggles reach Ham")
H.ui["God Mode"].cb({ toggleState = true })
eq("godMode enabled", H.ham.godMode, true)
eq("native invincibility set too", callCount("SetEntityInvincible"), 1)
H.ui["God Mode"].cb({ toggleState = false })
eq("godMode disabled", H.ham.godMode, false)

H.ui["Invisible"].cb({ toggleState = true })
eq("invisible enabled", H.ham.invisible, true)
H.ui["No-Clip"].cb({ toggleState = true })
eq("noClip enabled", H.ham.noClip, true)
H.ui["No-Clip Speed"].cb(8)
eq("noclip speed forwarded as float", H.ham.setNoClipSpeed, 8.0)
H.ui["Free Cam"].cb({ toggleState = true })
eq("freeCam enabled", H.ham.freeCam, true)
H.ui["Spectator Mode"].cb({ toggleState = true })
eq("spectatorMode enabled", H.ham.spectatorMode, true)
H.ui["Anti-Teleport"].cb({ toggleState = true })
eq("antiTeleport enabled", H.ham.antiTeleport, true)

H.clearDraws()
H.frame()
check("overlay reflects active flags", (function()
    for i, d in ipairs(H.draws) do
        if d.text == "God" then return H.draws[i + 1].text == "off" end
    end
    return false
end)())

section("Per-frame effects")
clearCalls()
H.ui["Super Jump"].cb({ toggleState = true })
H.ui["Infinite Ammo"].cb({ toggleState = true })
H.ui["Disable Ragdoll"].cb({ toggleState = true })
H.frames(3)
check("super jump applied each frame", callCount("SetSuperJumpThisFrame") >= 3,
    tostring(callCount("SetSuperJumpThisFrame")))
check("infinite ammo applied each frame", callCount("SetPedInfiniteAmmo") >= 3)
check("ragdoll suppressed each frame", callCount("SetPedCanRagdoll") >= 3)
H.ui["Super Jump"].cb({ toggleState = false })
H.ui["Infinite Ammo"].cb({ toggleState = false })
H.ui["Disable Ragdoll"].cb({ toggleState = false })
clearCalls()
H.frames(3)
eq("super jump stops when off", callCount("SetSuperJumpThisFrame"), 0)

section("Teleport")
clearCalls()
H.ui["Teleport Method"].cb("Native (SetEntityCoords)")
submenuFunc("Quick Locations", "Airport")()
eq("native path uses SetEntityCoords", callCount("SetEntityCoords"), 1)
eq("native path does not call Ham", callCount("Ham.setPosition"), 0)

clearCalls()
H.ui["Teleport Method"].cb("Ham (setPosition)")
submenuFunc("Quick Locations", "Airport")()
eq("ham path uses setPosition", callCount("Ham.setPosition"), 1)
eq("ham path does not use the native", callCount("SetEntityCoords"), 0)

H.ui["Vertical Offset"].cb(25)
clearCalls()
submenuFunc("Quick Locations", "Pier")()
local args = lastCall("Ham.setPosition")
eq("vertical offset applied to Z", args[3], 13.0 + 25)
H.ui["Vertical Offset"].cb(0)
H.ui["Teleport Method"].cb("Native (SetEntityCoords)")

section("Teleport slots")
w.coords.x, w.coords.y, w.coords.z = 500.0, 600.0, 70.0
submenuFunc("Teleport Slots", "Save Slot 1")()
w.coords.x = 0.0
clearCalls()
submenuFunc("Teleport Slots", "Load Slot 1")()
local tp = lastCall("SetEntityCoords")
check("slot restores the saved position", tp[2] == 500.0 and tp[3] == 600.0 and tp[4] == 70.0,
    tp and ("%s %s %s"):format(tp[2], tp[3], tp[4]))
clearCalls()
submenuFunc("Teleport Slots", "Load Slot 3")()
eq("empty slot does not teleport", callCount("SetEntityCoords"), 0)

section("Coordinate prompt")
H.ui["Teleport to Coords..."].cb()
local prompt = lastPrompt()
check("prompt opened", prompt ~= nil)
clearCalls()
prompt.cb("123.5, -456.25, 78", false)
local c = lastCall("SetEntityCoords")
check("parses a coordinate triple", c and c[2] == 123.5 and c[3] == -456.25 and c[4] == 78.0,
    c and ("%s %s %s"):format(c[2], c[3], c[4]))
clearCalls()
H.ui["Teleport to Coords..."].cb()
lastPrompt().cb("not coordinates", false)
eq("garbage input does not teleport", callCount("SetEntityCoords"), 0)
clearCalls()
H.ui["Teleport to Coords..."].cb()
lastPrompt().cb("1,2,3", true)
eq("cancelling does not teleport", callCount("SetEntityCoords"), 0)

section("Waypoint")
clearCalls()
w.waypoint = nil
H.ui["Teleport to Waypoint"].cb()
eq("no waypoint means no teleport", callCount("SetEntityCoords"), 0)
w.waypoint = { x = 1000.0, y = 2000.0, z = 20.0 }
clearCalls()
H.ui["Teleport to Waypoint"].cb()
eq("waypoint teleports", callCount("SetEntityCoords"), 1)
w.waypoint = nil

section("Vehicle")
w.veh = 0
clearCalls()
submenuFunc("Vehicle Actions", "Repair")()
eq("repair refuses when on foot", callCount("SetVehicleFixed"), 0)
check("refusal is reported", logText():find("Not in a vehicle") ~= nil)

H.ui["Vehicle Model"].cb("zentorno")
clearCalls()
H.ui["Spawn Vehicle"].cb()
eq("vehicle created", callCount("CreateVehicle"), 1)
eq("player seated", callCount("SetPedIntoVehicle"), 1)
eq("model released", callCount("SetModelAsNoLongerNeeded"), 1)

clearCalls()
submenuFunc("Vehicle Actions", "Repair")()
eq("repair works when seated", callCount("SetVehicleFixed"), 1)
submenuFunc("Vehicle Actions", "Clean")()
eq("clean works", callCount("SetVehicleDirtLevel"), 1)
submenuFunc("Vehicle Actions", "Max Upgrades")()
check("mods applied", callCount("SetVehicleMod") >= 10, tostring(callCount("SetVehicleMod")))
submenuFunc("Vehicle Actions", "Set Plate...")()
lastPrompt().cb("AC-TEST", false)
eq("plate set", callCount("SetVehicleNumberPlateText"), 1)
clearCalls()
submenuFunc("Quick Spawn", "police")()
eq("quick spawn creates a vehicle", callCount("CreateVehicle"), 1)
w.veh = 0

section("World and weapons")
clearCalls()
H.ui["Time of Day"].cb("Night")
eq("clock overridden", callCount("NetworkOverrideClockTime"), 1)
H.ui["Hour"].cb(17)
eq("hour slider overrides the clock", callCount("NetworkOverrideClockTime"), 2)
H.ui["Weather"].cb("THUNDER")
eq("weather forced", callCount("SetWeatherTypeNowPersist"), 1)
H.ui["Disable Weather Sync"].cb({ toggleState = true })
eq("weather sync disabled via Ham", H.ham.disableWeather, true)

clearCalls()
H.ui["Weapon Name"].cb("WEAPON_CARBINERIFLE")
H.ui["Give Weapon"].cb()
eq("weapon given", callCount("GiveWeaponToPed"), 1)
clearCalls()
submenuFunc("Weapon Packs", "Rifles")()
eq("rifle pack gives three weapons", callCount("GiveWeaponToPed"), 3)
H.ui["Remove All Weapons"].cb()
eq("weapons stripped", callCount("RemoveAllPedWeapons"), 1)

section("Inspector")
H.prints = {}
submenuFunc("Dumps", "Resources")()
check("resources dumped", logText():find("chat") ~= nil)
H.prints = {}
submenuFunc("Dumps", "State Bags")()
check("state bags dumped", logText():find("job = police") ~= nil)
H.prints = {}
submenuFunc("Dumps", "Triggered Events")()
check("events dumped", logText():find("chat:addMessage") ~= nil)

H.ui["Dump Line Limit"].cb(2)
H.prints = {}
submenuFunc("Dumps", "Resources")()
check("dump limit is honoured", logText():find("2 more") ~= nil)
H.ui["Dump Line Limit"].cb(25)

H.ui["Copy Last Dump"].cb()
check("dump copied to clipboard", H.clipboard:find("Resources") ~= nil)

H.ui["Resource Name"].cb("chat")
H.prints = {}
H.ui["Check Resource"].cb()
check("existing resource reported present", logText():find("present") ~= nil)
H.ui["Resource Name"].cb("does-not-exist")
H.prints = {}
H.ui["Check Resource"].cb()
check("missing resource reported absent", logText():find("absent") ~= nil)

H.ui["Find Event..."].cb()
H.prints = {}
lastPrompt().cb("playerSpawned", false)
check("event found", logText():find("spawnmanager") ~= nil)
H.ui["Find Event..."].cb()
H.prints = {}
lastPrompt().cb("nothing-matches-this", false)
check("missing event reported", logText():find("No event matched") ~= nil)

section("HTTP")
H.posts = {}
H.ui["URL"].cb("")
submenuFunc("Send Request", "GET (sync)")()
eq("no request without a URL", #H.posts, 0)

H.ui["URL"].cb("https://ac.example.test/collect")
H.ui["POST Body"].cb('{"probe":1}')
submenuFunc("Send Request", "GET (sync)")()
eq("sync GET issued", #H.posts, 1)
eq("sync GET method", H.posts[1].method, "GET")
submenuFunc("Send Request", "POST (sync)")()
eq("sync POST issued", #H.posts, 2)
eq("sync POST carries the body", H.posts[2].payload, '{"probe":1}')

H.posts = {}
submenuFunc("Send Request", "POST (async)")()
eq("async POST issued", #H.posts, 1)
H.frame()
H.clearDraws()
H.frame()
check("async result reaches the overlay", (function()
    for i, d in ipairs(H.draws) do
        if d.text == "HTTP" then return H.draws[i + 1].text:sub(1, 2) == "ok" end
    end
    return false
end)())

H.ui["Copy Last Response"].cb()
check("response copied to clipboard", H.clipboard:find("ok") ~= nil)
clearCalls()
H.ui["Open URL in Browser"].cb()
eq("browser opened", callCount("Ham.openUrl"), 1)
H.ui["URL"].cb("not-a-url")
clearCalls()
H.ui["Open URL in Browser"].cb()
eq("non-http URL refused", callCount("Ham.openUrl"), 0)

section("Advanced")
clearCalls()
H.ui["Execute Context"].cb("isolated")
H.ui["Execute Lua..."].cb()
lastPrompt().cb('print("hi")', false)
eq("Execute called", callCount("Ham.Execute"), 1)
local ex = lastCall("Ham.Execute")
eq("Execute uses the configured context", ex[1], "isolated")
eq("Execute passes the code", ex[2], 'print("hi")')
H.ui["Execute Lua..."].cb()
clearCalls()
lastPrompt().cb("", false)
eq("empty code is not executed", callCount("Ham.Execute"), 0)

H.clipboard = "clipboard payload"
H.prints = {}
H.ui["Clipboard to Console"].cb()
check("clipboard printed", logText():find("clipboard payload") ~= nil)

clearCalls()
H.ui["Reset All Toggles"].cb()
eq("godMode reset", H.ham.godMode, false)
eq("noClip reset", H.ham.noClip, false)
eq("spectator reset", H.ham.spectatorMode, false)
eq("run speed restored", lastCall("SetRunSprintMultiplierForPlayer")[2], 1.0)

section("Action log")
H.ui["Clear Action Log"].cb()
H.clearDraws()
H.frame()
check("cleared log still renders", H.hasText("ACTION LOG"))
for i = 1, 30 do H.ui["Heal Fully"].cb() end
H.clearDraws()
H.frame()
local logRows = 0
local seenHeading = false
for _, d in ipairs(H.draws) do
    if d.text == "ACTION LOG" then seenHeading = true
    elseif seenHeading and d.fn == "drawText" then logRows = logRows + 1 end
end
check("log is capped, not unbounded", logRows > 0 and logRows <= 14, tostring(logRows))

section("Font selector")
clearCalls()
H.ui["Font"].cb("Consolas")
eq("font loaded", callCount("Ham.addFont"), 1)
eq("font activated", callCount("Ham.setFont"), 1)
H.ui["Font"].cb("Default")
eq("default resets", callCount("Ham.resetFont"), 1)

section("Re-execution")
local before = #H.threads
dofile("scripts/vanity-toolkit.lua")
H.frames(2)
eq("second execution spawns a second loop", #H.threads, before + 1)
eq("only the newest loop survives", H.aliveThreads(), 1)
H.clearDraws()
H.frame()
local panels = 0
for _, d in ipairs(H.draws) do
    if d.fn == "drawRectFilled" then panels = panels + 1 end
end
eq("overlay is not drawn twice", panels, 1)

--------------------------------------------------------------------------------
H.realPrint(("\n%d passed, %d failed"):format(passed, failed))
os.exit(failed == 0 and 0 or 1)
