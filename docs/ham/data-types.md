# Data Types

This page describes the common data types used throughout the Ham API.

## Vector2 / Position

Positions can be specified in multiple formats:

```lua
-- Array format
{100, 200}

-- Named format
{x = 100, y = 200}
```

## Vector4 / Color

Colors use RGBA format (0-255 each):

```lua
-- Array format
{255, 128, 0, 255}  -- Orange, fully opaque

-- Named format (x=r, y=g, z=b, w=a)
{x = 255, y = 128, z = 0, w = 255}
```

## Rectangle

```lua
-- Array format: {x, y, width, height}
{100, 100, 200, 50}

-- Named format
{x = 100, y = 100, w = 200, h = 50}
```

## Circle

```lua
-- Array format: {x, y, radius}
{200, 200, 50}

-- Named format
{x = 200, y = 200, radius = 50}
```
