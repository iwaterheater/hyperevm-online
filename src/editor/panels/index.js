// The panel registry: every module that fills one container of editor.html, in mount order.
// main.js loads each `path` with a guarded dynamic import() and calls its default export as mount(el, ctx), so the
// paths are relative to src/editor/ - the directory of main.js - and NOT to this file.
//
// el:    the container the panel owns the children of.
// title: the heading of the collapsible frame main.js wraps a side-column section in; null = the container has no frame.
// name:  what to call the panel in a message ("<name> (failed to load)"); every row has one, framed or not.
export const PANELS = [
  { el: '#menu-file',  title: null,        name: 'File menu',       path: './panels/menubar.js' },
  { el: '#menu-io',    title: null,        name: 'Import / Export', path: './io.js' },
  { el: '#menu-play',  title: null,        name: 'Play',            path: './play.js' },
  { el: '#toolbar',    title: null,        name: 'Toolbar',         path: './panels/toolbar.js' },
  { el: '#palette',    title: 'Palette',   name: 'Palette',         path: './panels/palette.js' },
  { el: '#inspector',  title: 'Inspector', name: 'Inspector',       path: './panels/inspector.js' },
  { el: '#arrange',    title: 'Arrange',   name: 'Arrange',         path: './panels/arrange.js' },
  { el: '#layers',     title: 'Layers',    name: 'Layers',          path: './panels/layers.js' },
  { el: '#regions',    title: 'Regions',   name: 'Regions',         path: './panels/regions.js' },
  { el: '#spawns',     title: 'Spawns',    name: 'Spawns',          path: './panels/spawns.js' },
  { el: '#validation', title: 'Issues',    name: 'Issues',          path: './panels/validation.js' },
  { el: '#minimap',    title: 'Minimap',   name: 'Minimap',         path: './panels/minimap.js' },
  { el: '#status',     title: null,        name: 'Status bar',      path: './panels/status.js' },
  { el: '#help',       title: null,        name: 'Help',            path: './panels/help.js' },
];
