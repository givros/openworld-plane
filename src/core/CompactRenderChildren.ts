import type { Object3D } from 'three';

interface SiblingOrder { object:Object3D; rank:number; previous?:SiblingOrder; next?:SiblingOrder; }
interface ChildSelection {
  object:Object3D;
  canonical:Object3D[];
  count:number;
  dirty:boolean;
  order:Map<Object3D,SiblingOrder>;
  first?:SiblingOrder;
  last?:SiblingOrder;
  selected:Object3D[];
  selectedSet:Set<Object3D>;
  generation:number;
  compare:(left:Object3D,right:Object3D)=>number;
}

/** Restricts native rendering to an already-computed selection without changing
 * parent identity, visibility, or the native sibling order. Known mutations use
 * append/remove/placeAfter; arbitrary edits use invalidate as an exact fallback.
 * A separate instance per pass permits a shadow draw inside a beauty draw.
 */
export class CompactRenderChildren {
  private readonly groups=new Map<Object3D,ChildSelection>();
  private readonly touched:ChildSelection[]=[];
  private generation=0;
  private drawing=false;
  private availableChildren=0;
  readonly statistics={draws:0,selectionEntries:0,retainedChildren:0,availableChildren:0,skippedChildren:0,indexRebuilds:0,indexedChildren:0,incrementalEdits:0,orderRenumbers:0};

  constructor(readonly root:Object3D){this.group(root);}

  /** Register a new empty order group before attaching any render leaves. */
  register(parent:Object3D):void {this.assertMutable();this.group(parent);}

  /** O(1) after registration; indexing waits until this group is drawn. */
  invalidate(parent:Object3D):void {
    this.assertMutable();
    const group=this.group(parent);
    this.availableChildren+=parent.children.length-group.count;
    group.count=parent.children.length;
    group.dirty=true;
  }

  /** Call immediately after Object3D.add appends a new child. */
  append(parent:Object3D,child:Object3D):void {
    this.assertMutable();const group=this.group(parent),children=parent.children;
    if(group.dirty||group.canonical!==children||children.length!==group.count+1||
      children[children.length-1]!==child||child.parent!==parent||group.order.has(child)){
      this.invalidate(parent);return;
    }
    const previous=group.last,rank=previous?previous.rank+1024:0;
    if(!Number.isFinite(rank)||previous&&rank<=previous.rank){this.invalidate(parent);return;}
    const entry:SiblingOrder={object:child,rank,previous};
    if(previous)previous.next=entry;else group.first=entry;
    group.last=entry;group.order.set(child,entry);this.updateCount(group);this.statistics.incrementalEdits++;
  }

  /** Call immediately after removing or reparenting the child. */
  remove(parent:Object3D,child:Object3D):void {
    this.assertMutable();const group=this.group(parent),entry=group.order.get(child);
    if(group.dirty||group.canonical!==parent.children||parent.children.length!==group.count-1||!entry){
      this.invalidate(parent);return;
    }
    this.unlink(group,entry);group.order.delete(child);this.updateCount(group);this.statistics.incrementalEdits++;
  }

  /** Call after moving an existing child immediately after its full-pass proxy.
   * Fractional ranks affect only this entry; a rare exhausted gap is reindexed.
   */
  placeAfter(parent:Object3D,child:Object3D,previousChild:Object3D):void {
    this.assertMutable();const group=this.group(parent),entry=group.order.get(child),previous=group.order.get(previousChild);
    if(child===previousChild)throw new Error('A compact render child cannot follow itself');
    if(group.dirty||group.canonical!==parent.children||parent.children.length!==group.count||!entry||!previous){
      this.invalidate(parent);return;
    }
    if(previous.next===entry)return;
    this.unlink(group,entry);
    const next=previous.next,rank=next?previous.rank+(next.rank-previous.rank)/2:previous.rank+1024;
    if(!Number.isFinite(rank)||rank<=previous.rank||next&&rank>=next.rank){
      this.statistics.orderRenumbers++;this.invalidate(parent);return;
    }
    entry.rank=rank;entry.previous=previous;entry.next=next;previous.next=entry;
    if(next)next.previous=entry;else group.last=entry;
    this.statistics.incrementalEdits++;
  }

