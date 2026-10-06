// Stub (step 3): the Place tool is written in step 4A. It loads, shows its toolbar button and does nothing.
export default function create(ctx) {
  return {
    id: 'place', label: 'Place', icon: '?', layer: 'objects', picks: [], hidden: false,
    get context() { return 'none'; },
    activate() {}, deactivate() {}, pointerDown() {}, pointerMove() {}, pointerUp() {}, key() { return false; },
  };
}
