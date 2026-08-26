--[[
    AC Telemetry HUD v1.0
    ---------------------
    Client-side ground truth for anti-cheat development.

    Draws a live overlay of what the client actually reports — position, velocity,
    per-frame movement delta, health, vehicle, ped model — and optionally POSTs
    the same snapshot to your own detection endpoint. Run it on your own test
    server and compare the client's view against what your server-side checks see.

    The per-frame delta panel is the interesting one: a legitimate player moves a
    bounded distance per frame, so `Delta` and `Implied` (delta extrapolated to
    m/s) are the raw signal behind most teleport and speed checks. `Jumps` counts
    every frame that exceeded the threshold, and `Max` keeps the worst one, so you
    can trigger a behaviour and read off exactly what your detector had to catch.

    Requires: Vanity (UI) + Ham (drawing, HTTP).
]]

--------------------------------------------------------------------------------
-- Render loop generation guard
--------------------------------------------------------------------------------
-- Vanity clears the UI on every Execute, but a CreateThread render loop from a
-- previous run keeps going on its own. Bumping a global generation counter makes
-- every older loop fall out of its `while` on the next frame, so re-executing the
-- script never stacks duplicate overlays.

_G.__AC_HUD_GENERATION = (_G.__AC_HUD_GENERATION or 0) + 1
local generation = _G.__AC_HUD_GENERATION

local function isCurrent()
    return _G.__AC_HUD_GENERATION == generation
end

--------------------------------------------------------------------------------
-- Configuration (mutated by the Vanity callbacks below)
--------------------------------------------------------------------------------

local cfg = {
    hudEnabled     = true,
    corner         = "Top Left",
    fontSize       = 14,
    background     = 170,  -- panel alpha, 0-255

    showPosition   = true,
    showMovement   = true,
    showPlayer     = true,
    showVehicle    = true,
    showSession    = false,

    jumpThreshold  = 5.0,  -- metres in a single frame before it counts as a jump

    endpoint       = "",
    autoPost       = false,
    postInterval   = 5,    -- seconds
}

local COLORS = {
    panel   = { 12, 14, 18 },
    heading = { 120, 200, 255, 255 },
    label   = { 150, 158, 170, 255 },
    value   = { 235, 238, 242, 255 },
    warn    = { 255, 190, 70, 255 },
    alert   = { 255, 95, 95, 255 },
    ok      = { 120, 230, 150, 255 },
    outline = { 0, 0, 0, 220 },
}

--------------------------------------------------------------------------------
-- Sampled state
--------------------------------------------------------------------------------

local state = {
    coords        = { x = 0.0, y = 0.0, z = 0.0 },
    heading       = 0.0,
    speed         = 0.0,       -- m/s, from the engine
    health        = 0,
    armour        = 0,
    pedModel      = 0,
    inVehicle     = false,
    vehModel      = 0,
    vehSpeed      = 0.0,

    delta         = 0.0,       -- metres moved since the previous frame
    impliedSpeed  = 0.0,       -- delta extrapolated to m/s
    maxDelta      = 0.0,
    maxImplied    = 0.0,
    jumps         = 0,
    lastJump      = 0.0,
    frameMs       = 0.0,
}

local prevCoords = nil
local prevTime   = nil
local marker     = nil

local postState = {
    lastAttempt = 0,
    requestId   = nil,
    status      = "idle",
}

--------------------------------------------------------------------------------
-- Helpers
--------------------------------------------------------------------------------

local function dist3(a, b)
    local dx, dy, dz = a.x - b.x, a.y - b.y, a.z - b.z
    return math.sqrt(dx * dx + dy * dy + dz * dz)
end

local function jsonEscape(s)
    s = tostring(s)
    s = s:gsub('[\\"]', '\\%0')
    s = s:gsub('\n', '\\n'):gsub('\r', '\\r'):gsub('\t', '\\t')
    return s
end

local function jsonString(k, v)
    return ('"%s":"%s"'):format(k, jsonEscape(v))
end

local function jsonNumber(k, v)
    -- %.4f keeps coordinates precise without emitting scientific notation,
    -- which a lot of JSON parsers on the receiving end handle badly.
    return ('"%s":%.4f'):format(k, v + 0.0)
