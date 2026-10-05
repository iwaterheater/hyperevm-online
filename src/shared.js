// Constants, data tables and formulas shared by the server and the client.

export const WORLD_R = 260;
export const TOWN_R = 24;
export const TICK = 1 / 15;
export const ATTACK_WINDUP = 0.4;   // seconds between a monster starting its swing and the hit landing

export const MOB_TYPES = {
  chaser:  { name: 'Skeleton Minion',  r: 0.7,  hp: 3,   speed: 3.0, dmg: 10, xp: 10,  color: 0xff3b8d },
  runner:  { name: 'Skeleton Rogue',   r: 0.45, hp: 1.5, speed: 5.2, dmg: 6,  xp: 8,   color: 0xff9a3b },
  shooter: { name: 'Skeleton Mage',    r: 0.6,  hp: 3,   speed: 2.4, dmg: 8,  xp: 16,  color: 0xffe14d },
  tank:    { name: 'Skeleton Warrior', r: 1.3,  hp: 14,  speed: 1.8, dmg: 20, xp: 45,  color: 0xb04dff },
  boss:    { name: 'Skeleton King',    r: 2.8,  hp: 160, speed: 2.2, dmg: 14, xp: 600, color: 0xff2244 },
};
export const MOB_KEYS = Object.keys(MOB_TYPES);

// ---------------------------------------------------------------- classes

// Two starting classes; at PROFESSION_LEVEL each branches into professions (`base` names the parent).
// hp / mp: [at level 1, per level]. patk / matk scale physical and magic damage, pdef divides damage taken.
// atkCd is the auto-attack interval, reach its range, hit its base damage.
export const CLASSES = {
  fighter: { name: 'Fighter', base: null, hp: [110, 24], mp: [40, 6], patk: 1, matk: 0.4, pdef: 1, crit: 0.08, atkCd: 0.5, reach: 2.4, hit: 2,
    weapon: 'sword', hoodie: 0x35523f, text: 'Fights up close with a sword. Tough and simple to play.' },
  mystic: { name: 'Mystic', base: null, hp: [80, 16], mp: [90, 16], patk: 0.5, matk: 1, pdef: 0.7, crit: 0.05, atkCd: 0.8, reach: 2.4, hit: 2,
    weapon: 'staff', hoodie: 0x3b4a8a, text: 'Casts spells from a distance. Fragile, lives on mana.' },
  knight: { name: 'Knight', base: 'fighter', hp: [150, 32], mp: [50, 7], patk: 0.95, matk: 0.4, pdef: 1.5, crit: 0.08, atkCd: 0.55, reach: 2.4, hit: 2,
    weapon: 'shield', hoodie: 0x5a6470, text: 'Tank: heavy defence, a shield, and skills that pull monsters onto himself.' },
  rogue: { name: 'Rogue', base: 'fighter', hp: [100, 22], mp: [50, 8], patk: 1.1, matk: 0.4, pdef: 0.9, crit: 0.25, atkCd: 0.36, reach: 2.4, hit: 2,
    weapon: 'daggers', hoodie: 0x6a2a2a, text: 'Melee damage: fast twin daggers, frequent critical hits, a quick dash.' },
  archer: { name: 'Archer', base: 'fighter', hp: [95, 20], mp: [55, 9], patk: 1.25, matk: 0.4, pdef: 0.8, crit: 0.15, atkCd: 0.9, reach: 18, hit: 2, ranged: true,
    weapon: 'bow', hoodie: 0x6a6a2a, text: 'Ranged damage: shoots a bow from far away, weak when cornered.' },
  wizard: { name: 'Wizard', base: 'mystic', hp: [85, 17], mp: [110, 20], patk: 0.5, matk: 1.35, pdef: 0.7, crit: 0.05, atkCd: 0.8, reach: 2.4, hit: 2,
    weapon: 'staff', hoodie: 0x5a2f7a, text: 'Magic damage: fire, wide area spells, and putting monsters to sleep.' },
  cleric: { name: 'Cleric', base: 'mystic', hp: [100, 20], mp: [110, 20], patk: 0.6, matk: 1, pdef: 0.9, crit: 0.05, atkCd: 0.8, reach: 2.4, hit: 2,
    weapon: 'staff', hoodie: 0xcfc9ae, text: 'Support: heals and blesses everyone nearby, raises the fallen.' },
};
export const CLASS_KEYS = Object.keys(CLASSES);
export const START_CLASSES = CLASS_KEYS.filter((k) => !CLASSES[k].base);
export const PROFESSION_LEVEL = 20;
export const professionsOf = (cls) => CLASS_KEYS.filter((k) => CLASSES[k].base === cls);
export const classLine = (cls) => (CLASSES[cls].base ? [CLASSES[cls].base, cls] : [cls]);

