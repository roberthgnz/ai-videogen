---
name: final-review
description: Editor's pass before declaring a video finished or exporting it in VideoGen - hook, rhythm, texts, audio, duration and close - and how to export. Use it when the user asks for the final video, to export, «get it ready» or «review everything».
---

# Final review

Use the response language specified in the studio instructions.

If you are resolving a note on an existing edit, apply `edit-notes`: patches go with
`apply_edit_notes` and the review of all affected moments with `review_edit_notes`. This general
checklist does not authorize changing the hook, close, rhythm or music if they are not part of the note.

Do the pass with `review_edit` (strip of cuts) and, if needed, `inspect_footage` at the doubtful moments.
Fix whatever fails before replying; do not hand over a list of unfixed problems.

## Checklist

1. **Duration:** the requested one, to the second.
2. **Hook:** in the first 1.5 s something eye-catching happens and the hook text is already on screen.
3. **Story:** the strip makes sense in order, no odd jumps, no repeated footage, no blurry or shaky
   shots if there were better ones.
4. **Rhythm:** varied durations, no shot under 0.8 s that cannot be understood, a close that breathes
   (2.5-4 s).
5. **Texts:** no pending WARNINGS from `place_text`, none covers faces or the subject, all in the
   safe zone and with time to be read. Spelling and accents checked.
6. **Effects:** at most two types of transition; no movement on shots that already move.
7. **Audio:** if there is voice, it is heard above the music; if there is music, the ending does not cut
   off abruptly; no long silences in clips with speech (`analyze_media` → `silences`).
8. **Close:** call to action visible for at least 2.5 s and a clean last shot.

## Exporting

- `generate_video` exports what is in the studio: the visual edit if it is active or, if not, the
  scene video. `quality`: `draft` (fast, for reviewing), `looks` (normal) or `delivery` (final delivery).
- It spends render minutes (and voice credit if scene voices are missing): launch it only if the user asks
  to export or generate and their permissions allow it. If their permissions require confirmation, the
  studio leaves an Approve button and it is enough to tell them.
- The user can also export with the **Export** button at the top.

## Reply

In 1-3 sentences: what you reviewed and fixed, and that it is ready to export (or what is missing and why).
