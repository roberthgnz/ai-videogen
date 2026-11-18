---
name: media-inspection
description: Actually look at the project's videos, images and audio - duration, resolution, shot changes, sharpness, still stretches, volume, specific frames - with the studio's tools and, if they are not enough, with ffprobe and ffmpeg. Use it when you need to know what is in a file to decide a cut or answer a question.
---

# Inspecting the files

Use the response language specified in the studio instructions.

## First, what you already have (no permissions)

1. The `FOOTAGE LOG` and the contact sheets that arrive with the message: what is
   seen, moments, legible texts, shot changes.
2. `inspect_footage` (clip `C3` or moment `C3.M2`, `from`, `to`, `frames`): strip of frames from a
   stretch. It is the fastest way to answer «where does the action start?» or
   «which of the two takes is better?».
3. `review_edit`: the current edit, cut by cut.

Use ffmpeg only when that is not enough. The paths of the files and of `ffmpeg` / `ffprobe` are in
`AGENTS.md`. The user's files are **read-only**: do not modify, move or delete them. What you generate
goes in `agent/tmp/` (create it if it does not exist) and is deleted when you finish.

The recipes below do not ask the user for permission as they stand: ffprobe, ffmpeg that measures with
`-f null -` (and `metadata=print` without `file=`, or with `file=-`) and ffmpeg that only writes to
`agent/tmp/` with a relative path. If you change the output to another folder, the user will have to
approve it.

## Recipes

**Technical data** (duration, resolution, fps, whether it has audio):
```
ffprobe -v error -show_entries format=duration:stream=codec_type,width,height,r_frame_rate -of json "<file>"
```

**A specific instant** (then open the image to look at it):
```
ffmpeg -v error -ss 3.5 -i "<file>" -frames:v 1 -vf scale=360:-1 -y "agent/tmp/f-3.5s.jpg"
```

**A stretch at a glance** (8 frames in a strip):
```
ffmpeg -v error -ss 2 -t 4 -i "<file>" -vf "fps=2,scale=180:-1,tile=8x1" -frames:v 1 -y "agent/tmp/strip.jpg"
```

**The most representative frame** (to choose a cover or the best instant):
```
ffmpeg -v error -i "<file>" -vf "thumbnail=60,scale=360:-1" -frames:v 1 -y "agent/tmp/best.jpg"
```

**Shot changes** (the instants come out as `lavfi.scd.time=`). Threshold 10 works for edited footage;
lower it to 6-8 for handheld shots with soft changes:
```
ffmpeg -i "<file>" -vf "scdet=threshold=10,metadata=print:key=lavfi.scd.time" -f null - 2>&1
```

**Sharpness** (`lavfi.blur` value: the higher, the blurrier; compare clips against each other, there is no
universal threshold). Useful for discarding the shaky take:
```
ffmpeg -i "<file>" -vf "fps=2,blurdetect=block_width=32:block_height=32,metadata=print:key=lavfi.blur" -f null - 2>&1
```

**Still stretches** (frozen image or stopped camera, `freeze_start` / `freeze_end`):
```
ffmpeg -i "<file>" -vf "freezedetect=n=0.003:d=0.5" -f null - 2>&1
```

**Black frames** (`black_start` / `black_end`): `-vf "blackdetect=d=0.2:pix_th=0.1"` with `-f null -`.

**Audio:** silences with `-af silencedetect=n=-35dB:d=0.4`; integrated loudness (LUFS, `I:` value) with
`-af ebur128`. If the file has no audio, ffmpeg will not show that data.

If a filter does not exist in this machine's ffmpeg, say so and use another route (individual frames and look at them).

## How to use what you find

- Translate the file's seconds into the tool: `in` in `arrange_clips`, `part` or `seconds` in
  `build_edit`, or `inspect_footage` to confirm before cutting.
- Tell the user what you saw in one sentence and with data («take 2 is sharper and the action starts at second 1.8»), not the command output.
