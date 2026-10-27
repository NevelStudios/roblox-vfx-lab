// Green portal: a lumpy disk of green liquid with spiral arms that wind into a bright yellow-green eye, painted in
// flat cartoon tones with brush streaks along the arms, a lighter lime rim with a ragged inner edge, and white specks
// swept around near the edge. Loop: the arms and the specks turn once per clip and the rim moves on a loop, so the
// sheet has no seam. Alpha blend with a little light (LightEmission 0.2); keep the emitter Color white.
// @param radius f32 0.45..0.72 = 0.66 portal radius
// @param wobble f32 0..0.12 = 0.08 how far the rim bulges
// @param arms f32 2..7 = 4 spiral arms (whole numbers)
// @param swirl f32 0..4 = 2.2 how tightly the arms wind into the eye
// @param strokes f32 1..6 = 3 brush streaks across the arms (more is finer)
// @param eye f32 0..1 = 0.85 brightness of the centre
// @param specks f32 0..1 = 0.6 white specks near the rim
// @param halo f32 0..1 = 0.2 soft glow just outside the rim
// @param deep color = #1d8a1f darkest strokes
// @param mid color = #45b82b main green
// @param light color = #93e03c light strokes
// @param glint color = #e9ff9e stroke highlights and the eye
// @param rim color = #b6ee46 rim band

fn effect(uv: vec2f) -> vec4f {
  let p = vfx_center(uv);
  let t = vfx.phase;
  let pol = vfx_polar(p);
  let around = vec2f(cos(pol.y), sin(pol.y));
  // The rim: a few big lumps and many small ripples, both looping, so it reads like liquid and never like a polygon.
  let lumps = vfx_loop_fbm(around * 1.2 + 7.0, t, 1.0, 2) * 0.65 + vfx_loop_fbm(around * 3.2 - 4.0, t, 2.0, 2) * 0.35;
  let radius = params.radius * (1.0 + lumps * params.wobble * 2.0);
  let rn = pol.x / radius;
  // Spiral coordinates: u is constant along an arm. The arm pattern uses a whole number of arms and the noise is read
  // on a circle of u, so the pattern turns a whole turn per clip with no seam.
  let v = log(max(rn, 0.02));
  let u = pol.y + params.swirl * v + t * VFX_TAU;
  let spiral = vec2f(cos(u), sin(u));
  // Brush streaks: noise fast across the arms and slow along them bends each arm and gives it painted edges.
  let bend = vfx_fbm3(vec3f(spiral * 1.6, v * 0.6), 3);
  let streak = vfx_fbm3(vec3f(spiral * params.strokes * 2.0 + 5.0, v * 0.9), 4) * 0.5 + 0.5;
  let arm = sin(floor(params.arms + 0.5) * u + bend * 2.4) * 0.5 + 0.5;
  let paint = arm * 0.72 + streak * 0.28;
  // Flat cartoon tones with short steps between them.
  var color = mix(params.deep, params.mid, smoothstep(0.3, 0.35, paint));
  color = mix(color, params.light, smoothstep(0.56, 0.61, paint));
  color = mix(color, params.glint, smoothstep(0.8, 0.84, paint) * 0.85);
  // The eye: the arms fade into a bright yellow-green centre.
  let eye = exp(-rn * rn * 9.0) * params.eye;
  color = mix(color, mix(params.light, params.glint, 0.7), smoothstep(0.25, 0.75, eye));
  // The rim band, lighter lime, with a ragged painted inner edge.
  let band = smoothstep(0.83, 0.87, rn + (streak - 0.5) * 0.12);
  color = mix(color, mix(params.rim, params.glint, smoothstep(0.6, 0.8, streak) * 0.5), band);
  // White specks that sweep around with the arms, mostly near the rim.
  let q = vfx_rot(p, -t * VFX_TAU) * 8.0;
  let cell = floor(q);
  let h = vfx_hash33(vec3f(cell, 11.0));
  let offset = (h.xy - 0.5) * 0.5;
  let blob = vfx_fill(length(fract(q) - 0.5 - offset) - mix(0.1, 0.22, h.z), 0.06);
  let speck = blob * step(h.z * 1.4, params.specks) * smoothstep(0.5, 0.75, rn) * (1.0 - smoothstep(0.95, 1.0, rn));
  color = mix(color, vec3f(0.97), speck);
  // Opaque liquid, with the darkest strokes a little see-through: depth, and motion in the alpha too.
  let depth = mix(0.86, 1.0, max(smoothstep(0.3, 0.35, paint), max(band, max(smoothstep(0.25, 0.75, eye), speck))));
  let disk = vfx_fill(rn - 1.0, vfx.px * 1.5 / radius) * depth;
  let halo = vfx_glow(rn - 1.0, 12.0) * params.halo * (1.0 - smoothstep(0.8, 0.94, pol.x));
  let alpha = max(disk, halo * (1.0 - disk));
  let rgb = mix(params.rim, color, clamp(disk / max(alpha, 0.0001), 0.0, 1.0));
  return vec4f(rgb, clamp(alpha, 0.0, 1.0));
}
