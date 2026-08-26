--[[
    Test stubs for Vanity + Ham + FiveM natives.

    Lets a script under test run outside the game so its logic can be exercised
    with plain Lua. Installs the globals a script expects, records every UI
    registration, draw call and HTTP request, and drives the render loop frame by
    frame via coroutines (matching CreateThread/Wait semantics).

    Usage:
        local H = dofile("test/stubs.lua")
        dofile("scripts/my-script.lua")
        H.frame()                        -- advance one frame
        H.ui["Show HUD"].cb({ toggleState = false })
]]

local H = {
    ui      = {},   -- registrations, array + keyed by name
    draws   = {},   -- Ham draw calls this frame batch
    posts   = {},   -- Ham HTTP requests
    prints  = {},   -- captured print() output
    threads = {},
}

--------------------------------------------------------------------------- world
H.world = {
    time     = 0,
    ped      = 1,
    coords   = { x = 100.0, y = 200.0, z = 30.0 },
    heading  = 90.0,
    speed    = 0.0,
    health   = 200,
    armour   = 50,
    pedModel = 1885233650,
    veh      = 0,
    vehModel = 0,
    vehSpeed = 0.0,
}
local w = H.world

function PlayerPedId()        return w.ped end
function PlayerId()           return 0 end
function GetPlayerServerId()  return 42 end
function GetGameTimer()       return w.time end
function GetEntityCoords()    return { x = w.coords.x, y = w.coords.y, z = w.coords.z } end
function GetEntityHeading()   return w.heading end
function GetEntityHealth()    return w.health end
function GetPedArmour()       return w.armour end
function GetVehiclePedIsIn()  return w.veh end
function GetEntitySpeed(e)    return (w.veh ~= 0 and e == w.veh) and w.vehSpeed or w.speed end
function GetEntityModel(e)    return (w.veh ~= 0 and e == w.veh) and w.vehModel or w.pedModel end

