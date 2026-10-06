// Stub (step 3): the Terrain tool is written in step 4B. It loads, shows its toolbar button and does nothing.
export default function create(ctx) {
  return {
    id: 'paint', label: 'Terrain', icon: '?', layer: 'ground', picks: [], hidden: false,
    get context() { return 'none'; },
    activate() {}, deactivate() {}, pointerDown() {}, pointerMove() {}, pointerUp() {}, key() { return false; },
  };
}
