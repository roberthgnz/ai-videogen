---
name: custom-graphics
description: Draw the video's image with custom graphics in VideoGen - infographics, maps, calendars, comparisons, figures, lists and cutout collages made in HTML, SVG, CSS and animation, in the style of the reference or of My style - instead of covering it with stock video. Use it when the reference or requested style is graphic or illustrated, when the user asks for graphics, animations, infographics or "like the reference", and when a scene is a data point, a date, a comparison, a map or a process.
---

# Custom graphics

Use the response language specified in the studio instructions.

Not every image is searched for: many are drawn. With `create_graphic` you write a graphic (markup,
stylesheet and animation) and the studio renders it frame by frame into a video clip of the project,
at the montage's format. After that it is one more clip: it plays, trims and exports with the rest.

## When to draw and when not to

| What needs showing | Source |
| --- | --- |
| The reference or My style (`MY STYLE`) is drawn: illustration, paper cutouts, infographic, motion graphics | Custom graphics, in that style. **Never stock** |
| A data point, a date, a figure, a comparison, a map, a process, a list, a quote | Custom graphic |
| The user asks for "graphics", "animations", "infographic", "templates", "like the reference" | Custom graphics |
| A person, a place, a product, a real action | User's material; if there is none, stock |
| A short caption over a video that stays visible | `place_text` (skill `on-screen-text`) |
| An animated title, a transition or a named effect, an animated chart, 3D, Lottie, several scenes | HyperFrames composition (skill `hyperframes-compositions`, `render_composition`) |

Covering a graphic reference with stock video is not approximating it: it is a different video. Do not
invent data, figures, dates or map outlines that the user or their documents do not give; if a data
point is missing, ask for it or draw the shape as a diagram and say so.

## 1. Before drawing: the reference recipe

Look at the images in `reference_evidence` (zoom in with `inspect_reference`) and write the recipe in
`imagery.recipe` of `save_reference_analysis`. It must be enough to redo the style without looking
again:

- **Background:** color in hex and material (cream paper with grain, green cutting mat with grid, plain).
- **Palette:** 4-6 colors in hex and what each is used for (accent, text, boxes).
- **Pieces:** what they are like (cutouts with an irregular white border, calendar sheets, stickers,
  flat icons) and their shadow (hard and short, diffuse, none).
- **Captions:** font, weight, uppercase, colored box or tape, tilt.
- **Composition:** where the main thing goes, how much air, how many pieces per screen.
- **Movement:** how each piece enters and holds (jumps in beats like stop-motion, slides, the stroke
  draws itself) and how often the screen changes.

If the project uses My style (`MY STYLE`), its colors, fonts and rules take precedence over the reference.

## 2. How a graphic is written

`create_graphic` takes three texts. The studio supplies the rest (page, canvas, timeline).

- **`html`**: the drawing, inside `#stage`. The canvas is **1080×1920** vertical and **1920×1080**
  horizontal; position in pixels (`position:absolute; left; top`). Inline HTML and SVG, one `id`
  per piece that is animated. No `<script>`. A photo or logo from the user: `<img src="asset:<assetId>">`.
- **`css`**: the stylesheet. Palette in variables (`:root{--paper:#e9e2d0}`) and reusable classes
  (`.piece`, `.label`, `.sheet`, `.cutout`): they are your template for the whole series.
- **`animation`**: JavaScript. These already exist: `tl` (paused GSAP timeline; seconds from the start
  of the graphic), `gsap`, `stage`, `W`, `H`, `D` (duration), `rnd()` (reproducible randomness, 0-1) and
  `drawPath(selector, {duration, ease}, second)` (an SVG stroke that draws itself).
  Each movement is a `tl.fromTo(...)`, `tl.to(...)` or `tl.set(...)` with its second at the end.

Render rules (it jumps frame by frame: whatever does not hang from `tl` is not seen or comes out different):

