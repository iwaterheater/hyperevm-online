# HyperEVM Online

A small open-world browser MMORPG starring a chibi cat in a hoodie, modelled on classic target-based MMORPGs.
Players share one seamless world, pick a class, hunt slimes, wolves, orcs, demons and skeletons together, level up, learn skills, choose a profession, and find, buy and wear weapons and armour.

- **Client:** [Three.js](https://threejs.org/) (no build step, loaded from a CDN)
- **Monsters:** animated skeleton models from the [KayKit Character Pack: Skeletons](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0) by Kay Lousberg (CC0); slimes, orcs, demons, ghosts and the other creatures from [Ultimate Monsters](https://quaternius.com/packs/ultimatemonsters.html) and [Cute Animated Monsters](https://quaternius.com/packs/cutemonsters.html) by Quaternius (CC0); the wolf, fox, bull, stag, alpaca, spider and raptor are Quaternius's animals (CC0) as the open-source [World of ClaudeCraft](https://github.com/levy-street/world-of-claudecraft) ships them
- **Scenery:** buildings, town walls, trees, rocks, hills and props from the [KayKit Medieval Hexagon Pack](https://github.com/KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0); graves, crypts, fences, dead trees and lanterns from [KayKit Halloween Bits](https://github.com/KayKit-Game-Assets/KayKit-Halloween-Bits-1.0); the King's fortress, ruins, chests and coins from [KayKit Dungeon Remastered](https://github.com/KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0); the meadow's trees, bushes, rocks and grass from the free part of the [KayKit Forest Nature Pack](https://kaylousberg.itch.io/kaykit-forest) — all by Kay Lousberg (CC0)
- **Townsfolk:** guards, blacksmith, sage and trader from the [KayKit Character Pack: Adventurers](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0) by Kay Lousberg (CC0)
- **Server:** Node.js + [`ws`](https://github.com/websockets/ws), authoritative for monsters, damage, XP, loot, items and gold

## Quick start

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Open <http://localhost:8765>, pick a name and enter the world.
Open the page in a second browser (or on another device in the same network, using your machine's IP) to see multiplayer in action.

Set a different port with the `PORT` environment variable:

```bash
PORT=3000 npm start
```

The page opens on a loading screen and keeps it until the world can be drawn without anything popping in. Its bar counts real things — the map, every model file the map uses, the cat, the monsters, the townsfolk, the effects — then the foliage is grown, the shaders are compiled and a few frames are drawn behind it, and only then does it fade into the menu. If nothing arrives for 20 seconds, or the map does not load, it says so and offers **Retry**. The picture, `assets/ui/loading.jpg`, is rendered from the game's own models with `blender --background art/hypercat.blend --python tools/build-keyart.py`; `/?loading=hold` keeps the screen up for a look at it (`/?loading=hold:40` freezes it at 40 %).

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` / arrows | Move, relative to the camera; the cat turns to face where it walks |
| Right mouse button (drag) | Turn the camera |
| Mouse wheel | Zoom |
| Left click on a monster or a cat | Select it as the target; a frame at the top shows its name, level and health |
| `Ctrl` + click on a cat | **Attack another player** - see [Fighting other cats](#fighting-other-cats). The Attack button under its name in the target frame does the same |
| `Tab` | Select the next nearest monster |
| `Esc` | Clear the target |
| `1`, clicking the target again, or right click on a monster | **Attack** — the cat runs up to its target and keeps hitting it with its weapon (auto-attack). The attack is the first slot of the [action bar](#action-bar) |
| `2` – `9`, `0` | The other slots of the [action bar](#action-bar): cast the skill, drink the potion or wear the gear in the slot. Skills cost mana and every one takes a moment - a spell is cast, a blow is wound up - and most have a cooldown; the cat stands still for that moment. A click on a slot does the same |
| `I` | Inventory: the character's numbers, the cat with its six equipment slots, and the bag. Click an item to wear or drink it, click a worn item to take it off, drag an item onto the action bar, right-click an item twice to destroy it; hover for its stats and what it would change. Drag the cat to turn it |
| `C` | Character status window: experience, skill points, gold, the weapon's enchantment, attributes and combat stats, with what the equipment adds |
| `K` | Skill book: everything the class can learn; a learned skill is dragged from it onto the action bar. Buying skills and choosing a profession only works next to the Sage in town |
| `M` | World map: the whole island with its relief, the zones and their level ranges, the boss lair, the monster camps tinted by how dangerous they are for this character, and the cats in sight. Hover a camp for its monsters. A click on the minimap opens it too |
| `O` | Settings: sound on or off and its volume; the resolution the world is rendered at (low, medium, high), shadows, the glow of lamps and spells, grass and flowers; Auto, which lowers those while the game runs slow; and the frame rate at the top edge. A change is at work at once and is remembered in the browser |
| `H` / `F1` | Help: every control |
| `X` | Sit down to rest — health and mana come back much faster; moving stands the cat up |
| `Space` | Jump (double jump) |
| `B` | Enchant the weapon in the paw (stand next to the Blacksmith in town; see [Enchanting](#enchanting)) |
| `T` | Trade (stand next to the Trader in town): buy potions and gear, sell anything from the bag |
| `Enter` | Open chat / send message |

The screen: in the top-left corner the cat's frame - its portrait in a laurel ring with the level on a badge, and beside it the name, the level and class, health and mana. In the top-right one the minimap in its gold ring - north is up, the arrow is the cat and points where it looks, a skull marks the boss lair, a house the town, and its `+` and `−` show less or more of the surroundings - under it the name of the place the cat is in and where it stands, and under that the row of window buttons. The chat is in the lower-left corner: the last lines, a line to write on (`Enter`, or a click on it) and two tabs - General shows everything, System only what the game itself said. The action bar lies at the lower edge, and in the lower-right corner is a pad for the mouse: the attack, the jump, the next target, and the dash once the cat knows one. **Experience** is the gold line under the ten slots of the action bar, with its numbers below it; it lights up when experience comes in. Everything else lives in the window it belongs to: gold in the inventory, the Trader's window and the status window; skill points in the skill book; the weapon's upgrade level in the status window and in the Blacksmith's line; how many cats are online at the foot of the Help window.

The windows also open from the buttons at the right edge: Character, Inventory, Skills and Map in the row under the minimap - and Shop while the Trader is in reach - Settings and Help under that. A button is lit while its window is open, and the Skills button wears a number while there are that many skills the unspent skill points can pay for. On a screen narrower than 1820 pixels one window is open at a time, in the middle between the chat and the minimap; a wider one shows the inventory beside the status window or the Trader's list.

The pictures of the HUD - the frame, the portrait, the ring of the minimap, its buttons and landmarks - are cut out of two painted sheets, `art/hud-atlas.png` and `art/minimap-atlas.png`, by `python3 tools/build-hud.py` into `assets/ui/hud/`.

### Action bar

Ten slots in the middle of the lower edge, on the keys `1` – `9` and `0`, with the experience bar under them from end to end. The first slot holds the **attack**: it can be dragged onto another slot, but not taken off the bar. Any other slot holds a skill or an item:

- **A skill** is cast by its key, exactly as a click on the slot does. The slot shows what it costs, its cooldown, and when the mana does not suffice.
- **A potion** is drunk; the slot shows how many the bag holds and the cooldown all potions share, and stays - greyed - when the last one is gone.
- **A piece of gear** is put on. Pressing the key again leaves it on (a second press in a fight must not strip the cat); it is taken off in the inventory. A worn piece is marked.

Drag a learned skill from the skill book (`K`) or an item from the inventory (`I`) onto a slot; drag one slot onto another to swap them; drag a slot off the bar, or right-click it, to clear it. A character without a bar of its own - a new one, or one saved before the bar existed - gets the attack on slot 1, its learned skills after it and its health and mana potions on `9` and `0`. A skill learned later goes into the first empty slot. The bar is saved with the character on the server.

## The world

One continuous map with no loading screens between its zones. The world is a data file, `map/world.json`: the terrain, every tree and wall, the zones, the monster camps, the chests, the townsfolk and the point where new cats appear. It is built and changed in the [map editor](#map-editor); nothing of it is generated when the game starts.

The map that ships with the game is a long island with the town in its middle. The zones are patches of it, not rings, and they get harder the further you go from the town:

| Zone | Where | Monster levels | Who lives there |
| --- | --- | --- | --- |
| Hypercat Town | The middle of the island | – | Walled safe zone: fast healing, townsfolk, the Blacksmith's enchanting, the Trader's shop |
| Green Meadows | Around the town | 1 – 4 | Slimes, Mushnubs, bunnies, chickens, pigs, pups, tabbies, pigeons, deer and stags, wolves and foxes, pandas, Armabees, a Stumpling and, rarely, the Mushroom King |
| Graveyard Wastes | Beyond the meadows, to the north and west | 5 – 9 | Skeletons, Ghosts, Skull Wraiths, Hopping Skulls, Cave Bats, Giant Spiders, ninjas, Hex Blobs and Glubs |
| Red Badlands | East | 6 – 10 | Cactoros, Prickles, orcs with their shamans and brutes, Sand Cyclopes, Crimson Dinos, Raptors, wolves, Wild Bulls with Alpacas, Alpakings, Sand Wyrmlings, Tribal Spirits |
| Drowned Marsh | West | 7 – 10 | Bog Frogs, Fishmen, Snappers, Red Crabs, Gremlins, Giant Spiders, Monkrooses, Golelings, Marsh Hornets, Spiky Slimes |
| Frostfang Peaks | The mountains of the north-west | 11 – 14 | Yetis, wolves, Snowballs, Frostlings, Penguins, Horned and Frost Birbs |
| Cursed Lands | The rim of the island | 10 – 15 | Elite skeletons, Imps, Red Fiends, Blue Demons, Void and Antenna Aliens, Cthulhu Spawn, Raptors, Hywirls, Squidles, Dragonlings and Fire Drakes |

The **Skeleton King** (level 18 boss) waits inside his walled fortress in the far north of the Cursed Lands. The minimap in the top-right corner always points to the town and to the boss lair.

A zone is a region of the map: a circle or a polygon with a name, a level range, a lighting mood (meadow, graveyard, cursed) and, for a town, the "safe" flag. Where regions overlap, the one listed last in the file wins. The banner, the radar rings, the light and the place where monsters refuse to follow all come from the regions, so a new map changes them without a line of code.

### Monsters

A monster is one of three kinds of fighter: it runs up and hits, it keeps its distance and shoots, or it is big, slow and hits hard. What a camp holds is written in the map, so any monster can be put anywhere in the [map editor](#map-editor); its strength comes from the level of the camp. How hard monsters are as a whole is one number, `MOB_POWER` in `src/shared.js`: every monster's health and blows are multiplied by it (now 2).

Not every monster is out for blood. A name written in **red** over a monster's head means it goes for any cat it notices; a name in **white** means it minds its own business until somebody hurts it, and then fights back. The calm ones are the slimes, the Mushnub and the Toadstool, the farm and forest animals (bunnies, chickens, pigs, pups, tabbies, pigeons, deer, stags, foxes, alpacas, bulls, pandas, penguins), the Red Crab, the Bog Frog, the Snowball, the Monkroose and the Stumpling.

| Type | Behaviour |
| --- | --- |
| Skeleton Minion | Shambles at you with a blade |
| Skeleton Rogue | Small, fast, fragile, dual-wields blades |
| Skeleton Mage | Keeps its distance, gathers a spell in a ring of fire and throws a fireball that follows its target - jump over it, dash through it or step aside at the last moment |
| Skeleton Warrior | Slow, tough, hits hard with an axe, drops extra gold |
| Skeleton King | Boss; fires rings of orbs, respawns after 90 seconds |
| Imp, Armabee, Skull Wraith, Wild Bunny, Wild Tabby, Angry Chicken, Shadow Ninja, Ninja Blob, Monkroose, Goleling, Glub, Sky Pigeon, Squidle, Chubby Chick, Young Deer, Red Fiend, Hopping Skull, Cave Bat, Marsh Hornet, Grey Wolf, Red Fox, Raptor | Fast and fragile: on you before you have turned round |
| Green Slime, Pink Slime, Mushnub, Bog Frog, Cactoro, Orc Raider, Orc Whelp, Cactus Bandit, Stray Pup, Plump Pigeon, Snapper, Fishman, Crimson Dino, Horned Birb, Frost Birb, Snowball, Alpaking, Hywirl, Three-Eyed Blob, Prickle, Red Crab, Sand Cyclops, Gremlin, Toadstool, Panda, Penguin, Pink Pig, Frostling, Forest Stag, Alpaca | Ordinary fighters that come up and hit |
| Tribal Shaman, Void Alien, Ghost, Dragonling, Void Sprout, Hex Blob, Glub Totem, Tribal Spirit, Alpaking Lord, Antenna Alien, Sheet Ghost, Cthulhu Spawn, Sand Wyrmling, Giant Spider | Keep their distance and shoot, like the Skeleton Mage |
| Orc Brute, Yeti, Blue Demon, Mushroom King, Fire Drake | Slow, tough, hit hard, drop extra gold; the Fire Drake shoots as well |
| Spiky Slime, Elder Mushnub, Armabee Queen, Goleling King, Stumpling, Wild Bull | Stronger kin of the small ones, with a little more gold |

Seventy-seven of them are Quaternius's models; the game loads only the ones the map uses.

### Classes

A character starts as a **Fighter** or a **Mystic** (chosen in the menu) and picks a profession from the Sage at level 20:

| Start | Profession | Role |
| --- | --- | --- |
| Fighter | Knight | Tank: shield, high defence, pulls monsters onto himself |
| Fighter | Rogue | Melee damage: fast twin daggers, critical hits, a dash |
| Fighter | Archer | Ranged damage with a bow |
| Mystic | Wizard | Magic damage: fire, area spells, sleep |
| Mystic | Cleric | Support: heals and blesses everyone nearby, raises the fallen |

Each class has its own hoodie colour and gear.

### Character stats

Press `C` for the character status window. Every class has six fixed base attributes, and all combat stats are derived from them, the level, the weapon's enchantment, passive skills, active buffs and the equipment — there are no points to assign. A value raised by a buff is shown in gold; the part of a value that comes from equipment stands beside it in green.

| Attribute | Raises |
| --- | --- |
| STR | P. Atk |
| DEX | Atk. Spd, Accuracy, Evasion, Critical, Speed |
| CON | HP |
| INT | M. Atk |
| WIT | Casting Spd, M. Critical |
| MEN | M. Def, MP |

- **P. Atk / M. Atk** against the target's **P. Def / M. Def**: damage is `attack × 100 / (100 + defence)`. Monsters have both defences too — warriors resist blades, mages resist spells.
- **Accuracy** against **Evasion** decides whether a physical attack lands; spells always land.
- **Critical** and **M. Critical** (per 1000) are the chances of a double-damage hit.
- **Atk. Spd** sets the auto-attack interval. It grows with the cat: a beginner attacks at three fifths of the speed its class has at level 40, and a weapon of a better tier adds a twentieth per tier. What speeds the attacks also shortens the wind-up of physical skills.
- **Casting Spd** shortens the cast time of spells, **Speed** is how fast the cat runs.

### Skills

- Every kill gives experience and **SP** (skill points).
- Skills are bought from the Sage with SP once the character's level is high enough, and can be upgraded through several ranks.
- Active skills go onto the [action bar](#action-bar); passive skills raise stats permanently.
- Monsters can be stunned, put to sleep, slowed and made to bleed; the Skeleton King ignores stuns and sleep.

### Items and equipment

Press `I` for the inventory: a bag of 30 slots and six equipment slots — weapon (the main hand), off hand, head, body, hands, feet. What a cat wears and carries is drawn on it, each piece in the colour of its tier, for everybody to see.

The window has three parts side by side:

- **The character's numbers**: health and mana, the six attributes and the combat stats of the status window (`C`), with what the equipment adds. While the cursor rests on a piece of gear in the bag, the rows it would change show the value before and after.
- **The paper doll**: the cat itself as the world shows it, alive and wearing what it wears; drag it to turn it. Head, body, hands and feet stand in a column on its left, the weapon and the off hand by its paws on the right. An empty slot shows the outline of what belongs in it; while the weapon takes both paws the off hand shows that weapon, dimmed and marked `2H`.
- **The bag**: a grid of six by five cells with the count of used slots above it and the gold below, and tabs that show all of it, only the gear or only the potions.

| Tier | Level | Armour (P. Def: head / body / hands / feet) | Shield (P. Def / M. Def) | Sword · Greatsword · Daggers · Bow (P. Atk) | Staff (M. Atk) | From |
| --- | --- | --- | --- | --- | --- | --- |
| Leather / Bronze | 1 | 2 / 5 / 2 / 2 | Wooden Buckler +4 / +1 | +4 · +6 · +3 · +5 | +5 | Trader, loot |
| Iron | 5 | 5 / 11 / 4 / 5 | Iron Shield +8 / +2 | +8 · +12 · +7 · +12 | +11 | Trader, loot |
| Steel | 10 | 8 / 18 / 7 / 8 | Steel Shield +13 / +4 | +14 · +21 · +12 · +20 | +18 | loot only |
| Hypurr | 15 | 12 / 27 / 10 / 12 | Hypurr Aegis +19 / +6 | +20 · +30 · +18 · +29 | +26 | loot only |

- **Armour** can be worn by any class. Besides P. Def, helmets give M. Def (3 / 6 / 10 / 15), gloves Accuracy (1 – 4) and boots Speed (2 – 8).
- **Weapons** come in five families — swords, greatswords, daggers (+10 – 40 Critical), bows and staves — and any class may wield any of them. The cat holds what is equipped, and how it fights follows the weapon, not the class: a bow shoots from afar in anyone's paws, everything else strikes up close. A bow is shot the way an archer does it: the cat turns side-on, holds the bow out at its target, takes an arrow from the quiver on its back, nocks it and pulls the string to its cheek while a gold bar fills, and the arrow flies when the draw is full. Walking away or losing the target lets the arrow down. With an empty weapon slot the cat fights with the basic weapon of its class, as before.
- **One hand or two.** A sword is one-handed; a greatsword, a bow, a staff and a pair of daggers (one in each paw) are two-handed. **Shields** go into the off hand of any class and give P. Def and a little M. Def. A two-handed weapon and a shield exclude each other: putting one on takes the other off into the bag (the tooltip and the numbers beside the doll show what that costs before you click), and when a sword and a shield would both have to come off for a two-handed weapon and the bag has no free place, nothing happens and the game says so. A cat with a shield and no weapon equipped fights with a plain sword if the weapon of its class would need both paws.
- **The Knight's shield.** Whoever becomes a Knight is handed a Wooden Buckler - onto the off paw when that is free, else into the bag - unless he owns a shield already. A Knight from before shields were items gets his the first time he enters the world. The defence his old built-in shield gave is part of his armour now, so no Knight lost anything.
- The bonus of an item is added to the base value of the class, so it grows with the level, and the weapon's enchantment, passive skills and buffs multiply a weapon item like the basic weapon. The tooltip of an item shows what wearing it would change in the numbers of the status window.
- **Potions** stack up to 99: Lesser Health Potion (80 HP), Health Potion (250 HP), Lesser Mana Potion (50 MP), Mana Potion (160 MP). They are drunk with a click in the bag or from a slot of the action bar - each kind of potion takes a slot of its own; all potions share a 6-second cooldown.
- **Loot** goes straight into the bag of whoever lands the killing blow, with a line in the chat. A minion leaves a piece of gear about one time in sixteen, a warrior one time in five, and the chance grows a little with the monster's level; the tier matches the level of the monster (now and then one tier lower). The Skeleton King leaves a Hypurr piece and three potions to everyone who wounded him. Chests sometimes hold a potion and seldom a piece of gear — the richer the chest, the better. Loot that does not fit into a full bag is lost.
- A new character starts with five Lesser Health Potions. Dying loses no items.

### Enchanting

A weapon is made stronger with a **Scroll: Enchant Weapon**, by the rules of Lineage II. The Trader sells the scroll
(150 gold); monsters leave one now and then, the King always, and chests may hold one.

- A scroll raises the weapon in the paw by one, up to **+30**. Every step adds 8% of the weapon's attack - the basic
  weapon of the class and the item together - so a +30 weapon hits 3.4 times as hard.
- The first three steps always succeed. Every step after +3 succeeds two times in three, and when it fails **the weapon
  breaks**: it is gone, with everything it had. The scroll is spent either way.
- Click a scroll in the bag - or its slot on the action bar - to open the enchant window: the weapon, what it would
  become, the odds. It stays open, a click a scroll.
- Beside the **Blacksmith**, `B` opens the same window with a second button: he does it with a steadier hand - ten
  points more chance - for a fee that grows with the weapon (`20 × (level of enchantment + 1)` gold). He needs the
  scroll too, and where a step cannot fail he has nothing to add.
- The enchantment belongs to the weapon: it stays with it in the bag, and goes with it to the Trader. A weapon made
  +7 or better, or lost at that height, is told to the whole world.
- A character from before enchanting keeps what it paid the Blacksmith for: every old upgrade is five steps on its weapon.

### The Trader

Stand next to the Trader in town and press `T`. He sells the four potions and all Leather and Iron gear - armour, shields and weapons (24 – 240 gold a piece; what a character cannot wear is listed last, with the reason), and buys anything from the bag for 30 % of its price. A worn item has to be taken off before it can be sold.

### Progression

- Killing monsters gives XP and SP to every player who damaged them. A level needs `100 × level²` experience.
- Levelling up raises health and mana and fully restores both.
- Mana is spent on skills and comes back slowly in the field, quickly while sitting, and fastest in town.
- Monsters drop gold coins, and now and then potions and gear (see [Items and equipment](#items-and-equipment)).
- Treasure chests stand beside the four roads and refill a few minutes after being opened; the further from town, the more gold and the better what else may lie in them. The King's hoard waits inside his fortress.
- Enchant your weapon with scrolls - see [Enchanting](#enchanting) - to raise P. Atk and M. Atk.
- Dying costs 4% of the current level's experience (never a level); you respawn in town.

### Fighting other cats

Cats may fight each other anywhere outside the safe places, by the rules of Lineage II. Nobody attacks by accident: a
peaceful cat is attacked with `Ctrl` + click, or with the Attack button of its target frame.

- **Purple name - flagged.** Attacking another cat flags the attacker for 30 seconds after its last blow. Anyone may
  fight a flagged cat; hitting back flags the defender too.
- **PvP.** Bringing down a flagged cat, or an outlaw, is a fight won: PvP +1. The loser keeps its experience.
- **PK.** Killing a cat that never fought back is murder: PK +1, and karma - 240 for the first one, 60 more for each
  after it.
- **Red name - outlaw.** A cat with karma may be attacked by anyone without that flagging the attacker, and it loses
  experience when another cat brings it down. In a safe place it is as safe as anyone, and the Trader serves it.
- **Karma** is worked off by killing monsters (`8 + 2 × the monster's level` each), and 120 of it goes with every death.
- Area skills never start a fight: among cats they reach only flagged ones and outlaws. Stuns, sleep, slows and
  bleeding work on cats as they do on monsters; a cat's attack does three quarters of its damage to another cat.

The counts are in the Character window (`C`) and under the name in the Inventory (`I`); the colour of a name is seen by
everyone, on the cat, in its target frame and on the minimap.

## Map editor

The editor is a second page of the same server. Start the server in editor mode and open it:

```bash
npm run dev          # the same as: node server.js --editor
```

Open <http://localhost:8765/editor.html>. The game runs beside it on <http://localhost:8765> as usual.
Without editor mode the page still opens, read-only: everything works except Save and Play, and Export still downloads the map.

The window is a 3D view of the island with the model palette on the left, panels on the right, the tools and their options above and a status bar below. The status bar always says what a click and a drag do with the tool in hand (its tooltip has the whole line when the window is narrow), and for a moment what has just happened. `?` (or `F1`) shows every key; keys are written as your keyboard has them (⌥ ⇧ ⌘ on a Mac, Alt, Shift, Ctrl elsewhere).

### Tools

| Tool | Key | What it does |
| --- | --- | --- |
| Select | `V` | Click, Shift-click or drag a box to select anything; drag the selection or the gizmo to move, turn, scale and lift it; a click on a member of a group takes the whole group, a double-click the one member. A click on a gizmo handle that is not dragged goes to what lies under the handle |
| Place | `P` | Puts the model chosen in the palette under the cursor: one at a time, as a line (walls, fences: click the corners, `Enter` finishes) or as a ring (drag from the centre). Alt-click picks the model of an object on the map |
| Scatter | `B` | A brush that scatters the models selected in the palette (⌘/Ctrl-click adds one, Shift-click a whole range of tiles) at a chosen density, only on the chosen ground types; a second stroke over the same spot adds nothing. Alt erases |
| Terrain | `T` | Paints ground types with a soft or hard brush, lays roads along clicked points (optionally clearing the scenery in the way) and flood-fills an area or the selected region. Water and lava block walking |
| Sculpt | `Y` | Shapes the hills. **Raise** and **Lower**: hold the button and the ground under the brush goes up (down) for as long as you hold it, also while the pointer rests; `Alt` does the opposite, `Shift` smooths. **Smooth** evens the ground out, **Flatten** levels it to the height it had where the stroke began, **Set height** to a typed height (a plateau, a pit; Alt-click takes the height under the cursor), **Ramp** lays a straight slope between the press and the release, as wide as the brush - a road up a hill. Options: radius, strength, a soft or hard edge, and "Max slope", which keeps a stroke from making a wall (Off allows cliffs). `[` `]` change the radius, `Shift`+`[` `]` the strength, `1`-`6` the mode; one press-drag-release is one undo step and `Esc` takes it back. Heights run from -1 to 60 |
| Spawn | `M` | Monster camps: click for a camp with the settings of the options strip, or drag from its centre to its radius; drag the rim to resize. The dashed ring shows from how far away the camp's monsters notice a player |
| Chest | `C` | Treasure chests: gold, the big golden kind, the time until one refills. A click on a chest - its pin or the chest itself - selects it |
| NPC | `U` | Blacksmith, Sage, Trader and guards |
| Start point | | Where new and fallen cats appear, and how wide that spot is |
| Region | `Z` | Zones as circles or polygons; the points of a polygon can be dragged, added and removed |
| Measure | `L` | Distances and areas; changes nothing |

### Panels

- **Palette** – every model of the asset packs with a rendered thumbnail, search, favourites and recent ones. The **Stamps** tab keeps selections you saved under a name (a house with its fence, a camp with its tents) to place again; stamps can be exported and imported as a file.
- **Inspector** – the fields of the selection: position, rotation, scale, model, collider, group; a camp's monster mix, levels, count and respawn time; a chest's gold; a region's name, levels, mood and colour. Several items of one kind are edited together, and a number field takes `+5`, `*1.2` and the like. With nothing selected it shows the map's name and radius.
- **Arrange** – align, distribute, face a point, randomise rotation and scale, drop to the ground, repeat as an array.
- **Layers** – show, hide and lock each kind of thing; under it your own layers (below), every model in use (hide it, select all of it, replace it by another) and every group.
- **Regions** – the zones in the order they win, with their settings; drag a row to change the order. "From spawns" sets a zone's level range from its camps.
- **Spawns** – a table of every camp with totals per zone, editing of several camps at once, and "Populate" to fill a zone with camps. Click a value to edit it in a small card beside the row; while the card is open the rows keep their places, whatever column the table is sorted by.
- **Issues** – what is wrong with the map. An error (a camp inside the town, too many NPCs) blocks saving; a warning (a chest inside a wall, a camp nobody can walk to, objects left standing in water after a pond was painted, no Sage on the map) does not. A click on a row selects what it is about - one item, both boss camps, every object in the water - and goes there.
- **Minimap** – the island from above; click to move the camera, four camera bookmarks. It stays in view at the foot of the right column while the panels above it scroll; fold it to one line when you need the room.

**Your own layers.** Under the eight fixed layers the Layers panel has **My layers**: parts of the map you name yourself - "Town", "Forest", "Bandit camp". **+ Add layer** asks for a name (Enter adds it, Esc cancels) and makes the new layer the active one: every object, camp, chest and NPC you place from then on is put onto it, whatever tool places it. Click a layer to make it active, click it again to place onto no layer; the status bar names the active layer. A layer's eye hides everything on it and its lock keeps it from being picked, moved or deleted, exactly like the fixed layers - hidden scenery still blocks the way, as it does in the game. A double-click on a name (or `F2` for the active layer) renames it, dragging a row reorders the list, and the `⋯` of a row has the rest: **Move selection here**, **Select items**, **Rename** and **Delete** - deleting a layer that holds something asks whether its items stay on the map (on no layer) or go with it. The Inspector has a **Layer** choice for whatever is selected, also for a selection of several kinds; copies, pasted items and arrays stay on the layer of their source. Layers are saved in the map file (`layers`, and `l` on an item) and travel with Export and Import; which of them are hidden, locked and active is remembered by your browser. The game ignores them. Regions and the start point are on no layer.

**Hills.** The ground has a height at every vertex of its grid, and everything follows it. Objects, chests, camps and NPCs stand on the ground under them - an object's `Y` in the Inspector is its height ABOVE that ground, so sculpting under a village lifts the village. The cursor points at the hill it is over (the status bar shows the height there as `h`), the brush ring, the grid, the camp discs and the region outlines lie on the slopes, the minimap shades the relief, and Issues warns when a chest, an NPC, the centre of a camp or the start point stands on a slope steeper than 45 degrees. A flat map is saved as before: the file gains a `heights` block only once there is a hill.

The toolbar also switches overlays (grid, colliders, the threat rings of all camps, a tint that shows which region wins where) and the preview: neutral light, the game's own look (the light of the region under the camera, fog, shadows, no markers), or one of the region moods.

### Keys worth knowing

| Input | Action |
| --- | --- |
| Right mouse button (drag) / wheel | Orbit / zoom towards the cursor |
| `W` `A` `S` `D`, or Space + drag | Move the camera |
| `F` / `H` / `O` | Frame the selection / go to the start point / look straight down |
| `Q` `E`, `[` `]`, arrows | Turn, scale, nudge the selection (or the model about to be placed). With a brush (Terrain, Sculpt, Scatter) `[` `]` change its radius |
| `G` | Snapping on and off (holding ⌘/Ctrl while dragging inverts it) |
| ⌘/Ctrl + `Z`, `Shift`+`Z` | Undo, redo – a drag, a brush stroke, a paste or a typed value is one step each |
| ⌘/Ctrl + `C` `X` `V` `D` | Copy, cut, paste (the copy hangs on the cursor until you click), duplicate |
| ⌘/Ctrl + `G`, `Shift`+`G` | Group, ungroup |
| ⌘/Ctrl + `A` | Select everything the tool in hand can pick. With Select that is everything except the regions (a zone is picked by its outline, or all of them with the Region tool) |
| `Delete` | Delete the selection. While a polygon is being clicked it takes back the last point instead; in Place > Line, Terrain > Road and Measure it always does - a press too many never deletes what is selected |
| ⌘/Ctrl + `S` | Save |
| ⌘/Ctrl + `Enter` | Play |
| `Esc` | Cancel what is in progress, then back to Select, then clear the selection |

### Saving, backups and drafts

- **Save** writes the map to the server's map file and the running game takes it over at once: every open game tab reloads itself and its cat comes back to the spot it stood on. Monsters start over only when camps, safe regions or the radius changed, so repainting a meadow does not reset a fight.
- A map with errors is not saved; the Issues panel lists them. If the map on the server changed since the editor loaded it, the editor asks whether to overwrite it or to load the server's version.
- Before every save that changes the map, the server copies the old file into a `backups` folder next to it (`map/backups/`, git-ignored): `session-…` for the first save since the server started, `world-…` for the rest. It keeps the 20 newest, the first of each of the last 14 days, and the one the session started from. Backups are plain map files: to go back, stop the server, copy one over `map/world.json` and start again – or use **Import** in the editor.
- **Drafts.** Three seconds after the last change the unsaved map is kept in the browser's storage, also when it has errors and cannot be saved. The next time the editor opens it offers to restore the draft. A save removes the draft of the changes it saved. A draft that was offered and not answered (`Esc`) is never thrown away for you: it stays in storage through saves, reverts and reloads, a **Draft 14:02?** button in the menu bar asks again at any time, and the editor asks once more by itself when you have new unsaved changes - until you answer, those are not kept as a draft. Only **Restore** or **Discard** ends it.
- Saving twice within a second is fine: the server takes one changing save a second, and the editor waits that second out instead of reporting an error.
- **Export** downloads the map as a `.json` file exactly as Save would write it; **Import** loads such a file as unsaved work; **Revert** loads the server's map again; **New** starts an empty island. None of them touches the server's map until you save.
- **Maps** is the map library: named copies of a map kept on the server in `map/library/`, to go back to an earlier version or to compare two. **Keep a copy…** stores the map in the editor under a name. A click on an entry opens it in the editor – the game keeps running its own map, marked **live** in the list, until you press Save, which makes the opened one the live map. Switching from one library map to another asks nothing as long as you have not edited the one that is open. To put the first one back, open the copy you kept of it and save again. A map file dropped into `map/library/` shows up in the list; to remove an entry, delete its file.
- The map that ships with the game lives in git as `map/world.json`: to change it for everybody, save it in the editor and commit the file.

### Play-testing

**Play** saves unsaved changes and opens the game in a second tab with a test character – any class, level 1 to 40, optionally invulnerable and twice as fast – that is never written to the player saves. **From camera** starts it at the point the editor's camera looks at. The play tab is reused: later saves reload it in place. In the game, a small bar in the lower right corner shows the cat's coordinates and region, and **Edit here** brings the editor (the same tab, with its undo history) to that spot. The browser must allow pop-ups for the site.

### Who may save

In editor mode without a token the server accepts a save only from the machine it runs on: the request must come over the loopback interface, name `localhost`, `127.0.0.1` or `[::1]` as its host, carry no proxy header and come from the editor page itself.

> **Never run the tokenless editor mode behind a reverse proxy, a tunnel, Docker or WSL port forwarding.** There every visitor's request reaches the server from a local address, and anybody could overwrite the map. Set `EDITOR_TOKEN` instead: the editor then asks for the token before it saves.

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"    # a token
EDITOR_TOKEN=<token> npm run dev
```

| Setting | Meaning |
| --- | --- |
| `--editor` or `MAP_EDITOR=1` | Editor mode: the server accepts saves and play-test characters. With `NODE_ENV=production` it is ignored unless `EDITOR_TOKEN` is set |
| `EDITOR_TOKEN` | 24 to 256 characters. Whoever knows it may save, from anywhere. It does not switch editor mode on by itself |
| `MAP_FILE` | The map file to serve and to save (default `map/world.json`); its backups go into `backups/` beside it and its library is `library/` beside it |
| `DATA_DIR` | Where player progress is kept (default `data`) |

To try things without touching the real map or the real players: `MAP_FILE=/tmp/world.json DATA_DIR=/tmp/data PORT=3000 npm run dev` on a copy of the map.

## Project structure

```
index.html        Page, HUD and styles
editor.html       The map editor page
server.js         HTTP static server + WebSocket game server; loads the map and, in editor mode, saves it
bots/             The bots: run.mjs (the roster, the runner), bot.mjs (what a bot does), nav.mjs (where it can walk)
map/world.json    The world: terrain, scenery, regions, monster camps, chests, townsfolk, start point
map/backups/      The map before each save (created by the server, git-ignored)
map/library/      The map library: named copies of the map, listed in the editor's Maps menu
src/main.js       Client: rendering, input, networking, HUD
src/cat.js        The cat: a Blender model of rigid parts (assets/cat/hypercat.glb), animated in code; weapons, armour and the shield, tinted by tier
art/              The Blender sources: the cat, its weapons and its armour (hypercat.blend), the skill effects (fx.blend)
src/fx.js         What skills look like: Blender-made shapes (assets/fx/fx.glb) - bolts, ground circles, glyphs, flames, light - animated in code
src/skeleton.js   Skeleton monsters: loads the KayKit models and drives their animations
assets/skeletons/ KayKit skeleton models, weapons and their CC0 license
src/monster.js    The other monsters: loads the Quaternius models a map uses and drives their animations
assets/monsters/  Quaternius monsters and animals, one file a monster, with their CC0 license
assets/forest/    KayKit forest trees, bushes, rocks and grass, with their CC0 license
assets/medieval/  KayKit buildings, walls, trees, rocks and props, with their CC0 license
assets/halloween/ KayKit graveyard models, with their CC0 license
assets/dungeon/   KayKit fortress walls, pillars, chests and coins, with their CC0 license
assets/adventurers/ KayKit adventurer characters used as townsfolk, with their CC0 license
src/npc.js        Townsfolk: the models and animations of the guards, blacksmith, sage and trader the map places
src/world.js      The visible world: draws the map and follows the lighting mood of the region the player is in
src/map/format.js   The map format: schema, limits, loading, validation, regions and ground queries (server, game, editor)
src/map/catalog.js  The model catalog: asset packs, what each model blocks, what glows
src/map/view.js     Draws a map: terrain, sea, instanced scenery, foliage; answers collisions
src/map/lighting.js The light rig and the region moods
src/map/builtin.js  The models that are code: fountain, lamp posts, bushes, crystals, spikes, the lair ring
src/postfx.js     Bloom and tone mapping of the finished frame
src/editor/       The map editor: the map store with undo, viewport, markers, tools/, panels/, css/
src/geo.js        Helpers for building vertex-coloured low-poly geometry
src/shared.js     Constants, tables (monsters, classes, skills, items) and formulas used by both client and server
tools/bake-map.mjs      Wrote the first map/world.json from the old world generator; refuses to overwrite an edited map without --force
tools/check-imports.mjs Checks every import and page reference of this bundler-less project (npm run check)
tools/build-fx.py       Builds the skill-effect shapes in art/fx.blend and exports assets/fx/fx.glb; run inside Blender
tools/import-monsters.mjs  Brings the Quaternius monsters and animals into assets/monsters/, keeping the five animations the game plays
test/             Tests of the map format, the items, the action bar, the server and the editor's logic (npm test)
data/             Saved player progress (created at runtime, git-ignored)
```

## How it works

- The server simulates the world at 20 ticks per second and sends each player a snapshot of everything nearby. The client draws other cats and monsters walking in a straight line from one snapshot to the next, a twentieth of a second behind the server.
- With Auto on in the settings, the game watches its own frame rate: when it cannot hold 40 frames a second it takes the graphics down a step - a lower resolution, then no shadows, no glow, the lowest resolution, no grass - and gives a step back when it has run at the screen's rate for a while. It never raises anything above what the player has set.
- Monsters, projectile hits, damage, XP, gold, loot, chests, items and upgrades are decided by the server.
- Items are one table, `ITEMS` in `src/shared.js`, used by the server, the client and the tests alike; `statsOf()` in the same file turns class, level, skills, buffs and equipment into combat stats, so the server's damage and the client's status window always agree.
- Every item request — wear, take off, drink, buy, sell, destroy — names the stack by its place in the bag and by its item, and the server checks all of it: the stack is there, the level fits, the paws are free or what holds them fits into the bag (`wearItem()` in `src/shared.js` is the whole rule of one- and two-handed gear), the Trader is in reach, the gold and the room in the bag suffice, the cat is alive. A request that cannot be done is answered with a line the player sees; nothing changes on the client until the server says so.
- The owner of a bag receives it, and what it wears, only when they change. Other players get one number per cat — which pieces it wears and carries, of which tier, and what kind of weapon it holds — and nothing of anybody's bag.
- The action bar is ten slots, each empty or the id of an active skill or of an item. The client sends a new arrangement whole (`{ t: 'bar', bar: [...] }`); the server keeps what `cleanBar()` in `src/shared.js` makes of it - anything that is not an active skill or an item becomes an empty slot - and sends the kept bar back to its owner, as it does when it slots a newly learned skill.
- Player movement is simulated on the client for responsiveness; the server sanity-checks the speed and snaps cheaters back.
- The world is one file. The server reads `map/world.json` when it starts and refuses to run with a map that does not validate; the client fetches the same map from `/api/map` and draws it. Scenery is drawn as instanced batches, one per model, so thousands of trees and walls stay cheap to draw.
- From the map the server takes where monsters live (camps: a disc, a count, a mix of monster types, a level range, a respawn time), where chests and townsfolk stand, where new cats appear and which regions are safe. Monsters never appear on water or lava, or inside a safe region.
- Trees, rocks, buildings and blocked ground (water, lava) stop the local player only: the server does not load models, so monsters and projectiles pass through scenery.
- When the map is saved in the editor, the server swaps the world in place and tells every client; each one reloads the page and rejoins where it stood.
- Melee monsters telegraph their attacks: they stop, raise the weapon and the hit lands 0.4 seconds later, so it can be dodged.
- Combat is target-based, as in classic MMORPGs: the server checks that the selected monster is alive and within reach before a swing or a bolt lands.
- Projectiles are drawn locally from "shot" events, so they look smooth regardless of the tick rate.
- A character saved before the game had items loads with an empty bag; whatever a save holds that is not a known item is left out when it is read. One saved before the action bar gets the default bar, one saved before the off hand loads with that paw empty - and a Knight among them is handed his shield.
- Progress (class, level, XP, SP, skills, gold, bag, equipment with the weapon's enchantment, and action bar) is saved to `data/players.json`, keyed by a random token stored in the browser's `localStorage`. There are no accounts or passwords: clearing browser data loses the character.

## Playing with friends over the internet

The server is a single Node.js process, so any host that can run Node and accept WebSocket connections works (a VPS, Railway, Render, Fly.io, …). Start it with `npm start` and point players at its address. Behind HTTPS the client automatically switches to `wss://`.

## Bots

Ten cats that play on their own, so that the world is never empty:

```bash
npm run bots                                  # ten bots on http://localhost:8765
npm run bots -- --url http://localhost:3000 --count 4 --verbose
```

A bot is a player like any other: it joins through the game's WebSocket and plays by the same rules, and the server
saves it with its level and gear, so it comes back as it left. It hunts the camp that fits
its level, rests, drinks potions, and goes back to town to sell its loot, buy gear and potions, learn skills from the
Sage; a scroll it finds goes onto its weapon while nothing can go wrong. It walks around water, cliffs and scenery, takes a moment to react, says a line in
the chat now and then, and takes a break of a few minutes every half hour or so (`--no-breaks` keeps them all in).

The roster is in `bots/run.mjs`: a name, a class, the level the bot starts at and the one it stops growing at - three of
the ten stay beginners for good, and none outgrows its start by more than a few levels - and a role, how it treats
other cats:

| Role | Towards other cats |
| --- | --- |
| `farmer` | Peaceful; fights back when attacked, to the end - and, small as it is, mostly loses |
| `veteran` | Peaceful, and quick to fight back |
| `guard` | Hunts outlaws, and nobody else |
| `duelist` | Challenges cats of about its level, and lets go of one that will not fight; hunts outlaws |
| `pk` | Attacks cats from four levels below its own to two above, and kills them: a murderer with a red name, until it has worked its karma off |

A cat a bot has brought down is left alone by that bot for some minutes. Among themselves the bots fight seldom.

The bots have to run on the machine the server runs on: the first time one joins, the server makes it the character of
its roster line - the level, the skills and gear of that level - which only a program on the same machine may ask for.
The bots say nothing about being bots, and nothing about being people.

## Limitations

- One server process holds the whole world; there is no sharding or horizontal scaling.
- No accounts and no parties. Items cannot be traded between players or dropped on the ground, and loot belongs to whoever lands the last blow (the King's to everyone who wounded him).
- Every piece of armour is one model in four tints, and all tiers of a weapon share one model; a greatsword is the sword drawn larger, and the shield is one shape built in code. Only shields go into the off hand: there is no second weapon for it, and a two-handed weapon attacks as fast as any other.
- The HUD is laid out for a window at least 1280 pixels wide and 720 high; in a smaller one the windows reach over the chat and the radar.
- Clerics can only heal and bless players standing near them; there is no targeting of other players yet.
- The cat and a handful of built-in models (the fountain, lamp posts, bushes, crystals, spikes, the ring of the King's lair) are built from code; everything else is imported models placed by the map.
- The ground is flat: a grid of ground types two units wide, with no heights. Hills are models.
- One server runs one map. Two people can edit it, but not together: whoever saves second is asked to overwrite or to reload.
- The editor draws monsters, townsfolk and the start point as markers, not as their animated models; how a camp plays is seen in a play-test.
- Backups are files on the server's disk; the editor cannot list or restore them.
- The cat model is built from code to match the reference artwork, not sculpted or scanned.
