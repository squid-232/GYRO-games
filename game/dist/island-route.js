import * as T from './vendor/three.module.js';

export const TERRAIN_XZ=.60, TERRAIN_Y=.88, ROUTE_SPACING=680, ROUTE_START=420;
const smooth=t=>{t=T.MathUtils.clamp(t,0,1);return t*t*t*(t*(t*6-15)+10);};
const passes=new Set(['05_Cliff_Plateau','06_Twin_Peaks','07_Karst_Towers','08_River_Valley','09_Glacier_Fjord']);
export function corridorX(id,z){
 const u=T.MathUtils.clamp((250-z)/500,0,1),edge=Math.sin(Math.PI*u);
 const bend=id==='09_Glacier_Fjord'?48:id==='05_Cliff_Plateau'?70:55;
 return bend*Math.sin(2*Math.PI*u)*edge*edge+(id==='01_Volcano'?110:0)*edge*edge*edge;
}
export function heightAt(data,x,z,source=data.heights){
 if(Math.abs(x)>data.size/2||Math.abs(z)>data.size/2)return -data.depth;
 const u=(x/data.size+.5)*256,v=(z/data.size+.5)*256;
 const ix=Math.min(255,Math.floor(u)),iz=Math.min(255,Math.floor(v)),a=u-ix,b=v-iz;
 return T.MathUtils.lerp(T.MathUtils.lerp(source[iz*257+ix],source[iz*257+ix+1],a),T.MathUtils.lerp(source[(iz+1)*257+ix],source[(iz+1)*257+ix+1],a),b)/65535*data.sizeY-data.depth;
}
export function preparePass(data){
 if(!passes.has(data.name))return;
 data.originalHeights=data.heights.slice();
 // Open a meandering pass through the source relief, keeping the outer peaks.
 // The same edited heightfield drives geometry, coast, prop placement and collision.
 for(let iz=0;iz<=256;iz++)for(let ix=0;ix<=256;ix++){
  const x=(ix/256-.5)*data.size,z=(iz/256-.5)*data.size,index=iz*257+ix;
  const h=data.heights[index]/65535*data.sizeY-data.depth;
  const width=24+5*Math.sin(z*.018),lateral=Math.abs(x-corridorX(data.name,z));
  const cut=(1-smooth((lateral-width)/58))*smooth((245-Math.abs(z))/28);
  const floor=1.8+1.2*(.5+.5*Math.sin(z*.019));
  const carved=T.MathUtils.lerp(h,Math.min(h,floor),cut);
  data.heights[index]=Math.round((carved+data.depth)/data.sizeY*65535);
 }
}
const STEP=4,EXTENT=336;
export function buildRoute(data,centerX,seaLevel){
 const points=[];
 for(let q=-EXTENT;q<=EXTENT;q+=STEP){
  const approach=smooth((330-Math.abs(q))/165),sourceZ=-q/TERRAIN_XZ;
  const x=centerX*approach+corridorX(data.name,sourceZ)*TERRAIN_XZ;
  let ground=seaLevel;
  // Preserve a safe central lane while leaving the outer cliff shoulders tangible.
  for(const side of [-6,0,6])ground=Math.max(ground,seaLevel+heightAt(data,(x-centerX+side)/TERRAIN_XZ,sourceZ)*TERRAIN_Y);
  points.push({x,y:Math.max(0,ground+1.2)});
 }
 const raw=points.map(p=>p.y);
 for(let i=0;i<points.length;i++){
  // Anticipate terrain before reaching it. A soft maximum prevents a late climb.
  let y=0;for(let j=0;j<points.length;j++)y=Math.max(y,raw[j]-Math.pow((i-j)*STEP/18,2));
  points[i].y=y;
 }
 return {points};
}
export function sampleRoute(profile,q,out){
 const f=(q+EXTENT)/STEP,index=Math.floor(f),t=f-index;
 const weights0=Math.pow(1-t,3)/6,weights1=(3*t*t*t-6*t*t+4)/6,weights2=(-3*t*t*t+3*t*t+3*t+1)/6,weights3=t*t*t/6;
 const points=profile.points,last=points.length-1;
 const p0=points[T.MathUtils.clamp(index-1,0,last)],p1=points[T.MathUtils.clamp(index,0,last)],p2=points[T.MathUtils.clamp(index+1,0,last)],p3=points[T.MathUtils.clamp(index+2,0,last)];
 // Uniform cubic B-spline: position, tangent and acceleration remain continuous.
 out.x=p0.x*weights0+p1.x*weights1+p2.x*weights2+p3.x*weights3;
 out.y=p0.y*weights0+p1.y*weights1+p2.y*weights2+p3.y*weights3;
 return out;
}
