---
name: montage
description: Editing craft for short videos in VideoGen - choosing the story, ordering, cutting, pacing, polishing and reviewing with the studio's tools. Always use it when the user asks to assemble, reorder, shorten, lengthen, pace, change shots, add transitions or review the montage.
---

# Montage

Use the response language specified in the studio instructions.

The montage lives in the studio: change it only with its tools (`videogen` server), never by editing
files. This skill adds craft to the process you already know (material log → story → assemble →
review → polish → explain the reasoning). The material log is the state block `FOOTAGE LOG`.

The explicit prompt rules; then the reference. The rhythms and structures below are guidelines, not a
template. Study and save the reference's adaptation before assembling. Use only the resources that
apply: voice, subtitles, titles, music and effects are independent and all optional. Do not confuse
speeding up a take with reproducing the example's cutting dynamism.

## 1. Before cutting: decide the story

Read the `FOOTAGE LOG` (clips C1, C2… and their moments C3.M2, with what is seen and its
quality) and choose a structure. Write it for yourself in one line before calling anything.

| Material | Structure | Order |
| --- | --- | --- |
| A single recording (tutorial, recipe, process, trip) | Hook → context → steps → result → closing | Recording order |
| Before and after, transformation | Result as hook (1-2 s) → before → fast process → after | Recording order, with the result brought forward |
| List ("3 tricks", "5 places") | Hook with the promise → one block per point → closing | One point per block, no mixing |
| Loose clips (stock, b-roll) | A thematic or emotional thread | By contrast: far→close, tension→calm, cold→warm |
| No material, or drawn reference (infographic, cutouts, motion graphics) | The script's; the image is drawn (skill `custom-graphics`) | The narrative's: one graphic per idea |
| Person talking to camera | What they say rules; b-roll illustrates | The speech's; clean it up from the transcript (skill `transcript-editing`) |

If the material has an order (numbering like "3/6", a progress, a sequence), respect it even if the
file name says otherwise. Leave out what is shaky, blurry, repeated or tells nothing, and say so.

Stock is not the default image. A data point, a date, a comparison, a map or a process is drawn with
`create_graphic`; and if the reference or My style (`MY STYLE`) is graphic, the whole image is drawn
in that style. Stock is left for truly filmed scenes when the user does not have that material.

## 2. Hook

- What is seen in the first 1.5 s decides whether they stay. Open with the most striking shot or with
  the final result, already in motion. No slow starts, black or fade-in.
- The first shot is short (1-2 s) and the hook text lasts 2-3 s.

## 3. Duration of each shot

| Shot | Duration |
| --- | --- |
| Detail, insert, reaction | 0.8-1.5 s |
| Action that is understood on its own | 1.5-3 s |
| Landscape, wide shot, "breather" | 2-3 s |
| With text to read or voice | As long as it takes to read: ~0.3 s per word + 1 s |
| Closing (with call to action) | 2.5-4 s |

- Vary the durations: all equal sounds like a machine. Speed up toward the climax and let the closing breathe.
- Hit the requested duration exactly (15, 30, 60 s…). If the material falls short, say so; do not
  stretch boring shots.

## 4. Where to cut

- On a change of shot, at the end of a gesture or at the peak of an action (cut on movement).
- Chain by continuity when you can: same direction of movement, similar shapes or colors.
- Do not cut mid camera movement or repeat material. Going back within a clip or back and forth
  between two clips only if it is on purpose.

## 5. Tools, in order

1. **Assemble:** `build_edit` with parts (beats) and moments from the log. Per moment you can set
   `seconds`, `part` (`best` by default, `start`, `end`, `whole`) and `speed`. To reorder or shorten
   what is already there, `arrange_clips` (assetId, in, duration). Do not compute times by hand with `edit_workspace`.
2. **Review:** read the WARNINGS and the strip that `build_edit` returns like an editor. Does
   it make sense in order? Does it hook? Are there odd jumps or surplus shots? Fix (two rounds at
   most). If in doubt about a span, `inspect_footage`. After changes with other tools, `review_edit`.
3. **Polish**, always after assembling (assembling resets the effects):
   - `set_clip_effects`: `cut` for dry rhythm; `zoom` or `slide` for trailer or energy; `fade` for
     calm or emotion. `alternate` movement to give life to static shots; `none` if they already move a lot.
   - Speed: 1.5-2× for transitional material and 0.5-0.75× for a beautiful shot; never on clips with voice.
   - Texts: skill `on-screen-text`. Music: skill `rhythm-and-music`, at the end.
4. **Before answering:** skill `final-review` if the user is going to export or asked for the full video.

## 6. Small changes

For notes on an existing montage, load `edit-notes`. Use `apply_edit_notes` by ID and field, without
rewriting lists, and go through all the batches of `review_edit_notes`. Keep the rest (order, trims,
transitions, movements and texts). Use the full-montage tools only when the user asks to redo its
structure. Say what you changed and the scope you reviewed.

## 7. How to tell it

In 1-3 sentences: the chosen story, the criterion for order and cuts, and what you left out and why.
Talk about what the user sees in the studio, not folders or tools: if music is missing, "if you upload
a song in Audio (the panel has a link to free music), I will adjust the cuts to its rhythm". If the project was named after a file, give it
a name with `rename_project` in this first turn.
End with `propose_actions`: 1-3 concrete next steps with their full input (another rhythm, another
hook, adding voice-over, exporting), never repeating what you just did.
