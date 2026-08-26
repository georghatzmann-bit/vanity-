--[[
    Luchs GUI v1.0  —  anti-cheat test bench, drawn front end
    =========================================================

    The same bench as luchs-script.lua, behind a drawn window instead of the
    Vanity menu. The Vanity menu holds exactly one button: "Launch Menu".

    Paste this whole file into Vanity and hit Execute. No other files needed.

    ---------------------------------------------------------------------------
    WHAT IS IN HERE

    Scenario runner   Ladders of increasing magnitude — teleport distance,
                      vertical jumps, hop rate, sprint multiplier, health and
                      armour writes. The first step your detector did not flag
                      is where its threshold sits.

    Monitors          Baseline a server-side inventory (resources, state bags,
                      events), do something, diff it. What the server changed in
                      response shows up as added, changed or removed.

    Calibration       Percentiles over what normal play actually does, and a
                      suggested threshold read off the tail rather than guessed.

    Telemetry         The same numbers as JSON, POSTed to your own collector,
                      plus a one-document export bundle of the whole session.

    ---------------------------------------------------------------------------
    THIS FILE AND ITS SIBLING

    Everything between SHARED ENGINE BEGIN and SHARED ENGINE END is byte-for-byte
    the same as in luchs-script.lua, including the SPEC table that defines every
    feature. Only the front end at the bottom differs. test/parity_test.lua fails
    if the two ever drift apart.

    ---------------------------------------------------------------------------
    NOT INCLUDED

    The spoofing/bypass family (spoofTeleport, speedSpoof, pedSpoof,
    spoofAllVisible, camBypass, lockEventLogger) and the aimbot. Those exist to
    defeat detection or to target other players, which is the opposite of what
    this bench is for. A test asserts no call site for them exists.

    Ham.getAntiCheats is read and reported — presence, count, names — and
    nothing in this file branches on the answer.

    Requires: Vanity (UI) + Ham (drawing, input, HTTP, inspection).
]]

--------------------------------------------------------------------------------
-- Render loop generation guard
--------------------------------------------------------------------------------
-- Vanity clears the UI on every Execute but leaves old CreateThread loops
-- running. Bumping a global counter retires them on their next frame — and the
-- retiring loop hands the mouse back on its way out, see onRetire below.

_G.__LUCHS_GUI_GENERATION = (_G.__LUCHS_GUI_GENERATION or 0) + 1
local generation = _G.__LUCHS_GUI_GENERATION

local function isCurrent()
    return _G.__LUCHS_GUI_GENERATION == generation
end

local SCRIPT_NAME    = "Luchs GUI v1.0"
local INTERFACE_NAME = "drawn-gui"

--------------------------------------------------------------------------------
-- >>> SHARED ENGINE BEGIN <<<
--------------------------------------------------------------------------------
-- Everything between this marker and SHARED ENGINE END is byte-identical in
-- luchs-script.lua and luchs-gui.lua. The two scripts are standalone single
-- files by design — nothing may be require()d into a Vanity sandbox — so the
-- engine is carried in both. test/parity_test.lua compares the two regions and
-- fails on any drift, which is what keeps "same features, different surface"
-- true rather than aspirational.
--------------------------------------------------------------------------------
-- Ham access
--------------------------------------------------------------------------------
-- Ham exposes every function in both camelCase and lowercase. Resolving through
-- one helper covers both and degrades to a log line if a build lacks a function
-- rather than erroring out mid-callback.

local HAM = _G.Ham or _G.ham or {}

local log  -- forward declaration; defined with the action log below

local function hamFn(name)
    return HAM[name] or HAM[name:lower()]
end

local function ham(name, ...)
    local fn = hamFn(name)
    if not fn then
        log("Ham." .. name .. " unavailable")
        return nil
    end
    return fn(...)
end
--------------------------------------------------------------------------------
-- Configuration
--------------------------------------------------------------------------------

local cfg = {
    -- overlay
    overlay        = true,
    corner         = "Top Right",
    fontSize       = 14,
    showStatus     = true,
    showMovement   = true,
    showScenario   = true,
    showMonitors   = true,
    showCalibration = true,
    showLog        = true,
    showInput      = false,
    showShapes     = false,
    showMarker     = false,

    shape          = "Rect Outline",
    shapeR         = 120,
    shapeG         = 200,
    shapeB         = 255,
    thickness      = 2,

    -- movement analysis
    jumpThreshold  = 5.0,

    -- teleport
    telMethod      = "Native (SetEntityCoords)",
    telOffset      = 0,

    -- scenario runner
    scenario       = "Teleport Ladder",
    stepDelay      = 3000,   -- ms between ladder steps
    repeats        = 1,

    -- telemetry
    endpoint       = "",
    autoPost       = false,
    postInterval   = 5,

    -- monitors
    monitorSource  = "Resources",
    autoDiff       = false,
    diffInterval   = 10,

    -- calibration
    calibrationMetric = "Frame Delta",
    collectSamples    = false,
    calibrationMargin = 50,

    -- self
    noClipSpeed    = 3,
    freeCamSpeed   = 3,
    runSpeed       = 1,
    swimSpeed      = 1,
    setHealth      = 200,
    setArmour      = 0,

    -- world
    -- Both default to what the Time of Day selector's first choice means, so
    -- the two controls never open disagreeing with each other.
    timeOfDay      = "Morning",
    hour           = 7,
    weather        = "CLEAR",

    -- fonts
    font           = "Default",

    -- misc
    dumpLimit      = 25,
    vehicleModel   = "adder",
    weaponName     = "WEAPON_PISTOL",
    httpUrl        = "",
    httpBody       = "",
    execResource   = "isolated",
    resourceQuery  = "",
}

local toggles = {
    godMode = false, invisible = false, noClip = false, freeCam = false,
    spectator = false, antiTeleport = false, antiBlock = false,
    superJump = false, noRagdoll = false, infiniteAmmo = false,
    disableWeather = false, blockInput = false, showCursor = false,
}

local COLORS = {
    panel   = { 12, 14, 18 },
    accent  = { 120, 200, 255, 255 },
    label   = { 150, 158, 170, 255 },
    value   = { 235, 238, 242, 255 },
    on      = { 120, 230, 150, 255 },
    off     = { 110, 116, 126, 255 },
    warn    = { 255, 190, 70, 255 },
    alert   = { 255, 95, 95, 255 },
    outline = { 0, 0, 0, 220 },
}
--------------------------------------------------------------------------------
-- Movement / telemetry state
--------------------------------------------------------------------------------

local state = {
    coords = { x = 0.0, y = 0.0, z = 0.0 },
    heading = 0.0, speed = 0.0, health = 0, armour = 0,
    pedModel = 0, inVehicle = false, vehModel = 0, vehSpeed = 0.0,
    delta = 0.0, verticalDelta = 0.0, impliedSpeed = 0.0,
    maxDelta = 0.0, maxImplied = 0.0,
    jumps = 0, lastJump = 0.0, frameMs = 0.0,
}

local prevCoords, prevTime = nil, nil
local marker, savedMarker = nil, nil
local slots = {}
local lastDump, lastResponse = "", ""
local httpStatus = "idle"
local pendingRequest = nil
local spawnedVehicle = nil
local postState = { lastAttempt = 0, requestId = nil, status = "idle" }
--------------------------------------------------------------------------------
-- Action log
--------------------------------------------------------------------------------

local logEntries = {}
local LOG_MAX = 14