end

local function jsonInt(k, v)
    return ('"%s":%d'):format(k, math.floor((v or 0) + 0.5))
end

local function jsonBool(k, v)
    return ('"%s":%s'):format(k, v and "true" or "false")
end

--------------------------------------------------------------------------------
-- Sampling
--------------------------------------------------------------------------------

local function sample()
    local ped = PlayerPedId()
    if not ped or ped == 0 then return end

    local now = GetGameTimer()
    local c   = GetEntityCoords(ped)
    local cur = { x = c.x, y = c.y, z = c.z }

    state.coords   = cur
    state.heading  = GetEntityHeading(ped)
    state.speed    = GetEntitySpeed(ped)
    state.health   = GetEntityHealth(ped)
    state.armour   = GetPedArmour(ped)
    state.pedModel = GetEntityModel(ped)

    local veh = GetVehiclePedIsIn(ped, false)
    state.inVehicle = veh ~= 0
    if state.inVehicle then
        state.vehModel = GetEntityModel(veh)
        state.vehSpeed = GetEntitySpeed(veh)
    else
        state.vehModel = 0
        state.vehSpeed = 0.0
    end

    if prevCoords and prevTime then
        local dt = (now - prevTime) / 1000.0
        state.frameMs = now - prevTime
        local d = dist3(cur, prevCoords)
        state.delta = d
        state.impliedSpeed = dt > 0 and (d / dt) or 0.0

        if d > state.maxDelta then state.maxDelta = d end
        if state.impliedSpeed > state.maxImplied then
            state.maxImplied = state.impliedSpeed
        end
        if d >= cfg.jumpThreshold then
            state.jumps = state.jumps + 1
            state.lastJump = d
        end
    end

    prevCoords = cur
    prevTime   = now
end

--------------------------------------------------------------------------------
-- Telemetry
--------------------------------------------------------------------------------

local function buildSnapshot()
    local ped = PlayerPedId()
    local parts = {
        jsonString("user", Ham.getName and Ham.getName() or "unknown"),
        jsonString("endpoint", Ham.getServerEndpoint and Ham.getServerEndpoint() or ""),
        jsonInt("serverId", GetPlayerServerId(PlayerId())),
        jsonInt("gameTime", GetGameTimer()),
        jsonNumber("x", state.coords.x),
        jsonNumber("y", state.coords.y),
        jsonNumber("z", state.coords.z),
        jsonNumber("heading", state.heading),
        jsonNumber("speed", state.speed),
        jsonNumber("delta", state.delta),
        jsonNumber("impliedSpeed", state.impliedSpeed),
        jsonNumber("maxDelta", state.maxDelta),
        jsonNumber("maxImplied", state.maxImplied),
        jsonInt("jumps", state.jumps),
        jsonInt("health", state.health),
        jsonInt("armour", state.armour),
        jsonInt("pedModel", state.pedModel),
        jsonBool("inVehicle", state.inVehicle),
        jsonInt("vehModel", state.vehModel),
        jsonNumber("vehSpeed", state.vehSpeed),
    }
    return "{" .. table.concat(parts, ",") .. "}"
end

local function postSnapshot(manual)
    if cfg.endpoint == "" then
        postState.status = "no endpoint"
        if manual then
            Vanity.notify("Set a telemetry endpoint first", "error", 3000)
        end
        return
    end
    if postState.requestId then
        postState.status = "busy"
        return
    end

    postState.requestId = Ham.httpPostAsync(
        cfg.endpoint,
        buildSnapshot(),
        { ["Content-Type"] = "application/json" }
    )
    postState.lastAttempt = GetGameTimer()
    postState.status = "sending"
end

local function pollPost()
    if not postState.requestId then return end

    local result = Ham.getAsyncResult(postState.requestId)
    if not result or not result.ready then return end

    if result.success then
        postState.status = ("ok %d"):format(result.status or 0)
    else
        postState.status = "error: " .. tostring(result.error or "unknown")
    end

    postState.requestId = nil
    Ham.cleanupAsyncRequests()
end

--------------------------------------------------------------------------------
-- Rendering
--------------------------------------------------------------------------------

