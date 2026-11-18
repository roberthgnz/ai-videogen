---
name: hyperframes-compositions
description: Make a full HyperFrames clip inside VideoGen and bring it into the montage with render_composition - blocks and components from its catalog (animated titles, transitions, charts, maps, chat or interface cards, backgrounds, 3D), multiple scenes, Lottie, three.js, canvas or shaders. Use it when a create_graphic graphic falls short, when the user asks for a header, an intro, an animated title, a transition or a named effect, or "something more spectacular", and ALWAYS before using a HyperFrames skill (hyperframes, hyperframes-cli, hyperframes-registry, media-use, reverse-any-video, style-sampling or a block) in this studio.
---

# HyperFrames compositions

Use the response language specified in the studio instructions.

HyperFrames is the engine that renders the studio's graphics: it turns HTML into video frame by
frame. You have its official skills (in English) and its command line. With them you write a
**composition** (a HyperFrames project, with its files) in your folder, and `render_composition`
renders it and drops it into the montage as one more clip. This skill explains how to use those skills
**inside the studio**; where they disagree, this one wins.

## 1. Graphic or composition

| What needs doing | With what |
| --- | --- |
| An infographic, a map, a calendar, a figure, a list, a collage: a drawing that fits in one html, one css and one animation | `create_graphic` (skill `custom-graphics`). Faster and needs no permissions |
| An animated title, a transition or a "named" effect (glitch, film grain, particles, glass, neon) | Composition, starting from a catalog block |
| An animated chart, a bar race, a map with a route, a chat or interface card, a code diff | Composition, starting from a catalog block |
| 3D, shaders, Lottie, three.js, complex canvas, several chained scenes with their transitions | Composition |
| A multi-second brand header, intro or outro | Composition |
| A short caption over a video that stays visible | `place_text` (skill `on-screen-text`) |

Start with the simplest thing that gives the result. Before hand-writing a named effect, look for it
in the catalog (section 4): starting from a ready-made block is faster and usually looks better.

## 2. Where the work happens

- One folder per composition: `agent/compositions/<name>/` (`header`, `sales-chart`). Do not
  reuse it for another one: it is the source of that clip and you will need it to fix it.
- The video only changes through `render_composition`. Do not copy files into `media/` or touch
  anything outside `agent/`.
- User material inside the composition (a photo, a logo, a video): copy it from `media/…` to the
  composition's `assets/`. References guide the style, but they are not material: do not put them in.

## 3. The studio's command line

`AGENTS.md` / `CLAUDE.md` gives, under "Local tools", the studio's HyperFrames
command (its Node and its CLI, in quotes). **Wherever a HyperFrames skill says `npx hyperframes <command>`, run
the studio's command** with the same arguments after it; in PowerShell, with `&` in front. Do not use `npx`: it would download
another version from the internet.

Pass the folder as an argument instead of changing directory:

```
<studio command> init agent/compositions/header --skip-skills --non-interactive --resolution portrait
<studio command> check agent/compositions/header --json
<studio command> snapshot agent/compositions/header --at 0.4,1.5,3.6
```

- **Without asking the user**, run the commands that only look, written like this (the studio's command
  as is and the relative folder): `lint`, `check`, `snapshot`, `catalog`, `info`, `compositions`,
  `docs`. Type the studio's command out in full every time: putting its path in a variable
  (`$h = …`), assigning the output (`$j = …`) or chaining a command that writes makes the whole line a
  question to the user. Trimming the output with `| Select-Object -First 40` or `| Select-String` is fine.
- `info` describes a composition folder, not a catalog item: what a block is, its size, length and
  variables come in the `catalog --json` results and in the files `add` installs.
- **They ask for permission in the chat**: `init`, `add` (needs internet), `capture <url>` (internet),
  writing files and any other command. Ask for just what you need: group what you can and, if they
  refuse, make the graphic with `create_graphic`.
- `--resolution`: `portrait` (1080×1920) if the project is vertical, `landscape` (1920×1080) if it is
  horizontal. Check it in the state.
- `init` leaves HyperFrames' own generic `AGENTS.md`, `CLAUDE.md` and `package.json` in the folder. They
  describe HyperFrames outside the studio and do not apply here: no `npm run …`, no `npx`, no preview.
- Every file write is a question to the user. Write each file whole in one go and, after a check or a
  snapshot, fix everything you saw in a single edit rather than one edit per detail.

## 4. What to read from HyperFrames

| For | Skill and file |
| --- | --- |
| The render contract and the shape of a project | `hyperframes` (SKILL.md) and `references/format.md` |
| Motion: curves, titles, cuts, holding | `hyperframes/references/motion.md` |
| Vertical: areas the app covers, pacing | `hyperframes/references/types/vertical.md` |
| Charts and figures | `hyperframes/references/types/data.md` |
| Lottie, three.js, canvas, 3D | `hyperframes/references/runtimes.md`, `types/3d.md` |
| Find and install a block or component | `hyperframes-registry`: `catalog --query "<in English>" --json`, then `add <name> --dir <folder> --json` |
| `lint`, `check`, `snapshot` and their failures | `hyperframes-cli` and `references/lint-validate-inspect.md` |
| Redo the graphics of a reference video | `reverse-any-video` (the image part only) |
| An already proven series style (collage, finance, science) | `style-sampling` |
| Treat a photo or a video inside the composition (cropping, grain, grading) | `media-use`, only its local, free tools |