log = function(text)
    local stamp = GetGameTimer()
    logEntries[#logEntries + 1] = { t = stamp, text = text }
    while #logEntries > LOG_MAX do table.remove(logEntries, 1) end
    print(("[Luchs %8.2fs] %s"):format(stamp / 1000.0, text))
end

local function clearLog()
    logEntries = {}
    log("Log cleared")
end

local function act(text, notifyType)
    log(text)
    if Vanity and Vanity.notify then
        Vanity.notify(text, notifyType or "info", 2000)
    end
end
--------------------------------------------------------------------------------
-- Helpers
--------------------------------------------------------------------------------

local function ped() return PlayerPedId() end

local function coords()
    local c = GetEntityCoords(ped())
    return c.x, c.y, c.z
end

local function currentVehicle()
    local v = GetVehiclePedIsIn(ped(), false)
    if v == 0 then return nil end
    return v
end

local function requireVehicle(what)
    local v = currentVehicle()
    if not v then
        act("Not in a vehicle — " .. what .. " skipped", "error")
        return nil
    end
    return v
end

local function onOff(b) return b and "on" or "off" end

local function dist3(a, b)
    local dx, dy, dz = a.x - b.x, a.y - b.y, a.z - b.z
    return math.sqrt(dx * dx + dy * dy + dz * dz)
end

local function truncate(s, n)
    s = tostring(s)
    if #s <= n then return s end
    return s:sub(1, n - 3) .. "..."
end

-- Best effort: the ground is only known for streamed-in areas, so fall back to
-- the requested Z rather than dropping the player through the map.
local function groundAt(x, y, z)
    local ok, found, gz = pcall(GetGroundZFor_3dCoord, x, y, z + 50.0, false)
    if ok and found and gz and gz > 0.0 then return gz + 1.0 end
    return z
end

local function loadModel(hash)
    RequestModel(hash)
    local waited = 0
    while not HasModelLoaded(hash) and waited < 5000 do
        Wait(10)
        waited = waited + 10
    end
    return HasModelLoaded(hash)
end

local function moveTo(x, y, z, method)
    if (method or cfg.telMethod) == "Ham (setPosition)" then
        ham("setPosition", x + 0.0, y + 0.0, z + 0.0)
    else
        SetEntityCoords(ped(), x + 0.0, y + 0.0, z + 0.0, false, false, false, true)
    end
end

local function teleport(x, y, z, label)
    z = z + cfg.telOffset
    moveTo(x, y, z)
    act(("Teleport [%s] -> %.1f %.1f %.1f%s"):format(
        cfg.telMethod == "Ham (setPosition)" and "ham" or "native",
        x, y, z, label and ("  (" .. label .. ")") or ""))
end

--------------------------------------------------------------------------------
-- Anti-cheat detection
--------------------------------------------------------------------------------
-- Ham reports which anti-cheats it recognises on the server. This is read and
-- reported, nothing more: no branch anywhere in this file looks at the result.
-- Knowing the name of what you are calibrating against is half of what a run
-- report is worth — "the ladder reached 25 m unflagged" only means something
-- next to the name of the thing that was supposed to flag it.
--
-- Builds disagree on the return shape. Some hand back an array of names, some
-- a map keyed by name (with `true`, or a details table, as the value). Both are
-- normalised to one sorted array of names here so nothing downstream has to
-- care which build it is talking to.

local antiCheat = { list = {}, checkedAt = nil, supported = true, shape = "none" }

local function normaliseAntiCheats(value)
    local names = {}
    if type(value) ~= "table" then return names, "none" end

    local total = 0
    for _ in pairs(value) do total = total + 1 end
    if total == 0 then return names, "empty" end

    if #value == total then
        -- Array form: { "FiveGuard", "ElectronAC" }
        for _, name in ipairs(value) do names[#names + 1] = tostring(name) end
        table.sort(names)
        return names, "array"
    end

    -- Map form: { FiveGuard = true, ElectronAC = { version = 3 } }. A key
    -- explicitly mapped to false means "looked for, not found" — skip it.
    for key, present in pairs(value) do
        if type(key) == "string" then
            if present ~= false then names[#names + 1] = key end
        else
            names[#names + 1] = tostring(present)
        end
    end
    table.sort(names)
    return names, "map"
end

local function antiCheatText()
    if not antiCheat.supported then return "detection unsupported" end
    if not antiCheat.checkedAt then return "not checked" end
    if #antiCheat.list == 0 then return "none detected" end
    return table.concat(antiCheat.list, ", ")
end

local function detectAntiCheats(manual)
    local fn = hamFn("getAntiCheats")
    if not fn then
        antiCheat.supported, antiCheat.list, antiCheat.shape = false, {}, "none"
        if manual then act("Ham.getAntiCheats is missing on this build", "error") end
        return antiCheat.list
    end

    -- pcall is safe here: getAntiCheats does not yield, so nothing tries to
    -- resume across the protected-call boundary.
    local ok, found = pcall(fn)
    antiCheat.supported = true
    antiCheat.checkedAt = GetGameTimer()

    if not ok then
        antiCheat.list, antiCheat.shape = {}, "error"
        if manual then act("Anti-cheat detection errored: " .. tostring(found), "error") end
        return antiCheat.list
    end

    antiCheat.list, antiCheat.shape = normaliseAntiCheats(found)

    if manual then
        if #antiCheat.list == 0 then
            act("No anti-cheat detected", "info")
        else
            act(("Anti-cheat: %s"):format(table.concat(antiCheat.list, ", ")), "success")
        end
    end
    return antiCheat.list
end

local function antiCheatReport()
    local out = {}
    out[#out + 1] = "Anti-cheat detection"
    out[#out + 1] = ("  present  : %s"):format(#antiCheat.list > 0 and "yes" or "no")
    out[#out + 1] = ("  count    : %d"):format(#antiCheat.list)
    out[#out + 1] = ("  names    : %s"):format(antiCheatText())
    out[#out + 1] = ("  shape    : %s"):format(antiCheat.shape)
    if antiCheat.checkedAt then
        out[#out + 1] = ("  checked  : %.2fs"):format(antiCheat.checkedAt / 1000.0)
    else
        out[#out + 1] = "  checked  : never"
    end
    return table.concat(out, "\n")
end

--------------------------------------------------------------------------------
-- Monitors
--------------------------------------------------------------------------------
-- A monitor watches one server-visible inventory and reports what moved. Take a
-- baseline, do something, diff: whatever the server changed in response shows up
-- as added, changed or removed. That is the other half of the bench — the
-- scenario runner drives client behaviour, a monitor shows the server reacting
-- to it, and the two timestamps line up in the same action log.
--
-- Every diff rebases the baseline onto the snapshot it just took, so a diff
-- always answers "what changed since the last look" rather than accumulating
-- against an ever older starting point.

-- State bags come from the server, so the shape is not ours to trust: a deep
-- or self-referencing table would otherwise hang the render loop. Six levels is
-- far past anything a bag legitimately nests.
local FLATTEN_MAX_DEPTH = 6

local function flatten(map, prefix, into, depth)
    depth = depth or 0
    if depth > FLATTEN_MAX_DEPTH then
        into[(prefix or "?") .. "/..."] = "(nested too deeply to read)"
        return into
    end
    for key, value in pairs(map or {}) do
        local name = prefix and (prefix .. "/" .. tostring(key)) or tostring(key)
        if type(value) == "table" then
            flatten(value, name, into, depth + 1)
        else
            into[name] = tostring(value)
        end
    end
    return into
end

local function listToSet(list, mark)
    local set = {}
    if type(list) ~= "table" then return set end
    for _, name in ipairs(list) do set[tostring(name)] = mark end
    return set
end

local MONITOR_SOURCES = {
    { name = "Resources",
      note = "Resources the server has running",
      collect = function() return listToSet(ham("getResources"), "present") end },
    { name = "State Bags",
      note = "Every state bag and its value — the one source where values change",
      collect = function() return flatten(ham("getAllStateBags"), nil, {}) end },
    { name = "Triggered Events",
      note = "Events seen firing, per resource",
      collect = function() return flatten(ham("getAllEvents"), nil, {}) end },
    { name = "Registered Events",
      note = "Event handlers registered, per resource",
      collect = function() return flatten(ham("getAllRegisteredEvents"), nil, {}) end },
    { name = "Ped Models",
      note = "Ped models the client knows about",
      collect = function() return listToSet(ham("getPedModelNames"), "present") end },
    { name = "Anti-Cheats",
      note = "Anti-cheats Ham recognises — watch one appear or disappear mid-session",
      collect = function() return listToSet(detectAntiCheats(false), "present") end },
}

local function monitorSourceByName(name)
    for _, s in ipairs(MONITOR_SOURCES) do
        if s.name == name then return s end
    end
    return MONITOR_SOURCES[1]
end

local function monitorSourceNames()
    local names = {}
    for _, s in ipairs(MONITOR_SOURCES) do names[#names + 1] = s.name end
    return names
end

local monitor = {
    baseline = nil, baselineAt = nil,
    added = {}, changed = {}, removed = {},
    lastAt = nil, runs = 0, lastSource = nil,
}

-- Sorted so a report reads the same way twice; pairs() order is not stable.
local function diffMaps(old, new)
    local added, changed, removed = {}, {}, {}

    for key, value in pairs(new) do
        local before = old[key]
        if before == nil then
            added[#added + 1] = { key = key, value = value }
        elseif before ~= value then
            changed[#changed + 1] = { key = key, from = before, to = value }
        end
    end

    for key, value in pairs(old) do
        if new[key] == nil then
            removed[#removed + 1] = { key = key, value = value }
        end
    end

    local function byKey(a, b) return a.key < b.key end
    table.sort(added, byKey)
    table.sort(changed, byKey)
    table.sort(removed, byKey)
    return added, changed, removed
end

local function monitorChangeCount()
    return #monitor.added + #monitor.changed + #monitor.removed
end

local function takeBaseline(manual)
    local source = monitorSourceByName(cfg.monitorSource)
    monitor.baseline = source.collect()
    monitor.baselineAt = GetGameTimer()
    monitor.lastSource = source.name
    monitor.added, monitor.changed, monitor.removed = {}, {}, {}

    local n = 0
    for _ in pairs(monitor.baseline) do n = n + 1 end
    if manual then
        act(("Baseline taken: %s, %d entries"):format(source.name, n), "success")
    else
        log(("Baseline taken: %s, %d entries"):format(source.name, n))
    end
    return n
end

local function diffNow(manual)
    local source = monitorSourceByName(cfg.monitorSource)

    if not monitor.baseline or monitor.lastSource ~= source.name then
        takeBaseline(false)
        if manual then
            act(("No baseline for %s yet — taken now"):format(source.name), "info")
        end
        return 0
    end

    local current = source.collect()
    monitor.added, monitor.changed, monitor.removed = diffMaps(monitor.baseline, current)
    monitor.baseline = current
    monitor.baselineAt = GetGameTimer()
    monitor.lastAt = monitor.baselineAt
    monitor.runs = monitor.runs + 1

    local total = monitorChangeCount()
    local summary = ("%s: %d changes (+%d ~%d -%d)"):format(
        source.name, total, #monitor.added, #monitor.changed, #monitor.removed)

    if total > 0 then
        act(summary, "success")
    elseif manual then
        act(source.name .. ": no change", "info")
    end
    return total
end

local function clearBaseline()
    monitor.baseline, monitor.baselineAt, monitor.lastSource = nil, nil, nil
    monitor.added, monitor.changed, monitor.removed = {}, {}, {}
    monitor.runs = 0
    act("Baseline cleared")
end

local function monitorReport()
    local out = {}
    out[#out + 1] = ("Monitor diff — %s"):format(monitor.lastSource or cfg.monitorSource)
    if not monitor.baseline then
        out[#out + 1] = "  no baseline taken yet"
        return table.concat(out, "\n")
    end

    out[#out + 1] = ("  baseline %.2fs, %d diffs run"):format(
        (monitor.baselineAt or 0) / 1000.0, monitor.runs)

    if monitorChangeCount() == 0 then
        out[#out + 1] = "  no change since the last look"
        return table.concat(out, "\n")
    end

    for _, e in ipairs(monitor.added) do
        out[#out + 1] = ("  + added     %s = %s"):format(e.key, truncate(e.value, 60))
    end
    for _, e in ipairs(monitor.changed) do
        out[#out + 1] = ("  ~ changed   %s: %s -> %s")
            :format(e.key, truncate(e.from, 30), truncate(e.to, 30))
    end
    for _, e in ipairs(monitor.removed) do
        out[#out + 1] = ("  - removed   %s = %s"):format(e.key, truncate(e.value, 60))
    end

    out[#out + 1] = ("  %d changes (%d added, %d changed, %d removed)"):format(
        monitorChangeCount(), #monitor.added, #monitor.changed, #monitor.removed)
    return table.concat(out, "\n")
end

local function pollMonitors()
    if not cfg.autoDiff then return end
    local now = GetGameTimer()
    if monitor.lastAuto and (now - monitor.lastAuto) < cfg.diffInterval * 1000 then return end
    monitor.lastAuto = now
    diffNow(false)
end

--------------------------------------------------------------------------------
-- Calibration
--------------------------------------------------------------------------------
-- A detector needs a number, and picking one out of the air is how you end up
-- banning people for lag. Calibration takes the other route: record what the
-- quantity actually does during normal play, then read a threshold off the
-- distribution. The percentiles are the useful part — the maximum is one bad
-- frame, p99 is the shape of the tail you have to live above.
--
-- The suggested threshold is p99 plus a headroom margin. It is a starting
-- point, not an answer: raise the margin until your own honest play stops
-- tripping it, then run a ladder and see how much room is left before a real
-- teleport slips underneath.

local SAMPLE_MAX = 4096

-- The jump-threshold slider's range, shared with the code that writes a
-- calibrated value into it so the two cannot disagree.
local JUMP_MIN, JUMP_MAX = 1, 200

local CALIBRATION_METRICS = {
    { name = "Frame Delta", unit = "m", applies = true,
      note = "Distance covered in one frame — what a teleport check reads",
      value = function() return state.delta end },
    { name = "Implied Speed", unit = "m/s", applies = false,
      note = "Frame delta divided by frame time, independent of the reported speed",
      value = function() return state.impliedSpeed end },
    { name = "Vertical Delta", unit = "m", applies = true,
      note = "Height gained or lost in one frame, usually checked on its own",
      value = function() return state.verticalDelta end },
    { name = "Reported Speed", unit = "m/s", applies = false,
      note = "The speed the game itself reports for the ped",
      value = function() return state.speed end },
}

local function calibrationMetricByName(name)
    for _, m in ipairs(CALIBRATION_METRICS) do
        if m.name == name then return m end
    end
    return CALIBRATION_METRICS[1]
end

local function calibrationMetricNames()
    local names = {}
    for _, m in ipairs(CALIBRATION_METRICS) do names[#names + 1] = m.name end
    return names
end

local calibration = { samples = {}, startedAt = nil, dropped = 0, write = 0, metric = nil }

local function clearSamples()
    calibration.samples = {}
    calibration.startedAt = nil
    calibration.dropped, calibration.write = 0, 0
    calibration.metric = nil
end

local function pushSample(value)
    local s = calibration.samples
    if #s < SAMPLE_MAX then
        s[#s + 1] = value
    else
        -- Ring buffer: a long session should calibrate on the recent past, not
        -- run out of memory recording all of it.
        calibration.write = (calibration.write % SAMPLE_MAX) + 1
        s[calibration.write] = value
        calibration.dropped = calibration.dropped + 1
    end
end

local function collectSample()
    if not cfg.collectSamples then return end
    local metric = calibrationMetricByName(cfg.calibrationMetric)
    if calibration.metric and calibration.metric ~= metric.name then
        -- Mixing two quantities into one distribution would be meaningless.
        clearSamples()
    end
    calibration.metric = metric.name
    calibration.startedAt = calibration.startedAt or GetGameTimer()
    pushSample(metric.value() or 0.0)
end

-- Nearest-rank: with 100 samples p50 is the 50th, p99 the 99th. No interpolation,
-- so every number in the report is a value that was actually measured.
local function percentile(sorted, p)
    if #sorted == 0 then return 0.0 end
    local rank = math.ceil((p / 100.0) * #sorted)
    if rank < 1 then rank = 1 end
    if rank > #sorted then rank = #sorted end
    return sorted[rank]
end

local function calibrationStats()
    local sorted = {}
    for i, v in ipairs(calibration.samples) do sorted[i] = v end
    table.sort(sorted)

    local metric = calibrationMetricByName(calibration.metric or cfg.calibrationMetric)
    local p99 = percentile(sorted, 99)
    local elapsed = calibration.startedAt
        and (GetGameTimer() - calibration.startedAt) / 1000.0 or 0.0

    return {
        metric      = metric.name,
        unit        = metric.unit,
        applies     = metric.applies,
        count       = #sorted,
        dropped     = calibration.dropped,
        elapsed     = elapsed,
        min         = percentile(sorted, 0),
        p50         = percentile(sorted, 50),
        p90         = percentile(sorted, 90),
        p95         = percentile(sorted, 95),
        p99         = p99,
        max         = #sorted > 0 and sorted[#sorted] or 0.0,
        margin      = cfg.calibrationMargin,
        suggested   = p99 * (1.0 + cfg.calibrationMargin / 100.0),
    }
end

local function calibrationReport()
    local s = calibrationStats()
    if s.count == 0 then
        return "No samples yet — turn on Collect Samples and play normally for a while."
    end

    local out = {}
    out[#out + 1] = ("Calibration — %s (%s)"):format(s.metric, s.unit)
    out[#out + 1] = ("  %d samples over %.2fs%s"):format(
        s.count, s.elapsed, s.dropped > 0 and (", %d dropped"):format(s.dropped) or "")
    out[#out + 1] = ("  min   %10.3f"):format(s.min)
    out[#out + 1] = ("  p50   %10.3f"):format(s.p50)
    out[#out + 1] = ("  p90   %10.3f"):format(s.p90)
    out[#out + 1] = ("  p95   %10.3f"):format(s.p95)
    out[#out + 1] = ("  p99   %10.3f"):format(s.p99)
    out[#out + 1] = ("  max   %10.3f"):format(s.max)
    out[#out + 1] = ("  suggested threshold  %.2f %s   (p99 + %d %% headroom)")
        :format(s.suggested, s.unit, s.margin)
    out[#out + 1] = "  Raise the margin until honest play stops tripping it, then run a"
    out[#out + 1] = "  ladder to see how much room that leaves a real teleport."
    return table.concat(out, "\n")
end
--------------------------------------------------------------------------------
-- Sampling
--------------------------------------------------------------------------------

local function sample()
    local p = ped()
    if not p or p == 0 then return end

    local now = GetGameTimer()
    local c = GetEntityCoords(p)
    local cur = { x = c.x, y = c.y, z = c.z }

    state.coords   = cur
    state.heading  = GetEntityHeading(p)
    state.speed    = GetEntitySpeed(p)
    state.health   = GetEntityHealth(p)
    state.armour   = GetPedArmour(p)
    state.pedModel = GetEntityModel(p)

    local veh = GetVehiclePedIsIn(p, false)
    state.inVehicle = veh ~= 0
    if state.inVehicle then
        state.vehModel = GetEntityModel(veh)
        state.vehSpeed = GetEntitySpeed(veh)
    else
        state.vehModel, state.vehSpeed = 0, 0.0
    end

    if prevCoords and prevTime then
        local dt = (now - prevTime) / 1000.0
        state.frameMs = now - prevTime
        local d = dist3(cur, prevCoords)
        state.delta = d
        state.impliedSpeed = dt > 0 and (d / dt) or 0.0
        if d > state.maxDelta then state.maxDelta = d end
        -- Peak within the current scenario step; the runner resets it per step.
        if d > (state.stepPeak or 0.0) then state.stepPeak = d end
        if state.impliedSpeed > state.maxImplied then
            state.maxImplied = state.impliedSpeed
        end
        state.verticalDelta = math.abs(cur.z - prevCoords.z)
        if d >= cfg.jumpThreshold then
            state.jumps = state.jumps + 1
            state.lastJump = d
        end
        collectSample()
    end

    prevCoords, prevTime = cur, now
end

local function resetCounters()
    state.maxDelta, state.maxImplied = 0.0, 0.0
    state.jumps, state.lastJump = 0, 0.0
    state.verticalDelta = 0.0
end
--------------------------------------------------------------------------------
-- JSON
--------------------------------------------------------------------------------

local function jsonEscape(s)
    s = tostring(s)
    s = s:gsub('[\\"]', '\\%0')
    s = s:gsub('\n', '\\n'):gsub('\r', '\\r'):gsub('\t', '\\t')
    -- Anything else under 0x20 has no shorthand and would make the document
    -- invalid; a state bag value is server-controlled, so it can contain one.
    s = s:gsub('%c', function(c) return ('\\u%04x'):format(c:byte()) end)
    return s
end

local function jStr(k, v) return ('"%s":"%s"'):format(k, jsonEscape(v)) end
-- %.4f keeps coordinates precise without scientific notation, which many
-- parsers on the receiving end handle badly.
local function jNum(k, v) return ('"%s":%.4f'):format(k, (v or 0) + 0.0) end
local function jInt(k, v) return ('"%s":%d'):format(k, math.floor((v or 0) + 0.5)) end
local function jBool(k, v) return ('"%s":%s'):format(k, v and "true" or "false") end
-- For values that are already JSON: a nested object or array built elsewhere.
local function jRaw(k, raw) return ('"%s":%s'):format(k, raw) end

local function jsonStringArray(list)
    local out = {}
    for i, v in ipairs(list or {}) do out[i] = ('"%s"'):format(jsonEscape(v)) end
    return "[" .. table.concat(out, ",") .. "]"
end

local function buildSnapshot(extra)
    local parts = {
        jStr("user", tostring(ham("getName") or "unknown")),
        jStr("endpoint", tostring(ham("getServerEndpoint") or "")),
        jInt("serverId", GetPlayerServerId(PlayerId())),
        jInt("gameTime", GetGameTimer()),
        jNum("x", state.coords.x), jNum("y", state.coords.y), jNum("z", state.coords.z),
        jNum("heading", state.heading),
        jNum("speed", state.speed),
        jNum("delta", state.delta),
        jNum("impliedSpeed", state.impliedSpeed),
        jNum("maxDelta", state.maxDelta),
        jNum("maxImplied", state.maxImplied),
        jInt("jumps", state.jumps),
        jInt("health", state.health),
        jInt("armour", state.armour),
        jInt("pedModel", state.pedModel),
        jBool("inVehicle", state.inVehicle),
        jInt("vehModel", state.vehModel),
        jNum("vehSpeed", state.vehSpeed),
        jNum("verticalDelta", state.verticalDelta),
        jBool("antiCheatPresent", #antiCheat.list > 0),
        jInt("antiCheatCount", #antiCheat.list),
        jRaw("antiCheatNames", jsonStringArray(antiCheat.list)),
    }
    for _, e in ipairs(extra or {}) do parts[#parts + 1] = e end
    return "{" .. table.concat(parts, ",") .. "}"
end
--------------------------------------------------------------------------------
-- Telemetry POST
--------------------------------------------------------------------------------

local function postSnapshot(manual, extra)
    if cfg.endpoint == "" then
        postState.status = "no endpoint"
        if manual then act("Set a telemetry endpoint first", "error") end
        return
    end
    if postState.requestId then
        postState.status = "busy"
        return
    end
    postState.requestId = ham("httpPostAsync", cfg.endpoint, buildSnapshot(extra),
        { ["Content-Type"] = "application/json" })
    postState.lastAttempt = GetGameTimer()
    postState.status = "sending"
end

local function pollTelemetry()
    if not postState.requestId then return end
    local result = ham("getAsyncResult", postState.requestId)
    if type(result) ~= "table" or not result.ready then return end
    postState.status = result.success
        and ("ok %d"):format(result.status or 0)
        or ("error: " .. tostring(result.error or "unknown"))
    postState.requestId = nil
    ham("cleanupAsyncRequests")
end
--------------------------------------------------------------------------------
-- HTTP (manual requests)
--------------------------------------------------------------------------------

local function showResponse(kind, result)
    if type(result) ~= "table" then
        httpStatus = "no result"
        act(kind .. ": no result table", "error")
        return
    end
    if result.success then
        lastResponse = tostring(result.data or "")
        httpStatus = ("ok %d (%d bytes)"):format(result.status or 0, #lastResponse)
        act(("%s -> %d, %d bytes"):format(kind, result.status or 0, #lastResponse), "success")
        print("---- response ----")
        print(truncate(lastResponse, 2000))
    else
        httpStatus = "error: " .. tostring(result.error or "unknown")
        act(("%s failed: %s"):format(kind, tostring(result.error or "unknown")), "error")
    end
end

local function httpSync(method)
    if cfg.httpUrl == "" then act("Set a URL first", "error") return end
    local headers = { ["Content-Type"] = "application/json" }
    local result = (method == "GET")
        and ham("httpGet", cfg.httpUrl, headers)
        or ham("httpPost", cfg.httpUrl, cfg.httpBody, headers)
    showResponse("HTTP " .. method, result)
end

local function httpAsync(method)
    if cfg.httpUrl == "" then act("Set a URL first", "error") return end
    if pendingRequest then act("A request is already in flight", "error") return end
    local headers = { ["Content-Type"] = "application/json" }
    pendingRequest = (method == "GET")
        and ham("httpGetAsync", cfg.httpUrl, headers)
        or ham("httpPostAsync", cfg.httpUrl, cfg.httpBody, headers)
    if pendingRequest then
        httpStatus = "sending (async " .. method .. ")"
        log("HTTP async " .. method .. " -> " .. cfg.httpUrl)
    end
end

local function pollHttp()
    if not pendingRequest then return end
    local result = ham("getAsyncResult", pendingRequest)
    if type(result) ~= "table" or not result.ready then return end
    showResponse("HTTP async", result)
    pendingRequest = nil
    ham("cleanupAsyncRequests")
end
--------------------------------------------------------------------------------
-- Scenario runner
--------------------------------------------------------------------------------
-- Each scenario is a ladder of increasing magnitude. The runner plays one step
-- at a time, waits, records what the client actually did, then returns to the
-- starting state. Line the report up against your server log: the first step
-- your detector did not flag is where its threshold sits.

local SCENARIOS = {
    {
        name = "Teleport Ladder", unit = "m",
        steps = { 1, 2, 5, 10, 25, 50, 100, 250, 500 },
        note = "Horizontal jumps of growing distance, returning to origin between steps",
        apply = function(m, ox, oy, oz) moveTo(ox + m, oy, oz) end,
        back  = function(ox, oy, oz) moveTo(ox, oy, oz) end,
    },
    {
        name = "Teleport Ladder (fine)", unit = "m",
        steps = { 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10 },
        note = "Fine steps through the range most distance checks sit in",
        apply = function(m, ox, oy, oz) moveTo(ox + m, oy, oz) end,
        back  = function(ox, oy, oz) moveTo(ox, oy, oz) end,
    },
    {
        name = "Vertical Ladder", unit = "m",
        steps = { 1, 5, 10, 25, 50, 100, 250 },
        note = "Upward jumps — vertical movement is often checked separately",
        apply = function(m, ox, oy, oz) moveTo(ox, oy, oz + m) end,
        back  = function(ox, oy, oz) moveTo(ox, oy, oz) end,
    },
    {
        name = "Rapid Reposition", unit = "hops",
        steps = { 2, 4, 8, 16, 32 },
        note = "Many small 2 m hops in one step — exercises rate checks, not distance checks",
        apply = function(m, ox, oy, oz)
            for i = 1, m do
                moveTo(ox + ((i % 2 == 0) and 2 or 0), oy, oz)
                Wait(50)
            end
        end,
        back  = function(ox, oy, oz) moveTo(ox, oy, oz) end,
    },
    {
        name = "Speed Ramp", unit = "x",
        steps = { 1, 2, 3, 4, 5, 6, 8, 10 },
        note = "Sprint multiplier ramp — run forward while this one plays",
        apply = function(m) SetRunSprintMultiplierForPlayer(PlayerId(), m * 1.0) end,
        back  = function() SetRunSprintMultiplierForPlayer(PlayerId(), 1.0) end,
    },
    {
        name = "Health Jumps", unit = "hp",
        steps = { 10, 25, 50, 100, 150, 200 },
        note = "Instant heal of growing size from a wounded state",
        apply = function(m)
            SetEntityHealth(PlayerPedId(), 100)
            Wait(200)
            SetEntityHealth(PlayerPedId(), math.min(100 + m, 200))
        end,
        back  = function() SetEntityHealth(PlayerPedId(), 200) end,
    },
    {
        name = "Armour Jumps", unit = "ap",
        steps = { 10, 25, 50, 75, 100 },
        note = "Armour written directly, from zero each time",
        apply = function(m)
            SetPedArmour(PlayerPedId(), 0)
            Wait(200)
            SetPedArmour(PlayerPedId(), m)
        end,
        back  = function() SetPedArmour(PlayerPedId(), 0) end,
    },
}

local function scenarioByName(name)
    for _, s in ipairs(SCENARIOS) do
        if s.name == name then return s end
    end
    return SCENARIOS[1]
end

local function scenarioNames()
    local names = {}
    for _, s in ipairs(SCENARIOS) do names[#names + 1] = s.name end
    return names
end

local runner = {
    active = false, name = "", unit = "", note = "",
    step = 0, total = 0, pass = 0, passes = 1, current = 0,
    lastText = "idle", results = {}, startedAt = 0,
}

local function runnerReport()
    if #runner.results == 0 then
        return "No scenario has been run yet."
    end
    local out = {}
    out[#out + 1] = ("Scenario: %s"):format(runner.name)
    out[#out + 1] = ("  %s"):format(runner.note)
    -- A ladder that went unflagged only means something next to the name of the
    -- thing that was supposed to flag it.
    out[#out + 1] = ("  anti-cheat: %s"):format(antiCheatText())
    out[#out + 1] = ("  %d results, started at %.2fs")
        :format(#runner.results, runner.startedAt / 1000.0)
    out[#out + 1] = "    #  pass   magnitude    measured   peak/frame     implied         t"
    for _, r in ipairs(runner.results) do
        out[#out + 1] = ("  %3d  %4d  %10s  %10.2f  %11.2f  %10.1f  %8.2fs"):format(
            r.index, r.pass, ("%g %s"):format(r.magnitude, runner.unit),
            r.measured, r.peak, r.implied, r.t / 1000.0)
    end
    out[#out + 1] =
        "  Compare with your server log — the first step it did not flag is the gap."
    return table.concat(out, "\n")
end

local function stopScenario(reason)
    if not runner.active then
        act("No scenario is running", "error")
        return
    end
    runner.active = false
    runner.lastText = reason or "stopped"
    act("Scenario " .. (reason or "stopped"))
end

local function startScenario()
    if runner.active then
        act("A scenario is already running", "error")
        return
    end
    local scenario = scenarioByName(cfg.scenario)

    runner.active    = true
    runner.name      = scenario.name
    runner.unit      = scenario.unit
    runner.note      = scenario.note
    runner.total     = #scenario.steps
    runner.passes    = cfg.repeats
    runner.step      = 0
    runner.pass      = 1
    runner.results   = {}
    runner.startedAt = GetGameTimer()
    runner.lastText  = "starting"

    act(("Scenario '%s': %d steps x %d"):format(
        scenario.name, #scenario.steps, cfg.repeats), "success")
    print("---- scenario ----")
    print("  " .. scenario.note)

    CreateThread(function()
        for pass = 1, cfg.repeats do
            runner.pass = pass
            for index, magnitude in ipairs(scenario.steps) do
                if not isCurrent() or not runner.active then
                    runner.active = false
                    return
                end

                runner.step = index
                runner.current = magnitude

                local ox, oy, oz = coords()
                local origin = { x = ox, y = oy, z = oz }
                state.stepPeak = 0.0
                local t0 = GetGameTimer()

                scenario.apply(magnitude, ox, oy, oz)
                Wait(300)

                local nx, ny, nz = coords()
                local measured = dist3(origin, { x = nx, y = ny, z = nz })

                runner.results[#runner.results + 1] = {
                    index = index, pass = pass, magnitude = magnitude,
                    measured = measured, peak = state.stepPeak or 0.0,
                    implied = state.impliedSpeed, t = t0,
                }
                runner.lastText = ("step %d/%d  %g %s  measured %.2f m")
                    :format(index, #scenario.steps, magnitude, scenario.unit, measured)
                log(("Scenario %s  pass %d  step %d  %g %s  measured %.2f m  peak %.2f m")
                    :format(scenario.name, pass, index, magnitude, scenario.unit,
                            measured, state.stepPeak or 0.0))

                if cfg.endpoint ~= "" then
                    postSnapshot(false, {
                        jStr("scenario", scenario.name),
                        jInt("scenarioStep", index),
                        jInt("scenarioPass", pass),
                        jNum("scenarioMagnitude", magnitude),
                        jNum("scenarioMeasured", measured),
                    })
                end

                if scenario.back then scenario.back(ox, oy, oz) end
                Wait(cfg.stepDelay)
            end
        end

        runner.active = false
        runner.lastText = ("done — %d results"):format(#runner.results)
        act(("Scenario '%s' finished, %d results"):format(
            scenario.name, #runner.results), "success")
        print(runnerReport())
    end)
end
--------------------------------------------------------------------------------
-- Per-frame effects
--------------------------------------------------------------------------------

local function applyPerFrameEffects()
    local p = ped()
    if toggles.superJump then SetSuperJumpThisFrame(PlayerId()) end
    if toggles.noRagdoll then SetPedCanRagdoll(p, false) end
    if toggles.infiniteAmmo then SetPedInfiniteAmmo(p, true, GetSelectedPedWeapon(p)) end
end
--------------------------------------------------------------------------------
-- Overlay
--------------------------------------------------------------------------------

local drawText       = hamFn("drawText")
local drawRectFilled = hamFn("drawRectFilled")
local drawRect       = hamFn("drawRect")
local drawLine       = hamFn("drawLine")
local drawCircle     = hamFn("drawCircle")
local drawGradient   = hamFn("drawRectGradient")
local getTextWidth   = hamFn("getTextWidth")
local getResolution  = hamFn("getResolution")
local worldToScreen  = hamFn("worldToScreen")
local canDraw = drawText ~= nil and drawRectFilled ~= nil and getResolution ~= nil

-- drawText's fontSize is independent of the font getTextWidth measures with
-- (12 px by default), so scale the measurement to the configured size.
local function measure(text)
    if not getTextWidth then return #tostring(text) * 7.0 end
    local w = getTextWidth(tostring(text))
    return (w or 0) * (cfg.fontSize / 12.0)
end

local function buildRows()
    local rows = {}
    local function heading(text) rows[#rows + 1] = { kind = "heading", text = text } end
    local function row(label, value, color)
        rows[#rows + 1] = { kind = "row", label = label, value = value, color = color }
    end
    local function flag(label, on)
        row(label, onOff(on), on and COLORS.on or COLORS.off)
    end

    if cfg.showStatus then
        heading("STATUS")
        row("Pos", ("%.1f  %.1f  %.1f"):format(
            state.coords.x, state.coords.y, state.coords.z))
        row("Speed", ("%.1f m/s  (%.0f km/h)"):format(state.speed, state.speed * 3.6))
        row("Health", ("%d / armour %d"):format(state.health, state.armour))
        if marker then
            row("From marker", ("%.2f m"):format(dist3(state.coords, marker)))
        end
        flag("God", toggles.godMode)
        flag("Invisible", toggles.invisible)
        flag("No-Clip", toggles.noClip)
        flag("Free Cam", toggles.freeCam)
        flag("Spectator", toggles.spectator)
        flag("Anti-TP", toggles.antiTeleport)
        row("TP method", cfg.telMethod == "Ham (setPosition)" and "ham" or "native")
        row("Anti-cheat", truncate(antiCheatText(), 30),
            #antiCheat.list > 0 and COLORS.warn or COLORS.off)
    end

    if cfg.showMovement then
        heading("MOVEMENT")
        local deltaColor = COLORS.value
        if state.delta >= cfg.jumpThreshold then
            deltaColor = COLORS.alert
        elseif state.delta >= cfg.jumpThreshold * 0.5 then
            deltaColor = COLORS.warn
        end
        row("Delta/frame", ("%.3f m"):format(state.delta), deltaColor)
        row("Implied", ("%.1f m/s"):format(state.impliedSpeed), deltaColor)
        row("Max delta", ("%.3f m"):format(state.maxDelta))
        row("Max implied", ("%.1f m/s"):format(state.maxImplied))
        row(("Jumps >= %gm"):format(cfg.jumpThreshold),
            ("%d  (last %.2f m)"):format(state.jumps, state.lastJump),
            state.jumps > 0 and COLORS.alert or COLORS.on)
        row("Frame", ("%.0f ms"):format(state.frameMs))
    end

    if cfg.showMonitors then
        heading("MONITOR")
        row("Source", truncate(monitor.lastSource or cfg.monitorSource, 28))
        if not monitor.baseline then
            row("Baseline", "none", COLORS.off)
        else
            row("Baseline", ("%.1fs ago"):format(
                (GetGameTimer() - (monitor.baselineAt or 0)) / 1000.0))
            local total = monitorChangeCount()
            row("Last diff",
                total > 0 and ("+%d ~%d -%d"):format(
                    #monitor.added, #monitor.changed, #monitor.removed) or "no change",
                total > 0 and COLORS.alert or COLORS.on)
        end
        if cfg.autoDiff then
            row("Auto diff", ("every %ds"):format(cfg.diffInterval), COLORS.on)
        end
    end

    if cfg.showCalibration then
        heading("CALIBRATION")
        local s = calibrationStats()
        row("Metric", ("%s (%s)"):format(truncate(s.metric, 20), s.unit))
        row("Samples", cfg.collectSamples
            and ("%d, collecting"):format(s.count) or ("%d, paused"):format(s.count),
            cfg.collectSamples and COLORS.on or COLORS.off)
        if s.count > 0 then
            row("p50 / p99", ("%.3f / %.3f"):format(s.p50, s.p99))
            row("Suggested", ("%.2f %s  (+%d%%)"):format(s.suggested, s.unit, s.margin),
                COLORS.warn)
        end
    end

    if cfg.showScenario then
        heading("SCENARIO")
        if runner.active then
            row("Running", truncate(runner.name, 30), COLORS.on)
            row("Progress", ("pass %d/%d   step %d/%d"):format(
                runner.pass, runner.passes, runner.step, runner.total), COLORS.warn)
        else
            row("Selected", truncate(cfg.scenario, 30))
            row("State", runner.lastText, COLORS.off)
        end
        row("Results", tostring(#runner.results))
        row("Last", truncate(runner.lastText, 40))
    end

    if cfg.showInput then
        heading("INPUT")
        if hamFn("getMousePos") then
            local mx, my = ham("getMousePos")
            row("Mouse", ("%.0f, %.0f"):format(mx or 0, my or 0))
        end
        -- Virtual key codes, per the Ham key-codes reference.
        local watched = {
            { "Shift", 0x10 }, { "Ctrl", 0x11 }, { "Alt", 0x12 },
            { "Space", 0x20 }, { "LMB", 0x01 }, { "RMB", 0x02 },
        }
        local down = {}
        if hamFn("getKeyState") then
            for _, k in ipairs(watched) do
                local st = ham("getKeyState", k[2])
                if st and st ~= 0 then down[#down + 1] = k[1] end
            end
        end
        row("Keys", #down > 0 and table.concat(down, " ") or "-",
            #down > 0 and COLORS.on or COLORS.off)
    end

    if cfg.endpoint ~= "" then
        heading("TELEMETRY")
        row("Auto POST", cfg.autoPost and ("on, every %ds"):format(cfg.postInterval) or "off")
        local color = COLORS.value
        if postState.status:sub(1, 5) == "error" then color = COLORS.alert
        elseif postState.status:sub(1, 2) == "ok" then color = COLORS.on end
        row("Status", truncate(postState.status, 34), color)
    end

    if httpStatus ~= "idle" then
        heading("HTTP")
        row("Status", truncate(httpStatus, 34),
            httpStatus:sub(1, 5) == "error" and COLORS.alert or COLORS.value)
    end

    return rows
end

local function logLines()
    local lines = {}
    for _, e in ipairs(logEntries) do
        lines[#lines + 1] = ("%7.2fs  %s"):format(e.t / 1000.0, truncate(e.text, 52))
    end
    if #lines == 0 then lines[1] = "(nothing yet)" end
    return lines
end

local function drawShapeDemo(resW, resH)
    local color = { cfg.shapeR, cfg.shapeG, cfg.shapeB, 230 }
    local cx, cy = resW * 0.5, resH * 0.5
    local w, h = 220, 140
    local x, y = cx - w / 2, cy - h / 2

    if cfg.shape == "Line" and drawLine then
        drawLine({ x, y }, { x + w, y + h }, color, cfg.thickness)
        drawLine({ x, y + h }, { x + w, y }, color, cfg.thickness)
    elseif cfg.shape == "Rect Outline" and drawRect then
        drawRect({ x, y }, { x + w, y + h }, color, 8, 0, cfg.thickness)
    elseif cfg.shape == "Rect Filled" then
        drawRectFilled({ x, y, w, h }, color, 8, 0)
    elseif cfg.shape == "Gradient" and drawGradient then
        drawGradient({ x, y, w, h }, color, { 20, 20, 30, 230 }, true)
    elseif cfg.shape == "Circle" and drawCircle then
        drawCircle({ cx, cy, 70 }, color, 48, cfg.thickness, false)
    elseif cfg.shape == "Circle Filled" and drawCircle then
        drawCircle({ cx, cy, 70 }, color, 48, 1.0, true)
    elseif cfg.shape == "Text" then
        drawText(SCRIPT_NAME, { cx, cy }, color, cfg.fontSize * 2,
            true, true, COLORS.outline)
    end
end

local function drawMarker()
    if not savedMarker or not worldToScreen then return end
    local onScreen, sx, sy = worldToScreen(savedMarker.x, savedMarker.y, savedMarker.z)
    if not onScreen then return end
    local color = { 255, 190, 70, 235 }
    if drawCircle then drawCircle({ sx, sy, 10 }, color, 24, 2.0, false) end
    if drawLine then
        drawLine({ sx - 16, sy }, { sx + 16, sy }, color, 1)
        drawLine({ sx, sy - 16 }, { sx, sy + 16 }, color, 1)
    end
    drawText(("marker  %.1f m"):format(dist3(state.coords, savedMarker)),
        { sx, sy + 20 }, color, cfg.fontSize, true, true, COLORS.outline)
end

local MARGIN = 20

-- With every panel open at font 26 the overlay can outgrow a short screen, and
-- a panel drawn past the bottom edge is worse than a trimmed one. The log gives
-- way first because it is the part that grows without bound; if the rows alone
-- still do not fit, the tail goes and the last row says so.
local function fitPanel(rows, lines, resH, lineH, headGap, pad)
    local budget = resH - MARGIN * 2 - pad * 2

    local function height()
        local h = 0
        for _, r in ipairs(rows) do
            h = h + lineH + (r.kind == "heading" and headGap or 0)
        end
        if lines then h = h + lineH + headGap + #lines * lineH end
        return h
    end

    while lines and #lines > 1 and height() > budget do table.remove(lines, 1) end
    if lines and height() > budget then lines = nil end

    if height() > budget then
        while #rows > 1 and height() + lineH > budget do table.remove(rows) end
        rows[#rows + 1] = { kind = "row", label = "...", value = "panel trimmed to fit" }
    end

    return rows, lines
end

local function drawOverlay()
    local resW, resH = getResolution()
    resW, resH = resW or 1920, resH or 1080

    if cfg.showShapes then drawShapeDemo(resW, resH) end
    if cfg.showMarker then drawMarker() end

    local rows = buildRows()
    local lines = cfg.showLog and logLines() or nil
    if #rows == 0 and not lines then return end

    local pad, lineH, headGap = 10, cfg.fontSize + 6, 6
    rows, lines = fitPanel(rows, lines, resH, lineH, headGap, pad)

    local labelCol = 0
    for _, r in ipairs(rows) do
        if r.kind == "row" then labelCol = math.max(labelCol, measure(r.label)) end
    end
    labelCol = labelCol + 14

    local contentW, contentH = labelCol, 0
    for _, r in ipairs(rows) do
        if r.kind == "heading" then
            contentH = contentH + lineH + headGap
            contentW = math.max(contentW, measure(r.text))
        else
            contentH = contentH + lineH
            contentW = math.max(contentW, labelCol + measure(r.value))
        end
    end
    if lines then
        contentH = contentH + lineH + headGap + #lines * lineH
        for _, l in ipairs(lines) do contentW = math.max(contentW, measure(l)) end
        contentW = math.max(contentW, measure("ACTION LOG"))
    end

    local panelW = contentW + pad * 2
    local panelH = contentH + pad * 2

    local px, py
    if cfg.corner == "Top Left" then
        px, py = MARGIN, MARGIN
    elseif cfg.corner == "Top Right" then
        px, py = resW - panelW - MARGIN, MARGIN
    elseif cfg.corner == "Bottom Left" then
        px, py = MARGIN, resH - panelH - MARGIN
    else
        px, py = resW - panelW - MARGIN, resH - panelH - MARGIN
    end

    drawRectFilled({ px, py, panelW, panelH },
        { COLORS.panel[1], COLORS.panel[2], COLORS.panel[3], 175 }, 6, 0)
    if drawLine then
        drawLine({ px, py }, { px + panelW, py }, COLORS.accent, 2)
    end

    local y = py + pad
    for _, r in ipairs(rows) do
        if r.kind == "heading" then
            y = y + headGap
            drawText(r.text, { px + pad, y }, COLORS.accent,
                cfg.fontSize, false, true, COLORS.outline)
            y = y + lineH
        else
            drawText(r.label, { px + pad, y }, COLORS.label,
                cfg.fontSize, false, true, COLORS.outline)
            drawText(r.value, { px + pad + labelCol, y }, r.color or COLORS.value,
                cfg.fontSize, false, true, COLORS.outline)
            y = y + lineH
        end
    end

    if lines then
        y = y + headGap
        drawText("ACTION LOG", { px + pad, y }, COLORS.accent,
            cfg.fontSize, false, true, COLORS.outline)
        y = y + lineH
        for _, l in ipairs(lines) do
            drawText(l, { px + pad, y }, COLORS.value,
                cfg.fontSize, false, true, COLORS.outline)
            y = y + lineH
        end
    end
end
--------------------------------------------------------------------------------
-- Main loop
--------------------------------------------------------------------------------
-- The two front ends differ only in what they hang off these two hooks: the
-- menu build leaves both nil, the drawn GUI fills them in.

local perFrame, onRetire

CreateThread(function()
    while isCurrent() do
        Wait(0)

        sample()
        applyPerFrameEffects()
        pollTelemetry()
        pollHttp()
        pollMonitors()

        if cfg.autoPost and cfg.endpoint ~= "" and not postState.requestId then
            local elapsed = (GetGameTimer() - postState.lastAttempt) / 1000.0
            if elapsed >= cfg.postInterval then postSnapshot(false) end
        end

        if cfg.overlay and canDraw then
            -- Only this loop can hand back a captured mouse, so it must survive
            -- a bad frame. drawOverlay never yields, so protecting it here does
            -- not put a Wait inside a pcall.
            local drawn, err = pcall(drawOverlay)
            if not drawn then
                cfg.overlay = false
                log("Overlay draw failed, overlay switched off: " .. tostring(err))
            end
        end
        if perFrame then perFrame() end
    end

    -- Reached only when a newer Execute bumped the generation. Whatever this run
    -- grabbed — the mouse, the input block — has to go back before the new one
    -- starts, or the player is left with a cursor and no menu under it.
    if onRetire then onRetire() end
end)
--------------------------------------------------------------------------------
-- Inspector dumps
--------------------------------------------------------------------------------

local function publishDump(title, lines)
    local shown = math.min(#lines, cfg.dumpLimit)
    print(("---- %s (%d entries, showing %d) ----"):format(title, #lines, shown))
    for i = 1, shown do print("  " .. lines[i]) end
    if #lines > shown then
        print(("  ... %d more (raise Dump Line Limit)"):format(#lines - shown))
    end
    lastDump = title .. "\n" .. table.concat(lines, "\n")
    act(("%s: %d entries"):format(title, #lines), "success")
end

local function dumpArray(title, value)
    if type(value) ~= "table" then act(title .. ": no data", "error") return end
    local lines = {}
    for _, v in ipairs(value) do lines[#lines + 1] = tostring(v) end
    publishDump(title, lines)
end

local function dumpEventMap(title, value)
    if type(value) ~= "table" then act(title .. ": no data", "error") return end
    local lines = {}
    for resource, events in pairs(value) do
        if type(events) == "table" then
            for _, e in ipairs(events) do
                lines[#lines + 1] = ("%s  ->  %s"):format(resource, tostring(e))
            end
        else
            lines[#lines + 1] = tostring(resource)
        end
    end
    table.sort(lines)
    publishDump(title, lines)
end

local function dumpStateBags()
    local bags = ham("getAllStateBags")
    if type(bags) ~= "table" then act("State bags: no data", "error") return end
    local lines = {}
    for bag, data in pairs(bags) do
        if type(data) == "table" then
            for k, v in pairs(data) do
                lines[#lines + 1] = ("%s  %s = %s"):format(bag, tostring(k), truncate(v, 60))
            end
        else
            lines[#lines + 1] = ("%s = %s"):format(tostring(bag), truncate(data, 60))
        end
    end
    table.sort(lines)
    publishDump("State bags", lines)
end

--------------------------------------------------------------------------------
-- Export bundle
--------------------------------------------------------------------------------
-- One JSON document holding everything this run knows: the live snapshot, what
-- anti-cheat was detected, the calibration distribution, the last monitor diff,
-- every scenario step and the action log. Paste it next to your server-side log
-- and both halves of the same minutes are in one place.

local function jsonEntries(list)
    local out = {}
    for _, e in ipairs(list) do
        out[#out + 1] = "{" .. table.concat({
            jStr("key", e.key),
            jStr("from", e.from or e.value or ""),
            jStr("to", e.to or e.value or ""),
        }, ",") .. "}"
    end
    return "[" .. table.concat(out, ",") .. "]"
end

local function antiCheatJson()
    return "{" .. table.concat({
        jBool("present", #antiCheat.list > 0),
        jInt("count", #antiCheat.list),
        jStr("shape", antiCheat.shape),
        jBool("supported", antiCheat.supported),
        jRaw("names", jsonStringArray(antiCheat.list)),
    }, ",") .. "}"
end

local function calibrationJson()
    local s = calibrationStats()
    return "{" .. table.concat({
        jStr("metric", s.metric), jStr("unit", s.unit),
        jInt("count", s.count), jInt("dropped", s.dropped),
        jNum("elapsed", s.elapsed),
        jNum("min", s.min), jNum("p50", s.p50), jNum("p90", s.p90),
        jNum("p95", s.p95), jNum("p99", s.p99), jNum("max", s.max),
        jInt("margin", s.margin), jNum("suggested", s.suggested),
    }, ",") .. "}"
end

local function monitorJson()
    return "{" .. table.concat({
        jStr("source", monitor.lastSource or cfg.monitorSource),
        jBool("baseline", monitor.baseline ~= nil),
        jInt("runs", monitor.runs),
        jInt("changes", monitorChangeCount()),
        jRaw("added", jsonEntries(monitor.added)),
        jRaw("changed", jsonEntries(monitor.changed)),
        jRaw("removed", jsonEntries(monitor.removed)),
    }, ",") .. "}"
end

local function scenarioJson()
    local steps = {}
    for _, r in ipairs(runner.results) do
        steps[#steps + 1] = "{" .. table.concat({
            jInt("index", r.index), jInt("pass", r.pass),
            jNum("magnitude", r.magnitude), jNum("measured", r.measured),
            jNum("peak", r.peak), jNum("implied", r.implied), jInt("t", r.t),
        }, ",") .. "}"
    end
    return "{" .. table.concat({
        jStr("name", runner.name), jStr("unit", runner.unit),
        jStr("note", runner.note), jBool("active", runner.active),
        jInt("startedAt", runner.startedAt), jInt("results", #runner.results),
        jRaw("steps", "[" .. table.concat(steps, ",") .. "]"),
    }, ",") .. "}"
end

local function logJson()
    local out = {}
    for _, e in ipairs(logEntries) do
        out[#out + 1] = "{" .. jInt("t", e.t) .. "," .. jStr("text", e.text) .. "}"
    end
    return "[" .. table.concat(out, ",") .. "]"
end

local function exportBundle()
    return "{" .. table.concat({
        jStr("script", SCRIPT_NAME),
        jStr("interface", INTERFACE_NAME),
        jInt("gameTime", GetGameTimer()),
        jStr("user", tostring(ham("getName") or "unknown")),
        jStr("server", tostring(ham("getServerHostname") or "")),
        jStr("serverEndpoint", tostring(ham("getServerEndpoint") or "")),
        jInt("serverId", GetPlayerServerId(PlayerId())),
        jRaw("snapshot", buildSnapshot()),
        jRaw("antiCheat", antiCheatJson()),
        jRaw("calibration", calibrationJson()),
        jRaw("monitor", monitorJson()),
        jRaw("scenario", scenarioJson()),
        jRaw("log", logJson()),
    }, ",") .. "}"
end

--------------------------------------------------------------------------------
-- Feature spec
--------------------------------------------------------------------------------
-- Every feature this bench has, described once, as data. Both front ends walk
-- this table and nothing else: luchs-script.lua turns each item into a Vanity
-- control, luchs-gui.lua draws it. Adding a feature here adds it to both, and
-- test/parity_test.lua fails if the two files ever stop agreeing on it.
--
-- Item kinds:
--   button    action()
--   toggle    get() -> boolean          set(boolean)
--   slider    get() -> number           set(number)      min, max, step
--   selector  get() -> string           set(string)      choices (table or function)
--   text      get() -> string           set(string)      placeholder
--   group     items = { buttons only }  — a submenu in the menu, a block in the GUI
--
-- Text entry goes through Vanity.promptText in both front ends: it is a modal
-- the drawn GUI can raise just as well as the menu can.

local function promptFor(title, label, default, maxLen, apply)
    Vanity.promptText({ title = title, label = label,
                        default = default or "", maxLen = maxLen or 120 },
        function(text, cancelled)
            if cancelled then return end
            apply(text or "")
        end)
end

local function giveWeapons(names, ammo, what)
    for _, weapon in ipairs(names) do
        GiveWeaponToPed(ped(), GetHashKey(weapon), ammo, false, false)
    end
    act(what .. " given", "success")
end

local function spawnModel(name)
    if name == "" then
        act("Enter a vehicle model first", "error")
        return
    end
    local hash = GetHashKey(name)
    if not loadModel(hash) then
        act("Model did not load: " .. name, "error")
        return
    end
    local p = ped()
    local x, y, z = coords()
    spawnedVehicle = CreateVehicle(hash, x, y, z, GetEntityHeading(p), true, false)
    SetPedIntoVehicle(p, spawnedVehicle, -1)
    SetModelAsNoLongerNeeded(hash)
    act("Spawned " .. name, "success")
end

local function saveSlot(n)
    local x, y, z = coords()
    slots[n] = { x = x, y = y, z = z }
    act(("Slot %d saved"):format(n), "success")
end

local function loadSlot(n)
    if slots[n] then
        teleport(slots[n].x, slots[n].y, slots[n].z, ("slot %d"):format(n))
    else
        act(("Slot %d empty"):format(n), "error")
    end
end

local function applySuggestedThreshold()
    local s = calibrationStats()
    if s.count == 0 then
        act("No samples to calibrate from", "error")
        return
    end
    if not s.applies then
        act(("%s is not a per-frame distance — nothing to apply it to"):format(s.metric),
            "error")
        return
    end

    -- Clamped to the slider's own range: a threshold the menu cannot display is
    -- one the menu would then disagree with.
    local value = s.suggested
    local clamped = false
    if value < JUMP_MIN then value, clamped = JUMP_MIN, true end
    if value > JUMP_MAX then value, clamped = JUMP_MAX, true end

    cfg.jumpThreshold = value
    act(("Jump threshold set to %.2f %s from p99 + %d %%%s")
        :format(value, s.unit, s.margin,
            clamped and (" (clamped from %.2f)"):format(s.suggested) or ""),
        "success")
end

local function copyText(what, text)
    if text == nil or text == "" then
        act("Nothing to copy for " .. what, "error")
        return
    end
    ham("copyToClipboard", text)
    act(("%s copied (%d bytes)"):format(what, #text), "success")
end

local function sendExportBundle()
    if cfg.endpoint == "" then
        act("Set a telemetry endpoint first", "error")
        return
    end
    local body = exportBundle()
    ham("httpPostAsync", cfg.endpoint, body, { ["Content-Type"] = "application/json" })
    act(("Export bundle sent (%d bytes)"):format(#body), "success")
end

local function printSessionInfo()
    local x, y, z = coords()
    local resW, resH = 0, 0
    if getResolution then resW, resH = getResolution() end
    print("---- session ----")
    print("  script     : " .. SCRIPT_NAME .. "  (" .. INTERFACE_NAME .. ")")
    print("  user       : " .. tostring(ham("getName")))
    print("  discord    : " .. tostring(ham("getDiscordName")) ..
          " (" .. tostring(ham("getDiscordId")) .. ")")
    print("  server     : " .. tostring(ham("getServerHostname")))
    print("  endpoint   : " .. tostring(ham("getServerEndpoint")))
    print("  server id  : " .. tostring(GetPlayerServerId(PlayerId())))
    print(("  position   : %.2f %.2f %.2f"):format(x, y, z))
    print(("  resolution : %sx%s"):format(tostring(resW), tostring(resH)))
    print("  ped model  : " .. tostring(GetEntityModel(ped())))
    print("  anti-cheat : " .. antiCheatText())
    act("Session info printed", "success")
end

local function resetEverything()
    if runner.active then stopScenario("stopped by reset") end
    for _, name in ipairs({ "godMode", "invisible", "noClip", "freeCam", "spectatorMode",
                            "antiTeleport", "antiBlockControl", "disableWeather" }) do
        ham(name, false)
    end
    for k in pairs(toggles) do toggles[k] = false end
    SetEntityInvincible(ped(), false)
    SetPedCanRagdoll(ped(), true)
    SetRunSprintMultiplierForPlayer(PlayerId(), 1.0)
    SetSwimMultiplierForPlayer(PlayerId(), 1.0)
    cfg.runSpeed, cfg.swimSpeed = 1, 1
    resetCounters()
    act("Everything reset", "success")
end

local function setFontChoice(choice)
    cfg.font = choice
    if choice == "Default" then
        ham("resetFont")
        act("Font reset to default")
        return
    end
    local index = ({ ["Rubik"] = 1, ["Font Awesome"] = 2, ["Consolas"] = 3 })[choice]
    local handle = ham("addFont", index, cfg.fontSize + 4)
    if handle then
        ham("setFont", handle)
        act("Font set to " .. choice, "success")
    else
        act("Font " .. choice .. " failed to load", "error")
    end
end

local function toggleFeature(key, hamName, label, extra)
    return function(on)
        toggles[key] = on
        if hamName then ham(hamName, on) end
        if extra then extra(on) end
        act(label .. " " .. onOff(on))
    end
end

local SPEC = {

{ section = "Scenario Runner",
  note = "Reproducible behaviour ladders — the client half of a detection test",
  items = {
    { kind = "selector", label = "Scenario", choices = scenarioNames,
      desc = "Which behaviour ladder to play",
      get = function() return cfg.scenario end,
      set = function(v)
          cfg.scenario = v
          local s = scenarioByName(v)
          runner.lastText = "idle"
          log(("Scenario selected: %s  (%d steps)"):format(v, #s.steps))
          print("  " .. s.note)
      end },
    { kind = "slider", label = "Step Delay", min = 500, max = 15000, step = 500,
      desc = "Milliseconds between ladder steps — leave room for your server to react",
      get = function() return cfg.stepDelay end,
      set = function(v) cfg.stepDelay = v end },
    { kind = "slider", label = "Repeats", min = 1, max = 10, step = 1,
      desc = "How many times to replay the whole ladder",
      get = function() return cfg.repeats end,
      set = function(v) cfg.repeats = v end },
    { kind = "button", label = "Start Scenario", action = startScenario,
      desc = "Play the selected ladder, recording what the client did at every step" },
    { kind = "button", label = "Stop Scenario",
      desc = "Abort the run after the current step",
      action = function() stopScenario("stopped by user") end },
    { kind = "button", label = "Print Run Report",
      desc = "Dump the last run as a table to the F8 console",
      action = function()
          print(runnerReport())
          act(("Report printed (%d results)"):format(#runner.results))
      end },
    { kind = "button", label = "Copy Run Report",
      desc = "Put the run report on the system clipboard",
      action = function()
          if #runner.results == 0 then
              act("No scenario has been run yet", "error")
              return
          end
          copyText("Run report", runnerReport())
      end },
    { kind = "button", label = "Describe Scenarios",
      desc = "List every ladder and what it exercises",
      action = function()
          print("---- scenarios ----")
          for _, s in ipairs(SCENARIOS) do
              print(("  %-26s %d steps  (%s)"):format(s.name, #s.steps, s.unit))
              print("      " .. s.note)
          end
          act("Scenario list printed")
      end },
}},

{ section = "Movement Analysis",
  note = "Raw per-frame movement — the signal every teleport check reads",
  items = {
    { kind = "slider", label = "Jump Threshold", min = JUMP_MIN, max = JUMP_MAX, step = 1,
      desc = "Metres in one frame before it counts as a jump",
      get = function() return cfg.jumpThreshold end,
      set = function(v) cfg.jumpThreshold = v + 0.0 end },
    { kind = "button", label = "Reset Counters",
      desc = "Zero the max delta and jump counters before a run",
      action = function() resetCounters(); act("Counters reset", "success") end },
    { kind = "button", label = "Set Reference Marker",
      desc = "Store the current position; the overlay shows distance from it",
      action = function()
          local x, y, z = coords()
          marker = { x = x, y = y, z = z }
          savedMarker = marker
          act("Reference marker set", "success")
      end },
    { kind = "button", label = "Clear Marker",
      desc = "Remove the reference marker",
      action = function() marker, savedMarker = nil, nil; act("Marker cleared") end },
    { kind = "toggle", label = "3D Marker",
      desc = "Project the saved world position onto the screen",
      get = function() return cfg.showMarker end,
      set = function(on)
          cfg.showMarker = on
          if on and not savedMarker then
              act("No marker set — use 'Set Reference Marker'", "error")
          end
      end },
}},

{ section = "Monitors",
  note = "Watch a server-side inventory and diff it: added, changed, removed",
  items = {
    { kind = "selector", label = "Monitor Source", choices = monitorSourceNames,
      desc = "Which inventory to watch",
      get = function() return cfg.monitorSource end,
      set = function(v)
          cfg.monitorSource = v
          log("Monitor source: " .. v .. "  (" .. monitorSourceByName(v).note .. ")")
      end },
    { kind = "button", label = "Take Baseline", action = function() takeBaseline(true) end,
      desc = "Snapshot the selected inventory as the starting point" },
    { kind = "button", label = "Diff Now", action = function() diffNow(true) end,
      desc = "Compare against the baseline, then rebase onto what was just seen" },
    { kind = "button", label = "Print Monitor Diff",
      desc = "Dump the last diff to the console",
      action = function() print(monitorReport()); act("Monitor diff printed") end },
    { kind = "button", label = "Copy Monitor Diff",
      desc = "Put the last diff on the system clipboard",
      action = function() copyText("Monitor diff", monitorReport()) end },
    { kind = "button", label = "Clear Baseline", action = clearBaseline,
      desc = "Forget the baseline so the next diff starts fresh" },
    { kind = "toggle", label = "Auto Diff",
      desc = "Diff on a fixed interval and log whatever moved",
      get = function() return cfg.autoDiff end,
      set = function(on)
          cfg.autoDiff = on
          act("Auto diff " .. onOff(on))
      end },
    { kind = "slider", label = "Diff Interval", min = 1, max = 60, step = 1,
      desc = "Seconds between automatic diffs",
      get = function() return cfg.diffInterval end,
      set = function(v) cfg.diffInterval = v end },
}},

{ section = "Calibration",
  note = "Percentiles over what normal play actually does, and a threshold from them",
  items = {
    { kind = "selector", label = "Calibration Metric", choices = calibrationMetricNames,
      desc = "Which quantity to build a distribution for",
      get = function() return cfg.calibrationMetric end,
      set = function(v)
          cfg.calibrationMetric = v
          log("Calibration metric: " .. v .. "  (" .. calibrationMetricByName(v).note .. ")")
      end },
    { kind = "toggle", label = "Collect Samples",
      desc = "Record one sample per frame — play normally while this is on",
      get = function() return cfg.collectSamples end,
      set = function(on)
          cfg.collectSamples = on
          act("Sample collection " .. onOff(on))
      end },
    { kind = "slider", label = "Safety Margin", min = 0, max = 300, step = 10,
      desc = "Headroom above p99, in percent, for the suggested threshold",
      get = function() return cfg.calibrationMargin end,
      set = function(v) cfg.calibrationMargin = v end },
    { kind = "button", label = "Print Calibration",
      desc = "Percentiles and the suggested threshold, to the console",
      action = function() print(calibrationReport()); act("Calibration printed") end },
    { kind = "button", label = "Copy Calibration",
      desc = "Put the calibration table on the system clipboard",
      action = function() copyText("Calibration", calibrationReport()) end },
    { kind = "button", label = "Clear Samples",
      desc = "Throw the distribution away and start collecting again",
      action = function() clearSamples(); act("Samples cleared") end },
    { kind = "button", label = "Apply Suggested Threshold", action = applySuggestedThreshold,
      desc = "Set the jump threshold to p99 plus the margin" },
}},

{ section = "Telemetry",
  note = "POST what the client sees to your own collector",
  items = {
    { kind = "text", label = "Endpoint", placeholder = "https://your-server/ac-telemetry",
      desc = "Your own collector; snapshots and scenario steps are POSTed as JSON",
      get = function() return cfg.endpoint end,
      set = function(v) cfg.endpoint = v or ""; postState.status = "idle" end },
    { kind = "toggle", label = "Auto POST",
      desc = "Send a snapshot on a fixed interval",
      get = function() return cfg.autoPost end,
      set = function(on)
          cfg.autoPost = on
          if on and cfg.endpoint == "" then act("Set an endpoint first", "error") end
      end },
    { kind = "slider", label = "POST Interval", min = 1, max = 60, step = 1,
      desc = "Seconds between automatic snapshots",
      get = function() return cfg.postInterval end,
      set = function(v) cfg.postInterval = v end },
    { kind = "button", label = "Send Snapshot Now", action = function() postSnapshot(true) end,
      desc = "POST one snapshot immediately" },
    { kind = "button", label = "Print Snapshot",
      desc = "Echo the snapshot JSON to the console without sending it",
      action = function()
          print("[Luchs] " .. buildSnapshot())
          act("Snapshot printed")
      end },
}},

{ section = "Self",
  note = "Client-side state a detector is meant to notice",
  items = {
    { kind = "toggle", label = "God Mode",
      desc = "Ham godMode plus the native invincibility flag",
      get = function() return toggles.godMode end,
      set = toggleFeature("godMode", "godMode", "God mode",
          function(on) SetEntityInvincible(ped(), on) end) },
    { kind = "toggle", label = "Invisible", desc = "Toggle player visibility",
      get = function() return toggles.invisible end,
      set = toggleFeature("invisible", "invisible", "Invisible") },
    { kind = "toggle", label = "No-Clip", desc = "Fly through geometry",
      get = function() return toggles.noClip end,
      set = toggleFeature("noClip", "noClip", "No-clip") },
    { kind = "slider", label = "No-Clip Speed", min = 1, max = 20, step = 1,
      desc = "No-clip movement multiplier",
      get = function() return cfg.noClipSpeed end,
      set = function(v) cfg.noClipSpeed = v; ham("setNoClipSpeed", v + 0.0) end },
    { kind = "toggle", label = "Free Cam", desc = "Detach the camera from the player",
      get = function() return toggles.freeCam end,
      set = toggleFeature("freeCam", "freeCam", "Free cam") },
    { kind = "slider", label = "Free Cam Speed", min = 1, max = 20, step = 1,
      desc = "Free camera movement multiplier",
      get = function() return cfg.freeCamSpeed end,
      set = function(v) cfg.freeCamSpeed = v; ham("setFreecamSpeed", v + 0.0) end },
    { kind = "toggle", label = "Spectator Mode", desc = "Toggle spectator mode",
      get = function() return toggles.spectator end,
      set = toggleFeature("spectator", "spectatorMode", "Spectator") },
    { kind = "toggle", label = "Anti-Teleport",
      desc = "Refuse teleports pushed by the server — a detector should notice this",
      get = function() return toggles.antiTeleport end,
      set = toggleFeature("antiTeleport", "antiTeleport", "Anti-teleport") },
    { kind = "toggle", label = "Anti-Block Control",
      desc = "Refuse having entity control taken away",
      get = function() return toggles.antiBlock end,
      set = toggleFeature("antiBlock", "antiBlockControl", "Anti-block control") },
    { kind = "slider", label = "Run Speed", min = 1, max = 10, step = 1,
      desc = "Sprint speed multiplier",
      get = function() return cfg.runSpeed end,
      set = function(v)
          cfg.runSpeed = v
          SetRunSprintMultiplierForPlayer(PlayerId(), v * 1.0)
          act("Run speed x" .. v)
      end },
    { kind = "slider", label = "Swim Speed", min = 1, max = 10, step = 1,
      desc = "Swim speed multiplier",
      get = function() return cfg.swimSpeed end,
      set = function(v)
          cfg.swimSpeed = v
          SetSwimMultiplierForPlayer(PlayerId(), v * 1.0)
          act("Swim speed x" .. v)
      end },
    { kind = "toggle", label = "Super Jump", desc = "Applied every frame while enabled",
      get = function() return toggles.superJump end,
      set = toggleFeature("superJump", nil, "Super jump") },
    { kind = "toggle", label = "Disable Ragdoll", desc = "Stop the ped from going limp",
      get = function() return toggles.noRagdoll end,
      set = function(on)
          toggles.noRagdoll = on
          if not on then SetPedCanRagdoll(ped(), true) end
          act("Ragdoll " .. (on and "disabled" or "enabled"))
      end },
    { kind = "slider", label = "Set Health", min = 0, max = 200, step = 5,
      desc = "Write health directly — a big jump is a detection signal",
      get = function() return cfg.setHealth end,
      set = function(v)
          cfg.setHealth = v
          SetEntityHealth(ped(), v)
          act("Health set to " .. v)
      end },
    { kind = "slider", label = "Set Armour", min = 0, max = 100, step = 5,
      desc = "Write armour directly",
      get = function() return cfg.setArmour end,
      set = function(v)
          cfg.setArmour = v
          SetPedArmour(ped(), v)
          act("Armour set to " .. v)
      end },
    { kind = "button", label = "Heal Fully", desc = "Health 200, armour 100",
      action = function()
          SetEntityHealth(ped(), 200)
          SetPedArmour(ped(), 100)
          cfg.setHealth, cfg.setArmour = 200, 100
          act("Healed to full", "success")
      end },
}},

{ section = "Teleport",
  note = "The same jump down either code path, so you can check your detector sees both",
  items = {
    { kind = "selector", label = "Teleport Method",
      choices = { "Native (SetEntityCoords)", "Ham (setPosition)" },
      desc = "Which path a jump takes — check whether your detector sees both",
      get = function() return cfg.telMethod end,
      set = function(v) cfg.telMethod = v; log("Teleport method: " .. v) end },
    { kind = "slider", label = "Vertical Offset", min = 0, max = 100, step = 5,
      desc = "Added to the target Z, e.g. to land above ground",
      get = function() return cfg.telOffset end,
      set = function(v) cfg.telOffset = v; log("Teleport Z offset " .. v) end },
    { kind = "button", label = "Teleport to Coords...",
      desc = "Type a coordinate triple to jump to",
      action = function()
          local x, y, z = coords()
          promptFor("Teleport", "X, Y, Z:",
              ("%.1f, %.1f, %.1f"):format(x, y, z), 100, function(text)
                  local tx, ty, tz = text:match(
                      "(-?%d+%.?%d*)%s*,%s*(-?%d+%.?%d*)%s*,%s*(-?%d+%.?%d*)")
                  if not tx then
                      act("Could not parse coordinates", "error")
                      return
                  end
                  teleport(tonumber(tx), tonumber(ty), tonumber(tz), "manual")
              end)
      end },
    { kind = "button", label = "Teleport to Waypoint", desc = "Jump to the map marker",
      action = function()
          local blip = GetFirstBlipInfoId(8)
          if not DoesBlipExist(blip) then
              act("No waypoint set", "error")
              return
          end
          local c = GetBlipInfoIdCoord(blip)
          teleport(c.x, c.y, groundAt(c.x, c.y, c.z), "waypoint")
      end },
    { kind = "group", label = "Teleport Slots",
      desc = "Store and recall up to three positions",
      items = {
        { kind = "button", label = "Save Slot 1", action = function() saveSlot(1) end },
        { kind = "button", label = "Load Slot 1", action = function() loadSlot(1) end },
        { kind = "button", label = "Save Slot 2", action = function() saveSlot(2) end },
        { kind = "button", label = "Load Slot 2", action = function() loadSlot(2) end },
        { kind = "button", label = "Save Slot 3", action = function() saveSlot(3) end },
        { kind = "button", label = "Load Slot 3", action = function() loadSlot(3) end },
        { kind = "button", label = "Print All Slots", action = function()
            for i = 1, 3 do
                local s = slots[i]
                print(("  slot %d: %s"):format(i,
                    s and ("%.1f %.1f %.1f"):format(s.x, s.y, s.z) or "empty"))
            end
            act("Slots printed")
        end },
      }},
    { kind = "group", label = "Quick Locations", desc = "Jump to well-known spots",
      items = {
        { kind = "button", label = "Airport",
          action = function() teleport(-1336.0, -3044.0, 13.9, "airport") end },
        { kind = "button", label = "Pier",
          action = function() teleport(-1850.0, -1231.0, 13.0, "pier") end },
        { kind = "button", label = "Mount Chiliad",
          action = function() teleport(450.0, 5566.0, 806.0, "chiliad") end },
        { kind = "button", label = "Legion Square",
          action = function() teleport(215.0, -810.0, 31.0, "legion") end },
        { kind = "button", label = "Sandy Shores",
          action = function() teleport(1704.0, 3760.0, 34.7, "sandy") end },
        { kind = "button", label = "Paleto Bay",
          action = function() teleport(-160.0, 6316.0, 31.6, "paleto") end },
        { kind = "button", label = "Casino",
          action = function() teleport(925.0, 46.0, 81.1, "casino") end },
        { kind = "button", label = "Maze Bank Roof",
          action = function() teleport(-75.0, -818.0, 326.2, "maze bank") end },
      }},
}},

{ section = "Vehicle",
  note = "Spawn and manipulate a vehicle under the same log timestamps",
  items = {
    { kind = "text", label = "Vehicle Model", placeholder = "e.g. adder, sultan, police",
      desc = "Spawn name for the button below",
      get = function() return cfg.vehicleModel end,
      set = function(v) cfg.vehicleModel = v or "" end },
    { kind = "button", label = "Spawn Vehicle", desc = "Spawn the model above and get in",
      action = function() spawnModel(cfg.vehicleModel) end },
    { kind = "group", label = "Quick Spawn", desc = "Common models, one click each",
      items = (function()
          local items = {}
          for _, name in ipairs({ "adder", "zentorno", "t20", "sultan", "kuruma",
                                  "police", "ambulance", "firetruk", "buzzard",
                                  "lazer", "rhino", "blista" }) do
              items[#items + 1] = { kind = "button", label = name,
                                    action = function() spawnModel(name) end }
          end
          return items
      end)() },
    { kind = "button", label = "Repair Vehicle", desc = "Fix damage and deformation",
      action = function()
          local v = requireVehicle("repair"); if not v then return end
          SetVehicleFixed(v); SetVehicleDeformationFixed(v)
          act("Vehicle repaired", "success")
      end },
    { kind = "button", label = "Clean Vehicle", desc = "Wash the dirt off",
      action = function()
          local v = requireVehicle("clean"); if not v then return end
          SetVehicleDirtLevel(v, 0.0)
          act("Vehicle cleaned", "success")
      end },
    { kind = "button", label = "Flip Upright", desc = "Put the vehicle back on its wheels",
      action = function()
          local v = requireVehicle("flip"); if not v then return end
          SetVehicleOnGroundProperly(v)
          act("Vehicle flipped upright", "success")
      end },
    { kind = "button", label = "Delete Vehicle", desc = "Remove the current vehicle",
      action = function()
          local v = requireVehicle("delete"); if not v then return end
          SetEntityAsMissionEntity(v, true, true)
          DeleteVehicle(v)
          act("Vehicle deleted", "success")
      end },
    { kind = "button", label = "Max Upgrades", desc = "Fit every mod at its highest level",
      action = function()
          local v = requireVehicle("tuning"); if not v then return end
          SetVehicleModKit(v, 0)
          for modType = 0, 16 do
              local count = GetNumVehicleMods(v, modType)
              if count and count > 0 then SetVehicleMod(v, modType, count - 1, false) end
          end
          ToggleVehicleMod(v, 18, true)
          act("Max upgrades applied", "success")
      end },
    { kind = "button", label = "Set Plate...", desc = "Type a new number plate",
      action = function()
          local v = requireVehicle("plate"); if not v then return end
          promptFor("Number Plate", "Text:", "LUCHS", 8, function(text)
              SetVehicleNumberPlateText(v, text)
              act("Plate set to " .. text, "success")
          end)
      end },
    { kind = "button", label = "Boost Forward", desc = "Double the current velocity",
      action = function()
          local v = requireVehicle("boost"); if not v then return end
          local vel = GetEntityVelocity(v)
          SetEntityVelocity(v, vel.x * 2.0, vel.y * 2.0, vel.z)
          act("Velocity doubled")
      end },
}},

{ section = "World",
  note = "Time and weather, forced locally",
  items = {
    { kind = "selector", label = "Time of Day",
      choices = { "Morning", "Noon", "Evening", "Night" },
      desc = "Override the in-game clock",
      get = function() return cfg.timeOfDay end,
      set = function(v)
          cfg.timeOfDay = v
          local hours = { Morning = 7, Noon = 12, Evening = 19, Night = 0 }
          cfg.hour = hours[v]
          NetworkOverrideClockTime(hours[v], 0, 0)
          act("Time set to " .. v)
      end },
    { kind = "slider", label = "Hour", min = 0, max = 23, step = 1,
      desc = "Set the hour precisely",
      get = function() return cfg.hour end,
      set = function(v)
          cfg.hour = v
          NetworkOverrideClockTime(v, 0, 0)
          log("Clock set to " .. v .. ":00")
      end },
    { kind = "selector", label = "Weather",
      choices = { "CLEAR", "EXTRASUNNY", "CLOUDS", "OVERCAST", "RAIN",
                  "THUNDER", "SMOG", "FOGGY", "SNOW", "BLIZZARD" },
      desc = "Force a weather type",
      get = function() return cfg.weather end,
      set = function(v)
          cfg.weather = v
          SetWeatherTypeNowPersist(v)
          act("Weather set to " .. v)
      end },
    { kind = "toggle", label = "Disable Weather Sync",
      desc = "Stop the server driving local weather",
      get = function() return toggles.disableWeather end,
      set = function(on)
          toggles.disableWeather = on
          ham("disableWeather", on)
          act("Weather sync " .. (on and "disabled" or "enabled"))
      end },
}},

{ section = "Weapons",
  note = "Inventory writes, another thing a server usually reconciles",
  items = {
    { kind = "text", label = "Weapon Name", placeholder = "WEAPON_...",
      desc = "Weapon hash name for the button below",
      get = function() return cfg.weaponName end,
      set = function(v) cfg.weaponName = v or "" end },
    { kind = "button", label = "Give Weapon",
      desc = "Give the weapon named above with 250 rounds",
      action = function()
          if cfg.weaponName == "" then
              act("Enter a weapon name first", "error")
              return
          end
          GiveWeaponToPed(ped(), GetHashKey(cfg.weaponName), 250, false, true)
          act("Gave " .. cfg.weaponName, "success")
      end },
    { kind = "group", label = "Weapon Packs", desc = "Give a themed set of weapons at once",
      items = {
        { kind = "button", label = "Pistols", action = function()
            giveWeapons({ "WEAPON_PISTOL", "WEAPON_COMBATPISTOL", "WEAPON_APPISTOL" },
                250, "Pistols")
        end },
        { kind = "button", label = "Rifles", action = function()
            giveWeapons({ "WEAPON_ASSAULTRIFLE", "WEAPON_CARBINERIFLE",
                          "WEAPON_SPECIALCARBINE" }, 250, "Rifles")
        end },
        { kind = "button", label = "Melee", action = function()
            giveWeapons({ "WEAPON_BAT", "WEAPON_KNIFE", "WEAPON_CROWBAR" }, 1, "Melee")
        end },
        { kind = "button", label = "Throwables", action = function()
            giveWeapons({ "WEAPON_GRENADE", "WEAPON_SMOKEGRENADE", "WEAPON_MOLOTOV" },
                25, "Throwables")
        end },
      }},
    { kind = "toggle", label = "Infinite Ammo",
      desc = "Refill the equipped weapon every frame",
      get = function() return toggles.infiniteAmmo end,
      set = function(on)
          toggles.infiniteAmmo = on
          if not on then SetPedInfiniteAmmo(ped(), false, GetSelectedPedWeapon(ped())) end
          act("Infinite ammo " .. onOff(on))
      end },
    { kind = "button", label = "Remove All Weapons", desc = "Strip the ped's inventory",
      action = function()
          RemoveAllPedWeapons(ped(), true)
          act("Weapons removed", "success")
      end },
}},

{ section = "Inspector",
  note = "What the server is running, holding and firing",
  items = {
    { kind = "slider", label = "Dump Line Limit", min = 5, max = 200, step = 5,
      desc = "How many lines a dump prints to the console",
      get = function() return cfg.dumpLimit end,
      set = function(v) cfg.dumpLimit = v end },
    { kind = "group", label = "Dumps", desc = "Print server-side inventories to the console",
      items = {
        { kind = "button", label = "Resources",
          action = function() dumpArray("Resources", ham("getResources")) end },
        { kind = "button", label = "Injectable Resources",
          action = function() dumpArray("Injectable resources", ham("getInjectableResources")) end },
        { kind = "button", label = "Safe Resources",
          action = function() dumpArray("Safe resources", ham("getSafeResources")) end },
        { kind = "button", label = "State Bags", action = dumpStateBags },
        { kind = "button", label = "Triggered Events",
          action = function() dumpEventMap("Triggered events", ham("getAllEvents")) end },
        { kind = "button", label = "Registered Events",
          action = function() dumpEventMap("Registered events", ham("getAllRegisteredEvents")) end },
        { kind = "button", label = "Ped Model Names",
          action = function() dumpArray("Ped models", ham("getPedModelNames")) end },
      }},
    { kind = "text", label = "Resource Name", placeholder = "resource to check",
      desc = "Name for the resource check below",
      get = function() return cfg.resourceQuery end,
      set = function(v) cfg.resourceQuery = v or "" end },
    { kind = "button", label = "Check Resource",
      desc = "Ask whether a resource exists on this server",
      action = function()
          if cfg.resourceQuery == "" then
              act("Enter a resource name first", "error")
              return
          end
          local exists = ham("hasResource", cfg.resourceQuery)
          act(("Resource '%s': %s"):format(cfg.resourceQuery,
              exists and "present" or "absent"), exists and "success" or "info")
      end },
    { kind = "button", label = "Find Event...", desc = "Search the event inventory by substring",
      action = function()
          promptFor("Find Event", "Partial event name:", "", 120, function(text)
              if text == "" then return end
              local found = ham("findEvent", text)
              if type(found) == "table" and found.event then
                  act(("Found %s in %s"):format(found.event, tostring(found.resource)),
                      "success")
                  print(("  event    : %s"):format(found.event))
                  print(("  resource : %s"):format(tostring(found.resource)))
              else
                  act("No event matched '" .. text .. "'", "error")
              end
          end)
      end },
    { kind = "button", label = "Copy Last Dump",
      desc = "Put the most recent dump on the system clipboard",
      action = function() copyText("Dump", lastDump) end },
}},

{ section = "HTTP",
  note = "Talk to your collector by hand",
  items = {
    { kind = "text", label = "URL", placeholder = "https://your-server/endpoint",
      desc = "Target for the requests below",
      get = function() return cfg.httpUrl end,
      set = function(v) cfg.httpUrl = v or "" end },
    { kind = "text", label = "POST Body", placeholder = '{"test": true}',
      desc = "Request body sent with POST",
      get = function() return cfg.httpBody end,
      set = function(v) cfg.httpBody = v or "" end },
    { kind = "group", label = "Send Request",
      desc = "Synchronous calls block the frame; async ones resolve in the render loop",
      items = {
        { kind = "button", label = "GET (sync)",   action = function() httpSync("GET") end },
        { kind = "button", label = "POST (sync)",  action = function() httpSync("POST") end },
        { kind = "button", label = "GET (async)",  action = function() httpAsync("GET") end },
        { kind = "button", label = "POST (async)", action = function() httpAsync("POST") end },
      }},
    { kind = "button", label = "Copy Last Response",
      desc = "Put the last response body on the clipboard",
      action = function() copyText("Response", lastResponse) end },
    { kind = "button", label = "Open URL in Browser",
      desc = "Hand the URL to the default browser",
      action = function()
          if cfg.httpUrl:sub(1, 4) ~= "http" then
              act("URL must start with http:// or https://", "error")
              return
          end
          ham("openUrl", cfg.httpUrl)
          act("Opened in browser")
      end },
}},

{ section = "Anti-Cheat Detection",
  note = "Which anti-cheat Ham sees here — read and reported, never branched on",
  items = {
    { kind = "button", label = "Detect Anti-Cheats",
      desc = "Ask Ham which anti-cheats it recognises here",
      action = function() detectAntiCheats(true) end },
    { kind = "button", label = "Print Anti-Cheat Report",
      desc = "Presence, count, names and the shape the build answered in",
      action = function() print(antiCheatReport()); act("Anti-cheat report printed") end },
    { kind = "button", label = "Copy Anti-Cheat Report",
      desc = "Put the anti-cheat report on the system clipboard",
      action = function() copyText("Anti-cheat report", antiCheatReport()) end },
}},

{ section = "Advanced",
  note = "Overlay, fonts, input, raw execution and the export bundle",
  items = {
    { kind = "toggle", label = "Show Overlay",
      desc = "Master switch for everything drawn on screen",
      get = function() return cfg.overlay end,
      set = function(on) cfg.overlay = on end },
    { kind = "selector", label = "Overlay Corner",
      choices = { "Top Right", "Top Left", "Bottom Left", "Bottom Right" },
      desc = "Where the panel sits",
      get = function() return cfg.corner end,
      set = function(v) cfg.corner = v end },
    { kind = "slider", label = "Overlay Font Size", min = 10, max = 26, step = 1,
      desc = "Overlay text size",
      get = function() return cfg.fontSize end,
      set = function(v) cfg.fontSize = v end },
    { kind = "toggle", label = "Status Panel",
      desc = "Position, speed, health and active flags",
      get = function() return cfg.showStatus end,
      set = function(on) cfg.showStatus = on end },
    { kind = "toggle", label = "Movement Panel",
      desc = "Per-frame delta, implied speed and the jump counter",
      get = function() return cfg.showMovement end,
      set = function(on) cfg.showMovement = on end },
    { kind = "toggle", label = "Monitor Panel",
      desc = "Baseline age and what the last diff found",
      get = function() return cfg.showMonitors end,
      set = function(on) cfg.showMonitors = on end },
    { kind = "toggle", label = "Calibration Panel",
      desc = "Sample count and the threshold the distribution suggests",
      get = function() return cfg.showCalibration end,
      set = function(on) cfg.showCalibration = on end },
    { kind = "toggle", label = "Scenario Panel",
      desc = "Live progress of the running ladder",
      get = function() return cfg.showScenario end,
      set = function(on) cfg.showScenario = on end },
    { kind = "toggle", label = "Action Log",
      desc = "Timestamped list of the last actions taken",
      get = function() return cfg.showLog end,
      set = function(on) cfg.showLog = on end },
    { kind = "toggle", label = "Input Panel",
      desc = "Live mouse position and held modifier keys",
      get = function() return cfg.showInput end,
      set = function(on) cfg.showInput = on end },
    { kind = "toggle", label = "Shape Demo",
      desc = "Draw the selected primitive in the middle of the screen",
      get = function() return cfg.showShapes end,
      set = function(on) cfg.showShapes = on end },
    { kind = "selector", label = "Demo Shape",
      choices = { "Rect Outline", "Rect Filled", "Gradient", "Circle",
                  "Circle Filled", "Line", "Text" },
      desc = "Which Ham drawing call to exercise",
      get = function() return cfg.shape end,
      set = function(v) cfg.shape = v end },
    { kind = "slider", label = "Shape Red", min = 0, max = 255, step = 5,
      desc = "Demo colour, red channel",
      get = function() return cfg.shapeR end, set = function(v) cfg.shapeR = v end },
    { kind = "slider", label = "Shape Green", min = 0, max = 255, step = 5,
      desc = "Demo colour, green channel",
      get = function() return cfg.shapeG end, set = function(v) cfg.shapeG = v end },
    { kind = "slider", label = "Shape Blue", min = 0, max = 255, step = 5,
      desc = "Demo colour, blue channel",
      get = function() return cfg.shapeB end, set = function(v) cfg.shapeB = v end },
    { kind = "slider", label = "Shape Thickness", min = 1, max = 20, step = 1,
      desc = "Outline thickness",
      get = function() return cfg.thickness end, set = function(v) cfg.thickness = v end },
    { kind = "selector", label = "Font",
      choices = { "Default", "Rubik", "Font Awesome", "Consolas" },
      desc = "Load and activate one of the built-in fonts",
      get = function() return cfg.font end, set = setFontChoice },
    { kind = "button", label = "Reset Font", desc = "Go back to the default font",
      action = function() cfg.font = "Default"; ham("resetFont"); act("Font reset") end },
    { kind = "toggle", label = "Show Mouse Cursor",
      desc = "Show and enable the mouse cursor",
      get = function() return toggles.showCursor end,
      set = function(on)
          toggles.showCursor = on
          ham("toggleMouse", on)
          act("Mouse cursor " .. onOff(on))
      end },
    { kind = "toggle", label = "Block Game Input",
      desc = "Stop keystrokes reaching the game while an overlay has focus",
      get = function() return toggles.blockInput end,
      set = function(on)
          toggles.blockInput = on
          ham("toggleInputBlock", on)
          act("Game input " .. (on and "blocked" or "released"))
      end },
    { kind = "text", label = "Execute Context", placeholder = 'resource name or "isolated"',
      desc = "Which resource context Execute runs in",
      get = function() return cfg.execResource end,
      set = function(v) cfg.execResource = (v ~= "" and v) or "isolated" end },
    { kind = "button", label = "Execute Lua...",
      desc = "Run Lua inside a resource context — the primitive a detector most wants to catch",
      action = function()
          promptFor("Execute Lua", "Code:",
              'print("hello from " .. GetCurrentResourceName())', 500, function(text)
                  if text == "" then return end
                  local ok = ham("Execute", cfg.execResource, text)
                  act(("Execute in '%s': %s"):format(cfg.execResource,
                      ok and "ok" or "failed"), ok and "success" or "error")
              end)
      end },
    { kind = "button", label = "Clipboard to Console",
      desc = "Read the system clipboard into the console",
      action = function()
          print("---- clipboard ----")
          print(truncate(tostring(ham("getClipboard")), 2000))
          act("Clipboard printed")
      end },
    { kind = "button", label = "Print Session Info", action = printSessionInfo,
      desc = "Dump account, server and client details to the console" },
    { kind = "button", label = "Print Export Bundle",
      desc = "One JSON document with the snapshot, calibration, diff, run and log",
      action = function()
          local body = exportBundle()
          print("---- export bundle ----")
          print(body)
          act(("Export bundle printed (%d bytes)"):format(#body), "success")
      end },
    { kind = "button", label = "Copy Export Bundle",
      desc = "Put the whole export bundle on the system clipboard",
      action = function() copyText("Export bundle", exportBundle()) end },
    { kind = "button", label = "Send Export Bundle", action = sendExportBundle,
      desc = "POST the export bundle to the telemetry endpoint" },
    { kind = "button", label = "Clear Action Log", desc = "Empty the on-screen action log",
      action = function() clearLog() end },
    { kind = "button", label = "Reset Everything", action = resetEverything,
      desc = "Turn every feature back off and zero the counters" },
}},

}

--------------------------------------------------------------------------------
-- Spec helpers shared by both front ends
--------------------------------------------------------------------------------

local function itemChoices(item)
    local c = item.choices
    if type(c) == "function" then return c() end
    return c or {}
end

-- Index of the currently selected choice, always at least 1 so a front end
-- never has to deal with "selected nothing".
local function choiceIndex(item)
    local choices, current = itemChoices(item), item.get and item.get()
    for i, name in ipairs(choices) do
        if name == current then return i end
    end
    return 1
end

-- Wraps at both ends: stepping past the last choice lands on the first.
local function stepChoice(item, direction)
    local choices = itemChoices(item)
    if #choices == 0 then return end
    local index = choiceIndex(item) + direction
    while index > #choices do index = index - #choices end
    while index < 1 do index = index + #choices end
    item.set(choices[index])
end

local function specSections()
    local names = {}
    for _, s in ipairs(SPEC) do names[#names + 1] = s.section end
    return names
end

-- Flat list of every addressable feature, "Section/Label" (and "Section/Group/Label"
-- for group members). This is what the parity test compares between the two files.
local function specFeatureIds()
    local ids = {}
    for _, s in ipairs(SPEC) do
        for _, item in ipairs(s.items) do
            if item.kind == "group" then
                for _, sub in ipairs(item.items) do
                    ids[#ids + 1] = ("%s/%s/%s"):format(s.section, item.label, sub.label)
                end
            else
                ids[#ids + 1] = ("%s/%s"):format(s.section, item.label)
            end
        end
    end
    table.sort(ids)
    return ids
end

--------------------------------------------------------------------------------
-- <<< SHARED ENGINE END >>>
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- Front end: the drawn GUI
--------------------------------------------------------------------------------
-- One Vanity control exists — "Launch Menu". Everything else lives in a window
-- drawn with Ham primitives and driven by the mouse.
--
-- Three rules this front end has to keep and the tests hold it to:
--
--   Input goes back.   The moment the window is not up — hidden, a draw error,
--                      or this loop retiring after a re-Execute — the cursor
--                      and the input block are handed back. A player left with
--                      a captured mouse and no window has to restart the game.
--
--   No Wait in pcall.  Drawing runs inside pcall so a bad frame cannot take the
--                      loop down with it, and yielding across that boundary is
--                      not portable between LuaJIT and 5.4. So a click never
--                      runs its action during the draw: it is queued and run
--                      afterwards, outside the protected call, where an action
--                      that Waits (loading a model, say) is safe.
--
--   Nothing sticks.    A slider being dragged is released whenever the button
--                      comes up, the tab changes or the window closes, so a
--                      drag started on one tab cannot keep writing to a widget
--                      the user can no longer see.

local GUI_BASE_W    = 760
local GUI_BASE_H    = 560
local GUI_MARGIN    = 20
local GUI_ANIM_SPEED = 12.0   -- e-folds per second

local GUI_COLORS = {
    shadow    = { 0, 0, 0, 120 },
    panel     = { 14, 16, 21, 242 },
    header    = { 20, 24, 32, 255 },
    tabIdle   = { 20, 23, 30, 255 },
    tabActive = { 32, 40, 54, 255 },
    rowAlt    = { 18, 21, 27, 255 },
    rowHover  = { 30, 38, 50, 255 },
    accent    = { 120, 200, 255, 255 },
    label     = { 176, 184, 196, 255 },
    value     = { 235, 238, 242, 255 },
    dim       = { 110, 116, 126, 255 },
    on        = { 120, 230, 150, 255 },
    off       = { 70, 76, 88, 255 },
    track     = { 40, 46, 58, 255 },
    outline   = { 0, 0, 0, 220 },
}

-- Virtual key codes, per docs/ham/key-codes.md. Home/End/Page Up/Page Down are
-- listed there; F5-F8 are the standard 0x70+ function-key block of the same
-- Windows table.
local TOGGLE_KEYS = {
    { name = "F5", vk = 0x74 },
    { name = "F6", vk = 0x75 },
    { name = "F7", vk = 0x76 },
    { name = "F8", vk = 0x77 },
    { name = "Home", vk = 0x24 },
    { name = "End", vk = 0x23 },
    { name = "Page Up", vk = 0x21 },
    { name = "Page Down", vk = 0x22 },
}

local gui = {
    visible   = false,
    anim      = 0.0,
    tab       = 1,
    scroll    = {},
    scalePct  = 100,
    toggleKey = TOGGLE_KEYS[1].name,
    drag      = nil,
    grabbed   = false,
    lastFrame = nil,
    keyWasDown = false,
    errorShown = false,
}

-- Clicks are queued here during the draw and run after it, outside pcall.
local queued = {}

local function enqueue(fn)
    queued[#queued + 1] = fn
end

--------------------------------------------------------------------------------
-- Input
--------------------------------------------------------------------------------

local getMousePos     = hamFn("getMousePos")
local isMouseClicked  = hamFn("isMouseClicked")
local isMouseDown     = hamFn("isMouseDown")
local getKeyState     = hamFn("getKeyState")

local mouse = { x = 0.0, y = 0.0, down = false, clicked = false, wasDown = false }

local function readMouse()
    if getMousePos then
        local x, y = getMousePos()
        mouse.x, mouse.y = x or 0.0, y or 0.0
    end

    local down
    if isMouseDown then
        down = isMouseDown(0) and true or false
    elseif getKeyState then
        down = getKeyState(0x01) ~= 0
    else
        down = false
    end

    -- Derive the press edge ourselves as well as asking for it: a build without
    -- isMouseClicked still gets working buttons.
    local clicked = down and not mouse.wasDown
    if isMouseClicked and isMouseClicked(0) then clicked = true end

    mouse.wasDown, mouse.down, mouse.clicked = down, down, clicked
end

local function toggleKeyEntry()
    for _, k in ipairs(TOGGLE_KEYS) do
        if k.name == gui.toggleKey then return k end
    end
    return TOGGLE_KEYS[1]
end

local function toggleKeyPressed()
    if not getKeyState then return false end
    local down = getKeyState(toggleKeyEntry().vk) ~= 0
    local pressed = down and not gui.keyWasDown
    gui.keyWasDown = down
    return pressed
end

--------------------------------------------------------------------------------
-- Input capture
--------------------------------------------------------------------------------

local function grabInput(on)
    if gui.grabbed == on then return end
    gui.grabbed = on
    ham("toggleMouse", on)
    ham("toggleInputBlock", on)
end

local function setVisible(on)
    gui.visible = on
    gui.drag = nil            -- never leave a drag live across a close
    grabInput(on)
    if on then gui.errorShown = false end
end

--------------------------------------------------------------------------------
-- Geometry
--------------------------------------------------------------------------------

local function guiScale() return gui.scalePct / 100.0 end

-- The window is clamped to the screen on both axes, so no scale can push an
-- edge off-screen; at large scales the content area simply holds fewer rows.
local function windowRect()
    local resW, resH = 1920, 1080
    if getResolution then
        local w, h = getResolution()
        resW, resH = w or 1920, h or 1080
    end

    local s = guiScale()
    local w = math.min(GUI_BASE_W * s, resW - GUI_MARGIN * 2)
    local h = math.min(GUI_BASE_H * s, resH - GUI_MARGIN * 2)
    local x = (resW - w) / 2
    local y = (resH - h) / 2

    if x < GUI_MARGIN then x = GUI_MARGIN end
    if y < GUI_MARGIN then y = GUI_MARGIN end
    if x + w > resW - GUI_MARGIN then x = resW - GUI_MARGIN - w end
    if y + h > resH - GUI_MARGIN then y = resH - GUI_MARGIN - h end

    return x, y, w, h, resW, resH
end

local function guiMeasure(text, size)
    if not getTextWidth then return #tostring(text) * (size * 0.55) end
    local w = getTextWidth(tostring(text))
    return (w or 0) * (size / 12.0)
end

local function hit(x, y, w, h)
    return mouse.x >= x and mouse.x <= x + w and mouse.y >= y and mouse.y <= y + h
end

--------------------------------------------------------------------------------
-- Tabs
--------------------------------------------------------------------------------
-- Every spec section becomes a tab, plus one for the window's own settings. The
-- window tab is deliberately outside SPEC: it configures this front end, not the
-- bench, and the parity test would otherwise see the two scripts disagree.

local function toggleKeyNames()
    local names = {}
    for _, k in ipairs(TOGGLE_KEYS) do names[#names + 1] = k.name end
    return names
end

local windowSection = {
    section = "Window",
    note = "This window's own settings — not part of the feature spec",
    items = {
        { kind = "slider", label = "Window Scale", min = 50, max = 200, step = 5,
          desc = "Window size in percent; it is always clamped to the screen",
          get = function() return gui.scalePct end,
          set = function(v) gui.scalePct = v end },
        { kind = "selector", label = "Toggle Key", choices = toggleKeyNames,
          desc = "Key that shows and hides this window",
          get = function() return gui.toggleKey end,
          set = function(v)
              gui.toggleKey = v
              -- Treat the new key as already held so rebinding onto a key that
              -- happens to be down does not immediately close the window.
              gui.keyWasDown = true
          end },
        { kind = "button", label = "Hide Menu",
          desc = "Close the window and hand the mouse back to the game",
          action = function() setVisible(false) end },
    },
}

local TABS = {}
for _, section in ipairs(SPEC) do TABS[#TABS + 1] = section end
TABS[#TABS + 1] = windowSection

-- Groups flatten into a heading plus their buttons: a submenu in the menu front
-- end, an indented block here.
local function tabRows(section)
    local rows = {}
    for _, item in ipairs(section.items) do
        if item.kind == "group" then
            rows[#rows + 1] = { kind = "group", label = item.label, desc = item.desc }
            for _, sub in ipairs(item.items) do
                rows[#rows + 1] = { kind = "button", item = sub, indent = true }
            end
        else
            rows[#rows + 1] = { kind = item.kind, item = item }
        end
    end
    return rows
end

local function currentTab()
    if gui.tab < 1 or gui.tab > #TABS then gui.tab = 1 end
    return TABS[gui.tab]
end

local function setTab(index)
    if index == gui.tab then return end
    gui.tab = index
    -- A drag must not survive the tab that started it, or it keeps writing to a
    -- widget that is no longer on screen.
    gui.drag = nil
end

--------------------------------------------------------------------------------
-- Drawing
--------------------------------------------------------------------------------

local function quantise(item, raw)
    local step = item.step or 1
    local value = item.min + math.floor((raw - item.min) / step + 0.5) * step
    if value < item.min then value = item.min end
    if value > item.max then value = item.max end
    return value
end

local function drawWindow()
    local x, y, w, h, resW, resH = windowRect()
    local s = guiScale()
    local alpha = gui.anim

    -- The window rises into place as it fades in; both are driven by the same
    -- eased value, so neither depends on the frame rate.
    y = y + (1.0 - alpha) * 24 * s

    local function col(c, mul)
        local a = (c[4] or 255) * (mul or 1.0) * alpha
        return { c[1], c[2], c[3], math.floor(a + 0.5) }
    end

    local font    = math.max(10, math.min(28, 14 * s))
    local small   = math.max(9, font - 2)
    local titleH  = 36 * s
    local tabW    = 190 * s
    local pad     = 12 * s
    local rowH    = 30 * s
    local footerH = 26 * s
    local barW    = 16 * s

    local active = gui.visible and alpha > 0.6

    drawRectFilled({ x + 3 * s, y + 3 * s, w, h }, col(GUI_COLORS.shadow), 8 * s, 0)
    drawRectFilled({ x, y, w, h }, col(GUI_COLORS.panel), 8 * s, 0)
    drawRectFilled({ x, y, w, titleH }, col(GUI_COLORS.header), 8 * s, 0)
    if drawLine then
        drawLine({ x, y + titleH }, { x + w, y + titleH }, col(GUI_COLORS.accent), 2)
    end

    drawText(SCRIPT_NAME, { x + pad, y + titleH * 0.3 }, col(GUI_COLORS.accent),
        font, false, true, GUI_COLORS.outline)

    -- Close box, top right of the title bar.
    local closeSize = titleH * 0.5
    local closeX, closeY = x + w - pad - closeSize, y + (titleH - closeSize) / 2
    local closeHot = active and hit(closeX, closeY, closeSize, closeSize)
    drawRectFilled({ closeX, closeY, closeSize, closeSize },
        col(closeHot and GUI_COLORS.rowHover or GUI_COLORS.tabIdle), 4 * s, 0)
    drawText("x", { closeX + closeSize * 0.5, closeY + closeSize * 0.1 },
        col(GUI_COLORS.value), small, true, true, GUI_COLORS.outline)
    if closeHot and mouse.clicked then enqueue(function() setVisible(false) end) end

    -- Tab column.
    local tabsTop = y + titleH
    local tabsH = h - titleH
    local tabH = math.min(rowH, tabsH / #TABS)
    drawRectFilled({ x, tabsTop, tabW, tabsH }, col(GUI_COLORS.tabIdle), 0, 0)

    for i, section in ipairs(TABS) do
        local ty = tabsTop + (i - 1) * tabH
        local selected = (i == gui.tab)
        local hot = active and hit(x, ty, tabW, tabH)
        if selected or hot then
            drawRectFilled({ x, ty, tabW, tabH },
                col(selected and GUI_COLORS.tabActive or GUI_COLORS.rowHover), 0, 0)
        end
        if selected and drawLine then
            drawLine({ x, ty }, { x, ty + tabH }, col(GUI_COLORS.accent), 3)
        end
        drawText(section.section, { x + pad, ty + (tabH - font) * 0.5 },
            col(selected and GUI_COLORS.value or GUI_COLORS.label),
            font, false, true, GUI_COLORS.outline)
        if hot and mouse.clicked then
            local index = i
            enqueue(function() setTab(index) end)
        end
    end

    -- Content area.
    local cx = x + tabW
    local cy = tabsTop
    local cw = w - tabW
    local ch = tabsH - footerH

    local section = currentTab()
    local rows = tabRows(section)

    drawText(section.note or "", { cx + pad, cy + 6 * s },
        col(GUI_COLORS.dim), small, false, true, GUI_COLORS.outline)

    local listTop = cy + 6 * s + small + 8 * s
    local listH = ch - (listTop - cy)
    local visible = math.max(1, math.floor(listH / rowH))

    local scroll = gui.scroll[gui.tab] or 0
    local maxScroll = math.max(0, #rows - visible)
    if scroll > maxScroll then scroll = maxScroll end
    if scroll < 0 then scroll = 0 end
    gui.scroll[gui.tab] = scroll

    local rowW = cw - pad * 2 - (maxScroll > 0 and barW or 0)
    local labelW = rowW * 0.46
    local ctrlX = cx + pad + labelW
    local ctrlW = rowW - labelW

    for slot = 1, visible do
        local index = slot + scroll
        local row = rows[index]
        if row then
            local ry = listTop + (slot - 1) * rowH
            local hot = active and hit(cx + pad, ry, rowW, rowH)
            local textY = ry + (rowH - font) * 0.5

            if index % 2 == 0 then
                drawRectFilled({ cx + pad, ry, rowW, rowH }, col(GUI_COLORS.rowAlt), 4 * s, 0)
            end
            if hot and row.kind ~= "group" then
                drawRectFilled({ cx + pad, ry, rowW, rowH }, col(GUI_COLORS.rowHover), 4 * s, 0)
            end

            if row.kind == "group" then
                drawText(row.label, { cx + pad, textY }, col(GUI_COLORS.accent),
                    font, false, true, GUI_COLORS.outline)

            elseif row.kind == "button" then
                local item = row.item
                drawText((row.indent and "   " or "") .. item.label,
                    { cx + pad + 6 * s, textY }, col(GUI_COLORS.value),
                    font, false, true, GUI_COLORS.outline)
                drawText(">", { cx + pad + rowW - 14 * s, textY },
                    col(GUI_COLORS.dim), font, false, true, GUI_COLORS.outline)
                if hot and mouse.clicked then enqueue(item.action) end

            elseif row.kind == "toggle" then
                local item = row.item
                local on = item.get() and true or false
                drawText(item.label, { cx + pad + 6 * s, textY }, col(GUI_COLORS.label),
                    font, false, true, GUI_COLORS.outline)
                local pillW, pillH = 44 * s, 18 * s
                local px = cx + pad + rowW - pillW - 8 * s
                local py = ry + (rowH - pillH) / 2
                drawRectFilled({ px, py, pillW, pillH },
                    col(on and GUI_COLORS.on or GUI_COLORS.off), pillH * 0.5, 0)
                drawRectFilled({ on and (px + pillW - pillH) or px, py, pillH, pillH },
                    col(GUI_COLORS.value), pillH * 0.5, 0)
                if hot and mouse.clicked then
                    enqueue(function() item.set(not on) end)
                end

            elseif row.kind == "slider" then
                local item = row.item
                local value = item.get() or item.min
                drawText(item.label, { cx + pad + 6 * s, textY }, col(GUI_COLORS.label),
                    font, false, true, GUI_COLORS.outline)

                local valueText = ("%g"):format(value)
                local valueW = guiMeasure(valueText, font) + 10 * s
                local trackX = ctrlX
                local trackW = ctrlW - valueW - 8 * s
                local trackH = 6 * s
                local trackY = ry + (rowH - trackH) / 2

                local span = (item.max - item.min)
                local frac = span > 0 and ((value - item.min) / span) or 0
                drawRectFilled({ trackX, trackY, trackW, trackH },
                    col(GUI_COLORS.track), trackH * 0.5, 0)
                drawRectFilled({ trackX, trackY, trackW * frac, trackH },
                    col(GUI_COLORS.accent), trackH * 0.5, 0)
                drawRectFilled({ trackX + trackW * frac - 4 * s, ry + rowH * 0.25,
                                 8 * s, rowH * 0.5 }, col(GUI_COLORS.value), 3 * s, 0)
                drawText(valueText, { trackX + trackW + 8 * s, textY },
                    col(GUI_COLORS.value), font, false, true, GUI_COLORS.outline)

                if active and mouse.clicked and hit(trackX - 6 * s, ry, trackW + 12 * s, rowH) then
                    gui.drag = { item = item, x = trackX, w = trackW }
                end

            elseif row.kind == "selector" then
                local item = row.item
                drawText(item.label, { cx + pad + 6 * s, textY }, col(GUI_COLORS.label),
                    font, false, true, GUI_COLORS.outline)

                local arrowW = 22 * s
                local rightX = cx + pad + rowW - 8 * s
                local leftBox = ctrlX
                local rightBox = rightX - arrowW

                drawRectFilled({ leftBox, ry + 4 * s, arrowW, rowH - 8 * s },
                    col(GUI_COLORS.track), 4 * s, 0)
                drawRectFilled({ rightBox, ry + 4 * s, arrowW, rowH - 8 * s },
                    col(GUI_COLORS.track), 4 * s, 0)
                drawText("<", { leftBox + arrowW * 0.5, textY }, col(GUI_COLORS.value),
                    font, true, true, GUI_COLORS.outline)
                drawText(">", { rightBox + arrowW * 0.5, textY }, col(GUI_COLORS.value),
                    font, true, true, GUI_COLORS.outline)

                local mid = (leftBox + arrowW + rightBox) * 0.5
                local choices = itemChoices(item)
                local shown = ("%s  (%d/%d)"):format(
                    tostring(item.get()), choiceIndex(item), #choices)
                drawText(shown, { mid, textY }, col(GUI_COLORS.value),
                    font, true, true, GUI_COLORS.outline)

                if active and mouse.clicked then
                    if hit(leftBox, ry + 4 * s, arrowW, rowH - 8 * s) then
                        enqueue(function() stepChoice(item, -1) end)
                    elseif hit(rightBox, ry + 4 * s, arrowW, rowH - 8 * s) then
                        enqueue(function() stepChoice(item, 1) end)
                    end
                end

            elseif row.kind == "text" then
                local item = row.item
                drawText(item.label, { cx + pad + 6 * s, textY }, col(GUI_COLORS.label),
                    font, false, true, GUI_COLORS.outline)
                local boxW = ctrlW - 8 * s
                drawRectFilled({ ctrlX, ry + 4 * s, boxW, rowH - 8 * s },
                    col(GUI_COLORS.track), 4 * s, 0)
                local shown = item.get()
                if shown == nil or shown == "" then shown = item.placeholder or "(empty)" end
                drawText(truncate(shown, 34), { ctrlX + 6 * s, textY },
                    col(shown == item.placeholder and GUI_COLORS.dim or GUI_COLORS.value),
                    font, false, true, GUI_COLORS.outline)
                if hot and mouse.clicked then
                    enqueue(function()
                        promptFor(item.label, item.label .. ":", item.get() or "",
                            200, function(text) item.set(text) end)
                    end)
                end
            end
        end
    end

    -- Scrollbar, only when there is something to scroll.
    if maxScroll > 0 then
        local bx = cx + pad + rowW
        local upHot = active and hit(bx, listTop, barW, barW)
        local downHot = active and hit(bx, listTop + listH - barW, barW, barW)

        drawRectFilled({ bx, listTop, barW, listH }, col(GUI_COLORS.tabIdle), 3 * s, 0)
        drawRectFilled({ bx, listTop, barW, barW },
            col(upHot and GUI_COLORS.rowHover or GUI_COLORS.track), 3 * s, 0)
        drawRectFilled({ bx, listTop + listH - barW, barW, barW },
            col(downHot and GUI_COLORS.rowHover or GUI_COLORS.track), 3 * s, 0)
        drawText("^", { bx + barW * 0.5, listTop + 2 * s }, col(GUI_COLORS.value),
            small, true, true, GUI_COLORS.outline)
        drawText("v", { bx + barW * 0.5, listTop + listH - barW + 2 * s },
            col(GUI_COLORS.value), small, true, true, GUI_COLORS.outline)

        local thumbTrack = listH - barW * 2
        local thumbH = math.max(barW, thumbTrack * (visible / #rows))
        local thumbY = listTop + barW + (thumbTrack - thumbH) * (scroll / maxScroll)
        drawRectFilled({ bx + 2 * s, thumbY, barW - 4 * s, thumbH },
            col(GUI_COLORS.accent), 3 * s, 0)

        if mouse.clicked then
            if upHot then enqueue(function() gui.scroll[gui.tab] = scroll - 1 end) end
            if downHot then enqueue(function() gui.scroll[gui.tab] = scroll + 1 end) end
        end
    end

    -- Footer: the newest log line, and where in the list we are.
    local fy = y + h - footerH
    drawRectFilled({ x, fy, w, footerH }, col(GUI_COLORS.header), 0, 0)
    local newest = logEntries[#logEntries]
    drawText(newest and truncate(newest.text, 60) or "no activity yet",
        { x + pad, fy + (footerH - small) * 0.5 }, col(GUI_COLORS.label),
        small, false, true, GUI_COLORS.outline)
    drawText(("%d-%d / %d   %s"):format(
            math.min(scroll + 1, #rows), math.min(scroll + visible, #rows), #rows,
            gui.toggleKey),
        { x + w - pad, fy + (footerH - small) * 0.5 }, col(GUI_COLORS.dim),
        small, false, true, GUI_COLORS.outline)
end

--------------------------------------------------------------------------------
-- Frame
--------------------------------------------------------------------------------

local function guiFrame()
    readMouse()

    if toggleKeyPressed() then setVisible(not gui.visible) end

    -- 1 - exp(-speed * dt) is the same curve whatever the frame rate, unlike a
    -- fixed step per frame. dt is capped so a hitch cannot snap the window open.
    local now = GetGameTimer()
    local dt = (now - (gui.lastFrame or now)) / 1000.0
    gui.lastFrame = now
    if dt > 0.25 then dt = 0.25 end
    if dt < 0 then dt = 0 end

    local target = gui.visible and 1.0 or 0.0
    gui.anim = gui.anim + (target - gui.anim) * (1.0 - math.exp(-GUI_ANIM_SPEED * dt))
    if math.abs(target - gui.anim) < 0.002 then gui.anim = target end

    -- A drag lives exactly as long as the button is held. Closing the window or
    -- changing tab drops it too; between them there is no path that leaves one
    -- attached to a widget the user can no longer see.
    if gui.drag and not mouse.down then gui.drag = nil end
    if gui.drag then
        local item = gui.drag.item
        local frac = gui.drag.w > 0 and ((mouse.x - gui.drag.x) / gui.drag.w) or 0.0
        if frac < 0 then frac = 0 end
        if frac > 1 then frac = 1 end
        local value = quantise(item, item.min + frac * (item.max - item.min))
        if value ~= item.get() then enqueue(function() item.set(value) end) end
    end

    if gui.anim <= 0.002 and not gui.visible then return end
    drawWindow()
end

--------------------------------------------------------------------------------
-- Hooks into the shared main loop
--------------------------------------------------------------------------------

perFrame = function()
    if not canDraw then return end

    local ok, err = pcall(guiFrame)

    if not ok then
        -- Whatever went wrong, the mouse goes back. A captured cursor with no
        -- window under it leaves the player unable to do anything but restart.
        gui.visible, gui.anim, gui.drag = false, 0.0, nil
        grabInput(false)
        queued = {}
        if not gui.errorShown then
            gui.errorShown = true
            act("GUI draw failed, window hidden: " .. tostring(err), "error")
        end
        return
    end

    -- Actions run out here, never inside the pcall above. An action may Wait —
    -- loading a vehicle model does — and yielding across a protected call is not
    -- portable between LuaJIT and Lua 5.4.
    if #queued > 0 then
        local run = queued
        queued = {}
        for _, fn in ipairs(run) do
            if fn then fn() end
        end
    end
end

onRetire = function()
    -- A newer Execute bumped the generation and this loop is finishing. Release
    -- before the new instance starts, or two of them fight over the cursor.
    gui.visible, gui.anim, gui.drag = false, 0.0, nil
    grabInput(false)
end

--------------------------------------------------------------------------------
-- Front end: one button
--------------------------------------------------------------------------------
-- The repo convention is to open a script with Vanity.addText; this one does
-- not, on purpose. The menu holds exactly one control and everything else lives
-- in the drawn window.

Vanity.addButton("Launch Menu", function()
    if not canDraw then
        act("Ham drawing is unavailable — the window cannot be shown", "error")
        return
    end
    setVisible(not gui.visible)
    act(gui.visible and "Menu shown" or "Menu hidden")
end, SCRIPT_NAME .. " — show or hide the drawn menu (" .. #TABS ..
    " tabs, every feature is in there)")

--------------------------------------------------------------------------------
-- Load
--------------------------------------------------------------------------------

detectAntiCheats(false)

if not canDraw then
    print("[Luchs] Ham drawing unavailable — this front end needs it; use luchs-script.lua")
end

Vanity.notify(SCRIPT_NAME .. " loaded", "success", 2500)
log(("%s loaded — %d tabs, %d features, anti-cheat: %s")
    :format(SCRIPT_NAME, #TABS, #specFeatureIds(), antiCheatText()))
