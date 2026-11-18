"use client";

import { ScrollArea as S } from "radix-ui";
import { cn } from "./cn";

/** Scroll container with a thin overlay scrollbar. `viewportRef` reaches the scrolling element. */
export function ScrollArea({
  className,
  viewportClassName,
  viewportRef,
  children,
  orientation = "vertical",
  ...props
}: Omit<React.ComponentProps<typeof S.Root>, "dir"> & {
  viewportClassName?: string;
  viewportRef?: React.Ref<HTMLDivElement>;
  orientation?: "vertical" | "horizontal";
}) {
  return (
    <S.Root type="hover" scrollHideDelay={500} className={cn("relative overflow-hidden", className)} {...props}>
      <S.Viewport ref={viewportRef} className={cn("h-full w-full", viewportClassName)}>
        {children}
      </S.Viewport>
      <S.Scrollbar
        orientation={orientation}
        className={cn(
          "flex touch-none select-none p-0.5 transition-colors",
          orientation === "vertical" ? "h-full w-2.5" : "h-2.5 flex-col",
        )}
      >
        <S.Thumb className="relative flex-1 rounded-full bg-foreground/20 hover:bg-foreground/35" />
      </S.Scrollbar>
      <S.Corner />
    </S.Root>
  );
}
