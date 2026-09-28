import test from 'node:test';
import assert from 'node:assert/strict';
import { Group, Object3D } from 'three';
import { detachImportedScene } from '../src/world/detachImportedScene.ts';

test('unobserved imported children detach without changing their contents',()=>{
  const scene=new Group(),children=[];
  for(let i=0;i<4097;i++){
    const child=new Group(),nested=new Object3D();child.add(nested);children.push(child);scene.add(child);
  }
  detachImportedScene(scene);
  assert.equal(scene.children.length,0);
  for(const child of children){assert.equal(child.parent,null);assert.equal(child.children.length,1);assert.equal(child.children[0].parent,child);}
});

function observedFixture(detach){
  const scene=new Group(),other=new Group(),events=[];
  const children=Array.from({length:4},(_,i)=>{const child=new Object3D();child.name=String(i);return child;});
  const added=new Object3D();added.name='added';scene.add(...children);
  scene.addEventListener('childremoved',event=>events.push(['parent',event.child.name,scene.children.map(child=>child.name)]));
  for(const child of children)child.addEventListener('removed',()=>{
    assert.equal(child.parent,null);events.push(['child',child.name,scene.children.map(sibling=>sibling.name)]);
    if(child===children[0])other.add(children[2]);
    if(child===children[1])scene.add(added);
  });
  detach(scene);
  return {events,remaining:scene.children.map(child=>child.name),reparented:other.children.map(child=>child.name),parents:children.map(child=>child.parent===null?'null':child.parent===other?'other':'scene')};
}

test('observed detach matches clear snapshot, event order and reentrant reparenting',()=>{
  const expected=observedFixture(scene=>scene.clear());
  assert.deepEqual(expected.remaining,['added']);assert.deepEqual(expected.reparented,['2']);
  assert.deepEqual(observedFixture(detachImportedScene),expected);
});

test('custom removal and dispatch methods retain bounded per-child behavior',()=>{
  const scene=new Group(),children=Array.from({length:2051},()=>new Object3D());
  scene.add(...children);const calls=[],events=[],originalRemove=scene.remove;
  scene.remove=function(...objects){calls.push(objects.length);return originalRemove.apply(this,objects);};
  const child=children[0],originalDispatch=child.dispatchEvent;
  child.dispatchEvent=function(event){events.push([event.type,this.parent,scene.children.length]);return originalDispatch.call(this,event);};
  detachImportedScene(scene);
  assert.equal(scene.children.length,0);assert.ok(children.every(object=>object.parent===null));
  assert.deepEqual(calls.filter(size=>size>1),[1024,1024,3]);
  assert.deepEqual(events,[['removed',null,2050]]);
});

test('each observer guard retains the remaining-sibling state during removal',()=>{
  for(const mode of ['child-listener','child-dispatch','scene-dispatch']){
    const scene=new Group(),children=[new Object3D(),new Object3D(),new Object3D()],remaining=[];
    scene.add(...children);
    if(mode==='child-listener')for(const child of children)child.addEventListener('removed',()=>remaining.push(scene.children.length));
    if(mode==='child-dispatch')for(const child of children){
      const original=child.dispatchEvent;
      child.dispatchEvent=function(event){if(event.type==='removed')remaining.push(scene.children.length);return original.call(this,event);};
    }
    if(mode==='scene-dispatch'){
      const original=scene.dispatchEvent;
      scene.dispatchEvent=function(event){if(event.type==='childremoved')remaining.push(scene.children.length);return original.call(this,event);};
    }
    detachImportedScene(scene);assert.deepEqual(remaining,[2,1,0],mode);
  }
});
