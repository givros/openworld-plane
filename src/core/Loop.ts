export class Loop {
  private handle = 0;
  private last = 0;
  private nextFrame = 0;
  private running = false;
  constructor(private readonly tick: (dt: number, simulationDt: number, rawDt: number) => void, public targetFps=30) {}
  private readonly frame = (now: number): void => {
    if (!this.running) return;
    const interval=this.targetFps>0?1000/this.targetFps:0;
    if(interval&&this.nextFrame&&now+.25<this.nextFrame){this.handle=requestAnimationFrame(this.frame);return;}
    const raw = this.last ? (now - this.last) / 1000 : 1 / (this.targetFps||60);
    this.last = now;
    if(interval){
      // Preserve the display cadence without replaying missed rendering work.
      // Flight and camera timing below still use actual elapsed wall time.
      this.nextFrame=this.nextFrame?this.nextFrame+Math.max(1,Math.floor((now-this.nextFrame+.25)/interval)+1)*interval:now+interval;
    }
    // Camera damping and preload velocity must use the same elapsed interval
    // as flight simulation. A separate 50 ms presentation cap made a slow
    // frame move the aircraft farther than its camera and preload prediction.
    const elapsed=Math.min(raw,.12);
    this.tick(elapsed,elapsed,raw);
    if(this.running)this.handle = requestAnimationFrame(this.frame);
  };
  start(): void { if (this.running) return; this.running = true; this.last = 0;this.nextFrame=0; this.handle = requestAnimationFrame(this.frame); }
  stop(): void { this.running = false; cancelAnimationFrame(this.handle); this.last = 0;this.nextFrame=0; }
  dispose(): void { this.stop(); }
}
