// Stub (step 3): the Paste tool is written in step 4A. It loads and does nothing (it never has a toolbar button).
export default function create(ctx) {
  return {
    id: 'paste', label: 'Paste', icon: '?', layer: null, picks: [], hidden: true,
    get context() { return 'none'; },
    activate() {}, deactivate() {}, pointerDown() {}, pointerMove() {}, pointerUp() {}, key() { return false; },
  };
}
