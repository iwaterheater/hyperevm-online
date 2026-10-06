// Stub (step 3): the region tint overlay is written in step 4D. `canvas` stays null, so the minimap draws no tint.
export default function create(ctx) {
  return { id: 'regiontint', canvas: null, version: 0, setVisible() {} };
}
