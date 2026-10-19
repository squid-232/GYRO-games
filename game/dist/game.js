import * as T from './vendor/three.module.js';
import { updateTacticalHUD } from './tactical-hud.js';
import { advanceFrame } from './frame-timing.js';
import {GraphicsSettings} from './graphics-settings.js';
import { createParticleSystem } from './particle-system.js';
import { createCannonEffects } from './cannon-effects.js';
import { GyroController } from './gyro.js';
import { parseAircraft } from './aircraft-model.js';
import { createSpaceplane, updateSpaceplane } from './spaceplane-model.js';
import { createEnemyAircraft, ENEMY_EXTENTS } from './enemy-model.js';
import { createEnemyMissile, createPlayerMissile, animateEnemyMissile } from './missile-model.js';
import { createIslandMap, createSeaStack } from './island-map.js';
import {ISLAND_REGIONS} from './notion-islands.js';
import { createMoraCoin } from './coin-model.js';
import { createEnemyExplosions } from './explosion-effect.js';
import { createSpaceMap, createOrbitalObstacle, createOrbitalGate, ringIntersects } from './space-map.js';
const $=id=>document.getElementById(id), clamp=T.MathUtils.clamp;
let renderer;
try{renderer=new T.WebGLRenderer({canvas:$('scene'),antialias:true,powerPreference:'high-performance'});}catch(e){$('loadError').classList.remove('hidden');$('loadError').textContent='无法启动 3D 场景，请启用浏览器硬件加速后刷新。';throw e;}
const graphics=new GraphicsSettings(renderer,devicePixelRatio);
renderer.debug.checkShaderErrors=new URLSearchParams(location.search).has('debug-gpu');
renderer.setClearColor(0x72939c);renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;renderer.shadowMap.autoUpdate=false;
const scene=new T.Scene();scene.fog=new T.FogExp2(0x78979e,.005);const camera=new T.PerspectiveCamera(53,innerWidth/innerHeight,.1,700);
const hemisphere=new T.HemisphereLight(0xc2deeb,0x263b3c,2.3);scene.add(hemisphere);const sun=new T.DirectionalLight(0xffe8c4,3.3);sun.position.set(-32,38,-45);scene.add(sun);const rim=new T.DirectionalLight(0xb5e4ff,1.8);rim.position.set(15,8,15);scene.add(rim);
// One tight shadow map follows the player. Only the aircraft casts/receives it;
// the island scene and its reflection do not add duplicate shadow-map renders.
scene.add(sun.target);sun.shadow.mapSize.set(512,512);sun.shadow.camera.near=1;sun.shadow.camera.far=110;
sun.shadow.bias=-.00005;sun.shadow.radius=1.5;
const aircraftSunOffset=new T.Vector3(-32,38,-45);
let lastShadowAt=-Infinity,lastShadowRadius=0;
function applyGraphicsQuality(){
 sun.castShadow=selectedMap==='island'&&graphics.profile.shadows;
 islandMap.setQuality(graphics.profile);enemyExplosions.setQuality(graphics.profile);lastShadowAt=-Infinity;
}
function updateAircraftShadows(now=performance.now()){
 if(!aircraft||!sun.castShadow||selectedMap!=='island'||now-lastShadowAt<1000/graphics.profile.shadowHz)return;
 lastShadowAt=now;
 const radius=mode==='menu'?10:3.1;
 if(radius!==lastShadowRadius){Object.assign(sun.shadow.camera,{left:-radius,right:radius,top:radius,bottom:-radius});sun.shadow.camera.updateProjectionMatrix();lastShadowRadius=radius;}
 sun.target.position.copy(aircraft.position);sun.position.copy(aircraft.position).add(aircraftSunOffset);
 sun.shadow.normalBias=mode==='menu'?.025:.007;renderer.shadowMap.needsUpdate=true;
}
// Studio environment gives the existing metal material a continuous reflection.
const envScene=new T.Scene();envScene.background=new T.Color(0x344a5d);for(const [x,y,z,color] of [[-8,9,0,0xdcf6ff],[8,5,2,0xffe0b0],[0,3,-10,0x78bfff]]){const p=new T.Mesh(new T.PlaneGeometry(7,17),new T.MeshBasicMaterial({color,side:T.DoubleSide}));p.position.set(x,y,z);p.lookAt(0,0,0);envScene.add(p);}const pmrem=new T.PMREMGenerator(renderer);const envMap=pmrem.fromScene(envScene,.02);scene.environment=envMap.texture;pmrem.dispose();
const world=new T.Group();scene.add(world);const objects=[],shots=[],hostile=[],effects=[];let aircraft,mode='loading',autoFire=true,muted=true,keys=new Set(),touch={x:0,y:0,fire:false};
const enemyExplosions=createEnemyExplosions(world);
window.addEventListener('pagehide',()=>enemyExplosions.dispose(),{once:true});
let hp=5,score=0,coins=0,kills=0,distance=0,elapsed=0,level=1,speed=26,invuln=0,spawnTimer=0,shotTimer=0,noticeTimer=0,shake=0,best=0;
try{best=Number(localStorage.getItem('gyro-skystrike-best'))||0;}catch{}$('best').textContent=String(best).padStart(6,'0');
let poseView, poseLoad;
const gyro=new GyroController({onInterrupt:message=>{if(mode==='playing'){pause();$('pauseReason').textContent=message;}},onNotice:notice,onNoseDirection:direction=>poseView?.setNoseDirection(direction),onPanelVisibility:visible=>{
 if(poseView){poseView.setVisible(visible);return;}
 if(!visible||poseLoad)return;
 poseLoad=import('./gyro-view.js').then(({GyroPoseView})=>{
   poseView=new GyroPoseView($('gyroModel'),gyro,selectedMap);
   poseView.setVisible(gyro.selected && !$('gyroPanel').classList.contains('hidden'));
 }).catch(()=>{$('gyroModelState').textContent='3D 预览暂不可用，角度读数和操控仍可使用';poseLoad=null;});
}});
function permitFlight(){if(gyro.canFly)return true;notice(gyro.pauseMessage);return false;}
const player={x:0,y:5,z:7},range={x:10,yMin:2.6,yMax:11};
const geo={particle:new T.OctahedronGeometry(.14)};
const cannon=createCannonEffects(world);
window.addEventListener('pagehide',()=>cannon.dispose(),{once:true});
const particles=createParticleSystem(world,geo.particle);
window.addEventListener('pagehide',()=>particles.dispose(),{once:true});
const islandMap=createIslandMap(scene);
window.addEventListener('pagehide',()=>islandMap.dispose(),{once:true});
for(const region of ISLAND_REGIONS){const option=document.createElement('option');option.value=region.id;option.textContent=region.name;$('islandRegion').append(option);}
function updateIslandRegionUI(){
 const region=ISLAND_REGIONS.find(r=>r.id===islandMap.region);
 $('islandRegion').value=region.id;$('islandRegionDescription').textContent=region.description;
 $('islandMinimap').src=`./assets/notion-islands/${region.id}/minimap.webp`;
 if(selectedMap==='island'){$('theaterName').textContent=region.name;$('missionLocation').textContent=`MARITIME / ${region.name}`;}
}
let spaceMap,activeMap=islandMap,selectedMap='space',islandAircraft,spaceAircraft,waveIndex=0,battlefieldPreparing=false;
try{const saved=localStorage.getItem('gyro-skystrike-map');if(saved==='island'||saved==='space')selectedMap=saved;}catch{}
function selectMap(kind){
 if(mode!=='menu'&&mode!=='loading')return;
 selectedMap=kind==='island'?'island':'space';const orbital=selectedMap==='space';
 cannon.clear();
 poseView?.setAircraftKind(selectedMap);
 applyGraphicsQuality();if(orbital)sun.target.position.set(0,0,0);
 if(orbital&&!spaceMap)spaceMap=createSpaceMap(scene);
 islandMap.root.visible=!orbital;if(spaceMap)spaceMap.root.visible=orbital;
 activeMap=orbital?spaceMap:islandMap;activeMap.reset();
 // The flight transform belongs to the carrier group, preserving the Xuan Nv
 // model's calibrated internal XYZ proportions when menu/flight scale changes.
 if(islandAircraft)islandAircraft.visible=!orbital;
 if(spaceAircraft){spaceAircraft.visible=orbital;updateSpaceplane(spaceAircraft,0,false);}
 $('aircraftName').innerHTML=orbital?'玄女 <em>XUAN NV</em>':'F-22 <em>RAPTOR</em>';
 $('aircraftDescription').textContent=orbital?'空天战机 · 高置前掠翼 · 双发推进':'F-22A · 菱形翼身 · 双二维喷口';
 $('aircraftRole').textContent=orbital?'SPACE FIGHTER / 空天':'FIGHTER / 单座';
 $('aircraftNumber').textContent=orbital?'现役载具 / 02':'现役载具 / 01';
 $('islandAircraftDiagram').style.display=orbital?'none':'';
 $('spaceAircraftDiagram').style.display=orbital?'':'none';
 scene.fog=orbital?null:new T.FogExp2(0x78979e,.005);
 renderer.setClearColor(orbital?0x030610:0x72939c);renderer.toneMappingExposure=orbital?1.08:1.12;
 hemisphere.color.setHex(orbital?0xa2b8d3:0xc2deeb);hemisphere.groundColor.setHex(orbital?0x080e28:0x263b3c);hemisphere.intensity=orbital?.7:2.3;
 sun.color.setHex(orbital?0xffebd0:0xffe8c4);sun.intensity=orbital?3.2:3.3;sun.position.set(orbital?-78:-32,orbital?48:38,orbital?39:-45);
 rim.color.setHex(orbital?0x7fa4c4:0xb5e4ff);rim.intensity=orbital?.85:1.8;
 document.body.dataset.map=selectedMap;
 $('islandRegionPanel').classList.toggle('hidden',orbital);
 $('mapIsland').setAttribute('aria-pressed',String(!orbital));$('mapSpace').setAttribute('aria-pressed',String(orbital));
 $('missionLocation').textContent=orbital?'ORBITAL EXCLUSION / 轨道禁区':'ARCHIPELAGO / 群岛战区';
 $('operationLabel').textContent=orbital?'OPERATION 02 / 轨道':'OPERATION 01 / 群岛';
 $('missionType').textContent=orbital?'近地轨道 / 残骸突围':'海岛空域 / 空中拦截';$('areaCode').textContent=orbital?'02—AO':'01—AO';
 $('introText').innerHTML=orbital?'驾驶玄女空天战机，突破轨道封锁。<br>避开小行星，穿过蓝色环框，迎击敌机。':'低空突入群岛，突破敌方封锁。<br>沿航线收集补给，规避礁柱，清除空中威胁。';
 $('theaterName').textContent=orbital?'轨道禁区':'群岛战区';$('theaterEnglish').textContent=orbital?'ORBITAL INTERDICTION':'MARITIME INTERDICTION';$('theaterCode').textContent=orbital?'AO / 02':'AO / 01';
 $('heightLabel').textContent=orbital?'OFFSET / 航道高度':'ALT / 高度';$('heightUnit').textContent=orbital?'REL. METERS':'METERS';
 $('tacticalRadar').setAttribute('aria-label',orbital?'前方敌机、残骸、环框与补给位置':'前方敌机、礁柱与补给位置');
 $('radarObstacleLabel').textContent=orbital?'残骸 / 环框':'礁柱';$('scene').setAttribute('aria-label',orbital?'3D 轨道禁区太空空战场景':'3D 海岛空战场景');
 updateIslandRegionUI();
 try{localStorage.setItem('gyro-skystrike-map',selectedMap);}catch{}
}
async function chooseBattlefield(kind){
 if(mode!=='menu'||battlefieldPreparing)return;
 selectMap(kind);await prepareCurrentBattlefield();
}
$('mapIsland').onclick=()=>chooseBattlefield('island');$('mapSpace').onclick=()=>chooseBattlefield('space');
$('islandRegion').onchange=async()=>{
 if(mode!=='menu'||battlefieldPreparing)return;
 const id=$('islandRegion').value;
 await prepareCurrentBattlefield(()=>islandMap.setRegion(id));updateIslandRegionUI();
};
selectMap(selectedMap);