local function buildLines()
    local lines = {}
    local function heading(text)
        lines[#lines + 1] = { kind = "heading", text = text }
    end
    local function row(label, value, color)
        lines[#lines + 1] = { kind = "row", label = label, value = value, color = color }
    end

    if cfg.showPosition then
        heading("POSITION")
        row("Coords", ("%.2f  %.2f  %.2f"):format(
            state.coords.x, state.coords.y, state.coords.z))
        row("Heading", ("%.1f deg"):format(state.heading))
        if marker then
            row("From marker", ("%.2f m"):format(dist3(state.coords, marker)))
        end
    end

    if cfg.showMovement then
        heading("MOVEMENT")
        row("Speed", ("%.2f m/s  (%.0f km/h)"):format(state.speed, state.speed * 3.6))

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
            state.jumps > 0 and COLORS.alert or COLORS.ok)
        row("Frame", ("%.0f ms"):format(state.frameMs))
    end

    if cfg.showPlayer then
        heading("PLAYER")
        row("Health", tostring(state.health))
        row("Armour", tostring(state.armour))
        row("Ped model", tostring(state.pedModel))
    end

    if cfg.showVehicle and state.inVehicle then
        heading("VEHICLE")
        row("Model", tostring(state.vehModel))
        row("Speed", ("%.2f m/s  (%.0f km/h)"):format(
            state.vehSpeed, state.vehSpeed * 3.6))
    end

    if cfg.showSession then
        heading("SESSION")
        row("User", Ham.getName and Ham.getName() or "n/a")
        row("Server", Ham.getServerEndpoint and Ham.getServerEndpoint() or "n/a")
        row("Server ID", tostring(GetPlayerServerId(PlayerId())))
    end

    if cfg.endpoint ~= "" then
        heading("TELEMETRY")
        local color = COLORS.value
        if postState.status:sub(1, 5) == "error" then
            color = COLORS.alert
        elseif postState.status:sub(1, 2) == "ok" then
            color = COLORS.ok
        end
        row("Auto POST", cfg.autoPost
            and (("on, every %ds"):format(cfg.postInterval)) or "off")
        row("Status", postState.status, color)
    end

    return lines
end

-- drawText's fontSize is independent of the font getTextWidth measures with
-- (default 12 per the docs), so scale the measurement to the configured size.
local function measure(text)
    local w = Ham.getTextWidth(text)
    return (w or 0) * (cfg.fontSize / 12.0)
end

local function drawHud()
    local lines = buildLines()
    if #lines == 0 then return end

    local pad      = 10
    local lineH    = cfg.fontSize + 6
    local headGap  = 6
    local labelCol = 0

    for _, line in ipairs(lines) do
        if line.kind == "row" then
            local w = measure(line.label)
            if w > labelCol then labelCol = w end
        end
    end
    labelCol = labelCol + 14

    local contentW = labelCol
    local contentH = 0
    for _, line in ipairs(lines) do
        if line.kind == "heading" then
            contentH = contentH + lineH + headGap
            contentW = math.max(contentW, measure(line.text))
        else
            contentH = contentH + lineH
            contentW = math.max(contentW, labelCol + measure(line.value))
        end
    end

    local panelW = contentW + pad * 2
    local panelH = contentH + pad * 2

    local resW, resH = Ham.getResolution()
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

    Ham.drawRectFilled(
        { px, py, panelW, panelH },
        { COLORS.panel[1], COLORS.panel[2], COLORS.panel[3], cfg.background },
        6, 0)
    Ham.drawLine(
        { px, py }, { px + panelW, py },
        COLORS.heading, 2)

    local y = py + pad
    for _, line in ipairs(lines) do
        if line.kind == "heading" then
            y = y + headGap
            Ham.drawText(line.text, { px + pad, y }, COLORS.heading,
                cfg.fontSize, false, true, COLORS.outline)
            y = y + lineH
        else
            Ham.drawText(line.label, { px + pad, y }, COLORS.label,
                cfg.fontSize, false, true, COLORS.outline)
            Ham.drawText(line.value, { px + pad + labelCol, y },
                line.color or COLORS.value,
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
        pollPost()

        if cfg.autoPost and cfg.endpoint ~= "" and not postState.requestId then
            local elapsed = (GetGameTimer() - postState.lastAttempt) / 1000.0
            if elapsed >= cfg.postInterval then
                postSnapshot(false)
            end
        end

        if cfg.hudEnabled then
            drawHud()
        end
    end
end)

--------------------------------------------------------------------------------
-- Vanity UI
--------------------------------------------------------------------------------

Vanity.addText("AC Telemetry HUD v1.0")
Vanity.addText("Client ground truth for anti-cheat validation")

Vanity.addSeparator("Overlay")

Vanity.addToggle("Show HUD", true, function(info)
    cfg.hudEnabled = info.toggleState
end, "Draw the telemetry overlay on screen")

Vanity.addSelector("Corner", { "Top Left", "Top Right", "Bottom Left", "Bottom Right" },
    function(choice)
        cfg.corner = choice
    end, "Where the panel is anchored")

Vanity.addSlider("Font Size", 10, 26, 14, 1, function(value)
    cfg.fontSize = value
end, "Overlay text size in pixels")

Vanity.addSlider("Background", 0, 255, 170, 5, function(value)
    cfg.background = value
end, "Panel background opacity")

Vanity.addSeparator("Panels")

Vanity.addToggle("Position", true, function(info)
    cfg.showPosition = info.toggleState
end, "Coordinates, heading, distance from marker")

Vanity.addToggle("Movement", true, function(info)
    cfg.showMovement = info.toggleState
end, "Speed, per-frame delta, jump counter")

Vanity.addToggle("Player", true, function(info)
    cfg.showPlayer = info.toggleState
end, "Health, armour, ped model")

Vanity.addToggle("Vehicle", true, function(info)
    cfg.showVehicle = info.toggleState
end, "Vehicle model and speed when seated")

Vanity.addToggle("Session", false, function(info)
    cfg.showSession = info.toggleState
end, "User, server endpoint, server ID")

Vanity.addSeparator("Movement Analysis")

Vanity.addSlider("Jump Threshold", 1, 50, 5, 1, function(value)
    cfg.jumpThreshold = value + 0.0
end, "Metres in one frame before it counts as a jump")

Vanity.addButton("Set Reference Marker", function()
    marker = { x = state.coords.x, y = state.coords.y, z = state.coords.z }
    print(("[AC HUD] Marker set: %.2f, %.2f, %.2f"):format(marker.x, marker.y, marker.z))
    Vanity.notify("Reference marker set", "success", 2000)
end, "Store the current position to measure distance from")

Vanity.addButton("Clear Marker", function()
    marker = nil
    Vanity.notify("Marker cleared", "info", 2000)
end, "Remove the reference marker")

Vanity.addButton("Reset Counters", function()
    state.maxDelta   = 0.0
    state.maxImplied = 0.0
    state.jumps      = 0
    state.lastJump   = 0.0
    print("[AC HUD] Counters reset")
    Vanity.notify("Counters reset", "success", 2000)
end, "Zero the max delta and jump counters before a new test run")

Vanity.addSeparator("Telemetry")

Vanity.addTextInput("Endpoint", "", "https://your-server/ac-telemetry",
    function(value)
        cfg.endpoint = value or ""
        postState.status = "idle"
    end, "Your own collector URL; snapshots are POSTed as JSON")

Vanity.addToggle("Auto POST", false, function(info)
    cfg.autoPost = info.toggleState
    if info.toggleState and cfg.endpoint == "" then
        Vanity.notify("Set an endpoint first", "error", 3000)
    end
end, "Send a snapshot on a fixed interval")

Vanity.addSlider("Interval", 1, 60, 5, 1, function(value)
    cfg.postInterval = value
end, "Seconds between automatic snapshots")

Vanity.addButton("Send Snapshot Now", function()
    postSnapshot(true)
    print("[AC HUD] Snapshot: " .. buildSnapshot())
end, "POST one snapshot immediately and echo it to the console")

Vanity.addButton("Print Snapshot", function()
    print("[AC HUD] " .. buildSnapshot())
end, "Echo the current snapshot JSON to the F8 console without sending it")

Vanity.notify("AC Telemetry HUD loaded", "success", 2500)
