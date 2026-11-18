import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Build host details are isolated here, like native platform support in Rust. */
export function buildPlatform() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("This release builds Windows x64 only.");
  return {
    target: "x86_64-pc-windows-msvc",
    nodeName: "videogen-node-x86_64-pc-windows-msvc.exe",
    nodeUrl: "https://nodejs.org/dist/v22.23.5/win-x64/node.exe",
    nodeSha256: "247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a",
    nodeChecksums: "https://nodejs.org/dist/v22.23.5/SHASUMS256.txt",
    browserUrl: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.30/win64/chrome-headless-shell-win64.zip",
    browserExecutable: path.join("chrome-headless-shell-win64", "chrome-headless-shell.exe"),
    ffmpegUrl: "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip",
    ffmpegSha256: "db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec",
    ffmpegDirectory: "ffmpeg-8.1.2-essentials_build",
    whisperUrl: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip",
    whisperSha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
    whisperExecutable: "whisper-cli.exe",
    executableSuffix: ".exe",
  };
}

export async function visualCppRuntime() {
  const vswhere = path.join(process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)", "Microsoft Visual Studio/Installer/vswhere.exe");
  const { stdout } = await promisify(execFile)(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { windowsHide: true });
  const redist = path.join(stdout.trim(), "VC/Redist/MSVC");
  const versions = (await fs.readdir(redist)).filter((name) => /^\d/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const arch = path.join(redist, version, "x64");
    const folders = await fs.readdir(arch).catch(() => []);
    const crt = folders.find((name) => /^Microsoft\.VC\d+\.CRT$/.test(name));
    if (crt) return path.join(arch, crt);
  }
  throw new Error("Visual C++ redistributable CRT files were not found. Install the MSVC build tools.");
}