1. No `Math.random`, `Date`, `setTimeout`, `requestAnimationFrame`, `@keyframes`, `transition`,
   `repeat: -1` or another root timeline. A nested timeline is added with `tl.add(...)`.
2. No internet: no images, fonts or external scripts.
3. Fonts by name: Inter, Montserrat, Outfit, Nunito, Oswald, League Gothic, Archivo Black, Poppins,
   Roboto, Playfair Display, EB Garamond, Space Mono. If the reference uses another, pick the closest and say so.
4. Do not put a CSS `transform` on a piece you animate with GSAP: fixed tilt goes with
   `gsap.set("#id",{rotation:-3})`. Animate `x`, `y`, `scale`, `rotation`, `opacity`; not `left`/`top`.
5. Entrances with `fromTo` (the initial state is set from second 0). The last state holds until `D`:
   leave at least 0.6 s still at the end so it can be read.
6. `<canvas>`: draw in a function and call it from `onUpdate` of a `tl` tween
   (`tl.to(s,{p:1,duration:D,ease:"none",onUpdate:draw},0)`), never in your own loop.

### Example: paper collage, date change (vertical, 4 s)

```css
:root{--paper:#e9e2d0;--ink:#141414;--pink:#ec2f8f;--blue:#44597a}
#stage{background:var(--paper)}
.grain{position:absolute;left:0;top:0;opacity:.1}
.piece{position:absolute}
.label{padding:.16em .45em;font:900 64px/1 Montserrat,sans-serif;text-transform:uppercase;color:#fff;background:var(--ink);box-shadow:0 8px 0 rgba(0,0,0,.14)}
.label.pink{background:var(--pink)}
.sheet{width:300px;background:#f7f4ea;text-align:center;box-shadow:0 10px 0 rgba(0,0,0,.14)}
.sheet b{display:block;padding:14px 0;font:900 34px/1 Montserrat,sans-serif;text-transform:uppercase;color:#fff;background:var(--blue)}
.sheet span{display:block;font:900 190px/1.05 Montserrat,sans-serif;color:var(--ink)}
```

```html
<svg class="grain" width="1080" height="1920"><filter id="paper-filter"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" seed="4"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.3 0 0 0 -.5"/></filter><rect width="100%" height="100%" filter="url(#paper-filter)"/></svg>
<div id="time" class="piece label pink" style="left:330px;top:420px;font-size:120px">00:00</div>
<div id="h18" class="piece sheet" style="left:190px;top:650px"><b>November</b><span>18</span></div>
<svg id="cross" class="piece" style="left:180px;top:700px" width="330" height="270"><path d="M12 250 L318 22" fill="none" stroke="#141414" stroke-width="12" stroke-linecap="round"/></svg>
<div id="h19" class="piece sheet" style="left:590px;top:630px"><b style="background:var(--pink)">November</b><span>19</span></div>
<div id="footer" class="piece label pink" style="left:300px;top:1190px">To Thursday 19</div>
```

```js
gsap.set("#time",{rotation:-2}); gsap.set("#h18",{rotation:-3}); gsap.set("#h19",{rotation:2});
tl.fromTo("#time",{scale:0,opacity:0},{scale:1,opacity:1,duration:.3,ease:"back.out(2)"},.15);
tl.fromTo("#h18",{y:80,opacity:0},{y:0,opacity:1,duration:.35,ease:"steps(4)"},.5);
drawPath("#cross path",{duration:.25,ease:"power1.in"},1.3);
tl.fromTo("#h19",{y:80,opacity:0},{y:0,opacity:1,duration:.35,ease:"steps(4)"},1.6);
tl.fromTo("#footer",{scale:.6,opacity:0},{scale:1,opacity:1,duration:.25,ease:"back.out(2)"},2.2);
for(let t=2.6;t<D-.2;t+=.3) tl.set("#h19",{rotation:2+(rnd()-.5)*1.5},t); // stop-motion jitter
```

