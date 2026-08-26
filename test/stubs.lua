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

local function record(t) H.draws[#H.draws + 1] = t end

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

function Ham.drawCircle(circle, color, thickness)
    record({ fn = "drawCircle", circle = circle, color = color, thickness = thickness })
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

--------------------------------------------------------------------------- driver
function H.frame(ms)
    w.time = w.time + (ms or 16)
    for _, co in ipairs(H.threads) do
        if coroutine.status(co) ~= "dead" then
            local ok, err = coroutine.resume(co)
            if not ok then error("thread error: " .. tostring(err), 0) end
        end
    end
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

return H
