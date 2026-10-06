// Stub (step 3): the Measure tool is written in step 4D. It loads, shows its toolbar button and does nothing.
export default function create(ctx) {
  return {
    id: 'measure', label: 'Measure', icon: '?', layer: null, picks: [], hidden: false,
    get context() { return 'none'; },
    activate() {}, deactivate() {}, pointerDown() {}, pointerMove() {}, pointerUp() {}, key() { return false; },
  };
}