It is an example of the technique, not a template to copy: the style comes from the reference recipe.

### Resources that are often needed

- **Paper grain:** a full-canvas SVG `<rect>` with `feTurbulence` (with a fixed `seed`), still.
- **Cutout with white border:** in SVG, the same `<path>` twice: underneath in white with a thick white
  `stroke` and `stroke-linejoin="round"`, on top in its color. Irregular border: an
  `feTurbulence` + `feDisplacementMap` filter (`scale` 8-16) on the group. Hard shadow: `filter:drop-shadow(0 8px 0 rgba(0,0,0,.16))`.
- **Label or tape:** a colored box with uppercase weight-900 text tilted 1-4 degrees.
- **Mat or grid:** `background-image` with two repeated `linear-gradient`s (lines every 60 px).
- **Stroke that draws itself** (route on a map, strikethrough, arrow, underline): an SVG `<path>` with
  `stroke` and no fill, and `drawPath("#route",{duration:1.6},0.9)`. Do not do it by hand with
  `pathLength="1"`: the stroke would appear all at once.
- **Counting figure:** `tl.to(n,{v:85.6,duration:1,onUpdate:()=>el.textContent=n.v.toFixed(1)},1)`.
- **Stop-motion feel:** `ease:"steps(4)"` on entrances and small rotation `tl.set`s every 0.3 s.

## 3. Placing it in the video

- **Video from a script:** `build_timeline` with `stock: false`. It returns the span of each scene
  (`start`, `duration`, when the voice starts): one `create_graphic` per scene with those `start` and `duration`.
- **Replace a shot** (stock or the user's) with a graphic: `replaceClipId` with the clip's id. The
  graphic inherits its place and duration.
- **Add it at a given moment:** `start`. Whatever it covers on the main track is trimmed, without moving the rest.
- Inside the graphic, time starts at 0. The main thing enters before 0.4 s; each data point appears
  when the voice names it (about 0.3 s per word from when the voice starts) and never before.
- One idea per graphic. If the scene says two things, they are two moments of the same graphic or two graphics.
- In pass-based editing (`PASSES`), graphics that are the video's image are made in the **cut** pass.

## 4. The series is a system

The first graphic sets the visual system: palette, background, classes and way of moving. Review it and
fix it before making more. The following ones carry `styleFrom` with its `assetId`: they receive its
`css` and you only send the `html`, the `animation` and the new css. That way they all look like the
same video and changing a color is changing a variable. Vary the composition between graphics (not
always centered, not always the same pieces).

## 5. Make it readable

- Vertical: the important things between **y 250 and 1440 px** and between **x 60 and 960 px** (top,
  bottom and right are covered by the TikTok, Reels and Shorts interface). The background and
  decorations do reach the edges.
- If the montage has subtitles, leave their strip free (see its `y` in the state).
- Sizes for 1080 width: headline 84-130 px, labels 48-72 px, nothing below 36 px.
- High contrast between text and box. Few words: the graphic accompanies the voice, it does not repeat all of it.

## 6. Look at it before answering

`create_graphic` returns six frames of the result. Compare them with the reference like an art
director: same background and texture, same palette, same pieces and borders, same typography and air?
Is each text readable and does it fit in the safe zone? Is anything cut off, overlapped or empty? Does
the last frame hold on its own? A red banner «ANIMATION ERROR» is a failure in
your JavaScript.

Fix with `create_graphic` and `replaces` (two rounds at most per graphic): the new version takes the
place of the old one. To touch up a graphic from another turn, recover how it is made with `read_graphic`.

## 7. How to tell it

Say what you drew and what you took from the reference («I made the five scenes as paper cutouts on a
cream background, with your pink and black labels»), and what you could not match and why (an exact
font, a very detailed illustration). Give them an example of how to ask you for changes: «Make the calendar blue», «Remove the paper texture»,
«On the map, make the line draw more slowly».
