import * as React from "react"
import { cn } from "@/lib/utils"
import { Separator as SeparatorPrimitive } from "radix-ui"

/** Hairline that fades out at both ends. */
function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=horizontal]:bg-gradient-to-r data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px data-[orientation=vertical]:bg-gradient-to-b from-transparent via-white/[0.09] to-transparent",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
