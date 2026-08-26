-- Tests for scripts/luchs-script.lua — the engine, and the Vanity menu front end.
-- Run: lua5.4 test/luchs-script_test.lua
--
-- The same engine sits inside luchs-gui.lua byte for byte (parity_test.lua holds
-- that), so everything below covers both scripts' behaviour; luchs-gui_test.lua
-- only has to cover the window.

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

local function near(name, got, want, tol)
    check(name, math.abs(got - want) <= (tol or 0.001),
        ("got %s, want %s"):format(tostring(got), tostring(want)))
end

local function section(t) H.realPrint("\n" .. t) end
local function clearCalls() H.calls = {} end
local function callCount(n) return H.calls[n] or 0 end
local function logText() return table.concat(H.prints, "\n") end

local function lastCall(name)
    for i = #H.calls, 1, -1 do
        if H.calls[i].name == name then return H.calls[i].args end
    end
end

local function submenuFunc(menuName, itemName)
    local menu = H.ui[menuName]
    if not menu or not menu.items then return nil end
    for _, item in ipairs(menu.items) do
        if item.name == itemName then return item.func end
    end
end

local function lastPrompt()
    for i = #H.ui, 1, -1 do
        if H.ui[i].kind == "prompt" then return H.ui[i] end
    end
end

-- The console output of a button that prints one multi-line report.
local function reportFrom(button)
    H.prints = {}
    H.ui[button].cb()
    for _, line in ipairs(H.prints) do
        if line:find("\n") then return line end
    end
    return logText()
end

local function runUntil(pred, budget)
    for _ = 1, budget or 400 do
        if pred() then return true end
        H.frame()
    end
    return pred()
end

--------------------------------------------------------------------------------
-- A JSON parser, so "valid JSON" is checked rather than pattern-matched.
--------------------------------------------------------------------------------

