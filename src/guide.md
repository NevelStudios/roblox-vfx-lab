## overview

The VFX lab turns a WGSL node into Roblox textures. Roblox runs no custom shaders, so the node renders on this
machine's GPU (Dawn, headless) and is baked into a PNG: a flipbook sheet for a ParticleEmitter, or a still texture
for a ParticleEmitter, Beam, Trail or Decal.

The loop:

1. Read `node` and `helpers`. Write a node with `vfx_shader_write` (a file in the library, `shaders/<name>.wgsl`).
2. Look at it with `vfx_render` (the clip as a sheet, chosen phases, or a sweep of one parameter). Fix it with
   `vfx_shader_edit`, render again. Read `quality` before you call it done.
3. `vfx_bake` writes the final PNG and its recipe (`bakes/<name>.png` and `.json`).
4. `vfx_upload` uploads the PNG through Roblox's own Studio MCP (`upload_image`, the Studio user's account). Uploads are
   public, moderated and permanent: settle the look first, say how many uploads you will make, upload only on
   request. The same PNG is never uploaded twice: the recipe keeps its asset id.
5. `vfx_apply` puts the texture on a ParticleEmitter (with the flipbook settings), Beam, Trail, Decal or MeshPart,
   or creates a new emitter.
6. `vfx_preview` plays the emitters in the Edit viewport and freezes them at chosen moments for screenshots.

`vfx_delete` removes a node (`kind` node) or a bake with its recipe (`kind` bake). Delete only what the developer asks
you to delete.

The library is `$VFX_LAB_LIBRARY`, default `~/roblox-vfx-lab`. The tools that reach Studio (`vfx_upload`,
`vfx_apply`, `vfx_preview`) start Roblox's Studio MCP the first time they run; everything else works without Studio.
The same lab runs in a browser with no install at https://nevelstudios.github.io/roblox-vfx-lab/.

`vfx_viewer` answers the URL of a local page (WebGPU: Chrome, Edge, Safari 26, Firefox 141 on Windows) that plays
every node live with parameter sliders, a flipbook sheet view and an alpha view, and plays bakes as Roblox plays them.
It follows the library: every write, edit or bake you make shows on the open page at once. Give the URL to the
developer when they want to watch. The page also has a Code pane (the developer edits and saves nodes there, under
the same stale rule as `replaces`), a Gallery of the examples, and Export to Roblox, which uploads the open bake
through the Studio MCP after the developer confirms and applies it to what is selected in Studio. The examples are in
the library from the first start (`portal/green-portal`, a painted swirl, and `space/black-hole`, a ray-traced
black hole): read one with
`vfx_shader_read` before you write a node of the same kind.
With Auto bake on, the page bakes the node to `bakes/<node>.png` after every change it makes (parameters, grid, clip)
and plays the baked frame beside the live one; Save PNG downloads the sheet. The Clip panel takes the duration or the
FPS (each rewrites the other) and says when a loop is over Roblox's 30 fps. Pixels Fit (the default) renders the live
view at the screen's own resolution; while it plays, a node that takes over 30 ms a frame drops samples, and a pause
redraws it at full samples. A node's bake can change under you while
the developer works: read its recipe before you upload it.

## node

A node is WGSL that defines one function:

```wgsl
fn effect(uv: vec2f) -> vec4f
```

- `uv` is 0..1 inside the cell, y up, (0.5, 0.5) at the centre. The cell margin is outside uv: alpha there is 0.
- Return straight (not premultiplied) RGBA, each 0..1. Alpha is the shape. Keep RGB white or near white for most
  textures: the emitter's `Color` tints them, so one texture serves many colours.
- The engine supersamples each pixel (`ss` x `ss` samples on a rotated grid) and averages in premultiplied space,
  then dithers to 8 bits, so soft falloffs bake without bands. Smooth gradients need no noise of their own.

Uniforms (read only):

- `vfx.phase`: 0..1 across the clip. OneShot: frame i of N is i / (N - 1), so frame 0 is phase 0 and the last frame
  is phase 1. Loop: i / N, so phase 1 is the next loop's frame 0 (do not draw it twice).
- `vfx.time`: `phase * duration` in seconds. `vfx.duration` is the clip length.
- `vfx.frame`, `vfx.frames`: this frame's index and the frame count (as f32). Use them for variant sheets.
- `vfx.px`: one output pixel in uv units. Use it for crisp edges: `vfx_fill(d, vfx.px)`.

