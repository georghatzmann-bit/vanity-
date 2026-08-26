# Vanity Script API

Scripts execute inside a sandboxed environment with access to a `Vanity` table. Use it to add
interactive UI elements — buttons, toggles, sliders, and more — to your script's submenu in the menu.

## How it works

Elements appear below the **Execute** button, separated by a divider. Every time you click Execute,
the previous UI is cleared and the script runs fresh — you always get a clean slate.

---

## `Vanity.addButton(name, callback, description)`

Adds a clickable button.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Label shown in the menu |
| `callback` | function | yes | Called when the button is pressed |
| `description` | string | no | Tooltip / hover text |

```lua
Vanity.addButton("Say Hello", function()
    print("Hello!")
end, "Prints hello to the console")
```

## `Vanity.addToggle(name, default, callback, description)`

Adds an on/off toggle. The callback receives a table with a `toggleState` boolean.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Label shown in the menu |
| `default` | boolean | no | Initial state (`false` if omitted) |
| `callback` | function | yes | Called when toggled; receives `info.toggleState` (bool) |
| `description` | string | no | Tooltip / hover text |

```lua
Vanity.addToggle("God Mode", false, function(info)
    if info.toggleState then
        print("God mode ON")
    else
        print("God mode OFF")
    end
end, "Toggle invincibility")
```

## `Vanity.addSlider(name, min, max, default, step, callback, description)`

Adds a numeric slider.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Label shown in the menu |
| `min` | number | yes | Minimum value |
| `max` | number | yes | Maximum value |
| `default` | number | no | Starting value (defaults to `min`) |
| `step` | number | no | Increment per tick (defaults to `1`) |
| `callback` | function | yes | Called on change; receives the new value |
| `description` | string | no | Tooltip / hover text |

```lua
Vanity.addSlider("Speed", 0, 200, 50, 5, function(value)
    print("Speed set to: " .. value)
end, "Adjust movement speed")
```

## `Vanity.addSelector(name, choices, callback, description)`

Adds a left/right selector for picking from a list of strings.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Label shown in the menu |
| `choices` | table | yes | Array of strings, e.g. `{"Low", "Medium", "High"}` |
| `callback` | function | yes | Called on change; receives the selected choice string |
| `description` | string | no | Tooltip / hover text |

```lua
Vanity.addSelector("Quality", {"Low", "Medium", "High"}, function(choice)
    print("Selected: " .. choice)
end, "Pick a quality level")
```

## `Vanity.addSubmenu(name, items, description)`

Adds a nested submenu. Items can be a flat array of option tables, or a tabbed layout using
`{ name, options }` tables (tabs are auto-detected).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Label shown in the menu |
| `items` | table | yes | Array of options **or** array of tab objects |
| `description` | string | no | Tooltip / hover text |

**Flat submenu**

```lua
Vanity.addSubmenu("More Options", {
    { name = "Option A", type = "button", func = function() print("A") end },
    { name = "Option B", type = "button", func = function() print("B") end },
}, "Extra settings")
```

**Tabbed submenu**

```lua
Vanity.addSubmenu("Settings", {
    { name = "General", options = {
        { name = "Reset All", type = "button", func = function() print("Reset") end },
    }},
    { name = "Advanced", options = {
        { name = "Debug Mode", type = "button", func = function() print("Debug") end },
    }},
}, "Tabbed settings panel")
```

## `Vanity.addSeparator(name)`

Adds a visual divider line with an optional label.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | no | Optional label on the separator |

```lua
Vanity.addSeparator("Settings")
```

## `Vanity.addText(name)`

Adds a non-interactive text line (cannot be selected or hovered).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Text to display |

```lua
Vanity.addText("Version 1.0")
```

## `Vanity.addTextInput(name, default, placeholder, callback, description)`

Adds an inline text input field.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Label shown in the menu |
| `default` | string | no | Initial value (defaults to `""`) |
| `placeholder` | string | no | Placeholder text when empty |
| `callback` | function | no | Called when the value changes; receives the new string |
| `description` | string | no | Tooltip / hover text |

```lua
Vanity.addTextInput("Player Name", "John", "Enter name...", function(value)
    print("Name set to: " .. value)
end, "Set the target player name")
```

## `Vanity.notify(message, type, duration)`

Shows a toast notification on screen. **Not a UI element** — it fires immediately.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `message` | string | yes | Notification text |
| `type` | string | no | `"info"`, `"success"`, `"error"` (defaults to `"info"`) |
| `duration` | number | no | Duration in milliseconds (defaults to `2000`) |

```lua
Vanity.notify("Script loaded!", "success", 3000)
```

## `Vanity.promptText(opts, callback)`

Opens a text input popup dialog. **Not a UI element** — it fires immediately and shows a modal prompt.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `opts` | table | yes | `{ title, label, default, maxLen }` |
| `callback` | function | yes | Called with `(text, cancelled)` |