let audio;function tone(freq,dur,type='sine',vol=.025){if(muted)return;try{audio??=new (window.AudioContext||window.webkitAudioContext)();if(audio.state==='suspended')audio.resume();const o=audio.createOscillator(),g=audio.createGain();o.type=type;o.frequency.setValueAtTime(freq,audio.currentTime);o.frequency.exponentialRampToValueAtTime(Math.max(30,freq*.45),audio.currentTime+dur);g.gain.setValueAtTime(vol,audio.currentTime);g.gain.exponentialRampToValueAtTime(.001,audio.currentTime+dur);o.connect(g);g.connect(audio.destination);o.start();o.stop(audio.currentTime+dur);}catch{}}
function notice(text){$('notice').textContent=text;$('notice').style.opacity=1;noticeTimer=2.5;}
// 技能冷却采用有效游戏时间；暂停和体感数据中断均不推进计时。
const missileConfig = Object.freeze({cooldown:12, coldTime:.35, maxRange:140, speed:82, turnRate:5.5, damage:8});
function missileSkillState(){
 return world.userData.missileSkill ??= {cooldown:0, side:-1, marker:null, label:'', disabled:null};
}
function resetMissileSkill(){
 const skill=missileSkillState();skill.cooldown=0;skill.side=-1;
 if(skill.marker)skill.marker.visible=false;
}
function findMissileTarget(origin=player){
 let target=null,closest=Infinity;
 for(const o of objects){
  if(o.type!=='enemy'||o.hp<=0)continue;
  const p=o.mesh.position,ahead=origin.z-p.z;
  if(ahead<5||ahead>missileConfig.maxRange)continue;
  const rank=ahead+Math.hypot(p.x-origin.x,p.y-origin.y)*3;
  if(rank<closest){closest=rank;target=o;}
 }
 return target;
}
function createMissileLockMarker(){
 const points=[];
 for(const x of [-1,1])for(const y of [-1,1]){
  points.push(x*2.35,y*.95,0,x*2.35,y*1.35,0,x*2.35,y*1.35,0,x*1.75,y*1.35,0);
 }
 const geometry=new T.BufferGeometry();
 geometry.setAttribute('position',new T.Float32BufferAttribute(points,3));
 const marker=new T.LineSegments(geometry,new T.LineBasicMaterial({color:0xa9efce,transparent:true,opacity:.9,depthTest:false,depthWrite:false,toneMapped:false}));
 marker.name='Tracking missile target';marker.renderOrder=3;marker.visible=false;world.add(marker);
 return marker;
}
function updateMissileHUD(){
 const skill=missileSkillState(),active=mode==='playing'&&(!gyro.selected||gyro.fresh);
 const inFlight=shots.find(s=>s.kind==='tracking'&&objects.includes(s.target));
 const target=active?(skill.cooldown===0?findMissileTarget():inFlight?.target):null;
 const ready=active&&skill.cooldown===0&&!!target;
 let label;
 if(mode==='paused')label='已暂停'+(skill.cooldown>0?' · '+skill.cooldown.toFixed(1)+'s':'');
 else if(mode!=='playing')label=mode==='over'?'本局已结束':'出击后可用';
 else if(!active)label='等待体感数据';
 else if(skill.cooldown>0)label='冷却 '+skill.cooldown.toFixed(1)+'s';
 else label=target?'目标锁定 · 就绪':'就绪 · 等待敌机';
 if(skill.label!==label){
  $('missileStatus').textContent=label;
  $('missileSkill').setAttribute('aria-label','冷启动跟踪导弹，'+label+'，快捷键 Q');
  skill.label=label;
 }
 if(skill.disabled!==!ready){$('missileSkill').disabled=!ready;skill.disabled=!ready;}
 if(skill.ready!==ready){$('missileSkill').setAttribute('data-ready',String(ready));skill.ready=ready;}
 const progress=Math.round((1-skill.cooldown/missileConfig.cooldown)*100);
 if(skill.progress!==progress){$('missileProgress').style.transform='scaleX('+(progress/100)+')';skill.progress=progress;}
 if(target&&!skill.marker)skill.marker=createMissileLockMarker();
 if(skill.marker){
  skill.marker.visible=!!target;
  if(target){
   skill.marker.position.copy(target.mesh.position);
   skill.marker.quaternion.copy(camera.quaternion);
   skill.marker.material.color.setHex(ready?0xa9efce:0xffb86b);
  }
 }
}
function launchTrackingMissile(){
 if(mode!=='playing'||(gyro.selected&&!gyro.fresh))return;
 const skill=missileSkillState();
 if(skill.cooldown>0){notice('导弹冷却中 · '+skill.cooldown.toFixed(1)+' 秒');return;}
 const target=findMissileTarget();
 if(!target){notice('前方没有可锁定敌机 · 技能保留');return;}
 const side=skill.side;skill.side=-side;
 const origin=new T.Vector3(side*.72,-.34,-.28).applyQuaternion(aircraft.quaternion).add(new T.Vector3(player.x,player.y,player.z));
 const mesh=createPlayerMissile(new T.Vector3(0,0,-1));mesh.position.copy(origin);world.add(mesh);
 shots.push({kind:'tracking',mesh,target,vel:new T.Vector3(side*2.8,-3.8,-9),age:0,life:5,ignited:false,flightSpeed:24,trailTimer:0});
 skill.cooldown=missileConfig.cooldown;
 particleBurst(origin,0xd5e7e9,7);tone(210,.12,'triangle',.04);
 notice('冷弹射 · 即将点火追踪');updateMissileHUD();
}
function damageEnemy(enemy,amount,position){
 const index=objects.indexOf(enemy);if(index<0||enemy.hp<=0)return;
 enemy.hp-=amount;particleBurst(position,0xffcf8a,3);
 if(enemy.hp>0)return;
 const p=enemy.mesh.position.clone();
 enemyExplosions.spawn(p,enemy.mesh.quaternion,selectedMap==='space');score+=200;kills++;tone(140,.22,'sawtooth',.035);
 removeObject(index);
 for(let k=0;k<3;k++)addCoin(p.x+(k-1)*.8,p.y,p.z-k*1.2);
}
// 沿上一位置到当前位置求首次碰撞，避免高速飞弹跨过较薄的目标。
// 环框只检查实体边框，中央通道仍可穿过；其他障碍沿用游戏命中范围。
function missileHitFraction(o,start,end){
 const p=o.mesh.position,padding=.16;
 const center={x:p.x,y:o.type==='rock'?(o.bottom+o.top)/2:p.y,z:p.z};
 const half={x:o.type==='gate'?o.ringRadius+o.tube:(o.hit?.x??o.r),
  y:o.type==='rock'?(o.top-o.bottom)/2:o.type==='gate'?o.ringRadius+o.tube:(o.hit?.y??o.r),
  z:o.type==='gate'?o.halfDepth:(o.hit?.z??o.r)};
 let enter=0,exit=1;
 for(const axis of ['x','y','z']){
  const delta=end[axis]-start[axis],low=center[axis]-half[axis]-padding,high=center[axis]+half[axis]+padding;
  if(Math.abs(delta)<1e-8){if(start[axis]<low||start[axis]>high)return Infinity;continue;}
  const a=(low-start[axis])/delta,b=(high-start[axis])/delta;
  enter=Math.max(enter,Math.min(a,b));exit=Math.min(exit,Math.max(a,b));
  if(enter>exit)return Infinity;
 }
 if(o.type==='gate'){
  for(const t of [enter,(enter+exit)/2,exit]){
   const x=T.MathUtils.lerp(start.x,end.x,t),y=T.MathUtils.lerp(start.y,end.y,t);
   if(Math.abs(Math.hypot(x-p.x,y-p.y)-o.ringRadius)<=o.tube+padding)return t;
  }
  return Infinity;
 }
 return enter;
}
function updateTrackingMissile(s,dt){
 // 分步转向保留可见弧线，先弹射 0.35 秒，安全离机后开启发动机。
 const steps=Math.max(1,Math.ceil(dt/.008)),step=dt/steps;
 for(let i=0;i<steps;i++){
  const previous=s.mesh.position.clone();s.age+=step;s.life-=step;
  if(s.age<missileConfig.coldTime){
   s.vel.y-=5*step;s.mesh.position.addScaledVector(s.vel,step);
  }else{
   if(!s.ignited){
    s.ignited=true;s.mesh.getObjectByName('missile-exhaust').visible=true;
    tone(460,.18,'sawtooth',.025);particleBurst(s.mesh.position,0xa9dfff,4);
   }
   // 原目标已击毁或飞过玩家时，优先重新捕获前方敌机。
   if(!objects.includes(s.target)||s.target.hp<=0||s.target.mesh.position.z>player.z+3)s.target=findMissileTarget();
   s.flightSpeed=Math.min(missileConfig.speed,s.flightSpeed+120*step);
   if(s.target){
    const aim=s.target.mesh.position.clone(),lead=Math.min(.6,aim.distanceTo(s.mesh.position)/(s.flightSpeed+speed));
    aim.z+=speed*lead;
    aim.x+=Math.cos(elapsed*1.2+s.target.phase)*1.2*(elapsed<8?.35:1.8)*lead;
    const desired=aim.sub(s.mesh.position);
    if(desired.lengthSq()>1e-8){
     const rotation=new T.Quaternion().setFromUnitVectors(new T.Vector3(0,0,1),desired.normalize());
     s.mesh.quaternion.rotateTowards(rotation,missileConfig.turnRate*step);
    }
   }
   s.vel.set(0,0,1).applyQuaternion(s.mesh.quaternion).multiplyScalar(s.flightSpeed);
   s.mesh.position.addScaledVector(s.vel,step);
   animateEnemyMissile(s.mesh,s.age);
  }
  let hit=null,first=Infinity;
  for(const o of objects){
   if(o.type==='coin')continue;
   const fraction=missileHitFraction(o,previous,s.mesh.position);
   if(fraction<first){first=fraction;hit=o;}
  }
  if(hit){
   const impact=previous.lerp(s.mesh.position,first);
   if(hit.type==='enemy')damageEnemy(hit,missileConfig.damage,impact);
   else particleBurst(impact,0x9edbff,10);
   return true;
  }
  if(s.life<=0||s.mesh.position.z>30||s.mesh.position.z<-190){
   particleBurst(s.mesh.position,0x9edbff,5);return true;
  }
 }
 if(s.ignited){
  s.trailTimer-=dt;
  if(s.trailTimer<=0){
   s.trailTimer=.055;
   particles.emit(s.mesh.position,new T.Vector3(0,0,speed*.2),0xb3dce5,.35,1.4);
  }
 }
 return false;
}
function clearList(list){if(list===effects){enemyExplosions.clear();particles.clear();cannon.clear();}for(const o of list){world.remove(o.mesh);if(o.ownedMaterial)o.mesh.material.dispose();if(o.ownedEdges){o.ownedEdges.geometry.dispose();o.ownedEdges.material.dispose();}}list.length=0;}
function reset(){if(!permitFlight())return;resetMissileSkill();for(const list of [objects,shots,hostile,effects])clearList(list);hp=5;score=coins=kills=distance=elapsed=0;activeMap.reset();waveIndex=0;level=1;speed=26;invuln=2;spawnTimer=.8;shotTimer=0;shake=0;player.x=0;player.y=5;keys.clear();touch.x=touch.y=0;touch.fire=false;mode='playing';document.body.classList.add('playing');$('overlay').classList.add('hidden');$('pauseOverlay').classList.add('hidden');$('endOverlay').classList.add('hidden');$('pause').disabled=false;aircraft.visible=true;aircraft.scale.setScalar(.24);aircraft.rotation.set(0,0,0);camera.position.set(0,11,22);$('hitflash').style.opacity=0;for(let i=0;i<7;i++)addCoin(Math.sin(i*.4)*.5,5,-28-i*3);addRock(-6,5,-57,1.8);addEnemy(0,5,-90);if(selectedMap==='space')addGate(0,6.5,-150);notice(selectedMap==='space'?'轨道禁区 · 穿越蓝色环框，避开残骸':'进入群岛战区 · 沿金币航线穿越礁柱');updateHUD();tone(600,.2);}
let lastHUDAt=-Infinity;
function updateHUD(now=-Infinity){if(Number.isFinite(now)&&now-lastHUDAt<100)return;lastHUDAt=now;$('score').textContent=String(Math.floor(score)).padStart(6,'0');$('coins').textContent=coins;[...$('health').children].forEach((e,i)=>e.classList.toggle('empty',i>=hp));$('sector').textContent=String(level).padStart(2,'0');$('speed').textContent=`${Math.round(speed*27.7)} KM/H`;$('alt').textContent=Math.round(selectedMap==='space'?player.y*10:1600+player.y*160);}
function end(){mode='over';document.body.classList.remove('playing');$('pause').disabled=true;const newBest=score>best;best=Math.max(best,Math.floor(score));try{localStorage.setItem('gyro-skystrike-best',best);}catch{}$('best').textContent=String(best).padStart(6,'0');$('report').innerHTML=`任务得分 <b>${Math.floor(score)}</b><br>拾取摩拉 <b>${coins}</b><br>击毁目标 <b>${kills}</b><br>飞行距离 <b>${(distance/1000).toFixed(2)} km</b><br>${newBest?'新纪录':'历史最佳'} <b>${best}</b>`;$('endOverlay').classList.remove('hidden');tone(100,.6,'sawtooth',.045);}
function pause(){if(mode==='playing'){$('pauseReason').textContent='准备好后继续任务。';mode='paused';keys.clear();touch.fire=false;touch.x=touch.y=0;$('thumb').style.transform='';$('pauseOverlay').classList.remove('hidden');document.body.classList.remove('playing');}else if(mode==='paused'){if(!permitFlight()){$('pauseReason').textContent=gyro.pauseMessage;return;}mode='playing';$('pauseOverlay').classList.add('hidden');document.body.classList.add('playing');}}
function returnLobby(){
 if(mode!=='paused'&&mode!=='over')return;
 best=Math.max(best,Math.floor(score));try{localStorage.setItem('gyro-skystrike-best',best);}catch{}
 $('best').textContent=String(best).padStart(6,'0');
 for(const list of [objects,shots,hostile,effects])clearList(list);
 resetMissileSkill();
 keys.clear();touch.x=touch.y=0;touch.fire=false;$('thumb').style.transform='';
 hp=5;score=coins=kills=distance=elapsed=0;activeMap.reset();waveIndex=0;level=1;speed=26;invuln=spawnTimer=shotTimer=shake=noticeTimer=0;
 player.x=0;player.y=5;mode='menu';menuTime=0;
 document.body.classList.remove('playing');$('pause').disabled=true;
 $('pauseOverlay').classList.add('hidden');$('endOverlay').classList.add('hidden');$('overlay').classList.remove('hidden');
 $('hitflash').style.opacity=0;$('notice').style.opacity=0;
 aircraft.visible=true;aircraft.scale.setScalar(.85);aircraft.position.set(3.2,5,0);aircraft.rotation.set(.12,Math.PI*.16,-.13);
 camera.position.set(12,15,23);camera.lookAt(0,4,-1);updateHUD();
 $('gyroClose').onclick();$('start').focus();
}
function toggleFire(){autoFire=!autoFire;$('fireMode').innerHTML=`${autoFire?'自动开火':'手动开火'} <span>${autoFire?'ON':'SPACE'}</span>`;$('fireMode').setAttribute('aria-pressed',autoFire);}
function particleBurst(pos,color,count=16){particles.burst(pos,color,count);}
function damage(){if(invuln>0||mode!=='playing')return;hp--;invuln=1.7;shake=.4;tone(80,.25,'sawtooth',.08);particleBurst(new T.Vector3(player.x,player.y,player.z),0xffa765,10);notice(hp<=2?'机体受损 · 注意闪避':'受到撞击 · 护盾恢复中');if(hp<=0){end();updateHUD();}}
function addCoin(x,y,z){const mesh=createMoraCoin();mesh.position.set(x,y,z);world.add(mesh);objects.push({type:'coin',mesh,r:.9});}
function addRock(x,y,z,r=1.8){const obstacle=selectedMap==='space'?createOrbitalObstacle(x,y,z,r,waveIndex):{type:'rock',...createSeaStack(x,y,z,r)};world.add(obstacle.mesh);objects.push(obstacle);}
function addGate(x,y,z){const gate=createOrbitalGate(x,y,z);world.add(gate.mesh);objects.push(gate);}
function shotHitsObject(o,shot){
 const p=o.mesh.position,x=shot.mesh.position.x,y=shot.mesh.position.y;
 if(o.type==='gate')return Math.abs(Math.hypot(x-p.x,y-p.y)-o.ringRadius)<o.tube+.08&&p.z>=shot.mesh.position.z-o.halfDepth&&p.z<=shot.prevZ+o.halfDepth;
 return Math.abs(p.x-x)<(o.hit?.x??o.r)&&(o.type==='rock'?rockHeightHit(o,y):Math.abs(p.y-y)<(o.hit?.y??o.r))&&p.z>=shot.mesh.position.z-(o.hit?.z??o.r)&&p.z<=shot.prevZ+(o.hit?.z??o.r);
}
function playerHitsObject(o){
 const p=o.mesh.position;
 if(o.type==='gate')return ringIntersects(o,player.x,player.y,player.z,.65);
 return (o.type==='rock'?(Math.abs(p.x-player.x)<o.r+.65&&rockHeightHit(o,player.y,.65)):o.hit?Math.hypot((p.x-player.x)/(o.hit.x+.65),(p.y-player.y)/(o.hit.y+.65))<1:Math.hypot(p.x-player.x,p.y-player.y)<o.r+.65)&&Math.abs(p.z-player.z)<(o.hit?.z??o.r)+1;
}
function rockHeightHit(o,y,padding=0){return y>o.bottom-padding&&y<o.top+padding;}
function addEnemy(x,y,z){const mesh=createEnemyAircraft();mesh.position.set(x,y,z);world.add(mesh);objects.push({type:'enemy',mesh,r:1.15,hit:ENEMY_EXTENTS,hp:3+Math.min(3,level-1),baseX:x,phase:Math.random()*6.28,fire:2+Math.random()*2});}
function launchEnemyMissile(enemy){
 // Alternate underwing launch points and aim once, preserving the dodge timing.
 const side=enemy.launchSide??-1;enemy.launchSide=-side;
 const origin=new T.Vector3(side*.86,-.29,.48).applyQuaternion(enemy.mesh.quaternion).add(enemy.mesh.position);
 const vel=new T.Vector3(player.x,player.y,player.z).sub(origin).normalize().multiplyScalar(38);
 const mesh=createEnemyMissile(vel);mesh.position.copy(origin);world.add(mesh);
 hostile.push({mesh,vel,life:5,age:0,flamePhase:elapsed*7+side});
}
function spawn(){waveIndex++;
 if(selectedMap==='space'&&waveIndex%3===2){
  const x=waveIndex%2?3:-3,y=6.5;addGate(x,y,-112);
  for(let i=0;i<7;i++)addCoin(x,y,-95-i*4);
  addRock(-x*2,8,-145,1.8);if(elapsed>4)addEnemy(-x,5,-165);return;
 }
 const lane=(Math.floor(Math.random()*3)-1)*6;const y=4+Math.random()*5;
 for(let i=0;i<6;i++)addCoin(lane+Math.sin(i*.5)*.8,y,-100-i*3.6);
 const blocked=[-6,0,6].filter(x=>x!==lane);addRock(blocked[Math.floor(Math.random()*2)],3.5+Math.random()*5,-112,1.4+Math.random()*.8);
 if(elapsed>4)addEnemy(blocked[0],5+Math.random()*3,-133);
 if(level>=3)addRock(blocked[1],6+Math.random()*2,-139,1.5);
}
function fire(){
 const orbital=selectedMap==='space';
 if(!orbital)cannon.trigger();
 for(const side of [-1,1]){
  const mesh=orbital?cannon.createLaser():cannon.createTracer();
  cannon.muzzlePosition(side,player,aircraft.quaternion,mesh.position);
  shots.push({mesh,life:1.6});
 }
 tone(orbital?720:170,.065,orbital?'triangle':'sawtooth',orbital?.012:.018);
}
function removeObject(index){const o=objects[index];world.remove(o.mesh);if(o.ownedEdges){o.ownedEdges.geometry.dispose();o.ownedEdges.material.dispose();}objects.splice(index,1);}
function advanceGame(dt){
 const motion=gyro.sample(Math.min(dt,.25));
 if(mode!=='playing'||(gyro.selected&&!gyro.fresh))return 0;
 return advanceFrame(dt,step=>tick(step,motion));
}
function tick(dt,motion=gyro.sample(dt)){if(mode!=='playing'||(gyro.selected&&!gyro.fresh))return false;elapsed+=dt;distance+=speed*dt;score+=dt*8;const next=1+Math.floor(elapsed/25);if(next!==level){level=next;notice(`进入第 ${level} 战区 · 威胁提升`);tone(900,.3);}speed=Math.min(48,26+(level-1)*3);invuln=Math.max(0,invuln-dt);shake=Math.max(0,shake-dt);$('hitflash').style.opacity=shake>0?shake*1.5:0;
 const skill=missileSkillState(),wasCooling=skill.cooldown>0;
 skill.cooldown=Math.max(0,skill.cooldown-dt);
 if(wasCooling&&skill.cooldown===0)notice('跟踪导弹已就绪 · 按 Q 或点击释放');
 const dx=motion?motion.x:(keys.has('KeyD')||keys.has('ArrowRight')?1:0)-(keys.has('KeyA')||keys.has('ArrowLeft')?1:0)+touch.x;
 const dy=motion?motion.y:(keys.has('KeyW')||keys.has('ArrowUp')?1:0)-(keys.has('KeyS')||keys.has('ArrowDown')?1:0)+touch.y;
 player.x=clamp(player.x+clamp(dx,-1,1)*12*dt,-range.x,range.x);player.y=clamp(player.y+clamp(dy,-1,1)*9*dt,range.yMin,range.yMax);
 aircraft.position.set(player.x,player.y,player.z);aircraft.rotation.z=T.MathUtils.damp(aircraft.rotation.z,-dx*.32,8,dt);aircraft.rotation.x=T.MathUtils.damp(aircraft.rotation.x,dy*.12,8,dt);aircraft.visible=invuln>0?Math.floor(invuln*12)%2===0:true;
 camera.position.lerp(new T.Vector3(player.x*.38,player.y+6,22),1-Math.exp(-5*dt));camera.lookAt(player.x*.45,player.y+1,-24);if(shake){camera.position.x+=(Math.random()-.5)*shake;camera.position.y+=(Math.random()-.5)*shake;}
 spawnTimer-=dt;if(spawnTimer<=0){spawn();spawnTimer=Math.max(1.6,3.4-level*.15);}shotTimer-=dt;if((autoFire||keys.has('Space')||touch.fire)&&shotTimer<=0){fire();shotTimer=.14;}
 for(let i=shots.length-1;i>=0;i--){const s=shots[i];if(s.kind==='tracking')continue;s.prevZ=s.mesh.position.z;s.mesh.position.z-=115*dt;s.life-=dt;let hit=false;for(let j=objects.length-1;j>=0;j--){const o=objects[j];if(o.type==='coin')continue;const p=o.mesh.position;if(shotHitsObject(o,s)){hit=true;if(o.type==='enemy')damageEnemy(o,1,s.mesh.position);else particleBurst(s.mesh.position,0xffb66c,2);break;}}if(hit||s.life<=0){world.remove(s.mesh);shots.splice(i,1);}}
 for(let i=objects.length-1;i>=0;i--){const o=objects[i];const p=o.mesh.position;p.z+=speed*dt;if(o.type==='coin'){o.mesh.rotation.y+=dt*2.8;if(Math.hypot(p.x-player.x,p.y-player.y)<1.3&&Math.abs(p.z-player.z)<1.8){coins++;score+=25;tone(1300,.09,'sine',.025);particleBurst(p,0xffd16b,5);removeObject(i);continue;}}else{if(o.type==='asteroid'){o.mesh.rotation.x+=dt*o.spin;o.mesh.rotation.z+=dt*o.spin*.7;}if(o.type==='enemy'){p.x=clamp(o.baseX+Math.sin(elapsed*1.2+o.phase)*(elapsed<8?.35:1.8),-10,10);o.mesh.rotation.z=Math.cos(elapsed*1.2+o.phase)*.16;o.fire-=dt;if(o.fire<0&&p.z<-8&&p.z>-85){launchEnemyMissile(o);o.fire=Math.max(.9,2.5-level*.12);}}if(playerHitsObject(o)){damage();if(mode==='over')return;}}if(p.z>25)removeObject(i);}
 for(let i=shots.length-1;i>=0;i--){
  const s=shots[i];if(s.kind!=='tracking')continue;
  if(updateTrackingMissile(s,dt)){world.remove(s.mesh);shots.splice(i,1);}
 }
 for(let i=hostile.length-1;i>=0;i--){const b=hostile[i];b.mesh.position.addScaledVector(b.vel,dt);b.life-=dt;b.age+=dt;animateEnemyMissile(b.mesh,b.age,b.flamePhase);if(b.mesh.position.distanceTo(new T.Vector3(player.x,player.y,player.z))<.9){damage();b.life=0;if(mode==='over')return;}if(b.life<=0||b.mesh.position.z>30){world.remove(b.mesh);hostile.splice(i,1);}}
 for(let i=effects.length-1;i>=0;i--){const e=effects[i];e.life-=dt;e.mesh.position.addScaledVector(e.vel,dt);e.mesh.material.opacity=Math.max(0,e.life);if(e.life<=0){world.remove(e.mesh);e.mesh.material.dispose();effects.splice(i,1);}}
 particles.update(dt);cannon.update(dt);
 enemyExplosions.update(dt,speed,camera);
 activeMap.update(distance,elapsed);
 return true;}
