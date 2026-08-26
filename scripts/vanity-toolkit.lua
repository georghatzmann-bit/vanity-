--[[
    Vanity Toolkit v1.0
    -------------------
    A broad test bench for the Vanity UI and the Ham API, built to exercise
    behaviour on your own server and watch what your server-side checks make
    of it.

    Every action is timestamped into an on-screen action log and echoed to the
    F8 console, so a client-side trigger can be lined up against a server-side
    detection hit. The Teleport section deliberately offers both the native
    SetEntityCoords path and Ham's setPosition path for the same jump — useful
    when you want to know whether a check sees both.

    Deliberately not included: the spoofing/bypass family (spoofTeleport,
    speedSpoof, pedSpoof, spoofAllVisible, camBypass, lockEventLogger) and the
    aimbot. Those exist to defeat detection or to target other players, which is
    the opposite of what this bench is for.

    Requires: Vanity (UI) + Ham (drawing, HTTP, inspection).
]]

--------------------------------------------------------------------------------
-- Render loop generation guard
--------------------------------------------------------------------------------
-- Vanity clears the UI on every Execute but leaves old CreateThread loops
-- running. Bumping a global counter retires them on their next frame.

_G.__VANITY_TOOLKIT_GENERATION = (_G.__VANITY_TOOLKIT_GENERATION or 0) + 1
local generation = _G.__VANITY_TOOLKIT_GENERATION

local function isCurrent()
    return _G.__VANITY_TOOLKIT_GENERATION == generation
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
-- State
--------------------------------------------------------------------------------

local cfg = {
    -- overlay
    overlay        = true,
    corner         = "Top Right",
    fontSize       = 14,
    showStatus     = true,
    showLog        = true,
    showInput      = false,
    showShapes     = false,
    showMarker     = false,

    shape          = "Rect Outline",
    shapeR         = 120,
    shapeG         = 200,
    shapeB         = 255,
    thickness      = 2,

    -- teleport
    telMethod      = "Native (SetEntityCoords)",
    telOffset      = 0,

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
    godMode        = false,
    invisible      = false,
    noClip         = false,
    freeCam        = false,
    spectator      = false,
    antiTeleport   = false,
    antiBlock      = false,
    superJump      = false,
    noRagdoll      = false,
    infiniteAmmo   = false,
    disableWeather = false,
    blockInput     = false,
    showCursor     = false,
}

local runSpeed, swimSpeed = 1, 1
local slots = {}          -- teleport slots, 1..5
local savedMarker = nil   -- world position drawn by the 3D marker
local lastDump = ""       -- last inspector dump, for the clipboard
local lastResponse = ""   -- last HTTP body, for the clipboard
local httpStatus = "idle"
local pendingRequest = nil
local spawnedVehicle = nil

local COLORS = {
    panel   = { 12, 14, 18 },
    accent  = { 120, 200, 255, 255 },
    label   = { 150, 158, 170, 255 },
    value   = { 235, 238, 242, 255 },
    on      = { 120, 230, 150, 255 },
    off     = { 110, 116, 126, 255 },
    alert   = { 255, 95, 95, 255 },
    outline = { 0, 0, 0, 220 },
}

--------------------------------------------------------------------------------
-- Action log
--------------------------------------------------------------------------------

local logEntries = {}
local LOG_MAX = 14

