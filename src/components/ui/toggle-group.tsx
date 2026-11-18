"use client";

import { useLayoutEffect, useRef } from "react";
import { Toggle as UiToggle, ToggleGroup as UiToggleGroup } from "@ui-sdk/react/toggle";
import { cn } from "./cn";

/**
 * Single-choice group that always has a value (a click on the active item
 * doesn't clear it). "segmented" is the iOS segmented control: one raised thumb that slides to the
 * chosen segment; "cards" lays items out as tiles.
 */
export function ToggleGroup<V extends string>({
  value,
  onValueChange,
  variant = "segmented",
  className,
  children,
  disabled,
  "aria-label": ariaLabel,
}: {
  value: V;
  onValueChange: (value: V) => void;
  variant?: "segmented" | "cards";
  className?: string;
  children: React.ReactNode;
  disabled?: boolean;
  "aria-label": string;
}) {
  const root = useRef<HTMLDivElement>(null);
  // The thumb is one element for the whole control (.ui-segmented::before in globals.css): it is told where
  // the chosen segment is, and a spring takes it there. Written straight to the element, so moving it costs
  // no render; measured again whenever the control changes size (a longer label, a panel that opens).
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || variant !== "segmented") return;
    const place = () => {
      const on = el.querySelector<HTMLElement>(":scope > [data-pressed]");
      if (!on || !on.offsetWidth) { delete el.dataset.thumb; return; }
      el.style.setProperty("--seg-x", `${on.offsetLeft}px`);
      el.style.setProperty("--seg-w", `${on.offsetWidth}px`);
      el.dataset.thumb = "";
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [value, variant]);

  return (
    <UiToggleGroup<V>
      ref={root}
      value={value ? [value] : []}
      deselectable={false}
      disabled={disabled}
      aria-label={ariaLabel}
      onValueChange={([v]) => v !== undefined && onValueChange(v)}
      className={cn("ui-toggle-group", variant === "segmented" ? "ui-segmented" : "grid gap-2", className)}
      data-variant={variant}
    >
      {children}
    </UiToggleGroup>
  );
}

export function ToggleGroupItem({
  value,
  children,
  className,
  variant = "segmented",
  title,
  "aria-label": ariaLabel,
}: {
  value: string;
  children: React.ReactNode;
  className?: string;
  variant?: "segmented" | "cards";
  title?: string;
  "aria-label"?: string;
}) {
  return (
    <UiToggle
      value={value}
      title={title}
      aria-label={ariaLabel}
      className={cn(
        variant === "segmented"
          ? "ui-segment"
          : "cursor-pointer rounded-xl border border-transparent bg-fill px-3 py-2 text-left transition-[background-color,border-color,box-shadow] duration-150 hover:bg-fill-strong active:bg-fill-strong data-disabled:cursor-default data-disabled:opacity-45 data-pressed:border-accent data-pressed:bg-accent/10 data-pressed:shadow-[0_0_0_1px_var(--accent)]",
        className,
      )}
    >
      {children}
    </UiToggle>
  );
}

/** On/off button (loop, mute): a tinted wash when it is on. */
export function Toggle({ className, ...props }: Omit<React.ComponentProps<typeof UiToggle>, "className"> & { className?: string }) {
  return (
    <UiToggle
      className={cn(
        "ui-button grid h-9 w-9 cursor-pointer place-items-center rounded-[10px] text-muted [--press-scale:0.92] hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.1] data-disabled:cursor-default data-disabled:opacity-45 data-pressed:bg-accent/15 data-pressed:text-tint",
        className,
      )}
      {...props}
    />
  );
}
