import * as React from "react"
import { cn } from "@/lib/utils"
import { Progress as ProgressPrimitive } from "radix-ui"

/** Brand-gradient bar with a cyan glint at its end. For a launch timeline use fx/ProgressBeam. */
function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-white/[0.07] shadow-[inset_0_1px_1px_rgb(0_0_0/0.4)]",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="relative h-full w-full flex-1 rounded-full bg-brand transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] after:absolute after:inset-y-0 after:right-0 after:w-3 after:rounded-full after:bg-gradient-to-r after:from-transparent after:to-brand-cyan/80"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
