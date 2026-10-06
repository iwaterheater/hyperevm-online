// The Start point tool: where players appear and come back to life - a point and the disc around it.
//
//   click on the ground           the start point moves there
//   press and drag on the ground  it follows the pointer - one undo step
//   drag its pin or its rim line  the same, from where it stands
//   drag a rim handle             the radius of the disc
//   arrows, [ ]                   nudge it, shrink or grow the disc
//
// A map has exactly one start point, so this tool creates nothing and deletes nothing. Activating it selects the start
// point: its rim handles are live at once.
// The gestures are the ones every marker tool has (markerTool in tools/spawn.js).
import { LIMITS, groundAt, inShape, isBlocked, regionAt } from '../../map/format.js';
import { h, row, button, numberField } from '../ui/dom.js';
import { hintFor } from '../keymap.js';
import { markerTool } from './spawn.js';

const START_COLOR = 0x4de0c0;      // the colour of the start marker

export default function create(ctx) {
  const { store, ui, cmd } = ctx;
  const start = () => store.map?.start ?? null;
  const usable = () => { const s = start(); return !!s && ui.isPickable('start', s); };
  const selectStart = () => { if (usable() && !(store.selection.size === 1 && store.selection.has(start()))) store.select([start()]); };

  const tool = markerTool(ctx, {
    id: 'start', label: 'Start point', icon: '⚑', layer: 'start', kind: 'start', drag: 'follow',

    target: start,

    canPlace(x, z) {
      const map = store.map, r = map.start.r;
      if (Math.hypot(x, z) + r > map.radius - LIMITS.startMargin) return `The start disc must stay ${LIMITS.startMargin} units inside the island's edge`;
      if (isBlocked(map, x, z)) return `Players cannot appear on ${groundAt(map, x, z).name.toLowerCase()}`;
      return null;
    },

    // where the disc would land
    ring: () => ({ r: Math.max(start()?.r ?? 0, 0.6), color: START_COLOR }),

    hints: {
      create: 'Click: move the start point here · drag: it follows the pointer',
      item: 'Drag: move the start point',
      selected: 'Drag: move the start point · drag a rim handle: the radius of the disc',
      handle: 'Drag the rim to set the radius: players appear at a random point of the disc',
    },

    activate: selectStart,

    // The three numbers of the start point, typed: each field is one undo step (begin on the first change, commit on
    // Enter or blur) and shows what a drag on the map does.
    options(el, keep) {
      let open = false;       // a typed edit of ours has a store group open
      const live = (key, label) => ({
        onInput: (v) => {
          const s = start();
          if (!s || !usable()) return;
          if (!open) {
            if (store.grouping) return;
            store.begin(label);
            open = true;
          }
          store.exec(cmd.set([s], { [key]: v }));
        },
        onCommit: () => {
          if (!open) return;
          open = false;
          store.commit();
        },
      });
      const x = numberField({ value: 0, step: 0.1, ...live('x', 'Move the start point') });
      const z = numberField({ value: 0, step: 0.1, ...live('z', 'Move the start point') });
      const r = numberField({ value: 0, min: LIMITS.startR[0], max: LIMITS.startR[1], step: 0.5, ...live('r', 'Resize the start point') });
      const where = h('span', { class: 'ui-hint' });
      const home = hintFor('view.home');
      const go = button('Go to start', () => ctx.actions.run('view.home'), { title: home ? `Move the camera to the start point (${home})` : 'Move the camera to the start point' });

      const sync = () => {
        const s = start(), on = usable();
        for (const field of [x, z, r]) field.setDisabled(!on);
        go.disabled = !s;
        if (!s) { where.textContent = ''; return; }
        x.set(s.x);
        z.set(s.z);
        r.set(s.r);
        const map = store.map, state = ui.layers?.start;
        const safe = map.regions.find((region) => region.safe && inShape(region.shape, s.x, s.z));
        where.textContent = state && !state.visible ? 'The Start layer is hidden'
          : state && state.locked ? 'The Start layer is locked'
            : isBlocked(map, s.x, s.z) ? `On ${groundAt(map, s.x, s.z).name.toLowerCase()}: players cannot appear there`
              : safe ? `Inside ${safe.name} (safe)`
                : `In ${regionAt(map, s.x, s.z).name}: not a safe region, monsters can reach new players`;
      };
      const xRow = row('Start X', x), zRow = row('Z', z), rRow = row('Radius', r);
      xRow.title = zRow.title = 'Where players appear. Click or drag on the map to move it';
      rRow.title = 'Players appear at a random point of this disc';
      el.append(xRow, zRow, rRow, go, where);
      sync();
      keep(store.on('change', (change) => { if (change.updated.start.length || change.updated.regions.length || change.added.regions.length || change.removed.regions.length || change.ground) sync(); }));
      keep(store.on('load', () => { open = false; sync(); selectStart(); }));
      keep(ui.on('layers', sync));
    },
  });
  return tool;
}
