"use client";

import { t as translate } from "@/lib/i18n";
import { AlertDialog as A } from "radix-ui";

/**
 * Confirmation for destructive actions, as an iOS alert: title and message centred, two full-width answers
 * under a hairline. Cancelling is the bold, safe one; the destructive one is red (.ui-alert in globals.css).
 * Controlled: the caller opens it (from a menu item, a button…) and gets `onConfirm` when the user accepts.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending = false,
  error,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  error?: string | null;
  /** An option that changes what the action does (a checkbox under the message). */
  children?: React.ReactNode;
}) {
  return (
    <A.Root open={open} onOpenChange={onOpenChange}>
      <A.Portal>
        <A.Overlay className="ui-overlay fixed inset-0 z-50 bg-transparent" />
        <A.Content className="ui-pop ui-dialog ui-alert fixed left-1/2 top-1/2 z-50 w-[min(320px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[14px] text-center">
          <div className="px-5 pb-5 pt-6">
            <A.Title className="text-[17px] font-semibold leading-snug tracking-[-0.02em]">{title}</A.Title>
            <A.Description className="mt-1.5 text-[13px] leading-[1.45] text-foreground/80">{description}</A.Description>
            {children}
            {error && (
              <p role="alert" className="mt-3 rounded-[10px] bg-danger/15 px-3 py-2 text-[13px] text-danger">
                {error}
              </p>
            )}
          </div>
          <div className="ui-alert-actions">
            <A.Cancel asChild>
              <button type="button">{translate("Cancel")}</button>
            </A.Cancel>
            {/* Not A.Action: that would close the dialog before the action can report an error. */}
            <button type="button" data-destructive disabled={pending} onClick={onConfirm}>
              {pending ? translate("One moment…") : confirmLabel}
            </button>
          </div>
        </A.Content>
      </A.Portal>
    </A.Root>
  );
}
