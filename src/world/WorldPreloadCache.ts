export interface WorldPreloadCacheOptions {
  readBinary:(path:string,signal:AbortSignal)=>Promise<ArrayBuffer>;
  readJSON:(path:string,signal:AbortSignal)=>Promise<unknown>;
  signal?:AbortSignal;
  concurrency?:number;
}

export interface WorldPreloadStats {
  completed:number;
  total:number;
  bytes:number;
  jsonEntries:number;
  binaryEntries:number;
  dedupAliases:number;
  cacheHits:number;
  networkReads:number;
  pending:number;
  complete:boolean;
}

type Entry = {
  kind:'binary'|'json';path:string;expectedBytes?:number;contentKey?:string;
  status:'planned'|'queued'|'loading'|'ready';value?:unknown;
  promise?:Promise<unknown>;resolve?:(value:unknown)=>void;reject?:(error:unknown)=>void;
};
const cancelled=()=>new DOMException('World preload was cancelled.','AbortError');

/**
 * Owns raw asset data for one world lifetime, independently of GPU resource leases.
 * Returned buffers and decoded JSON are borrowed immutable data: callers must not
 * mutate them or transfer/detach their backing buffers.
 */
export class WorldPreloadCache {
  private readonly paths=new Map<string,Entry>();
  private readonly contents=new Map<string,Entry>();
  private readonly entries=new Set<Entry>();
  private readonly controller=new AbortController();
  private readonly concurrency:number;
  private readonly queue:Entry[]=[];
  private queueOffset=0;
  private active=0;
  private pending=0;
  private completed=0;
  private bytes=0;
  private jsonEntries=0;
  private binaryEntries=0;
  private dedupAliases=0;
  private cacheHits=0;
  private networkReads=0;
  private closed=false;
  private terminalError:unknown;
  private readonly progress=new Set<(stats:WorldPreloadStats)=>void>();
  private readonly onLifetimeAbort=()=>this.close(cancelled());

  constructor(private readonly options:WorldPreloadCacheOptions){
    this.concurrency=options.concurrency??4;
    if(!Number.isSafeInteger(this.concurrency)||this.concurrency<1)throw new Error('Preload concurrency must be a positive integer.');
    if(options.signal?.aborted)this.close(cancelled());
    else options.signal?.addEventListener('abort',this.onLifetimeAbort,{once:true});
  }

  private assertOpen():void{if(this.closed)throw this.terminalError;}
  private validatePath(path:string):void{
    if(typeof path!=='string'||!path.length)throw new Error('Preload asset path must not be empty.');
  }

  /** A supplied content key must be a manifest SHA-256, paired with its exact byte length. */
  addBinary(path:string,expectedBytes?:number,contentKey?:string):void{
    this.assertOpen();this.validatePath(path);
    if(expectedBytes!==undefined&&(!Number.isSafeInteger(expectedBytes)||expectedBytes<0))throw new Error('Invalid preload byte length.');
    if(contentKey!==undefined&&(!/^[a-f\d]{64}$/i.test(contentKey)||expectedBytes===undefined))
      throw new Error('A preload content key requires a SHA-256 and exact byte length.');
    const key=contentKey?.toLowerCase();
    const current=this.paths.get(path);
    const sameContent=key===undefined?undefined:this.contents.get(key);
    if(sameContent&&sameContent.expectedBytes!==expectedBytes)throw new Error('Conflicting byte lengths for identical preload content.');
    if(current){
      if(current.kind!=='binary'||(expectedBytes!==undefined&&current.expectedBytes!==undefined&&expectedBytes!==current.expectedBytes)||
        (key!==undefined&&current.contentKey!==undefined&&current.contentKey!==key)||
        (sameContent!==undefined&&sameContent!==current))throw new Error(`Conflicting preload definition: ${path}`);
      if(expectedBytes!==undefined){
        if(current.status==='ready'&&(current.value as ArrayBuffer).byteLength!==expectedBytes)throw new Error(`Preload byte length changed: ${path}`);
        current.expectedBytes=expectedBytes;
      }
      if(key!==undefined){current.contentKey=key;this.contents.set(key,current);}
      return;
    }
    if(sameContent){this.paths.set(path,sameContent);this.dedupAliases++;return;}
    const entry:Entry={kind:'binary',path,expectedBytes,contentKey:key,status:'planned'};
    this.paths.set(path,entry);this.entries.add(entry);
    if(key!==undefined)this.contents.set(key,entry);
  }

  addJSON(path:string):void{
    this.assertOpen();this.validatePath(path);
    const current=this.paths.get(path);
    if(current){if(current.kind!=='json')throw new Error(`Conflicting preload definition: ${path}`);return;}
    const entry:Entry={kind:'json',path,status:'planned'};
    this.paths.set(path,entry);this.entries.add(entry);
  }

