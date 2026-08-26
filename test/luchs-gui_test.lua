-- Tests for scripts/luchs-gui.lua (the drawn front end).
-- Run: lua5.4 test/luchs-gui_test.lua
--
-- The engine underneath is the same one luchs-script_test.lua covers; this file
-- is about the window: that it stays on screen, that clicking it does what it
-- looks like it does, and that it never keeps hold of the mouse.

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
local function logText() return table.concat(H.prints, "\n") end
local function callCount(n) return H.calls[n] or 0 end

--------------------------------------------------------------------------------
dofile("scripts/luchs-gui.lua")
H.frames(2)

--------------------------------------------------------------------------------
-- Helpers that drive the window through what it draws
--------------------------------------------------------------------------------

local function redraw()
    H.clearDraws()
    H.frame()
end

-- The footer's "from-to / total" tells the test how far down a tab it is,
-- without it having to redo the window's layout arithmetic.
local function footerRange()
    for _, t in ipairs(H.drawnTexts()) do
        local from, to, total = t:match("^(%d+)%-(%d+) / (%d+)")
        if from then return tonumber(from), tonumber(to), tonumber(total) end
    end
end

-- A slider track is a track-coloured rect immediately followed by its
-- accent-coloured fill. Matching on that pair rather than on a pixel height
-- keeps the helper working at every window scale — the bug that first hid a
-- broken drag test behind a silently skipped one.
local function isColor(d, r, g, b)
    return d.color and d.color[1] == r and d.color[2] == g and d.color[3] == b
end

