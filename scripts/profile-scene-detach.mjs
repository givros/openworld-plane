import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { Group, Object3D } from 'three';
import { detachImportedScene } from '../src/world/detachImportedScene.ts';

// Isolated ownership/complexity experiment; never imported by the runtime.
// Bulk detach preserves parents, removal order and the two removal events.
// A callback inspecting scene.children sees the batch already removed. The
// freshly loaded GLTF scene has no such callbacks; this is not a general
// replacement for Object3D.remove when observers require intermediate state.
function detachImportedChildren(scene){
  const children=scene.children.splice(0);
  const removed={type:'removed'},childRemoved={type:'childremoved',child:null};
  for(const child of children){
    child.parent=null;child.dispatchEvent(removed);
    childRemoved.child=child;scene.dispatchEvent(childRemoved);
  }
  childRemoved.child=null;
}

const count=140210,report={count,results:[]};
for(const method of process.argv.includes('--guarded-only')?[]:['bounded-remove','linear-detach']){
  const scene=new Group(),children=[];
  let removedCount=0,childRemovedCount=0,sequence=0;
  const removed=event=>{assert.equal(event.target.parent,null);removedCount++;};
  scene.addEventListener('childremoved',event=>{
    assert.equal(event.child,children[sequence++]);assert.equal(event.child.parent,null);childRemovedCount++;
  });
  for(let i=0;i<count;i++){
    const child=new Object3D();child.addEventListener('removed',removed);children.push(child);scene.add(child);
  }
  const before=performance.now();
  if(method==='bounded-remove')while(scene.children.length)scene.remove(...scene.children.slice(0,1024));
  else detachImportedChildren(scene);
  const elapsedMs=performance.now()-before;
  assert.equal(scene.children.length,0);assert.equal(removedCount,count);assert.equal(childRemovedCount,count);
  assert.ok(children.every(child=>child.parent===null));
  report.results.push({method,elapsedMs,removedCount,childRemovedCount});
  console.log(JSON.stringify(report.results.at(-1)));
}
{
  const scene=new Group(),children=[];
  for(let i=0;i<count;i++){const child=new Object3D();children.push(child);scene.add(child);}
  const before=performance.now();detachImportedScene(scene);const elapsedMs=performance.now()-before;
  assert.equal(scene.children.length,0);assert.ok(children.every(child=>child.parent===null));
  report.results.push({method:'guarded-linear-unobserved',elapsedMs,parentsCleared:count});
}
function reentrant(remove){
  const scene=new Group(),other=new Group(),children=Array.from({length:4},(_,i)=>{const child=new Object3D();child.name=String(i);return child;}),events=[];
  const later=new Object3D();later.name='later';scene.add(...children);
  scene.addEventListener('childremoved',event=>events.push(`parent:${event.child.name}:${scene.children.map(child=>child.name).join(',')}`));
  for(const child of children)child.addEventListener('removed',()=>{
    events.push(`child:${child.name}:${scene.children.map(sibling=>sibling.name).join(',')}`);
    if(child===children[0])other.add(children[2]);
    if(child===children[1])scene.add(later);
  });
  remove(scene);
  return {events,sceneChildren:scene.children.map(child=>child.name),otherChildren:other.children.map(child=>child.name),parents:children.map(child=>child.parent?.uuid===other.uuid?'other':child.parent===null?'null':'scene'),laterParent:later.parent===null?'null':'scene'};
}
const expected=reentrant(scene=>scene.clear());
assert.deepEqual(reentrant(detachImportedScene),expected);
report.reentrantCallbackBehaviorIdentical=true;
{
  const scene=new Group(),child=new Object3D();scene.add(child);const events=[];
  const original=child.dispatchEvent;
  child.dispatchEvent=function(event){events.push({type:event.type,remaining:scene.children.length,parent:this.parent});return original.call(this,event);};
  detachImportedScene(scene);assert.deepEqual(events,[{type:'removed',remaining:0,parent:null}]);
  report.customDispatchFallbackPassed=true;
}
console.log(JSON.stringify(report));
const name=process.argv.includes('--guarded-only')?'detach-guarded-experiment.json':'detach-experiment.json';
await writeFile(new URL(`../artifacts/four-horizons/loading-profile/${name}`,import.meta.url),JSON.stringify(report,null,2));
