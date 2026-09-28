import { clamp, type FlightState, type GameMode } from '../game/types';

const icons = {
  reset: '<path d="M4 9a8 8 0 1 1 0 6M4 3v6h6"/>',
  sound: '<path d="M11 5 6 9H3v6h3l5 4zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 5 6 9H3v6h3l5 4zM16 9l6 6m0-6-6 6"/>',
  full: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  exit: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>',
  paint: '<path d="m12 3 7 7a8 8 0 1 1-14 0zM5 14h14"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  play: '<path d="m8 4 13 8-13 8z"/>',
};
const svg=(name:keyof typeof icons):string=>`<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
export const attitudePitch = (pitch:number):number => clamp(pitch*58,-26,26);
export const attitudeBank = (bank:number):number => clamp(bank*180/Math.PI,-50,50);
export const attitudeTransform = (pitch:number,bank:number): { pitch:number; bank:number } => ({ pitch:attitudePitch(pitch), bank:attitudeBank(bank) });
export interface HudActions { manual():void; autopilot():void; reset():void; sound():boolean; fullscreen():void; paint(hex:string):void; camera(index:number):void; biome(id:string):void; }
export class FlightHud {
  readonly root: HTMLDivElement;
  private readonly speed:HTMLElement;
  private readonly altitude:HTMLElement;
  private readonly rpm:HTMLElement;
  private readonly throttle:HTMLElement;
  private readonly attitude:HTMLElement;
  private readonly alert:HTMLElement;
  private readonly status:HTMLElement;
  private readonly biome:HTMLElement;
  private readonly coords:HTMLElement;
  private readonly heading:HTMLElement;
  private readonly progress:HTMLElement;
  private readonly timelineLabel:HTMLElement;
  private readonly colorInput:HTMLInputElement;
  private readonly paintReadout:HTMLElement;
  private readonly paintPanel:HTMLElement;
  private readonly soundButton:HTMLButtonElement;
  private readonly fullscreenButton:HTMLButtonElement;
  private timer=0;
  private lastMode='';
  constructor(app:HTMLElement,actions:HudActions,paint:string) {
    this.root=document.createElement('div');this.root.id='flight-ui';this.root.dataset.mode='inspection';
    this.root.innerHTML=`
      <div class="cinema-bar top"></div><div class="cinema-bar bottom"></div>
      <header class="brand"><div class="brand-emblem"><span>7</span><i></i><i></i><i></i></div><div><p class="eyebrow">FIELD OPERATIONS · AIRCRAFT 07</p><h1>CROPPER SEVEN<span class="edition">ASTRAL</span></h1></div></header>
      <nav class="utility" aria-label="Experience controls">
        <button id="paint-button" class="utility-button paint-button" aria-expanded="false" aria-controls="paint-panel">${svg('paint')}<span>PAINT</span></button>
        <div class="utility-divider"></div>
        <button id="reset-button" class="utility-button" title="Reset aircraft (R)" aria-label="Reset aircraft">${svg('reset')}</button>
        <button id="sound-button" class="utility-button" title="Mute sound" aria-label="Mute sound" aria-pressed="false">${svg('sound')}</button>
        <button id="fullscreen-button" class="utility-button" title="Enter fullscreen (F)" aria-label="Enter fullscreen">${svg('full')}</button>
      </nav>
      <section id="paint-panel" class="paint-panel" aria-label="Aircraft paint" hidden>
        <div class="panel-heading"><span>MAKE IT YOURS</span><span>06 / COLORS</span></div><h2>Aircraft paint</h2>
        <div class="swatches">${[['Crop orange','#ed870c'],['Racing red','#c84732'],['Aero blue','#3479a8'],['Forest green','#4c7650'],['Desert gold','#c7952e'],['Graphite','#3a4146']].map(([name,color])=>`<button class="swatch" data-color="${color}" style="--swatch:${color}" aria-label="${name}" title="${name}"></button>`).join('')}</div>
        <label class="custom-paint"><span>Custom color</span><input id="custom-paint" type="color" value="${paint}" aria-label="Custom aircraft color"><output id="paint-readout">${paint.toUpperCase()}</output></label>
      </section>
      <section class="telemetry" aria-label="Flight instruments">
        <div><span class="instrument-label">IAS <small>KTS</small></span><strong id="speed">000</strong></div>
        <div><span class="instrument-label">ALT <small>FT</small></span><strong id="altitude">000</strong></div>
        <div><span class="instrument-label">ENGINE</span><strong id="rpm">0720</strong></div>
        <div><span class="instrument-label">POWER</span><strong id="throttle">00<small>%</small></strong></div>
      </section>
      <div class="flight-alert" id="flight-alert" role="status"></div>
      <div class="attitude" aria-label="Aircraft attitude"><div class="attitude-window"><div id="attitude-horizon"><i></i><span></span><span></span></div></div><div class="attitude-aircraft"><b></b><i></i><b></b></div><div class="attitude-ticks"></div></div>
      <aside class="camera-presets" aria-label="Aircraft inspection views"><span>INSPECT</span>${['Front','Side','Rear','Above'].map((name,i)=>`<button data-camera="${i}" aria-label="${name} inspection" title="${name} view (${i+1})"><b>0${i+1}</b><span>${name}</span></button>`).join('')}<i></i></aside>
      <section class="start-panel"><div class="readiness"><span class="status-dot"></span> PREFLIGHT COMPLETE <span class="readiness-rule"></span> <b>07</b></div><h2>Good skies ahead.</h2><p>A little grit. A lot of altitude.</p>
        <div class="start-actions"><button id="manual-button" class="start-action primary"><span class="action-label">MANUAL FLIGHT</span><strong>TAKE CONTROLS ${svg('arrow')}</strong><span class="action-footer">YOUR AIRCRAFT. YOUR HORIZON.<kbd>↵</kbd></span></button>
        <button id="autopilot-button" class="start-action secondary"><span class="action-label">AUTOPILOT SHOWCASE</span><strong>WATCH CINEMATIC ${svg('play')}</strong><span class="action-footer">A FLIGHT AROUND SEVEN FIELD.<span>55 SEC</span></span></button></div>
      </section>
      <nav class="biome-destinations" aria-label="Explore the four biomes"><span>FOUR HORIZONS</span>${[['verdant-airfield','Airfield'],['azure-port','Azure Port'],['alpine-lake','Alpine Lake'],['sunstone-oasis','Oasis']].map(([id,label],index)=>`<button data-biome="${id}" title="Start a flight over ${label}"><small>0${index+1}</small>${label}</button>`).join('')}</nav>
      <div class="inspection-hint"><span class="mouse-icon"></span> DRAG TO ORBIT <i>·</i> SCROLL TO ZOOM <i>·</i> SHIFT + DRAG TO PAN</div>
      <div class="controls-guide"><kbd>W / Z</kbd> POWER <span>·</span> <kbd>↑ ↓</kbd> PITCH <span>·</span> <kbd>← →</kbd> BANK <span>·</span> <kbd>J / L</kbd> RUDDER <span>·</span> <kbd>SPACE</kbd> BRAKE</div>
      <section class="cinematic-timeline" aria-label="Cinematic progress"><div><span class="status-dot"></span><span id="timeline-label">ANTICIPATION</span><span>00:55</span></div><div class="timeline-track"><i id="timeline-progress"></i></div></section>
      <footer class="location"><div class="compass"><span>N</span><i id="heading-arrow"></i><b id="heading">000°</b></div><div><span class="location-kicker">FREE FLIGHT / <span id="phase-label">ON THE GROUND</span></span><strong id="biome-name">VERDANT AIRFIELD</strong><small id="coordinates">SEVEN FIELD · RWY 18 / 36</small></div><span class="location-mark">07</span></footer>
      <div class="desktop-notice">CROPPER SEVEN is built for a desktop keyboard and mouse.<br>Use a window at least 900 pixels wide.</div>`;
    app.append(this.root);
    const el=<T extends HTMLElement>(id:string):T=>this.root.querySelector<T>('#'+id)!;
    this.speed=el('speed');this.altitude=el('altitude');this.rpm=el('rpm');this.throttle=el('throttle');this.attitude=el('attitude-horizon');this.alert=el('flight-alert');this.status=el('phase-label');this.biome=el('biome-name');this.coords=el('coordinates');this.heading=el('heading');this.progress=el('timeline-progress');this.timelineLabel=el('timeline-label');this.colorInput=el('custom-paint');this.paintReadout=el('paint-readout');this.paintPanel=el('paint-panel');this.soundButton=el('sound-button');this.fullscreenButton=el('fullscreen-button');
    el('manual-button').onclick=actions.manual;el('autopilot-button').onclick=actions.autopilot;el('reset-button').onclick=actions.reset;
    this.soundButton.onclick=()=>this.setMuted(actions.sound());this.fullscreenButton.onclick=actions.fullscreen;
    if(!document.fullscreenEnabled)this.fullscreenButton.hidden=true;
    el('paint-button').onclick=()=>{this.paintPanel.hidden=!this.paintPanel.hidden;el('paint-button').setAttribute('aria-expanded',String(!this.paintPanel.hidden));};
    this.root.querySelectorAll<HTMLButtonElement>('.swatch').forEach(button=>button.onclick=()=>{actions.paint(button.dataset.color!);this.setPaint(button.dataset.color!);});
    this.colorInput.oninput=()=>{actions.paint(this.colorInput.value);this.setPaint(this.colorInput.value);};
    this.root.querySelectorAll<HTMLButtonElement>('[data-camera]').forEach(button=>button.onclick=()=>actions.camera(Number(button.dataset.camera)));
    this.root.querySelectorAll<HTMLButtonElement>('[data-biome]').forEach(button=>button.onclick=()=>actions.biome(button.dataset.biome!));
    this.setPaint(paint);
  }
  setPaint(hex:string):void {this.colorInput.value=hex;this.paintReadout.textContent=hex.toUpperCase();this.root.querySelectorAll<HTMLButtonElement>('.swatch').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.color===hex.toLowerCase())));}
  setMuted(muted:boolean):void {this.soundButton.innerHTML=svg(muted?'mute':'sound');this.soundButton.setAttribute('aria-pressed',String(muted));this.soundButton.setAttribute('aria-label',muted?'Enable sound':'Mute sound');this.soundButton.title=muted?'Enable sound':'Mute sound';}
  setFullscreen(active:boolean):void {this.fullscreenButton.innerHTML=svg(active?'exit':'full');this.fullscreenButton.setAttribute('aria-label',active?'Exit fullscreen':'Enter fullscreen');this.fullscreenButton.title=(active?'Exit':'Enter')+' fullscreen (F)';}
  setCamera(index:number):void {this.root.classList.add('focused-inspection');this.root.querySelectorAll<HTMLButtonElement>('[data-camera]').forEach(b=>b.classList.toggle('selected',Number(b.dataset.camera)===index));}
  update(dt:number,mode:GameMode,s:FlightState,biomeLabel:string):void {
    if(this.lastMode!==mode){this.root.dataset.mode=mode;this.lastMode=mode;this.paintPanel.hidden=true;this.root.querySelector('#paint-button')?.setAttribute('aria-expanded','false');}
    this.attitude.style.setProperty('--attitude-pitch',attitudePitch(s.pitch).toFixed(2)+'px');
    this.attitude.style.setProperty('--attitude-bank',attitudeBank(s.bank).toFixed(2)+'deg');
    this.timer+=dt;if(this.timer<.1)return;this.timer=0;
    this.speed.textContent=Math.round(s.speed*1.94384).toString().padStart(3,'0');
    this.altitude.textContent=Math.round(Math.max(0,s.altitude)*3.28084).toString().padStart(3,'0');
    this.rpm.textContent=Math.round(s.rpm).toString().padStart(4,'0');this.throttle.textContent=Math.round(s.throttle*100).toString().padStart(2,'0')+'%';
    this.biome.textContent=biomeLabel.toUpperCase();this.status.textContent=s.phase.replaceAll('-',' ').toUpperCase();
    const near=Math.hypot(s.position.x,s.position.z)<600;
    this.coords.textContent=near?'SEVEN FIELD · RWY 18 / 36':`${Math.round(s.position.x).toLocaleString('en-US')} E  /  ${Math.round(s.position.z).toLocaleString('en-US')} N`;
    this.heading.textContent=(((s.yaw*180/Math.PI)%360+360)%360).toFixed(0).padStart(3,'0')+'°';
    (this.root.querySelector('#heading-arrow') as HTMLElement).style.transform=`rotate(${-s.yaw}rad)`;
    let alert='';
    if(s.crashed)alert='AIRCRAFT STOPPED — PRESS R TO RESET';
    else if(mode==='manual'){
      if(s.stallSeverity>.55&&!s.grounded)alert='STALL — LOWER THE NOSE';
      else if(s.phase==='touchdown'||s.phase==='rollout')alert='LANDED — BRAKE OR ADD POWER';
      else if(s.phase==='manual-ready')alert=s.landings?'READY — ADD POWER TO TAKE OFF AGAIN':'READY — HOLD W TO ADD POWER';
      else if(s.grounded&&s.speed>28)alert='ROTATE — HOLD ↓';
      else if(!s.grounded&&s.altitude<9&&s.verticalSpeed<-.4)alert='FLARE — PULL ↓';
    } else if(mode==='autopilot'&&s.phase==='complete')alert='FLIGHT COMPLETE — TAKE THE CONTROLS OR PRESS R';
    this.alert.textContent=alert;this.alert.classList.toggle('visible',!!alert);this.alert.classList.toggle('danger',s.crashed||s.stallSeverity>.55);
    this.progress.style.transform=`scaleX(${clamp(s.elapsed/55.2)})`;this.timelineLabel.textContent=s.phase.replaceAll('-',' ').toUpperCase();
  }
  dispose():void {this.root.remove();}
}

