import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

/*
 * Small status chips. Colour is never the only signal – always put a word inside.
 * default = violet tint, brand = gradient, success/warning/destructive = status, gold = "New" (cyan highlight), muted = quiet.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-brand-violet/15 text-violet-text ring-1 ring-brand-violet/25 ring-inset",
        brand: "bg-brand text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.2)]",
        secondary: "bg-white/[0.07] text-foreground ring-1 ring-white/[0.08] ring-inset",
        muted: "bg-white/[0.05] text-muted-foreground",
        success: "bg-success/12 text-success ring-1 ring-success/25 ring-inset",
        warning: "bg-warning/12 text-warning ring-1 ring-warning/25 ring-inset",
        destructive: "bg-destructive/12 text-destructive ring-1 ring-destructive/25 ring-inset",
        gold: "bg-brand-cyan/12 text-cyan-text ring-1 ring-brand-cyan/30 ring-inset",
        outline: "border-white/[0.12] text-foreground [a&]:hover:bg-white/[0.06]",
        ghost: "[a&]:hover:bg-white/[0.06]",
        link: "text-violet-text underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