local function parseJson(text)
    local pos = 1

    local function skip()
        local at = text:find("[^ \t\r\n]", pos)
        pos = at or (#text + 1)
    end

    local parseValue

    local function parseString()
        assert(text:sub(pos, pos) == '"', "expected a string at " .. pos)
        pos = pos + 1
        local out = {}
        while true do
            local c = text:sub(pos, pos)
            assert(c ~= "", "unterminated string")
            if c == '"' then pos = pos + 1 break end
            if c == "\\" then
                local esc = text:sub(pos + 1, pos + 1)
                local simple = { n = "\n", t = "\t", r = "\r", b = "\b", f = "\f",
                                 ['"'] = '"', ["\\"] = "\\", ["/"] = "/" }
                if simple[esc] then
                    out[#out + 1] = simple[esc]
                    pos = pos + 2
                elseif esc == "u" then
                    local hex = text:sub(pos + 2, pos + 5)
                    assert(hex:match("^%x%x%x%x$"), "bad \\u escape at " .. pos)
                    out[#out + 1] = "\\u" .. hex
                    pos = pos + 6
                else
                    error("bad escape \\" .. esc .. " at " .. pos)
                end
            else
                assert(c:byte() >= 32, ("raw control byte %d at %d"):format(c:byte(), pos))
                out[#out + 1] = c
                pos = pos + 1
            end
        end
        return table.concat(out)
    end

    local function parseObject()
        pos = pos + 1
        local out = {}
        skip()
        if text:sub(pos, pos) == "}" then pos = pos + 1 return out end
        while true do
            skip()
            local key = parseString()
            skip()
            assert(text:sub(pos, pos) == ":", "expected : at " .. pos)
            pos = pos + 1
            out[key] = parseValue()
            skip()
            local c = text:sub(pos, pos)
            if c == "," then pos = pos + 1
            elseif c == "}" then pos = pos + 1 return out
            else error("expected , or } at " .. pos) end
        end
    end

    local function parseArray()
        pos = pos + 1
        local out = {}
        skip()
        if text:sub(pos, pos) == "]" then pos = pos + 1 return out end
        while true do
            out[#out + 1] = parseValue()
            skip()
            local c = text:sub(pos, pos)
            if c == "," then pos = pos + 1
            elseif c == "]" then pos = pos + 1 return out
            else error("expected , or ] at " .. pos) end
        end
    end

    parseValue = function()
        skip()
        local c = text:sub(pos, pos)
        if c == "{" then return parseObject() end
        if c == "[" then return parseArray() end
        if c == '"' then return parseString() end
        if text:sub(pos, pos + 3) == "true" then pos = pos + 4 return true end
        if text:sub(pos, pos + 4) == "false" then pos = pos + 5 return false end
        if text:sub(pos, pos + 3) == "null" then pos = pos + 4 return nil end
        local num = text:match("^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
        assert(num and #num > 0, "unexpected character at " .. pos ..
            ": " .. text:sub(pos, pos + 20))
        pos = pos + #num
        return tonumber(num)
    end

    local value = parseValue()
    skip()
    assert(pos > #text, "trailing content at " .. pos)
    return value
end

--------------------------------------------------------------------------------
dofile("scripts/luchs-script.lua")
H.frames(3)

section("Loading")
check("the script announced its feature count",
    logText():find("14 sections, 153 features") ~= nil, logText():sub(1, 200))
check("anti-cheat was detected at load", logText():find("ElectronAC, FiveGuard") ~= nil)

section("Overlay")
H.clearDraws()
H.frame()
for _, panel in ipairs({ "STATUS", "MOVEMENT", "MONITOR", "CALIBRATION",
                         "SCENARIO", "ACTION LOG" }) do
    check("panel " .. panel, H.hasText(panel))
end
eq("the status panel names the anti-cheat",
    H.rowValue("Anti-cheat").text, "ElectronAC, FiveGuard")

for _, corner in ipairs({ "Top Left", "Top Right", "Bottom Left", "Bottom Right" }) do
    for _, size in ipairs({ 10, 14, 26 }) do
        H.ui["Overlay Corner"].cb(corner)
        H.ui["Overlay Font Size"].cb(size)
        H.clearDraws()
        H.frame()
        local panel
        for _, d in ipairs(H.draws) do
            if d.fn == "drawRectFilled" then panel = d break end
        end
        local r = panel.rect
        check(("panel fits (%s, font %d)"):format(corner, size),
            r[1] >= 0 and r[2] >= 0 and r[1] + r[3] <= 1920 and r[2] + r[4] <= 1080,
            ("x=%.0f y=%.0f w=%.0f h=%.0f"):format(r[1], r[2], r[3], r[4]))
    end
end

-- Everything on, biggest font, full log, small screen: the panel has to give.
H.resolution = { 800, 600 }
H.ui["Overlay Font Size"].cb(26)
H.ui["Input Panel"].cb({ toggleState = true })
for _ = 1, 20 do H.ui["Reset Counters"].cb() end
H.clearDraws()
H.frame()
local small
for _, d in ipairs(H.draws) do
    if d.fn == "drawRectFilled" then small = d break end
end
check("the panel is trimmed to fit a short screen",
    small and small.rect[2] + small.rect[4] <= 600,
    small and ("y=%.0f h=%.0f"):format(small.rect[2], small.rect[4]) or "nothing drawn")
check("and says so rather than silently dropping rows", H.hasText("..."))

H.resolution = { 1920, 1080 }
H.ui["Overlay Font Size"].cb(14)
H.ui["Overlay Corner"].cb("Top Right")
H.ui["Input Panel"].cb({ toggleState = false })

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
eq("a 50 m jump is measured", d.text, "50.000 m")
check("and coloured as an alert", d.color[1] == 255 and d.color[2] == 95)
eq("the jump is counted", H.rowValue("Jumps >=").text:sub(1, 1), "1")

section("Anti-cheat detection: both return shapes")

H.antiCheats = { "ReaperAC", "FiveGuard" }
H.ui["Detect Anti-Cheats"].cb()
local report = reportFrom("Print Anti-Cheat Report")
check("array form is read", report:find("names    : FiveGuard, ReaperAC") ~= nil, report)
check("array form is labelled as such", report:find("shape    : array") ~= nil, report)
check("presence is reported", report:find("present  : yes") ~= nil)
check("count is reported", report:find("count    : 2") ~= nil)

-- Map form: keyed by name, value true or a details table. false means the build
-- looked and did not find it.
H.antiCheats = { FiveGuard = true, ElectronAC = false, ReaperAC = { version = 3 } }
H.ui["Detect Anti-Cheats"].cb()
report = reportFrom("Print Anti-Cheat Report")
check("map form is read", report:find("names    : FiveGuard, ReaperAC") ~= nil, report)
check("map form is labelled as such", report:find("shape    : map") ~= nil, report)
check("a key mapped to false is not reported as present",
    report:find("ElectronAC") == nil, report)
check("count follows the map", report:find("count    : 2") ~= nil)

H.antiCheats = {}
H.ui["Detect Anti-Cheats"].cb()
report = reportFrom("Print Anti-Cheat Report")
check("an empty answer reads as none detected",
    report:find("names    : none detected") ~= nil, report)
check("and presence is no", report:find("present  : no") ~= nil)

H.antiCheats = nil     -- makes the stub raise
H.prints = {}
H.ui["Detect Anti-Cheats"].cb()
check("an erroring build is caught, not propagated",
    logText():find("errored") ~= nil, logText():sub(1, 160))
report = reportFrom("Print Anti-Cheat Report")
check("and reported as an error shape", report:find("shape    : error") ~= nil, report)

H.antiCheats = { "FiveGuard", "ElectronAC" }
H.ui["Detect Anti-Cheats"].cb()

section("Monitors: added, changed and removed")

H.ui["Monitor Source"].cb("Resources")
H.inspect.resources = { "chat", "spawnmanager", "mapmanager" }
H.ui["Take Baseline"].cb()
report = reportFrom("Print Monitor Diff")
check("a fresh baseline reports no change",
    report:find("no change since the last look") ~= nil, report)

H.inspect.resources = { "chat", "mapmanager", "esx_ambulancejob" }   -- +1, -1
H.ui["Diff Now"].cb()
report = reportFrom("Print Monitor Diff")
check("an added entry is found",
    report:find("%+ added%s+esx_ambulancejob") ~= nil, report)
check("a removed entry is found",
    report:find("%- removed%s+spawnmanager") ~= nil, report)
check("the totals line up",
    report:find("2 changes %(1 added, 0 changed, 1 removed%)") ~= nil, report)

H.ui["Diff Now"].cb()
report = reportFrom("Print Monitor Diff")
check("the diff rebases, so an unchanged second look is quiet",
    report:find("no change since the last look") ~= nil, report)

H.ui["Monitor Source"].cb("State Bags")
H.inspect.stateBags = { ["player:1"] = { job = "police", isDead = false } }
H.ui["Take Baseline"].cb()
H.inspect.stateBags = { ["player:1"] = { job = "ems", isDead = false } }
H.ui["Diff Now"].cb()
report = reportFrom("Print Monitor Diff")
check("a changed value is found with both sides",
    report:find("~ changed%s+player:1/job: police %-> ems") ~= nil, report)
check("and counted as changed, not as add plus remove",
    report:find("1 changes %(0 added, 1 changed, 0 removed%)") ~= nil, report)

H.ui["Monitor Source"].cb("Resources")
report = reportFrom("Print Monitor Diff")
H.ui["Diff Now"].cb()
report = reportFrom("Print Monitor Diff")
check("switching source takes its own baseline first",
    report:find("Monitor diff — Resources") ~= nil, report)

H.ui["Clear Baseline"].cb()
report = reportFrom("Print Monitor Diff")
check("a cleared baseline says so", report:find("no baseline taken yet") ~= nil, report)

H.prints = {}
H.ui["Auto Diff"].cb({ toggleState = true })
H.ui["Diff Interval"].cb(1)
H.inspect.resources = { "chat" }
runUntil(function() return logText():find("Baseline taken") ~= nil end, 200)
H.inspect.resources = { "chat", "brand_new_resource" }
local autoFound = runUntil(function()
    return logText():find("brand_new_resource") ~= nil
        or logText():find("1 changes") ~= nil
end, 300)
check("auto diff runs on its interval", autoFound, logText():sub(-200))
H.ui["Auto Diff"].cb({ toggleState = false })

section("Calibration: percentiles and the suggested threshold")

H.ui["Calibration Metric"].cb("Frame Delta")
H.ui["Collect Samples"].cb({ toggleState = true })
H.ui["Safety Margin"].cb(50)

-- One frame per sample, moving 1 m, then 2 m, ... 100 m: the distribution is
-- exactly the integers 1..100, so every percentile has a known answer. The jump
-- to the origin is its own frame, and the samples are cleared after it.
w.coords.x, w.coords.y, w.coords.z = 0.0, 0.0, 0.0
H.frame()
H.ui["Clear Samples"].cb()
for i = 1, 100 do
    w.coords.x = w.coords.x + i
    H.frame()
end

report = reportFrom("Print Calibration")
check("the sample count is right", report:find("100 samples") ~= nil, report)
check("p50 is the 50th value", report:find("p50%s+50%.000") ~= nil, report)
check("p90 is the 90th value", report:find("p90%s+90%.000") ~= nil, report)
check("p95 is the 95th value", report:find("p95%s+95%.000") ~= nil, report)
check("p99 is the 99th value", report:find("p99%s+99%.000") ~= nil, report)
check("max is the largest value", report:find("max%s+100%.000") ~= nil, report)
check("min is the smallest value", report:find("min%s+1%.000") ~= nil, report)
check("the suggested threshold is p99 plus the margin",
    report:find("suggested threshold  148%.50 m   %(p99 %+ 50 %% headroom%)") ~= nil, report)

H.ui["Safety Margin"].cb(100)
report = reportFrom("Print Calibration")
check("raising the margin raises the suggestion",
    report:find("suggested threshold  198%.00 m   %(p99 %+ 100 %% headroom%)") ~= nil, report)

H.ui["Safety Margin"].cb(0)
report = reportFrom("Print Calibration")
check("a zero margin suggests p99 itself",
    report:find("suggested threshold  99%.00 m") ~= nil, report)

H.ui["Safety Margin"].cb(50)
H.prints = {}
H.ui["Apply Suggested Threshold"].cb()
check("applying it writes the jump threshold",
    logText():find("Jump threshold set to 148%.50 m") ~= nil, logText():sub(-200))
H.clearDraws()
H.frame()
check("and the overlay counts against the new threshold",
    H.rowValue("Jumps >= 148.5m") ~= nil,
    table.concat(H.drawnTexts(), "|"):sub(1, 120))
H.ui["Jump Threshold"].cb(5)

H.ui["Calibration Metric"].cb("Implied Speed")
H.frames(2)
report = reportFrom("Print Calibration")
check("switching metric starts a new distribution",
    report:find("Calibration — Implied Speed") ~= nil, report)
check("and does not carry the old samples over",
    report:find("100 samples") == nil, report)

H.prints = {}
H.ui["Apply Suggested Threshold"].cb()
check("a speed metric refuses to be applied as a distance threshold",
    logText():find("not a per%-frame distance") ~= nil, logText():sub(-160))

H.ui["Calibration Metric"].cb("Frame Delta")
H.ui["Collect Samples"].cb({ toggleState = false })
H.ui["Clear Samples"].cb()
report = reportFrom("Print Calibration")
check("no samples reads as no samples", report:find("No samples yet") ~= nil, report)

section("Scenario runner")

H.ui["Scenario"].cb("Teleport Ladder")
H.ui["Step Delay"].cb(500)
H.ui["Repeats"].cb(1)
w.coords.x, w.coords.y, w.coords.z = 300.0, 400.0, 50.0
clearCalls()
H.prints = {}
H.ui["Start Scenario"].cb()

H.clearDraws()
H.frame()
check("the overlay shows the run in progress", H.hasText("Running"))

check("the ladder runs to completion",
    runUntil(function() return logText():find("finished") ~= nil end, 400))

report = reportFrom("Print Run Report")
check("the report names the scenario", report:find("Teleport Ladder") ~= nil)
check("the report names the anti-cheat it ran against",
    report:find("anti%-cheat: ElectronAC, FiveGuard") ~= nil, report)
check("the report lists nine steps", (function()
    local n = select(2, report:gsub("\n%s+%d+%s+1%s", ""))
    return n == 9, tostring(n)
end)())
check("every step teleported", callCount("SetEntityCoords") >= 18,
    tostring(callCount("SetEntityCoords")))

H.ui["Copy Run Report"].cb()
check("the report copies to the clipboard", H.clipboard:find("Teleport Ladder") ~= nil)

H.prints = {}
H.ui["Start Scenario"].cb()
H.frame()
H.ui["Start Scenario"].cb()
check("a second start is refused", logText():find("already running") ~= nil)
H.ui["Stop Scenario"].cb()
H.frames(8)
check("stopping is reported", logText():find("stopped by user") ~= nil)
H.prints = {}
H.frames(40)
check("and no further steps run", not logText():find("step"))
H.prints = {}
H.ui["Stop Scenario"].cb()
check("stopping when idle says so", logText():find("No scenario is running") ~= nil)

H.ui["Scenario"].cb("Armour Jumps")
H.ui["Repeats"].cb(2)
clearCalls()
H.prints = {}
H.ui["Start Scenario"].cb()
runUntil(function() return logText():find("finished") ~= nil end, 600)
report = reportFrom("Print Run Report")
check("two passes are recorded", report:find("  2 ") ~= nil)
check("the armour ladder wrote armour", callCount("SetPedArmour") >= 10,
    tostring(callCount("SetPedArmour")))
H.ui["Repeats"].cb(1)

H.ui["Scenario"].cb("Speed Ramp")
clearCalls()
H.prints = {}
H.ui["Start Scenario"].cb()
runUntil(function() return logText():find("finished") ~= nil end, 400)
check("the speed ramp set the multiplier",
    callCount("SetRunSprintMultiplierForPlayer") >= 8,
    tostring(callCount("SetRunSprintMultiplierForPlayer")))

section("Scenario telemetry")
H.ui["Scenario"].cb("Teleport Ladder")
H.posts = {}
H.ui["Endpoint"].cb("https://ac.example.test/collect")
H.prints = {}
H.ui["Start Scenario"].cb()
runUntil(function() return logText():find("finished") ~= nil end, 400)
check("steps were POSTed", #H.posts >= 5, tostring(#H.posts))
local payload = H.posts[1].payload
check("the payload carries the scenario name",
    payload:find('"scenario":"Teleport Ladder"') ~= nil)
check("the payload carries the step index", payload:find('"scenarioStep":') ~= nil)
check("the payload carries the magnitude", payload:find('"scenarioMagnitude":') ~= nil)
check("the payload carries the anti-cheat", payload:find('"antiCheatCount":2') ~= nil)
check("each snapshot is valid JSON on its own", (function()
    local ok, err = pcall(parseJson, payload)
    return ok, tostring(err)
end)())
H.ui["Endpoint"].cb("")

section("Teleport paths")
clearCalls()
H.ui["Teleport Method"].cb("Native (SetEntityCoords)")
submenuFunc("Quick Locations", "Airport")()
eq("the native path is used", callCount("SetEntityCoords"), 1)
eq("and Ham is not", callCount("Ham.setPosition"), 0)

clearCalls()
H.ui["Teleport Method"].cb("Ham (setPosition)")
submenuFunc("Quick Locations", "Airport")()
eq("the Ham path is used", callCount("Ham.setPosition"), 1)

clearCalls()
H.prints = {}
H.ui["Start Scenario"].cb()
runUntil(function() return logText():find("finished") ~= nil end, 400)
check("the ladder follows the selected path",
    callCount("Ham.setPosition") >= 18 and callCount("SetEntityCoords") == 0,
    ("ham=%d native=%d"):format(callCount("Ham.setPosition"), callCount("SetEntityCoords")))
H.ui["Teleport Method"].cb("Native (SetEntityCoords)")

section("Export bundle")

H.prints = {}
H.ui["Print Export Bundle"].cb()
local bundleText
for _, line in ipairs(H.prints) do
    if line:sub(1, 1) == "{" then bundleText = line break end
end
check("a bundle was printed", bundleText ~= nil)

local ok, bundle = pcall(parseJson, bundleText or "")
check("the bundle is valid JSON", ok, tostring(bundle))

if ok then
    eq("it names the script", bundle.script, "Luchs Skript v1.0")
    eq("it names the front end", bundle.interface, "vanity-menu")
    check("it carries the live snapshot",
        type(bundle.snapshot) == "table" and type(bundle.snapshot.x) == "number")
    check("it carries the anti-cheat block",
        type(bundle.antiCheat) == "table" and bundle.antiCheat.count == 2
            and bundle.antiCheat.present == true)
    eq("with the names as an array", #bundle.antiCheat.names, 2)
    check("it carries the calibration block",
        type(bundle.calibration) == "table"
            and type(bundle.calibration.p99) == "number"
            and type(bundle.calibration.suggested) == "number")
    check("it carries the monitor block",
        type(bundle.monitor) == "table" and type(bundle.monitor.added) == "table")
    check("it carries the scenario steps",
        type(bundle.scenario) == "table" and #bundle.scenario.steps == 9,
        bundle.scenario and tostring(#bundle.scenario.steps))
    check("it carries the action log",
        type(bundle.log) == "table" and #bundle.log > 0)
end

-- A state bag value the server controls can hold anything; the bundle still has
-- to parse.
H.inspect.stateBags = {
    ["player:9"] = { note = 'quote " backslash \\ newline \n tab \t bell \7' },
}
H.ui["Monitor Source"].cb("State Bags")
H.ui["Take Baseline"].cb()
H.inspect.stateBags = { ["player:9"] = { note = "changed" } }
H.ui["Diff Now"].cb()
H.prints = {}
H.ui["Print Export Bundle"].cb()
for _, line in ipairs(H.prints) do
    if line:sub(1, 1) == "{" then bundleText = line break end
end
check("hostile state-bag text stays valid JSON", (function()
    local parsed, err = pcall(parseJson, bundleText or "")
    return parsed, tostring(err)
end)())

H.ui["Copy Export Bundle"].cb()
check("the bundle copies to the clipboard", H.clipboard:sub(1, 1) == "{")

section("Toolkit paths still work")

H.ui["God Mode"].cb({ toggleState = true })
eq("god mode is plumbed", H.ham.godMode, true)
H.ui["God Mode"].cb({ toggleState = false })

w.veh = 0
clearCalls()
H.ui["Repair Vehicle"].cb()
eq("repair refuses on foot", callCount("SetVehicleFixed"), 0)
H.ui["Vehicle Model"].cb("zentorno")
H.ui["Spawn Vehicle"].cb()
eq("a vehicle spawns", callCount("CreateVehicle"), 1)
H.ui["Repair Vehicle"].cb()
eq("and repair works once seated", callCount("SetVehicleFixed"), 1)
w.veh = 0

H.prints = {}
submenuFunc("Dumps", "State Bags")()
check("state bags dump", logText():find("player:9") ~= nil)
H.ui["Copy Last Dump"].cb()
check("the dump copies", H.clipboard:find("State bags") ~= nil)

H.posts = {}
H.ui["URL"].cb("https://ac.example.test/x")
submenuFunc("Send Request", "GET (sync)")()
eq("a sync GET is issued", #H.posts, 1)

clearCalls()
H.ui["Execute Lua..."].cb()
lastPrompt().cb('print("hi")', false)
eq("Execute is called", callCount("Ham.Execute"), 1)

H.ui["Teleport to Coords..."].cb()
clearCalls()
lastPrompt().cb("11.5, 22.5, 33.5", false)
local c = lastCall("SetEntityCoords")
check("a coordinate prompt parses",
    c and c[2] == 11.5 and c[3] == 22.5 and c[4] == 33.5)

H.ui["Teleport to Coords..."].cb()
H.prints = {}
lastPrompt().cb("not coordinates", false)
check("and rejects garbage", logText():find("Could not parse") ~= nil)

section("Reset Everything")
H.ui["Scenario"].cb("Teleport Ladder")
H.ui["Start Scenario"].cb()
H.frame()
clearCalls()
H.prints = {}
H.ui["Reset Everything"].cb()
eq("god mode is cleared", H.ham.godMode, false)
eq("run speed is restored", lastCall("SetRunSprintMultiplierForPlayer")[2], 1.0)
check("a running scenario is stopped", logText():find("stopped by reset") ~= nil)
H.frames(30)

section("Re-execution")
dofile("scripts/luchs-script.lua")
H.frames(2)
eq("only the newest loop survives", H.aliveThreads(), 1)
H.clearDraws()
H.frame()
local panels = 0
for _, dd in ipairs(H.draws) do
    if dd.fn == "drawRectFilled" then panels = panels + 1 end
end
eq("the overlay is not drawn twice", panels, 1)

section("A build without getAntiCheats")
Ham.getAntiCheats = nil
dofile("scripts/luchs-script.lua")
H.frames(2)
report = reportFrom("Print Anti-Cheat Report")
check("detection reports itself unsupported",
    report:find("names    : detection unsupported") ~= nil, report)
check("and nothing else broke", H.aliveThreads() == 1)

--------------------------------------------------------------------------------
H.realPrint(("\n%d passed, %d failed"):format(passed, failed))
os.exit(failed == 0 and 0 or 1)
