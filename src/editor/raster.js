// Stub (step 3): the ground rasteriser is written in step 4B. PURE: no DOM, no three.
// Every function returns an Int32Array of indices into ground.cells, without duplicates.
const todo = () => { throw new Error('not implemented'); };

export function disc(ground, x, z, radius) { return todo(); }
export function softDisc(ground, x, z, radius, seed) { return todo(); }
export function capsule(ground, x0, z0, x1, z1, radius, seed = null) { return todo(); }
export function ribbon(ground, points, width) { return todo(); }
export function flood(ground, index, { radius } = {}) { return todo(); }
export function inside(ground, shape) { return todo(); }
export function boundsOf(ground, indices) { return todo(); }   // -> { ix0, iz0, ix1, iz1 } | null