async function prepareCombatRendering(){
 const warmup=new T.Group();warmup.name='Combat material warmup';warmup.visible=false;
 warmup.add(createEnemyAircraft(),createEnemyMissile(new T.Vector3(0,0,1)),createPlayerMissile(new T.Vector3(0,0,-1)),createMoraCoin(),
  cannon.createTracer(),cannon.createLaser(),createSeaStack(0,5,-30).mesh,createOrbitalObstacle(0,5,-30).mesh,createOrbitalGate(0,5,-40).mesh);
 world.add(warmup);enemyExplosions.prepare(renderer);
 camera.position.set(0,11,22);camera.lookAt(0,5,-24);
 aircraft.position.set(0,5,7);aircraft.scale.setScalar(.24);
 await prepareCurrentBattlefield();
}
async function prepareCurrentBattlefield(changeRegion){
 battlefieldPreparing=true;$('start').disabled=true;$('renderQuality').disabled=true;
 $('mapIsland').disabled=$('mapSpace').disabled=$('islandRegion').disabled=true;
 $('start').innerHTML='正在准备战场 <span>↗</span>';
 // 只预热当前战场；切换地图时在大厅准备，避免首次进入同时编译两套光照。
 try{
  if(changeRegion)await changeRegion();
  await activeMap.ready;
  $('loadError').classList.add('hidden');
  updateAircraftShadows();renderer.render(scene,camera);
  await renderer.compileAsync(scene,camera);
  if(selectedMap==='island')await activeMap.renderReflection(renderer,scene,camera,performance.now(),true);
 }catch(error){
  $('loadError').classList.remove('hidden');$('loadError').textContent=`战场准备失败：${error.message}。可重新选择区域重试。`;
 }finally{
  battlefieldPreparing=false;$('renderQuality').disabled=false;$('mapIsland').disabled=$('mapSpace').disabled=$('islandRegion').disabled=false;
  if(mode==='menu'){$('start').disabled=selectedMap==='island'&&!islandMap.loaded;$('start').innerHTML=$('start').disabled?'资源尚未就绪':'开始出击 <span>↗</span>';}
 }
}
async function boot(){try{const response=await fetch('assets/airplane-f22.glb');if(!response.ok)throw Error(`HTTP ${response.status}`);islandAircraft=parseAircraft(await response.arrayBuffer());spaceAircraft=createSpaceplane();aircraft=new T.Group();aircraft.name='Player aircraft carrier';aircraft.add(islandAircraft,spaceAircraft);scene.add(aircraft);islandAircraft.visible=selectedMap==='island';spaceAircraft.visible=selectedMap==='space';updateSpaceplane(spaceAircraft,0,false);await prepareCombatRendering();aircraft.scale.setScalar(.85);mode='menu';$('start').disabled=selectedMap==='island'&&!islandMap.loaded;$('start').innerHTML=$('start').disabled?'资源尚未就绪':'开始出击 <span>↗</span>';animate();}catch(e){$('loadError').classList.remove('hidden');$('loadError').textContent='模型加载失败。请通过本地 HTTP 服务打开游戏，并确认 assets/airplane-f22.glb 存在。'+e.message;}}
let last=performance.now(),menuTime=0;
function animate(now=performance.now()){
 requestAnimationFrame(animate);
 if(document.hidden||battlefieldPreparing){last=now;return;}
 if(!graphics.shouldDraw(now,mode==='playing'))return;
 const rawDt=Math.max(0,(now-last)/1000),dt=Math.min(rawDt,.25);last=now;
 if(mode==='playing')advanceGame(rawDt);
 else if(mode==='menu'){
  menuTime+=dt;activeMap.update(0,menuTime);aircraft.visible=true;
  aircraft.position.set(3.2,5+Math.sin(menuTime*.8)*.2,0);
  aircraft.rotation.set(.12,Math.PI*.16+Math.sin(menuTime*.18)*.12,-.13);
  camera.position.set(12,15,23);camera.lookAt(0,4,-1);
 }
 if(noticeTimer>0){noticeTimer-=dt;if(noticeTimer<=0)$('notice').style.opacity=0;}
 graphics.record(now,rawDt*1000,mode==='playing'&&(!gyro.selected||gyro.fresh),mode==='menu');
 particles.flush();cannon.flush(player,aircraft.quaternion,selectedMap==='island',shots);updateHUD(now);updateMissileHUD();
 updateTacticalHUD({mode,player,objects,elapsed,distance,kills},now);
 if(spaceAircraft&&selectedMap==='space')updateSpaceplane(spaceAircraft,mode==='menu'?menuTime:elapsed,mode!=='menu');
 activeMap.renderReflection(renderer,scene,camera,now);
 updateAircraftShadows(now);renderer.render(scene,camera);
}

