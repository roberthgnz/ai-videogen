"use client";

import { t as translate } from "@/lib/i18n";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isDesktop } from "@/lib/desktop";

const subscribe = () => () => {};
const serverSnapshot = () => false;
const previewSnapshot = () => typeof window !== "undefined" && (isDesktop() || (process.env.NODE_ENV === "development" && new URLSearchParams(window.location.search).has("desktop-preview")));
export function DesktopChrome() {
  const desktop = useSyncExternalStore(subscribe, previewSnapshot, serverSnapshot);
  const native = isDesktop();
  const maximize = useRef<HTMLButtonElement>(null);
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const cleanup: (() => void)[] = [];
    const apply = ({ transparent, accent }: { transparent: boolean; accent: string }) => {
      document.documentElement.dataset.backdrop = transparent ? "mica" : "solid";
      document.documentElement.style.setProperty("--accent", accent);
      document.documentElement.style.setProperty("--system-accent", accent);
      const channels = accent.match(/[0-9a-f]{2}/gi)?.map((value) => {
        const channel = parseInt(value, 16) / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      });
      if (channels?.length === 3) document.documentElement.style.setProperty("--system-on-accent", channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722 > .179 ? "#000000" : "#ffffff");
    };
    document.documentElement.dataset.desktop = "true";
    if (!native) { document.documentElement.dataset.backdrop = "solid"; return; }
    async function setup() {
      const [{ invoke }, { getCurrentWindow }, { listen }, { openUrl }] = await Promise.all([
        import("@tauri-apps/api/core"), import("@tauri-apps/api/window"), import("@tauri-apps/api/event"), import("@tauri-apps/plugin-opener"),
      ]);
      if (disposed) return;
      const windowHandle = getCurrentWindow();
      apply(await invoke("desktop_appearance"));
      const bounds = async () => {
        const rect = maximize.current?.getBoundingClientRect();
        if (rect) await invoke("chrome_bounds", { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
        setMaximized(await windowHandle.isMaximized());
      };
      await bounds();
      const resize = await windowHandle.onResized(() => { void bounds().catch(() => {}); });
      const appearance = await listen<{ transparent: boolean; accent: string }>("desktop-appearance", ({ payload }) => apply(payload));
      const external = (event: MouseEvent) => {
        if (event.defaultPrevented) return;
        const anchor = (event.target as Element)?.closest<HTMLAnchorElement>("a[href]");
        if (!anchor) return;
        const url = new URL(anchor.href, window.location.href);
        if (url.origin !== window.location.origin && ["https:", "http:", "mailto:"].includes(url.protocol)) {
          event.preventDefault();
          void openUrl(url.href).catch(() => setError(translate("The link couldn't be opened.")));
        }
      };
      document.addEventListener("click", external, true);
      document.addEventListener("auxclick", external, true);
      const remove = () => { resize(); appearance(); document.removeEventListener("click", external, true); document.removeEventListener("auxclick", external, true); };
      if (disposed) remove(); else cleanup.push(remove);
    }
    void setup().catch(() => setError(translate("It couldn't be connected to the window.")));
    return () => { disposed = true; cleanup.forEach((fn) => fn()); };
  }, [desktop, native]);
  if (!desktop) return null;
  const control = async (action: "minimize" | "toggleMaximize" | "close") => {
    try { const { getCurrentWindow } = await import("@tauri-apps/api/window"); await getCurrentWindow()[action](); }
    catch { setError(translate("You couldn't change the window.")); }
  };
  return (
    <>
      <div className="desktop-titlebar">
        <div className="desktop-title" data-tauri-drag-region>VideoGen</div>
        <button type="button" disabled={!native} className="desktop-settings" aria-label={translate("Settings")} onClick={async () => {
          try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("open_settings"); } catch { setError(translate("The adjustments could not be opened.")); }
        }}>⚙</button>
        <button type="button" disabled={!native} aria-label={translate("Minimize")} onClick={() => void control("minimize")}><svg viewBox="0 0 12 12" aria-hidden><path d="M1 6h10" /></svg></button>
        <button ref={maximize} disabled={!native} type="button" aria-label={maximized ? translate("Restore") : translate("Maximize")} onClick={() => void control("toggleMaximize")}><svg viewBox="0 0 12 12" aria-hidden>{maximized ? <path d="M3 3V1h8v8H9M1 3h8v8H1z" /> : <path d="M1.5 1.5h9v9h-9z" />}</svg></button>
        <button type="button" disabled={!native} className="desktop-close" aria-label={translate("Close")} onClick={() => void control("close")}><svg viewBox="0 0 12 12" aria-hidden><path d="m1 1 10 10M11 1 1 11" /></svg></button>
      </div>
      {error && <div className="desktop-error" role="alert">{error}<button type="button" onClick={() => setError("")}>{translate("Close")}</button></div>}
    </>
  );
}
