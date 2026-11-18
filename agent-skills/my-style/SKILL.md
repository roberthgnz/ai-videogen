---
name: my-style
description: Apply the user's My style profile (colors, fonts, logos, pacing, captions, graphics density and rules) to every VideoGen video, and propose new rules when they correct something that holds for all their videos. Use it when editing, placing texts or captions, and when the user corrects the style.
---

# My style

Use the response language specified in the studio instructions.

My style is a global user profile: what they want in **all** their videos, whatever
the project. They can have several (one per brand or client) and each project uses one. You receive it
every turn in the `CURRENT STATE` block (`MY STYLE` line) and in full with `get_style_profile`.
If the project has none, you work as usual and can only propose rules.

## Priority

1. What the user asks for in this project (their most recent message wins).
2. The rules and preferences of My style.
3. The project's references, for whatever the profile does not fix.
4. Your own judgment.

If a style reference clashes with a profile rule (the reference uses emojis and the profile says
«no emojis»), the rule wins. A field the profile does not mention is not a prohibition:
decide it from the prompt and the references.

## How to apply it

- **Pacing:** the profile's usual shot length and pacing set the `seconds` of `build_edit`. Keep
  the contrast between hook, body and close; do not turn it into a uniform cadence.
- **Captions:** Always = add them whenever there is voice; Never = do not add them
  unless the user asks for them here; Depends on the video = decide from the prompt.
  After creating them (`analyze_media` with `addCaptions`), style them with `apply_style_to_captions`:
  position, size, colors, font, uppercase, words per caption and highlight. The split uses the per-word
  timings; without unambiguous timings it keeps the existing groups. For a local correction use
  `apply_edit_notes` within its scope, without reapplying the global profile. Check with `review_edit`
  that they do not cover faces.
- **Texts and titles:** `place_text` with the profile's colors (text and box) and its title font
  (`fontFamily`, `fontWeight`, `fontStyle`). If it asks for an exact font you do not have, use the
  closest one and say so.
- **Graphics:** density decides how many labels you place. No graphics = none unless
  requested; Few = only at key moments (hook, data point, close); Many = accompanies
  almost every idea. If their notes describe a drawn image (cutouts, infographic, illustration), that is
  the image of their videos: make it with `create_graphic` (skill `custom-graphics`) using the profile's
  colors and fonts, not with stock video.
- **Logos:** `use_style_logo` brings the logo from the library into the project and gives you its
  `assetId`; place it with `edit_workspace` as an image clip on an upper track (`track` 1 or higher,
  `fit` contain), where its placement says. With no placement: at the end, small, covering nothing.
- **Rules:** follow all of them. Before considering the video finished, go through them one by one.

## Learning from the user

When the user corrects or asks for something that would hold for any video of theirs («captions lower», «no emojis», «fewer graphics», «never use zoom transitions»):

1. Apply it in this project, as usual.
2. Propose saving it with `propose_style_rule`: one rule per idea, in a concrete imperative sentence
   («Captions in the lower third, never over the
   face»), with the reason in `reason`.
3. In your `message`, say you are proposing it to them and that they can add or discard it in the chat.

Do not propose rules for something that only holds for this video («in this
one, the title in red»), for your own decisions, or for what a reference says. Do not repeat pending
proposals or rules the profile already has. **Nothing enters My style unless the user accepts it:**
never say it is already saved.

## How to report it

Say in one sentence what you took from My style («I used your colors and the captions at the bottom in uppercase, as in your Viegas style») and what could not be applied and why (for example, an exact font that is
not available).
