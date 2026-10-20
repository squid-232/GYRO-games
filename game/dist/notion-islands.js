import * as T from './vendor/three.module.js';
import {TERRAIN_XZ,TERRAIN_Y,ROUTE_SPACING,ROUTE_START,corridorX,preparePass,buildRoute,sampleRoute,heightAt} from './island-route.js';

// Authored in the user's Notion Island Maps v2 pack, converted by tools/import_notion_islands.py.
export const ISLAND_REGIONS = [
 ['01_Volcano','火山岛','黑沙海岸 · 火山熔湖'],['02_Atoll','珊瑚环礁','浅水潟湖 · 水上村落'],
 ['03_Archipelago','翡翠群岛','分散岛链 · 热带海岸'],['04_Crescent_Bay','月牙湾','弧形山脊 · 避风海湾'],
 ['05_Cliff_Plateau','悬崖台地','断崖峡谷 · 海蚀岩柱'],['06_Twin_Peaks','双子峰','双峰山脊 · 狭长鞍部'],
 ['07_Karst_Towers','喀斯特峰林','石灰岩峰 · 碧水潟湖'],['08_River_Valley','雨林河谷','高山湖泊 · 入海河流'],
 ['09_Glacier_Fjord','冰川峡湾','冰雪山脉 · 浮冰峡湾']
].map(([id,name,description])=>({id,name,description}));
const BASE='./assets/notion-islands/', SCALE=TERRAIN_XZ, PERIOD=ROUTE_SPACING*4;
const textureCache=new Map(), modelCache=new Map(), materialCache=new Map();
const clock={value:0},animatedTextures=[];let manifestPromise,obstacleParts;
async function fetchFile(path,binary=false){
 const response=await fetch(BASE+path);
 if(!response.ok)throw Error(`海岛资源加载失败：${path} (${response.status})`);
 return binary?response.arrayBuffer():response.json();
}
function manifest(){return manifestPromise??=fetchFile('manifest.json').catch(e=>{manifestPromise=null;throw e;});}
function texture(path,color=false){
 const key=path+color;
 if(!textureCache.has(key))textureCache.set(key,new T.TextureLoader().loadAsync(BASE+path).then(t=>{
  t.colorSpace=color?T.SRGBColorSpace:T.NoColorSpace;t.wrapS=t.wrapT=T.RepeatWrapping;t.anisotropy=4;return t;
 }).catch(()=>{textureCache.delete(key);throw Error(`无法加载海岛纹理：${path}`);}));
 return textureCache.get(key);
}
async function material(name,info){
 if(!materialCache.has(name))materialCache.set(name,(async()=>{
  const src=info.materials[name]||{},water=/RiverWater|LakeWater/.test(name),lava=name==='LavaLake';
  const maps={};await Promise.all(['map','normalMap','emissiveMap'].map(async key=>{if(src[key])maps[key]=await texture(src[key],key!=='normalMap');}));
  if(water||lava)for(const slot of Object.keys(maps)){maps[slot]=maps[slot].clone();maps[slot].needsUpdate=true;animatedTextures.push({map:maps[slot],x:lava?.015:0,y:lava?.009:water?-.03:0});}
  const color=new T.Color().setRGB(...(src.color||[1,1,1]),T.SRGBColorSpace);
  // Albedo textures already contain their base colors; avoid tinting them twice.
  if(maps.map)color.setRGB(.9,.92,.88);
  const mat=new T.MeshStandardMaterial({color,...maps,roughness:water?.24:src.roughness??.8,
   metalness:src.metalness??0,envMapIntensity:water?.65:.28,
   transparent:(src.opacity??1)<1,opacity:src.opacity??1,depthWrite:(src.opacity??1)>=1,
   side:/Leaf|Needles|Grass|BroadLeaf/.test(name)?T.DoubleSide:T.FrontSide});
  mat.name=name;mat.normalScale.set(.65,.65);
  if(src.emissive){mat.emissive.setRGB(...src.emissive);mat.emissiveIntensity=lava?1.4:.7;}
  mat.onBeforeCompile=shader=>{
   shader.uniforms.uIslandTime=clock;
   shader.vertexShader='varying vec3 vIslandLocal;\n'+shader.vertexShader;
   shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvIslandLocal = position;');
   shader.fragmentShader='varying vec3 vIslandLocal; uniform float uIslandTime;\n'+shader.fragmentShader;
   shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
    float luminance=dot(diffuseColor.rgb,vec3(.2126,.7152,.0722));
    diffuseColor.rgb=mix(vec3(luminance),diffuseColor.rgb,.82);
    ${lava?'diffuseColor.rgb *= .87 + .13*sin(vIslandLocal.x*.4+vIslandLocal.z*.3-uIslandTime*.8);':''}`);
   if(water)shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
    normal=normalize(normal+vec3(sin(vIslandLocal.x*.65+uIslandTime)*.07,cos(vIslandLocal.z*.8-uIslandTime*.7)*.05,0.));`);
  };
  mat.customProgramCacheKey=()=>`notion-pbr-v1-${water}-${lava}`;return mat;
 })().catch(e=>{materialCache.delete(name);throw e;}));
 return materialCache.get(name);
}
async function model(name,info){
 if(!modelCache.has(name))modelCache.set(name,(async()=>{
  const def=info.models[name];if(!def)throw Error(`缺少海岛模型 ${name}`);
  const buffer=await fetchFile(def.file,true);
  if(buffer.byteLength!==def.vertices*32+def.indices*4||def.indices%3!==0||
   def.groups.some(g=>g.start%3!==0||g.count%3!==0||g.start<0||g.count<0||g.start+g.count>def.indices)||
   def.groups.reduce((sum,g)=>sum+g.count,0)!==def.indices){
   throw Error(`海岛模型索引数据不完整：${name}，请更新模型和 manifest.json 后重试`);
  }
  const interleaved=new T.InterleavedBuffer(new Float32Array(buffer,0,def.vertices*8),8);
  const indices=new Uint32Array(buffer,def.vertices*32,def.indices);
  return Promise.all(def.groups.map(async group=>{
   const geometry=new T.BufferGeometry();
   geometry.setAttribute('position',new T.InterleavedBufferAttribute(interleaved,3,0));
   geometry.setAttribute('normal',new T.InterleavedBufferAttribute(interleaved,3,3));
   geometry.setAttribute('uv',new T.InterleavedBufferAttribute(interleaved,2,6));
   geometry.setIndex(new T.BufferAttribute(indices.slice(group.start,group.start+group.count),1));
   geometry.computeBoundingSphere();return {geometry,material:await material(group.material,info)};
  }));
 })().catch(e=>{modelCache.delete(name);throw e;}));
 return modelCache.get(name);
}
function rockMaterial(source,variant){
 const mat=source.clone();mat.name=`Weathered coastal rock ${variant+1}`;
 mat.color.setHex([0xa8aaa0,0xa29e90,0x909997,0xb2aa99,0x999b90,0x9a9390][variant]);
 mat.roughness=.87;mat.envMapIntensity=.22;mat.normalScale.set(.42,.42);
 mat.onBeforeCompile=shader=>{
  shader.vertexShader='varying vec3 vRockPoint; varying vec3 vRockNormal;\n'+shader.vertexShader;
  shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
   vec3 rockScale=vec3(length(modelMatrix[0].xyz),length(modelMatrix[1].xyz),length(modelMatrix[2].xyz));
   vRockPoint=position*rockScale;
   vRockNormal=normalize(normal/rockScale);`);
  shader.fragmentShader='varying vec3 vRockPoint; varying vec3 vRockNormal;\n'+shader.fragmentShader;
  // Object-relative triplanar coordinates stay fixed as an obstacle scrolls past.
  // Texel density follows its actual dimensions, without stretching the source UV.
  shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`
   #ifdef USE_MAP
    vec3 blend=pow(abs(normalize(vRockNormal)),vec3(4.));blend/=max(dot(blend,vec3(1.)),.0001);
    vec3 p=vRockPoint*.46;
    vec4 rockTex=texture2D(map,p.yz)*blend.x+texture2D(map,p.xz)*blend.y+texture2D(map,p.xy)*blend.z;
    float luminance=dot(rockTex.rgb,vec3(.2126,.7152,.0722));
    rockTex.rgb=mix(vec3(luminance),rockTex.rgb,.35);
    diffuseColor*=rockTex;
   #endif`);
  shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
   float wet=1.-smoothstep(.12,.85,vRockPoint.y);
   float grain=sin(vRockPoint.x*31.+sin(vRockPoint.z*17.))*sin(vRockPoint.y*27.)*.035;
   diffuseColor.rgb*=mix(1.,.53,wet)+grain;`);
  shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=mix(roughnessFactor,.32,wet);');
 };mat.customProgramCacheKey=()=> 'sculpted-coast-rock-v1';return mat;
}
function prepareObstacle(parts){
 if(obstacleParts)return;
 const bounds=new T.Box3(),point=new T.Vector3();let radius=0;
 for(const part of parts){const p=part.geometry.attributes.position;for(let i=0;i<p.count;i++){point.fromBufferAttribute(p,i);bounds.expandByPoint(point);radius=Math.max(radius,Math.hypot(point.x,point.z));}}
 const height=Math.max(.001,bounds.max.y-bounds.min.y);radius=Math.max(.001,radius);
 const transform=new T.Matrix4().makeScale(1/radius,1/height,1/radius).multiply(new T.Matrix4().makeTranslation(0,-bounds.min.y,0));
 obstacleParts=Array.from({length:6},(_,variant)=>{
  const phase=variant*1.73,geometries=parts.map(part=>part.geometry.clone().applyMatrix4(transform));let outer=0,top=0;
  for(const geometry of geometries){const p=geometry.attributes.position;
   for(let i=0;i<p.count;i++){
    const x=p.getX(i),y=p.getY(i),z=p.getZ(i),a=Math.atan2(z,x);
    const pedestal=.17*Math.exp(-y*13.);
    const shoulder=.11*Math.exp(-Math.pow((y-.68)/.19,2));
    const notch=.12*Math.exp(-Math.pow((y-.27)/.075,2));
    const fissures=.055*Math.pow(.5+.5*Math.sin(a*5.+phase+y*.8),8);
    const strata=.018*Math.sin(y*54.+Math.sin(a*3.+phase)*.65);
    const profile=.77+pedestal+shoulder-notch+strata-fissures;
    const lobes=1.+.065*Math.sin(a*3.+phase)+.035*Math.sin(a*7.-phase+y*3.);
    const lean=Math.sin(y*Math.PI*.5)*.07;
    const nx=x*profile*lobes+lean*Math.cos(phase),nz=z*profile*lobes+lean*Math.sin(phase);
    // Trim the crown along a fractured, sloping plane instead of a pointed tip.
    const cap=.9+.025*Math.sin(phase)+x*.045-z*.035+.012*Math.sin((x+z)*11.+phase);
    const ny=Math.max(0,Math.min(y,cap));
    p.setXYZ(i,nx,ny,nz);outer=Math.max(outer,Math.hypot(nx,nz));top=Math.max(top,ny);
   }
  }
  return geometries.map((geometry,i)=>{
   // Keep the refined silhouette inside exactly the original collision envelope.
   geometry.scale(.97/Math.max(outer,.001),1/Math.max(top,.001),.97/Math.max(outer,.001));
   geometry.computeVertexNormals();geometry.computeBoundingBox();geometry.computeBoundingSphere();
   return {geometry,material:rockMaterial(parts[i].material,variant)};
  });
 });
}
export function createImportedSeaStack(){
 if(!obstacleParts)return null;
 const root=new T.Group(),parts=obstacleParts[Math.floor(Math.random()*obstacleParts.length)];
 root.rotation.y=Math.random()*Math.PI*2;
 for(const part of parts)root.add(new T.Mesh(part.geometry,part.material));return root;
}
function terrain(data,segments){
 const positions=[],uv=[],indices=[],width=segments+1;
 for(let z=0;z<=segments;z++)for(let x=0;x<=segments;x++){
  const px=(x/segments-.5)*data.size,pz=(z/segments-.5)*data.size;
  positions.push(px,heightAt(data,px,pz),pz);uv.push(x/segments,z/segments);
 }
 for(let z=0;z<segments;z++)for(let x=0;x<segments;x++){const a=z*width+x;indices.push(a,a+width,a+1,a+1,a+width,a+width+1);}
 const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(positions,3));
 geometry.setAttribute('uv',new T.Float32BufferAttribute(uv,2));geometry.setIndex(indices);geometry.computeVertexNormals();return geometry;
}
function terrainMaterial(map,rock){
 const mat=new T.MeshStandardMaterial({map,roughness:.94,metalness:.01,envMapIntensity:.18});
 mat.userData.cliffTexture=rock;
 mat.onBeforeCompile=shader=>{
  shader.uniforms.uCliffRock={value:rock};
  shader.vertexShader='varying vec3 vIslandGround; varying vec3 vIslandNormal;\n'+shader.vertexShader;
  shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvIslandGround=position;vIslandNormal=normalize(normal/vec3(.60,.88,.60));');
  shader.fragmentShader='varying vec3 vIslandGround;varying vec3 vIslandNormal;uniform sampler2D uCliffRock;\n'+shader.fragmentShader;
  shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
   float wet=1.-smoothstep(-.3,2.3,vIslandGround.y);
   vec3 groundNormal=normalize(vIslandNormal),blend=pow(abs(groundNormal),vec3(4.));blend/=max(dot(blend,vec3(1.)),.001);
   vec3 rockPoint=vIslandGround*vec3(.60,.88,.60)*.24;
   vec3 rockColor=texture2D(uCliffRock,rockPoint.yz).rgb*blend.x+texture2D(uCliffRock,rockPoint.xz).rgb*blend.y+texture2D(uCliffRock,rockPoint.xy).rgb*blend.z;
   float cliff=1.-smoothstep(.35,.80,abs(groundNormal.y));
   float rockLuma=dot(rockColor,vec3(.2126,.7152,.0722));
   rockColor=mix(vec3(rockLuma),rockColor,.35)*vec3(.77,.82,.79);
   diffuseColor.rgb=mix(diffuseColor.rgb,rockColor,cliff*.94);
   diffuseColor.rgb=mix(vec3(dot(diffuseColor.rgb,vec3(.2126,.7152,.0722))),diffuseColor.rgb,.82);
   diffuseColor.rgb*=mix(.96,.64,wet);
   float rockRelief=rockLuma*cliff;`);
  shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
   vec3 terrainDX=dFdx(-vViewPosition),terrainDY=dFdy(-vViewPosition);
   vec3 terrainR1=cross(terrainDY,normal),terrainR2=cross(normal,terrainDX);
   float terrainDet=dot(terrainDX,terrainR1);
   vec3 terrainGrad=dFdx(rockRelief)*terrainR1+dFdy(rockRelief)*terrainR2;
   normal=normalize(abs(terrainDet)*normal-sign(terrainDet)*terrainGrad*.055);`);
  shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=mix(roughnessFactor,.38,wet);');
 };mat.customProgramCacheKey=()=> 'notion-terrain-triplanar-cliffs-v3';return mat;
}
function coastMaterial(data){
 const bytes=new Uint8Array(257*257*2);
 for(let i=0;i<data.heights.length;i++){bytes[i*2]=data.heights[i]>>>8;bytes[i*2+1]=data.heights[i]&255;}
 const depth=new T.DataTexture(bytes,257,257,T.RGFormat);depth.magFilter=depth.minFilter=T.LinearFilter;depth.needsUpdate=true;
 const icy=data.name==='09_Glacier_Fjord';
 const mat=new T.ShaderMaterial({transparent:true,depthWrite:false,uniforms:{uHeight:{value:depth},uRange:{value:data.sizeY},uDepth:{value:data.depth},uTime:clock,uTint:{value:new T.Color(icy?0x5b929a:0x307f7c)}},
  vertexShader:`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
  fragmentShader:`uniform sampler2D uHeight;uniform float uRange,uDepth,uTime;uniform vec3 uTint;varying vec2 vUv;
   void main(){vec2 packed=texture2D(uHeight,vUv).rg;float h=dot(packed,vec2(65280.,255.))/65535.*uRange-uDepth;
    if(h>.12||h< -18.)discard;
    float edge=smoothstep(0.,.035,min(min(vUv.x,vUv.y),min(1.-vUv.x,1.-vUv.y)));
    float shallow=1.-smoothstep(0.,18.,-h);
    float wash=.5+.5*sin(h*3.5+uTime*1.6+sin(vUv.x*90.+vUv.y*65.)*.5);
    float foam=(1.-smoothstep(.1,1.8,abs(h+.3)))*(.28+.32*wash);
    vec3 color=mix(uTint,vec3(.66,.79,.75),foam);
    gl_FragColor=vec4(color,edge*(shallow*.26+foam*.5));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
   }`});
 return {mat,depth};
}
const smallProps=new Set(['Seashells','Starfish','Crate','Barrel','Campfire','Signpost','TreasureChest','BeachGrass','Rock_Pebbles']);
function addInstances(parent,parts,placements,category){
 const matrix=new T.Matrix4(),rotation=new T.Quaternion(),axis=new T.Vector3(0,1,0),position=new T.Vector3(),scale=new T.Vector3();
 for(const part of parts){
  const mesh=new T.InstancedMesh(part.geometry,part.material,placements.length);mesh.userData.category=category;mesh.userData.total=placements.length;
  for(let i=0;i<placements.length;i++){
   const p=placements[i];position.set(p.x,p.y,p.z);rotation.setFromAxisAngle(axis,T.MathUtils.degToRad(p.rot||0));scale.set(p.scale||1,(p.scale||1)*TERRAIN_XZ/TERRAIN_Y,p.scale||1);
   matrix.compose(position,rotation,scale);mesh.setMatrixAt(i,matrix);
  }
  mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();parent.add(mesh);
 }
}
export function createNotionIslands(parent,shores,seaLevel){
 const regions=new Map(),slots=[];let loading,obstacleWarmup,quality=0,disposed=false,gpuReady=false,bag=[],lastRegion='',focus='03_Archipelago';
 function nextRegion(exclude){
  if(!bag.length){bag=ISLAND_REGIONS.map(r=>r.id);for(let i=bag.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[bag[i],bag[j]]=[bag[j],bag[i]];}}
  let index=bag.findIndex(id=>!exclude.has(id)&&id!==lastRegion);
  // A blocked bag tail is retained for later; choose an inactive region now.
  if(index<0){const choices=ISLAND_REGIONS.map(r=>r.id).filter(id=>!exclude.has(id)&&id!==lastRegion);return lastRegion=choices[Math.floor(Math.random()*choices.length)];}
  return lastRegion=bag.splice(index,1)[0];
 }
 async function buildRegion(id,info){
  if(regions.has(id))return;
  const data=await fetchFile(`${id}/layout.json`);
  const [raw,map]=await Promise.all([fetchFile(`${id}/height.r16`,true),texture(`${id}/color.webp`,true)]);
  data.heights=new Uint16Array(raw);if(data.heights.length!==257*257)throw Error('海岛地形数据长度错误');
  preparePass(data);
  const vegetation=data.trees.filter((_,i)=>i%Math.max(1,Math.ceil(data.trees.length/160))===0).map(p=>({
   prefab:data.protos[p.p],x:p.x,z:p.z,y:heightAt(data,p.x,p.z),rot:p.r,scale:p.s,tree:true}));
  const props=data.props.filter(p=>!data.originalHeights||Math.abs(p.x-corridorX(id,p.z))>40).map(p=>({...p,y:p.y+(data.originalHeights?heightAt(data,p.x,p.z)-heightAt(data,p.x,p.z,data.originalHeights):0)}));
  const placements=[...props,...vegetation.filter(p=>!data.originalHeights||Math.abs(p.x-corridorX(id,p.z))>38)],names=[...new Set([...placements.map(p=>p.prefab),...data.meshes.map(m=>m.model)])];
  const assets=new Map(await Promise.all(names.map(async name=>[name,await model(name,info)])));
  const lowAssets=new Map(await Promise.all(names.map(async name=>[name,info.models[name].lod?await model(info.models[name].lod,info):assets.get(name)])));
  if(disposed)return;
  const group=new T.Group();group.name=`Notion / ${data.cn}`;group.scale.set(SCALE,TERRAIN_Y,SCALE);group.visible=false;
  const rock=await texture(info.materials.RockGray.map,true);
  const geometries=[terrain(data,64),terrain(data,128),terrain(data,256)],ground=terrainMaterial(map,rock),coast=coastMaterial(data);
  const coastGeometry=new T.PlaneGeometry(data.size,data.size);coastGeometry.rotateX(-Math.PI/2);
  const uv=coastGeometry.attributes.uv;for(let i=0;i<uv.count;i++)uv.setY(i,1-uv.getY(i));
  const land=new T.Mesh(geometries[0],ground);group.add(land);
  const foam=new T.Mesh(coastGeometry,coast.mat);foam.position.y=.10;group.add(foam);
  const details=new T.Group(),lowDetails=new T.Group();group.add(details,lowDetails);
  const byType=new Map();for(const p of placements){if(!byType.has(p.prefab))byType.set(p.prefab,[]);byType.get(p.prefab).push(p);}
  for(const [name,list] of byType){
   if(list[0].tree)list.sort((a,b)=>Math.sin(a.x*12.98+a.z*78.23)-Math.sin(b.x*12.98+b.z*78.23));
   const category=list[0].tree?'tree':smallProps.has(name)?'small':/Rowboat|Iceberg/.test(name)?'floating':'landmark';
   addInstances(details,assets.get(name),list,category);addInstances(lowDetails,lowAssets.get(name),list,category);
  }
  const adjusted=[];
  for(const mesh of data.meshes)for(const part of assets.get(mesh.model)){
   let geometry=part.geometry;
   if(data.originalHeights){geometry=geometry.clone();const p=geometry.attributes.position;
    for(let i=0;i<p.count;i++){const x=p.getX(i),z=p.getZ(i);p.setY(i,p.getY(i)+heightAt(data,x,z)-heightAt(data,x,z,data.originalHeights));}
    geometry.computeVertexNormals();geometry.computeBoundingSphere();adjusted.push(geometry);
   }group.add(new T.Mesh(geometry,part.material));
  }
  regions.set(id,{id,data,adjusted,group,land,details,lowDetails,foam,geometries,ground,coast,coastGeometry});parent.add(group);shores.push(foam);parent.dispatchEvent({type:'terrainprogress',loaded:regions.size,total:ISLAND_REGIONS.length});
 }
 async function prepare(){
  if(loading)return loading;if(regions.size===ISLAND_REGIONS.length)return;
  loading=(async()=>{
   const info=await manifest();prepareObstacle(await model('Rock_SeaStack',info));
   if(!obstacleWarmup){obstacleWarmup=createImportedSeaStack();obstacleWarmup.visible=false;obstacleWarmup.name='Coastal rock material warmup';parent.add(obstacleWarmup);}
   // Complete all loading in the lobby. Recycling only reuses existing scene nodes.
   // Await every job before allowing retry, so a failed request cannot duplicate a tile.
   const results=await Promise.allSettled(ISLAND_REGIONS.map(r=>buildRegion(r.id,info)));
   const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;
   if(!disposed)reset();
  })();
  try{return await loading;}finally{loading=null;}
 }
 function assign(slot,id){
  if(slot.region)slot.region.group.visible=false;
  slot.region=regions.get(id);const g=slot.region.group;g.visible=true;
  slot.x=0;g.position.set(slot.x,seaLevel,7-slot.center);g.rotation.y=0;
  slot.profile=buildRoute(slot.region.data,slot.x,seaLevel);
 }
 function reset(){
  if(regions.size!==ISLAND_REGIONS.length)return;
  for(const region of regions.values())region.group.visible=false;
  slots.length=0;bag=[];lastRegion='';const used=new Set();
  // A readable opening establishes the new mountain scale; following sectors shuffle.
  for(let i=0;i<4;i++){const slot={side:i%2?-1:1,center:ROUTE_START+i*ROUTE_SPACING};
   const id=i===0?'05_Cliff_Plateau':nextRegion(used);used.add(id);assign(slot,id);slots.push(slot);
  }update(0,0);
 }
 let traveled=0;
 function update(distance,elapsed){
  traveled=distance;clock.value=elapsed;for(const item of animatedTextures)item.map.offset.set(elapsed*item.x,elapsed*item.y);
  for(const slot of slots){
   // Keep the entire connecting spline alive until camera and trailing effects pass it.
   while(distance-slot.center>370){const used=new Set(slots.map(s=>s.region.id));slot.center+=PERIOD;slot.side*=-1;assign(slot,nextRegion(used));}
   const tile=slot.region,z=7+distance-slot.center;tile.group.position.z=z;
   const near=z> -550&&z<230;
   tile.land.geometry=tile.geometries[near?(quality===0?1:2):0];
   const detailed=quality===2&&z> -270;tile.details.visible=near&&detailed;tile.lowDetails.visible=near&&!detailed;
   if(near)for(const mesh of (detailed?tile.details:tile.lowDetails).children){
    const kind=mesh.userData.category,total=mesh.userData.total;
    mesh.visible=kind!=='small'||quality>0&&z> -180;
    if(kind==='floating')mesh.position.y=Math.sin(elapsed*1.2)*.06;
    mesh.count=kind==='tree'?Math.max(1,Math.ceil(total*[.35,.65,1][quality])):total;
   }
  }
  const nearest=slots.reduce((best,s)=>!best||Math.abs(s.center-distance)<Math.abs(best.center-distance)?s:best,null);
  if(nearest&&focus!==nearest.region.id){focus=nearest.region.id;parent.dispatchEvent({type:'regionchange'});}
 }
 function navigation(distance,out={}){
  const slot=slots.find(s=>Math.abs(distance-s.center)<336);
  out.x=out.y=0;out.active=false;out.transition=false;out.phase=Infinity;out.name='开阔海域';out.key='sea';out.pass=false;
  if(slot){sampleRoute(slot.profile,distance-slot.center,out);out.phase=distance-slot.center;
   out.active=Math.abs(out.phase)<300;out.transition=Math.abs(out.phase)>145&&out.active;
   out.pass=!!slot.region.data.originalHeights;out.name=ISLAND_REGIONS.find(r=>r.id===slot.region.id).name;out.key=`${slot.center}:${slot.region.id}`;
  }return out;
 }
 function groundHeight(x,z){
  let height=seaLevel;
  for(const slot of slots){const g=slot.region.group,lx=(x-g.position.x)/SCALE,lz=(z-g.position.z)/SCALE;
   height=Math.max(height,seaLevel+heightAt(slot.region.data,lx,lz)*TERRAIN_Y);
  }return height;
 }
 function prepareGPU(renderer){
  if(gpuReady||regions.size!==ISLAND_REGIONS.length)return;
  const textures=new Set();
  for(const region of regions.values()){
   textures.add(region.coast.depth);textures.add(region.ground.userData.cliffTexture);
   region.group.traverse(object=>{if(object.material)for(const key of ['map','normalMap','emissiveMap']){const texture=object.material[key];if(texture)textures.add(texture);}});
  }
  for(const texture of textures)renderer.initTexture(texture);
  gpuReady=true;
 }
 return {update,reset,prepareGPU,navigation,groundHeight,get ready(){return prepare();},get region(){return focus;},get loaded(){return regions.size===ISLAND_REGIONS.length;},
  setQuality(profile){quality=profile.reflectionSize>512?2:profile.shadows?1:0;},
  dispose(){
   disposed=true;slots.length=0;if(obstacleWarmup)parent.remove(obstacleWarmup);
   for(const region of regions.values()){
    parent.remove(region.group);const i=shores.indexOf(region.foam);if(i>=0)shores.splice(i,1);
    region.group.traverse(o=>{if(o.isInstancedMesh)o.dispose();});region.geometries.forEach(g=>g.dispose());region.adjusted.forEach(g=>g.dispose());
    region.ground.map.dispose();textureCache.delete(`${region.id}/color.webptrue`);region.ground.dispose();region.coast.mat.dispose();region.coast.depth.dispose();region.coastGeometry.dispose();
   }
   regions.clear();
  }};
}
