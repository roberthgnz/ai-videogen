"use client";

import { Field as UiField, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input as UiInput } from "@ui-sdk/react/input";
import { Label as UiLabel } from "@ui-sdk/react/label";
import { Textarea as UiTextarea } from "@ui-sdk/react/textarea";
import { cn } from "./cn";

export function Label({ className, ...props }: Omit<React.ComponentProps<typeof UiLabel>, "className"> & { className?: string }) {
  return <UiLabel className={cn("text-xs text-muted", className)} {...props} />;
}

/** Label above a control, with an optional note on the right (a counter, a unit). */
export function Field({
  label,
  htmlFor,
  aside,
  hint,
  children,
  className,
}: {
  label: React.ReactNode;
  htmlFor: string;
  aside?: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <UiField className={cn("block space-y-1", className)}>
      <div className="flex justify-between gap-2 text-xs text-muted">
        <FieldLabel htmlFor={htmlFor} className="text-xs font-normal text-muted">{label}</FieldLabel>
        {aside && <span>{aside}</span>}
      </div>
      {children}
      {hint && <FieldDescription className="text-xs text-muted">{hint}</FieldDescription>}
    </UiField>
  );
}

export function Input({ className, ...props }: Omit<React.ComponentProps<typeof UiInput>, "className"> & { className?: string }) {
  return <UiInput className={cn("ui-field h-9 w-full rounded-[10px] px-3 text-sm", className)} {...props} />;
}

export function Textarea({ className, ...props }: Omit<React.ComponentProps<typeof UiTextarea>, "className"> & { className?: string }) {
  return <UiTextarea className={cn("ui-field h-auto min-h-0 w-full rounded-[10px] px-3 py-2 text-sm leading-6", className)} {...props} />;
}
