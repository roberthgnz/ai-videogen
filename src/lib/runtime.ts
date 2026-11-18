import { t as translate } from "@/lib/i18n";
import path from "node:path";

/** Desktop resources are supplied by the native launcher, never inferred from cwd. */
export function appResource(...segments: string[]): string {
  const root = process.env.VIDEOGEN_APP_DIR;
  if (process.env.VIDEOGEN_DESKTOP === "1" && (!root || !path.isAbsolute(root))) {
    throw new Error(translate("The absolute resource route of VideoGen is missing."));
  }
  return path.join(/*turbopackIgnore: true*/ root ?? process.cwd(), ...segments);
}

export function runtimeBinary(key: "FFMPEG_PATH" | "FFPROBE_PATH" | "VIDEOGEN_NODE_PATH", fallback: string): string {
  const value = process.env[key];
  if (process.env.VIDEOGEN_DESKTOP === "1" && (!value || !path.isAbsolute(value))) {
    throw new Error(translate("The packaging binary is missing: {0}.", key));
  }
  return value || fallback;
}

export function hyperframesCli(): string {
  const value = process.env.VIDEOGEN_HYPERFRAMES_CLI;
  if (process.env.VIDEOGEN_DESKTOP === "1" && (!value || !path.isAbsolute(value))) {
    throw new Error(translate("The CLI packaging of HyperFrames is missing."));
  }
  return value || appResource("node_modules", "hyperframes", "bin", "hyperframes.mjs");
}

/** The studio's HyperFrames as a command line: the Node that runs it and the CLI's entry file, both absolute. */
export function hyperframesCommand(): { node: string; cli: string } {
  return { node: runtimeBinary("VIDEOGEN_NODE_PATH", process.execPath), cli: path.resolve(/*turbopackIgnore: true*/ hyperframesCli()) };
}
