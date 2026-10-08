import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MELEE_REACH } from './shared.js';

// What skills look like. The shapes are modelled in Blender (art/fx.blend) and exported as one file: projectiles,
// circles for the ground, glyphs, flames and volumes of light. They are drawn unlit - their facet shading is baked into
// their vertex colours, whose alpha is the fade of the see-through parts - and they are animated here, in code: each
// effect is a few of those shapes moved, turned, scaled and faded for a fraction of a second.
// White shapes take the colour of the skill; the fireball, the meteor, the arrow and the flame keep their own.
// In the file a projectile points along +Z with its tail behind it, glyphs stand facing +Z, the rest stands on y = 0.

const MODEL_URL = './assets/fx/fx.glb';
const TEAL = 0x7fe8d6, GOLD = 0xffd76a, GREEN = 0x8ee68e, RED = 0xff5a5a, FIRE = 0xff7a2a, ICE = 0xa9d8ff;
const VIOLET = 0xc9a6ff, STEEL = 0x9fc4ff, PALE = 0xffe9a6, WHITE = 0xffffff;

// projectiles by the `fx` of a skill: the model and the colour of the sparks it leaves
const BOLTS = { arcane: ['Arcane', TEAL], frost: ['Frost', ICE], fire: ['Fire', FIRE], arrow: ['Arrow', PALE] };
// the circle an area skill draws where it will land, and its colour
const AREAS = { starfall: ['CircleArcane', GOLD], inferno: ['CircleFire', FIRE], volley: ['CircleAim', PALE] };

const ease = (k) => 1 - (1 - k) ** 3;
const tone = (hex, k) => new THREE.Color(hex).multiplyScalar(k);
// the two materials of one effect: for its opaque parts and for those that fade by the alpha of their vertex colours
function matsOf(tint = WHITE, { k = 1.5, kGlow = 2, fade = false } = {}) {
  const base = { vertexColors: true, side: THREE.DoubleSide };
  return [
    new THREE.MeshBasicMaterial({ ...base, color: tone(tint, k), transparent: fade }),
    new THREE.MeshBasicMaterial({ ...base, color: tone(tint, kGlow), transparent: true, depthWrite: false }),
  ];
}
const opacity = (mats, a) => { for (const m of mats) if (m.transparent) m.opacity = a; };

