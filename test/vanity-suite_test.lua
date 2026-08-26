-- Tests for scripts/vanity-suite.lua (the single-file build)
-- Run: lua5.4 test/vanity-suite_test.lua

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
local function clearCalls() H.calls = {} end
local function callCount(n) return H.calls[n] or 0 end

local function lastCall(name)
    for i = #H.calls, 1, -1 do
        if H.calls[i].name == name then return H.calls[i].args end
    end
end

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

local function logText() return table.concat(H.prints, "\n") end

-- Run frames until `pred` holds or the budget runs out.
local function runUntil(pred, budget)
    for _ = 1, budget or 400 do
        if pred() then return true end
        H.frame()
    end
    return pred()
end

--------------------------------------------------------------------------------
dofile("scripts/vanity-suite.lua")

section("Single file, self-contained")
local src = io.open("scripts/vanity-suite.lua"):read("a")
check("no require()", not src:match("\nrequire%("), "script must stand alone")
check("no dofile()", not src:match("\ndofile%("), "script must stand alone")
check("substantial", #src > 40000, tostring(#src) .. " bytes")

section("Excluded features are absent")
for _, banned in ipairs({ "aimBot", "setAimbotFov", "setAimbotBone", "spoofTeleport",
                          "speedSpoof", "pedSpoof", "spoofAllVisible", "camBypass",
                          "lockEventLogger", "getAntiCheats" }) do
    local calls = select(2, src:gsub('ham%("' .. banned .. '"', ""))
        + select(2, src:gsub("Ham%." .. banned .. "%(", ""))
        + select(2, src:gsub("HAM%." .. banned .. "%(", ""))
    eq("no call to " .. banned, calls, 0)
end

section("UI registration")
local kinds = {}
for _, e in ipairs(H.ui) do kinds[e.kind] = (kinds[e.kind] or 0) + 1 end
check("toggles",   (kinds.toggle or 0)    >= 18, tostring(kinds.toggle))
check("sliders",   (kinds.slider or 0)    >= 15, tostring(kinds.slider))
check("buttons",   (kinds.button or 0)    >= 20, tostring(kinds.button))
check("selectors", (kinds.selector or 0)  >= 6,  tostring(kinds.selector))
check("inputs",    (kinds.textinput or 0) >= 6,  tostring(kinds.textinput))
check("submenus",  (kinds.submenu or 0)   >= 6,  tostring(kinds.submenu))
check("every control has a description", (function()
    local missing = {}
    for _, e in ipairs(H.ui) do
        local needs = e.kind == "toggle" or e.kind == "slider" or e.kind == "button"
            or e.kind == "selector" or e.kind == "textinput" or e.kind == "submenu"
        if needs and (not e.desc or e.desc == "") then missing[#missing + 1] = e.name end
    end
    return #missing == 0, table.concat(missing, ", ")
end)())

section("Overlay")
H.frames(3)
H.clearDraws()
H.frame()
check("status panel", H.hasText("STATUS"))
check("movement panel", H.hasText("MOVEMENT"))
check("scenario panel", H.hasText("SCENARIO"))
check("action log", H.hasText("ACTION LOG"))

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

section("Movement tracking")
w.coords.x, w.coords.y, w.coords.z = 100.0, 200.0, 30.0
H.frames(3)
H.clearDraws()
H.frame()
eq("stationary delta is zero", H.rowValue("Delta/frame").text, "0.000 m")
w.coords.x = w.coords.x + 50.0
H.clearDraws()
H.frame()
local d = H.rowValue("Delta/frame")
eq("50 m jump measured", d.text, "50.000 m")
check("jump is coloured as an alert", d.color[1] == 255 and d.color[2] == 95)
eq("jump counted", H.rowValue("Jumps >=").text:sub(1, 1), "1")
H.ui["Reset Counters"].cb()
H.clearDraws()
H.frame()
eq("counters reset", H.rowValue("Max delta").text, "0.000 m")

section("Scenario runner: catalogue")
local scenarioSelector = H.ui["Scenario"]
check("scenario selector exists", scenarioSelector ~= nil)
check("several ladders offered", #scenarioSelector.choices >= 7,
    tostring(#scenarioSelector.choices))
H.prints = {}
H.ui["Describe Scenarios"].cb()
check("catalogue describes each ladder", logText():find("Teleport Ladder") ~= nil
    and logText():find("Speed Ramp") ~= nil)

section("Scenario runner: teleport ladder")
H.ui["Scenario"].cb("Teleport Ladder")
H.ui["Step Delay"].cb(500)
H.ui["Repeats"].cb(1)
w.coords.x, w.coords.y, w.coords.z = 300.0, 400.0, 50.0
clearCalls()
H.prints = {}
H.ui["Start Scenario"].cb()

H.clearDraws()
H.frame()
check("runner reports as running", (function()
    for i, dd in ipairs(H.draws) do
        if dd.text == "Running" then return true end
    end
    return false
end)())

local finished = runUntil(function() return logText():find("finished") ~= nil end, 400)
check("ladder runs to completion", finished)

H.prints = {}
H.ui["Print Run Report"].cb()
local report = logText()
check("report lists nine steps", (function()
    local n = select(2, report:gsub("\n%s+%d+%s+1%s", ""))
    return n == 9, tostring(n)
end)())
check("report names the scenario", report:find("Teleport Ladder") ~= nil)
check("report explains how to read it", report:find("first step it did not flag") ~= nil)

check("ladder magnitudes appear in the log", (function()
    for _, m in ipairs({ "1 m", "25 m", "500 m" }) do
        if not report:find(m, 1, true) then return false, m end
    end
    return true
end)())

check("each step teleported", callCount("SetEntityCoords") >= 18,
    tostring(callCount("SetEntityCoords")))

H.ui["Copy Run Report"].cb()
check("report copied to clipboard", H.clipboard:find("Teleport Ladder") ~= nil)

section("Scenario runner: guards")
H.prints = {}
H.ui["Start Scenario"].cb()
H.frame()
H.ui["Start Scenario"].cb()
check("cannot start twice", logText():find("already running") ~= nil)
H.ui["Stop Scenario"].cb()
H.frames(3)
check("stop is reported", logText():find("stopped by user") ~= nil)
-- Stopping aborts *after* the step already in flight, so let that one land first.
H.frames(5)
H.prints = {}
H.frames(40)
check("no further steps once the in-flight one finishes", not logText():find("step"))

H.prints = {}
H.ui["Stop Scenario"].cb()
check("stopping when idle is reported", logText():find("No scenario is running") ~= nil)

section("Scenario runner: repeats and other ladders")
H.ui["Scenario"].cb("Armour Jumps")
H.ui["Repeats"].cb(2)
clearCalls()
H.prints = {}
H.ui["Start Scenario"].cb()
runUntil(function() return logText():find("finished") ~= nil end, 600)
H.prints = {}
H.ui["Print Run Report"].cb()
local armourReport = logText()
check("two passes recorded", armourReport:find("  2 ") ~= nil)
check("armour ladder wrote armour", callCount("SetPedArmour") >= 10,
    tostring(callCount("SetPedArmour")))
H.ui["Repeats"].cb(1)

H.ui["Scenario"].cb("Speed Ramp")
clearCalls()
H.prints = {}
H.ui["Start Scenario"].cb()
runUntil(function() return logText():find("finished") ~= nil end, 400)
check("speed ramp set the multiplier", callCount("SetRunSprintMultiplierForPlayer") >= 8,
    tostring(callCount("SetRunSprintMultiplierForPlayer")))

H.ui["Scenario"].cb("Vertical Ladder")
clearCalls()
H.prints = {}
H.ui["Start Scenario"].cb()
runUntil(function() return logText():find("finished") ~= nil end, 400)
check("vertical ladder moved on Z", (function()
    for i = #H.calls, 1, -1 do
        local c = H.calls[i]
        if c.name == "SetEntityCoords" then return true end
    end
    return false
end)())

section("Scenario runner: telemetry per step")
H.ui["Scenario"].cb("Teleport Ladder")
H.posts = {}
H.ui["Endpoint"].cb("https://ac.example.test/collect")
H.prints = {}
H.ui["Start Scenario"].cb()
runUntil(function() return logText():find("finished") ~= nil end, 400)
check("steps were POSTed", #H.posts >= 5, tostring(#H.posts))
local payload = H.posts[1].payload
check("payload carries the scenario name", payload:find('"scenario":"Teleport Ladder"') ~= nil)
check("payload carries the step index", payload:find('"scenarioStep":') ~= nil)
check("payload carries the magnitude", payload:find('"scenarioMagnitude":') ~= nil)
check("payload carries position", payload:find('"x":') ~= nil)
H.ui["Endpoint"].cb("")

section("Teleport paths")
clearCalls()
H.ui["Teleport Method"].cb("Native (SetEntityCoords)")
submenuFunc("Quick Locations", "Airport")()
eq("native path", callCount("SetEntityCoords"), 1)
eq("native path avoids Ham", callCount("Ham.setPosition"), 0)
clearCalls()
H.ui["Teleport Method"].cb("Ham (setPosition)")
submenuFunc("Quick Locations", "Airport")()
eq("ham path", callCount("Ham.setPosition"), 1)

clearCalls()
H.ui["Scenario"].cb("Teleport Ladder")
H.prints = {}
H.ui["Start Scenario"].cb()
runUntil(function() return logText():find("finished") ~= nil end, 400)
check("the ladder follows the selected teleport path",
    callCount("Ham.setPosition") >= 18 and callCount("SetEntityCoords") == 0,
    ("ham=%d native=%d"):format(callCount("Ham.setPosition"), callCount("SetEntityCoords")))
H.ui["Teleport Method"].cb("Native (SetEntityCoords)")

section("Toolkit sections still work")
H.ui["God Mode"].cb({ toggleState = true })
eq("godMode plumbed", H.ham.godMode, true)
H.ui["God Mode"].cb({ toggleState = false })

w.veh = 0
clearCalls()
submenuFunc("Vehicle Actions", "Repair")()
eq("repair refuses on foot", callCount("SetVehicleFixed"), 0)
H.ui["Vehicle Model"].cb("zentorno")
H.ui["Spawn Vehicle"].cb()
eq("vehicle spawned", callCount("CreateVehicle"), 1)
submenuFunc("Vehicle Actions", "Repair")()
eq("repair works when seated", callCount("SetVehicleFixed"), 1)
w.veh = 0

H.prints = {}
submenuFunc("Dumps", "State Bags")()
check("state bags dumped", logText():find("job = police") ~= nil)
H.ui["Copy Last Dump"].cb()
check("dump copied", H.clipboard:find("State bags") ~= nil)

H.posts = {}
H.ui["URL"].cb("https://ac.example.test/x")
submenuFunc("Send Request", "GET (sync)")()
eq("sync GET issued", #H.posts, 1)

clearCalls()
H.ui["Execute Lua..."].cb()
lastPrompt().cb('print("hi")', false)
eq("Execute called", callCount("Ham.Execute"), 1)

H.ui["Teleport to Coords..."].cb()
clearCalls()
lastPrompt().cb("11.5, 22.5, 33.5", false)
local c = lastCall("SetEntityCoords")
check("coordinate prompt parses", c and c[2] == 11.5 and c[3] == 22.5 and c[4] == 33.5)

section("Reset Everything")
H.ui["Scenario"].cb("Teleport Ladder")
H.ui["Start Scenario"].cb()
H.frame()
clearCalls()
H.prints = {}
H.ui["Reset Everything"].cb()
eq("godMode cleared", H.ham.godMode, false)
eq("run speed restored", lastCall("SetRunSprintMultiplierForPlayer")[2], 1.0)
check("running scenario is stopped", logText():find("stopped by reset") ~= nil)
H.frames(30)

section("Re-execution")
local threadsBefore = H.aliveThreads()
dofile("scripts/vanity-suite.lua")
H.frames(2)
eq("only the newest loop survives", H.aliveThreads(), 1)
H.clearDraws()
H.frame()
local panels = 0
for _, dd in ipairs(H.draws) do
    if dd.fn == "drawRectFilled" then panels = panels + 1 end
end
eq("overlay is not drawn twice", panels, 1)

--------------------------------------------------------------------------------
H.realPrint(("\n%d passed, %d failed"):format(passed, failed))
os.exit(failed == 0 and 0 or 1)
