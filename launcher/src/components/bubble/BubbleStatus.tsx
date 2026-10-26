import { Bubbles, CircleSlash, FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBubbleSupport } from "@/hooks/use-bubble-support";
import { bubbleText, isExperimentalLevel } from "@/lib/bubble";
import { cn } from "@/lib/utils";

/**
 * Small chip that says whether a build can use Bubble Builds (e.g. on Library cards).
 * Tooltip = the English note. `hideUnavailable` shows nothing for versions without them.
 */
export function BubbleStatus({
  version,
  hideUnavailable = false,
  className,
}: {
  version: string;
  hideUnavailable?: boolean;
  className?: string;
}) {
  const info = useBubbleSupport(version);
  if (!info || (hideUnavailable && info.level === "unavailable")) return null;
  const experimental = isExperimentalLevel(info.level);
  const Icon = info.level === "supported" ? Bubbles : experimental ? FlaskConical : CircleSlash;
  const variant = info.level === "supported" ? "default" : experimental ? "warning" : "muted";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant} tabIndex={0} className={cn("cursor-help", className)}>
          <Icon />
          {bubbleText.levelLabel[info.level]}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{info.note}</TooltipContent>
    </Tooltip>
  );
}
