--[[
    Vanity Suite v1.0  —  single-file test bench
    ============================================

    Everything in one file: telemetry HUD, feature toolkit, and a scenario
    runner that plays reproducible behaviour ladders so you can find where your
    server-side detection thresholds actually sit.

    Paste this whole file into Vanity and hit Execute. No other files needed.

    ---------------------------------------------------------------------------
    THE POINT OF THE SCENARIO RUNNER

    A detector has a threshold. It might catch a 10 m jump and miss a 7 m one.
    Finding that edge is what calibration is: run a ladder of increasing
    magnitude, timestamp every step, then line the run report up against your
    server log and see which step was the first to trip.

    That is the useful axis to vary — how big the behaviour is, not how well it
    hides. If a step goes unnoticed, the fix belongs in the detector.

    ---------------------------------------------------------------------------
    NOT INCLUDED

    The spoofing/bypass family (spoofTeleport, speedSpoof, pedSpoof,
    spoofAllVisible, camBypass, lockEventLogger) and the aimbot. Those exist to
    defeat detection or to target other players.

    If you want to know whether your anti-cheat catches Ham's built-in spoofers,
    you do not need them wired in here: flip them on in Ham's own menu, run a
    ladder from this script, and compare the logs. The ground truth this file
    records is what makes that comparison readable.

    Requires: Vanity (UI) + Ham (drawing, HTTP, inspection).
]]

--------------------------------------------------------------------------------
-- Render loop generation guard
--------------------------------------------------------------------------------
-- Vanity clears the UI on every Execute but leaves old CreateThread loops
-- running. Bumping a global counter retires them on their next frame.

_G.__VANITY_SUITE_GENERATION = (_G.__VANITY_SUITE_GENERATION or 0) + 1
local generation = _G.__VANITY_SUITE_GENERATION

local function isCurrent()
    return _G.__VANITY_SUITE_GENERATION == generation
end

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
    delta = 0.0, impliedSpeed = 0.0,
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
    print(("[Suite %8.2fs] %s"):format(stamp / 1000.0, text))
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
        if d >= cfg.jumpThreshold then
            state.jumps = state.jumps + 1
            state.lastJump = d
        end
    end

    prevCoords, prevTime = cur, now
end

local function resetCounters()
    state.maxDelta, state.maxImplied = 0.0, 0.0
    state.jumps, state.lastJump = 0, 0.0
end

--------------------------------------------------------------------------------
-- JSON
--------------------------------------------------------------------------------

local function jsonEscape(s)
    s = tostring(s)
    s = s:gsub('[\\"]', '\\%0')
    s = s:gsub('\n', '\\n'):gsub('\r', '\\r'):gsub('\t', '\\t')
    return s
end