```lua
Vanity.promptText({
    title = "Enter Coordinates",
    label = "X, Y, Z:",
    default = "0, 0, 0",
    maxLen = 100,
}, function(text, cancelled)
    if cancelled then return end
    print("Got: " .. text)
end)
```

## `Vanity.clear()`

Removes all UI elements registered by this script. Useful if you want to conditionally rebuild the
UI within a single execution.

```lua
Vanity.clear()
```

---

## Examples

### Simple script

```lua
Vanity.addButton("Print Hello", function()
    print("Hello from Vanity!")
end, "Prints a greeting to the F8 console")
```

### Multiple element types

```lua
Vanity.addText("My Custom Script v1.0")
Vanity.addSeparator("Controls")

Vanity.addButton("Greet", function()
    print("Hello, world!")
end, "Print a greeting")

Vanity.addToggle("Logging", false, function(info)
    if info.toggleState then
        print("Logging enabled")
    else
        print("Logging disabled")
    end
end, "Toggle console logging")

Vanity.addSlider("Volume", 0, 100, 50, 5, function(value)
    print("Volume: " .. value)
end, "Adjust volume level")

Vanity.addSelector("Mode", {"Easy", "Normal", "Hard"}, function(choice)
    print("Mode: " .. choice)
end, "Select difficulty")
```

### Advanced — submenus, tabs, and natives

```lua
Vanity.addText("Teleporter & Vehicle Kit v2.0")

Vanity.addSeparator("Teleport")

local savedCoords = nil

Vanity.addButton("Save Current Position", function()
    local ped = PlayerPedId()
    local coords = GetEntityCoords(ped)
    savedCoords = { x = coords.x, y = coords.y, z = coords.z }
    print(("Saved position: %.1f, %.1f, %.1f"):format(coords.x, coords.y, coords.z))
end, "Store your current coordinates")

Vanity.addButton("Teleport to Saved", function()
    if not savedCoords then
        print("No position saved yet!")
        return
    end
    local ped = PlayerPedId()
    SetEntityCoords(ped, savedCoords.x, savedCoords.y, savedCoords.z, false, false, false, true)
    print("Teleported!")
end, "Go back to your saved position")

Vanity.addSubmenu("Quick Locations", {
    { name = "Airport", type = "button", func = function()
        SetEntityCoords(PlayerPedId(), -1336.0, -3044.0, 13.9, false, false, false, true)
    end },
    { name = "Pier", type = "button", func = function()
        SetEntityCoords(PlayerPedId(), -1850.0, -1231.0, 13.0, false, false, false, true)
    end },
    { name = "Mount Chiliad", type = "button", func = function()
        SetEntityCoords(PlayerPedId(), 450.0, 5566.0, 806.0, false, false, false, true)
    end },
}, "Teleport to popular spots")

Vanity.addSeparator("Vehicle")

local spawnedVehicle = nil

Vanity.addSubmenu("Vehicle Tools", {
    { name = "Spawn", options = {
        { name = "Adder", type = "button", func = function()
            local hash = GetHashKey("adder")
            RequestModel(hash)
            while not HasModelLoaded(hash) do Wait(0) end
            local ped = PlayerPedId()
            local coords = GetEntityCoords(ped)
            local heading = GetEntityHeading(ped)
            spawnedVehicle = CreateVehicle(hash, coords.x, coords.y, coords.z, heading, true, false)
            SetPedIntoVehicle(ped, spawnedVehicle, -1)
            SetModelAsNoLongerNeeded(hash)
            print("Spawned Adder")
        end },
    }},
    { name = "Modify", options = {
        { name = "Repair Vehicle", type = "button", func = function()
            local veh = GetVehiclePedIsIn(PlayerPedId(), false)
            if veh == 0 then print("Not in a vehicle") return end
            SetVehicleFixed(veh)
            print("Vehicle repaired")
        end },
    }},
}, "Spawn, modify, and manage vehicles")

Vanity.addSeparator("Misc")

Vanity.addSlider("Run Speed", 1, 10, 1, 1, function(value)
    SetRunSprintMultiplierForPlayer(PlayerId(), value * 1.0)
    print("Run speed: " .. value .. "x")
end, "Multiply your sprint speed")

Vanity.addToggle("Invisible", false, function(info)
    local ped = PlayerPedId()
    if info.toggleState then
        SetEntityVisible(ped, false, false)
        print("You are now invisible")
    else
        SetEntityVisible(ped, true, false)
        print("You are visible again")
    end
end, "Toggle player visibility")

Vanity.addSelector("Time of Day", {"Morning", "Noon", "Evening", "Night"}, function(choice)
    local hours = { Morning = 7, Noon = 12, Evening = 19, Night = 0 }
    NetworkOverrideClockTime(hours[choice], 0, 0)
    print("Time set to " .. choice)
end, "Change the in-game clock")
```

---

## Ham API

Scripts also have access to the **Ham API** for low-level game interaction — natives, HTTP requests,
events, and more. Documentation for it is not yet mirrored in this repo.
