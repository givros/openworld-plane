import './styles.css';
import { Game } from './game/Game';

const app=document.querySelector<HTMLElement>('#app')!;
const startup=new AbortController();
let game:Game|undefined;
if(import.meta.hot)import.meta.hot.dispose(()=>{startup.abort();game?.dispose();});
Game.create(app,startup.signal).then(created=>{
  if(startup.signal.aborted)created.dispose();else game=created;
}).catch((error:unknown)=>{
  if(startup.signal.aborted)return;
  const loading=app.querySelector('#loading');
  if(loading){
    loading.innerHTML='<span>07</span><p>THE WORLD COULD NOT LOAD</p><p>Reload to try again.</p>';
    const detail=document.createElement('p');detail.textContent=error instanceof Error?error.message:'The environment could not be prepared.';loading.append(detail);
  }
  console.error(error);
});