local function jStr(k, v) return ('"%s":"%s"'):format(k, jsonEscape(v)) end
-- %.4f keeps coordinates precise without scientific notation, which many
-- parsers on the receiving end handle badly.
local function jNum(k, v) return ('"%s":%.4f'):format(k, (v or 0) + 0.0) end
local function jInt(k, v) return ('"%s":%d'):format(k, math.floor((v or 0) + 0.5)) end
local function jBool(k, v) return ('"%s":%s'):format(k, v and "true" or "false") end

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
        drawText("Vanity Suite", { cx, cy }, color, cfg.fontSize * 2,
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

local function drawOverlay()
    local resW, resH = getResolution()
    resW, resH = resW or 1920, resH or 1080

    if cfg.showShapes then drawShapeDemo(resW, resH) end
    if cfg.showMarker then drawMarker() end

    local rows = buildRows()
    local lines = cfg.showLog and logLines() or nil
    if #rows == 0 and not lines then return end

    local pad, lineH, headGap = 10, cfg.fontSize + 6, 6

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

    local margin = 20
    local px, py
    if cfg.corner == "Top Left" then
        px, py = margin, margin
    elseif cfg.corner == "Top Right" then
        px, py = resW - panelW - margin, margin
    elseif cfg.corner == "Bottom Left" then
        px, py = margin, resH - panelH - margin
    else
        px, py = resW - panelW - margin, resH - panelH - margin
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

CreateThread(function()
    while isCurrent() do
        Wait(0)

        sample()
        applyPerFrameEffects()
        pollTelemetry()
        pollHttp()

        if cfg.autoPost and cfg.endpoint ~= "" and not postState.requestId then
            local elapsed = (GetGameTimer() - postState.lastAttempt) / 1000.0
            if elapsed >= cfg.postInterval then postSnapshot(false) end
        end

        if cfg.overlay and canDraw then drawOverlay() end
    end
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
-- UI: header and scenario runner
--------------------------------------------------------------------------------

Vanity.addText("Vanity Suite v1.0")
Vanity.addText("Telemetry + toolkit + scenario runner, all in one script")

Vanity.addSeparator("Scenario Runner")

Vanity.addSelector("Scenario", scenarioNames(), function(choice)
    cfg.scenario = choice
    local s = scenarioByName(choice)
    runner.lastText = "idle"
    log("Scenario selected: " .. choice .. "  (" .. #s.steps .. " steps)")
    print("  " .. s.note)
end, "Which behaviour ladder to play")

Vanity.addSlider("Step Delay", 500, 15000, 3000, 500, function(value)
    cfg.stepDelay = value
end, "Milliseconds between ladder steps — leave room for your server to react")

Vanity.addSlider("Repeats", 1, 10, 1, 1, function(value)
    cfg.repeats = value
end, "How many times to replay the whole ladder")

Vanity.addButton("Start Scenario", startScenario,
    "Play the selected ladder, recording what the client did at every step")

Vanity.addButton("Stop Scenario", function()
    stopScenario("stopped by user")
end, "Abort the run after the current step")

Vanity.addButton("Print Run Report", function()
    print(runnerReport())
    act(("Report printed (%d results)"):format(#runner.results))
end, "Dump the last run as a table to the F8 console")

Vanity.addButton("Copy Run Report", function()
    if #runner.results == 0 then
        act("No scenario has been run yet", "error")
        return
    end
    ham("copyToClipboard", runnerReport())
    act("Report copied to clipboard", "success")
end, "Put the run report on the system clipboard")

Vanity.addButton("Describe Scenarios", function()
    print("---- scenarios ----")
    for _, s in ipairs(SCENARIOS) do
        print(("  %-26s %d steps  (%s)"):format(s.name, #s.steps, s.unit))
        print("      " .. s.note)
    end
    act("Scenario list printed")
end, "List every ladder and what it exercises")

--------------------------------------------------------------------------------
-- UI: movement analysis
--------------------------------------------------------------------------------

Vanity.addSeparator("Movement Analysis")

Vanity.addSlider("Jump Threshold", 1, 50, 5, 1, function(value)
    cfg.jumpThreshold = value + 0.0
end, "Metres in one frame before it counts as a jump")

Vanity.addButton("Reset Counters", function()
    resetCounters()
    act("Counters reset", "success")
end, "Zero the max delta and jump counters before a run")

Vanity.addButton("Set Reference Marker", function()
    local x, y, z = coords()
    marker = { x = x, y = y, z = z }
    savedMarker = marker
    act("Reference marker set", "success")
end, "Store the current position; the overlay shows distance from it")

Vanity.addButton("Clear Marker", function()
    marker, savedMarker = nil, nil
    act("Marker cleared")
end, "Remove the reference marker")

--------------------------------------------------------------------------------
-- UI: telemetry
--------------------------------------------------------------------------------

Vanity.addSeparator("Telemetry")

Vanity.addTextInput("Endpoint", "", "https://your-server/ac-telemetry", function(value)
    cfg.endpoint = value or ""
    postState.status = "idle"
end, "Your own collector; snapshots and scenario steps are POSTed as JSON")

Vanity.addToggle("Auto POST", false, function(info)
    cfg.autoPost = info.toggleState
    if info.toggleState and cfg.endpoint == "" then
        act("Set an endpoint first", "error")
    end
end, "Send a snapshot on a fixed interval")

Vanity.addSlider("POST Interval", 1, 60, 5, 1, function(value)
    cfg.postInterval = value
end, "Seconds between automatic snapshots")

Vanity.addButton("Send Snapshot Now", function()
    postSnapshot(true)
end, "POST one snapshot immediately")

Vanity.addButton("Print Snapshot", function()
    print("[Suite] " .. buildSnapshot())
    act("Snapshot printed")
end, "Echo the snapshot JSON to the console without sending it")

--------------------------------------------------------------------------------
-- UI: session
--------------------------------------------------------------------------------

Vanity.addSeparator("Session")

Vanity.addButton("Print Session Info", function()
    local x, y, z = coords()
    local resW, resH = 0, 0
    if getResolution then resW, resH = getResolution() end
    print("---- session ----")
    print("  user       : " .. tostring(ham("getName")))
    print("  discord    : " .. tostring(ham("getDiscordName")) ..
          " (" .. tostring(ham("getDiscordId")) .. ")")
    print("  server     : " .. tostring(ham("getServerHostname")))
    print("  endpoint   : " .. tostring(ham("getServerEndpoint")))
    print("  server id  : " .. tostring(GetPlayerServerId(PlayerId())))
    print(("  position   : %.2f %.2f %.2f"):format(x, y, z))
    print(("  resolution : %sx%s"):format(tostring(resW), tostring(resH)))
    print("  ped model  : " .. tostring(GetEntityModel(ped())))
    act("Session info printed", "success")
end, "Dump account, server and client details to the console")

--------------------------------------------------------------------------------
-- UI: self
--------------------------------------------------------------------------------

Vanity.addSeparator("Self")

Vanity.addToggle("God Mode", false, function(info)
    toggles.godMode = info.toggleState
    ham("godMode", info.toggleState)
    SetEntityInvincible(ped(), info.toggleState)
    act("God mode " .. onOff(info.toggleState))
end, "Ham godMode plus the native invincibility flag")

Vanity.addToggle("Invisible", false, function(info)
    toggles.invisible = info.toggleState
    ham("invisible", info.toggleState)
    act("Invisible " .. onOff(info.toggleState))
end, "Toggle player visibility")

Vanity.addToggle("No-Clip", false, function(info)
    toggles.noClip = info.toggleState
    ham("noClip", info.toggleState)
    act("No-clip " .. onOff(info.toggleState))
end, "Fly through geometry")

Vanity.addSlider("No-Clip Speed", 1, 20, 3, 1, function(value)
    ham("setNoClipSpeed", value + 0.0)
    log("No-clip speed " .. value)
end, "No-clip movement multiplier")

Vanity.addToggle("Free Cam", false, function(info)
    toggles.freeCam = info.toggleState
    ham("freeCam", info.toggleState)
    act("Free cam " .. onOff(info.toggleState))
end, "Detach the camera from the player")

Vanity.addSlider("Free Cam Speed", 1, 20, 3, 1, function(value)
    ham("setFreecamSpeed", value + 0.0)
    log("Free cam speed " .. value)
end, "Free camera movement multiplier")

Vanity.addToggle("Spectator Mode", false, function(info)
    toggles.spectator = info.toggleState
    ham("spectatorMode", info.toggleState)
    act("Spectator " .. onOff(info.toggleState))
end, "Toggle spectator mode")

Vanity.addToggle("Anti-Teleport", false, function(info)
    toggles.antiTeleport = info.toggleState
    ham("antiTeleport", info.toggleState)
    act("Anti-teleport " .. onOff(info.toggleState))
end, "Refuse teleports pushed by the server — a detector should notice this")

Vanity.addToggle("Anti-Block Control", false, function(info)
    toggles.antiBlock = info.toggleState
    ham("antiBlockControl", info.toggleState)
    act("Anti-block control " .. onOff(info.toggleState))
end, "Refuse having entity control taken away")

Vanity.addSlider("Run Speed", 1, 10, 1, 1, function(value)
    SetRunSprintMultiplierForPlayer(PlayerId(), value * 1.0)
    act("Run speed x" .. value)
end, "Sprint speed multiplier")

Vanity.addSlider("Swim Speed", 1, 10, 1, 1, function(value)
    SetSwimMultiplierForPlayer(PlayerId(), value * 1.0)
    act("Swim speed x" .. value)
end, "Swim speed multiplier")

Vanity.addToggle("Super Jump", false, function(info)
    toggles.superJump = info.toggleState
    act("Super jump " .. onOff(info.toggleState))
end, "Applied every frame while enabled")

Vanity.addToggle("Disable Ragdoll", false, function(info)
    toggles.noRagdoll = info.toggleState
    if not info.toggleState then SetPedCanRagdoll(ped(), true) end
    act("Ragdoll " .. (info.toggleState and "disabled" or "enabled"))
end, "Stop the ped from going limp")

Vanity.addSlider("Set Health", 0, 200, 200, 5, function(value)
    SetEntityHealth(ped(), value)
    act("Health set to " .. value)
end, "Write health directly — a big jump is a detection signal")

Vanity.addSlider("Set Armour", 0, 100, 0, 5, function(value)
    SetPedArmour(ped(), value)
    act("Armour set to " .. value)
end, "Write armour directly")

Vanity.addButton("Heal Fully", function()
    SetEntityHealth(ped(), 200)
    SetPedArmour(ped(), 100)
    act("Healed to full", "success")
end, "Health 200, armour 100")

--------------------------------------------------------------------------------
-- UI: teleport
--------------------------------------------------------------------------------

Vanity.addSeparator("Teleport")

Vanity.addSelector("Teleport Method", { "Native (SetEntityCoords)", "Ham (setPosition)" },
    function(choice)
        cfg.telMethod = choice
        log("Teleport method: " .. choice)
    end, "Which path a jump takes — check whether your detector sees both")

Vanity.addSlider("Vertical Offset", 0, 100, 0, 5, function(value)
    cfg.telOffset = value
    log("Teleport Z offset " .. value)
end, "Added to the target Z, e.g. to land above ground")

Vanity.addButton("Teleport to Coords...", function()
    local x, y, z = coords()
    Vanity.promptText({
        title = "Teleport", label = "X, Y, Z:",
        default = ("%.1f, %.1f, %.1f"):format(x, y, z), maxLen = 100,
    }, function(text, cancelled)
        if cancelled then return end
        local tx, ty, tz = text:match("(-?%d+%.?%d*)%s*,%s*(-?%d+%.?%d*)%s*,%s*(-?%d+%.?%d*)")
        if not tx then
            act("Could not parse coordinates", "error")
            return
        end
        teleport(tonumber(tx), tonumber(ty), tonumber(tz), "manual")
    end)
end, "Type a coordinate triple to jump to")

Vanity.addButton("Teleport to Waypoint", function()
    local blip = GetFirstBlipInfoId(8)
    if not DoesBlipExist(blip) then
        act("No waypoint set", "error")
        return
    end
    local c = GetBlipInfoIdCoord(blip)
    teleport(c.x, c.y, groundAt(c.x, c.y, c.z), "waypoint")
end, "Jump to the map marker")

Vanity.addSubmenu("Teleport Slots", {
    { name = "Save Slot 1", type = "button", func = function()
        local x, y, z = coords(); slots[1] = { x = x, y = y, z = z }
        act("Slot 1 saved", "success")
    end },
    { name = "Load Slot 1", type = "button", func = function()
        if slots[1] then teleport(slots[1].x, slots[1].y, slots[1].z, "slot 1")
        else act("Slot 1 empty", "error") end
    end },
    { name = "Save Slot 2", type = "button", func = function()
        local x, y, z = coords(); slots[2] = { x = x, y = y, z = z }
        act("Slot 2 saved", "success")
    end },
    { name = "Load Slot 2", type = "button", func = function()
        if slots[2] then teleport(slots[2].x, slots[2].y, slots[2].z, "slot 2")
        else act("Slot 2 empty", "error") end
    end },
    { name = "Save Slot 3", type = "button", func = function()
        local x, y, z = coords(); slots[3] = { x = x, y = y, z = z }
        act("Slot 3 saved", "success")
    end },
    { name = "Load Slot 3", type = "button", func = function()
        if slots[3] then teleport(slots[3].x, slots[3].y, slots[3].z, "slot 3")
        else act("Slot 3 empty", "error") end
    end },
    { name = "Print All Slots", type = "button", func = function()
        for i = 1, 3 do
            local s = slots[i]
            print(("  slot %d: %s"):format(i,
                s and ("%.1f %.1f %.1f"):format(s.x, s.y, s.z) or "empty"))
        end
        act("Slots printed")
    end },
}, "Store and recall up to three positions")

Vanity.addSubmenu("Quick Locations", {
    { name = "Airport",        type = "button", func = function() teleport(-1336.0, -3044.0, 13.9, "airport") end },
    { name = "Pier",           type = "button", func = function() teleport(-1850.0, -1231.0, 13.0, "pier") end },
    { name = "Mount Chiliad",  type = "button", func = function() teleport(450.0, 5566.0, 806.0, "chiliad") end },
    { name = "Legion Square",  type = "button", func = function() teleport(215.0, -810.0, 31.0, "legion") end },
    { name = "Sandy Shores",   type = "button", func = function() teleport(1704.0, 3760.0, 34.7, "sandy") end },
    { name = "Paleto Bay",     type = "button", func = function() teleport(-160.0, 6316.0, 31.6, "paleto") end },
    { name = "Casino",         type = "button", func = function() teleport(925.0, 46.0, 81.1, "casino") end },
    { name = "Maze Bank Roof", type = "button", func = function() teleport(-75.0, -818.0, 326.2, "maze bank") end },
}, "Jump to well-known spots")

--------------------------------------------------------------------------------
-- UI: vehicle
--------------------------------------------------------------------------------

Vanity.addSeparator("Vehicle")

Vanity.addTextInput("Vehicle Model", "adder", "e.g. adder, sultan, police", function(value)
    cfg.vehicleModel = value or ""
end, "Spawn name for the button below")

Vanity.addButton("Spawn Vehicle", function()
    if cfg.vehicleModel == "" then
        act("Enter a vehicle model first", "error")
        return
    end
    local hash = GetHashKey(cfg.vehicleModel)
    if not loadModel(hash) then
        act("Model did not load: " .. cfg.vehicleModel, "error")
        return
    end
    local p = ped()
    local x, y, z = coords()
    spawnedVehicle = CreateVehicle(hash, x, y, z, GetEntityHeading(p), true, false)
    SetPedIntoVehicle(p, spawnedVehicle, -1)
    SetModelAsNoLongerNeeded(hash)
    act("Spawned " .. cfg.vehicleModel, "success")
end, "Spawn the model above and get in")

Vanity.addSubmenu("Quick Spawn", (function()
    local list = { "adder", "zentorno", "t20", "sultan", "kuruma", "police",
                   "ambulance", "firetruk", "buzzard", "lazer", "rhino", "blista" }
    local items = {}
    for _, name in ipairs(list) do
        items[#items + 1] = { name = name, type = "button", func = function()
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
        end }
    end
    return items
end)(), "Common models, one click each")

Vanity.addSubmenu("Vehicle Actions", {
    { name = "Condition", options = {
        { name = "Repair", type = "button", func = function()
            local v = requireVehicle("repair"); if not v then return end
            SetVehicleFixed(v); SetVehicleDeformationFixed(v)
            act("Vehicle repaired", "success")
        end },
        { name = "Clean", type = "button", func = function()
            local v = requireVehicle("clean"); if not v then return end
            SetVehicleDirtLevel(v, 0.0)
            act("Vehicle cleaned", "success")
        end },
        { name = "Flip Upright", type = "button", func = function()
            local v = requireVehicle("flip"); if not v then return end
            SetVehicleOnGroundProperly(v)
            act("Vehicle flipped upright", "success")
        end },
        { name = "Delete", type = "button", func = function()
            local v = requireVehicle("delete"); if not v then return end
            SetEntityAsMissionEntity(v, true, true)
            DeleteVehicle(v)
            act("Vehicle deleted", "success")
        end },
    }},
    { name = "Tuning", options = {
        { name = "Max Upgrades", type = "button", func = function()
            local v = requireVehicle("tuning"); if not v then return end
            SetVehicleModKit(v, 0)
            for modType = 0, 16 do
                local count = GetNumVehicleMods(v, modType)
                if count and count > 0 then
                    SetVehicleMod(v, modType, count - 1, false)
                end
            end
            ToggleVehicleMod(v, 18, true)  -- turbo
            act("Max upgrades applied", "success")
        end },
        { name = "Set Plate...", type = "button", func = function()
            local v = requireVehicle("plate"); if not v then return end
            Vanity.promptText({ title = "Number Plate", label = "Text:",
                                default = "SUITE", maxLen = 8 },
                function(text, cancelled)
                    if cancelled then return end
                    SetVehicleNumberPlateText(v, text)
                    act("Plate set to " .. text, "success")
                end)
        end },
        { name = "Boost Forward", type = "button", func = function()
            local v = requireVehicle("boost"); if not v then return end
            local vel = GetEntityVelocity(v)
            SetEntityVelocity(v, vel.x * 2.0, vel.y * 2.0, vel.z)
            act("Velocity doubled")
        end },
    }},
}, "Repair, clean, tune and manage the current vehicle")

--------------------------------------------------------------------------------
-- UI: world and weapons
--------------------------------------------------------------------------------

Vanity.addSeparator("World")

Vanity.addSelector("Time of Day", { "Morning", "Noon", "Evening", "Night" }, function(choice)
    local hours = { Morning = 7, Noon = 12, Evening = 19, Night = 0 }
    NetworkOverrideClockTime(hours[choice], 0, 0)
    act("Time set to " .. choice)
end, "Override the in-game clock")

Vanity.addSlider("Hour", 0, 23, 12, 1, function(value)
    NetworkOverrideClockTime(value, 0, 0)
    log("Clock set to " .. value .. ":00")
end, "Set the hour precisely")

Vanity.addSelector("Weather", {
    "CLEAR", "EXTRASUNNY", "CLOUDS", "OVERCAST", "RAIN",
    "THUNDER", "SMOG", "FOGGY", "SNOW", "BLIZZARD",
}, function(choice)
    SetWeatherTypeNowPersist(choice)
    act("Weather set to " .. choice)
end, "Force a weather type")

Vanity.addToggle("Disable Weather Sync", false, function(info)
    toggles.disableWeather = info.toggleState
    ham("disableWeather", info.toggleState)
    act("Weather sync " .. (info.toggleState and "disabled" or "enabled"))
end, "Stop the server driving local weather")

Vanity.addSeparator("Weapons")

Vanity.addTextInput("Weapon Name", "WEAPON_PISTOL", "WEAPON_...", function(value)
    cfg.weaponName = value or ""
end, "Weapon hash name for the button below")

Vanity.addButton("Give Weapon", function()
    if cfg.weaponName == "" then
        act("Enter a weapon name first", "error")
        return
    end
    GiveWeaponToPed(ped(), GetHashKey(cfg.weaponName), 250, false, true)
    act("Gave " .. cfg.weaponName, "success")
end, "Give the weapon named above with 250 rounds")

Vanity.addSubmenu("Weapon Packs", {
    { name = "Pistols", type = "button", func = function()
        for _, w in ipairs({ "WEAPON_PISTOL", "WEAPON_COMBATPISTOL", "WEAPON_APPISTOL" }) do
            GiveWeaponToPed(ped(), GetHashKey(w), 250, false, false)
        end
        act("Pistols given", "success")
    end },
    { name = "Rifles", type = "button", func = function()
        for _, w in ipairs({ "WEAPON_ASSAULTRIFLE", "WEAPON_CARBINERIFLE", "WEAPON_SPECIALCARBINE" }) do
            GiveWeaponToPed(ped(), GetHashKey(w), 250, false, false)
        end
        act("Rifles given", "success")
    end },
    { name = "Melee", type = "button", func = function()
        for _, w in ipairs({ "WEAPON_BAT", "WEAPON_KNIFE", "WEAPON_CROWBAR" }) do
            GiveWeaponToPed(ped(), GetHashKey(w), 1, false, false)
        end
        act("Melee given", "success")
    end },
    { name = "Throwables", type = "button", func = function()
        for _, w in ipairs({ "WEAPON_GRENADE", "WEAPON_SMOKEGRENADE", "WEAPON_MOLOTOV" }) do
            GiveWeaponToPed(ped(), GetHashKey(w), 25, false, false)
        end
        act("Throwables given", "success")
    end },
}, "Give a themed set of weapons at once")

Vanity.addToggle("Infinite Ammo", false, function(info)
    toggles.infiniteAmmo = info.toggleState
    if not info.toggleState then
        SetPedInfiniteAmmo(ped(), false, GetSelectedPedWeapon(ped()))
    end
    act("Infinite ammo " .. onOff(info.toggleState))
end, "Refill the equipped weapon every frame")

Vanity.addButton("Remove All Weapons", function()
    RemoveAllPedWeapons(ped(), true)
    act("Weapons removed", "success")
end, "Strip the ped's inventory")

--------------------------------------------------------------------------------
-- UI: overlay
--------------------------------------------------------------------------------

Vanity.addSeparator("Overlay")

Vanity.addToggle("Show Overlay", true, function(info)
    cfg.overlay = info.toggleState
end, "Master switch for everything drawn on screen")

Vanity.addSelector("Overlay Corner", { "Top Right", "Top Left", "Bottom Left", "Bottom Right" },
    function(choice) cfg.corner = choice end, "Where the panel sits")

Vanity.addSlider("Overlay Font Size", 10, 26, 14, 1, function(value)
    cfg.fontSize = value
end, "Overlay text size")

Vanity.addToggle("Status Panel", true, function(info)
    cfg.showStatus = info.toggleState
end, "Position, speed, health and active flags")

Vanity.addToggle("Movement Panel", true, function(info)
    cfg.showMovement = info.toggleState
end, "Per-frame delta, implied speed and the jump counter")

Vanity.addToggle("Scenario Panel", true, function(info)
    cfg.showScenario = info.toggleState
end, "Live progress of the running ladder")

Vanity.addToggle("Action Log", true, function(info)
    cfg.showLog = info.toggleState
end, "Timestamped list of the last actions taken")

Vanity.addToggle("Input Panel", false, function(info)
    cfg.showInput = info.toggleState
end, "Live mouse position and held modifier keys")

Vanity.addToggle("3D Marker", false, function(info)
    cfg.showMarker = info.toggleState
    if info.toggleState and not savedMarker then
        act("No marker set — use 'Set Reference Marker'", "error")
    end
end, "Project the saved world position onto the screen")

Vanity.addToggle("Shape Demo", false, function(info)
    cfg.showShapes = info.toggleState
end, "Draw the selected primitive in the middle of the screen")

Vanity.addSelector("Demo Shape",
    { "Rect Outline", "Rect Filled", "Gradient", "Circle", "Circle Filled", "Line", "Text" },
    function(choice) cfg.shape = choice end, "Which Ham drawing call to exercise")

Vanity.addSlider("Shape Red", 0, 255, 120, 5, function(v) cfg.shapeR = v end, "Demo colour, red channel")
Vanity.addSlider("Shape Green", 0, 255, 200, 5, function(v) cfg.shapeG = v end, "Demo colour, green channel")
Vanity.addSlider("Shape Blue", 0, 255, 255, 5, function(v) cfg.shapeB = v end, "Demo colour, blue channel")
Vanity.addSlider("Shape Thickness", 1, 20, 2, 1, function(v) cfg.thickness = v end, "Outline thickness")

--------------------------------------------------------------------------------
-- UI: inspector
--------------------------------------------------------------------------------

Vanity.addSeparator("Inspector")

Vanity.addSlider("Dump Line Limit", 5, 200, 25, 5, function(value)
    cfg.dumpLimit = value
end, "How many lines a dump prints to the console")

Vanity.addSubmenu("Dumps", {
    { name = "Resources", type = "button", func = function()
        dumpArray("Resources", ham("getResources"))
    end },
    { name = "Injectable Resources", type = "button", func = function()
        dumpArray("Injectable resources", ham("getInjectableResources"))
    end },
    { name = "Safe Resources", type = "button", func = function()
        dumpArray("Safe resources", ham("getSafeResources"))
    end },
    { name = "State Bags", type = "button", func = dumpStateBags },
    { name = "Triggered Events", type = "button", func = function()
        dumpEventMap("Triggered events", ham("getAllEvents"))
    end },
    { name = "Registered Events", type = "button", func = function()
        dumpEventMap("Registered events", ham("getAllRegisteredEvents"))
    end },
    { name = "Ped Model Names", type = "button", func = function()
        dumpArray("Ped models", ham("getPedModelNames"))
    end },
}, "Print server-side inventories to the console")

Vanity.addTextInput("Resource Name", "", "resource to check", function(value)
    cfg.resourceQuery = value or ""
end, "Name for the resource check below")

Vanity.addButton("Check Resource", function()
    if cfg.resourceQuery == "" then
        act("Enter a resource name first", "error")
        return
    end
    local exists = ham("hasResource", cfg.resourceQuery)
    act(("Resource '%s': %s"):format(cfg.resourceQuery, exists and "present" or "absent"),
        exists and "success" or "info")
end, "Ask whether a resource exists on this server")

Vanity.addButton("Find Event...", function()
    Vanity.promptText({ title = "Find Event", label = "Partial event name:",
                        default = "", maxLen = 120 },
        function(text, cancelled)
            if cancelled or text == "" then return end
            local found = ham("findEvent", text)
            if type(found) == "table" and found.event then
                act(("Found %s in %s"):format(found.event, tostring(found.resource)), "success")
                print(("  event    : %s"):format(found.event))
                print(("  resource : %s"):format(tostring(found.resource)))
            else
                act("No event matched '" .. text .. "'", "error")
            end
        end)
end, "Search the event inventory by substring")

Vanity.addButton("Copy Last Dump", function()
    if lastDump == "" then
        act("Nothing dumped yet", "error")
        return
    end
    ham("copyToClipboard", lastDump)
    act(("Copied %d bytes to clipboard"):format(#lastDump), "success")
end, "Put the most recent dump on the system clipboard")

--------------------------------------------------------------------------------
-- UI: HTTP
--------------------------------------------------------------------------------

Vanity.addSeparator("HTTP")

Vanity.addTextInput("URL", "", "https://your-server/endpoint", function(value)
    cfg.httpUrl = value or ""
end, "Target for the requests below")

Vanity.addTextInput("POST Body", "", '{"test": true}', function(value)
    cfg.httpBody = value or ""
end, "Request body sent with POST")

Vanity.addSubmenu("Send Request", {
    { name = "GET (sync)",   type = "button", func = function() httpSync("GET") end },
    { name = "POST (sync)",  type = "button", func = function() httpSync("POST") end },
    { name = "GET (async)",  type = "button", func = function() httpAsync("GET") end },
    { name = "POST (async)", type = "button", func = function() httpAsync("POST") end },
}, "Synchronous calls block the frame; async ones resolve in the render loop")

Vanity.addButton("Copy Last Response", function()
    if lastResponse == "" then
        act("No response yet", "error")
        return
    end
    ham("copyToClipboard", lastResponse)
    act(("Copied %d bytes to clipboard"):format(#lastResponse), "success")
end, "Put the last response body on the clipboard")

Vanity.addButton("Open URL in Browser", function()
    if cfg.httpUrl:sub(1, 4) ~= "http" then
        act("URL must start with http:// or https://", "error")
        return
    end
    ham("openUrl", cfg.httpUrl)
    act("Opened in browser")
end, "Hand the URL to the default browser")

--------------------------------------------------------------------------------
-- UI: input, fonts, advanced
--------------------------------------------------------------------------------

Vanity.addSeparator("Input & Fonts")

Vanity.addToggle("Show Mouse Cursor", false, function(info)
    toggles.showCursor = info.toggleState
    ham("toggleMouse", info.toggleState)
    act("Mouse cursor " .. onOff(info.toggleState))
end, "Show and enable the mouse cursor")

Vanity.addToggle("Block Game Input", false, function(info)
    toggles.blockInput = info.toggleState
    ham("toggleInputBlock", info.toggleState)
    act("Game input " .. (info.toggleState and "blocked" or "released"))
end, "Stop keystrokes reaching the game while an overlay has focus")

Vanity.addSelector("Font", { "Default", "Rubik", "Font Awesome", "Consolas" }, function(choice)
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
end, "Load and activate one of the built-in fonts")

Vanity.addButton("Reset Font", function()
    ham("resetFont")
    act("Font reset")
end, "Go back to the default font")

Vanity.addSeparator("Advanced")

Vanity.addTextInput("Execute Context", "isolated", 'resource name or "isolated"',
    function(value)
        cfg.execResource = (value ~= "" and value) or "isolated"
    end, "Which resource context Execute runs in")

Vanity.addButton("Execute Lua...", function()
    Vanity.promptText({ title = "Execute Lua", label = "Code:",
                        default = 'print("hello from " .. GetCurrentResourceName())',
                        maxLen = 500 },
        function(text, cancelled)
            if cancelled or text == "" then return end
            local ok = ham("Execute", cfg.execResource, text)
            act(("Execute in '%s': %s"):format(cfg.execResource, ok and "ok" or "failed"),
                ok and "success" or "error")
        end)
end, "Run Lua inside a resource context — the primitive a detector most wants to catch")

Vanity.addButton("Clipboard to Console", function()
    print("---- clipboard ----")
    print(truncate(tostring(ham("getClipboard")), 2000))
    act("Clipboard printed")
end, "Read the system clipboard into the console")

Vanity.addButton("Clear Action Log", function()
    logEntries = {}
    log("Log cleared")
end, "Empty the on-screen action log")

Vanity.addButton("Reset Everything", function()
    -- Only stop if something is running; stopScenario complains when idle.
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
    resetCounters()
    act("Everything reset — menu switches still show their old position", "success")
end, "Turn every feature back off and zero the counters")

if not canDraw then
    print("[Suite] Ham drawing unavailable — overlay disabled, menu still works")
end

Vanity.notify("Vanity Suite loaded", "success", 2500)
log("Suite v1.0 loaded")
