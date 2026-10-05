// Constants and formulas shared by the server and the client.

export const WORLD_R = 260;
export const TOWN_R = 24;
export const TICK = 1 / 15;
export const CAST_TIME = 0.65;      // seconds a player stands still channelling before a bolt is released
export const BOLT_DMG = 3;          // base damage of one bolt, before level and weapon multipliers
export const BOLT_RANGE = 22;       // how far away the target of a bolt may be
export const BOLT_MP = 8;
// Basic attack: the cat auto-attacks its selected target with the sword while within reach.
export const SWORD = { cd: 0.45, range: 2.4, dmg: 2 };
// Skill 2, Starfall: a ground-targeted area blast that lands shortly after the cast completes.
export const METEOR = { cast: 0.9, cd: 6, range: 16, radius: 4.5, dmg: 10, delay: 0.45, mp: 22 };
export const ATTACK_WINDUP = 0.4;   // seconds between a monster starting its swing and the hit landing

export const MOB_TYPES = {
  chaser:  { name: 'Skeleton Minion',  r: 0.7,  hp: 3,   speed: 3.0, dmg: 10, xp: 10,  color: 0xff3b8d },
  runner:  { name: 'Skeleton Rogue',   r: 0.45, hp: 1.5, speed: 5.2, dmg: 6,  xp: 8,   color: 0xff9a3b },
  shooter: { name: 'Skeleton Mage',    r: 0.6,  hp: 3,   speed: 2.4, dmg: 8,  xp: 16,  color: 0xffe14d },
  tank:    { name: 'Skeleton Warrior', r: 1.3,  hp: 14,  speed: 1.8, dmg: 20, xp: 45,  color: 0xb04dff },
  boss:    { name: 'Skeleton King',    r: 2.8,  hp: 160, speed: 2.2, dmg: 14, xp: 600, color: 0xff2244 },
};
export const MOB_KEYS = Object.keys(MOB_TYPES);

export const xpNext = (level) => Math.round(50 * Math.pow(level, 1.5));
export const maxHpFor = (level) => 100 + 20 * (level - 1);
export const maxMpFor = (level) => 60 + 12 * (level - 1);
export const dmgMult = (level, weapon) => (1 + 0.4 * (weapon - 1)) * (1 + 0.08 * (level - 1));
export const upgradeCost = (weapon) => 40 * weapon;

// One seamless world: concentric zones around the town, harder the further out you go.
export const ZONES = [
  { r: TOWN_R, name: 'Hypercat Town' },
  { r: 95, name: 'Green Meadows · Lv 1–4', lvl: [1, 4], mobs: 110, types: ['chaser', 'chaser', 'chaser', 'runner', 'runner'] },
  { r: 175, name: 'Graveyard Wastes · Lv 5–9', lvl: [5, 9], mobs: 130, types: ['chaser', 'runner', 'shooter', 'shooter'] },
  { r: WORLD_R, name: 'Cursed Lands · Lv 10–15', lvl: [10, 15], mobs: 150, types: ['chaser', 'runner', 'shooter', 'tank', 'tank'] },
];
// The blacksmith NPC sells weapon upgrades to players standing next to him.
export const BLACKSMITH = { x: -4.8, z: 11.5 };
export const SHOP_RANGE = 5.5;

export const zoneAt = (dist) => ZONES.find((z) => dist <= z.r) || ZONES[ZONES.length - 1];

export const BOSS = { x: 0, z: -228, lvl: 18 };
export const FORT_R = 26;   // radius of the Skeleton King's fortress wall

// Treasure chests: beside the four roads, richer the further from town, plus the King's hoard in the fortress.
export const CHESTS = [];
for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
  let side = 1;
  for (let r = 46; r < WORLD_R - 12; r += 24) {
    side = -side;
    const x = dx * r + dz * side * 4.6, z = dz * r + dx * side * 4.6;
    if (Math.hypot(x - BOSS.x, z - BOSS.z) < FORT_R + 10) continue;
    CHESTS.push({ x, z, gold: r < ZONES[1].r ? 12 : r < ZONES[2].r ? 40 : 90 });
  }
}
CHESTS.push({ x: BOSS.x, z: BOSS.z - FORT_R + 6, gold: 400, big: true });
export const CHEST_REACH = 1.9;
