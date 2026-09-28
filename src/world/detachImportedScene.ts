import * as THREE from 'three';

type ObservedObject=THREE.Object3D & {_listeners?:Record<string,unknown[]>};
const observes=(object:THREE.Object3D,type:string):boolean=>
  object.dispatchEvent!==THREE.Object3D.prototype.dispatchEvent||
  !!(object as ObservedObject)._listeners?.[type]?.length;

/** Release imported source nodes without repeatedly shifting a large child array. */
export function detachImportedScene(scene:THREE.Group):void{
  if(scene.remove!==THREE.Object3D.prototype.remove||observes(scene,'childremoved')||
    scene.children.some(child=>observes(child,'removed'))){
    // Preserve clear()'s original snapshot: callbacks may reparent siblings or
    // add new children, and those new children must remain in the scene.
    const sourceChildren=scene.children.slice();
    for(let i=0;i<sourceChildren.length;i+=1024)scene.remove(...sourceChildren.slice(i,i+1024));
    return;
  }
  // GLTFLoader's fresh source objects have no removal observers. Dispatching
  // their normal events is still safe after one bulk removal of the children.
  const children=scene.children.splice(0),removed={type:'removed' as const};
  for(const child of children){
    child.parent=null;child.dispatchEvent(removed);
    scene.dispatchEvent({type:'childremoved',child});
  }
}