Parameters are annotations, read into `params.<name>`:

```wgsl
// @param glow f32 0..4 = 1.5 core brightness
// @param arms f32 2..8 = 4
// @param tilt vec2f = 0.2, -0.1
// @param tint color = #ffd27a
```

Types: `f32` (range `min..max` and default), `vec2f`, `vec3f`, `vec4f` (comma defaults), `color` (a vec3f from `#rrggbb`
or `r, g, b`). Text after the default is the description. At most 15 parameters. `vfx_render` and `vfx_bake` take
`values` to override them for one call; the file does not change.

## helpers

Every node can call these (all prefixed `vfx_`):

- `VFX_PI`, `VFX_TAU`
- `vfx_center(uv) -> vec2f`: uv to -1..1 with 0 at the centre.
- `vfx_polar(p) -> vec2f`: (radius, angle in -PI..PI).
- `vfx_rot(p, angle) -> vec2f`
- `vfx_remap(x, a, b) -> f32`: 0 at a, 1 at b, clamped.
- `vfx_ease_out(t)`, `vfx_ease_in(t)`, `vfx_ease_in_out(t)`
- `vfx_posterize(x, steps)`: cel steps for drawn matter.
- Signed distances (negative inside): `vfx_circle(p, r)`, `vfx_ring(p, r, width)`, `vfx_segment(p, a, b)` (unsigned
  distance to a line), `vfx_box(p, half)`.
- `vfx_fill(d, w) -> f32`: 1 inside a distance, an edge `w` wide. `w = vfx.px` gives a crisp anti-aliased edge.
- `vfx_glow(d, k) -> f32`: `exp(-d * k)` light falloff outside a shape.
- `vfx_hash21(p) -> f32`, `vfx_hash31(p) -> f32`, `vfx_hash33(p) -> vec3f`: 0..1 hashes.
- `vfx_noise(p)`, `vfx_noise3(p)`: gradient noise, about -1..1.
- `vfx_fbm(p, octaves)`, `vfx_fbm3(p, octaves)`: fractal noise, about -1..1.
- `vfx_loop_fbm(p, phase, speed, octaves)`: fractal noise that loops over phase with no jump (for Loop sheets).
- `vfx_cells(p) -> vec2f`: Worley distances (F1, F2). `F2 - F1` gives cracks and cell walls.

## examples

A shock ring that is bright on one side, grows with an ease out and breaks up as it fades:

```wgsl
// @param width f32 0.02..0.3 = 0.12
// @param breakup f32 0..1 = 0.6
fn effect(uv: vec2f) -> vec4f {
  let p = vfx_center(uv);
  let t = vfx.phase;
  let r = mix(0.15, 0.85, vfx_ease_out(t));
  let pol = vfx_polar(p);
  let side = 0.55 + 0.45 * cos(pol.y - 0.6);
  let w = params.width * (1.0 - 0.7 * t) * side;
  let band = vfx_fill(vfx_ring(p, r, w), vfx.px * 2.0);
  let n = vfx_fbm(p * 4.0 + vec2f(t * 3.0, 0.0), 4) * 0.5 + 0.5;
  let eaten = smoothstep(t * params.breakup, t * params.breakup + 0.15, n);
  let a = band * eaten * (1.0 - vfx_ease_in(t));
  return vec4f(vec3f(1.0), a * side);
}
```

A looping smoke puff with a silhouette and inner mottling:

```wgsl
fn effect(uv: vec2f) -> vec4f {
  let p = vfx_center(uv);
  let n = vfx_loop_fbm(p * 2.5, vfx.phase, 1.5, 5);
  let shape = vfx_fill(length(p) - 0.62 - n * 0.22, vfx.px * 2.0);
  let shade = 0.55 + 0.45 * (vfx_loop_fbm(p * 5.0 + 7.0, vfx.phase, 2.0, 3) * 0.5 + 0.5);
  return vec4f(vec3f(shade), shape);
}
```

## quality

`vfx_render` and `vfx_bake` measure every frame (coverage, peak alpha, alpha on the cell edge, share at full white,
change from the frame before) and warn about the usual faults. Fix every warning or say why it does not apply.

