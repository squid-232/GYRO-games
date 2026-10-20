import * as T from './vendor/three.module.js';

// Simulation uses longitudinal/lateral lane coordinates. Only the render pose is
// projected onto the continuous world route; it is restored before the next tick.
// Projectiles use independent world positions after launch and bypass this projection.
export function createTerrainFlight(map,world,camera,{onEnter,onFinish}){
 const objective=document.getElementById('flightObjective');
 const state={x:0,y:0,bank:0,climb:0,yaw:0,active:false,transition:false,phase:Infinity};
 const center={},before={},after={},nav={},a={},b={};
 const routeQuaternion=new T.Quaternion(),euler=new T.Euler(0,0,0,'YXZ');
 const desired=new T.Vector3(),look=new T.Vector3(),lookSmooth=new T.Vector3(0,6,-35),scratch=new T.Vector3(),playerPoint=new T.Vector3();
 const saved=new WeakMap(),rendered=[];
 let traveled=0,island=false,key='',active=false,cameraReady=false;
 function frameAt(distance,out){
  map.navigation(distance,out);map.navigation(distance-1,a);map.navigation(distance+1,b);
  out.dx=(b.x-a.x)/2;out.dy=(b.y-a.y)/2;
  out.yaw=-Math.atan(out.dx);out.pitch=Math.atan2(out.dy,Math.hypot(1,out.dx));
  return out;
 }
 function point(local,out){
  if(!island)return out.copy(local);
  frameAt(traveled+7-local.z,nav);
  return out.set(nav.x+Math.cos(nav.yaw)*local.x,nav.y+local.y,local.z-Math.sin(nav.yaw)*local.x);
 }
 // Invert the lateral route projection for collision, radar and local impact effects.
 function localPoint(position,out){
  if(!island)return out.copy(position);
  const wx=position.x,wy=position.y,wz=position.z;let z=wz,x=wx;
  for(let i=0;i<6;i++){
   frameAt(traveled+7-z,nav);x=(wx-nav.x)/Math.cos(nav.yaw);
   z=wz+Math.sin(nav.yaw)*x;
  }
  frameAt(traveled+7-z,nav);
  return out.set((wx-nav.x)/Math.cos(nav.yaw),wy-nav.y,z);
 }
 function direction(local,vector,out){
  out.copy(vector);if(!island)return out;
  frameAt(traveled+7-local.z,nav);
  routeQuaternion.setFromEuler(euler.set(nav.pitch,nav.yaw,0,'YXZ'));
  return out.applyQuaternion(routeQuaternion);
 }
 function worldGroundHit(position){return island&&map.groundHeight(position.x,position.z)>position.y-.45;}
 function pose(object,billboard=false){
  point(object.position,scratch);object.position.copy(scratch);
  if(!billboard){routeQuaternion.setFromEuler(euler.set(nav.pitch,nav.yaw,0,'YXZ'));object.quaternion.premultiply(routeQuaternion);}
 }
 function reset(){
  restoreRender();traveled=0;island=false;key='';active=false;cameraReady=false;
  Object.assign(state,{x:0,y:0,bank:0,climb:0,yaw:0,active:false,transition:false,phase:Infinity});
  world.position.set(0,0,0);world.quaternion.identity();objective.classList.add('hidden');
  lookSmooth.set(0,6,-35);camera.up.set(0,1,0);camera.fov=53;camera.updateProjectionMatrix();
 }
 function advance(speed,dt,islandMode){
  if(!islandMode)return speed*dt;
  frameAt(traveled,center);
  // Keep speed along the arc stable instead of accelerating on lateral transfers.
  return speed*dt/Math.hypot(1,center.dx,center.dy);
 }
 function update(distance,player,islandMode,speed=26){
  traveled=distance;island=islandMode;
  if(!island){Object.assign(state,{x:0,y:0,bank:0,climb:0,yaw:0,active:false,transition:false});active=false;objective.classList.add('hidden');return state;}
  frameAt(distance,center);map.navigation(distance-3,before);map.navigation(distance+3,after);
  const curvature=(after.x-2*center.x+before.x)/9/Math.pow(1+center.dx*center.dx,1.5);
  Object.assign(state,{x:center.x,y:center.y,yaw:center.yaw,climb:center.pitch,
   bank:T.MathUtils.clamp(-Math.atan(curvature*speed*speed/28),-.08,.08),
   active:center.active,transition:center.transition,phase:center.phase});
  if(center.active&&key!==center.key){key=center.key;onEnter(center.name);}
  if(active&&!center.active)onFinish();active=center.active;
  objective.classList.toggle('hidden',!active);
  if(active){const p=center.phase,stage=p< -180?'直线接近':p< -100?'对准入口':p<100?(center.pass?'峡谷穿行':'海岛穿行'):p<180?'冲出山口':'展开海湾';
   const text=`${center.name} / ${stage}`;if(objective.textContent!==text)objective.textContent=text;
  }return state;
 }
 function aimCamera(dt,player){
  // Short, level pursuit camera: no horizon roll or automatic zoom during transfers.
  point(desired.set(player.x*.32,player.y+5.8,24),desired);
  point(look.set(player.x*.35,player.y+.8,-22),look);
  if(!cameraReady){camera.position.copy(desired);lookSmooth.copy(look);cameraReady=true;}
  else{camera.position.lerp(desired,1-Math.exp(-5*dt));lookSmooth.lerp(look,1-Math.exp(-3.8*dt));}
  if(island){
   point(playerPoint.set(player.x,player.y,7),scratch);
   // Pull the camera inward if a cliff lies between it and the aircraft.
   for(let i=1;i<=6;i++){
    const t=i/7,x=T.MathUtils.lerp(scratch.x,camera.position.x,t),y=T.MathUtils.lerp(scratch.y,camera.position.y,t),z=T.MathUtils.lerp(scratch.z,camera.position.z,t);
    if(map.groundHeight(x,z)>y-1.5){camera.position.lerp(scratch,.18);break;}
   }
   camera.position.y=Math.max(camera.position.y,map.groundHeight(camera.position.x,camera.position.z)+3);
  }
  camera.up.set(0,1,0);camera.lookAt(lookSmooth);
 }
 function groundHit(local,radius=0){
  if(!island)return false;
  for(const side of radius?[-radius,0,radius]:[0]){
   point(scratch.set(local.x+side,local.y,local.z),scratch);
   if(map.groundHeight(scratch.x,scratch.z)>scratch.y-.45)return true;
  }return false;
 }
 function beginRender(aircraft,enabled){
  if(!island||!enabled)return;
  for(const object of [...world.children,aircraft]){
   if(object.userData.routeBatch||object.userData.routeWorld||!object.visible)continue;
   let snapshot=saved.get(object);if(!snapshot){snapshot={position:new T.Vector3(),quaternion:new T.Quaternion()};saved.set(object,snapshot);}
   snapshot.position.copy(object.position);snapshot.quaternion.copy(object.quaternion);rendered.push(object);
   pose(object,object.userData.routeBillboard);
  }
 }
 function restoreRender(){for(const object of rendered){const snapshot=saved.get(object);object.position.copy(snapshot.position);object.quaternion.copy(snapshot.quaternion);}rendered.length=0;}
 function projectBatch(object){if(island)pose(object);}
 reset();return {update,advance,aimCamera,point,localPoint,direction,worldGroundHit,groundHit,beginRender,restoreRender,projectBatch,reset,state,
  get active(){return active;},get transition(){return state.transition;},
  get seaObstacles(){if(!island)return true;for(const d of [-35,0,145]){map.navigation(traveled+d,nav);if(nav.y>.01||map.groundHeight(nav.x,7-d)>-2.5)return false;}return true;},
  dispose(){restoreRender();}};
}
