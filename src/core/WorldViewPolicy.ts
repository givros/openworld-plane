/** Covers the authored 3.2 km square island from any point inside its bounds. */
export const FULL_WORLD_VIEW_DISTANCE=6000;
export const MAX_REVIEW_VIEW_DISTANCE=16000;

/** Old public trial links must not reintroduce a short view or partial residency.
 * Explicit review/debug sessions retain their controls for repeatable benchmarks.
 */
export function worldViewPolicy(search:string){
  const query=new URLSearchParams(search),review=query.has('review')||query.has('debug');
  const distance=Number(query.get('view'));
  const residency=Number(query.get('resident')??100);
  return {
    review,
    viewDistance:review&&Number.isFinite(distance)&&distance>=100&&distance<=MAX_REVIEW_VIEW_DISTANCE?distance:FULL_WORLD_VIEW_DISTANCE,
    residentPercent:review&&Number.isFinite(residency)&&residency>=0&&residency<=100?residency:100,
  };
}
