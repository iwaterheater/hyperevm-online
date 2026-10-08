// The player's own settings: sound and graphics. They are kept in the browser and never reach the server.
// Pure: what applies them to the renderer and the sound is in src/main.js.

export const SETTINGS_KEY = 'hypercat-settings';   // where they are kept, in localStorage
// How much of the screen's own resolution is rendered, per side: fewer pixels are the cheapest way to more frames.
export const RESOLUTIONS = { low: 0.5, medium: 0.75, high: 1 };
export const DEFAULT_SETTINGS = Object.freeze({
  sound: true, volume: 100,   // volume in percent: 100 is as loud as the game is made
  resolution: 'high', shadows: true, glow: true, grass: true,
  auto: true,    // lower the graphics while the game runs slow (see lowered)
  fps: false,    // show the frame rate
});

// Settings that can be relied on, from whatever was stored: a value of the wrong kind falls back to its default,
// what is unknown is dropped.
export function cleanSettings(raw) {
  const from = raw && typeof raw === 'object' ? raw : {}, out = { ...DEFAULT_SETTINGS };
  for (const key of ['sound', 'shadows', 'glow', 'grass', 'auto', 'fps']) if (typeof from[key] === 'boolean') out[key] = from[key];
  if (Number.isFinite(from.volume)) out.volume = Math.max(0, Math.min(100, Math.round(from.volume)));
  if (Object.hasOwn(RESOLUTIONS, from.resolution)) out.resolution = from.resolution;
  return out;
}

// The renderer's pixel ratio on a screen of the given device pixel ratio (never more than 2: beyond it nobody sees
// the difference, and the frame costs four times as much).
export const pixelRatio = (resolution, device = 1) => Math.min(device > 0 ? device : 1, 2) * RESOLUTIONS[resolution];

// What "Auto" takes away when the game does not hold its frame rate, a step at a time, the cheapest loss first.
export const AUTO_STEPS = [{ resolution: 'medium' }, { shadows: false }, { glow: false }, { resolution: 'low' }, { grass: false }];
// The settings as they are when Auto has taken `steps` steps. A step only ever lowers: what the player has set lower
// already stays as it is, and nothing is raised.
export function lowered(settings, steps) {
  const out = { ...settings };
  for (const step of AUTO_STEPS.slice(0, Math.max(0, steps))) {
    for (const [key, value] of Object.entries(step)) {
      if (key !== 'resolution') out[key] = out[key] && value;
      else if (RESOLUTIONS[value] < RESOLUTIONS[out.resolution]) out.resolution = value;
    }
  }
  return out;
}

// What every sound is multiplied by: 0 to 1.
export const loudness = (settings) => (settings.sound ? settings.volume / 100 : 0);
