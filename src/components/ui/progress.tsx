"use client";

import { Progress as UiProgress, ProgressIndicator, ProgressTrack } from "@ui-sdk/react/progress";
import { cn } from "./cn";

/** Thin bar. `value` null = indeterminate (pulses). */
export function Progress({ value, className, label }: { value: number | null; className?: string; label?: string }) {
  return (
    <UiProgress value={value} max={100} aria-label={label} className={cn("block h-1 min-w-0", className)}>
      <ProgressTrack className="relative h-full overflow-hidden rounded-full bg-fill-strong">
        <ProgressIndicator className="ui-progress-indicator h-full rounded-full bg-accent transition-[width] duration-300 ease-out data-indeterminate:w-1/4 data-indeterminate:animate-pulse" />
      </ProgressTrack>
    </UiProgress>
  );
}