-- Defined above as a local so `ham()` can use it before this point.
log = function(text)
    local stamp = GetGameTimer()
    logEntries[#logEntries + 1] = { t = stamp, text = text }
    while #logEntries > LOG_MAX do
        table.remove(logEntries, 1)
    end
    print(("[Toolkit %8.2fs] %s"):format(stamp / 1000.0, text))
end

local function act(text, notifyType)
    log(text)
    if Vanity and Vanity.notify then
        Vanity.notify(text, notifyType or "info", 2000)
    end
end

--------------------------------------------------------------------------------
-- Small helpers
--------------------------------------------------------------------------------

local function ped()
    return PlayerPedId()
end

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

local function onOff(b)
    return b and "on" or "off"
end

-- Best effort: the ground is only known for streamed-in areas, so fall back to
-- the requested Z rather than dropping the player through the map.
local function groundAt(x, y, z)
    local ok, found, gz = pcall(GetGroundZFor_3dCoord, x, y, z + 50.0, false)
    if ok and found and gz and gz > 0.0 then
        return gz + 1.0
    end
    return z
end

local function teleport(x, y, z, label)
    z = z + cfg.telOffset
    if cfg.telMethod == "Ham (setPosition)" then
        ham("setPosition", x + 0.0, y + 0.0, z + 0.0)
    else
        SetEntityCoords(ped(), x + 0.0, y + 0.0, z + 0.0, false, false, false, true)
    end
    act(("Teleport [%s] -> %.1f %.1f %.1f%s"):format(
        cfg.telMethod == "Ham (setPosition)" and "ham" or "native",
        x, y, z, label and ("  (" .. label .. ")") or ""))
end

local function truncate(s, n)
    s = tostring(s)
    if #s <= n then return s end
    return s:sub(1, n - 3) .. "..."
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

--------------------------------------------------------------------------------
-- Inspector dumps
--------------------------------------------------------------------------------

local function publishDump(title, lines)
    local shown = math.min(#lines, cfg.dumpLimit)
    print(("---- %s (%d entries, showing %d) ----"):format(title, #lines, shown))
    for i = 1, shown do
        print("  " .. lines[i])
    end
    if #lines > shown then
        print(("  ... %d more (raise Dump Line Limit)"):format(#lines - shown))
    end
    lastDump = title .. "\n" .. table.concat(lines, "\n")
    act(("%s: %d entries"):format(title, #lines), "success")
end

local function dumpArray(title, value)
    if type(value) ~= "table" then
        act(title .. ": no data", "error")
        return
    end
    local lines = {}
    for _, v in ipairs(value) do
        lines[#lines + 1] = tostring(v)
    end
    publishDump(title, lines)
end

local function dumpEventMap(title, value)
    if type(value) ~= "table" then
        act(title .. ": no data", "error")
        return
    end
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
    if type(bags) ~= "table" then
        act("State bags: no data", "error")
        return
    end
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
-- HTTP
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
    if cfg.httpUrl == "" then
        act("Set a URL first", "error")
        return
    end
    local headers = { ["Content-Type"] = "application/json" }
    local result
    if method == "GET" then
        result = ham("httpGet", cfg.httpUrl, headers)
    else
        result = ham("httpPost", cfg.httpUrl, cfg.httpBody, headers)
    end
    showResponse("HTTP " .. method, result)
end

local function httpAsync(method)
    if cfg.httpUrl == "" then
        act("Set a URL first", "error")
        return
    end
    if pendingRequest then
        act("A request is already in flight", "error")
        return
    end
    local headers = { ["Content-Type"] = "application/json" }
    if method == "GET" then
        pendingRequest = ham("httpGetAsync", cfg.httpUrl, headers)
    else
        pendingRequest = ham("httpPostAsync", cfg.httpUrl, cfg.httpBody, headers)
    end
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
-- Per-frame effects
--------------------------------------------------------------------------------

local function applyPerFrameEffects()
    local p = ped()

    if toggles.superJump then
        SetSuperJumpThisFrame(PlayerId())
    end
    if toggles.noRagdoll then
        SetPedCanRagdoll(p, false)
    end
    if toggles.infiniteAmmo then
        SetPedInfiniteAmmo(p, true, GetSelectedPedWeapon(p))
    end
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
local canDraw        = drawText ~= nil and drawRectFilled ~= nil and getResolution ~= nil

-- drawText's fontSize is independent of the font getTextWidth measures with
-- (12 px by default), so scale the measurement to the configured size.
local function measure(text)
    if not getTextWidth then return #tostring(text) * 7.0 end
    local w = getTextWidth(tostring(text))
    return (w or 0) * (cfg.fontSize / 12.0)
end

local function statusRows()
    local rows = {}
    local function row(label, value, color)
        rows[#rows + 1] = { label = label, value = value, color = color }
    end
    local function flag(label, on)
        row(label, onOff(on), on and COLORS.on or COLORS.off)
    end

    local x, y, z = coords()
    row("Pos", ("%.1f %.1f %.1f"):format(x, y, z))
    row("Speed", ("%.1f m/s"):format(GetEntitySpeed(ped())))
    row("Health", ("%d / armour %d"):format(GetEntityHealth(ped()), GetPedArmour(ped())))

    flag("God", toggles.godMode)
    flag("Invisible", toggles.invisible)
    flag("No-Clip", toggles.noClip)
    flag("Free Cam", toggles.freeCam)
    flag("Spectator", toggles.spectator)
    flag("Anti-TP", toggles.antiTeleport)
    flag("Inf. Ammo", toggles.infiniteAmmo)

    row("TP method", cfg.telMethod == "Ham (setPosition)" and "ham" or "native")
    if httpStatus ~= "idle" then
        row("HTTP", truncate(httpStatus, 34),
            httpStatus:sub(1, 5) == "error" and COLORS.alert or COLORS.value)
    end
    return rows
end

local function inputRows()
    local rows = {}
    if hamFn("getMousePos") then
        local mx, my = ham("getMousePos")
        rows[#rows + 1] = { label = "Mouse", value = ("%.0f, %.0f"):format(mx or 0, my or 0) }
    end
    -- Virtual key codes, per docs/ham/key-codes.md
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
    rows[#rows + 1] = { label = "Keys", value = #down > 0 and table.concat(down, " ") or "-",
                        color = #down > 0 and COLORS.on or COLORS.off }
    return rows
end

local function drawPanel(px, py, title, rows, logLines)
    local pad, lineH = 10, cfg.fontSize + 6
    local labelCol = 0
    for _, r in ipairs(rows) do
        labelCol = math.max(labelCol, measure(r.label))
    end
    labelCol = labelCol + 14

    local contentW = math.max(measure(title), labelCol)
    for _, r in ipairs(rows) do
        contentW = math.max(contentW, labelCol + measure(r.value))
    end
    for _, l in ipairs(logLines or {}) do
        contentW = math.max(contentW, measure(l))
    end

    local rowCount = #rows + (logLines and (#logLines + 1) or 0)
    local panelW = contentW + pad * 2
    local panelH = (rowCount + 1) * lineH + pad * 2 + 6

    drawRectFilled({ px, py, panelW, panelH },
        { COLORS.panel[1], COLORS.panel[2], COLORS.panel[3], 175 }, 6, 0)
    if drawLine then
        drawLine({ px, py }, { px + panelW, py }, COLORS.accent, 2)
    end

    local y = py + pad
    drawText(title, { px + pad, y }, COLORS.accent, cfg.fontSize, false, true, COLORS.outline)
    y = y + lineH + 4

    for _, r in ipairs(rows) do
        drawText(r.label, { px + pad, y }, COLORS.label, cfg.fontSize, false, true, COLORS.outline)
        drawText(r.value, { px + pad + labelCol, y }, r.color or COLORS.value,
            cfg.fontSize, false, true, COLORS.outline)
        y = y + lineH
    end

    if logLines then
        y = y + 4
        drawText("ACTION LOG", { px + pad, y }, COLORS.accent,
            cfg.fontSize, false, true, COLORS.outline)
        y = y + lineH
        for _, l in ipairs(logLines) do
            drawText(l, { px + pad, y }, COLORS.value, cfg.fontSize, false, true, COLORS.outline)
            y = y + lineH
        end
    end

    return panelW, panelH
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
        drawText("Vanity Toolkit", { cx, cy }, color, cfg.fontSize * 2,
            true, true, COLORS.outline)
    end
end

local function drawMarker()
    if not savedMarker or not worldToScreen then return end
    local onScreen, sx, sy = worldToScreen(savedMarker.x, savedMarker.y, savedMarker.z)
    if not onScreen then return end

    local color = { 255, 190, 70, 235 }
    if drawCircle then
        drawCircle({ sx, sy, 10 }, color, 24, 2.0, false)
    end
    if drawLine then
        drawLine({ sx - 16, sy }, { sx + 16, sy }, color, 1)
        drawLine({ sx, sy - 16 }, { sx, sy + 16 }, color, 1)
    end
    local x, y, z = coords()
    local dx, dy, dz = savedMarker.x - x, savedMarker.y - y, savedMarker.z - z
    drawText(("marker  %.1f m"):format(math.sqrt(dx * dx + dy * dy + dz * dz)),
        { sx, sy + 20 }, color, cfg.fontSize, true, true, COLORS.outline)
end

local function drawOverlay()
    local resW, resH = getResolution()
    resW, resH = resW or 1920, resH or 1080

    if cfg.showShapes then drawShapeDemo(resW, resH) end
    if cfg.showMarker then drawMarker() end

    local rows = {}
    if cfg.showStatus then
        for _, r in ipairs(statusRows()) do rows[#rows + 1] = r end
    end
    if cfg.showInput then
        for _, r in ipairs(inputRows()) do rows[#rows + 1] = r end
    end

    local logLines = nil
    if cfg.showLog then
        logLines = {}
        for _, e in ipairs(logEntries) do
            logLines[#logLines + 1] = ("%7.2fs  %s"):format(e.t / 1000.0, truncate(e.text, 52))
        end
        if #logLines == 0 then logLines[1] = "(nothing yet)" end
    end

    if #rows == 0 and not logLines then return end

    -- Measure first so the panel can be placed against the right or bottom edge.
    local pad, lineH = 10, cfg.fontSize + 6
    local labelCol = 0
    for _, r in ipairs(rows) do labelCol = math.max(labelCol, measure(r.label)) end
    labelCol = labelCol + 14
    local contentW = labelCol
    for _, r in ipairs(rows) do contentW = math.max(contentW, labelCol + measure(r.value)) end
    for _, l in ipairs(logLines or {}) do contentW = math.max(contentW, measure(l)) end
    contentW = math.max(contentW, measure("VANITY TOOLKIT"))
    local rowCount = #rows + (logLines and (#logLines + 1) or 0)
    local panelW = contentW + pad * 2
    local panelH = (rowCount + 1) * lineH + pad * 2 + 6

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

    drawPanel(px, py, "VANITY TOOLKIT", rows, logLines)
end

--------------------------------------------------------------------------------
-- Main loop
--------------------------------------------------------------------------------

CreateThread(function()
    while isCurrent() do
        Wait(0)
        applyPerFrameEffects()
        pollHttp()
        if cfg.overlay and canDraw then
            drawOverlay()
        end
    end
end)

--------------------------------------------------------------------------------
-- UI: header
--------------------------------------------------------------------------------

Vanity.addText("Vanity Toolkit v1.0")
Vanity.addText("Test bench — every action is logged with a timestamp")

Vanity.addSeparator("Session")

Vanity.addButton("Print Session Info", function()
    local x, y, z = coords()
    local resW, resH = 0, 0
    if getResolution then resW, resH = getResolution() end
    print("---- session ----")
    print("  user          : " .. tostring(ham("getName")))
    print("  discord       : " .. tostring(ham("getDiscordName")) ..
          " (" .. tostring(ham("getDiscordId")) .. ")")
    print("  server        : " .. tostring(ham("getServerHostname")))
    print("  endpoint      : " .. tostring(ham("getServerEndpoint")))
    print("  server id     : " .. tostring(GetPlayerServerId(PlayerId())))
    print(("  position      : %.2f %.2f %.2f"):format(x, y, z))
    print(("  resolution    : %sx%s"):format(tostring(resW), tostring(resH)))
    print("  ped model     : " .. tostring(GetEntityModel(ped())))
    act("Session info printed", "success")
end, "Dump account, server and client details to the F8 console")

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
    runSpeed = value
    SetRunSprintMultiplierForPlayer(PlayerId(), value * 1.0)
    act("Run speed x" .. value)
end, "Sprint speed multiplier")

Vanity.addSlider("Swim Speed", 1, 10, 1, 1, function(value)
    swimSpeed = value
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
    end, "Which path the jump takes — useful for checking whether both are caught")

Vanity.addSlider("Vertical Offset", 0, 100, 0, 5, function(value)
    cfg.telOffset = value
    log("Teleport Z offset " .. value)
end, "Added to the target Z, e.g. to land above ground")

Vanity.addButton("Teleport to Coords...", function()
    local x, y, z = coords()
    Vanity.promptText({
        title = "Teleport",
        label = "X, Y, Z:",
        default = ("%.1f, %.1f, %.1f"):format(x, y, z),
        maxLen = 100,
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

Vanity.addButton("Set 3D Marker Here", function()
    local x, y, z = coords()
    savedMarker = { x = x, y = y, z = z }
    act("3D marker placed", "success")
end, "Place the world-space marker the overlay draws")

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
                                default = "TOOLKIT", maxLen = 8 },
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
-- UI: world
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

--------------------------------------------------------------------------------
-- UI: weapons
--------------------------------------------------------------------------------

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

Vanity.addToggle("Action Log", true, function(info)
    cfg.showLog = info.toggleState
end, "Timestamped list of the last actions taken")

Vanity.addToggle("Input Panel", false, function(info)
    cfg.showInput = info.toggleState
end, "Live mouse position and held modifier keys")

Vanity.addToggle("3D Marker", false, function(info)
    cfg.showMarker = info.toggleState
    if info.toggleState and not savedMarker then
        act("No marker set — use 'Set 3D Marker Here'", "error")
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
-- UI: input and fonts
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

--------------------------------------------------------------------------------
-- UI: advanced
--------------------------------------------------------------------------------

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
    local text = ham("getClipboard")
    print("---- clipboard ----")
    print(truncate(tostring(text), 2000))
    act("Clipboard printed")
end, "Read the system clipboard into the F8 console")

Vanity.addButton("Clear Action Log", function()
    logEntries = {}
    log("Log cleared")
end, "Empty the on-screen action log")

Vanity.addButton("Reset All Toggles", function()
    for _, name in ipairs({ "godMode", "invisible", "noClip", "freeCam", "spectatorMode",
                            "antiTeleport", "antiBlockControl", "disableWeather" }) do
        ham(name, false)
    end
    for k in pairs(toggles) do toggles[k] = false end
    SetEntityInvincible(ped(), false)
    SetPedCanRagdoll(ped(), true)
    SetRunSprintMultiplierForPlayer(PlayerId(), 1.0)
    SetSwimMultiplierForPlayer(PlayerId(), 1.0)
    act("All toggles reset — menu switches still show their old position", "success")
end, "Turn every feature back off in one go")

if not canDraw then
    print("[Toolkit] Ham drawing unavailable — overlay disabled, menu still works")
end

Vanity.notify("Vanity Toolkit loaded", "success", 2500)
log("Toolkit v1.0 loaded")
