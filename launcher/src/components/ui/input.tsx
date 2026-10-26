import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-lg bg-black/25 px-3 py-1 text-sm shadow-[inset_0_0_0_1px_rgb(255_255_255/0.09),inset_0_1px_2px_rgb(0_0_0/0.3)] transition-[color,box-shadow,background-color] duration-150 outline-none selection:bg-brand-violet/50 selection:text-white file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-faint hover:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14),inset_0_1px_2px_rgb(0_0_0/0.3)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:bg-black/35 focus-visible:shadow-[inset_0_0_0_1px_rgb(167_139_250/0.8),0_0_0_3px_rgb(139_92_246/0.22),0_0_18px_-4px_rgb(139_92_246/0.45)]",
        "aria-invalid:shadow-[inset_0_0_0_1px_rgb(239_68_68/0.8),0_0_0_3px_rgb(239_68_68/0.18)]",
        className
      )}
      {...props}
    />
  )
}

export { Input }
