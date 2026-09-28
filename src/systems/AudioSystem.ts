import { clamp, type FlightState } from '../game/types';

export type AudioCue='start'|'liftoff'|'approach'|'complete'|'reset'|'touchdown';
export class AudioSystem {
  muted=false;
  private context:AudioContext|null=null;
  private master:GainNode|null=null;
  private engineGain:GainNode|null=null;
  private windGain:GainNode|null=null;
  private ambientGain:GainNode|null=null;
  private engineFilter:BiquadFilterNode|null=null;
  private windFilter:BiquadFilterNode|null=null;
  private first:OscillatorNode|null=null;
  private second:OscillatorNode|null=null;
  private noise:AudioBuffer|null=null;
  private readonly loops:AudioScheduledSourceNode[]=[];
  private readonly events:Record<AudioCue,number>={start:0,liftoff:0,approach:0,complete:0,reset:0,touchdown:0};
  private disposed=false;
  constructor(){document.addEventListener('visibilitychange',this.visibility);}
  unlock():void {
    if(this.disposed)return;
    if(this.context){if(this.context.state==='suspended')void this.context.resume();return;}
    const ctx=new AudioContext();this.context=ctx;
    this.master=ctx.createGain();this.master.gain.value=this.muted?0:.72;this.master.connect(ctx.destination);
    this.engineGain=ctx.createGain();this.engineGain.gain.value=0;
    this.engineFilter=ctx.createBiquadFilter();this.engineFilter.type='lowpass';this.engineFilter.frequency.value=240;
    this.engineFilter.connect(this.engineGain).connect(this.master);
    this.first=ctx.createOscillator();this.first.type='sawtooth';this.first.frequency.value=18;this.first.connect(this.engineFilter);this.first.start();
    this.second=ctx.createOscillator();this.second.type='square';this.second.frequency.value=36.36;
    const harmonicGain=ctx.createGain();harmonicGain.gain.value=.28;this.second.connect(harmonicGain).connect(this.engineFilter);this.second.start();this.loops.push(this.first,this.second);
    this.noise=ctx.createBuffer(1,ctx.sampleRate*3,ctx.sampleRate);const samples=this.noise.getChannelData(0);let seed=7012;
    for(let i=0;i<samples.length;i++){seed=(Math.imul(seed,1664525)+1013904223)|0;samples[i]=(seed>>>0)/2147483648-1;}
    this.windGain=ctx.createGain();this.windGain.gain.value=0;this.windFilter=ctx.createBiquadFilter();this.windFilter.type='bandpass';this.windFilter.Q.value=.7;this.windFilter.connect(this.windGain).connect(this.master);
    const wind=ctx.createBufferSource();wind.buffer=this.noise;wind.loop=true;wind.connect(this.windFilter);wind.start();this.loops.push(wind);
    this.ambientGain=ctx.createGain();this.ambientGain.gain.value=.025;const ambientFilter=ctx.createBiquadFilter();ambientFilter.type='lowpass';ambientFilter.frequency.value=520;ambientFilter.connect(this.ambientGain).connect(this.master);
    const ambient=ctx.createBufferSource();ambient.buffer=this.noise;ambient.loop=true;ambient.playbackRate.value=.73;ambient.connect(ambientFilter);ambient.start();this.loops.push(ambient);
    void ctx.resume();
  }
  toggle():boolean {this.unlock();this.muted=!this.muted;this.master?.gain.setTargetAtTime(this.muted?0:.72,this.context!.currentTime,.012);return this.muted;}
  private readonly visibility=():void=>{if(!this.context)return;if(document.hidden)void this.context.suspend();else void this.context.resume();};
  update(s:FlightState):void {
    const ctx=this.context;if(!ctx||!this.engineGain||!this.first||!this.second||!this.engineFilter||!this.windFilter||!this.windGain||!this.ambientGain)return;
    const rpm=clamp(s.rpm/2500),speed=clamp(s.speed/78),t=ctx.currentTime;
    this.first.frequency.setTargetAtTime(18+rpm*54,t,.06);this.second.frequency.setTargetAtTime((18+rpm*54)*2.02,t,.06);
    this.engineFilter.frequency.setTargetAtTime(240+rpm*1500,t,.06);this.engineGain.gain.setTargetAtTime(s.crashed?0:.008+rpm*.17,t,.08);
    this.windFilter.frequency.setTargetAtTime(480+speed*2100,t,.12);this.windGain.gain.setTargetAtTime(.006+speed*.095,t,.12);
    this.ambientGain.gain.setTargetAtTime(.025*(1-speed*.55),t,.12);
  }
  cue(name:AudioCue):void {
    const ctx=this.context;if(!ctx||!this.master)return;this.events[name]++;
    const gain=ctx.createGain();const t=ctx.currentTime;gain.gain.setValueAtTime(.0001,t);gain.gain.exponentialRampToValueAtTime(name==='touchdown'?.18:.055,t+.015);gain.gain.exponentialRampToValueAtTime(.0001,t+.4);gain.connect(this.master);
    if(name==='touchdown'){
      const source=ctx.createBufferSource();source.buffer=this.noise;const filter=ctx.createBiquadFilter();filter.type='lowpass';filter.frequency.setValueAtTime(230,t);filter.frequency.exponentialRampToValueAtTime(55,t+.36);source.connect(filter).connect(gain);source.start();source.stop(t+.42);source.onended=()=>{source.disconnect();filter.disconnect();gain.disconnect();};
    }else{
      const pitches={start:[420,710],liftoff:[540,760],approach:[390,330],complete:[520,820],reset:[520,300]};const p=pitches[name];
      const source=ctx.createOscillator();source.type='triangle';source.frequency.setValueAtTime(p[0],t);source.frequency.exponentialRampToValueAtTime(p[1],t+.3);source.connect(gain);source.start();source.stop(t+.42);source.onended=()=>{source.disconnect();gain.disconnect();};
    }
  }
  get diagnostics(){return{unlocked:!!this.context,state:this.context?.state??'locked',muted:this.muted,loopSources:this.loops.length,masterGain:this.master?.gain.value??0,events:{...this.events}};}
  dispose():void {if(this.disposed)return;this.disposed=true;document.removeEventListener('visibilitychange',this.visibility);for(const s of this.loops){s.stop();s.disconnect();}this.loops.length=0;void this.context?.close();this.context=null;}
}
