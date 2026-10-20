import * as T from './vendor/three.module.js';

// Combat stays in a translated local corridor, so steering, bullets and targeting
// share one coordinate system while the carrier actually crosses the island.
const smooth=t=>{t=T.MathUtils.clamp(t,0,1);return t*t*t*(t*(t*6-15)+10);};
const envelope=(phase,plateau)=>smooth((155-Math.abs(phase))/(155-plateau));
const checkpoints=[{at:-45,x:-3,y:5},{at:0,x:3,y:7},{at:45,x:0,y:5}];
export function createTerrainFlight(map,world,camera,{onEnter,onRing,onFinish}){
 const group=new T.Group();group.name='Terrain navigation rings';world.add(group);
 const material=new T.MeshBasicMaterial({color:0xc8e8c3,transparent:true,opacity:.95,depthWrite:false});
 const geometry=new T.TorusGeometry(3,.075,4,24,Math.PI/2-.18);
 const outlineGeometry=new T.TorusGeometry(3,.13,4,24,Math.PI/2-.18);
 const outlineMaterial=new T.MeshBasicMaterial({color:0x163239,transparent:true,opacity:.6,depthWrite:false});
 const rings=checkpoints.map(()=>{const ring=new T.Group();for(let i=0;i<4;i++){
  const outline=new T.Mesh(outlineGeometry,outlineMaterial);outline.rotation.z=i*Math.PI/2+.09;outline.position.z=-.035;ring.add(outline);
  const arc=new T.Mesh(geometry,material);arc.rotation.z=i*Math.PI/2+.09;ring.add(arc);
 }group.add(ring);return ring;});
 const objective=document.getElementById('flightObjective'),cameraLocal=new T.Vector3(0,11,22),desired=new T.Vector3();
 let key='',hits=0,passed=0,finished=false,enabled=false;
 const state={x:0,y:0,blend:0,bank:0,climb:0,phase:-Infinity};
 function reset(){
  Object.assign(state,{x:0,y:0,blend:0,bank:0,climb:0,phase:-Infinity});
  key='';hits=passed=0;finished=false;enabled=false;group.visible=false;objective.classList.add('hidden');
  world.position.set(0,0,0);cameraLocal.set(0,11,22);camera.fov=53;camera.updateProjectionMatrix();
 }
 function update(distance,player,island){
  const route=island?map.flyover(distance):null;
  const active=!!route&&Math.abs(route.phase)<155;
  if(!active){
   if(enabled&&!finished){onFinish(hits);finished=true;}
   enabled=false;group.visible=false;objective.classList.add('hidden');
   Object.assign(state,{x:0,y:0,blend:0,bank:0,climb:0,phase:route?.phase??-Infinity});world.position.set(0,0,0);return state;
  }
  if(key!==route.key){key=route.key;hits=passed=0;finished=false;rings.forEach(r=>{r.userData.passed=false;});onEnter(route.name);}
  enabled=true;const p=route.phase,b=envelope(p,65),lift=envelope(p,90);
  Object.assign(state,{phase:p,x:route.x*b,y:route.lift*lift,blend:b,
   bank:-Math.atan(route.x*(envelope(p+1,65)-envelope(p-1,65))*.5)*.24,
   climb:Math.atan(route.lift*(envelope(p+1,90)-envelope(p-1,90))*.5)*.2});
  world.position.set(state.x,state.y,0);group.visible=true;
  for(let i=0;i<rings.length;i++){
   const ring=rings[i],point=checkpoints[i];ring.position.set(point.x,point.y,7+p-point.at);
   if(!ring.userData.passed&&p>=point.at){
    ring.userData.passed=true;passed++;
    if(Math.hypot(player.x-point.x,player.y-point.y)<2.35){hits++;onRing(hits);}
   }
   ring.visible=!ring.userData.passed;
  }
  const stage=p< -65?'爬升接近':p>65?'下降返航':'地形飞越';
  const text=`${route.name} / ${stage}  ·  导航环 ${hits}/3${passed===3&&hits===3?'  ·  全环达成':''}`;
  if(objective.textContent!==text)objective.textContent=text;
  objective.classList.remove('hidden');return state;
 }
 function aimCamera(dt,player){
  desired.set(player.x*.38+Math.sign(state.x)*state.blend*1.8,player.y+6+state.blend*2.4,22+state.blend*3);
  cameraLocal.lerp(desired,1-Math.exp(-5*dt));camera.position.copy(cameraLocal).add(world.position);
  camera.lookAt(state.x+player.x*.45,state.y+player.y+1,-24);
  const fov=T.MathUtils.damp(camera.fov,53+state.blend*3,4,dt);
  if(Math.abs(fov-camera.fov)>.001){camera.fov=fov;camera.updateProjectionMatrix();}
 }
 reset();return {update,aimCamera,reset,state,get active(){return enabled;},
  // Keep rocks on the sea floor; suppress new pillars before the aerial leg.
  get seaObstacles(){return state.phase< -285||state.phase>155;},
  dispose(){world.remove(group);geometry.dispose();material.dispose();outlineGeometry.dispose();outlineMaterial.dispose();}};
}
