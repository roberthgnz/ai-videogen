import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { buildPlatform, visualCppRuntime } from "./platform.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const generated = path.join(root, ".desktop");
const resources = path.join(root, "src-tauri", "resources");
const binaries = path.join(root, "src-tauri", "binaries");
const require = createRequire(import.meta.url);
const Zip = require("adm-zip");
const platform = buildPlatform();
const lockPath = path.join(root, "desktop", "artifacts.lock.json");
const update = process.argv.includes("--update-lock");
let lock = await fs.readFile(lockPath, "utf8").then(JSON.parse).catch(() => ({}));
const secrets = ["ANTHROPIC_API_KEY", "FISH_AUDIO_API_KEY", "ELEVENLABS_API_KEY", "PIXABAY_API_KEY"];

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} exited ${code}`)));
  });
}
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function download(name, url) {
  const dest = path.join(generated, "downloads", name);
  let bytes = await fs.readFile(dest).catch(() => null);
  if (!bytes) {
    console.log(`Downloading ${name}…`);
    const response = await fetch(url, { signal: AbortSignal.timeout(20 * 60 * 1000) });
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, bytes);
  }
  const sha256 = digest(bytes);
  if (update && !lock[name]) lock[name] = { url, sha256 };
  if (lock[name]?.url !== url || lock[name]?.sha256 !== sha256) throw new Error(`Artifact checksum missing or mismatched: ${name}. Review upstream before --update-lock.`);
  if (update) await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
  return bytes;
}
async function unzip(bytes, target) {
  const zip = new Zip(bytes);
  for (const entry of zip.getEntries()) {
    const dest = path.resolve(target, entry.entryName);
    if (!dest.startsWith(path.resolve(target) + path.sep)) throw new Error("Unsafe archive entry");
    if (entry.isDirectory) await fs.mkdir(dest, { recursive: true });
    else { await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, entry.getData()); }
  }
}
async function copy(source, target) { await fs.cp(source, target, { recursive: true, dereference: true, force: true }); }

await fs.mkdir(binaries, { recursive: true });
await fs.mkdir(resources, { recursive: true });
const nodeBytes = await download("node-22.23.5.exe", platform.nodeUrl);
// Pinned from the official SHASUMS256.txt; cached builds need no network lookup.
if (digest(nodeBytes) !== platform.nodeSha256) throw new Error("Official Node checksum mismatch");
const node = path.join(binaries, platform.nodeName);
await fs.writeFile(node, nodeBytes);

const runtime = path.join(resources, "runtime");
await fs.mkdir(runtime, { recursive: true });
for (const name of ["package.json", "package-lock.json"]) await copy(path.join(root, "desktop", "runtime", name), path.join(runtime, name));
const dependencyLock = digest(await fs.readFile(path.join(runtime, "package-lock.json")));
const installed = await fs.readFile(path.join(runtime, ".installed"), "utf8").catch(() => "");
if (installed !== dependencyLock) {
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  await run(node, [npmCli, "ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: runtime });
  await fs.writeFile(path.join(runtime, ".installed"), dependencyLock);
}
const browserZip = await download("chrome-headless-shell-152.0.7977.30.zip", platform.browserUrl);
if (!(await fs.stat(path.join(resources, "browser", platform.browserExecutable)).catch(() => null))) {
  await unzip(browserZip, path.join(resources, "browser"));
}
const ffmpegZip = await download("ffmpeg-8.1.2.zip", platform.ffmpegUrl);
if (digest(ffmpegZip) !== platform.ffmpegSha256) throw new Error("Official FFmpeg checksum mismatch");
if (!(await fs.stat(path.join(resources, "tools", `ffmpeg${platform.executableSuffix}`)).catch(() => null))) {
  const tools = path.join(generated, "ffmpeg");
  await unzip(ffmpegZip, tools);
  await fs.mkdir(path.join(resources, "tools"), { recursive: true });
  for (const name of ["ffmpeg", "ffprobe"]) await copy(path.join(tools, platform.ffmpegDirectory, "bin", `${name}${platform.executableSuffix}`), path.join(resources, "tools", `${name}${platform.executableSuffix}`));
  await copy(path.join(tools, platform.ffmpegDirectory, "LICENSE"), path.join(resources, "tools", "FFMPEG-LICENSE.txt"));
}
const whisperDir = path.join(resources, "whisper");
const whisperZip = await download("whisper-1.9.5.zip", platform.whisperUrl);
if (digest(whisperZip) !== platform.whisperSha256) throw new Error("Official Whisper checksum mismatch");
if (!(await fs.stat(path.join(whisperDir, platform.whisperExecutable)).catch(() => null))) {
  const archive = new Zip(whisperZip);
  const binary = archive.getEntries().find((entry) => path.posix.basename(entry.entryName) === platform.whisperExecutable);
  if (!binary) throw new Error("Whisper executable missing from archive");
  const folder = path.posix.dirname(binary.entryName);
  await fs.mkdir(whisperDir, { recursive: true });
  for (const entry of archive.getEntries()) {
    const name = path.posix.basename(entry.entryName);
    if (!entry.isDirectory && path.posix.dirname(entry.entryName) === folder && (name === platform.whisperExecutable || name.endsWith(".dll"))) await fs.writeFile(path.join(whisperDir, name), entry.getData());
  }
}
for (const name of await fs.readdir(whisperDir)) {
  if (name.endsWith(platform.executableSuffix) && name !== platform.whisperExecutable) await fs.unlink(path.join(whisperDir, name));
}
const modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin";
const model = await download("ggml-small.bin", modelUrl);
if (digest(model) !== "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b") throw new Error("Whisper model checksum mismatch");
await fs.mkdir(path.join(resources, "model"), { recursive: true });
await fs.writeFile(path.join(resources, "model", "ggml-small.bin"), model);
await copy(path.join(path.dirname(process.execPath), "LICENSE"), path.join(resources, "NODE-LICENSE.txt"));
const crt = await visualCppRuntime();
for (const name of await fs.readdir(crt)) {
  if (!name.endsWith(".dll")) continue;
  await copy(path.join(crt, name), path.join(whisperDir, name));
  await copy(path.join(crt, name), path.join(runtime, "node_modules/better-sqlite3/build/Release", name));
}
if (update) await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");

console.log("Building standalone Next.js…");
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", STORAGE_DIR: path.join(generated, "build-storage") };
for (const key of secrets) env[key] = "";
delete env.VIDEOGEN_DESKTOP;
await run(node, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "build"], { env });
const app = path.join(resources, "app");
// Remove only the generated app tree, after checking its resolved absolute target.
if (path.resolve(app) !== path.join(root, "src-tauri", "resources", "app")) throw new Error("Unsafe staging path");
await fs.rm(app, { recursive: true, force: true });
await copy(path.join(root, ".next", "standalone"), app);
for (const name of await fs.readdir(app)) if (name.startsWith(".env")) await fs.rm(path.join(app, name), { force: true });
await copy(path.join(root, "public"), path.join(app, "public"));
await copy(path.join(root, ".next", "static"), path.join(app, ".next", "static"));
await copy(path.join(root, "drizzle"), path.join(app, "drizzle"));
await copy(path.join(root, "src", "templates"), path.join(app, "src", "templates"));
await copy(path.join(root, "node_modules", "gsap", "dist", "gsap.min.js"), path.join(app, "node_modules", "gsap", "dist", "gsap.min.js"));
// Use the separately installed SQLite addon built for the bundled Node version.
await copy(path.join(runtime, "node_modules", "better-sqlite3"), path.join(app, "node_modules", "better-sqlite3"));
for (const name of ["boot.cjs", "import.cjs", "migrate.cjs"]) await copy(path.join(root, "desktop", name), path.join(resources, name));
await fs.writeFile(path.join(resources, "manifest.json"), JSON.stringify({ node: "22.23.5", hyperframes: "0.9.33", ffmpeg: "8.1.2", chrome: "152.0.7977.30", sqlite: "13.0.3", whisper: "1.9.5", target: platform.target, dependencyLock }, null, 2));
console.log("Desktop resources ready.");
