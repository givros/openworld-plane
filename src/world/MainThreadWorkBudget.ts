/** Share a small CPU preparation budget across concurrent landscape requests.
 * Work itself stays synchronous; yielding happens only between atomic units.
 * Callers recheck in a loop after awaiting: another resumed request may consume
 * the next budget first. */
export class MainThreadWorkBudget {
  private spent=0;
  private pending:Promise<void>|null=null;
  private budget=3;

  constructor(milliseconds=3){
    this.setLimit(milliseconds);
  }

  get limit():number{return this.budget;}
  setLimit(milliseconds:number):void{
    if(!Number.isFinite(milliseconds)||milliseconds<0)throw new Error('Invalid landscape commit budget.');
    this.budget=Math.max(.01,milliseconds);
  }

  charge(milliseconds:number):void{this.spent+=Math.max(0,milliseconds);}

  checkpoint():Promise<void>|undefined{
    if(this.spent<this.budget)return undefined;
    if(!this.pending)this.pending=new Promise<void>(resolve=>{
      let finished=false,frame:number|undefined,timer:ReturnType<typeof setTimeout>;
      const resume=()=>{
        if(finished)return;finished=true;clearTimeout(timer);
        if(frame!==undefined&&typeof cancelAnimationFrame==='function')cancelAnimationFrame(frame);
        this.spent=0;this.pending=null;resolve();
      };
      if(typeof requestAnimationFrame==='function'&&typeof document!=='undefined'&&!document.hidden){
        // A tab can become hidden after this check, suspending its pending RAF.
        // The fallback still allows cancellation and resource disposal to settle.
        timer=setTimeout(resume,100);frame=requestAnimationFrame(resume);
      }else timer=setTimeout(resume,0);
    });
    return this.pending;
  }
}
