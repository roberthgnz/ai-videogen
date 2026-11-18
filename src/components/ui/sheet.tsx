"use client";

import { Dialog as D, VisuallyHidden } from "radix-ui";
import { cn } from "./cn";

/** Side sheet (Radix Dialog) sliding in from the right: the studio panel on phones. */
export function Sheet({
  open,
  onOpenChange,
  title,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name; not shown (the content brings its own header). */
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="ui-overlay fixed inset-0 z-40 bg-transparent" />
        <D.Content
          aria-describedby={undefined}
          className={cn("ui-sheet glass-panel fixed inset-y-2 right-2 z-40 flex w-[min(400px,92vw)] flex-col overflow-hidden rounded-[20px] outline-none", className)}
        >
          <VisuallyHidden.Root>
            <D.Title>{title}</D.Title>
          </VisuallyHidden.Root>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export const SheetClose = D.Close;
