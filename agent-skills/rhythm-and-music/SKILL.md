---
name: rhythm-and-music
description: Give a short video rhythm in VideoGen with music, cuts, speed and transitions - choose a track, sync cuts to the beats, energy curve. Use it when the user asks for more rhythm, «make it go with the music», a trailer style, something calmer, or when polishing an edit that has music.
---

# Rhythm and music

Use the response language specified in the studio instructions.

## Energy curve

Decide the shape before touching anything and state it in one sentence:

- **Trailer / hype:** strong start, cuts getting shorter (2.5 → 1.5 → 1 s), a brief pause before the
  climax, a close that breathes (3 s).
- **Calm / aesthetic:** shots of 2.5-4 s, `fade`, slow `alternate` movement, no speed-ups.
- **Tutorial / informative:** the explanation sets the rhythm; cuts when the step changes, not on a whim.

## Music

- **Visual edit:** the music is an audio clip imported into the timeline. If there is an imported audio
  not yet placed, place it with `edit_workspace` keeping all the other clips (starts at 0, lasts as long
  as the video, volume 0.25-0.35 if there is voice and 0.8-1 if there is not). If there is none, tell the
  user to import a track from the Audio panel; do not invent it.
- **Scene video (script):** `set_style` with `music`: `auto`, `none` or the exact name of a library track
  (the available ones appear in the state). If the library is empty, tell the user to add a song in
  Script › Voice and style › Background music, button
  Add song (next to it there is a link to free music). Do not talk about folders.
- With voice, the music goes underneath: `add_voiceover` already lowers the music; do not raise it afterwards.

## Cuts on the beat

For a specific note about volume or sync, load `edit-notes` and use `apply_edit_notes` on the affected
clips. Do not slide the music or change cuts unrelated to the request. The steps below are for
assembling or for an explicit request to sync the whole edit.

1. First order, cut and set speeds (skill `montage`).
2. Then `sync_music_to_beats`: without voice it adjusts the cuts to the beats; with voice it slides the
   music so its hits land on the cuts without moving the voice or the captions.
3. If you change the edit afterwards, sync again.
4. Check with `review_edit` that there are no shots under 0.8 s that cannot be understood.

## Speed and transitions

- `set_clip_effects` with `speed`: 1.5-2× on filler footage (walking, commutes, long processes);
  0.5-0.75× on a beautiful shot or the climax. Never on clips with voice or someone speaking.
- Transitions: `cut` is the fastest and cleanest (default at high rhythm); `zoom` and `slide` give
  energy in a trailer, better used deliberately than on every cut; `fade` for calm and endings.
  Do not mix more than two types in the same video.
- Movement: `alternate` brings still shots to life; `none` on shots that already move (drone, handheld).

## Silences and original voice

If someone speaks to camera, `analyze_media` with `silences` removes pauses on all tracks; with
`transcribe` it extracts captions of what they actually say. Do that before adjusting the rhythm.
