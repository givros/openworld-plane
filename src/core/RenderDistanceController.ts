/** Adapts only visibility distance from intervals between actually rendered frames. */
export interface RenderDistanceSample {
  nowMs:number;
  frameDurationMs:number;
  rendered:boolean;
  ready:boolean;
  pendingLoads:number;
  initialLoad?:boolean;
}

export interface RenderDistanceOptions {
  targetFps?:number;
  minimumDistance?:number;
  maximumDistance?:number;
  initialDistance?:number;
  recoveryMs?:number;
}

type SkipReason='initializing'|'manual-override'|'invalid-sample'|'not-rendered'|'loading'|'recovery'|null;
const clamp=(value:number,minimum:number,maximum:number)=>Math.min(maximum,Math.max(minimum,value));

/**
 * This controller has no renderer dependency and changes no shading or asset data.
 * Call update once per observed image completion, or mark skipped draws rendered:false.
 * Feed elapsed time between images, including slow frames, rather than CPU submission
 * time or RAF-only cadence. Visible loading and its recovery interval are excluded.
 */
export class RenderDistanceController {
  readonly minimumDistance:number;
  readonly maximumDistance:number;
  readonly targetFps:number;
  private readonly recoveryMs:number;
  private current:number;
  private target:number;
  private override:number|null=null;
  private previousNow:number|null=null;
  private eligibleAfterMs=Infinity;
  private nextDecreaseAtMs=0;
  private nextIncreaseAtMs=0;
  private lastAssessmentMs=-Infinity;
  private samples:number[]=[];
  private evidenceMs=0;
  private acceptedFrames=0;
  private skippedFrames=0;
  private decisions=0;
  private lastReason:SkipReason='initializing';
  private lastP75Ms:number|null=null;
  private lastP95Ms:number|null=null;

  constructor(options:RenderDistanceOptions={}) {
    this.minimumDistance=options.minimumDistance??100;
    this.maximumDistance=options.maximumDistance??300;
    this.targetFps=options.targetFps??30;
    this.recoveryMs=options.recoveryMs??1000;
    const initial=options.initialDistance??this.maximumDistance;
    if(![this.minimumDistance,this.maximumDistance,this.targetFps,initial,this.recoveryMs].every(Number.isFinite)||
      this.minimumDistance<=0||this.maximumDistance<this.minimumDistance||this.targetFps<=0||this.recoveryMs<0)
      throw new Error('Render distance options must be finite, positive and ordered.');
    this.current=clamp(initial,this.minimumDistance,this.maximumDistance);this.target=this.current;
  }

  get distance():number{return this.current;}
  get targetDistance():number{return this.target;}

  /** A deliberate debug/user choice may exceed the automatic ceiling. */
  setOverride(distance:number|null):number {
    if(distance!==null&&(!Number.isFinite(distance)||distance<this.minimumDistance||distance>16000))
      throw new Error(`Manual render distance must be ${this.minimumDistance}–16000 meters, or null.`);
    this.override=distance;this.resetEvidence();
    this.eligibleAfterMs=(this.previousNow??0)+this.recoveryMs;
    if(distance!==null){this.current=distance;this.target=distance;this.lastReason='manual-override';}
    else{this.target=clamp(this.current,this.minimumDistance,this.maximumDistance);this.lastReason='recovery';}
    return this.current;
  }

  update(sample:RenderDistanceSample):number {
    const {nowMs,frameDurationMs}=sample;
    if(!Number.isFinite(nowMs)||nowMs<0||(this.previousNow!==null&&nowMs<this.previousNow)||
      !Number.isFinite(sample.pendingLoads)||sample.pendingLoads<0) {
      this.skippedFrames++;this.lastReason='invalid-sample';this.resetEvidence();return this.current;
    }
    const first=this.previousNow===null;
    // Bound only the smoothing step, never the observed frame duration.
    const deltaSeconds=first?0:Math.min(.25,(nowMs-this.previousNow!)/1000);
    this.previousNow=nowMs;
    if(first)this.eligibleAfterMs=nowMs+this.recoveryMs;
    if(this.override!==null){this.lastReason='manual-override';return this.current;}
    if(sample.initialLoad||!sample.ready||sample.pendingLoads>0){
      this.skippedFrames++;this.lastReason='loading';this.eligibleAfterMs=nowMs+this.recoveryMs;this.resetEvidence();return this.current;
    }
    if(!sample.rendered){
      this.skippedFrames++;this.lastReason='not-rendered';this.resetEvidence();return this.current;
    }
    if(!Number.isFinite(frameDurationMs)||frameDurationMs<=0){
      this.skippedFrames++;this.lastReason='invalid-sample';this.resetEvidence();return this.current;
    }
    if(nowMs<this.eligibleAfterMs){this.skippedFrames++;this.lastReason='recovery';return this.current;}
    this.lastReason=null;this.acceptedFrames++;
    this.samples.push(frameDurationMs);if(this.samples.length>120)this.samples.shift();
    this.evidenceMs+=frameDurationMs;
    if(nowMs-this.lastAssessmentMs>=250&&this.samples.length>=8){
      this.lastAssessmentMs=nowMs;
      const sorted=[...this.samples].sort((a,b)=>a-b),budget=1000/this.targetFps;
      const percentile=(fraction:number)=>sorted[Math.ceil(sorted.length*fraction)-1];
      this.lastP75Ms=percentile(.75);this.lastP95Ms=percentile(.95);
      if(this.evidenceMs>=1500&&this.lastP75Ms>budget*1.08&&nowMs>=this.nextDecreaseAtMs&&this.target>this.minimumDistance){
        const factor=clamp(Math.sqrt(budget/this.lastP75Ms),.72,.94);
        this.target=Math.max(this.minimumDistance,this.target*factor);this.recordDecision(nowMs);
      }else if(this.samples.length>=60&&this.evidenceMs>=4000&&this.lastP95Ms<budget*.8&&
        nowMs>=this.nextIncreaseAtMs&&this.target<this.maximumDistance){
        this.target=Math.min(this.maximumDistance,this.target*1.08);this.recordDecision(nowMs);
      }
    }
    const step=(this.target<this.current?60:12)*deltaSeconds;
    this.current+=clamp(this.target-this.current,-step,step);
    return this.current;
  }

  get diagnostics(){return{
    distance:this.current,targetDistance:this.target,manualOverride:this.override,
    minimumDistance:this.minimumDistance,maximumDistance:this.maximumDistance,targetFps:this.targetFps,
    acceptedFrames:this.acceptedFrames,skippedFrames:this.skippedFrames,decisions:this.decisions,
    evidenceFrames:this.samples.length,evidenceMs:this.evidenceMs,p75FrameMs:this.lastP75Ms,p95FrameMs:this.lastP95Ms,
    lastSkipReason:this.lastReason,atMinimum:this.current===this.minimumDistance,
  };}

  private resetEvidence():void {this.samples=[];this.evidenceMs=0;this.lastP75Ms=null;this.lastP95Ms=null;}
  private recordDecision(nowMs:number):void {
    this.decisions++;this.nextDecreaseAtMs=nowMs+2500;this.nextIncreaseAtMs=nowMs+8000;this.resetEvidence();
  }
}
