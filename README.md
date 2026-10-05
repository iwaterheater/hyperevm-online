# HyperCat Online

A small open-world browser MMORPG starring a chibi cat in a green hoodie.
Players share one seamless world, hunt skeletons together, level up, collect gold and upgrade their weapon.

- **Client:** [Three.js](https://threejs.org/) (no build step, loaded from a CDN)
- **Monsters:** animated skeleton models from the [KayKit Character Pack: Skeletons](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0) by Kay Lousberg (CC0)
- **Scenery:** buildings, town walls, trees, rocks, hills and props from the [KayKit Medieval Hexagon Pack](https://github.com/KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0); graves, crypts, fences, dead trees and lanterns from [KayKit Halloween Bits](https://github.com/KayKit-Game-Assets/KayKit-Halloween-Bits-1.0) — both by Kay Lousberg (CC0)
- **Townsfolk:** guards, blacksmith, sage and trader from the [KayKit Character Pack: Adventurers](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0) by Kay Lousberg (CC0)
- **Server:** Node.js + [`ws`](https://github.com/websockets/ws), authoritative for monsters, damage, XP and loot

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

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` / arrows | Move |
| Mouse | Aim |
| Left mouse button (hold) | **Sword** — basic attack; hits every monster in a short cone in front of the cat, can be used on the move. Swings cycle through three animations: left-to-right, right-to-left and an overhead chop |
| `1` (hold) | **Bolt** — a single projectile at the cursor; 0.65 s cast |
| `2` | **Starfall** — a falling star that blasts an area at the cursor (range 16, radius 4.5); 0.9 s cast, 6 s cooldown |
| | The cat stands still while casting a skill; dashing cancels the cast |
| `Space` | Jump (double jump) |
| `Shift` | Dash — brief invulnerability, damages enemies you pass through |
| `Q` / `E` / right mouse button | Hyper wave (needs full hyper energy) |
| `B` | Buy a weapon upgrade (stand next to the Blacksmith in town) |
| `Enter` | Open chat / send message |
| `M` | Mute sound |

## The world

One continuous map with no loading screens. Zones get harder the further you go from the town:

| Zone | Distance from centre | Monster levels |
| --- | --- | --- |
| Hypercat Town | 0 – 24 | Walled safe zone: fast healing, townsfolk, the Blacksmith's weapon shop |
| Green Meadows | 24 – 95 | 1 – 4 |
| Graveyard Wastes | 95 – 175 | 5 – 9 |
| Cursed Lands | 175 – 260 | 10 – 15 |

The **Skeleton King** (level 18 boss) waits inside a ring of pillars in the far north of the Cursed Lands. The radar in the top-right corner always points to the town and to the boss lair.

### Monsters

| Type | Behaviour |
| --- | --- |
| Skeleton Minion | Shambles at you with a blade |
| Skeleton Rogue | Small, fast, fragile, dual-wields blades |
| Skeleton Mage | Keeps its distance and fires orbs from its staff |
| Skeleton Warrior | Slow, tough, hits hard with an axe, drops extra gold |
| Skeleton King | Boss; fires rings of orbs, respawns after 90 seconds |

### Progression

- Killing monsters gives XP to every player who damaged them.
- Levelling up raises max health and damage and fully heals you.
- Monsters drop gold gems; gems also charge hyper energy.
- Spend gold at the Blacksmith in town (`B`) to upgrade your weapon.
- Dying costs 10% of your gold; you respawn in town.

## Project structure

```
index.html        Page, HUD and styles
server.js         HTTP static server + WebSocket game server
src/main.js       Client: rendering, input, networking, HUD
src/cat.js        Procedural 3D cat model and its animations
src/skeleton.js   Skeleton monsters: loads the KayKit models and drives their animations
assets/skeletons/ KayKit skeleton models, weapons and their CC0 license
assets/medieval/  KayKit buildings, walls, trees, rocks and props, with their CC0 license
assets/halloween/ KayKit graveyard models, with their CC0 license
assets/adventurers/ KayKit adventurer characters used as townsfolk, with their CC0 license
src/npc.js        Townsfolk: guards at the gates, blacksmith, sage, trader
src/world.js      Terrain, town, scenery, lighting and obstacle collision
src/geo.js        Helpers for building vertex-coloured low-poly geometry
src/shared.js     Constants and formulas used by both client and server
data/             Saved player progress (created at runtime, git-ignored)
```

## How it works

- The server simulates the world at 15 ticks per second and sends each player a snapshot of everything nearby.
- Monsters, projectile hits, damage, XP, gold and upgrades are decided by the server.
- Player movement is simulated on the client for responsiveness; the server sanity-checks the speed and snaps cheaters back.
- Trees, rocks and buildings block the local player only: the server does not know about scenery, so monsters and projectiles pass through it.
- Melee monsters telegraph their attacks: they stop, raise the weapon and the hit lands 0.4 seconds later, so it can be dodged.
- Projectiles are drawn locally from "shot" events, so they look smooth regardless of the tick rate.
- Progress (level, XP, gold, weapon) is saved to `data/players.json`, keyed by a random token stored in the browser's `localStorage`. There are no accounts or passwords: clearing browser data loses the character.

## Playing with friends over the internet

The server is a single Node.js process, so any host that can run Node and accept WebSocket connections works (a VPS, Railway, Render, Fly.io, …). Start it with `npm start` and point players at its address. Behind HTTPS the client automatically switches to `wss://`.

## Limitations

- One server process holds the whole world; there is no sharding or horizontal scaling.
- No accounts, no PvP, no inventory beyond gold and a weapon level.
- The cat, the terrain and the cursed-land scenery are built from code; skeletons, buildings, trees, rocks and the graveyard are imported models.
- The cat model is built from code to match the reference artwork, not sculpted or scanned.
