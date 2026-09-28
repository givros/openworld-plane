import test from 'node:test';
import assert from 'node:assert/strict';
import {Group,Object3D,Scene} from 'three';
import {CompactRenderChildren} from '../src/core/CompactRenderChildren.ts';

const objects=count=>Array.from({length:count},()=>new Object3D());
const visited=root=>{const result=[];root.traverse(object=>result.push(object));return result;};

test('compact rendering retains native sibling order and exact parent identity',()=>{
  const scene=new Scene(),root=new Group(),[first,hidden,last]=objects(3);root.add(first,hidden,last);scene.add(root);
  const canonical=root.children,compact=new CompactRenderChildren(root);
  const answer=compact.render([last,first],()=>{
    assert.deepEqual(visited(scene),[scene,root,first,last]);
    assert.equal(first.parent,root);assert.equal(hidden.parent,root);assert.equal(last.parent,root);
    assert.equal(hidden.visible,true);assert.equal(root.parent,scene);return 42;
  });
  assert.equal(answer,42);assert.equal(root.children,canonical);assert.deepEqual(root.children,[first,hidden,last]);
  assert.equal(compact.statistics.retainedChildren,2);assert.equal(compact.statistics.skippedChildren,1);
});

test('nested order groups retain hierarchy while empty branches are omitted',()=>{
  const root=new Group(),ordered=new Group(),nested=new Group(),unused=new Group(),[a,b,c,d]=objects(4);
  ordered.renderOrder=17;nested.renderOrder=29;root.add(a,ordered,unused);ordered.add(b,nested,c);nested.add(d);unused.add(new Object3D());
  const originals=[root,ordered,nested,unused].map(group=>group.children),compact=new CompactRenderChildren(root);
  compact.invalidate(ordered);compact.invalidate(nested);compact.invalidate(unused);
  compact.render([d,c,d],()=>{
    assert.deepEqual(visited(root),[root,ordered,nested,d,c]);
    assert.equal(d.parent,nested);assert.equal(nested.parent,ordered);assert.equal(ordered.renderOrder,17);assert.equal(nested.renderOrder,29);
  });
  [root,ordered,nested,unused].forEach((group,index)=>assert.equal(group.children,originals[index]));
  assert.equal(compact.statistics.selectionEntries,3);assert.equal(compact.statistics.retainedChildren,4);assert.equal(compact.statistics.skippedChildren,4);
  compact.render([],()=>assert.deepEqual(visited(root),[root]));
  assert.equal(compact.statistics.retainedChildren,0);
});

test('stable selections never reindex inactive proxy children',()=>{
  const root=new Group(),proxies=objects(10000);root.add(...proxies);
  const compact=new CompactRenderChildren(root),selected=[proxies[9999],proxies[3]];
  compact.render(selected,()=>{});
  const indexed=compact.statistics.indexedChildren,rebuilds=compact.statistics.indexRebuilds;
  for(let frame=0;frame<20;frame++)compact.render(selected,()=>assert.deepEqual(root.children,[proxies[3],proxies[9999]]));
  assert.equal(compact.statistics.indexedChildren,indexed);assert.equal(compact.statistics.indexRebuilds,rebuilds);
  assert.equal(compact.statistics.skippedChildren,9998);
});

test('incremental streaming appends removals and region inserts never reindex 10k siblings',()=>{
  const root=new Group(),proxies=objects(10000);root.add(...proxies);
  const compact=new CompactRenderChildren(root);compact.render([proxies[0]],()=>{});
  const indexed=compact.statistics.indexedChildren,rebuilds=compact.statistics.indexRebuilds;
  for(let frame=0;frame<100;frame++){
    const [arrival,region]=objects(2),full=proxies[frame*73],removed=proxies[9999-frame];
    root.add(arrival);compact.append(root,arrival);
    root.add(region);compact.append(root,region);
    const position=root.children.indexOf(full);root.children.splice(root.children.indexOf(region),1);root.children.splice(position+1,0,region);
    compact.placeAfter(root,region,full);
    root.remove(removed);compact.remove(root,removed);
    const selection=[arrival,region,proxies[0],full],wanted=new Set(selection),expected=root.children.filter(child=>wanted.has(child));
    compact.render(selection,()=>assert.deepEqual(root.children,expected));
  }
  assert.equal(compact.statistics.indexedChildren,indexed);assert.equal(compact.statistics.indexRebuilds,rebuilds);
  assert.equal(compact.statistics.orderRenumbers,0);assert.equal(compact.statistics.incrementalEdits,400);
  assert.equal(compact.statistics.availableChildren,10100);
});

