# Icons

The pictures of the action bar and of the inventory: 128 x 128 px RGBA PNG, full-bleed squares (the HUD rounds the
corners and draws the border and the colour of the tier itself).

- `skills/<skill id>.png` - one per skill of `src/shared.js`. An active skill is a small scene on a dark ground that
  glows in the colour of its school: orange and red for melee, amber and green for archery, mint for the arcane, ice
  blue for frost, orange for fire, gold and green for the holy, violet for the rogue's shadow, steel blue for defence.
  A passive skill ("... Mastery", Eagle Eye) is an emblem in a gold ring on a darker ground.
- `items/<key>.png` - one per kind of item, shared by its tiers: the weapon families `sword`, `greatsword`, `daggers`,
  `bow`, `staff`, the `shield`, the armour slots `head`, `body`, `hands`, `feet`, the potions `hp_small`, `hp_large`,
  `mp_small`, `mp_large`, and `attack` for the basic attack.

`src/icons.js` maps a skill id or an item id to its file (`skillIcon`, `itemIcon`) and lists the set (`ICON_FILES`);
`test/icons.test.mjs` checks that the list and this directory agree.

## How they are built

The whole set is made by one script and is never edited by hand:

    /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/build-icons.py

It renders every icon with EEVEE from the game's own art - the weapons, the armour and the cat's head of
`art/hypercat.blend` and the effect shapes of `art/fx.blend` (drawn unlit from their vertex colours, tinted, as the game
draws them) - together with a few props it models itself in the same style (the shield, the flasks, the eye, the drop
of mana, the arc of a slash, the gold ring; the dagger and the greatsword are the Sword reshaped), then paints the
ground, the shadow and the glow behind each render. The build is deterministic: the same script gives the same bytes.
It takes about half a minute, and neither `.blend` is changed. To change or add an icon,
edit its `icon(...)` line in the script and run it again; `--only <id>` builds a few, `--sheet <file>` pastes the set
into one contact sheet for review. The header of the script says the rest.

This is original art, made for HyperEVM Online from the project's own models. Nothing in it is taken from another game
or from an icon pack.
