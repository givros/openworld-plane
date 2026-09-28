import type { Object3D } from 'three';

/**
 * Freeze the authored local matrices below a static world, leaving its placement
 * and every world-matrix update under Three's normal parent/force semantics.
 *
 * Call only after the complete static asset transfer. Descendant position,
 * quaternion and scale are authored constants; later local edits must update
 * that object's matrix explicitly or restore automatic local updates first.
 * Newly added children are not frozen. Geometry and instance buffers stay mutable.
 */
export function freezeStaticLocalMatrices(root:Object3D):()=>void {
  const changed:Object3D[]=[];
  root.traverse(object=>{
    if(object===root||!object.matrixAutoUpdate)return;
    object.updateMatrix();object.matrixAutoUpdate=false;changed.push(object);
  });
  let restored=false;
  return()=>{
    if(restored)return;
    for(const object of changed)object.matrixAutoUpdate=true;
    restored=true;
  };
}
