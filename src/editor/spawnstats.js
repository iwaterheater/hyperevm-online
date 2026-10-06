// Stub (step 3): the numbers behind the Spawns panel are written in step 4C. PURE: no DOM, no three.
const todo = () => { throw new Error('not implemented'); };

export function spawnRows(map) { return todo(); }                  // -> [{ spawn, index, region, types, lvl, count, r, respawn }]
export function totalsByRegion(map) { return todo(); }             // -> [{ region, monsters, byType, lvl }]
export function levelsFromSpawns(map, region) { return todo(); }   // -> [min, max] | null
export function populate(map, region, { n, spacing, template, keepOut = 6, rnd = Math.random } = {}) { return todo(); }   // -> Spawn[]
