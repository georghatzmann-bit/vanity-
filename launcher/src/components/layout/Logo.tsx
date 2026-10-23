import { cn } from "@/lib/utils";

/** Vanity-Zeichen: ein „V“ aus zwei Balken auf violettem Grund. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="64 64 896 896" className={cn("size-8", className)} aria-hidden="true">
      <defs>
        <linearGradient id="vanity-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8a6bff" />
          <stop offset="1" stopColor="#3a22b8" />
        </linearGradient>
      </defs>
      <rect x="64" y="64" width="896" height="896" rx="208" fill="url(#vanity-logo-bg)" />
      <path d="M268 286 h132 l112 330 l-66 156 z" fill="#fff" />
      <path d="M756 286 h-132 l-178 486 h132 z" fill="#fff" fillOpacity="0.78" />
    </svg>
  );
}
