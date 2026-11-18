"use client";

import { Children } from "react";
import { Button as UiButton } from "@ui-sdk/react/button";
import { cn } from "./cn";
import { Tooltip } from "./tooltip";

const VARIANTS = {
  /** Filled with the tint: the one main action on screen. Disabled it stays readable as a quiet grey block. */
  primary: "bg-accent text-on-accent font-semibold hover:brightness-110 active:brightness-90 disabled:bg-fill disabled:text-muted disabled:opacity-100",
  /** Grey fill, ink label. */
  glass: "bg-fill text-foreground font-medium hover:bg-fill-strong active:bg-fill-strong aria-pressed:bg-accent/15 aria-pressed:text-tint data-[state=open]:bg-fill-strong",
  /** Grey fill, tinted label: secondary actions inside panels. */
  outline: "bg-fill text-tint font-medium hover:bg-fill-strong active:bg-fill-strong aria-pressed:bg-accent aria-pressed:text-on-accent data-[state=open]:bg-fill-strong",
  /** No fill until touched; a tinted wash when it is a toggle that is on. */
  ghost: "text-foreground hover:bg-foreground/[0.06] active:bg-foreground/[0.1] aria-pressed:bg-accent/15 aria-pressed:text-tint data-[state=open]:bg-foreground/[0.08]",
  danger: "bg-danger text-white font-semibold hover:brightness-110 active:brightness-90",
  /** Plain: tinted text that dims while pressed. */
  link: "text-tint hover:opacity-75 active:opacity-50",
  /** Suggestion chip (globals.css .glass-chip brings its own size and states). */
  chip: "glass-chip",
} as const;

const SIZES = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-9 px-4 text-sm gap-2",
  // Small targets sink further, or the press would not read at all.
  icon: "h-9 w-9 justify-center [--press-scale:0.92]",
  "icon-sm": "h-8 w-8 justify-center text-sm [--press-scale:0.92]",
  "icon-lg": "h-10 w-10 justify-center [--press-scale:0.92]",
  inline: "text-sm gap-1",
  /** No size of its own: for variants that define it (chip). */
  none: "",
} as const;

export type ButtonProps = Omit<React.ComponentProps<typeof UiButton>, "className" | "children"> & {
  className?: string;
  children?: React.ReactNode;
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  asChild?: boolean;
};

export function Button({ variant = "ghost", size = "md", asChild = false, className, type, children, render, ...props }: ButtonProps) {
  return (
    <UiButton
      render={asChild ? Children.only(children) as React.ReactElement<Record<string, unknown>> : render}
      type={asChild ? undefined : (type ?? "button")}
      className={cn(
        "ui-button inline-flex flex-none cursor-pointer select-none items-center rounded-[10px] disabled:pointer-events-none disabled:cursor-default disabled:opacity-45 aria-disabled:cursor-default aria-disabled:opacity-45",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {asChild ? undefined : children}
    </UiButton>
  );
}

/** Icon-only button: the label is its accessible name and its tooltip. */
export function IconButton({
  label,
  tooltipSide,
  size = "icon",
  ...props
}: Omit<ButtonProps, "aria-label"> & { label: string; tooltipSide?: "top" | "bottom" | "left" | "right" }) {
  const button = <Button aria-label={label} size={size} {...props} />;
  // Disabled buttons get no pointer events, so a tooltip on them would never show.
  if (props.disabled) return button;
  return (
    <Tooltip content={label} side={tooltipSide}>
      {button}
    </Tooltip>
  );
}
