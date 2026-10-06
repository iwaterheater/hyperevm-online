// The Chest tool: treasure chests - where they stand, which way they open, what they pay.
//
//   click on free ground          a new chest with the settings of the options strip (gold, big, respawn, facing)
//   press and drag on free ground a new chest that turns to face the pointer - one undo step
//   click a chest                 select it (Shift / Mod: add or take it)      double-click: that one chest alone
//   drag a chest                  move the selected chests                     Alt+drag: move a copy
//   Alt+click a chest             copy its settings into the strip
//   Q E                           turn the selection by 15 degrees (Shift 90, Alt 1); with nothing selected they turn
//                                 the chest that is about to be placed
//
// The gestures are the ones every marker tool has (markerTool in tools/spawn.js); this file says what a chest is.
import { LIMITS, groundAt, isBlocked, qAngle } from '../../map/format.js';
import { row, numberField, angleField, checkField, selectField } from '../ui/dom.js';
import { describe } from './common.js';
import { markerTool, templateState, templateControls, turnStep } from './spawn.js';

const DEG = Math.PI / 180;
const DEFAULTS = { gold: 12, big: false, respawn: 150, ry: 0 };
// What the baked world pays: the three roadside chests by distance from the town, and the King's hoard.
const PRESETS = [
  { id: 'small', label: 'Small (12 g)', template: { gold: 12, big: false, respawn: 150 } },
  { id: 'medium', label: 'Medium (40 g)', template: { gold: 40, big: false, respawn: 150 } },
  { id: 'rich', label: 'Rich (90 g)', template: { gold: 90, big: false, respawn: 150 } },
  { id: 'hoard', label: 'Hoard (400 g, big)', template: { gold: 400, big: true, respawn: 300 } },
];

const clamp = (v, [min, max]) => Math.max(min, Math.min(max, v));
const whole = (v, range, fallback) => (Number.isFinite(v) ? clamp(Math.round(v), range) : fallback);

// The settings of a chest without its place, every value legal.
function clean(t) {
  return {
    gold: whole(t?.gold, LIMITS.chestGold, DEFAULTS.gold),
    big: t?.big === true,
    respawn: whole(t?.respawn, LIMITS.chestRespawn, DEFAULTS.respawn),
    ry: Number.isFinite(t?.ry) ? qAngle(t.ry) : 0,
  };
}

export default function create(ctx) {
  const { store, ui, cmd } = ctx;
  const template = templateState(ctx, 'chest', { defaults: DEFAULTS, read: clean, clean });
  const { opts } = template;
  const text = (t) => `${t.big ? 'big chest' : 'chest'} · ${t.gold} g · opens again after ${t.respawn} s`;

  const tool = markerTool(ctx, {
    id: 'chest', label: 'Chest', icon: '▣', layer: 'chests', kind: 'chest', drag: 'facing',

    props: () => template.fresh(),

    canPlace(x, z) {
      const map = store.map;
      if (Math.hypot(x, z) > map.radius - LIMITS.chestMargin) return `Outside the island: a chest stays ${LIMITS.chestMargin} unit inside its edge`;
      if (isBlocked(map, x, z)) return `Nobody can reach a chest on ${groundAt(map, x, z).name.toLowerCase()}`;
      return null;
    },

    ghost: (props) => ({ chests: [props] }),
    adopt: (item) => template.adopt(item),
    placed(item) { if (item) ui.setStatus(`${item.big ? 'Big chest' : 'Chest'} added \u00b7 ${item.gold} g \u00b7 opens again after ${item.respawn} s`); },

    // nothing selected: Q and E turn the chest that is about to be placed
    idleKey(action, ev) {
      if (action !== 'rotate.ccw' && action !== 'rotate.cw') return false;
      template.set({ ry: opts.ry + (action === 'rotate.ccw' ? 1 : -1) * turnStep(ev) });
      return true;
    },

    hints: {
      get create() { return `Click: ${text(template.fresh())} · drag: turn it to face the pointer · Q E: turn`; },
      item: 'Click: select · drag: move · Shift+click: add · Alt+click: copy its settings · Alt+drag: move a copy',
      selected: 'Drag: move the selected chests · Q E: turn · Alt+drag: move a copy',
    },

    options(el, keep) {
      const presetOf = () => PRESETS.find((p) => p.template.gold === opts.gold && p.template.big === opts.big && p.template.respawn === opts.respawn)?.id ?? null;
      const preset = selectField({
        value: presetOf(),
        options: [{ value: null, label: 'Custom' }, ...PRESETS.map((p) => ({ value: p.id, label: p.label }))],
        onCommit: (id) => {
          const found = PRESETS.find((p) => p.id === id);
          if (found) template.set(found.template);
          else preset.set(presetOf());     // "Custom" is what the fields make it, not a choice
        },
      });
      const gold = numberField({ value: opts.gold, min: LIMITS.chestGold[0], max: LIMITS.chestGold[1], step: 1, onInput: (v) => template.set({ gold: v }) });
      const big = checkField({ value: opts.big, onCommit: (on) => template.set({ big: on }) });
      const respawn = numberField({ value: opts.respawn, min: LIMITS.chestRespawn[0], max: LIMITS.chestRespawn[1], step: 1, onInput: (v) => template.set({ respawn: v }) });
      const facing = angleField({ value: opts.ry, step: 15 * DEG, onInput: (v) => template.set({ ry: v }) });

      const controls = templateControls(ctx, 'chest', template, (items) => {
        const t = template.fresh();
        store.begin(`Apply chest settings to ${describe(ctx, items)}`);
        try {
          store.exec(cmd.set(items, { gold: t.gold, big: t.big, respawn: t.respawn, ry: t.ry }));
        } finally {
          store.commit();
        }
      });

      const sync = () => {
        preset.set(presetOf());
        gold.set(opts.gold);
        big.set(opts.big);
        respawn.set(opts.respawn);
        facing.set(opts.ry);
        tool.refreshGhost();
      };
      const goldRow = row('Gold', gold), bigRow = row('Big', big), respawnRow = row('Respawn (s)', respawn), facingRow = row('Facing', facing);
      goldRow.title = 'The base payout: the server pays 0.8 to 1.3 times this';
      bigRow.title = 'The golden chest model, larger';
      respawnRow.title = 'Seconds an opened chest stays open';
      facingRow.title = 'Which way the chest opens. Drag on the map to aim it; Q and E turn it';
      el.append(row('Chest', preset), goldRow, bigRow, respawnRow, facingRow, ...controls.nodes);
      sync();
      keep(template.on(sync));
      keep(controls.release);
    },
  });

  // beyond the tool contract: the settings of the next chest, for scripts
  return Object.assign(tool, { opts, presets: PRESETS, template: () => template.fresh(), setTemplate: (patch) => template.set(patch) });
}
