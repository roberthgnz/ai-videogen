---
name: on-screen-text
description: Write, place and check texts over the video in VideoGen - hook, titles, lists, call to action and captions - so they can be read and cover nothing. Use it when the user asks for a text, a written hook, a call to action, captions, or to move or change a text.
---

# On-screen text

Use the response language specified in the studio instructions.

First decide whether they are needed from the prompt and the reference; do not add titles or captions
by default. A video with voice can go without captions, and original audio can be captioned without
generating voice-over. The explicit prompt prevails over the reference; the reference prevails over the
guideline sizes, positions and formulas in this guide. Also respect the absence of a box or text.

## What to write

- **One idea per text, 3-7 words.** If you need more, they are two texts at two moments.
- **Hook:** a promise, question or contrast that the video resolves («What if you
  slip away today?», «3 mistakes that ruin your photos»). Lasts 2-3 s
  and appears in the first second.
- **List:** number it («1. Clean the lens») and keep each point for as long as its
  block lasts.
- **Call to action:** a verb and a reason («Save it for your next break»,
  «Follow us for part 2»). At the end, at least 2.5 s.
- No emojis or stray symbols unless the user uses them. Uppercase only for very short phrases.
- Voice captions: enable them only when appropriate (`captions`); do not duplicate them. Their grouping,
  look and dynamism must follow the prompt and the reference, not necessarily show every word.

## Where and how

For a note about existing texts, load `edit-notes`: use `apply_edit_notes` by ID and
review all its batches with `review_edit_notes`. Do not rebuild the edit or resync the music.
What follows describes the initial creation; a correction must keep the unaffected fields.

`place_text` creates, changes or moves a text (without `id` it creates a new one; with `id` it changes it).
x and y are the top-left corner in % of the canvas; `width` in %; `fontSize` in pixels of a canvas 1080
wide (1920 in horizontal).

| Role | fontSize (vertical) | Usual position |
| --- | --- | --- |
| Hook | 64-84 | y 12-30 %, centered (`x` 4-8, `width` 84-92) |
| List point, label | 44-56 | Near what it points to |
| Call to action | 56-72 | y 55-72 % or wherever the subject is not |

- **Safe zone in vertical: y between 10 % and 80 %** of the height (above and below it the TikTok,
  Reels or Shorts interface covers it). In horizontal, leave a 5 % margin.
- Put it where the subject is **not**: sky, floor, wall, blurred area. Never over faces, eyes,
  hands doing something or the product.
- **Contrast:** over a light or very detailed background, use a box (dark `background`, e.g. `#101018`)
  and white text; over a dark, clean background, light text with no box.
- In a series of texts, keep position and size: the eye looks for them in the same place.
- Respect positions the user has already moved by hand.

## Check before replying

Each `place_text` returns **WARNINGS** (the measurable things - safe zone, framing, words, lines,
time on screen) and **an image of the frame** with the text in its yellow box and, in red, the strips
covered by the interface.

1. Fix all the WARNINGS, unless the user asked for exactly that.
2. Look at the image: if the text touches a face, eyes, hands or the subject, or cannot be read over the
   background, move it, change the size or add a box, and look again (maximum two rounds).
3. For a note, look at all the batches of `review_edit_notes`: they include simultaneous layers, shot
   changes, movement and the ending. An image of the original take with `inspect_footage` does not
   let you confirm how the other labels or the edit's zoom turn out.
4. In the reply say where it ended up and why («over the grass,
   not covering the flock»).
