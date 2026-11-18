---
name: passes
description: Pass-based editing with saved versions in VideoGen - only the passes each video needs (cut, captions, graphics, sound, all optional, in that order), planned from the request and the material, asking when it is unclear, with the user's approval in Guided mode or a single review at the end in Fast mode - and how to save, go back to a version and resume a project. Use it when the user asks to edit or assemble a whole video, says the video is already cut or already has captions or music, approves or asks for changes to a pass, wants to save or recover a version, or says «keep going», «resume» or «where were we?».
---

# Pass-based editing

Use the response language specified in the studio instructions.

A complete editing request («edit this reel for me», «put together a video with this») is not done in one go:
it is done **one pass at a time**, like an editor receiving notes. Each pass leaves a saved version and
the user reviews it before you continue. The state (mode, passes and versions) arrives in the `PASSES`
block of the current state; `get_pass` expands it.

## The passes: all optional, always in this order

| Pass | `pass` | What it decides | Accompanying skill |
| --- | --- | --- | --- |
| 1. Cut | `cut` | which shots go in, in what order and how long each lasts (including the custom graphics that serve as imagery); silences and false takes out | `montage`, `media-inspection`, `custom-graphics` |
| 2. Captions | `captions` | the captions for what is said: corrected text, timing and style | `on-screen-text` |
| 3. Graphics | `graphics` | titles, labels, written hook, call to action, transitions and camera movements | `on-screen-text`, `montage` |
| 4. Sound | `sound` | music, voice-over, volume and making sure the cuts land on the beat | `rhythm-and-music` |

Each pass builds on the previous ones: do not add captions during the cut or change the cut during
the graphics. A video only goes through the passes it needs: the studio shows only those.

## Plan first: which passes this video needs

Before the first pass of a complete editing request, call `plan_passes`: every pass goes in `include`
or in `skip` (with a reason the user can read). Decide from two things:

- **What the user asks for.** «Just put captions on it» → captions only. «Add music» → sound only.
  «Edit it for me» with nothing else → the passes that make sense for that material.
- **What the material already has.** Look before deciding (`inspect_footage`, the footage log, the
  assets): one finished take with no dead time is already cut; words written on the frames along the
  speech are burnt-in captions; a video with its own music or a clean voice may not need a sound pass.

Typical plans: an already edited video → no cut; a video with burnt-in captions → no captions; a talking
head the user wants «clean» → cut and captions, no graphics; raw clips for a reel → all four.

**When it is unclear, ask before planning.** If you cannot tell whether it is already cut, already
captioned or already has its sound, and the answer changes the work, ask in one short sentence and end the
turn («¿El vídeo ya viene cortado o quieres que quite pausas y tomas falsas?»). You can offer the likely
answers as `propose_actions` buttons that call `plan_passes` with each plan: the studio then shows the
steps and a button to start. Do not ask about things the request or the material already answer.

**Change the plan when the user does.** «It is already cut», «add captions too», «no music»: call
`plan_passes` again. A pass left out keeps the edit and its versions; one brought back starts as pending.
`start_pass` on a pass left out brings it back into the plan. The user can also add or drop steps in
the studio (menu «•••» next to the steps); the `PASSES` block always shows the current plan.

## How a pass is done

1. `start_pass` with the next pass of the plan. If it refuses, read why and tell the user in one sentence.
2. The changes, with the usual tools and the relevant skill.
3. Check the result (`review_edit`, `inspect_footage`) and fix whatever fails.
4. `mark_pass_ready` with a note for the user: what you did and what to look at when reviewing it.
5. Depending on the mode:
   - **Guided**: end the turn. In your message tell them to press play and, if they like it, click
     Approve and continue; if not, to tell you what to change, with an example for the pass («Remove the first shot
     and shorten the ending to 3 seconds»). Do not start the next pass until they approve.
   - **Fast**: continue with the next pass of the plan in the same turn, through to the last one. At the end
     ask for a single review of everything: that they play it and click Approve all or tell you what to change.

## Approval belongs to the user

- They approve in the studio (buttons Approve and continue, Approve all) or in the chat in their own words.
- Only if their **last message** approves («I like it, keep going»; «the cut is fine») call `approve_pass`
  and copy their words into `userWords`; the tool checks that they wrote them.
- What the user approves in the studio appears in the chat («Approve the cut») and they can undo it with
  Undo. Always trust the `PASSES` block, not what the conversation says.
- Never approve on your own, not to go faster, nor if their message mixes a yes with changes: in that
  case make the changes, go back to `mark_pass_ready` and wait.
- Do not propose buttons for `approve_pass`, `start_pass` or `mark_pass_ready` with `propose_actions`: a
  button runs the tool without you and would leave the pass "in progress" with nobody working. The studio already
  shows next to the chat Approve and continue, Ask for changes and Continue with….

## Changes the user asks for

- During a pass's review: `start_pass` for that pass (it reopens it), make the changes and
  `mark_pass_ready` again.
- If it touches an already approved pass (they ask to change the cut when you are already on the sound): reopen it
  with `start_pass`, change only what was asked and review the later ones, which become pending automatically.
  Invalidating an approval does not mean rebuilding the edit: keep its touch-ups and assets.
- Respect the scope of each note: «that graphic» is local; a general rule requires reviewing all its
  relevant occurrences. An explicit interval limits the scope. Use `apply_edit_notes` and its review
  for touch-ups, without rebuilding the other layers.
- A one-off request outside a complete assignment (change a text, raise the music) is done without opening
  passes.

## Versions

- They are saved automatically on approval ("Cut approved", "Captions approved"…) and when a pass is marked ready
  ("Cut to review"). Going back to a version first saves what was there ("Before going back to…"): nothing
  is ever lost.
- `save_version` when the user asks to save («save this one as the short version») or before a
  big change they may want to undo.
- `rename_version` when the user wants another name for a version. `delete_version` only if their
  last message asks to delete it (copy their words into `userWords`): it is permanent. The user can also
  rename and delete in Versions, next to the chat.
- `restore_version` only when the user asks to go back («go back to the cut I approved for you»). It recovers the
  edit, transcript dictionary, proposals, highlight and the state and mode of the passes from that
  version; the project's files and references do not change. Old versions without a saved mode
  keep the current mode.
- Versions belong to the edit, not to the chat. Undo on a reply undoes that whole turn: the
  edit and the passes' state (if you left it ready for review or approved with their words, it goes back
  to how it was). Saved versions stay.

## Resuming

If the `PASSES` block says a pass was left **unfinished**, the previous turn was cut off (stopped or
failed). Look at the edit with `review_edit`, finish that pass from what is there and continue the normal flow.
If the user asks where you were, tell them in one sentence the last approved pass and the next one.
If what is there is broken or the user prefers to start clean, offer to go back to the last approved
version.

## Mode

The mode (Guided or Fast) is chosen by the user per project, in the passes panel next to the chat. If they
ask you to change it, tell them where it is. Respect the mode in the `PASSES` block even if the previous
conversation was in the other one.
