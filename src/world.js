import { MapView } from './map/view.js';
import { createLighting } from './map/lighting.js';
import { moodAt } from './map/format.js';

// The visible world of the game: the map drawn by a MapView (terrain, sea, scenery, foliage, colliders) under the
// light rig, whose mood follows the region the player stands in. What the world looks like is data - map/world.json,
// made in the map editor; nothing here is generated.

const MOOD_EVERY = 0.25;   // seconds between two looks at which region the player is in
const MOOD_RATE = 1.5;     // how fast the light drifts to a new mood: about two seconds for a full change

// `onProgress(done, total)` is called per model file of the map that has settled: the loading screen counts them.
export function createWorld(scene, map, { onProgress = null } = {}) {
  const view = new MapView(scene);
  const lighting = createLighting(scene);
  const ready = view.load(map, { onProgress });   // resolves even when single models are missing; the view logs those

  const focus = { x: 0, z: 0 };
  let mood = map.fallback.mood, moodT = 0;

  // -> true while the view still has work queued (foliage tiles to grow, models in flight)
  function update(time, dt, x, z) {
    if ((moodT -= dt) <= 0) { moodT = MOOD_EVERY; mood = moodAt(map, x, z); }
    lighting.approach(mood, 1 - Math.exp(-dt * MOOD_RATE));
    lighting.follow(x, z);   // the shadow frustum follows the player ...
    const y = heightAt(x, z);   // ... up the hills too: the rig is built around y = 0, so it is lifted to the player's ground
    lighting.sun.position.y += y;
    lighting.sun.target.position.y = y;
    focus.x = x; focus.z = z;
    return view.update(time, dt, focus);
  }

  // Jumps to the mood of a place at once: for the menu, a join and a teleport, where a two-second fade would look wrong.
  function snapMood(x, z) {
    mood = moodAt(map, x, z);
    moodT = MOOD_EVERY;
    lighting.set(mood);
  }

  // Pushes a circle (object with x/z) out of scenery, townsfolk and ground that cannot be walked on.
  // `prev` is where it stood before it moved: blocked ground is slid along from there, and a step that ends wedged
  // between two obstacles is taken back to it.
  function collide(p, radius = 0.4, prev = null) {
    view.collide(p, radius, prev);
  }

  snapMood(map.start.x, map.start.z);
  // The height of the ground under a world point: everything that walks adds it to its own height.
  const heightAt = (x, z) => view.heightAt(x, z);

  return { view, lighting, ready, update, collide, snapMood, heightAt };
}
