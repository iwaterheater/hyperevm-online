// The NPC tool: the townsfolk - blacksmiths, sages, traders and guards - where they stand and which way they look.
//
//   click on free ground          a new NPC of the kind chosen in the options strip
//   press and drag on free ground a new NPC that turns to face the pointer - one undo step
//   click an NPC                  select it (Shift / Mod: add or take it)      double-click: that one NPC alone
//   drag an NPC                   move the selection                           Alt+drag: move a copy
//   Alt+click an NPC              copy its kind and facing into the strip
//   Q E                           turn the selection by 15 degrees (Shift 90, Alt 1); with nothing selected they turn
//                                 the NPC that is about to be placed
//
// The gestures are the ones every marker tool has (markerTool in tools/spawn.js); this file says what an NPC is.
import { LIMITS, NPC_KINDS, groundAt, isBlocked, isSafe, qAngle } from '../../map/format.js';
import { h, row, button, angleField } from '../ui/dom.js';
import { describe } from './common.js';
import { markerTool, templateState, templateControls, turnStep } from './spawn.js';

const DEG = Math.PI / 180;
const DEFAULTS = { kind: 'guard', ry: 0 };
const NAME = { blacksmith: 'Blacksmith', sage: 'Sage', trader: 'Trader', guard: 'Guard' };
const WHAT = {
  blacksmith: 'upgrades weapons for the players who stand next to him',
  sage: 'teaches skills and professions',
  trader: 'a townsman behind his stall',
  guard: 'stands watch',
};
const SERVES = ['blacksmith', 'sage'];     // the kinds players come to: validate() wants them inside a safe region
const nameOf = (kind) => NAME[kind] ?? kind;

function clean(t) {
  return { kind: NPC_KINDS.includes(t?.kind) ? t.kind : DEFAULTS.kind, ry: Number.isFinite(t?.ry) ? qAngle(t.ry) : 0 };
}

export default function create(ctx) {
  const { store, ui, cmd } = ctx;
  const template = templateState(ctx, 'npc', { defaults: DEFAULTS, read: clean, clean });
  const { opts } = template;

  const tool = markerTool(ctx, {
    id: 'npc', label: 'NPC', icon: '♟', layer: 'npcs', kind: 'npc', drag: 'facing',
    about: 'The people of the town: click to add the one chosen in the options, drag to turn them',

    props: () => template.fresh(),

    canPlace(x, z) {
      const map = store.map;
      if (Math.hypot(x, z) > map.radius - LIMITS.npcMargin) return `Outside the island: an NPC stays ${LIMITS.npcMargin} unit inside its edge`;
      if (isBlocked(map, x, z)) return `Nobody can reach an NPC on ${groundAt(map, x, z).name.toLowerCase()}`;
      return null;
    },

    ghost: (props) => ({ npcs: [props] }),
    adopt: (item) => template.adopt(item),

    placed(item) {
      if (!item) return;
      const exposed = SERVES.includes(item.kind) && !isSafe(store.map, item.x, item.z);
      ui.setNote(`${nameOf(item.kind)} added${exposed ? ': outside every safe region, so monsters can reach the players who visit' : ''}`);
    },

    idleKey(action, ev) {
      if (action !== 'rotate.ccw' && action !== 'rotate.cw') return false;
      template.set({ ry: opts.ry + (action === 'rotate.ccw' ? 1 : -1) * turnStep(ev) });
      return true;
    },

    hints: {
      intro: 'NPC: click adds the one chosen above, drag turns it · drag an NPC to move it',
      get create() { return `Click: place a ${nameOf(opts.kind)} (${WHAT[opts.kind] ?? 'an NPC'}) · drag: turn to face the pointer · Q E: turn`; },
      item: 'Click: select · drag: move · Shift+click: add · Alt+click: copy its kind and facing · Alt+drag: move a copy',
      selected: 'Drag: move the selection · Q E: turn · Alt+drag: move a copy',
    },

    options(el, keep) {
      // one button per kind: all four are in view, and a kind is one click
      const kinds = NPC_KINDS.map((kind) => {
        const node = button(nameOf(kind), () => template.set({ kind }), { title: `${nameOf(kind)}: ${WHAT[kind] ?? ''}` });
        return { kind, node };
      });
      const facing = angleField({ value: opts.ry, step: 15 * DEG, onInput: (v) => template.set({ ry: v }) });
      const census = h('span', { class: 'ui-hint', title: 'The NPCs of the map. Players need at least one Blacksmith and one Sage' });

      const controls = templateControls(ctx, 'npc', template, (items) => {
        const t = template.fresh();
        store.begin(`Apply NPC settings to ${describe(ctx, items)}`);
        try {
          store.exec(cmd.set(items, { kind: t.kind, ry: t.ry }));
        } finally {
          store.commit();
        }
      });

      const sync = () => {
        for (const k of kinds) {
          const active = k.kind === opts.kind;
          k.node.classList.toggle('active', active);
          k.node.setAttribute('aria-pressed', String(active));
        }
        facing.set(opts.ry);
        tool.refreshGhost();
      };
      const count = () => {
        const n = Object.fromEntries(NPC_KINDS.map((kind) => [kind, 0]));
        for (const npc of store.map?.npcs ?? []) if (npc.kind in n) n[npc.kind]++;
        census.textContent = `On the map: ${NPC_KINDS.map((kind) => `${n[kind]} ${nameOf(kind).toLowerCase()}${n[kind] === 1 ? '' : 's'}`).join(' · ')}`;
      };
      const facingRow = row('Facing', facing);
      facingRow.title = 'Which way the NPC looks. Drag on the map to aim; Q and E turn';
      el.append(row('Kind', h('span', { class: 'ui-group' }, kinds.map((k) => k.node))), facingRow, ...controls.nodes, census);
      sync();
      count();
      keep(template.on(sync));
      keep(controls.release);
      keep(store.on('change', (change) => { if (change.added.npcs.length || change.removed.npcs.length || change.updated.npcs.length) count(); }));
      keep(store.on('load', count));
    },
  });

  // beyond the tool contract: the settings of the next NPC, for scripts
  return Object.assign(tool, { opts, template: () => template.fresh(), setTemplate: (patch) => template.set(patch) });
}
