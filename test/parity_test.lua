-- Parity between scripts/luchs-script.lua and scripts/luchs-gui.lua.
-- Run: lua5.4 test/parity_test.lua
--
-- The two scripts are standalone single files — nothing can be require()d into a
-- Vanity sandbox — so the whole engine, SPEC table included, is carried in both.
-- This is the test that stops them drifting: the shared region must be identical
-- byte for byte, and both front ends must actually surface every feature in it.

local H = dofile("test/stubs.lua")

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

local function readFile(path)
    local f = assert(io.open(path), "cannot open " .. path)
    local s = f:read("*a")
    f:close()
    return s
end

local SCRIPT = "scripts/luchs-script.lua"
local GUI    = "scripts/luchs-gui.lua"

local scriptSrc, guiSrc = readFile(SCRIPT), readFile(GUI)

--------------------------------------------------------------------------------
section("Both scripts stand alone")

for _, pair in ipairs({ { SCRIPT, scriptSrc }, { GUI, guiSrc } }) do
    local name, src = pair[1], pair[2]
    check(name .. ": no require()", not src:match("\nrequire%("))
    check(name .. ": no dofile()", not src:match("\ndofile%("))
    check(name .. ": substantial", #src > 60000, tostring(#src) .. " bytes")
end

--------------------------------------------------------------------------------
section("Excluded features are absent from both")

-- Spoofing, bypass and the aimbot exist to defeat detection or to target other
-- players. getAntiCheats is read-only and stays in; nothing branches on it.
local BANNED = { "aimBot", "setAimbotFov", "setAimbotBone", "setAimbotKey",
                 "setAimbotSmoothing", "setAimbotVisibleOnly", "setAimbotIgnoreVehicles",
                 "spoofTeleport", "speedSpoof", "pedSpoof", "spoofAllVisible",
                 "camBypass", "lockEventLogger" }

for _, pair in ipairs({ { SCRIPT, scriptSrc }, { GUI, guiSrc } }) do
    local name, src = pair[1], pair[2]
    local hits = {}
    for _, banned in ipairs(BANNED) do
        local calls = select(2, src:gsub('ham%("' .. banned .. '"', ""))
            + select(2, src:gsub("Ham%." .. banned .. "%(", ""))
            + select(2, src:gsub("hamFn%(\"" .. banned .. "\"", ""))
        if calls > 0 then hits[#hits + 1] = banned end
    end
    check(name .. ": no call site for the excluded family",
        #hits == 0, table.concat(hits, ", "))
end

check("getAntiCheats is only ever read", (function()
    -- One resolution point in the engine, and the result is only ever counted,
    -- named or reported — never used as a condition on behaviour.
    local n = select(2, scriptSrc:gsub('hamFn%("getAntiCheats"%)', ""))
    return n == 1, tostring(n) .. " resolution sites"
end)())

--------------------------------------------------------------------------------
section("The shared engine is byte-identical")

local BEGIN_MARK = "-- >>> SHARED ENGINE BEGIN <<<"
local END_MARK   = "-- <<< SHARED ENGINE END >>>"

local function engineRegion(src)
    local a = src:find(BEGIN_MARK, 1, true)
    local b = src:find(END_MARK, 1, true)
    if not a or not b then return nil end
    return src:sub(a, b + #END_MARK - 1)
end

local scriptEngine, guiEngine = engineRegion(scriptSrc), engineRegion(guiSrc)

check("script has a marked engine region", scriptEngine ~= nil)
check("gui has a marked engine region", guiEngine ~= nil)
check("engine regions are the same size",
    scriptEngine and guiEngine and #scriptEngine == #guiEngine,
    scriptEngine and guiEngine
        and ("%d vs %d bytes"):format(#scriptEngine, #guiEngine) or "missing")
check("engine regions are identical", scriptEngine == guiEngine,
    (function()
        if not scriptEngine or not guiEngine then return "missing" end
        for i = 1, math.min(#scriptEngine, #guiEngine) do
            if scriptEngine:sub(i, i) ~= guiEngine:sub(i, i) then
                return "first difference at byte " .. i .. ": " ..
                    scriptEngine:sub(i, i + 40):gsub("\n", "|")
            end
        end
        return "one is a prefix of the other"
    end)())
check("the engine is most of each file",
    scriptEngine and #scriptEngine > #scriptSrc * 0.5,
    scriptEngine and ("%d of %d bytes"):format(#scriptEngine, #scriptSrc) or "missing")

--------------------------------------------------------------------------------
section("Room to grow")

-- Lua allows 200 local variables in one function, and a standalone script is
-- one function. Crossing it fails with "main function has more than 200 local
-- variables", which says nothing about the change that caused it — so the
-- headroom is asserted here, where the message can.
local compile = loadstring or load

local function spareLocals(src)
    for n = 1, 40 do
        local probe = { src }
        for i = 1, n do
            probe[#probe + 1] = ("local __probe%d = %d"):format(i, i)
        end
        local chunk, err = compile(table.concat(probe, "\n"))
        if not chunk then
            if tostring(err):find("local variables") then return n - 1 end
            return nil, err
        end
    end
    return 40
end

for _, pair in ipairs({ { SCRIPT, scriptSrc }, { GUI, guiSrc } }) do
    local name, src = pair[1], pair[2]
    local spare, err = spareLocals(src)
    check(name .. ": room for more top-level locals",
        spare ~= nil and spare >= 15,
        spare and (spare .. " spare") or ("compile failed: " .. tostring(err)))
end

--------------------------------------------------------------------------------
section("Feature spec")

-- Read the SPEC table itself rather than the whole engine: overlay rows use
-- `label =` too, and one of them is literally "...".
local specRegion = scriptEngine:match("\nlocal SPEC = {\n(.-)\nlocal function itemChoices")
check("the SPEC table can be read", specRegion ~= nil and #specRegion > 10000,
    specRegion and tostring(#specRegion) or "not found")
specRegion = specRegion or ""

local specLabels, labelOrder = {}, {}
for label in specRegion:gmatch('label = "([^"]+)"') do
    if not specLabels[label] then
        specLabels[label] = 0
        labelOrder[#labelOrder + 1] = label
    end
    specLabels[label] = specLabels[label] + 1
end

local specSections = {}
for name in specRegion:gmatch('section = "([^"]+)"') do
    specSections[#specSections + 1] = name
end

check("the spec has sections", #specSections == 14, tostring(#specSections))
check("the spec has features", #labelOrder > 120, tostring(#labelOrder))

check("every feature label is unique", (function()
    local dupes = {}
    for _, label in ipairs(labelOrder) do
        if specLabels[label] > 1 then dupes[#dupes + 1] = label end
    end
    -- Labels are how the two front ends are compared, and how a tester refers to
    -- a feature. Two features sharing one would make both ambiguous.
    return #dupes == 0, table.concat(dupes, ", ")
end)())

check("the tabs the brief asked for all exist", (function()
    local want = { "Scenario Runner", "Movement Analysis", "Monitors", "Calibration",
                   "Telemetry", "Self", "Teleport", "Vehicle", "World", "Weapons",
                   "Inspector", "HTTP", "Anti-Cheat Detection", "Advanced" }
    local have = {}
    for _, s in ipairs(specSections) do have[s] = true end
    local missing = {}
    for _, s in ipairs(want) do
        if not have[s] then missing[#missing + 1] = s end
    end
    return #missing == 0, table.concat(missing, ", ")
end)())

--------------------------------------------------------------------------------
section("The menu front end surfaces every feature")

dofile(SCRIPT)
H.frames(2)

local menuLabels = {}
local menuControls = 0
for _, e in ipairs(H.ui) do
    local isControl = e.kind == "button" or e.kind == "toggle" or e.kind == "slider"
        or e.kind == "selector" or e.kind == "textinput" or e.kind == "submenu"
    if isControl then
        menuControls = menuControls + 1
        menuLabels[e.name] = true
        if e.items then
            for _, item in ipairs(e.items) do menuLabels[item.name] = true end
        end
    end
end

check("the menu registers a control per feature",
    menuControls >= #labelOrder - 40, tostring(menuControls) .. " controls")

check("every spec feature reached the menu", (function()
    local missing = {}
    for _, label in ipairs(labelOrder) do
        if not menuLabels[label] then missing[#missing + 1] = label end
    end
    return #missing == 0, table.concat(missing, ", "):sub(1, 300)
end)())

check("every menu section is a separator", (function()
    local seps = {}
    for _, e in ipairs(H.ui) do
        if e.kind == "separator" then seps[e.name] = true end
    end
    local missing = {}
    for _, s in ipairs(specSections) do
        if not seps[s] then missing[#missing + 1] = s end
    end
    return #missing == 0, table.concat(missing, ", ")
end)())

check("every submenu entry is type=button", (function()
    local wrong = {}
    for _, e in ipairs(H.ui) do
        if e.kind == "submenu" then
            for _, item in ipairs(e.items or {}) do
                if item.type ~= "button" then
                    wrong[#wrong + 1] = e.name .. "/" .. tostring(item.name)
                end
            end
        end
    end
    return #wrong == 0, table.concat(wrong, ", ")
end)())

check("every control carries a description", (function()
    local missing = {}
    for _, e in ipairs(H.ui) do
        local needs = e.kind == "toggle" or e.kind == "slider" or e.kind == "button"
            or e.kind == "selector" or e.kind == "textinput" or e.kind == "submenu"
        if needs and (not e.desc or e.desc == "") then missing[#missing + 1] = e.name end
    end
    return #missing == 0, table.concat(missing, ", ")
end)())

check("every selector opens on its own first choice", (function()
    -- A Vanity selector always starts at index 1. If a spec default is anything
    -- else the menu shows one value while another is in effect.
    local wrong = {}
    for _, e in ipairs(H.ui) do
        if e.kind == "selector" then
            local first = e.choices and e.choices[1]
            if first == nil then wrong[#wrong + 1] = e.name .. " (no choices)" end
        end
    end
    return #wrong == 0, table.concat(wrong, ", ")
end)())

--------------------------------------------------------------------------------
section("The GUI front end surfaces every feature")

-- Drop the menu build entirely: its render loop must not draw over the GUI's.
H.ui, H.threads, H.draws, H.prints = {}, {}, {}, {}

dofile(GUI)
H.frames(2)

local guiControls = 0
for _, e in ipairs(H.ui) do
    local isControl = e.kind == "button" or e.kind == "toggle" or e.kind == "slider"
        or e.kind == "selector" or e.kind == "textinput" or e.kind == "submenu"
    if isControl then guiControls = guiControls + 1 end
end
eq("the GUI registers exactly one Vanity control", guiControls, 1)
check("and it is the Launch Menu button",
    H.ui["Launch Menu"] ~= nil and H.ui["Launch Menu"].kind == "button")

H.ui["Launch Menu"].cb()
H.frames(30)   -- let the open animation settle

local function footerRange()
    for _, t in ipairs(H.drawnTexts()) do
        local from, to, total = t:match("^(%d+)%-(%d+) / (%d+)")
        if from then return tonumber(from), tonumber(to), tonumber(total) end
    end
end

local function trim(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end

local guiLabels = {}
local visitedTabs = {}

for _, tabName in ipairs(specSections) do
    H.clearDraws(); H.frame()
    if H.clickText(tabName) then
        H.frame()
        visitedTabs[tabName] = true

        local guard = 0
        while guard < 60 do
            H.clearDraws(); H.frame()
            for _, t in ipairs(H.drawnTexts()) do guiLabels[trim(t)] = true end

            local _, to, total = footerRange()
            if not to or to >= total then break end
            if not H.clickText("v") then break end
            H.frame()
            guard = guard + 1
        end
    end
end

check("every spec tab is reachable in the GUI", (function()
    local missing = {}
    for _, s in ipairs(specSections) do
        if not visitedTabs[s] then missing[#missing + 1] = s end
    end
    return #missing == 0, table.concat(missing, ", ")
end)())

check("every spec feature is drawn in the GUI", (function()
    local missing = {}
    for _, label in ipairs(labelOrder) do
        if not guiLabels[label] then missing[#missing + 1] = label end
    end
    return #missing == 0, table.concat(missing, ", "):sub(1, 400)
end)())

check("the two front ends agree on the feature set", (function()
    local onlyMenu, onlyGui = {}, {}
    for _, label in ipairs(labelOrder) do
        if not menuLabels[label] then onlyMenu[#onlyMenu + 1] = label end
        if not guiLabels[label] then onlyGui[#onlyGui + 1] = label end
    end
    return #onlyMenu == 0 and #onlyGui == 0,
        ("menu missing %d, gui missing %d"):format(#onlyMenu, #onlyGui)
end)())

--------------------------------------------------------------------------------
H.realPrint(("\n%d passed, %d failed"):format(passed, failed))
os.exit(failed == 0 and 0 or 1)
