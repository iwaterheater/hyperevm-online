// Stub (step 3): the Scatter tool is written in step 4B. It loads, shows its toolbar button and does nothing.
export default function create(ctx) {
  return {
    id: 'scatter', label: 'Scatter', icon: '?', layer: 'objects', picks: [], hidden: false,
    get context() { return 'none'; },
    activate() {}, deactivate() {}, pointerDown() {}, pointerMove() {}, pointerUp() {}, key() { return false; },
  };
}
