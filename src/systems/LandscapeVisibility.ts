/** Keep the chosen ground footprint inside the far plane at every altitude. */
export function landscapeVisibility(horizontalDistance:number,cameraAltitude:number){
  if(!Number.isFinite(horizontalDistance)||horizontalDistance<=0||!Number.isFinite(cameraAltitude)||cameraAltitude<0)
    throw new Error('Landscape visibility requires a positive range and nonnegative altitude');
  const cameraFar=Math.max(100,Math.ceil(Math.hypot(horizontalDistance,cameraAltitude)/8)*8);
  return{cameraFar};
}