function CreateThread(fn) H.threads[#H.threads + 1] = coroutine.create(fn) end
function Wait(_)         coroutine.yield() end

H.realPrint = print
function print(...)
    local parts = {}
    for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
    H.prints[#H.prints + 1] = table.concat(parts, " ")
end

-------------------------------------------------------------------------- Vanity
Vanity = {}

local function reg(kind, name, extra)
    local e = { kind = kind, name = name }
    for k, v in pairs(extra or {}) do e[k] = v end
    H.ui[#H.ui + 1] = e
    H.ui[name] = e
    return e
end

function Vanity.addText(n)                 reg("text", n) end
function Vanity.addSeparator(n)            reg("separator", n or "") end
function Vanity.addButton(n, cb, d)        reg("button", n, { cb = cb, desc = d }) end
function Vanity.addToggle(n, def, cb, d)   reg("toggle", n, { default = def, cb = cb, desc = d }) end
function Vanity.addSelector(n, ch, cb, d)  reg("selector", n, { choices = ch, cb = cb, desc = d }) end
function Vanity.addSubmenu(n, items, d)    reg("submenu", n, { items = items, desc = d }) end
function Vanity.notify(m, t, dur)          reg("notify", m, { ntype = t, duration = dur }) end
function Vanity.promptText(o, cb)          reg("prompt", o.title, { opts = o, cb = cb }) end
function Vanity.clear() end

function Vanity.addSlider(n, mn, mx, def, st, cb, d)
    reg("slider", n, { min = mn, max = mx, default = def, step = st, cb = cb, desc = d })
end

function Vanity.addTextInput(n, def, ph, cb, d)
    reg("textinput", n, { default = def, placeholder = ph, cb = cb, desc = d })
end

----------------------------------------------------------------------------- Ham
Ham = {}

H.resolution = { 1920, 1080 }

function Ham.getResolution()     return H.resolution[1], H.resolution[2] end
function Ham.getTextWidth(s)     return #s * 7.0, 12.0 end
function Ham.getName()           return "tester" end
function Ham.getServerEndpoint() return "127.0.0.1:30120" end
function Ham.isGuiOpen()         return false end

-- Set H.drawError to make every Ham draw call raise, so a front end's
-- draw-failure path can be exercised. The scripts capture these functions as
-- locals at load, so the flag has to live inside the function body.
H.drawError = false

local function record(t)
    if H.drawError then error("stub draw failure", 0) end
    H.draws[#H.draws + 1] = t
end

function Ham.drawText(text, p, color, size, centered, outline, outlineColor)
    record({ fn = "drawText", text = text, x = p[1] or p.x, y = p[2] or p.y,
             color = color, size = size, centered = centered })
end

function Ham.drawRectFilled(rect, color, rounding)
    record({ fn = "drawRectFilled", rect = rect, color = color, rounding = rounding })
end

function Ham.drawRect(rect, color, thickness)
    record({ fn = "drawRect", rect = rect, color = color, thickness = thickness })
end

function Ham.drawLine(a, b, color, thickness)
    record({ fn = "drawLine", a = a, b = b, color = color, thickness = thickness })
end

function Ham.drawCircle(circle, color, segments, thickness, filled)
    record({ fn = "drawCircle", circle = circle, color = color,
             segments = segments, thickness = thickness, filled = filled })
end

function Ham.drawRectGradient(rect, colorStart, colorEnd, vertical)
    record({ fn = "drawRectGradient", rect = rect, colorStart = colorStart,
             colorEnd = colorEnd, vertical = vertical })
end

function Ham.drawTexture(texture, pos1, pos2, color)
    record({ fn = "drawTexture", texture = texture, pos1 = pos1, pos2 = pos2, color = color })
end

function Ham.pushClipRect(minPos, maxPos, intersect)
    record({ fn = "pushClipRect", minPos = minPos, maxPos = maxPos, intersect = intersect })
end

function Ham.popClipRect()
    record({ fn = "popClipRect" })
end

function Ham.worldToScreen(x, y, z) return true, x, y end

-- HTTP: requests are recorded and, by default, answered 200 on the next poll.
local nextId = 0
H.httpResponse = { ready = true, pending = false, success = true, status = 200, data = "ok" }

local function request(method, url, payload, headers)
    nextId = nextId + 1
    H.posts[#H.posts + 1] =
        { id = nextId, method = method, url = url, payload = payload, headers = headers }
    return nextId
end

function Ham.httpPostAsync(url, payload, headers) return request("POST", url, payload, headers) end
function Ham.httpGetAsync(url, headers)           return request("GET", url, nil, headers) end
function Ham.getAsyncResult()                     return H.httpResponse end
function Ham.cleanupAsyncRequests() end

--------------------------------------------------------------- extended natives
-- Every native below records its call into H.calls so tests can assert that a
-- menu action reached the game, and a few return plausible values.

H.calls = {}

local function recordCall(name, ...)
    local args = { ... }
    args.n = select("#", ...)
    H.calls[#H.calls + 1] = { name = name, args = args }
    H.calls[name] = (H.calls[name] or 0) + 1
end

H.recordCall = recordCall

-- Writes that move the world. A teleport native that leaves the ped where it
-- was makes every movement assertion vacuous — the ladder would measure zero
-- and no monitor could ever fire — so these four write through to H.world as
-- well as recording the call.
function SetEntityCoords(entity, x, y, z, ...)
    recordCall("SetEntityCoords", entity, x, y, z, ...)
    w.coords.x, w.coords.y, w.coords.z = x, y, z
end

function SetEntityHealth(entity, value)
    recordCall("SetEntityHealth", entity, value)
    w.health = value
end

function SetPedArmour(ped, value)
    recordCall("SetPedArmour", ped, value)
    w.armour = value
end

-- Natives whose return value nothing depends on.
for _, name in ipairs({
    "SetEntityHeading",
    "SetEntityInvincible", "SetEntityVisible", "SetEntityVelocity",
    "SetSuperJumpThisFrame", "SetPedCanRagdoll", "SetPedInfiniteAmmo",
    "SetRunSprintMultiplierForPlayer", "SetSwimMultiplierForPlayer",
    "RequestModel", "SetModelAsNoLongerNeeded", "SetPedIntoVehicle",
    "SetVehicleFixed", "SetVehicleDeformationFixed", "SetVehicleDirtLevel",
    "SetVehicleOnGroundProperly", "SetEntityAsMissionEntity", "DeleteVehicle",
    "SetVehicleModKit", "SetVehicleMod", "ToggleVehicleMod",
    "SetVehicleNumberPlateText", "NetworkOverrideClockTime",
    "SetWeatherTypeNowPersist", "GiveWeaponToPed", "RemoveAllPedWeapons",
}) do
    _G[name] = function(...) recordCall(name, ...) end
end

function GetHashKey(s)          recordCall("GetHashKey", s); return #tostring(s) * 7919 end
function HasModelLoaded()       return true end
function CreateVehicle(...)     recordCall("CreateVehicle", ...); w.veh = 77; return 77 end
function GetNumVehicleMods()    return 4 end
function GetSelectedPedWeapon() return 453432689 end
function GetEntityVelocity()    return { x = 1.0, y = 0.0, z = 0.0 } end

function GetGroundZFor_3dCoord(x, y, z)
    recordCall("GetGroundZFor_3dCoord", x, y, z)
    return true, 30.0
end

-- Waypoint: set H.world.waypoint to a table to make one exist.
w.waypoint = nil
function GetFirstBlipInfoId()   return w.waypoint and 99 or 0 end
function DoesBlipExist(b)       return b ~= 0 end
function GetBlipInfoIdCoord()   return w.waypoint or { x = 0.0, y = 0.0, z = 0.0 } end

------------------------------------------------------------------ extended Ham
-- Feature toggles record their argument so tests can read the last state set.

H.ham = {}

for _, name in ipairs({
    "godMode", "invisible", "noClip", "freeCam", "spectatorMode",
    "antiTeleport", "antiBlockControl", "disableWeather", "toggleMouse",
    "toggleInputBlock",
}) do
    Ham[name] = function(enabled)
        recordCall("Ham." .. name, enabled)
        H.ham[name] = enabled
        return true
    end
end

for _, name in ipairs({ "setNoClipSpeed", "setFreecamSpeed" }) do
    Ham[name] = function(speed)
        recordCall("Ham." .. name, speed)
        H.ham[name] = speed
    end
end

function Ham.setPosition(x, y, z)
    recordCall("Ham.setPosition", x, y, z)
    H.ham.setPosition = { x = x, y = y, z = z }
    w.coords.x, w.coords.y, w.coords.z = x, y, z
end

function Ham.getDiscordName()   return "tester#0001" end
function Ham.getDiscordId()     return "123456789012345678" end
function Ham.getServerHostname() return "Test Server" end

-- Inspection data; tests may overwrite these tables.
H.inspect = {
    resources   = { "chat", "spawnmanager", "mapmanager", "hardcap" },
    injectable  = { "chat", "mapmanager" },
    safe        = { "spawnmanager" },
    pedModels   = { "a_m_y_skater_01", "s_m_y_cop_01" },
    stateBags   = { ["player:1"] = { isDead = false, job = "police" } },
    events      = { chat = { "chat:addMessage" }, spawnmanager = { "playerSpawned" } },
    registered  = { chat = { "chatMessage" } },
}

function Ham.getResources()            return H.inspect.resources end
function Ham.getInjectableResources()  return H.inspect.injectable end
function Ham.getSafeResources()        return H.inspect.safe end
function Ham.getPedModelNames()        return H.inspect.pedModels end
function Ham.getAllStateBags()         return H.inspect.stateBags end
function Ham.getAllEvents()            return H.inspect.events end
function Ham.getAllRegisteredEvents()  return H.inspect.registered end

function Ham.hasResource(name)
    for _, r in ipairs(H.inspect.resources) do
        if r == name then return true end
    end
    return false
end

function Ham.findEvent(term)
    for resource, events in pairs(H.inspect.events) do
        for _, e in ipairs(events) do
            if e:find(term, 1, true) then
                return { event = e, resource = resource }
            end
        end
    end
    return nil
end

H.clipboard = ""
function Ham.copyToClipboard(text) H.clipboard = text; recordCall("Ham.copyToClipboard") end
function Ham.getClipboard()        return H.clipboard end
function Ham.openUrl(url)          recordCall("Ham.openUrl", url); return true end
function Ham.Execute(res, code)    recordCall("Ham.Execute", res, code); return true end

function Ham.addFont(index, size)  recordCall("Ham.addFont", index, size); return { font = index } end
function Ham.setFont(handle)       recordCall("Ham.setFont", handle) end
function Ham.resetFont()           recordCall("Ham.resetFont") end

-- Anti-cheat detection: tests may overwrite the list, or set it to nil to
-- simulate a build where Ham cannot answer.
H.antiCheats = { "FiveGuard", "ElectronAC" }
function Ham.getAntiCheats()
    recordCall("Ham.getAntiCheats")
    if H.antiCheats == nil then error("getAntiCheats failed", 0) end
    return H.antiCheats
end

-- Input. Mouse buttons are edge-triggered like the real API: H.click() arms a
-- press for exactly one frame, H.frame() clears it again.
H.mouse = { x = 640.0, y = 360.0 }
H.keysDown = {}
H.mouseDown = {}
H.mouseClicked = {}
H.mouseReleased = {}
H.keysPressed = {}

function Ham.getMousePos()  return H.mouse.x, H.mouse.y end
function Ham.getKeyState(k) return H.keysDown[k] and 1 or 0 end
function Ham.isKeyDown(k)   return H.keysDown[k] or false end
function Ham.isKeyPressed(k)  return H.keysPressed[k] or false end
function Ham.isKeyReleased(k) return false end
function Ham.isMouseDown(b)     return H.mouseDown[b or 0] or false end
function Ham.isMouseClicked(b)  return H.mouseClicked[b or 0] or false end
function Ham.isMouseReleased(b) return H.mouseReleased[b or 0] or false end
function Ham.isMouseDoubleClicked() return false end

-- Buttons released automatically at the end of the frame they were pressed in.
H.mouseAuto = {}

-- Move the cursor to (x, y) and press for exactly one frame.
function H.click(x, y, button)
    local b = button or 0
    H.mouse.x, H.mouse.y = x, y
    H.mouseClicked[b], H.mouseDown[b], H.mouseAuto[b] = true, true, true
end

-- Press and keep holding, for drags. Pair with H.moveTo and H.release.
function H.hold(x, y, button)
    local b = button or 0
    H.mouse.x, H.mouse.y = x, y
    H.mouseClicked[b], H.mouseDown[b] = true, true
    H.mouseAuto[b] = nil
end

function H.release(button)
    local b = button or 0
    H.mouseDown[b], H.mouseReleased[b] = false, true
    H.mouseAuto[b] = nil
end

function H.moveTo(x, y) H.mouse.x, H.mouse.y = x, y end
function H.hover(x, y)  H.mouse.x, H.mouse.y = x, y end

function H.press(key) H.keysPressed[key] = true end

-- Hold a virtual key down for one frame, so getKeyState sees a press edge.
function H.tapKey(vk)
    H.keysDown[vk] = true
    H.frame()
    H.keysDown[vk] = false
end

H.httpSyncResponse = { success = true, status = 200, data = '{"ok":true}' }
function Ham.httpGet(url, headers)
    recordCall("Ham.httpGet", url)
    H.posts[#H.posts + 1] = { method = "GET", url = url, headers = headers, sync = true }
    return H.httpSyncResponse
end
function Ham.httpPost(url, payload, headers)
    recordCall("Ham.httpPost", url)
    H.posts[#H.posts + 1] =
        { method = "POST", url = url, payload = payload, headers = headers, sync = true }
    return H.httpSyncResponse
end

--------------------------------------------------------------------------- driver
function H.frame(ms)
    w.time = w.time + (ms or 16)
    for _, co in ipairs(H.threads) do
        if coroutine.status(co) ~= "dead" then
            local ok, err = coroutine.resume(co)
            if not ok then error("thread error: " .. tostring(err), 0) end
        end
    end
    -- Clicks and key presses last exactly one frame, as they do in Ham. A
    -- button pressed with H.click comes back up; one pressed with H.hold stays
    -- down until H.release, which is what a drag needs.
    for b in pairs(H.mouseAuto) do H.mouseDown[b] = false end
    H.mouseAuto = {}
    H.mouseClicked, H.mouseReleased, H.keysPressed = {}, {}, {}
end

function H.frames(n, ms)
    for _ = 1, n do H.frame(ms) end
end

function H.clearDraws() H.draws = {} end

function H.aliveThreads()
    local n = 0
    for _, co in ipairs(H.threads) do
        if coroutine.status(co) ~= "dead" then n = n + 1 end
    end
    return n
end

-- The value drawn immediately after a label, i.e. the right-hand column of a row.
function H.rowValue(labelPrefix)
    for i, d in ipairs(H.draws) do
        if d.fn == "drawText" and d.text:sub(1, #labelPrefix) == labelPrefix then
            return H.draws[i + 1]
        end
    end
end

function H.hasText(text)
    for _, d in ipairs(H.draws) do
        if d.fn == "drawText" and d.text == text then return true end
    end
    return false
end

-- Every drawText of this frame batch, in draw order.
function H.drawnTexts()
    local out = {}
    for _, d in ipairs(H.draws) do
        if d.fn == "drawText" then out[#out + 1] = d.text end
    end
    return out
end

-- A drawn label, by exact text or by prefix. Immediate-mode widgets hit-test
-- where they draw, so a label's position is a place a click lands on it.
function H.findText(text, prefix)
    for _, d in ipairs(H.draws) do
        if d.fn == "drawText" then
            if d.text == text then return d end
            if prefix and d.text:sub(1, #text) == text then return d end
        end
    end
end

-- Click on a drawn label. Returns false if it was not drawn this frame.
function H.clickText(text, prefix)
    local d = H.findText(text, prefix)
    if not d then return false end
    H.click(d.x, d.y)
    return true
end

-- The window a self-drawn GUI paints: the panel of the shadow/panel pair, i.e.
-- two consecutive filled rects of the same size with the second offset back.
function H.windowRect()
    for i = 1, #H.draws - 1 do
        local a, b = H.draws[i], H.draws[i + 1]
        if a.fn == "drawRectFilled" and b.fn == "drawRectFilled"
            and a.rect[3] == b.rect[3] and a.rect[4] == b.rect[4]
            and b.rect[1] < a.rect[1] and b.rect[2] < a.rect[2] then
            return b.rect
        end
    end
end

return H
