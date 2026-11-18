"use client";

import { Children } from "react";
import { Tooltip as UiTooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { cn } from "./cn";

/** Ink tooltip around a single focusable child. */
export function Tooltip({
  content,
  children,
  side = "bottom",
  className,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}) {
  return (
    <UiTooltip delay={350}>
      <TooltipTrigger className="ui-tooltip-trigger" render={Children.only(children) as React.ReactElement<Record<string, unknown>>} />
      <TooltipContent
        side={side}
        sideOffset={6}
        collisionPadding={8}
        className={cn("ui-tooltip z-50 max-w-xs rounded-lg px-2.5 py-1.5 text-xs font-medium leading-4", className)}
      >
        {content}
      </TooltipContent>
    </UiTooltip>
  );
}
