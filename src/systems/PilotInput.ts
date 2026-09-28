import type { Controls } from '../game/types';

const FLIGHT_KEYS = new Set(['KeyW', 'KeyZ', 'KeyS', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'KeyA', 'KeyQ', 'ArrowRight', 'KeyD', 'KeyJ', 'KeyL', 'Space']);

export class PilotInput {
  readonly controls: Controls = { throttle: 0, pitch: 0, roll: 0, rudder: 0, brake: false };
  private readonly held = new Set<string>();
  private readonly element: HTMLElement;
  private enabledValue = true;
  private disposed = false;

  constructor(element: HTMLElement) {
    this.element = element;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  get enabled(): boolean { return this.enabledValue; }
  set enabled(value: boolean) {
    this.enabledValue = value;
    if (!value) this.reset();
  }

  reset(): void {
    this.held.clear();
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.reset();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabledValue || !FLIGHT_KEYS.has(event.code)) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    this.held.add(event.code);
    this.refresh();
    if (document.activeElement === document.body && this.element.tabIndex >= 0) this.element.focus({ preventScroll: true });
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (!FLIGHT_KEYS.has(event.code)) return;
    if (this.enabledValue && this.held.has(event.code)) event.preventDefault();
    this.held.delete(event.code);
    this.refresh();
  };

  private readonly onBlur = (): void => { this.reset(); };
  private readonly onVisibility = (): void => { if (document.hidden) this.reset(); };

  private refresh(): void {
    const held = this.held;
    const c = this.controls;
    c.throttle = Number(held.has('KeyW') || held.has('KeyZ')) - Number(held.has('KeyS'));
    c.pitch = Number(held.has('ArrowDown')) - Number(held.has('ArrowUp'));
    c.roll = Number(held.has('ArrowRight') || held.has('KeyD')) - Number(held.has('ArrowLeft') || held.has('KeyA') || held.has('KeyQ'));
    c.rudder = Number(held.has('KeyL')) - Number(held.has('KeyJ'));
    c.brake = held.has('Space');
  }
}
