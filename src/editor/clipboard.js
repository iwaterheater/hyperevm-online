// Stub (step 3): copy, cut, paste and the stamp storage are written in step 4A.
// Clip = { v: 1, pivot: { x, z }, objects: [], spawns: [], chests: [], npcs: [] } - items in file form, absolute coordinates.
const todo = () => { throw new Error('not implemented'); };

export function makeClip(ctx, items) { return todo(); }
export function readClip() { return todo(); }
export function writeClip(clip) { return todo(); }
export function instantiate(ctx, clip, { x, z, rot = 0 } = {}) { return todo(); }   // -> { objects, spawns, chests, npcs, skipped }
export function listStamps() { return todo(); }
export function saveStamp(name, clip) { return todo(); }
export function deleteStamp(name) { return todo(); }
export function exportStamps() { return todo(); }       // -> string
export function importStamps(text) { return todo(); }   // -> count
