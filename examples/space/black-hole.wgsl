// Black hole: a Schwarzschild black hole seen from just above a wide, thick accretion disk. Every pixel traces its
// light ray back through the bent space around the hole, so the far side of the disk arcs over the shadow and its
// underside shows below it, a crisp photon ring rims the shadow, and the disk glows white-hot near the hole and
// orange to red farther out. The disk is a stack of thin layers, so it reads thick and fluffy edge-on. Loop: the
// disk turns once per clip. Alpha blend (LightEmission 0): the shadow is black and opaque, space around it is clear.
// Lengths are in Schwarzschild radii.
// @param tilt f32 0.02..0.5 = 0.1 camera height over the disk plane (radians)
// @param roll f32 -0.4..0.4 = 0 turns the whole view
// @param heat f32 0.4..1.6 = 1 disk temperature: redder below 1, whiter above
// @param glow f32 0.3..6 = 3 disk brightness
// @param thickness f32 0..0.12 = 0.05 disk thickness (share of the radius)
// @param doppler f32 0..1 = 0.3 how much brighter the approaching side is
// @param turbulence f32 0..1 = 0.75 streaks and clumps in the disk
// @param ring f32 0..1 = 0.8 photon ring brightness
// @param seed f32 0..100 = 3

const BH_INNER: f32 = 3.0; // innermost stable circular orbit
const BH_OUTER: f32 = 14.0;
const BH_DIST: f32 = 60.0; // camera distance
const BH_VIEW: f32 = 14.5; // half the frame's width at the hole
const BH_LAYERS: i32 = 5;

// Disk colour by temperature (1 is the hottest ring): deep red, orange, peach, warm white.
fn bh_color(t: f32) -> vec3f {
  let red = vec3f(0.6, 0.12, 0.02);
  let orange = vec3f(1.0, 0.45, 0.1);
  let peach = vec3f(1.0, 0.72, 0.42);
  let white = vec3f(1.0, 0.92, 0.8);
  return mix(mix(mix(red, orange, smoothstep(0.05, 0.35, t)), peach, smoothstep(0.35, 0.75, t)), white, smoothstep(0.75, 1.25, t));
}

// One crossing of disk layer `layer` (-1..1) at p by a ray heading along dir: premultiplied colour and opacity.
fn bh_disk(p: vec3f, dir: vec3f, layer: f32) -> vec4f {
  let r = length(p.xz);
  if (r < BH_INNER * 0.97 || r > BH_OUTER) {
    return vec4f(0.0);
  }
  // The pattern turns once per clip; it is read on a circle, so the loop has no seam.
  let angle = atan2(p.z, p.x) - vfx.phase * VFX_TAU;
  let around = vec2f(cos(angle), sin(angle));
  let lr = log(r);
  let streaks = vfx_fbm3(vec3f(around * 1.5 + params.seed + layer * 3.1, lr * 8.0), 5) * 0.5 + 0.5;
  let clumps = vfx_fbm3(vec3f(around * 4.5 - params.seed - layer * 1.7, lr * 18.0), 3) * 0.5 + 0.5;
  let density = mix(1.0, smoothstep(0.2, 0.8, streaks) * (0.45 + 0.55 * clumps), params.turbulence);
  // Thin-disk temperature: zero at the inner edge, peaking just outside it, falling as r^-3/4.
  let x = BH_INNER / r;
  let temp = pow(x, 0.75) * pow(max(1.0 - sqrt(x), 0.0), 0.25) * 2.05;
  // Orbital speed, Doppler factor toward the camera, and the climb out of the hole's well.
  let beta = sqrt(0.5 / (r - 1.0));
  let toward = dot(normalize(vec3f(-p.z, 0.0, p.x)), -dir);
  let g = sqrt(1.0 - beta * beta) / (1.0 - beta * toward) * sqrt(1.0 - 1.0 / r);
  let shift = mix(1.0, g, params.doppler);
  // The middle layers are denser than the outer ones; the disk thins out toward its rim.
  let core = 1.0 - abs(layer) * 0.55;
  let edges = smoothstep(BH_INNER * 0.97, BH_INNER * 1.2, r) * (1.0 - smoothstep(BH_OUTER * 0.45, BH_OUTER, r));
  let opacity = clamp(density * edges * core * 0.85, 0.0, 0.97);
  let intensity = (0.15 + 0.85 * temp) * pow(shift, 3.0) * params.glow * (0.5 + 0.5 * density);
  return vec4f(bh_color(pow(temp, 1.8) * mix(1.0, shift, 0.3) * params.heat) * intensity * opacity, opacity);
}

fn effect(uv: vec2f) -> vec4f {
  let s = vfx_rot(vfx_center(uv), params.roll) * BH_VIEW;
  let cam = vec3f(0.0, sin(params.tilt), cos(params.tilt)) * BH_DIST;
  let forward = -normalize(cam);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  var pos = cam;
  var vel = normalize(forward * BH_DIST + right * s.x + up * s.y);
  let l = cross(pos, vel);
  let h2 = dot(l, l);
  var acc = vec4f(0.0);
  var closest = 1e9;
  var captured = false;
  // Light near a mass bends as if pulled by -1.5 h^2 r / |r|^5 (h: the ray's angular momentum). Leapfrog steps,
  // short near the hole and long far from it.
  for (var i = 0; i < 480; i++) {
    let r = length(pos);
    closest = min(closest, r);
    if (r < 1.0) {
      captured = true;
      acc += vec4f(0.0, 0.0, 0.0, 1.0) * (1.0 - acc.a);
      break;
    }
    if ((r > BH_DIST * 1.1 && dot(pos, vel) > 0.0) || acc.a > 0.995) {
      break;
    }
    let dt = clamp(0.05 * (r - 0.9), 0.008, 2.0);
    let half = vel - 1.5 * h2 * pos / pow(r, 5.0) * dt * 0.5;
    let next = pos + half * dt;
    vel = half - 1.5 * h2 * next / pow(length(next), 5.0) * dt * 0.5;
    // The disk's layers are thin cones y = layer * thickness * radius; a ray that crosses one picks up its light.
    for (var k = 0; k < BH_LAYERS; k++) {
      let layer = f32(k) / f32(BH_LAYERS - 1) * 2.0 - 1.0;
      let slope = layer * params.thickness;
      let a = pos.y - slope * length(pos.xz);
      let b = next.y - slope * length(next.xz);
      if (a * b <= 0.0 && a != b) {
        acc += bh_disk(mix(pos, next, a / (a - b)), normalize(vel), layer) * (1.0 - acc.a);
      }
    }
    pos = next;
  }
  // Rays that skim the photon sphere (r = 1.5) and escape: the thin bright ring on the shadow's rim.
  if (!captured) {
    let photon = exp(-max(closest - 1.5, 0.0) * 55.0) * params.ring;
    acc += vec4f(vec3f(1.0, 0.92, 0.82) * photon * 1.6, photon) * (1.0 - acc.a);
  }
  let rgb = acc.rgb / max(acc.a, 0.0001);
  // Tone map on the brightest channel, so bright orange stays orange and does not wash out to white.
  let peak = max(max(rgb.r, rgb.g), rgb.b);
  let mapped = rgb / max(peak, 0.0001) * (1.0 - exp(-peak * 1.6));
  return vec4f(mapped, acc.a);
}