local function sliderTracks()
    local out = {}
    for i = 1, #H.draws - 1 do
        local d, next = H.draws[i], H.draws[i + 1]
        if d.fn == "drawRectFilled" and next.fn == "drawRectFilled"
            and isColor(d, 40, 46, 58) and isColor(next, 120, 200, 255)
            and next.rect[2] == d.rect[2] and next.rect[4] == d.rect[4] then
            out[#out + 1] = d.rect
        end
    end
    return out
end

local function requireTrack(which)
    local tracks = sliderTracks()
    local track = tracks[which or 1]
    if not track then
        failed = failed + 1
        H.realPrint(("  FAIL  slider track %d not drawn"):format(which or 1))
    end
    return track
end

-- The two arrows of a selector sit on one row; a button's ">" does not.
local function selectorArrows()
    local left = H.findText("<")
    if not left then return nil end
    for _, d in ipairs(H.draws) do
        if d.fn == "drawText" and d.text == ">" and math.abs(d.y - left.y) < 0.5 then
            return left, d
        end
    end
end

local function selectorValue()
    local left = selectorArrows()
    if not left then return nil end
    for _, d in ipairs(H.draws) do
        if d.fn == "drawText" and math.abs(d.y - left.y) < 0.5
            and d.text ~= "<" and d.text ~= ">" and d.text:find("%(%d+/%d+%)") then
            return d.text
        end
    end
end

-- Tabs keep their own scroll position, so a visit that expects to see the
-- first rows has to wind back up to them.
local function openTab(name)
    redraw()
    local ok = H.clickText(name)
    H.frame()
    redraw()

    local guard = 0
    while guard < 60 do
        local from = footerRange()
        if not from or from <= 1 then break end
        if not H.clickText("^") then break end
        H.frame()
        redraw()
        guard = guard + 1
    end
    return ok
end

local function clickLabel(text)
    local ok = H.clickText(text)
    H.frame()
    return ok
end

-- Alpha of the window panel, i.e. how far the open animation has run.
local function windowAlpha()
    for i = 1, #H.draws - 1 do
        local a, b = H.draws[i], H.draws[i + 1]
        if a.fn == "drawRectFilled" and b.fn == "drawRectFilled"
            and a.rect[3] == b.rect[3] and a.rect[4] == b.rect[4]
            and b.rect[1] < a.rect[1] and b.rect[2] < a.rect[2] then
            return b.color[4]
        end
    end
end

-- Launch Menu toggles, so a test that wants the window up has to say so
-- rather than assume which way the last section left it.
local function showWindow()
    redraw()
    if H.windowRect() == nil then
        H.ui["Launch Menu"].cb()
        H.frames(30)
    end
    redraw()
end

local function dragSlider(track, frac)
    H.hold(track[1], track[2] + 2)
    H.frame()
    H.moveTo(track[1] + track[3] * frac, track[2] + 2)
    H.frame()
    H.release()
    H.frame()
end

--------------------------------------------------------------------------------
section("The Vanity menu holds one control")

local controls = 0
for _, e in ipairs(H.ui) do
    local isControl = e.kind == "button" or e.kind == "toggle" or e.kind == "slider"
        or e.kind == "selector" or e.kind == "textinput" or e.kind == "submenu"
    if isControl then controls = controls + 1 end
end
eq("exactly one control registered", controls, 1)
eq("it is a button", H.ui["Launch Menu"].kind, "button")
check("it carries a description", (H.ui["Launch Menu"].desc or "") ~= "")

section("Showing and hiding")

redraw()
check("nothing is drawn while hidden", H.windowRect() == nil)
eq("the mouse is not captured while hidden", H.ham.toggleMouse, nil)

H.ui["Launch Menu"].cb()
H.frames(30)
redraw()
check("the window is drawn once shown", H.windowRect() ~= nil)
eq("the mouse is captured", H.ham.toggleMouse, true)
eq("game input is blocked", H.ham.toggleInputBlock, true)
check("the title is drawn", H.hasText("Luchs GUI v1.0"))

H.ui["Launch Menu"].cb()
H.frames(40)
redraw()
eq("the mouse is handed back on hide", H.ham.toggleMouse, false)
eq("input is handed back on hide", H.ham.toggleInputBlock, false)
check("and nothing is left drawn", H.windowRect() == nil)

section("The toggle key")

H.frames(2)
H.keysDown[0x74] = true      -- F5, the default binding
H.frame()
H.keysDown[0x74] = false
H.frames(30)
redraw()
check("F5 shows the window", H.windowRect() ~= nil)

H.keysDown[0x74] = true
H.frame()
H.keysDown[0x74] = false
H.frames(40)
redraw()
check("F5 hides it again", H.windowRect() == nil)
eq("hiding by key also releases the mouse", H.ham.toggleMouse, false)

-- Held down, the key must fire once, not once per frame.
H.keysDown[0x74] = true
H.frames(20)
redraw()
check("holding the key does not flicker the window", H.windowRect() ~= nil)
H.keysDown[0x74] = false
H.frames(20)

section("Tabs")

H.frames(20)
redraw()
check("the window is open for the tab tests", H.windowRect() ~= nil)

for _, name in ipairs({ "Monitors", "Calibration", "Anti-Cheat Detection", "Window" }) do
    check("tab " .. name .. " opens", openTab(name) and H.hasText(name))
end

check("opening a tab shows its own items", (function()
    openTab("Calibration")
    return H.hasText("Collect Samples") and H.hasText("Safety Margin")
end)())

section("Every selector opens on its first choice")

-- Vanity selectors always start at index 1, and the drawn ones follow the same
-- spec. A default that is not choices[1] would leave the control showing one
-- value while another is in effect. Nothing above this point has changed one.
local selectorsSeen, selectorsWrong = 0, {}

for _, tab in ipairs({ "Scenario Runner", "Movement Analysis", "Monitors",
                       "Calibration", "Telemetry", "Self", "Teleport", "Vehicle",
                       "World", "Weapons", "Inspector", "HTTP",
                       "Anti-Cheat Detection", "Advanced", "Window" }) do
    openTab(tab)
    local guard = 0
    while guard < 40 do
        for _, txt in ipairs(H.drawnTexts()) do
            local index, total = txt:match("%((%d+)/(%d+)%)$")
            if index then
                selectorsSeen = selectorsSeen + 1
                if index ~= "1" then
                    selectorsWrong[#selectorsWrong + 1] =
                        ("%s: %s"):format(tab, txt)
                end
            end
        end
        local from, to, total = footerRange()
        if not to or to >= total then break end
        if not H.clickText("v") then break end
        H.frame()
        redraw()
        guard = guard + 1
    end
end

check("selectors were found to check", selectorsSeen >= 9, tostring(selectorsSeen))
check("every selector opens on its first choice",
    #selectorsWrong == 0, table.concat(selectorsWrong, ", "))

section("The open animation does not depend on the frame rate")

-- 1 - exp(-speed * dt) composes to exp(-speed * total), so the same elapsed
-- time must land on the same frame whether it arrived in few frames or many.
local function openFor(frames, ms)
    if H.windowRect() ~= nil then
        H.ui["Launch Menu"].cb()
        H.frames(80)
    end
    redraw()
    H.ui["Launch Menu"].cb()
    for _ = 1, frames do
        H.clearDraws()
        H.frame(ms)
    end
    return windowAlpha()
end

local slowFrames = openFor(5, 32)    -- 160 ms in 5 frames
local fastFrames = openFor(10, 16)   -- 160 ms in 10 frames
check("the same elapsed time gives the same opening state",
    slowFrames ~= nil and slowFrames == fastFrames,
    ("%s vs %s"):format(tostring(slowFrames), tostring(fastFrames)))
check("and it is partway open, not snapped",
    slowFrames ~= nil and slowFrames > 20 and slowFrames < 242, tostring(slowFrames))

H.frames(60)   -- let it finish opening

section("Window layout fits the screen at every scale")

openTab("Window")
local track = sliderTracks()[1]
check("the scale slider is drawn", track ~= nil)

for _, res in ipairs({ { 1920, 1080 }, { 1280, 720 }, { 2560, 1440 } }) do
    H.resolution = { res[1], res[2] }
    for _, frac in ipairs({ 0.0, 0.25, 0.5, 0.75, 1.0 }) do
        openTab("Window")
        dragSlider(requireTrack(1), frac)
        redraw()
        local r = H.windowRect()
        check(("window fits %dx%d at scale %d%%"):format(res[1], res[2], frac * 100),
            r ~= nil and r[1] >= 0 and r[2] >= 0
                and r[1] + r[3] <= res[1] and r[2] + r[4] <= res[2],
            r and ("x=%.0f y=%.0f w=%.0f h=%.0f"):format(r[1], r[2], r[3], r[4]) or "no window")
    end
end

H.resolution = { 1920, 1080 }
openTab("Window")
dragSlider(requireTrack(1), 1 / 3)   -- back to 100 %
redraw()
check("the scale slider came back to 100", H.hasText("100"))

section("The toggle-key stepper wraps at both ends")

openTab("Window")
local first = selectorValue()
check("the stepper starts on the first key", first and first:find("(1/8)", 1, true) ~= nil,
    tostring(first))

local left = selectorArrows()
H.click(left.x, left.y)
H.frame()
redraw()
local wrapped = selectorValue()
check("stepping back from the first wraps to the last",
    wrapped and wrapped:find("(8/8)", 1, true) ~= nil, tostring(wrapped))

local _, right = selectorArrows()
H.click(right.x, right.y)
H.frame()
redraw()
local wrappedFwd = selectorValue()
check("stepping forward from the last wraps to the first",
    wrappedFwd and wrappedFwd:find("(1/8)", 1, true) ~= nil, tostring(wrappedFwd))

check("the footer names the bound key", (function()
    for _, txt in ipairs(H.drawnTexts()) do
        if txt:find("/ %d+%s+F5$") then return true end
    end
    return false
end)())

section("Clicking widgets")

openTab("Self")
H.clickText("God Mode")
H.frame()
eq("a toggle row flips the feature", H.ham.godMode, true)
redraw()
H.clickText("God Mode")
H.frame()
eq("and flips it back", H.ham.godMode, false)

openTab("Anti-Cheat Detection")
H.prints = {}
clickLabel("Detect Anti-Cheats")
check("a button row runs its action", logText():find("Anti%-cheat") ~= nil)

openTab("Telemetry")
H.clickText("Endpoint")
H.frame()
check("a text row opens the Vanity prompt", (function()
    for i = #H.ui, 1, -1 do
        if H.ui[i].kind == "prompt" then return true end
    end
    return false
end)())

section("An action that yields runs outside the protected draw")

-- Spawning waits for the model to load. If that ran inside the pcall around the
-- draw, the coroutine would try to yield across a protected call, which is not
-- portable between LuaJIT and 5.4.
w.veh = 0
H.calls = {}
openTab("Vehicle")
clickLabel("Spawn Vehicle")
H.frames(4)
eq("the vehicle was spawned", callCount("CreateVehicle"), 1)
check("the loop survived the yield", H.aliveThreads() >= 1)
w.veh = 0

section("A drag never outlives the widget")

openTab("Window")
local scaleTrack = requireTrack(1)

-- Start a drag near the right end of the track.
H.hold(scaleTrack[1] + scaleTrack[3] * 0.8, scaleTrack[2] + 2)
H.frame()

-- Switch tab with the button still held. H.hold keeps it down, so only the tab
-- change itself can end the drag — which is the fix being tested.
local selfTab = H.findText("Self")
H.hold(selfTab.x, selfTab.y)
H.frames(3)
redraw()
local settled = H.windowRect()[3]

-- Still holding, move back across where the track used to be. A drag that
-- survived the tab change would follow the mouse and resize the window.
H.moveTo(scaleTrack[1], scaleTrack[2] + 2)
H.frames(3)
redraw()
local afterMove = H.windowRect()[3]
H.release()
H.frames(2)

check("the drag stopped writing once the tab changed",
    math.abs(afterMove - settled) < 1.0,
    ("%.0f then %.0f"):format(settled, afterMove))

-- And a plain release ends it too.
local tr = requireTrack(1)
H.hold(tr[1] + tr[3] * 0.5, tr[2] + 2)
H.frame()
H.release()
H.frame()
redraw()
local afterRelease = H.windowRect()[3]
H.moveTo(tr[1], tr[2] + 2)
H.frames(3)
redraw()
eq("and stops when the button comes up", H.windowRect()[3], afterRelease)

section("Re-execution")

showWindow()
eq("shown again, mouse captured", H.ham.toggleMouse, true)

local before = H.aliveThreads()
check("one loop before re-executing", before == 1, tostring(before))

dofile("scripts/luchs-gui.lua")
H.frames(3)
eq("only the newest loop survives", H.aliveThreads(), 1)
eq("the retiring loop handed the mouse back", H.ham.toggleMouse, false)

redraw()
check("the new instance starts hidden", H.windowRect() == nil)

H.ui["Launch Menu"].cb()
H.frames(30)
redraw()
local windows = 0
for i = 1, #H.draws - 1 do
    local a, b = H.draws[i], H.draws[i + 1]
    if a.fn == "drawRectFilled" and b.fn == "drawRectFilled"
        and a.rect[3] == b.rect[3] and a.rect[4] == b.rect[4]
        and b.rect[1] < a.rect[1] then
        windows = windows + 1
    end
end
eq("the window is not drawn twice", windows, 1)

local panels = 0
for _, d in ipairs(H.draws) do
    if d.fn == "drawRectFilled" and d.rect[3] > 300 and d.color[4] == 175 then
        panels = panels + 1
    end
end
eq("the overlay is not drawn twice", panels, 1)

section("A draw failure hands the mouse back")

-- Last, because it switches the overlay off on its way through.
showWindow()
eq("captured before the failure", H.ham.toggleMouse, true)

H.prints = {}
H.drawError = true
H.frame()
H.drawError = false
H.frames(2)

eq("released after the failure", H.ham.toggleMouse, false)
eq("input released too", H.ham.toggleInputBlock, false)
check("the GUI failure was reported once",
    select(2, logText():gsub("GUI draw failed", "")) == 1, logText():sub(1, 160))
check("the overlay switched itself off rather than killing the loop",
    logText():find("Overlay draw failed") ~= nil)
eq("the loop is still running", H.aliveThreads(), 1)
redraw()
check("and the window is gone", H.windowRect() == nil)

--------------------------------------------------------------------------------
H.realPrint(("\n%d passed, %d failed"):format(passed, failed))
os.exit(failed == 0 and 0 or 1)
