import * as T from './vendor/three.module.js';

// Authored in the user's Notion Island Maps v2 pack, converted by tools/import_notion_islands.py.
export const ISLAND_REGIONS = [
 ['01_Volcano','火山岛','黑沙海岸 · 火山熔湖'],['02_Atoll','珊瑚环礁','浅水潟湖 · 水上村落'],
 ['03_Archipelago','翡翠群岛','分散岛链 · 热带海岸'],['04_Crescent_Bay','月牙湾','弧形山脊 · 避风海湾'],
 ['05_Cliff_Plateau','悬崖台地','断崖峡谷 · 海蚀岩柱'],['06_Twin_Peaks','双子峰','双峰山脊 · 狭长鞍部'],
 ['07_Karst_Towers','喀斯特峰林','石灰岩峰 · 碧水潟湖'],['08_River_Valley','雨林河谷','高山湖泊 · 入海河流'],
 ['09_Glacier_Fjord','冰川峡湾','冰雪山脉 · 浮冰峡湾']
].map(([id,name,description])=>({id,name,description}));
const BASE='./assets/notion-islands/', SCALE=.22, PERIOD=520;
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
function prepareObstacle(parts){
 if(obstacleParts)return;
 const bounds=new T.Box3(),point=new T.Vector3();let radius=0;
 for(const part of parts){const p=part.geometry.attributes.position;for(let i=0;i<p.count;i++){point.fromBufferAttribute(p,i);bounds.expandByPoint(point);radius=Math.max(radius,Math.hypot(point.x,point.z));}}
 const height=Math.max(.001,bounds.max.y-bounds.min.y);radius=Math.max(.001,radius);
 const transform=new T.Matrix4().makeScale(1/radius,1/height,1/radius).multiply(new T.Matrix4().makeTranslation(0,-bounds.min.y,0));
 obstacleParts=parts.map(p=>({geometry:p.geometry.clone().applyMatrix4(transform),material:p.material}));
}
// Geometry fits exactly inside radius 1 / height 1, retaining existing hit bounds.
export function createImportedSeaStack(){
 if(!obstacleParts)return null;
 const root=new T.Group();for(const part of obstacleParts)root.add(new T.Mesh(part.geometry,part.material));return root;
}
function heightAt(data,x,z){
 const u=T.MathUtils.clamp((x/data.size+.5)*256,0,256),v=T.MathUtils.clamp((z/data.size+.5)*256,0,256);
 const ix=Math.min(255,Math.floor(u)),iz=Math.min(255,Math.floor(v)),a=u-ix,b=v-iz,h=data.heights;
 return T.MathUtils.lerp(T.MathUtils.lerp(h[iz*257+ix],h[iz*257+ix+1],a),T.MathUtils.lerp(h[(iz+1)*257+ix],h[(iz+1)*257+ix+1],a),b)/65535*data.sizeY-data.depth;
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
function terrainMaterial(map){
 const mat=new T.MeshStandardMaterial({map,roughness:.92,metalness:.015,envMapIntensity:.22});
 mat.onBeforeCompile=shader=>{
  shader.vertexShader='varying vec3 vIslandGround;\n'+shader.vertexShader;
  shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvIslandGround=position;');
  shader.fragmentShader='varying vec3 vIslandGround;\n'+shader.fragmentShader;
  shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
   float wet=1.-smoothstep(-.3,2.3,vIslandGround.y);
   float grain=sin(vIslandGround.x*4.7)*sin(vIslandGround.z*5.2)*.025;
   diffuseColor.rgb=mix(vec3(dot(diffuseColor.rgb,vec3(.2126,.7152,.0722))),diffuseColor.rgb,.8);
   diffuseColor.rgb*=mix(.94,.66,wet)+grain;`);
  shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=mix(roughnessFactor,.38,wet);');
 };mat.customProgramCacheKey=()=> 'notion-terrain-v1';return mat;
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
   const p=placements[i];position.set(p.x,p.y,p.z);rotation.setFromAxisAngle(axis,T.MathUtils.degToRad(p.rot||0));scale.setScalar(p.scale||1);
   matrix.compose(position,rotation,scale);mesh.setMatrixAt(i,matrix);
  }
  mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();parent.add(mesh);
 }
}
export function createNotionIslands(parent,shores,seaLevel){
 let current,loading,requested='03_Archipelago',quality=0,disposed=false;
 try{const saved=localStorage.getItem('gyro-island-region');if(ISLAND_REGIONS.some(r=>r.id===saved))requested=saved;}catch{}
 async function setRegion(id){
  if(!ISLAND_REGIONS.some(r=>r.id===id))throw Error('未知海岛区域');
  if(loading)return loading;
  if(current?.id===id)return;
  loading=(async()=>{
   const info=await manifest(),data=await fetchFile(`${id}/layout.json`);
   // Collision obstacles pass close to the camera; keep the complete source surface and UVs.
   prepareObstacle(await model('Rock_SeaStack',info));
   const [raw,map]=await Promise.all([fetchFile(`${id}/height.r16`,true),texture(`${id}/color.webp`,true)]);
   data.heights=new Uint16Array(raw);if(data.heights.length!==257*257)throw Error('海岛地形数据长度错误');
   // Uniformly sample the source placement list; do not retain only its first corner.
   const vegetation=data.trees.filter((_,i)=>i%Math.max(1,Math.ceil(data.trees.length/160))===0).map(p=>({
    prefab:data.protos[p.p],x:p.x,z:p.z,y:heightAt(data,p.x,p.z),rot:p.r,scale:p.s,tree:true}));
   const placements=[...data.props,...vegetation],names=[...new Set([...placements.map(p=>p.prefab),...data.meshes.map(m=>m.model)])];
   const assets=new Map(await Promise.all(names.map(async name=>[name,await model(name,info)])));
   const lowAssets=new Map(await Promise.all(names.map(async name=>[name,info.models[name].lod?await model(info.models[name].lod,info):assets.get(name)])));
   if(disposed)return;
   const root=new T.Group();root.name=`Notion / ${data.cn}`;
   const geometries=[terrain(data,64),terrain(data,128),terrain(data,256)],ground=terrainMaterial(map),coast=coastMaterial(data);
   const coastGeometry=new T.PlaneGeometry(data.size,data.size);coastGeometry.rotateX(-Math.PI/2);
   // PlaneGeometry's +V points toward -Z; height rows instead run south to north.
   const uv=coastGeometry.attributes.uv;for(let i=0;i<uv.count;i++)uv.setY(i,1-uv.getY(i));
   const tiles=[],surf=[];
   const byType=new Map();for(const p of placements){if(!byType.has(p.prefab))byType.set(p.prefab,[]);byType.get(p.prefab).push(p);}
   for(let i=0;i<4;i++){
    const tile=new T.Group();tile.scale.setScalar(SCALE);tile.position.set((i%2?1:-1)*70,seaLevel,-42-i*130);tile.rotation.y=(i%2?1:-1)*Math.PI/2;root.add(tile);
    const land=new T.Mesh(geometries[1],ground);tile.add(land);
    const foam=new T.Mesh(coastGeometry,coast.mat);foam.position.y=.10;tile.add(foam);surf.push(foam);
    const details=new T.Group(),lowDetails=new T.Group();tile.add(details,lowDetails);
    for(const [name,list] of byType){
     // Hash ordering spreads every density prefix over the full source island.
     if(list[0].tree)list.sort((a,b)=>Math.sin(a.x*12.98+a.z*78.23)-Math.sin(b.x*12.98+b.z*78.23));
     const category=list[0].tree?'tree':smallProps.has(name)?'small':/Rowboat|Iceberg/.test(name)?'floating':'landmark';
     addInstances(details,assets.get(name),list,category);addInstances(lowDetails,lowAssets.get(name),list,category);
    }
    for(const mesh of data.meshes)for(const part of assets.get(mesh.model)){const surface=new T.Mesh(part.geometry,part.material);tile.add(surface);}
    tiles.push({group:tile,startZ:tile.position.z,land,details,lowDetails});
   }
   const previous=current;current={id,root,tiles,surf,geometries,ground,coast,coastGeometry};parent.add(root);
   if(previous)release(previous);
   shores.push(...surf);requested=id;
   try{localStorage.setItem('gyro-island-region',id);}catch{}
   update(0,clock.value);
  })();
  try{return await loading;}finally{loading=null;}
 }
 function release(region){
  parent.remove(region.root);for(const foam of region.surf){const i=shores.indexOf(foam);if(i>=0)shores.splice(i,1);}
  region.root.traverse(o=>{if(o.isInstancedMesh)o.dispose();});
  region.geometries.forEach(g=>g.dispose());region.ground.map.dispose();textureCache.delete(`${region.id}/color.webptrue`);region.ground.dispose();region.coast.mat.dispose();region.coast.depth.dispose();region.coastGeometry.dispose();
 }
 function update(distance,elapsed){
  clock.value=elapsed;for(const item of animatedTextures)item.map.offset.set(elapsed*item.x,elapsed*item.y);if(!current)return;
  for(const tile of current.tiles){
   const z=120-((120-tile.startZ-distance)%PERIOD+PERIOD)%PERIOD;tile.group.position.z=z;
   const near=z>-(quality===2?230:170)&&z<100;
   tile.land.geometry=current.geometries[near?(quality===2?2:quality===1?1:0):0];
   const detailed=quality===2&&z> -100;
   tile.details.visible=near&&detailed;tile.lowDetails.visible=near&&!detailed;
   if(near)for(const mesh of (detailed?tile.details:tile.lowDetails).children){
    const kind=mesh.userData.category,total=mesh.userData.total;
    mesh.visible=kind!=='small'||quality>0&&z> -90;
    if(kind==='floating')mesh.position.y=Math.sin(elapsed*1.2)*.16;
    mesh.count=kind==='tree'?Math.max(1,Math.ceil(total*[.22,.5,1][quality])):total;
   }
  }
 }
 return {setRegion,update,get ready(){return loading||(current?Promise.resolve():setRegion(requested));},
  get region(){return current?.id||requested;},get loaded(){return !!current;},
  setQuality(profile){quality=profile.reflectionSize>512?2:profile.shadows?1:0;},
  dispose(){disposed=true;if(current)release(current);current=null;}};
}
