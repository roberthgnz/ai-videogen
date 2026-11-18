"use client";

import { t as translate } from "@/lib/i18n";
import { useRef } from "react";

/** Where the chosen width lives: a device preference, put back before the first paint by layout.tsx. */
const KEY = "videogen-side-width";
const PROPERTY = "--side-user-width";
/** The same limits as --side-width in studio.css, which holds them when the window changes size later. */
const MIN = 280;
const MAX = 720;
/** What the preview keeps, however wide the panel is asked to be. */
const STAGE_MIN = 360;
const STEP = 24;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Past a limit the panel still follows the pointer, less and less the further it goes: it says "there is
 * no more" without going dead under the hand. It never travels more than `dimension` beyond the limit.
 */
function rubberband(overshoot: number, dimension = 96, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * overshoot);
}

/** The panel and the room it can take, as they are on screen right now (in the middle of a settle too). */
function measure(handle: HTMLElement) {
  const root = handle.closest<HTMLElement>(".pro-studio");
  const side = root?.querySelector<HTMLElement>(".unified-agent, .pro-context-inspector");
  const stage = root?.querySelector<HTMLElement>(".pro-stage");
  if (!root || !side || !stage) return null;
  const width = side.getBoundingClientRect().width;
  // Never less than it is now: in a narrow window the layout's own width already leaves the preview under its minimum.
  return { root, width, max: Math.max(MIN, width, Math.min(MAX, width + stage.getBoundingClientRect().width - STAGE_MIN)) };
}

/** A splitter says where it is: read once when it appears, then after every change. */
function announce(handle: HTMLElement | null) {
  if (!handle) return;
  const measured = measure(handle);
  if (measured) handle.setAttribute("aria-valuenow", String(Math.round(measured.width)));
}

function write(width: number | null) {
  const style = document.documentElement.style;
  if (width === null) style.removeProperty(PROPERTY); else style.setProperty(PROPERTY, `${width}px`);
}

function remember(width: number | null) {
  try {
    if (width === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(width));
  } catch { /* storage blocked: the width still holds for this visit */ }
}

interface Drag {
  /** Where the pointer took hold, and how wide the panel was then: the panel keeps that offset under the hand. */
  x: number;
  start: number;
  min: number;
  max: number;
  /** The width the pointer asks for, before the limits. */
  raw: number;
  moved: boolean;
  /** What was set before the drag, to put back if it turns out to be a plain click. */
  before: string;
  frame: number;
}

/**
 * The left edge of the side panel (agent, inspector): drag it to make the panel wider or narrower.
 *
 * The width is a CSS variable on <html>, written at most once per frame while dragging, so the drag costs a
 * layout and no React render: the panel stays under the pointer. Past its limits it stretches with
 * resistance, and on release it settles on a spring (studio.css animates the grid only for that moment).
 * It can be taken again mid-settle: the next drag starts from where the panel is on screen, not from where
 * it was going. Arrow keys move it in steps, Home / End go to the limits, a double click or Enter gives the
 * width back to the layout.
 */
export function SideResizer() {
  const drag = useRef<Drag | null>(null);
  const settling = useRef(0);

  /** Applies a width change with the settle animation around it. */
  function land(handle: HTMLElement, root: HTMLElement, apply: () => void) {
    window.clearTimeout(settling.current);
    root.dataset.sideSettling = "";
    delete root.dataset.sideResizing;
    apply();
    settling.current = window.setTimeout(() => { delete root.dataset.sideSettling; announce(handle); }, 520);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const handle = e.currentTarget;
    const measured = measure(handle);
    if (!measured) return;
    // Keeps the text selection and the focus (the message box, usually) where they were.
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    window.clearTimeout(settling.current);
    const before = document.documentElement.style.getPropertyValue(PROPERTY);
    // From here the variable is the panel's width as measured: no jump if it was mid-settle or held back by a limit.
    write(measured.width);
    delete measured.root.dataset.sideSettling;
    measured.root.dataset.sideResizing = "";
    drag.current = { x: e.clientX, start: measured.width, min: Math.min(MIN, measured.width), max: Math.max(measured.max, measured.width), raw: measured.width, moved: false, before, frame: 0 };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    // The panel is on the right: pulling its edge to the left makes it wider.
    d.raw = d.start + d.x - e.clientX;
    if (e.clientX !== d.x) d.moved = true;
    if (d.frame) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      write(d.raw < d.min ? d.min - rubberband(d.min - d.raw) : d.raw > d.max ? d.max + rubberband(d.raw - d.max) : d.raw);
    });
  }

  // Fires for a release and for a cancelled drag alike.
  function onLostPointerCapture(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    const handle = e.currentTarget;
    const root = handle.closest<HTMLElement>(".pro-studio");
    if (!root) return;
    if (!d.moved) {
      // A click, not a drag: nothing is chosen, the layout keeps deciding.
      land(handle, root, () => { if (d.before) document.documentElement.style.setProperty(PROPERTY, d.before); else write(null); });
      return;
    }
    const width = Math.round(clamp(d.raw, d.min, d.max));
    land(handle, root, () => write(width));
    remember(width);
  }

  function reset(handle: HTMLElement) {
    const root = handle.closest<HTMLElement>(".pro-studio");
    if (!root) return;
    land(handle, root, () => write(null));
    remember(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const change = e.key === "ArrowLeft" ? STEP : e.key === "ArrowRight" ? -STEP : e.key === "End" ? Infinity : e.key === "Home" ? -Infinity : 0;
    if (!change && e.key !== "Enter") return;
    // The studio's own shortcuts (the arrows step through the video) do not get these.
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    if (!change) { reset(handle); return; }
    const measured = measure(handle);
    if (!measured) return;
    const width = Math.round(clamp(measured.width + change, MIN, measured.max));
    land(handle, measured.root, () => write(width));
    remember(width);
  }

  return <div ref={announce} role="separator" tabIndex={0} aria-orientation="vertical" aria-label={translate("Sidebar width")} aria-valuemin={MIN} aria-valuemax={MAX}
    title={translate("Drag to change width · Double click to re-establish width")} className="pro-side-resize"
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onLostPointerCapture={onLostPointerCapture}
    onDoubleClick={(e) => reset(e.currentTarget)} onKeyDown={onKeyDown}><span /></div>;
}
