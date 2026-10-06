import { h, button, selectField } from '../ui/dom.js';
import { hintFor } from '../keymap.js';
import { TOOLS } from '../tools/index.js';
import { MOODS } from '../../map/format.js';

// The toolbar (#toolbar): one button per tool with its key, the overlay switches, the preview selector.
// It only shows state and asks for changes: a tool is chosen through the action 'tool.<id>', an overlay through
// ui.overlays, the preview through viewport.setPreview. The keys on the buttons come from the keymap table.

// [key of ui.overlays, label, what it shows] - in toolbar order
const OVERLAYS = [
  ['grid', 'Grid', 'Ground grid: a line every 10 units, a bold one every 50'],
  ['boundary', 'Boundary', 'The edge of the island (the map radius)'],
  ['regiontint', 'Region tint', 'Tint the ground with the colour of the region that wins there'],
  ['colliders', 'Colliders', 'What blocks the player: object colliders and blocked ground'],
  ['threat', 'Threat', 'Threat rings of every spawn (how far its monsters reach)'],
  ['labels', 'Labels', 'Marker labels'],
  ['levelColors', 'Level colours', 'Colour spawns by level instead of by monster type'],
];

export default function mount(el, ctx) {
  const { ui, actions } = ctx;

  // ---- tools
  const tools = TOOLS.filter((row) => !row.hidden).map((row) => {
    const tool = ctx.tools?.[row.id];
    const label = String(tool?.label ?? row.label), layer = tool?.layer ?? row.layer, hint = hintFor(`tool.${row.id}`);
    const node = button([
      h('span', { class: 'tool-icon' }, String(tool?.icon ?? label[0])),
      h('span', { class: 'tool-label' }, label),
      hint && h('kbd', { class: 'ui-kbd' }, hint),
    ], () => {
      // a toolbar that works even before the action is registered is worth more than a strict one
      if (actions.has(`tool.${row.id}`)) actions.run(`tool.${row.id}`);
      else ui.set('tool', row.id);
    });
    node.classList.add('tool');
    node.dataset.tool = row.id;
    return { id: row.id, label, layer, hint, node };
  });

  const syncTools = () => {
    for (const t of tools) {
      const state = t.layer ? ui.layers?.[t.layer] : null;
      const off = !!state && (!state.visible || state.locked);
      const active = ui.tool === t.id;
      t.node.disabled = off;
      t.node.classList.toggle('active', active);
      t.node.setAttribute('aria-pressed', String(active));
      t.node.title = off
        ? `${t.label}: the ${t.layer} layer is ${state.visible ? 'locked' : 'hidden'}`
        : t.hint ? `${t.label} (${t.hint})` : t.label;
    }
  };

  // ---- overlays
  const toggles = OVERLAYS.map(([key, label, title]) => {
    const node = button(label, () => ui.set('overlays', { ...ui.overlays, [key]: !ui.overlays[key] }), { title });
    node.classList.add('toggle');
    return { key, node };
  });
  const syncOverlays = () => {
    for (const t of toggles) {
      const on = !!ui.overlays?.[t.key];
      t.node.classList.toggle('active', on);
      t.node.setAttribute('aria-pressed', String(on));
    }
  };

  // ---- preview: neutral light, the game's look, or one mood's light
  const preview = selectField({
    value: ui.preview,
    options: [
      { value: 'neutral', label: 'Neutral' },
      { value: 'game', label: 'Game' },
      ...Object.keys(MOODS).map((key) => ({ value: key, label: `Mood: ${MOODS[key].name}` })),
    ],
    onCommit: (mode) => ctx.viewport.setPreview(mode),   // which also sets ui.preview, and that comes back to this select
  });
  preview.el.title = 'Viewport lighting: neutral for editing, Game as players see it, or one mood';

  // two blocks: in a narrow window the second one moves to a line of its own as a whole
  el.replaceChildren(
    h('div', { class: 'tools' }, tools.map((t) => t.node)),
    h('div', { class: 'view' },
      h('div', { class: 'overlays' }, h('span', { class: 'caption' }, 'Show'), toggles.map((t) => t.node)),
      h('div', { class: 'preview' }, h('span', { class: 'caption' }, 'Preview'), preview)),
  );

  ui.on('tool', syncTools);
  ui.on('layers', syncTools);
  ui.on('overlays', syncOverlays);
  ui.on('preview', (mode) => preview.set(mode));
  syncTools();
  syncOverlays();
  return {};
}
