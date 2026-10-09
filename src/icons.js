import { SKILL_KEYS, itemOf } from './shared.js';

// The icons of the action bar and of the inventory: one 128 px picture per skill and per kind of item, rendered from
// the game's own models by tools/build-icons.py (see assets/icons/README.md). Every tier of an armour slot or of a
// weapon family shares one picture; whoever draws the slot adds the colour of the tier.

const BASE = './assets/icons';
// the pictures of assets/icons/items: weapon families, armour slots, potions, the enchant scroll, and the basic attack
const ITEM_ICONS = ['sword', 'greatsword', 'daggers', 'bow', 'staff', 'shield', 'head', 'body', 'hands', 'feet', 'hp_small', 'hp_large', 'mp_small', 'mp_large', 'scroll', 'attack'];
const SKILLS_WITH_ICON = new Set(SKILL_KEYS), ITEMS_WITH_ICON = new Set(ITEM_ICONS);

// The picture of a skill; undefined for what is not a skill.
export const skillIcon = (id) => (SKILLS_WITH_ICON.has(id) ? `${BASE}/skills/${id}.png` : undefined);

// The picture of an item: of its family if it is a weapon, of its slot if it is armour, its own if it is a potion.
// A name of a picture ("attack", "greatsword") is taken as it is. Undefined for anything else.
export function itemIcon(id) {
  const it = itemOf(id);
  // the last guess reads the id itself: gear is named "<tier>_<family or slot>"
  const key = [id, it?.family, it?.slot, it?.kind, it && id.slice(id.indexOf('_') + 1)].find((k) => ITEMS_WITH_ICON.has(k));
  return key ? `${BASE}/items/${key}.png` : undefined;
}

export const ATTACK_ICON = itemIcon('attack');

// Every file of the set, as a path from the root of the project.
export const ICON_FILES = [
  ...SKILL_KEYS.map((id) => `assets/icons/skills/${id}.png`),
  ...ITEM_ICONS.map((key) => `assets/icons/items/${key}.png`),
];
