import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

/*
 * Niobium buttons. default = brand gradient (the main action), secondary = glass,
 * outline = hairline, ghost = text only, destructive = red, link = violet text.
 * All press to 97 % and show a violet focus ring for keyboard users.
 */
const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg text-sm font-medium whitespace-nowrap transition-[color,background-color,box-shadow,scale,opacity,filter] duration-150 ease-out outline-none select-none active:scale-[0.97] focus-visible:ring-[3px] focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-brand text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.22),inset_0_0_0_1px_rgb(255_255_255/0.1),0_6px_20px_-8px_rgb(139_92_246/0.7)] hover:brightness-110 hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.25),inset_0_0_0_1px_rgb(255_255_255/0.14),0_8px_28px_-8px_rgb(139_92_246/0.85)]",
        destructive:
          "bg-destructive/90 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_6px_20px_-10px_rgb(239_68_68/0.7)] hover:bg-destructive focus-visible:ring-destructive/40",
        outline:
          "bg-white/[0.02] text-foreground shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)] hover:bg-white/[0.06] hover:shadow-[inset_0_0_0_1px_rgb(196_181_253/0.4)]",
        secondary:
          "bg-white/[0.07] text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.06),inset_0_0_0_1px_rgb(255_255_255/0.07)] backdrop-blur-md hover:bg-white/[0.11]",
        ghost:
          "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground",
        link: "text-violet-text underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-lg px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 rounded-md",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