  async readBinary(path:string,signal?:AbortSignal):Promise<ArrayBuffer>{
    this.assertOpen();if(signal?.aborted)throw cancelled();
    this.addBinary(path);
    return this.read(this.paths.get(path)!,signal) as Promise<ArrayBuffer>;
  }

  async readJSON<T=unknown>(path:string,signal?:AbortSignal):Promise<T>{
    this.assertOpen();if(signal?.aborted)throw cancelled();
    this.addJSON(path);
    return this.read(this.paths.get(path)!,signal) as Promise<T>;
  }

  private read(entry:Entry,signal?:AbortSignal):Promise<unknown>{
    if(entry.status!=='planned')this.cacheHits++;
    const shared=this.ensure(entry);
    if(!signal)return shared;
    return new Promise((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener('abort',abort);reject(cancelled());};
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted){abort();return;}
      shared.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{
        signal.removeEventListener('abort',abort);reject(error);
      });
    });
  }

  /** Additional assets may be planned and preloaded in subsequent phases. */
  async preload(onProgress?:(stats:WorldPreloadStats)=>void):Promise<void>{
    this.assertOpen();
    const notify=(stats:WorldPreloadStats)=>{
      try{onProgress?.(stats);}catch(error){this.close(error);}
    };
    if(onProgress)this.progress.add(notify);
    try{
      notify(this.stats);
      this.assertOpen();
      const requested=Array.from(this.entries,entry=>this.ensure(entry));
      await Promise.all(requested);
      this.assertOpen();notify(this.stats);
      this.assertOpen();
    }catch(error){this.close(error);throw error;}
    finally{this.progress.delete(notify);}
  }

  private ensure(entry:Entry):Promise<unknown>{
    this.assertOpen();
    if(entry.promise)return entry.promise;
    entry.promise=new Promise((resolve,reject)=>{entry.resolve=resolve;entry.reject=reject;});
    // A queued entry may be cancelled before an individual caller installs its handler.
    void entry.promise.catch(()=>{});
    entry.status='queued';this.pending++;this.queue.push(entry);this.pump();
    return entry.promise;
  }

  private pump():void{
    while(!this.closed&&this.active<this.concurrency&&this.queueOffset<this.queue.length){
      const entry=this.queue[this.queueOffset++];entry.status='loading';this.active++;
      void Promise.resolve().then(async()=>{
        this.assertOpen();this.networkReads++;
        const value=entry.kind==='binary'
          ?await this.options.readBinary(entry.path,this.controller.signal)
          :await this.options.readJSON(entry.path,this.controller.signal);
        this.assertOpen();
        if(entry.kind==='binary'){
          if(!(value instanceof ArrayBuffer))throw new Error(`Preload did not return an ArrayBuffer: ${entry.path}`);
          if(entry.expectedBytes!==undefined&&value.byteLength!==entry.expectedBytes)throw new Error(`Preload byte length changed: ${entry.path}`);
          this.bytes+=value.byteLength;this.binaryEntries++;
        }else this.jsonEntries++;
        entry.value=value;entry.status='ready';this.completed++;this.pending--;
        entry.resolve!(value);entry.resolve=undefined;entry.reject=undefined;
        const stats=this.stats;for(const notify of this.progress)notify(stats);
      }).catch(error=>this.close(error)).finally(()=>{
        if(!this.closed){this.active--;this.pump();}
      });
    }
    if(this.queueOffset===this.queue.length){this.queue.length=0;this.queueOffset=0;}
  }

  get stats():WorldPreloadStats{
    return{completed:this.completed,total:this.entries.size,bytes:this.bytes,jsonEntries:this.jsonEntries,
      binaryEntries:this.binaryEntries,dedupAliases:this.dedupAliases,cacheHits:this.cacheHits,
      networkReads:this.networkReads,pending:this.pending,complete:!this.closed&&this.completed===this.entries.size};
  }

  private close(error:unknown):void{
    if(this.closed)return;
    this.closed=true;this.terminalError=error;
    this.options.signal?.removeEventListener('abort',this.onLifetimeAbort);
    this.controller.abort();
    for(const entry of this.entries){entry.reject?.(error);entry.resolve=undefined;entry.reject=undefined;entry.value=undefined;entry.promise=undefined;}
    this.paths.clear();this.contents.clear();this.entries.clear();this.queue.length=0;this.queueOffset=0;
    this.active=0;this.pending=0;this.completed=0;this.bytes=0;this.binaryEntries=0;this.jsonEntries=0;this.dedupAliases=0;
    this.progress.clear();
  }

  dispose():void{this.close(cancelled());}
}
