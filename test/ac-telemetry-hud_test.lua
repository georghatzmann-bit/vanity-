-- Tests for scripts/ac-telemetry-hud.lua
-- Run: lua5.4 test/ac-telemetry-hud_test.lua

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
        ("got %s, want ~%s"):format(tostring(got), tostring(want)))
end

local function section(t) H.realPrint("\n" .. t) end

--------------------------------------------------------------------------------
dofile("scripts/ac-telemetry-hud.lua")

section("UI registration")
local kinds = {}
for _, e in ipairs(H.ui) do kinds[e.kind] = (kinds[e.kind] or 0) + 1 end
check("registers toggles",   (kinds.toggle or 0) >= 5)
check("registers sliders",   (kinds.slider or 0) >= 3)
check("registers buttons",   (kinds.button or 0) >= 4)
check("registers a selector", (kinds.selector or 0) == 1)
check("registers a text input", (kinds.textinput or 0) == 1)
check("every control has a description", (function()
    for _, e in ipairs(H.ui) do
        local needsDesc = e.kind == "toggle" or e.kind == "slider"
            or e.kind == "button" or e.kind == "selector" or e.kind == "textinput"
        if needsDesc and (not e.desc or e.desc == "") then return false, e.name end
    end
    return true
end)())

section("Idle: stationary player")
H.frames(5)
H.clearDraws()
H.frame()
eq("delta is zero", H.rowValue("Delta/frame").text, "0.000 m")
check("panel is drawn", (function()
    for _, d in ipairs(H.draws) do if d.fn == "drawRectFilled" then return true end end
    return false
end)())

section("Walking at a plausible speed")
w.speed = 5.0
for _ = 1, 3 do w.coords.x = w.coords.x + 0.08; H.frame() end
H.clearDraws()
w.coords.x = w.coords.x + 0.08
H.frame()
eq("delta tracks movement", H.rowValue("Delta/frame").text, "0.080 m")
eq("implied speed matches engine speed", H.rowValue("Implied").text, "5.0 m/s")
eq("jump counter stays at zero", H.rowValue("Jumps >=").text:sub(1, 1), "0")

section("Teleport: 50 m in one frame")
H.clearDraws()
w.coords.x = w.coords.x + 50.0
H.frame()
local d = H.rowValue("Delta/frame")
eq("delta reports the jump", d.text, "50.000 m")
check("delta is coloured as an alert", d.color[1] == 255 and d.color[2] == 95)
eq("jump is counted", H.rowValue("Jumps >=").text, "1  (last 50.00 m)")
eq("max delta retained", H.rowValue("Max delta").text, "50.000 m")

section("Threshold control")
H.ui["Jump Threshold"].cb(20)
H.clearDraws()
H.frame()
check("threshold label follows the slider",
    H.rowValue("Jumps >= 20m") ~= nil,
    "label was not 'Jumps >= 20m'")
H.ui["Jump Threshold"].cb(5)

section("Snapshot")
H.ui["Print Snapshot"].cb()
local snap = H.prints[#H.prints]:gsub("^%[AC HUD%] ", "")
check("snapshot is a JSON object", snap:sub(1, 1) == "{" and snap:sub(-1) == "}")
check("integers are not emitted as floats", not snap:match('"serverId":%d+%.'))
check("carries position", snap:find('"x":') ~= nil)
check("carries movement analysis", snap:find('"impliedSpeed":') ~= nil)
local f = io.open("/tmp/ac-hud-snapshot.json", "w")
if f then f:write(snap); f:close() end

section("Telemetry")
H.ui["Send Snapshot Now"].cb()
eq("no POST without an endpoint", #H.posts, 0)
H.ui["Endpoint"].cb("https://ac.example.test/collect")
H.ui["Send Snapshot Now"].cb()
eq("POSTs once an endpoint is set", #H.posts, 1)
eq("posts to the configured url", H.posts[1].url, "https://ac.example.test/collect")
eq("sends JSON content type", H.posts[1].headers["Content-Type"], "application/json")
H.clearDraws()
H.frame()
eq("status reflects the response", H.rowValue("Status").text, "ok 200")

H.ui["Auto POST"].cb({ toggleState = true })
H.ui["Interval"].cb(1)
local before = #H.posts
H.frames(70)
check("auto POST fires on the interval", #H.posts > before,
    ("posts went %d -> %d"):format(before, #H.posts))
local afterOne = #H.posts
H.frames(10)
eq("auto POST does not fire every frame", #H.posts, afterOne)
H.ui["Auto POST"].cb({ toggleState = false })

section("Layout")
for _, corner in ipairs({ "Top Left", "Top Right", "Bottom Left", "Bottom Right" }) do
    for _, size in ipairs({ 10, 14, 26 }) do
        H.ui["Corner"].cb(corner)
        H.ui["Font Size"].cb(size)
        H.clearDraws()
        H.frame()
        local panel
        for _, dd in ipairs(H.draws) do
            if dd.fn == "drawRectFilled" then panel = dd end
        end
        local r = panel.rect
        check(("panel fits on screen (%s, font %d)"):format(corner, size),
            r[1] >= 0 and r[2] >= 0
            and r[1] + r[3] <= H.resolution[1]
            and r[2] + r[4] <= H.resolution[2],
            ("x=%.0f y=%.0f w=%.0f h=%.0f"):format(r[1], r[2], r[3], r[4]))
    end
end
H.ui["Corner"].cb("Top Left")
H.ui["Font Size"].cb(14)

section("Panel toggles")
H.ui["Show HUD"].cb({ toggleState = false })
H.clearDraws()
H.frame()
eq("HUD off draws nothing", #H.draws, 0)
H.ui["Show HUD"].cb({ toggleState = true })

H.ui["Movement"].cb({ toggleState = false })
H.clearDraws()
H.frame()
check("movement panel hidden", not H.hasText("MOVEMENT"))
check("position panel still shown", H.hasText("POSITION"))
H.ui["Movement"].cb({ toggleState = true })

section("Vehicle")
H.clearDraws()
H.frame()
check("no vehicle panel on foot", not H.hasText("VEHICLE"))
w.veh, w.vehModel, w.vehSpeed = 7, 3078201489, 31.0
H.clearDraws()
H.frame()
check("vehicle panel appears when seated", H.hasText("VEHICLE"))
w.veh, w.vehModel, w.vehSpeed = 0, 0, 0.0

section("Marker and counters")
H.ui["Set Reference Marker"].cb()
w.coords.x = w.coords.x + 12.0
H.clearDraws()
H.frame()
eq("distance from marker", H.rowValue("From marker").text, "12.00 m")
H.ui["Clear Marker"].cb()
H.clearDraws()
H.frame()
check("marker row disappears once cleared", H.rowValue("From marker") == nil)
H.ui["Reset Counters"].cb()
H.clearDraws()
H.frame()
eq("max delta cleared", H.rowValue("Max delta").text, "0.000 m")
eq("jumps cleared", H.rowValue("Jumps >=").text:sub(1, 1), "0")

section("Re-execution")
local threadsBefore = #H.threads
dofile("scripts/ac-telemetry-hud.lua")
H.frames(2)
eq("a second execution spawns a second loop", #H.threads, threadsBefore + 1)
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
