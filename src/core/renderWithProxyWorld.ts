import type {Object3D,Scene} from 'three';

/** All renderable descendants must already have complete external proxies.
 * Use a synchronous render-list snapshot: authoritative parents and visibility
 * remain available to per-pass source selection, without a second native walk.
 */
export function renderWithProxyWorld(scene:Scene,world:Object3D,draw:()=>void):void {
  const children=scene.children;
  if(world.parent!==scene||!children.includes(world))throw new Error('The proxy world must be a direct scene child');
  scene.children=children.filter(child=>child!==world);
  try{draw();}finally{scene.children=children;}
}