// ---------------------------------------------------------------- skills

// Skills are bought from the Sage with SP. `sp` lists the cost of each rank (a cost of 0 is granted for free with the class);
// values given as arrays hold one entry per rank.
// kind: strike (melee hit on the target) | shot (physical projectile) | bolt (magic projectile) | ground (area at the cursor)
//     | heal | buff | taunt | sleep | dash | revive | passive
export const SKILLS = {
  // Fighter
  power_strike: { name: 'Power Strike', cls: 'fighter', lvl: 1, kind: 'strike', power: [3.5, 4.5, 5.5], mp: 6, cd: 5, sp: [0, 60, 220],
    text: 'A heavy blow at your target.' },
  weapon_mastery: { name: 'Weapon Mastery', cls: 'fighter', lvl: 3, kind: 'passive', stat: 'patk', add: [0.08, 0.16, 0.24], sp: [40, 150, 400],
    text: 'Permanently raises physical attack.' },
  stun_strike: { name: 'Stun Strike', cls: 'fighter', lvl: 5, kind: 'strike', power: [2, 2.6], stun: [2, 3], mp: 10, cd: 12, sp: [120, 350],
    text: 'Hits the target and stuns it for a few seconds.' },
  war_cry: { name: 'War Cry', cls: 'fighter', lvl: 8, kind: 'buff', stat: 'patk', mult: [1.2, 1.3], dur: 20, mp: 12, cd: 30, sp: [300, 700],
    text: 'Raises your physical attack for 20 seconds.' },
  armor_mastery: { name: 'Armor Mastery', cls: 'fighter', lvl: 12, kind: 'passive', stat: 'pdef', add: [0.1, 0.2, 0.3], sp: [700, 1400, 2500],
    text: 'Permanently raises defence.' },

  // Mystic
  bolt: { name: 'Arcane Bolt', cls: 'mystic', lvl: 1, kind: 'bolt', fx: 'arcane', power: [3, 3.8, 4.6], mp: 8, cast: 0.65, cd: 0, range: 22, sp: [0, 60, 220],
    text: 'A homing bolt of magic at your target.' },
  mend: { name: 'Mend', cls: 'mystic', lvl: 3, kind: 'heal', power: [40, 60, 85], mp: 14, cast: 1, cd: 6, sp: [40, 150, 400],
    text: 'Restores your health.' },
  frost_bolt: { name: 'Frost Bolt', cls: 'mystic', lvl: 5, kind: 'bolt', fx: 'frost', power: [2.4, 3.2], slow: [0.5, 0.4], slowDur: 4, mp: 10, cast: 0.8, cd: 6, range: 22, sp: [120, 350],
    text: 'Damages the target and slows it for 4 seconds.' },
  starfall: { name: 'Starfall', cls: 'mystic', lvl: 8, kind: 'ground', power: [10, 13], radius: 4.5, range: 16, delay: 0.45, mp: 22, cast: 0.9, cd: 6, sp: [300, 700],
    text: 'A falling star blasts the area under the cursor.' },
  mana_mastery: { name: 'Mana Mastery', cls: 'mystic', lvl: 12, kind: 'passive', stat: 'mp', add: [0.12, 0.24, 0.36], sp: [700, 1400, 2500],
    text: 'Permanently raises maximum mana.' },

  // Knight
  provoke: { name: 'Provoke', cls: 'knight', lvl: 20, kind: 'taunt', radius: 10, mp: 8, cd: 10, sp: [0, 900],
    text: 'Forces every monster nearby to attack you instead of your allies.' },
  shield_bash: { name: 'Shield Bash', cls: 'knight', lvl: 22, kind: 'strike', power: [1.5, 2], stun: [3, 4], mp: 12, cd: 12, sp: [800, 1600],
    text: 'Slams the target with the shield, stunning it for longer.' },
  iron_wall: { name: 'Iron Wall', cls: 'knight', lvl: 25, kind: 'buff', stat: 'pdef', mult: [2, 2.5], dur: 10, mp: 15, cd: 40, sp: [1200, 2400],
    text: 'Doubles your defence for 10 seconds.' },
  shield_mastery: { name: 'Shield Mastery', cls: 'knight', lvl: 28, kind: 'passive', stat: 'pdef', add: [0.15, 0.3], sp: [1800, 3200],
    text: 'Permanently raises defence further.' },

  // Rogue
  backstab: { name: 'Backstab', cls: 'rogue', lvl: 20, kind: 'strike', power: [5, 6.5], mp: 10, cd: 6, sp: [0, 900],
    text: 'A vicious stab for very high damage.' },
  shadow_step: { name: 'Shadow Step', cls: 'rogue', lvl: 22, kind: 'dash', mp: 6, cd: 6, sp: [800],
    text: 'Dash forward; you cannot be hit while dashing.' },
  rend: { name: 'Rend', cls: 'rogue', lvl: 25, kind: 'strike', power: [1.5, 2], dot: [1.2, 1.8], dotDur: 5, mp: 10, cd: 10, sp: [1200, 2400],
    text: 'Opens a wound that bleeds for 5 seconds.' },
  crit_mastery: { name: 'Critical Mastery', cls: 'rogue', lvl: 28, kind: 'passive', stat: 'crit', add: [0.08, 0.16], sp: [1800, 3200],
    text: 'Permanently raises the chance of a critical hit.' },

  // Archer
  power_shot: { name: 'Power Shot', cls: 'archer', lvl: 20, kind: 'shot', fx: 'arrow', power: [4, 5.2], mp: 8, cast: 0.5, cd: 4, range: 22, sp: [0, 900],
    text: 'A carefully aimed, powerful arrow.' },
  volley: { name: 'Volley', cls: 'archer', lvl: 22, kind: 'ground', phys: true, power: [6, 8], radius: 4, range: 18, delay: 0.35, mp: 16, cast: 0.7, cd: 8, sp: [800, 1600],
    text: 'Rains arrows on the area under the cursor.' },
  pinning_shot: { name: 'Pinning Shot', cls: 'archer', lvl: 25, kind: 'shot', fx: 'arrow', power: [2, 2.6], stun: [2.5, 3.5], mp: 12, cast: 0.5, cd: 12, range: 22, sp: [1200, 2400],
    text: 'Pins the target in place for a few seconds.' },
  eagle_eye: { name: 'Eagle Eye', cls: 'archer', lvl: 28, kind: 'passive', stat: 'crit', add: [0.08, 0.16], sp: [1800, 3200],
    text: 'Permanently raises the chance of a critical hit.' },

  // Wizard
  fireball: { name: 'Fireball', cls: 'wizard', lvl: 20, kind: 'bolt', fx: 'fire', power: [6, 7.5], mp: 14, cast: 0.9, cd: 0, range: 24, sp: [0, 900],
    text: 'A ball of fire for heavy damage.' },
  inferno: { name: 'Inferno', cls: 'wizard', lvl: 22, kind: 'ground', power: [16, 20], radius: 6, range: 18, delay: 0.5, mp: 34, cast: 1.2, cd: 10, sp: [800, 1600],
    text: 'Sets a wide area under the cursor ablaze.' },
  slumber: { name: 'Slumber', cls: 'wizard', lvl: 25, kind: 'sleep', dur: [6, 9], mp: 14, cast: 0.8, cd: 15, range: 22, sp: [1200, 2400],
    text: 'Puts the target to sleep until it is damaged.' },
  spell_mastery: { name: 'Spell Mastery', cls: 'wizard', lvl: 28, kind: 'passive', stat: 'matk', add: [0.1, 0.2], sp: [1800, 3200],
    text: 'Permanently raises magic attack.' },

  // Cleric
  healing_circle: { name: 'Healing Circle', cls: 'cleric', lvl: 20, kind: 'heal', power: [70, 100], radius: 9, mp: 22, cast: 1, cd: 6, sp: [0, 900],
    text: 'Heals you and every player nearby.' },
  blessing_might: { name: 'Blessing of Might', cls: 'cleric', lvl: 22, kind: 'buff', stat: 'atk', mult: [1.15, 1.25], dur: 60, radius: 9, mp: 20, cd: 20, sp: [800, 1600],
    text: 'Raises the damage of everyone nearby for a minute.' },
  blessing_ward: { name: 'Blessing of Ward', cls: 'cleric', lvl: 25, kind: 'buff', stat: 'pdef', mult: [1.25, 1.4], dur: 60, radius: 9, mp: 20, cd: 20, sp: [1200, 2400],
    text: 'Raises the defence of everyone nearby for a minute.' },
  resurrection: { name: 'Resurrection', cls: 'cleric', lvl: 28, kind: 'revive', radius: 8, mp: 40, cast: 2, cd: 60, sp: [1800],
    text: 'Raises fallen players nearby on the spot.' },
};
export const SKILL_KEYS = Object.keys(SKILLS);
export const MAX_SLOTS = 8;

