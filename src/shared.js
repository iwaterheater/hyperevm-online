// Constants, data tables and formulas shared by the server and the client.

export const TICK = 1 / 15;
export const ATTACK_WINDUP = 0.4;   // seconds between a monster starting its swing and the hit landing

// hp, pAtk: at level 1. pDef / mDef: multipliers on the level-based defence (warriors shrug off blades, mages shrug off spells).
// eva: bonus to evasion.
export const MOB_TYPES = {
  chaser:  { name: 'Skeleton Minion',  r: 0.7,  hp: 30,   speed: 3.0, pAtk: 14, pDef: 1,   mDef: 1,   eva: 0, xp: 10,  color: 0xff3b8d },
  runner:  { name: 'Skeleton Rogue',   r: 0.45, hp: 15,   speed: 5.2, pAtk: 8,  pDef: 0.7, mDef: 0.9, eva: 6, xp: 8,   color: 0xff9a3b },
  shooter: { name: 'Skeleton Mage',    r: 0.6,  hp: 30,   speed: 2.4, pAtk: 11, pDef: 0.7, mDef: 1.6, eva: 0, xp: 16,  color: 0xffe14d, magic: true },
  tank:    { name: 'Skeleton Warrior', r: 1.3,  hp: 140,  speed: 1.8, pAtk: 28, pDef: 1.6, mDef: 0.8, eva: 0, xp: 45,  color: 0xb04dff },
  boss:    { name: 'Skeleton King',    r: 2.8,  hp: 1600, speed: 2.2, pAtk: 20, pDef: 1.5, mDef: 1.5, eva: 2, xp: 600, color: 0xff2244, magic: true },
};
export const MOB_KEYS = Object.keys(MOB_TYPES);
// How far monsters sense and roam, in world units; the map editor draws its threat rings from the same numbers.
export const AGGRO_R = 13;        // a monster notices a player this close
export const BOSS_AGGRO_R = 20;   // the same for a boss
export const LEASH_R = 30;        // it only picks a target while it is this close to its home
export const WANDER_R = 5;        // an idle monster strolls this far from its home on each axis

// A monster's combat stats at a given level.
export function mobStats(type, level) {
  const d = MOB_TYPES[type];
  return {
    maxHp: Math.ceil(d.hp * (1 + 0.45 * (level - 1))),
    pAtk: Math.round(d.pAtk * (1 + 0.15 * (level - 1))),
    pDef: Math.round((15 + 3 * level) * d.pDef),
    mDef: Math.round((12 + 2.5 * level) * d.mDef),
    acc: level + 10,
    eva: level + 6 + d.eva,
  };
}

// ---------------------------------------------------------------- classes

