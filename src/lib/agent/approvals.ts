import { randomUUID } from "node:crypto";

/**
 * Permission questions from the installed program the agent runs on («¿Ejecutar ffmpeg …?», «¿Escribir
 * este archivo?»): they wait here until the user answers in the chat, the turn is stopped, or ten
 * minutes pass. Kept on globalThis so dev reloads don't orphan a waiting program.
 */

export interface ApprovalRequest {
  /** Short Spanish title: «Ejecutar un comando», «Escribir un archivo». */
  title: string;
  /** What exactly: the command, the file path, the URL. */
  detail: string;
}

export interface PendingApproval extends ApprovalRequest {
  id: string;
}

interface Waiting extends PendingApproval {
  resolve: (allowed: boolean) => void;
}

const WAIT_MS = 10 * 60_000;
const globalForApprovals = globalThis as unknown as { __videogenApprovals?: Map<string, Waiting[]>; __videogenTrusted?: Set<string> };
const pending = (globalForApprovals.__videogenApprovals ??= new Map<string, Waiting[]>());
/** Projects whose user chose «Permitir todo en este turno»: further questions are answered yes until it ends. */
const trusted = (globalForApprovals.__videogenTrusted ??= new Set<string>());

/** Asks the user; resolves false when they refuse, the turn is stopped or nobody answers in time. */
export function requestApproval(projectId: string, request: ApprovalRequest, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (trusted.has(projectId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const id = randomUUID();
    const finish = (allowed: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const list = (pending.get(projectId) ?? []).filter((w) => w.id !== id);
      if (list.length) pending.set(projectId, list); else pending.delete(projectId);
      resolve(allowed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), WAIT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(projectId, [...(pending.get(projectId) ?? []), { ...request, id, resolve: finish }]);
  });
}

/** What the chat shows as «Permitir / Rechazar» cards. */
export function pendingApprovals(projectId: string): PendingApproval[] {
  return (pending.get(projectId) ?? []).map(({ id, title, detail }) => ({ id, title, detail }));
}

/** The user's answer. `wholeTurn`: also say yes to everything else the agent asks until this turn ends. */
export function resolveApproval(projectId: string, id: string, allowed: boolean, wholeTurn = false): boolean {
  const list = pending.get(projectId) ?? [];
  const waiting = list.find((w) => w.id === id);
  if (!waiting) return false;
  if (allowed && wholeTurn) {
    trusted.add(projectId);
    for (const other of list) other.resolve(true);
  } else {
    waiting.resolve(allowed);
  }
  return true;
}

/** The turn ended: the next one asks again. */
export function endApprovals(projectId: string): void {
  trusted.delete(projectId);
  for (const waiting of pending.get(projectId) ?? []) waiting.resolve(false);
}