// every skill a character of this class can ever learn, starting class first
export const skillsFor = (cls) => SKILL_KEYS.filter((id) => classLine(cls).includes(SKILLS[id].cls));
// learned active skills in hotbar order (keys 1, 2, 3…)
export const hotbar = (cls, learned) => skillsFor(cls).filter((id) => SKILLS[id].kind !== 'passive' && learned[id] > 0).slice(0, MAX_SLOTS);

// Stats derived from class, level and passive skills.
export function statsOf(cls, level, learned = {}) {
  const c = CLASSES[cls];
  const passive = (stat) => {
    let v = 0;
    for (const id of skillsFor(cls)) {
      const s = SKILLS[id], rank = learned[id] | 0;
      if (s.kind === 'passive' && s.stat === stat && rank > 0) v += s.add[Math.min(rank, s.add.length) - 1];
    }
    return v;
  };
  return {
    maxHp: Math.round(c.hp[0] + c.hp[1] * (level - 1)),
    maxMp: Math.round((c.mp[0] + c.mp[1] * (level - 1)) * (1 + passive('mp'))),
    patk: c.patk * (1 + passive('patk')),
    matk: c.matk * (1 + passive('matk')),
    pdef: c.pdef * (1 + passive('pdef')),
    crit: c.crit + passive('crit'),
  };
}