The skills named after a block (`canopy-part-title`, `glass-shard-title`, `orbit-card`…) come with
that block already downloaded (its `.html` and its `assets/`) and the list of its variables: copy it
into `compositions/<name>/` of your composition instead of installing it with `add` (no internet
needed) and assemble it as its SKILL.md says.

## 5. What changes inside the studio

HyperFrames skills are written to make a whole video and deliver it. Here you make **one clip of the
montage**. So:

1. **Size and duration.** The root measures what the project format says (`data-width`,
   `data-height`) and lasts as long as the span it will occupy (`data-duration`): that of the clip it
   replaces or of the scene. 30 fps. Maximum 120 s per composition.
2. **No sound.** The clip comes in silent. Voice, music and effects are added with the studio's tools
   (`add_voiceover`, `sync_music_to_beats`…), not with `<audio>`, `tts` or `media-use` music.
3. **No voice subtitles** inside the composition: the studio adds them. You may add the graphic's own
   texts (headlines, labels, figures).
4. **Do not render or preview yourself.** No `render`, `preview`, `present`, `open`, `catch-up`,
   `share`, `publish`, `cloud`, `lambda` or `cloudrun`: `render_composition` renders, and the user
   sees the result in VideoGen. Do not talk about "Studio", "Framey" or the HyperFrames app.
5. **No usage notices or accounts.** Do not run `events --skill=…` (telemetry is disabled in your
   terminal), `usage`, `feedback`, `auth`, `upgrade`, `skills` or `history`. Nothing that asks for a
   HeyGen account or spends money (avatars, voices or generated video from `media-use`): if it were
   needed, tell the user and let them decide.
6. **No movie ceremony.** For a clip, do not write `SPEC.md` or `REVIEW.md` and do not propose three
   stories: the script, the style and the passes are already handled by the studio. Their review
   standard does apply: look at the frames before calling it good.
7. **The style is the video's.** My style (`MY STYLE`) and the reference take precedence over a
   block's factory look: change its color and font variables, and its text, to the project's. An
   unadapted block stands out like a patch.
8. **Vertical safe zone:** what is read goes between y 250 and 1440 px and between x 60 and 960 px; the
   background and decorations do reach the edges. If the montage has subtitles, leave their strip free.
9. **Many blocks are made at 1920×1080.** In a vertical project they do not fit as is: they are
   recomposed (scale, position, font size, one thing below another) and checked with `snapshot`.
10. **Not applicable here:** `figma` (the studio has no connection to Figma), `slideshow` (those are
    presentations, not clips) and `remotion-to-hyperframes` (it migrates code from another program).
11. Do not invent data, figures, dates or maps that the user or their documents do not give.

## 6. The cycle

1. `init` the folder (or copy a block you already have as a skill).
2. If a block exists for what you are after: `catalog --query` and `add`. Assemble it as
   `hyperframes-registry` says (`data-composition-src`, its `data-composition-id`, `data-start`,
   `data-duration`) and adapt variables, texts, colors and fonts.
3. Write or adjust the composition following the `hyperframes` contract.
4. `lint` and then `check --json`: fix all errors and weigh the warnings.
5. `snapshot --at <moments>` and **look at the PNGs** (in `.hyperframes/artifacts/snapshots/` of the
   folder): that is how you see the video before rendering it. Tiny or unstyled content means a badly
   assembled block.
6. `render_composition` with `dir`, `name`, `description` and where it goes (section 7). It returns
   frames of the already rendered clip: compare them with the reference and with the surrounding shots.
7. If something does not fit, edit the files and call again with `replaces` (two rounds at most).

If the render fails, the error carries the cause and almost always a `Fix:` line: apply it to the files.

## 7. Placing it in the video

Same as a custom graphic (skill `custom-graphics`, section 3):

- **Replace a shot:** `replaceClipId`. The composition must last at least as long as that clip.
- **Put it at a given moment:** `start` (and `track` if it goes on top). Whatever it covers on that
  track is trimmed.
- **Video from a script:** `build_timeline` with `stock: false` gives you the span of each scene.
- With neither, it stays in Files, unplaced.
- A multi-second header or title usually calls for the voice to start later or for that span to have
  no voice: check it in the state before placing it.

## 8. How to tell it

In the user's words, without naming HyperFrames, blocks or commands: «I made a 3-second animated header
with the title in your colors and put it at the start». Say what you adapted to their style and what
you could not match. Give them an example of how to ask you for changes: «Make the header shorter», «Change the title to…», «Make the chart bars rise more slowly».
