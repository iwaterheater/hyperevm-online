// The tool registry: every tool of the editor, in toolbar order.
// main.js loads each `path` with a guarded dynamic import(), so the paths are relative to src/editor/ - the directory
// of main.js - and NOT to this file. One module that fails to load is replaced by a stub built from its row here
// (id, label, layer, hidden), which is why those fields are repeated: the live tool object carries them too.
//
// layer:  the layer the tool edits (its toolbar button is disabled while that layer is hidden or locked), or null.
// hidden: true = no toolbar button; the tool is entered by an action (Paste).
// The keys are not listed here: they live in the one keymap table (keymap.js, actions 'tool.<id>').
export const TOOLS = [
  { id: 'select',  label: 'Select',      layer: null,      hidden: false, path: './tools/select.js' },
  { id: 'place',   label: 'Place',       layer: 'objects', hidden: false, path: './tools/place.js' },
  { id: 'paste',   label: 'Paste',       layer: null,      hidden: true,  path: './tools/paste.js' },
  { id: 'scatter', label: 'Scatter',     layer: 'objects', hidden: false, path: './tools/scatter.js' },
  { id: 'paint',   label: 'Terrain',     layer: 'ground',  hidden: false, path: './tools/paint.js' },
  { id: 'spawn',   label: 'Spawn',       layer: 'spawns',  hidden: false, path: './tools/spawn.js' },
  { id: 'chest',   label: 'Chest',       layer: 'chests',  hidden: false, path: './tools/chest.js' },
  { id: 'npc',     label: 'NPC',         layer: 'npcs',    hidden: false, path: './tools/npc.js' },
  { id: 'start',   label: 'Start point', layer: 'start',   hidden: false, path: './tools/start.js' },
  { id: 'region',  label: 'Region',      layer: 'regions', hidden: false, path: './tools/region.js' },
  { id: 'measure', label: 'Measure',     layer: null,      hidden: false, path: './tools/measure.js' },
];
