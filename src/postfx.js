import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// The look of the finished frame: the scene, a soft bloom on everything brighter than white (lamp bulbs, crystals,
// spell effects), then tone mapping. The game and the editor's game preview share it, so both show the same picture.
export function createComposer(renderer, scene, camera) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(renderer.getSize(new THREE.Vector2()), 0.4, 0.4, 1.0));
  composer.addPass(new OutputPass());
  return {
    render() { composer.render(); },
    setSize(w, h) { composer.setSize(w, h); },
  };
}
