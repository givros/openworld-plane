/// <reference types="vite/client" />
import type { ExperienceAPI, Game } from './game/Game';
declare global {
  interface Window { __AIRPLANE_EXPERIENCE__:ExperienceAPI; __THREE_GAME_DIAGNOSTICS__:Game['diagnostics']; }
}
