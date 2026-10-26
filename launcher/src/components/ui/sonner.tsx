import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/*
 * Toasts: dark glass with a coloured edge and a tinted icon tile (styles in index.css, ".nb-toast").
 * Niobium is always dark – so no theme switching.
 */
const Toaster = ({ toastOptions, ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      gap={10}
      offset={18}
      visibleToasts={4}
      icons={{
        success: <CircleCheckIcon className="size-4 text-success" />,
        info: <InfoIcon className="size-4 text-violet-text" />,
        warning: <TriangleAlertIcon className="size-4 text-warning" />,
        error: <OctagonXIcon className="size-4 text-destructive" />,
        loading: <Loader2Icon className="size-4 animate-spin text-violet-text" />,
      }}
      toastOptions={{
        ...toastOptions,
        classNames: { toast: "nb-toast", ...toastOptions?.classNames },
      }}
      style={
        {
          "--normal-bg": "var(--nb-glass-strong)",
          "--normal-text": "var(--nb-text)",
          "--normal-border": "rgb(255 255 255 / 0.09)",
          "--border-radius": "12px",
          "--width": "360px",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
