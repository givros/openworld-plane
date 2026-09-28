import test from 'node:test';
import assert from 'node:assert/strict';
import {Scene,Group,Mesh,BoxGeometry,MeshBasicMaterial} from 'three';
import {renderWithProxyWorld} from '../src/core/renderWithProxyWorld.ts';

test('proxy rendering omits canonical traversal while retaining source ancestry and visibility',()=>{
  const scene=new Scene(),world=new Group(),proxies=new Group(),mesh=new Mesh(new BoxGeometry(),new MeshBasicMaterial());
  world.add(mesh);scene.add(world,proxies);const children=scene.children;
  renderWithProxyWorld(scene,world,()=>{
    const visited=[];scene.traverse(object=>visited.push(object));
    assert.deepEqual(visited,[scene,proxies]);assert.equal(world.parent,scene);assert.equal(mesh.parent,world);
    assert.equal(world.visible,true);assert.equal(mesh.visible,true);
  });
  assert.equal(scene.children,children);assert.deepEqual(scene.children,[world,proxies]);mesh.geometry.dispose();mesh.material.dispose();
});

test('failed renders restore the original traversal snapshot',()=>{
  const scene=new Scene(),world=new Group();scene.add(world);const children=scene.children;
  assert.throws(()=>renderWithProxyWorld(scene,world,()=>{throw Error('draw failed');}),/draw failed/);
  assert.equal(scene.children,children);assert.equal(world.parent,scene);
});