// Two starting classes; at PROFESSION_LEVEL each branches into professions (`base` names the parent).
// attr: the six base attributes - STR, DEX, CON, INT, WIT, MEN - from which every combat stat is derived (see statsOf).
// armor: base physical defence of what the class wears. reach: auto-attack range.
export const CLASSES = {
  fighter: { name: 'Fighter', base: null, attr: [40, 30, 43, 21, 11, 25], armor: 40, reach: 2.4,
    weapon: 'sword', hoodie: 0x35523f, text: 'Fights up close with a sword. Tough and simple to play.' },
  mystic: { name: 'Mystic', base: null, attr: [22, 21, 27, 41, 20, 39], armor: 22, reach: 2.4,
    weapon: 'staff', hoodie: 0x3b4a8a, text: 'Casts spells from a distance. Fragile, lives on mana.' },
  knight: { name: 'Knight', base: 'fighter', attr: [40, 28, 48, 21, 11, 27], armor: 62, reach: 2.4,
    weapon: 'shield', hoodie: 0x5a6470, text: 'Tank: heavy defence, a shield, and skills that pull monsters onto himself.' },
  rogue: { name: 'Rogue', base: 'fighter', attr: [41, 46, 36, 21, 12, 24], armor: 32, reach: 2.4,
    weapon: 'daggers', hoodie: 0x6a2a2a, text: 'Melee damage: fast twin daggers, frequent critical hits, a quick dash.' },
  archer: { name: 'Archer', base: 'fighter', attr: [39, 44, 34, 21, 13, 26], armor: 30, reach: 18, ranged: true,
    weapon: 'bow', hoodie: 0x6a6a2a, text: 'Ranged damage: shoots a bow from far away, weak when cornered.' },
  wizard: { name: 'Wizard', base: 'mystic', attr: [21, 21, 27, 46, 26, 41], armor: 22, reach: 2.4,
    weapon: 'staff', hoodie: 0x5a2f7a, text: 'Magic damage: fire, wide area spells, and putting monsters to sleep.' },
  cleric: { name: 'Cleric', base: 'mystic', attr: [24, 22, 33, 37, 22, 45], armor: 34, reach: 2.4,
    weapon: 'staff', hoodie: 0xcfc9ae, text: 'Support: heals and blesses everyone nearby, raises the fallen.' },
};
export const ATTR_NAMES = ['STR', 'DEX', 'CON', 'INT', 'WIT', 'MEN'];
// What each kind of weapon contributes: attack values, base attack speed, critical rate (per 1000) and extra defence.
export const WEAPONS = {
  sword:   { pAtk: 18, mAtk: 6,  spd: 300, crit: 20,  pDef: 0 },
  shield:  { pAtk: 17, mAtk: 6,  spd: 290, crit: 20,  pDef: 15 },
  daggers: { pAtk: 16, mAtk: 6,  spd: 400, crit: 120, pDef: 0 },
  bow:     { pAtk: 26, mAtk: 6,  spd: 160, crit: 60,  pDef: 0 },
  staff:   { pAtk: 9,  mAtk: 24, spd: 250, crit: 10,  pDef: 0 },
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

// Every combat stat of a character, derived from its class attributes, level, weapon upgrade level, passive skills
// and active buffs (`buffs` maps a stat name to a multiplier).
//   STR -> P.Atk      DEX -> Atk.Spd, Accuracy, Evasion, Critical, Speed      CON -> HP
//   INT -> M.Atk      WIT -> Casting Spd, M.Critical                         MEN -> M.Def, MP
export function statsOf(cls, level, learned = {}, weapon = 1, buffs = {}) {
  const c = CLASSES[cls], w = WEAPONS[c.weapon];
  const [STR, DEX, CON, INT, WIT, MEN] = c.attr;
  const passive = (stat) => {
    let v = 0;
    for (const id of skillsFor(cls)) {
      const s = SKILLS[id], rank = learned[id] | 0;
      if (s.kind === 'passive' && s.stat === stat && rank > 0) v += s.add[Math.min(rank, s.add.length) - 1];
    }
    return v;
  };
  const buff = (stat) => buffs[stat] || 1;
  const grade = 1 + 0.4 * (weapon - 1);          // the Blacksmith's upgrades
  const atkLevel = 1 + 0.1 * (level - 1), defLevel = 1 + 0.05 * (level - 1);
  const atkSpd = Math.round(w.spd * (1 + (DEX - 30) * 0.012));
  const castSpd = Math.round(333 * (1 + (WIT - 20) * 0.02));
  const speed = Math.round(100 + DEX * 0.6);
  return {
    STR, DEX, CON, INT, WIT, MEN,
    maxHp: Math.round((80 + 20 * (level - 1)) * (1 + (CON - 30) * 0.03)),
    maxMp: Math.round((40 + 9 * (level - 1)) * (1 + (MEN - 20) * 0.05) * (1 + passive('mp'))),
    pAtk: Math.round(w.pAtk * grade * atkLevel * (1 + (STR - 40) * 0.025) * (1 + passive('patk')) * buff('patk') * buff('atk')),
    mAtk: Math.round(w.mAtk * grade * atkLevel * (1 + (INT - 41) * 0.03) * (1 + passive('matk')) * buff('atk')),
    pDef: Math.round((c.armor + w.pDef) * defLevel * (1 + passive('pdef')) * buff('pdef')),
    mDef: Math.round(20 * defLevel * (1 + (MEN - 20) * 0.04)),
    acc: Math.round(level + DEX * 0.3 + 5),
    eva: Math.round(level + DEX * 0.3),
    crit: Math.round(DEX * 2 + w.crit + passive('crit') * 1000),   // per 1000, as the status window shows it
    mCrit: Math.round(WIT * 2),
    atkSpd, castSpd, speed,
    atkCd: 150 / atkSpd,          // seconds between auto-attacks
    castMult: 333 / castSpd,      // multiplier on the cast time of spells
    move: speed * 0.075,          // world units per second
  };
}

// Spells are sped up by Casting Spd; physical skills keep their own timing.
export const isSpell = (s) => ['bolt', 'heal', 'sleep', 'buff', 'revive'].includes(s.kind) || (s.kind === 'ground' && !s.phys);
export const castTime = (s, st) => (s.cast || 0) * (isSpell(s) ? st.castMult : 1);

// Damage after the target's defence, and the chance of a physical attack landing.
export const mitigate = (attack, defence) => attack * 100 / (100 + defence);
export const hitChance = (acc, eva) => Math.max(0.4, Math.min(0.98, 0.9 + (acc - eva) * 0.015));

// ---------------------------------------------------------------- progression

export const xpNext = (level) => 100 * level * level;
export const spFor = (xp) => Math.ceil(xp / 8);                  // skill points earned along with experience
export const DEATH_XP_LOSS = 0.04;                               // share of the current level's experience lost on death
export const upgradeCost = (weapon) => 40 * weapon;

// ---------------------------------------------------------------- world

// The world itself - regions, monster camps, chests, townsfolk, the start point - is data: map/world.json, read through
// src/map/format.js. Only how far a player can reach is a rule of the game.
export const SHOP_RANGE = 5.5;    // how close to the Blacksmith or the Sage a player has to stand to deal with them
export const CHEST_REACH = 1.9;   // how close to a chest a player has to come to open it