// ---------------------------------------------------------------- progression

export const xpNext = (level) => 100 * level * level;
export const spFor = (xp) => Math.ceil(xp / 8);                  // skill points earned along with experience
export const DEATH_XP_LOSS = 0.04;                               // share of the current level's experience lost on death
export const dmgMult = (level, weapon) => (1 + 0.4 * (weapon - 1)) * (1 + 0.08 * (level - 1));
export const upgradeCost = (weapon) => 40 * weapon;

// ---------------------------------------------------------------- world

// One seamless world: concentric zones around the town, harder the further out you go.
export const ZONES = [
  { r: TOWN_R, name: 'Hypercat Town' },
  { r: 95, name: 'Green Meadows · Lv 1–4', lvl: [1, 4], mobs: 110, types: ['chaser', 'chaser', 'chaser', 'runner', 'runner'] },
  { r: 175, name: 'Graveyard Wastes · Lv 5–9', lvl: [5, 9], mobs: 130, types: ['chaser', 'runner', 'shooter', 'shooter'] },
  { r: WORLD_R, name: 'Cursed Lands · Lv 10–15', lvl: [10, 15], mobs: 150, types: ['chaser', 'runner', 'shooter', 'tank', 'tank'] },
];
export const zoneAt = (dist) => ZONES.find((z) => dist <= z.r) || ZONES[ZONES.length - 1];

// Townsfolk with a job: the Blacksmith sells weapon upgrades, the Sage teaches skills and professions.
export const BLACKSMITH = { x: -4.8, z: 11.5 };
export const SAGE = { x: 4.2, z: -4.6 };
export const SHOP_RANGE = 5.5;
export const near = (p, npc) => Math.hypot(p.x - npc.x, p.z - npc.z) < SHOP_RANGE;

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