test('new empty groups build ranks incrementally and reparent without a full index',()=>{
  const root=new Group(),nested=new Group(),compact=new CompactRenderChildren(root),[a,b,c]=objects(3);
  root.add(nested);compact.append(root,nested);compact.register(nested);
  for(const child of [a,b,c]){root.add(child);compact.append(root,child);}
  nested.add(b);compact.remove(root,b);compact.append(nested,b);
  compact.render([c,b,a],()=>assert.deepEqual(visited(root),[root,nested,b,a,c]));
  assert.equal(compact.statistics.indexRebuilds,0);
  root.remove(c);compact.remove(root,c);root.add(c);compact.append(root,c);
  compact.render([c,a,b],()=>assert.deepEqual(visited(root),[root,nested,b,a,c]));
  assert.equal(compact.statistics.indexRebuilds,0);
});

test('exhausted fractional order gaps fall back to an exact rare rebuild',()=>{
  const root=new Group(),[head,full,tail]=objects(3);root.add(head,full,tail);
  const compact=new CompactRenderChildren(root);compact.render([tail,full,head],()=>{});
  for(let frame=0;frame<150;frame++){
    const child=new Object3D();root.add(child);compact.append(root,child);
    root.children.splice(root.children.length-1,1);root.children.splice(root.children.indexOf(full)+1,0,child);compact.placeAfter(root,child,full);
    const expected=root.children.slice();compact.render([...expected].reverse(),()=>assert.deepEqual(root.children,expected));
  }
  assert.ok(compact.statistics.orderRenumbers>0);assert.ok(compact.statistics.indexRebuilds<6);
});

test('region proxies use their canonical interleaved order after explicit invalidation',()=>{
  const root=new Group(),[fullA,fullB,regionA,regionB]=objects(4);root.add(fullA,fullB);
  const compact=new CompactRenderChildren(root);compact.render([fullB,fullA],()=>assert.deepEqual(root.children,[fullA,fullB]));
  root.add(regionA,regionB);root.children.splice(0,4,fullA,regionA,fullB,regionB);compact.invalidate(root);
  const canonical=root.children;
  compact.render([regionB,regionA],()=>assert.deepEqual(root.children,[regionA,regionB]));
  assert.equal(root.children,canonical);assert.equal(regionA.parent,root);assert.equal(regionB.parent,root);
  root.children.splice(0,4,fullB,regionB,fullA,regionA);compact.invalidate(root);
  compact.render([regionA,regionB],()=>assert.deepEqual(root.children,[regionB,regionA]));
  root.remove(fullA,regionA);compact.invalidate(root);
  compact.render([regionB],()=>assert.deepEqual(root.children,[regionB]));
  assert.equal(compact.statistics.availableChildren,2);
});

test('reparented proxies preserve their new group order after invalidation',()=>{
  const root=new Group(),group=new Group(),[a,b]=objects(2);root.add(a,group);group.add(b);
  const compact=new CompactRenderChildren(root);compact.invalidate(group);compact.render([a,b],()=>{});
  group.add(a);compact.invalidate(root);compact.invalidate(group);
  compact.render([a,b],()=>assert.deepEqual(visited(root),[root,group,b,a]));
  assert.equal(a.parent,group);assert.deepEqual(group.children,[b,a]);
});

test('different pass lists nest and exceptions restore every exact child array',()=>{
  const beauty=new Group(),shadow=new Group(),[a,b,c,d]=objects(4);beauty.add(a,b);shadow.add(c,d);
  const beautyChildren=beauty.children,shadowChildren=shadow.children,beautyList=new CompactRenderChildren(beauty),shadowList=new CompactRenderChildren(shadow);
  assert.throws(()=>beautyList.render([a],()=>shadowList.render([d],()=>{
    assert.deepEqual(beauty.children,[a]);assert.deepEqual(shadow.children,[d]);throw new Error('native render failed');
  })),/native render failed/);
  assert.equal(beauty.children,beautyChildren);assert.equal(shadow.children,shadowChildren);
  beautyList.render([b],()=>assert.deepEqual(beauty.children,[b]));
});

test('unsafe same-list nesting, mutations, async callbacks and foreign selections restore safely',()=>{
  const root=new Group(),[a,b]=objects(2);root.add(a,b);const canonical=root.children,compact=new CompactRenderChildren(root);
  assert.throws(()=>compact.render([a],()=>compact.render([b],()=>{})),/Nested draws/);assert.equal(root.children,canonical);
  assert.throws(()=>compact.render([a],()=>compact.invalidate(root)),/during a draw/);assert.equal(root.children,canonical);
  assert.throws(()=>compact.render([a],()=>Promise.resolve()),/synchronous/);assert.equal(root.children,canonical);
  assert.throws(()=>compact.render([new Object3D()],()=>{}),/outside/);assert.equal(root.children,canonical);
  assert.throws(()=>compact.render([root],()=>{}),/render leaves/);assert.equal(root.children,canonical);
  compact.render([b],()=>assert.deepEqual(root.children,[b]));
});
