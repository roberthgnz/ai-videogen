"use client";

import { Tabs as UiTabs, TabsList as UiTabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import { cn } from "./cn";

export const Tabs = UiTabs;

export function TabsList({ className, ...props }: Omit<React.ComponentProps<typeof UiTabsList>, "className"> & { className?: string }) {
  return <UiTabsList className={cn("ui-tabs-list flex items-center gap-1", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: Omit<React.ComponentProps<typeof TabsTab>, "className"> & { className?: string }) {
  return (
    <TabsTab
      className={cn(
        "ui-button cursor-pointer rounded-full px-3 py-1.5 text-sm text-muted hover:bg-foreground/[0.05] hover:text-foreground disabled:pointer-events-none disabled:opacity-45",
        "data-selected:bg-fill data-selected:font-medium data-selected:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: Omit<React.ComponentProps<typeof TabsPanel>, "className"> & { className?: string }) {
  return <TabsPanel className={cn("outline-none", className)} {...props} />;
}
