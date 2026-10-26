"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Slider as SliderPrimitive } from "radix-ui"

/** Gradient track, white knob with a violet halo that grows on hover and while dragging. */
function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  const _values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : Array.isArray(defaultValue)
          ? defaultValue
          : [min, max],
    [value, defaultValue, min, max]
  )

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        "group/slider relative flex w-full cursor-pointer touch-none items-center py-1.5 select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          "relative grow overflow-hidden rounded-full bg-white/[0.08] shadow-[inset_0_1px_1px_rgb(0_0_0/0.4)] data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5"
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            "absolute bg-brand data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
          )}
        />
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          className="block size-4 shrink-0 rounded-full bg-white shadow-[0_0_0_4px_rgb(122_60_255/0.25),0_2px_6px_rgb(0_0_0/0.5)] transition-[box-shadow,scale] duration-150 ease-out hover:shadow-[0_0_0_6px_rgb(122_60_255/0.3),0_0_16px_rgb(122_60_255/0.6)] focus-visible:shadow-[0_0_0_6px_rgb(155_123_255/0.45),0_0_16px_rgb(122_60_255/0.6)] focus-visible:outline-hidden active:scale-110 disabled:pointer-events-none disabled:opacity-50"
        />
      ))}
    </SliderPrimitive.Root>
  )
}

export { Slider }
