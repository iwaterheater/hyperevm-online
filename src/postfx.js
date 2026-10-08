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
  const bloom = new UnrealBloomPass(renderer.getSize(new THREE.Vector2()), 0.4, 0.4, 1.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  return {
    render() { composer.render(); },
    // Compiles the shaders of everything in the scene, drawn or hidden, ahead of the frame that would need them.
    // -> a promise. The scene is rendered into the composer's buffer, not onto the canvas, and a program is built for
    // where it draws (no tone mapping, linear colours): compiled without that target they would all be built twice.
    compile() {
      const target = renderer.getRenderTarget();
      renderer.setRenderTarget(composer.readBuffer);
      const done = renderer.compileAsync(scene, camera);
      renderer.setRenderTarget(target);
      return done;
    },
    setSize(w, h) { composer.setSize(w, h); },
    // after renderer.setPixelRatio(): the buffers of the passes follow
    setPixelRatio(ratio) { composer.setPixelRatio(ratio); },
    // the bloom on or off; without it the frame is the scene and the tone mapping alone
    setGlow(on) { bloom.enabled = !!on; },
  };
}