- The shape must stay fully inside the cell in every frame: any alpha on the edge makes a cut line in game. Read the
  `edge` stat (it must be 0 or close to it; the warning fires above 0.02) and shrink or fade the shape before uv
  0.05..0.95. Long tongues, spikes and outer waves need a cap (`0.93 * tanh(reach / 0.93)` keeps a radius under 0.93).
  Only a still with margin 0 made to tile (Beam, Trail) may touch the edge.
- Nothing ends on a cut. A short edge fade (say 0.8..0.9 of the radius) under a shape that reaches it draws a visible
  arc where the shape stops. Fade over a long band (about 0.62..0.93) and shrink or zoom out the shape until its tails
  taper on their own inside it. A cut hides on the dark backdrop: check the bake over a bright one (the sky) too.
- Fill the cell. Empty space around the subject spends pixels on nothing: frame it to fill most of the cell (a zoom
  or scale parameter), then check the two rules above again.
- Frame 0 must read alone: devices that switch flipbooks off show only frame 0.
- Every frame changes shape. A sheet that grows and then holds one drawing plays as a still image.
- A Loop sheet must not jump from the last frame to the first (use `vfx_loop_fbm` or `sin/cos(phase * VFX_TAU)`).
- Little is at full white: a bright core or accent, fainter body. A shape that is mostly full white reads flat.
- Light (glows, flares, rings) keeps light's symmetry and a smooth falloff. Drawn matter (slashes, puffs, debris)
  has crisp edges, uneven silhouettes, holes and breakup.
- Look at the alpha backdrop for the shape, the dark backdrop for how it reads in game, and a bright one for cuts.
- Flipbooks: 4x4 at 1024 (256 px frames) is the usual sheet; 8x8 gives 128 px frames for small particles.
  Soft glows can be 256 or 512 px stills. A frame needs as many pixels as it covers on screen: 256 px frames suit
  hits and puffs under about 250 px on screen; a big or hero effect is a 1024 still or `tiles` (see roblox).

## roblox

- `FlipbookLayout` comes from the grid (`Grid2x2`, `Grid4x4`, `Grid8x8`). `FlipbookMode` is `OneShot` (once over the
  particle's Lifetime) or `Loop` at `FlipbookFramerate` (frames / duration, at most 30). A loop that needs more than
  30 fps plays slower in game (64 frames take 2.13 s): set duration to frames / fps. Few frames for a lot of motion
  (a full turn in 4 frames) jump visibly: use a bigger grid or slower motion.
- A flipbook sheet plays only on a ParticleEmitter. Beams and Trails take still textures; for a scrolling beam bake
  a still with margin 0 that tiles across uv.x, then set `TextureSpeed`.
- `LightEmission` 1 is additive: dark pixels vanish. `LightEmission` 0 is alpha blend: the alpha shape shows.
- Images above 1024 px are scaled down by Roblox, so sheets stay at 1024 or less. A still that must be sharper (a big
  sky object) bakes with `tiles` 2..4: the node renders at tiles x size px, is checked whole, and is written as
  `<out>-<row>-<col>` PNGs (row 1 at the top). Upload each, then lay them out in one BillboardGui or SurfaceGui: an
  ImageLabel per tile at Size 1/tiles in Scale, so the seams meet exactly. A ParticleEmitter cannot tile.
- A frame stays sharp up to about its own size on screen: an 8x8 frame (128 px) shows its pixels once the particle
  covers a few hundred screen pixels. For a big or close effect, bake stills (grid 1, 1024 px) and move them in
  Roblox: `RotSpeed` spins one, two stills at different speeds make a swirl (a body and a streaks-only layer).
- One sprite that stays (a portal, an aura, a sky object) is an `ImageLabel` in a BillboardGui (LightInfluence 0,
  Size in studs): nothing ages out, so nothing flickers, and it can hold `tiles` or flipbook sheets that a client
  script steps through `ImageRectOffset`. A particle must be replaced, and each handoff flickers where the old and
  the new one overlap. If it must be a particle: emit from an Attachment (a part emits from a random point in its
  volume, so the sprite jumps), and in game emit one, wait two frames for it to spawn, then set `TimeScale = 0`;
  keep a `Rate` (a new one each period, Lifetime = period + 0.05) only so it shows in Edit.
