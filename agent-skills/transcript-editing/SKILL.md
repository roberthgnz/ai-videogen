---
name: transcript-editing
description: Edit a video with speech from what is said in VideoGen - read the timed transcript, remove phrases, clean up pauses, repeated takes and filler words, and correct names before captioning. Always use it when the user asks to remove something that is said, clean up or shorten a spoken recording, remove silences, pauses, repetitions or filler words, correct names or brands in the captions, or caption someone speaking to camera.
---

# Editing from the transcript

Use the response language specified in the studio instructions.

For spoken material (someone to camera, a tutorial, a podcast) the edit is decided by what is
said. Work with the studio's tools (`videogen` server):

| Tool | What it is for |
| --- | --- |
| `read_transcript` | Read phrases with word numbers (#n), seconds and what is already removed. Always first. |
| `propose_transcript_cuts` | Leave proposed cuts for the user to review. It does not change the edit. |
| `apply_transcript_cuts` | Cut: approved proposals or specific words. Closes the gap on all tracks. |
| `restore_transcript_words` | Put removed words back into the edit. |
| `set_transcript_corrections` | Dictionary of names and terms for the captions. |
| `highlight_caption_keywords` | Keyword of each caption in color (figures, names, the idea). |

The user sees the same thing in **Captions › Words**: what is removed appears struck through and they get it back with
a click; the proposed cleanup appears in **Cleanup** with checkboxes, and the corrections in **Names**.

## Propose or cut directly

Cut without asking only when the user has said exactly what to remove:

- «remove where I say "don't put this in"», «remove the second phrase», «cut the ending from "and that's it"» → `read_transcript`, locate the words and `apply_transcript_cuts` with `cuts`. Say what
  you removed and that it can be recovered.
- «Remove the silences / pauses» → long pauses: `propose_transcript_cuts` with `auto=true` and
  apply only those of type `pause` (or `analyze_media` silences for a clip). These are low-risk cuts.

Propose first (`propose_transcript_cuts`) when judgment is needed and the user has not decided:

- «clean it up», «remove what's extra», «make it 30 s», «remove filler words», «make it more dynamic».
- Repeated takes, phrases that drift off topic, explanations that repeat, false starts.
- Any cut that changes what is being told.

When proposing, in your message say how many cuts, how much they save and the two or three most important, and the
next step: "Review them in Captions › Cleanup and click Apply, or tell me \"apply all\"". When the
user approves («apply», «ok, all of them», «all but the third»), use `apply_transcript_cuts` with
`proposalIds` or `all=true`. Do not propose again what they already rejected.

## What to propose

1. **Long pauses** (more than 0.4 s; 0.3 s if they ask for a very fast rhythm). `auto=true` finds them
   by combining the gaps between words with the real silences in the audio: the transcription stretches
   words over the silences.
2. **Repeated takes**: the same phrase said twice in a row. By default the **last** good take stays; if the first is complete and the second
   stumbles, propose removing the second and say so in
   `reason`. Also look for false starts («today I'm going to… today I'll show you»).
3. **Filler words and hesitations**: hesitation sounds ("uh", "um" and their equivalents in the transcript language) always; verbal tics ("I mean", "like", "well", "so", "okay?" and their equivalents in the transcript language)  only if
   they are loose and add nothing. Do not remove so many that the person sounds like a robot.
4. **Disposable phrases** (`kind: "phrase"`): what says nothing new, repeats itself, drifts off topic
   or announces what is coming without saying it. For a duration target, propose the dispensable first and
   say how much would remain.

Never propose removing words that change the meaning (a "no", a figure, a name) without saying so.

## Margins

`apply_transcript_cuts` leaves `margin` (0.1 s by default) of breathing room next to the words that
stay, never more than half the gap, and never cuts inside a word. The edges are placed using the
audio level, where the sound really fades out and comes back: there is no need to compensate by hand for the transcript
timings. Raise it to 0.15–0.2 s for a slow
rhythm (interview, emotion); lower it to 0.05 s only if they ask for very tight cuts.

## Names and terms before captioning

Automatic transcription fails on proper names, brands and jargon ("cloud code" instead of "Claude Code").
Before creating captions or when reviewing them:

1. `read_transcript` and look for misspelled names, brands, acronyms and technical terms. Use the project's
   topic, the references and the user's documents to know how they are written.
2. If it is obvious, correct it with `set_transcript_corrections`; if in doubt, ask in one sentence with the
   list («Is it written "Nanobanana" or "Nano Banana"?»).
3. Then create the captions (`analyze_media` with `addCaptions=true`): they already come out corrected and
   grouped by phrases. The corrections are also applied to the captions that already exist.
4. If the prompt or the reference asks for it (reels with a word highlighted in color), use
   `highlight_caption_keywords`. Better with `words`: read the captions and choose the word that carries the
   idea of each one (a figure, a name, the result), not connectors or filler words.

## How to report it

In the `message` of `propose_actions`: what you removed or proposed, how long it is now (before → after)
and where to review or recover it. Offer as the next step applying the cleanup, captioning or reviewing
the rhythm, not repeating what you just did.
