import type { Camera, Scene, WebGLRenderer } from 'three';

/** Render after all scene mutations and one complete world-matrix preparation. */
export function renderSceneWithPreparedMatrices(
  renderer:Pick<WebGLRenderer,'render'>,scene:Scene,camera:Camera,
):void {
  const automatic=scene.matrixWorldAutoUpdate;
  scene.matrixWorldAutoUpdate=false;
  try{renderer.render(scene,camera);}
  finally{scene.matrixWorldAutoUpdate=automatic;}
}
