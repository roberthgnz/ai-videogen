---
name: edit-notes
description: Apply notes to an existing edit, such as moving a label, clearing the face, simplifying, bringing an entrance forward, giving captions more time or lowering effects, keeping the rest and reviewing every affected moment. It does not rebuild the edit.
---

# Edit notes

Use the response language specified in the studio instructions.

A note corrects a specific decision. Before touching anything, identify its scope, the IDs and the necessary
fields in the current state. A local indication («that graphic», «from 0:04 to 0:07») has that scope;
a general rule («keep my face clear», «every caption at least 0.4 s») requires reviewing all the
relevant occurrences. Do not turn a local correction into a redesign of the video.

## Apply without rebuilding

Use `apply_edit_notes` with `expectedRevision` from the current state. Each operation carries an `id` and only the
fields that change in `set`. Omitted fields, other elements, tracks and order are kept. The
tool also allows adding or removing specific layers. Do not replace lists with `edit_workspace`
or use `build_edit`, `build_timeline` or `set_style` to resolve a note. Do not resync the
music either after moving a text or lowering an effect.

If there is an explicit interval, send `range: {from, to}`. The tool rejects the elements that
exceed it instead of altering content outside the span. Do not widen that interval to avoid the rejection.
If an element that crosses the boundary needs to be split, keep the outside material exactly
and explain the limitation before an operation the tool does not allow.

Apply related changes in a single call. If the revision changes, read `review_edit` and recalculate
against the current state: do not resend old data. Do not repeat factors or offsets
already saved when continuing a session.

## Interpreting the notes

| Note | Change and review |
| --- | --- |
| «Move it up, keep my face clear» | Change the position/size of the indicated label; if it is a general rule, look for other occurrences with the same problem. Check each shot, entrance, exit and maximum zoom. A box does not fix covering the face. |
| «One idea at a time» | Stagger or remove what is redundant. Two layers can form a single idea; do not delete titles or words just for counting them. Keep information and timings unrelated to the note. |
| «Move it 3 frames earlier» | `shiftFrames: -3` on the requested ID, without changing duration. The edit uses 30 fps. If it crosses the start, do not trim it or silently clamp it to zero. |
| «Every caption, at least 0.4 s» | Check all the captions in scope. Use gaps or group contiguous phrases keeping all their words and the original speech. Update one layer and delete the grouped ones; avoid overlaps, long gaps and speaker changes. Do not move voice or video. If the minimum is incompatible with the span, say so. |
| «Follow my style guide» | Read the available guide and references. Fix the relevant fields of all affected layers; keep text, position and timings unless the guide and the note ask to change them. There are only sans/serif/mono families: do not promise a custom font. |
| «Effects at half» | Identify the effect assets by name/context, not all the audio. Use `volumeFactor: 0.5` on each affected clip. Keep voice, music and sync. Half of the volume control is not the same as half of the perceived loudness. |
| «First word bigger and a hit at the start» | Keep the hook; separate only the first word into another layer, without repeating it in the original. Use a real available effect asset in a separate clip with `start: 0`. Do not invent assets or modify the rest of the edit. |

A text or sound embedded in a video is not an editable layer. If the independent asset is not available,
explain which part of the note cannot be resolved with the current tools.

## Review the final result

`apply_edit_notes` returns the exact changes and the necessary batches. Use `review_edit_notes` with the
new revision and look at **all** the pending batches. Each sheet gathers the visible layers and the simultaneous texts at
entrances/exits, shot and layer changes, and intermediate samples every second. Zoom
and transitions are rendered at the chosen instant. Also check the time,
duration and volume values; a strip of the original video is not enough.

If the note keeps failing, apply another patch limited to the justified elements. Coverage
resets to review the final version. A generic warning does not authorize fixing other elements or
redoing the video. Do not consider the note finished if batches remain pending.

The review uses system fonts and approximate boxes; it does not exactly reproduce the export
typography. The sampling does not certify continuous face tracking, every frame or the sound.
Do not claim to have listened to the audio when reviewing its values. If images are missing, retry that batch or
explain the limitation. Progress is saved so you can continue without repeating the changes.

End with `propose_actions`: what changed, the scope reviewed and the real limitations. Do not propose
re-running the same note as the next step.
