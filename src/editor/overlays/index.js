// The overlay registry: persistent visuals in the viewport that belong to no tool.
// main.js loads each `path` with a guarded dynamic import(), so the paths are relative to src/editor/ - the directory
// of main.js - and NOT to this file. An overlay's id is also its switch, ui.overlays[id], and its key in ctx.overlays.
export const OVERLAYS = [
  { id: 'regiontint', path: './overlays/regiontint.js' },
];