// `groundY(x, z)`, `layOnGround(mesh, x, z, reach, lift)` and `burst(x, y, z, hex, n, speed)` are the game's own.
export function createFx(scene, { groundY, layOnGround, burst }) {
  const parts = {};   // name of the model -> its pieces: { geo, glow }
  const loaded = new GLTFLoader().loadAsync(MODEL_URL).then((gltf) => {
    for (const node of gltf.scene.children) {
      const list = parts[node.name] = [];
      node.traverse((o) => { if (o.isMesh) list.push({ geo: o.geometry, glow: o.material.name === 'fx_glow' }); });
      // layOnGround lays down what faces +Z: the circles are stood up to face it
      if (node.name.startsWith('Circle')) for (const p of list) p.geo.rotateX(Math.PI / 2);
    }
    return true;
  }, (err) => { console.error('[fx] the models did not load', err); return false; });

  // A model in the given materials. The group is there at once; its meshes appear when the file has arrived.
  function make(name, mats) {
    const g = new THREE.Group();
    loaded.then((ok) => { if (ok) for (const p of parts[name]) g.add(new THREE.Mesh(p.geo, mats[p.glow ? 1 : 0])); });
    return g;
  }
  // materials of what stays for as long as the game runs: status marks, the aiming circle
  const kept = {};
  const keptMats = (key, tint, opts) => (kept[key] ??= matsOf(tint, opts));

  // ---- the effects in flight: `step(k, dt)` moves one from k = 0 to k = 1, then it is taken away
  const live = [];
  function play(root, dur, mats, step, delay = 0) {
    root.visible = false;
    scene.add(root);
    live.push({ root, t: -delay, dur, mats, step });
  }
  function update(dt) {
    for (let i = live.length - 1; i >= 0; i--) {
      const e = live[i];
      e.t += dt;
      if (e.t < 0) continue;   // not yet
      const k = Math.min(1, e.t / e.dur);
      e.root.visible = true;
      e.step(k, dt);
      if (k < 1) continue;
      scene.remove(e.root);
      for (const m of e.mats) m.dispose();
      live.splice(i, 1);
    }
  }
  const heightOf = (who) => groundY(who.x, who.z) + (who.y || 0);   // a cat may be in the air; a monster never is

  // ---- the building blocks. Heights are above the ground at x, z.

  // the spiked flash of something that lands
  function impact(x, y, z, tint, size = 1, delay = 0) {
    const m = matsOf(tint, { k: 1.9 }), o = make('Impact', m);
    o.position.set(x, groundY(x, z) + y, z);
    o.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    play(o, 0.26, m, (k, dt) => {
      o.scale.setScalar(size * (k < 0.35 ? 0.3 + 2 * k : (1 - k) / 0.65));
      o.rotation.y += dt * 6;
    }, delay);
  }

  // A circle drawn on the ground: it opens, turns and fades. `who` keeps it under someone's feet; a `wave` keeps
  // growing as it fades, like a shock running outwards.
  function circle(name, x, z, radius, tint, dur, { spin = 0.7, who = null, wave = false } = {}) {
    const m = matsOf(tint), o = make(name, m), root = new THREE.Group();
    root.add(o);
    play(root, dur, m, (k, dt) => {
      if (who) { x = who.x; z = who.z; }
      layOnGround(root, x, z, radius / 2, 0.09);
      root.scale.setScalar(radius * (wave ? 0.15 + 0.85 * ease(k) : 0.7 + 0.3 * ease(Math.min(1, k * 5))));
      o.rotation.z += spin * dt;
      opacity(m, (wave ? 1 - k : Math.min(1, (1 - k) * 3)) * (radius > 5 ? 0.6 : 0.9));   // a wide circle is drawn fainter
    });
  }

  // a column of light that shoots up and thins out
  function pillar(who, radius, height, tint, dur) {
    const m = matsOf(tint, { kGlow: 1.6 }), o = make('Pillar', m);
    play(o, dur, m, (k, dt) => {
      const r = radius * (1 - 0.45 * k);
      o.position.set(who.x, groundY(who.x, who.z), who.z);
      o.scale.set(r, height * ease(Math.min(1, k * 4)), r);
      o.rotation.y += dt;
      opacity(m, Math.min(1, (1 - k) * 2.5));
    });
  }

  // blades of light that circle someone and rise
  function aura(who, radius, height, tint, dur) {
    const m = matsOf(tint, { kGlow: 1.8 }), o = make('Aura', m);
    play(o, dur, m, (k, dt) => {
      o.position.set(who.x, heightOf(who) + k * height * 0.4, who.z);
      o.scale.set(radius, height * (0.4 + 0.6 * ease(Math.min(1, k * 3))), radius);
      o.rotation.y += dt * 3;
      opacity(m, Math.min(1, k * 6, (1 - k) * 2));
    });
  }

  // a shell of light around someone
  function dome(who, radius, tint, dur) {
    const m = matsOf(tint, { kGlow: 1.5 }), o = make('Dome', m);
    play(o, dur, m, (k, dt) => {
      o.position.set(who.x, heightOf(who), who.z);
      o.scale.setScalar(radius * (0.5 + 0.5 * ease(Math.min(1, k * 6))));
      o.rotation.y += dt * 0.8;
      opacity(m, Math.min(1, (1 - k) * 4) * (0.8 + 0.2 * Math.sin(k * dur * 14)));
    });
  }

  // a sign (Sword, Shield, Plus, Star...) that appears over someone's head, turns and is gone
  function glyph(name, who, h, size, tint, dur) {
    const m = matsOf(tint, { k: 1.8 }), o = make(name, m);
    play(o, dur, m, (k, dt) => {
      o.position.set(who.x, heightOf(who) + h + 0.7 * ease(k), who.z);
      o.scale.setScalar(size * Math.min(1, k * 6, (1 - k) * 4));
      o.rotation.y += dt * 4;
    });
  }

  // small signs that rise from the ground here and there within a radius
  function motes(name, who, radius, n, tint, dur, size = 0.9) {
    const m = matsOf(tint, { k: 1.8 }), root = new THREE.Group();
    const bits = Array.from({ length: n }, () => {
      const a = Math.random() * Math.PI * 2, r = radius * Math.sqrt(Math.random());
      const bit = { o: make(name, m), x: Math.cos(a) * r, z: Math.sin(a) * r, at: Math.random() * 0.5, h: 0.3 + Math.random() * 0.7 };
      root.add(bit.o);
      return bit;
    });
    play(root, dur, m, (k, dt) => {
      for (const b of bits) {
        const u = THREE.MathUtils.clamp((k - b.at) * 2, 0, 1), x = who.x + b.x, z = who.z + b.z;
        b.o.position.set(x, groundY(x, z) + b.h + u * 1.8, z);
        b.o.scale.setScalar(size * Math.min(1, u * 5, (1 - u) * 3));
        b.o.rotation.y += dt * 3;
      }
    });
  }

  // fires that burn on the ground within a radius
  function flames(x, z, radius, n, dur, size = 1.6, delay = 0) {
    const m = matsOf(WHITE, { kGlow: 1.7 }), root = new THREE.Group();
    const bits = Array.from({ length: n }, (_, i) => {
      const a = Math.random() * Math.PI * 2, r = n === 1 ? 0 : radius * Math.sqrt((i + 0.5) / n);
      const bit = { o: make('Flame', m), s: size * (0.6 + Math.random() * 0.6), p: Math.random() * 6 };
      bit.o.position.set(x + Math.cos(a) * r, 0, z + Math.sin(a) * r);
      bit.o.position.y = groundY(bit.o.position.x, bit.o.position.z);
      root.add(bit.o);
      return bit;
    });
    play(root, dur, m, (k, dt) => {
      for (const b of bits) {
        const s = b.s * Math.min(1, k * 8, (1 - k) * 2.5);
        b.o.scale.set(s, s * (1 + 0.2 * Math.sin(k * dur * 22 + b.p)), s);
        b.o.rotation.y += dt * 2.5;
      }
    }, delay);
  }

  // Something that falls out of the sky onto a point and calls `land` there. `from` is where it starts, relative to
  // the point; `trail` the width of the wake behind it; `spin` turns it about the axis it was modelled to turn on.
  function fall(name, x, z, time, { tint = WHITE, size = 1, from = [7, 22, -4], trail = 0, spin = 0, axis = 'z', delay = 0 } = {}, land = null) {
    const m = matsOf(tint, { k: 1.8 }), root = new THREE.Group(), o = make(name, m);
    o.scale.setScalar(size);
    root.add(o);
    if (trail) {
      const wake = make('Trail', m);
      wake.scale.set(trail, trail, trail * 7);
      root.add(wake);
    }
    const end = new THREE.Vector3(x, groundY(x, z) + 0.3, z), start = end.clone().add(new THREE.Vector3(...from));
    root.position.copy(start);
    root.lookAt(end);
    play(root, time, m, (k, dt) => {
      root.position.lerpVectors(start, end, k);
      o.rotation[axis] += spin * dt;
      if (k >= 1) land?.();
    }, delay);
  }

  // The smear a blade leaves: an arc in front of (x, z) towards dx, dz. `roll` tips its plane over (a quarter turn
  // makes a downward chop), `lead` starts it earlier in the sweep, `mirror` sweeps it the other way.
  function slash(x, z, dx, dz, { h = 1, size = MELEE_REACH + 0.3, tint = WHITE, roll = 0, lead = 0, mirror = false, dur = 0.2, delay = 0 } = {}) {
    const m = matsOf(tint, { kGlow: 1.8 }), o = make('Slash', m), tilt = new THREE.Group(), root = new THREE.Group();
    tilt.add(o);
    root.add(tilt);
    root.position.set(x, groundY(x, z) + h, z);
    root.rotation.y = Math.atan2(dx, dz);
    tilt.rotation.z = roll;
    const way = mirror ? -1 : 1;
    play(root, dur, m, (k) => {
      const s = size * (0.85 + 0.25 * k);
      o.scale.set(way * s, s, s);
      o.rotation.y = way * ((k - 0.5) * 0.9 - lead);
      opacity(m, 1 - k);
    }, delay);
  }

  // a sign that is thrust from one to the other (the knight's shield)
  function thrust(name, a, tv, tint, size) {
    const m = matsOf(tint, { k: 1.7, fade: true }), o = make(name, m);
    const dx = tv.x - a.x, dz = tv.z - a.z, d = Math.hypot(dx, dz) || 1;
    o.rotation.y = Math.atan2(dx, dz);
    play(o, 0.3, m, (k) => {
      const p = 0.7 + ease(k) * Math.max(0, d - 0.7), x = a.x + dx / d * p, z = a.z + dz / d * p;
      o.position.set(x, groundY(x, z) + 1.2, z);
      o.scale.setScalar(size * Math.min(1, k * 5));
      opacity(m, Math.min(1, (1 - k) * 2.5));
    });
  }

  // ---- what each skill shows. `a` is who used it, `tv` the monster it was used on (both have x and z), `ev` the
  // server's event. Skills that are not listed get the effect of their kind.
  const facing = (a, tv) => {
    if (!tv) return [Math.sin(a.yaw), Math.cos(a.yaw)];
    const dx = tv.x - a.x, dz = tv.z - a.z, d = Math.hypot(dx, dz) || 1;
    return [dx / d, dz / d];
  };
  const chop = { roll: -Math.PI / 2, lead: 0.5, size: 2.2, h: 1.3 };
  const SHOWS = {
    power_strike(k, a, tv) {
      const [dx, dz] = facing(a, tv);
      slash(a.x, a.z, dx, dz, { ...chop, size: 2.8, tint: GOLD, dur: 0.26 });
      slash(a.x, a.z, dx, dz, { size: 3.1, tint: GOLD, dur: 0.26 });
      if (tv) impact(tv.x, tv.top * 0.6, tv.z, GOLD, 1 + tv.def.r);
    },
    stun_strike(k, a, tv) {
      const [dx, dz] = facing(a, tv);
      slash(a.x, a.z, dx, dz, { ...chop, tint: PALE });
      if (!tv) return;
      impact(tv.x, tv.top * 0.6, tv.z, PALE, 0.7 + tv.def.r);
      glyph('Star', tv, tv.top + 0.2, 1.1, GOLD, 0.5);
    },
    shield_bash(k, a, tv) {
      if (!tv) return;
      thrust('Shield', a, tv, STEEL, 1.7);
      impact(tv.x, tv.top * 0.6, tv.z, STEEL, 0.8 + tv.def.r, 0.18);
    },
    backstab(k, a, tv) {   // two cuts that cross on the target
      const [dx, dz] = facing(a, tv);
      for (const s of [-1, 1]) slash(a.x, a.z, dx, dz, { roll: s * 0.9, mirror: s < 0, tint: VIOLET, size: 2.7, h: 1.2, delay: s < 0 ? 0 : 0.07 });
      if (tv) impact(tv.x, tv.top * 0.6, tv.z, VIOLET, 0.6 + tv.def.r, 0.07);
    },
    rend(k, a, tv) {       // three claw marks
      const [dx, dz] = facing(a, tv);
      for (let i = 0; i < 3; i++) slash(a.x, a.z, dx, dz, { roll: -1.0, tint: RED, size: 2.2 + i * 0.35, h: 1.2, dur: 0.24, delay: i * 0.03 });
      if (tv) burst(tv.x, tv.top * 0.6, tv.z, RED, 12, 5);
    },
    mend(k, a) {
      circle('CircleHeal', a.x, a.z, 1.7, GREEN, 0.9, { who: a, spin: 1.5 });
      motes('Plus', a, 1.1, 5, GREEN, 0.9);
    },
    healing_circle(k, a) {
      circle('CircleHeal', a.x, a.z, k.radius, GREEN, 1.2);
      motes('Plus', a, k.radius * 0.9, 18, GREEN, 1.2);
      aura(a, 1.2, 2.2, GREEN, 0.8);
    },
    resurrection(k, a) {
      circle('CircleHeal', a.x, a.z, k.radius, WHITE, 1.8, { spin: 1.2 });
      pillar(a, 1.4, 11, PALE, 1.6);
      motes('Plus', a, k.radius * 0.8, 14, WHITE, 1.6);
    },
    war_cry(k, a) {
      circle('CircleWar', a.x, a.z, 5, RED, 0.5, { wave: true, spin: 0 });
      aura(a, 1.2, 2.4, FIRE, 0.9);
      glyph('Sword', a, 2.9, 1.5, GOLD, 0.9);
    },
    provoke(k, a) {
      circle('CircleWar', a.x, a.z, k.radius, RED, 0.55, { wave: true, spin: 0 });
      aura(a, 1.3, 2.2, RED, 0.7);
    },
    iron_wall(k, a) {
      dome(a, 1.9, STEEL, 2.2);
      glyph('Shield', a, 2.9, 1.3, STEEL, 1.0);
    },
    blessing_might(k, a) {
      circle('CircleArcane', a.x, a.z, k.radius, GOLD, 1.0);
      aura(a, 1.2, 2.4, GOLD, 1.0);
      glyph('Sword', a, 2.9, 1.5, GOLD, 1.0);
    },
    blessing_ward(k, a) {
      circle('CircleArcane', a.x, a.z, k.radius, STEEL, 1.0);
      dome(a, 1.8, STEEL, 1.0);
      glyph('Shield', a, 2.9, 1.3, STEEL, 1.0);
    },
    slumber(k, a, tv) {
      if (!tv) return;
      burst(tv.x, tv.top, tv.z, VIOLET, 22, 4);
      circle('CircleArcane', tv.x, tv.z, tv.def.r + 0.9, VIOLET, 0.8, { who: tv, spin: -2 });
    },
    starfall(k, a, tv, ev) {
      const { x, z } = ev;
      circle('CircleArcane', x, z, k.radius, GOLD, k.delay + 0.5, { spin: 1.4 });
      fall('Star', x, z, k.delay, { tint: PALE, size: 1.8, trail: 0.7, spin: 9, axis: 'y' }, () => {
        impact(x, 0.7, z, GOLD, k.radius * 0.6);
        pillar({ x, z }, k.radius * 0.35, 7, PALE, 0.45);
        burst(x, 0.5, z, GOLD, 30, 10);
      });
      for (let i = 0; i < 5; i++) {   // and a shower of lesser stars around it
        const a2 = i * 1.257 + Math.random(), r = k.radius * (0.45 + Math.random() * 0.4), sx = x + Math.cos(a2) * r, sz = z + Math.sin(a2) * r;
        fall('Star', sx, sz, k.delay, { tint: PALE, size: 0.8, trail: 0.3, spin: 9, axis: 'y', delay: 0.05 + i * 0.05 }, () => impact(sx, 0.4, sz, GOLD, 0.9));
      }
    },
    inferno(k, a, tv, ev) {
      const { x, z } = ev;
      circle('CircleFire', x, z, k.radius, FIRE, k.delay + 0.9, { spin: -1.6 });
      fall('Meteor', x, z, k.delay, { size: 1.7, spin: 3 }, () => {
        impact(x, 1, z, FIRE, k.radius * 0.75);
        circle('CircleWar', x, z, k.radius * 1.15, FIRE, 0.45, { wave: true, spin: 0 });
        flames(x, z, k.radius * 0.9, 12, 1.1, 2.2);
        flames(x, z, 0, 1, 0.9, 4.2);
        burst(x, 0.5, z, FIRE, 45, 12);
      });
    },
    volley(k, a, tv, ev) {
      const { x, z } = ev;
      const back = facing(a, { x, z });   // the arrows come down from the archer's side
      circle('CircleAim', x, z, k.radius, PALE, k.delay + 0.45, { spin: 0.5 });
      for (let i = 0; i < 10; i++) {
        const a2 = Math.random() * Math.PI * 2, r = k.radius * 0.9 * Math.sqrt(i / 10), ax = x + Math.cos(a2) * r, az = z + Math.sin(a2) * r;
        fall('Arrow', ax, az, k.delay, { size: 1.3, from: [-back[0] * 6, 17, -back[1] * 6], delay: i * 0.02 }, () => impact(ax, 0.3, az, PALE, 0.55));
      }
    },
  };
  const KINDS = {
    strike(k, a, tv) {
      const [dx, dz] = facing(a, tv);
      slash(a.x, a.z, dx, dz, chop);
      if (tv) impact(tv.x, tv.top * 0.6, tv.z, WHITE, 0.6 + tv.def.r);
    },
    heal(k, a) { SHOWS.mend(k, a); },
    buff(k, a) { circle('CircleArcane', a.x, a.z, k.radius || 2.5, GOLD, 0.9); aura(a, 1.2, 2.4, GOLD, 0.9); },
    taunt(k, a) { SHOWS.provoke(k, a); },
    revive(k, a) { SHOWS.resurrection(k, a); },
    sleep(k, a, tv) { SHOWS.slumber(k, a, tv); },
    ground(k, a, tv, ev) { SHOWS.starfall(k, a, tv, ev); },
  };

  // ---- what ails a monster, worn on it: stars circling a stunned head, Zs rising from a sleeping one, ice about
  // slowed feet. `root` is the monster's own group, which always faces the camera; `top` its height, `r` its girth.
  function status(root, top, r) {
    const stars = [0, 1, 2].map(() => make('Star', keptMats('stun', GOLD, { k: 1.8 })));
    const zs = [0, 1, 2].map(() => make('Zee', keptMats('sleep', VIOLET, { k: 1.9 })));
    const ice = make('IceSpikes', keptMats('slow', WHITE, { k: 1.25 }));
    ice.scale.setScalar(0.9 + r * 1.1);
    root.add(...stars, ...zs, ice);
    return {
      update(flags, time) {
        stars.forEach((o, i) => {
          const a = time * 5 + i * 2.094;
          o.visible = !!(flags & 1);
          o.position.set(Math.cos(a) * (r * 0.5 + 0.4), top + 0.1 + Math.sin(a * 2) * 0.06, Math.sin(a) * (r * 0.5 + 0.4));
          o.rotation.y = time * 6;
          o.scale.setScalar(0.7);
        });
        zs.forEach((o, i) => {
          const p = (time * 0.55 + i / 3) % 1;
          o.visible = !!(flags & 2);
          o.position.set(0.25 + p * 0.7 + Math.sin(p * 9) * 0.08, top + 0.1 + p * 1.5, 0);
          o.scale.setScalar((0.7 + p * 1.1) * Math.min(1, p * 6, (1 - p) * 4));
        });
        ice.visible = !!(flags & 4);
      },
    };
  }

  // ---- the circle that shows where an area skill will land while it is being cast
  const aims = {};
  function hideAim() { for (const o of Object.values(aims)) o.visible = false; }
  function aim(id, x, z, radius) {
    const [name, tint] = AREAS[id] || AREAS.starfall;
    hideAim();
    if (!aims[name]) {
      const m = keptMats(`aim ${name}`, tint, { kGlow: 1.6 });
      m[1].opacity = 0.7;
      scene.add(aims[name] = make(name, m));
    }
    const o = aims[name];
    layOnGround(o, x, z, radius / 2, 0.08);
    o.scale.setScalar(radius);
    o.visible = true;
  }

  return {
    ready: loaded,   // resolves to false when the models did not load; never rejects
    update, status, aim, hideAim,
    // the server accepted a skill: everything it shows but its projectile, which the game flies itself
    cast(id, k, a, tv, ev) { (SHOWS[id] || KINDS[k.kind])?.(k, a, tv, ev); },
    // the swing of a plain attack: 0 and 1 are the two horizontal sweeps, 2 the chop; `delay` is the wind-up before it
    swing(x, z, dx, dz, kind, delay = 0) { slash(x, z, dx, dz, kind === 2 ? { ...chop, delay } : { mirror: kind === 1, delay }); },
    // A projectile of the kind `fx`, put into the scene: move it, `point` it at where it flies and `drop` it at the end.
    bolt(fx, size = 1, tint = WHITE) {
      const m = matsOf(tint, { k: 1.15, kGlow: 2.2 }), root = new THREE.Group(), o = make((BOLTS[fx] || BOLTS.arcane)[0], m);
      o.scale.setScalar(size);
      root.add(o);
      scene.add(root);
      return Object.assign(root, { core: o, mats: m, fx });
    },
    point(bolt, x, y, z, dt) {
      bolt.lookAt(x, y, z);
      if (bolt.fx !== 'arrow') bolt.core.rotation.z += dt * 9;
    },
    drop(bolt) {
      scene.remove(bolt);
      for (const m of bolt.mats) m.dispose();
    },
    // a projectile arrives at height `y` on a monster of girth `r`
    hit(fx, x, y, z, r = 0.7) {
      const tint = (BOLTS[fx] || BOLTS.arcane)[1];
      impact(x, y, z, tint, fx === 'arrow' ? 0.6 : 0.8 + r * 0.6);
      burst(x, y, z, tint, 6, 5);
      if (fx === 'fire') flames(x, z, r * 0.6, 3, 0.55, 1.2);
    },
    // a monster's blast on the ground (the Skeleton King's slam)
    boom(x, z, r) {
      circle('CircleWar', x, z, r, FIRE, 0.5, { wave: true, spin: 0 });
      impact(x, 0.8, z, FIRE, r * 0.5);
      flames(x, z, r * 0.7, 7, 0.7, 1.8);
    },
    levelUp(who) {
      pillar(who, 1.5, 10, GOLD, 1.2);
      circle('CircleArcane', who.x, who.z, 3, GOLD, 1.2, { who, spin: 2 });
      motes('Star', who, 1.6, 7, GOLD, 1.2, 0.7);
    },
  };
}
