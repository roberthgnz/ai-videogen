---
name: short-script
description: Write or touch up the visual or narrated script of a short video in VideoGen. Use it when creating a story from a topic, adapting a reference, writing voice-over, or changing structure, duration or tone.
---

# Script for short videos

Use the response language specified in the studio instructions.

A script organizes what is communicated; it does not force narration. Decide from the user's prompt and,
for whatever it does not specify, the reference. Voice, captions, titles, music and effects are chosen
separately in `direction`: a voice chosen in Settings is not a request for voice-over. If the
example uses no captions or call to action, do not add them out of habit; if the user asks for them, do.
The formulas below are guidelines when there is no more specific direction.

## Hook (first sentence)

Pick a formula and say it in under 2 s:

- **Question that hurts:** «Why do your phone videos look homemade?»
- **Concrete figure:** «3 tricks I use in every recording.»
- **Contrast or common mistake:** «Everyone films vertical like this. It's wrong.»
- **Result first:** «I filmed this with a 200-euro phone.»

No greetings, introductions or «today I'm going to show you».

## Structures

| Type | Structure |
| --- | --- |
| List | Hook → point 1 → point 2 → point 3 (the best last) → close |
| Tutorial | Result → materials or context in one sentence → steps → result again |
| Myth / reality | What people believe → why it is false → what works |
| Story | Situation → problem → twist → lesson |

To retain viewers: open a question at the start and answer it at the end; every sentence pushes into the next.
Close: resolve the promise. Add a call to action when the prompt asks for it or it fits the reference.

## Writing for the voice

Apply this section only when narration applies.

- Synthetic narration in the language requested for the video: short sentences (8-14 words), one idea per sentence.
- Figures and symbols written as they are read («three percent», «ten euros»).
- **Duration:** about 2.2 words per second counting the pauses between scenes (measured with the synthetic
  voice: 79 words gave 35 s). Count the words before delivering and trim if you go over.

| Video | Total words |
| --- | --- |
| 15 s | 30-33 |
| 30 s | 62-66 |
| 45 s | 95-100 |
| 60 s | 128-132 |

- **B-roll:** every shot must show what the voice says at that moment. `find_broll` and `change_shot`
  return a sheet with the clip of each shot: look at it and change the ones that do not fit before replying.

## Tools

- **Script by scenes** (no visual edit):
  - With no script, or if asked to redo it from scratch: `write_script`. If it fails for lack of a key,
    write it yourself scene by scene with `add_scene`.
  - To touch up: `edit_scene`, `add_scene`, `remove_scene`, `move_scene`. Do not rewrite everything.
  - B-roll searches in English, 2-4 words, one concrete filmable subject.
- **From script to timeline:** with the script written and the b-roll reviewed, `build_timeline` assembles
  it without rendering. Explicitly decide `voiceover`, `captions`, `titles`, `music` and `sfx` from
  the prompt and the reference. With `voiceover=false` no voice is generated and no voice credit is spent.
  The user presses play and moves, cuts or changes whatever they do not like; they export when they want
  (or you do with `generate_video` if they ask). Do not render to show them the result.
  - It replaces the edit's clips and texts: if it was already assembled and the user has touched it up,
    warn them before assembling again.
  - With the script already assembled, whatever changes the script (narration, scenes, other b-roll, style)
    only reaches the edit by calling `build_timeline` again. For touch-ups to image, timing, texts or music,
    edit the edit directly.
- **Voice-over on an edit, when appropriate:** `add_voiceover` with sentences that fulfill the script's
  narrative function and accompany what is seen. `captions` is decided separately. Each sentence
  starts when what it names appears and lasts as long as its shot. It spends voice credit: launch it if the
  user asks or their permissions allow it; otherwise propose it with `propose_actions`.
- The voice (also the one `build_timeline` generates) and the final video spend credit: generate them only
  if the user asks or their permissions allow it.
