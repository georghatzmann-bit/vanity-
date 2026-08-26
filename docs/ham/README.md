# Ham Lua API — mirrored reference

Mirrored from <https://docs.hammafia.cc/api/> so scripts can be written against a checked-in
reference. One file per function, named after the page slug.

---

# Ham Lua API Documentation

**Note:** The Ham API is accessible via `Ham`, `ham` global tables. All functions are available in both camelCase and lowercase variants.

## Categories

### General

- [getName](getName.md) - Get authenticated username
- [getDiscordName](getDiscordName.md) - Get Discord username
- [getDiscordId](getDiscordId.md) - Get Discord ID
- [isGuiOpen](isGuiOpen.md) - Check if GUI menu is open

### Input Handling

- [isKeyDown](isKeyDown.md) - Check if key is held
- [isKeyPressed](isKeyPressed.md) - Check if key was pressed
- [isKeyReleased](isKeyReleased.md) - Check if key was released
- [isMouseDown](isMouseDown.md) - Check if mouse button is held
- [isMouseClicked](isMouseClicked.md) - Check if mouse was clicked
- [isMouseDoubleClicked](isMouseDoubleClicked.md) - Check for double-click
- [isMouseReleased](isMouseReleased.md) - Check if mouse was released
- [getMousePos](getMousePos.md) - Get mouse position
- [getKeyState](getKeyState.md) - Get async key state
- [toggleMouse](toggleMouse.md) - Toggle mouse cursor
- [toggleInputBlock](toggleInputBlock.md) - Block game input

### Clipboard

- [copyToClipboard](copyToClipboard.md) - Copy text to clipboard
- [getClipboard](getClipboard.md) - Get clipboard contents

### Drawing API

- [drawLine](drawLine.md) - Draw a line
- [drawRect](drawRect.md) - Draw rectangle outline
- [drawRectFilled](drawRectFilled.md) - Draw filled rectangle
- [drawRectGradient](drawRectGradient.md) - Draw gradient rectangle
- [drawCircle](drawCircle.md) - Draw a circle
- [drawText](drawText.md) - Draw text
- [drawTexture](drawTexture.md) - Draw a texture
- [pushClipRect](pushClipRect.md) - Push clipping rectangle
- [popClipRect](popClipRect.md) - Pop clipping rectangle
- [getTextWidth](getTextWidth.md) - Measure text dimensions
- [getResolution](getResolution.md) - Get screen resolution
- [worldToScreen](worldToScreen.md) - Convert 3D to 2D coordinates

### Font Management

- [addFont](addFont.md) - Add built-in font
- [addWindowsFont](addWindowsFont.md) - Add Windows font
- [addCustomFont](addCustomFont.md) - Add custom font from URL
- [setFont](setFont.md) - Set active font
- [resetFont](resetFont.md) - Reset to default font

### Texture Management

- [addCustomTexture](addCustomTexture.md) - Load texture from URL
- [addCustomTextureAsync](addCustomTextureAsync.md) - Async texture load
- [getAsyncTextureResult](getAsyncTextureResult.md) - Check async texture status
- [cleanupAsyncTextureRequests](cleanupAsyncTextureRequests.md) - Cleanup texture requests

### Utility Functions

- [openUrl](openUrl.md) - Open URL in browser
- [Execute](Execute.md) - Execute Lua code
- [disableWeather](disableWeather.md) - Disable weather effects
- [passObjectControl](passObjectControl.md) - Pass entity control
- [lockEventLogger](lockEventLogger.md) - Lock event logger
- [unlockEventLogger](unlockEventLogger.md) - Unlock event logger

### HTTP Client

- [httpGet](httpGet.md) - Sync HTTP GET
- [httpPost](httpPost.md) - Sync HTTP POST
- [httpGetAsync](httpGetAsync.md) - Async HTTP GET
- [httpPostAsync](httpPostAsync.md) - Async HTTP POST
- [getAsyncResult](getAsyncResult.md) - Check async HTTP status
- [cleanupAsyncRequests](cleanupAsyncRequests.md) - Cleanup HTTP requests

### Server & Resource Info

- [getServerEndpoint](getServerEndpoint.md) - Get server endpoint
- [getServerHostname](getServerHostname.md) - Get server hostname
- [getResources](getResources.md) - Get all resources
- [hasResource](hasResource.md) - Check if resource exists
- [getInjectableResources](getInjectableResources.md) - Get injectable resources
- [getSafeResources](getSafeResources.md) - Get safe resources
- [getAntiCheats](getAntiCheats.md) - Get detected anti-cheats
- [getAllStateBags](getAllStateBags.md) - Get all state bags
- [getAllEvents](getAllEvents.md) - Get all events
- [getAllRegisteredEvents](getAllRegisteredEvents.md) - Get registered events
- [findEvent](findEvent.md) - Search for event
- [getPedModelNames](getPedModelNames.md) - Get ped model names

### Player Features

- [godMode](godMode.md) - Toggle invincibility
- [noClip](noClip.md) - Toggle no-clip
- [setNoClipSpeed](setNoClipSpeed.md) - Set no-clip speed
- [aimBot](aimBot.md) - Toggle aimbot
- [setAimbotFov](setAimbotFov.md) - Set aimbot FOV
- [setAimbotSmoothing](setAimbotSmoothing.md) - Set aimbot smoothing
- [setAimbotBone](setAimbotBone.md) - Set target bone
- [setAimbotKey](setAimbotKey.md) - Set aimbot key
- [setAimbotIgnoreVehicles](setAimbotIgnoreVehicles.md) - Ignore vehicles
- [setAimbotVisibleOnly](setAimbotVisibleOnly.md) - Target visible only
- [freeCam](freeCam.md) - Toggle free camera
- [setFreecamSpeed](setFreecamSpeed.md) - Set freecam speed
- [camBypass](camBypass.md) - Toggle camera bypass
- [spoofTeleport](spoofTeleport.md) - Toggle teleport spoof
- [spoofAllVisible](spoofAllVisible.md) - Spoof visibility
- [spinBot](spinBot.md) - Toggle spin bot
- [setSpinbotSpeed](setSpinbotSpeed.md) - Set spinbot speed
- [setPosition](setPosition.md) - Set player position
- [setKeyboardLayout](setKeyboardLayout.md) - Set keyboard layout
- [antiTeleport](antiTeleport.md) - Toggle anti-teleport
- [invisible](invisible.md) - Toggle invisibility
- [speedSpoof](speedSpoof.md) - Toggle speed spoof
- [antiBlockControl](antiBlockControl.md) - Toggle anti-block
- [pedSpoof](pedSpoof.md) - Toggle ped spoof
- [spectatorMode](spectatorMode.md) - Toggle spectator mode

### Reference

- [Data Types](data-types.md) - Position, color, rectangle formats
- [Key Codes](key-codes.md) - ImGui and virtual key codes
