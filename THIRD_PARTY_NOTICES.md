# Third-party licenses

The repository includes the materials below. `skills-lock.json` identifies the source of each skill in `.agents/skills/`.

| Material | Location and upstream license |
| --- | --- |
| Skills and blocks from [HyperFrames](https://github.com/heygen-com/hyperframes) | `.agents/skills/`, [Apache-2.0](licenses/hyperframes.txt) |
| Skills from [Emil Kowalski](https://github.com/emilkowalski/skills) | `.agents/skills/`, [MIT](licenses/emil-kowalski-skills.txt) |
| [UI SDK](https://github.com/vercel-labs/ui) skill | `.agents/skills/ui-sdk/`, [Apache-2.0](licenses/ui-sdk.txt) |
| Inter editor font | `public/fonts/`, [SIL OFL 1.1](public/fonts/OFL.txt) |

The HyperFrames blocks carry notices for GSAP, Three.js, and fonts alongside the corresponding files. Sound effects have their own [credits](.agents/skills/media-use/audio/assets/sfx/CREDITS.md). The npm and Rust dependencies are recorded in `package-lock.json`, `desktop/runtime/package-lock.json`, and `src-tauri/Cargo.lock`.

## Desktop installer

The downloads used to prepare the installer include Node.js, Chrome for Testing, Gyan's FFmpeg build, Whisper.cpp, and its multilingual model. See [`desktop/artifacts.lock.json`](desktop/artifacts.lock.json).

Preparation also copies the Visual C++ redistributables from the local Visual Studio installation. The installer includes the WebView2 bootstrapper. Preparing the installer saves the FFmpeg build's license at `src-tauri/resources/tools/FFMPEG-LICENSE.txt`.

For installer redistribution, consult the terms and notices for each of the included binaries, models, and runtimes.
