// Stub (step 3): the NPC tool is written in step 4C. It loads, shows its toolbar button and does nothing.
export default function create(ctx) {
  return {
    id: 'npc', label: 'NPC', icon: '?', layer: 'npcs', picks: [], hidden: false,
    get context() { return 'none'; },
    activate() {}, deactivate() {}, pointerDown() {}, pointerMove() {}, pointerUp() {}, key() { return false; },
  };
}