$('start').onclick=$('restart').onclick=reset;$('pause').onclick=$('resume').onclick=pause;$('returnLobby').onclick=$('endLobby').onclick=returnLobby;$('fireMode').onclick=toggleFire;$('missileSkill').onclick=launchTrackingMissile;$('sound').onclick=()=>{muted=!muted;$('sound').textContent=`音效 ${muted?'OFF':'ON'}`;$('sound').setAttribute('aria-label',muted?'开启音效':'关闭音效');tone(700,.15);};
window.addEventListener('keydown',e=>{if(e.target.closest('input,select,textarea,#gyroPanel'))return;if(e.target.tagName==='BUTTON'&&e.code==='Space'&&mode!=='playing')return;if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();if(e.code==='KeyP'||e.code==='Escape'){if(!e.repeat)pause();return;}if(e.code==='KeyQ'){e.preventDefault();if(!e.repeat)launchTrackingMissile();return;}if(e.code==='KeyF'&&!e.repeat)toggleFire();if(mode==='playing')keys.add(e.code);});window.addEventListener('keyup',e=>keys.delete(e.code));window.addEventListener('blur',()=>{keys.clear();if(mode==='playing')pause();});document.addEventListener('visibilitychange',()=>{if(document.hidden&&mode==='playing')pause();});
const stick=$('stick');let stickId=null;function stickMove(e){const r=stick.getBoundingClientRect(),x=e.clientX-r.left-r.width/2,y=e.clientY-r.top-r.height/2,mag=Math.max(1,Math.hypot(x,y)/40);touch.x=x/mag/40;touch.y=-y/mag/40;$('thumb').style.transform=`translate(${touch.x*32}px,${-touch.y*32}px)`;}stick.onpointerdown=e=>{stickId=e.pointerId;stick.setPointerCapture(e.pointerId);stickMove(e);};stick.onpointermove=e=>{if(e.pointerId===stickId)stickMove(e);};stick.onpointerup=stick.onpointercancel=()=>{stickId=null;touch.x=touch.y=0;$('thumb').style.transform='';};$('touchFire').onpointerdown=e=>{touch.fire=true;e.target.setPointerCapture(e.pointerId);};$('touchFire').onpointerup=$('touchFire').onpointercancel=()=>touch.fire=false;
window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();graphics.resize(innerWidth,innerHeight);});
graphics.onChange=()=>{applyGraphicsQuality();if(mode==='menu'&&!battlefieldPreparing)void prepareCurrentBattlefield();};
boot();
