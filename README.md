# CROPPER SEVEN — Astral

An expressive crop-duster and four connected, Blender-authored biomes: Verdant Airfield, Azure Port, Alpine Lake, and Sunstone Oasis. Fly manually, inspect and repaint the aircraft, or watch its 55-second cinematic flight. The four destination buttons start a flight above each region.

## Play

```sh
npm install
npm run dev
```

Open the local address printed by Vite. A desktop keyboard and mouse and a window at least 900 pixels wide are required.

| Control | Action |
| --- | --- |
| Enter | Take manual controls |
| W / Z, S | Increase / decrease throttle |
| Down / Up | Pull / push the nose |
| Left / A / Q, Right / D | Bank or steer |
| J / L | Rudder |
| Space | Wheel brakes |
| R | Reset to the airfield |
| F | Fullscreen |
| 1–4 | Front, side, rear, overhead inspection |
| Drag / scroll | Orbit / zoom in inspection |
| Shift-drag, middle-drag, right-drag | Pan in inspection |

Hold W to build power. At 29 m/s, hold Down to rotate. In the air, release Down after the initial climb and make small pitch corrections. Reduce power for approach, keep the wings level and flare gently. Brake after touchdown, or add at least 50% power and pull for a touch-and-go. After a full stop, add power to fly again without resetting.

## Verify

```sh
npm run build
npm run test:unit
npm test
npm run verify:visual
npm run inspect:canvas
```

The tests cover controls, contact physics, repeated flights, the cinematic, paint, fullscreen, audio, terrain seams, complete Blender geometry transfer, and repeated biome visits. The canvas inspector writes screenshots, pixel statistics and renderer measurements to `artifacts/`.

Editable Blender scenes, applied biome prompts and original exports are stored losslessly in `repository-assets/source/`. Run `npm run assets:restore -- --all` to restore them to `artifacts/four-horizons/` and `public/environments/`. Runtime assets restore automatically before local development and regular builds. Existing modified files are preserved rather than overwritten. After editing source assets, `npm run assets:pack` refreshes the lossless packages for version control.

`window.__AIRPLANE_EXPERIENCE__` exposes flight actions, state and diagnostics. `window.__THREE_GAME_DIAGNOSTICS__` exposes renderer, world, camera, audio and frame measurements. The `?debug=1` URL enables the tuning panel; deterministic review hooks are available with `?review=1`.
