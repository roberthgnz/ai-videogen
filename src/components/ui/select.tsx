"use client";

import { Children, isValidElement } from "react";
import {
  Select as UiSelect,
  SelectContent,
  SelectGroup as UiSelectGroup,
  SelectGroupLabel,
  SelectItem as UiSelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectSeparator as UiSelectSeparator,
  SelectTrigger,
  SelectValue,
  type ListData,
} from "@ui-sdk/react/select";
import { cn } from "./cn";

export function Select({
  value,
  onValueChange,
  placeholder,
  disabled,
  children,
  className,
  size = "md",
  "aria-label": ariaLabel,
  id,
  leading,
}: {
  value: string | undefined;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
  size?: "sm" | "md";
  "aria-label"?: string;
  id?: string;
  /** Shown before the value (a colour dot, an icon). */
  leading?: React.ReactNode;
}) {
  return (
    <UiSelect<string>
      value={value ?? null}
      onValueChange={(next) => { if (next !== null) onValueChange(next); }}
      disabled={disabled}
      items={collectItems(children)}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          "ui-field group inline-flex min-w-0 cursor-pointer items-center gap-2 text-left disabled:cursor-default",
          size === "sm" ? "h-8 rounded-[9px] px-2.5 text-xs font-medium" : "h-9 w-full rounded-[10px] px-3 text-sm",
          className,
        )}
      >
        {leading}
        <span className="min-w-0 flex-1 truncate">
          <SelectValue placeholder={placeholder} className="data-placeholder:text-muted" />
        </span>
        <Chevron className="flex-none text-muted transition-transform duration-150 group-data-open:rotate-180" />
      </SelectTrigger>
      <SelectContent
        sideOffset={6}
        collisionPadding={8}
        className="ui-pop z-50 max-h-[min(380px,var(--available-height))] min-w-[var(--anchor-width)] overflow-y-auto rounded-[14px] border-0 p-1"
      >
        {children}
      </SelectContent>
    </UiSelect>
  );
}

export function SelectItem({
  value,
  children,
  hint,
  disabled,
}: {
  value: string;
  children: React.ReactNode;
  /** Second line in the list (not shown in the trigger). */
  hint?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <UiSelectItem
      value={value}
      disabled={disabled}
      label={textContent(children)}
      className="relative flex cursor-pointer select-none flex-col rounded-[9px] py-2 pl-8 pr-3 text-sm outline-none data-disabled:cursor-default data-disabled:opacity-45 data-highlighted:bg-foreground/[0.06] data-selected:font-medium"
    >
      <SelectItemIndicator className="absolute left-2.5 top-2.5 text-foreground">
        <Check />
      </SelectItemIndicator>
      <SelectItemText>{children}</SelectItemText>
      {hint && <span className="text-xs font-normal text-muted">{hint}</span>}
    </UiSelectItem>
  );
}

export function SelectGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <UiSelectGroup>
      <SelectGroupLabel className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted">{label}</SelectGroupLabel>
      {children}
    </UiSelectGroup>
  );
}

export function SelectSeparator() {
  return <UiSelectSeparator className="mx-2 my-1 h-px bg-border" />;
}

function collectItems(children: React.ReactNode): ListData<string> {
  return Children.toArray(children).flatMap((child): ListData<string> => {
    if (!isValidElement<{ value?: string; children?: React.ReactNode; disabled?: boolean }>(child)) return [];
    if (child.type === SelectItem && child.props.value !== undefined) {
      return [{ value: child.props.value, label: textContent(child.props.children), disabled: child.props.disabled }];
    }
    return collectItems(child.props.children);
  });
}

function textContent(children: React.ReactNode): string {
  return Children.toArray(children).map((child): string => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    return isValidElement<{ children?: React.ReactNode }>(child) ? textContent(child.props.children) : "";
  }).join("");
}

function Chevron({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