  /** Input comes from the culler's existing selected lists, not another tree walk.
   * Only selected leaves and their ancestors are visited on each draw. Sorting
   * reads stable ranks; known streaming edits never rescan complete child lists.
   */
  render<T>(selected:readonly Object3D[],draw:()=>T):T {
    if(this.drawing)throw new Error('Nested draws on the same compact render list are unsupported');
    this.generation++;
    this.touched.length=0;
    this.touch(this.group(this.root));
    for(const leaf of selected){
      if(leaf===this.root)throw new Error('Select render leaves rather than the compact render root');
      let child=leaf;
      while(child!==this.root){
        const parent=child.parent;
        if(!parent)throw new Error('Selected object is outside the compact render root');
        const group=this.touch(this.group(parent));
        if(group.selectedSet.has(child))break;
        group.selectedSet.add(child);group.selected.push(child);
        child=parent;
      }
    }
    let retained=0;
    // Finish validation before changing any authoritative child arrays.
    for(const group of this.touched){
      this.index(group);
      for(const child of group.selected)if(!group.order.has(child))throw new Error('Invalidate compact render children after changing sibling membership');
      group.selected.sort(group.compare);
      retained+=group.selected.length;
    }
    Object.assign(this.statistics,{selectionEntries:selected.length,retainedChildren:retained,
      availableChildren:this.availableChildren,skippedChildren:this.availableChildren-retained});
    this.drawing=true;
    for(const group of this.touched)group.object.children=group.selected;
    try{
      const result=draw();
      if(result&&typeof (result as {then?:unknown}).then==='function')throw new Error('Compact render callbacks must be synchronous');
      this.statistics.draws++;
      return result;
    }finally{
      for(const group of this.touched)group.object.children=group.canonical;
      this.drawing=false;
    }
  }

  private group(object:Object3D):ChildSelection {
    const existing=this.groups.get(object);
    if(existing)return existing;
    let ancestor:Object3D|null=object;
    while(ancestor&&ancestor!==this.root)ancestor=ancestor.parent;
    if(!ancestor)throw new Error('Selected object is outside the compact render root');
    const order=new Map<Object3D,SiblingOrder>();
    const group:ChildSelection={object,canonical:object.children,count:object.children.length,dirty:object.children.length>0,order,
      selected:[],selectedSet:new Set(),generation:0,compare:(left,right)=>order.get(left)!.rank-order.get(right)!.rank};
    this.groups.set(object,group);this.availableChildren+=group.count;
    return group;
  }

  private touch(group:ChildSelection):ChildSelection {
    if(group.generation!==this.generation){
      group.generation=this.generation;group.selected.length=0;group.selectedSet.clear();this.touched.push(group);
    }
    return group;
  }

  private index(group:ChildSelection):void {
    const children=group.object.children;
    if(!group.dirty&&group.canonical===children&&group.count===children.length)return;
    this.availableChildren+=children.length-group.count;
    group.canonical=children;group.count=children.length;group.order.clear();group.first=undefined;group.last=undefined;
    for(let index=0;index<children.length;index++){
      const entry:SiblingOrder={object:children[index],rank:index*1024,previous:group.last};
      if(group.last)group.last.next=entry;else group.first=entry;
      group.last=entry;group.order.set(children[index],entry);
    }
    group.dirty=false;this.statistics.indexRebuilds++;this.statistics.indexedChildren+=children.length;
  }

  private updateCount(group:ChildSelection):void {
    this.availableChildren+=group.object.children.length-group.count;group.count=group.object.children.length;
  }

  private unlink(group:ChildSelection,entry:SiblingOrder):void {
    if(entry.previous)entry.previous.next=entry.next;else group.first=entry.next;
    if(entry.next)entry.next.previous=entry.previous;else group.last=entry.previous;
    entry.previous=undefined;entry.next=undefined;
  }

  private assertMutable():void {if(this.drawing)throw new Error('Cannot change compact render children during a draw');}
}
