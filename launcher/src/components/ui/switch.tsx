import * as React from "react"
import { cn } from "@/lib/utils"
import { Switch as SwitchPrimitive } from "radix-ui"

/** On = brand gradient with a soft glow; the knob springs across. */
function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-full p-[2px] transition-[background-color,box-shadow] duration-200 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-45",
        "data-[size=default]:h-[22px] data-[size=default]:w-[38px] data-[size=sm]:h-[18px] data-[size=sm]:w-[30px]",
        "data-[state=unchecked]:bg-white/[0.1] data-[state=unchecked]:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] hover:data-[state=unchecked]:bg-white/[0.14]",
        "data-[state=checked]:bg-brand data-[state=checked]:shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_0_14px_-2px_rgb(139_92_246/0.65)]",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.45)] ring-0 transition-[translate,scale,background-color] duration-[260ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]",
          "group-data-[size=default]/switch:size-[18px] group-data-[size=sm]/switch:size-[14px]",
          "data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-[#dcdce8] group-data-[size=default]/switch:data-[state=checked]:translate-x-4 group-data-[size=sm]/switch:data-[state=checked]:translate-x-3",
          "group-active/switch:scale-90"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
