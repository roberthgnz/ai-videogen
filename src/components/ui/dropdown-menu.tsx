"use client";

import { DropdownMenu as M, Slot } from "radix-ui";
import { cn } from "./cn";

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;

export function MenuContent({ className, align = "end", ...props }: React.ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={6}
        collisionPadding={8}
        className={cn("ui-pop z-50 min-w-[200px] rounded-[14px] p-1", className)}
        {...props}
      />
    </M.Portal>
  );
}

export function MenuItem({
  className,
  destructive = false,
  icon,
  children,
  ...props
}: React.ComponentProps<typeof M.Item> & { destructive?: boolean; icon?: React.ReactNode }) {
  return (
    <M.Item
      className={cn(
        "flex cursor-pointer select-none items-center gap-3 rounded-[9px] px-3 py-2 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-foreground/[0.06] [&>span:first-child]:text-muted data-[highlighted]:[&>span:first-child]:text-foreground",
        destructive && "text-danger data-[highlighted]:bg-danger/10 [&>span:first-child]:text-danger data-[highlighted]:[&>span:first-child]:text-danger",
        className,
      )}
      {...props}
    >
      {/* Slottable keeps `asChild` working: the icon lands inside the child element
          instead of becoming a second child the Slot can't merge onto. */}
      {icon && <span className="grid w-4 place-items-center opacity-90">{icon}</span>}
      <Slot.Slottable>{children}</Slot.Slottable>
    </M.Item>
  );
}

export function MenuSeparator() {
  return <M.Separator className="mx-2 my-1 h-px bg-border" />;
}
