"use client";

import { Switch as UiSwitch, SwitchThumb } from "@ui-sdk/react/switch";
import { cn } from "./cn";

export function Switch({ className, ...props }: Omit<React.ComponentProps<typeof UiSwitch>, "className"> & { className?: string }) {
  return (
    <UiSwitch className={cn("ui-switch", className)} {...props}>
      <SwitchThumb className="ui-switch-thumb" />
    </UiSwitch>
  );
}
