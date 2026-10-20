import * as T from './vendor/three.module.js';
import {createNotionIslands,createImportedSeaStack} from './notion-islands.js';

// The coastline and obstacles share the same sea level, sun and reflection pass.
// Notion terrain tiles recycle without allocating geometry during flight.
export const SEA_LEVEL = -3;
const TAU = Math.PI * 2;
const time = { value: 0 };
// Shared direction keeps sky, water highlights and scene lighting coherent.
export const COAST_SUN = new T.Vector3(-32,38,-45).normalize();
const waterNoise = `
  float hash21(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
  float noise21(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
    return mix(mix(hash21(i),hash21(i+vec2(1.,0.)),f.x),mix(hash21(i+vec2(0.,1.)),hash21(i+vec2(1.,1.)),f.x),f.y);}
  float fbm(vec2 p){return noise21(p)*.57+noise21(p*2.07+13.1)*.28+noise21(p*4.13-7.4)*.15;}
`;

const stone = new T.MeshStandardMaterial({ vertexColors: true, roughness: .91, metalness: .04 });
stone.onBeforeCompile = shader => {
  shader.uniforms.uCoastTime=time;
  shader.vertexShader = 'varying vec3 vTerrain; varying vec3 vCoastWorld;\n' + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrain = position;');
  // worldPosition is conditional in Three.js; compute explicitly for every variant.
  shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvCoastWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  shader.fragmentShader = 'uniform float uCoastTime; varying vec3 vTerrain; varying vec3 vCoastWorld;\n' + waterNoise + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
    float grain = fbm(vTerrain.xz*5. + vTerrain.y*.7);
    float strata = sin(vTerrain.y*6.0 + sin(vTerrain.x*.6) + sin(vTerrain.z*.8));
    float wetLevel = -2.72 + noise21(vCoastWorld.xz*.45)*.15 + sin(uCoastTime*.7)*.035;
    float wetness = 1.-smoothstep(wetLevel-.12,wetLevel+.55,vCoastWorld.y);
    diffuseColor.rgb *= (.82 + .22*grain + .035*strata) * mix(1.,.58,wetness);`);
  shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
    roughnessFactor=mix(roughnessFactor,.31,wetness);`);
};
stone.customProgramCacheKey = () => 'island-wet-coast-v2';
const metal = new T.MeshStandardMaterial({ color: 0x64747c, roughness: .4, metalness: .65 });
const beacon = new T.MeshBasicMaterial({ color: 0xffbb70 });
const cube = new T.BoxGeometry(1, 1, 1);
function box(group, material, x, y, z, sx, sy, sz) {
  const mesh = new T.Mesh(cube, material); mesh.position.set(x,y,z); mesh.scale.set(sx,sy,sz); group.add(mesh); return mesh;
}
function sky() {
  return new T.Mesh(new T.SphereGeometry(480,32,20),new T.ShaderMaterial({side:T.BackSide,depthWrite:false,
    vertexShader:`varying vec3 vDir;void main(){vDir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`varying vec3 vDir;void main(){vec3 d=normalize(vDir);float h=max(0.,d.y);
      vec3 color=mix(vec3(.25,.39,.44),vec3(.055,.17,.29),pow(h,.48));
      float sun=max(0.,dot(d,normalize(vec3(-32.,38.,-45.))));
      color+=vec3(.65,.49,.28)*pow(sun,20.)*.23+vec3(1.,.82,.53)*pow(sun,650.);
      float streak=sin(d.x*17.+d.z*8.+sin(d.x*25.)*.15);
      float cloud=smoothstep(.6,.98,streak)*exp(-pow((d.y-.22)*11.,2.));
      color=mix(color,vec3(.57,.66,.67),cloud*.15);gl_FragColor=vec4(color,1.);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`}));
}
function ocean() {
  const geometry=new T.PlaneGeometry(1400,1400,1,1);geometry.rotateX(-Math.PI/2);
  const material=new T.ShaderMaterial({uniforms:{uTime:time,uDistance:{value:0},uReflection:{value:null},uReflectionMatrix:{value:new T.Matrix4()},uReflectionReady:{value:0},uWaterDetail:{value:1},uTexel:{value:new T.Vector2(1/768,1/432)},uSun:{value:COAST_SUN}},
    vertexShader:`varying vec3 vWorld;varying vec4 vMirror;uniform mat4 uReflectionMatrix;
      void main(){vec4 p=modelMatrix*vec4(position,1.);vWorld=p.xyz;vMirror=uReflectionMatrix*p;gl_Position=projectionMatrix*viewMatrix*p;}`,
    fragmentShader:`uniform float uTime;uniform float uDistance;uniform sampler2D uReflection;uniform float uReflectionReady;uniform float uWaterDetail;
      uniform vec2 uTexel;uniform vec3 uSun;varying vec3 vWorld;varying vec4 vMirror;
      ${waterNoise}
      float waves(vec2 p,float t){
        float swell=sin(dot(p,vec2(.21,.34))+t*.65)*.25+sin(dot(p,vec2(-.37,.18))-t*.48)*.14;
        float wave=swell+noise21(p*vec2(.67,1.5)+vec2(t*.16,-t*.23))*.42;
        if(uWaterDetail>.5)wave+=noise21(p*vec2(1.9,3.7)-t*.25)*.19;
        return wave;
      }
      void main(){vec2 p=vWorld.xz+vec2(0.,-uDistance);float t=uTime;
        float wave=waves(p,t),a=waves(p+vec2(.12,0.),t)-wave,b=waves(p+vec2(0.,.12),t)-wave;
        float dist=length(cameraPosition-vWorld);
        float detail=1.-smoothstep(55.,220.,dist);
        vec3 n=normalize(vec3(-a*(.65+.45*detail),1.,-b*(.65+.45*detail)));
        vec3 view=normalize(cameraPosition-vWorld),light=uSun;
        float nv=max(.001,dot(n,view)),nl=max(.001,dot(n,light));
        float fresnel=.0204+.9796*pow(1.-nv,5.);
        vec3 halfVector=normalize(light+view);float nh=max(0.,dot(n,halfVector));
        // GGX microfacet sun reflection, with distance filtering to prevent sparkle aliasing.
        float roughness=.13+.09*(1.-detail);float alpha=roughness*roughness;
        float alpha2=alpha*alpha;float denom=nh*nh*(alpha2-1.)+1.;
        float D=alpha2/(3.14159265*denom*denom+.00001);
        float k=pow(roughness+1.,2.)/8.;float Gv=nv/(nv*(1.-k)+k),Gl=nl/(nl*(1.-k)+k);
        float F=.0204+.9796*pow(1.-max(0.,dot(halfVector,view)),5.);
        float spec=D*Gv*Gl*F/max(.004,4.*nv*nl);
        vec3 reflectedDirection=reflect(-view,n);
        vec3 reflected=mix(vec3(.25,.39,.44),vec3(.065,.18,.3),pow(max(0.,reflectedDirection.y),.48));
        if(uReflectionReady>.5){
        vec2 uv=vMirror.xy/max(.001,vMirror.w);
        vec2 distortion=n.xz*.10*clamp(22./max(dist,1.),.22,1.);
        vec2 q=clamp(uv+distortion,uTexel*2.,1.-uTexel*2.);
        float edge=smoothstep(0.,.025,uv.x)*smoothstep(0.,.025,uv.y)*(1.-smoothstep(.975,1.,uv.x))*(1.-smoothstep(.975,1.,uv.y));
        vec2 blur=uTexel*(.7+(1.-detail)*1.3);
        vec3 mirror=texture2D(uReflection,q).rgb*.4;
        mirror+=(texture2D(uReflection,q+vec2(blur.x,0.)).rgb+texture2D(uReflection,q-vec2(blur.x,0.)).rgb+texture2D(uReflection,q+vec2(0.,blur.y)).rgb+texture2D(uReflection,q-vec2(0.,blur.y)).rgb)*.15;
        reflected=mix(reflected,mirror,edge);
        }
        vec3 deep=vec3(.009,.057,.082)+vec3(.007,.024,.026)*wave;
        vec3 color=mix(deep,reflected,clamp(fresnel*1.15+.12,0.,.92));
        color+=vec3(1.,.85,.64)*min(spec,12.)*nl*2.4;
        float fog=1.-exp(-.000025*dist*dist);color=mix(color,vec3(.25,.39,.44),fog);
        gl_FragColor=vec4(color,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`});
  const mesh=new T.Mesh(geometry,material);mesh.position.y=SEA_LEVEL;mesh.name='Reflective ocean';return mesh;
}

// A planar scene reflection, not hardware ray tracing. One capped half-size pass;
// the main camera's projection is preserved and objects below the sea are clipped.
function createWaterReflection(sea,shores) {
  let target,lastReflection=-Infinity,reflectionHz=30,reflectionSize=960;const reflectedCamera=new T.PerspectiveCamera(),size=new T.Vector2(),direction=new T.Vector3(),look=new T.Vector3(),up=new T.Vector3();
  const clip=[new T.Plane(new T.Vector3(0,1,0),-SEA_LEVEL-.02)];
  const bias=new T.Matrix4().set(.5,0,0,.5,0,.5,0,.5,0,0,.5,.5,0,0,0,1);
  const uniforms=sea.material.uniforms;
  function render(renderer,scene,camera,now=performance.now(),prepare=false) {
    if(!reflectionHz||camera.position.y<=SEA_LEVEL+.05)return;
    if(!prepare&&target&&now-lastReflection<1000/reflectionHz)return;
    lastReflection=now;
    renderer.getDrawingBufferSize(size);
    const scale=Math.min(.5,reflectionSize/Math.max(size.x,size.y));
    const width=Math.max(1,Math.round(size.x*scale)),height=Math.max(1,Math.round(size.y*scale));
    if(!target){
      // Linear HDR stays un-tonemapped until the final water pass. Use RGBA8 if float rendering is unavailable.
      const hdr=renderer.extensions.has('EXT_color_buffer_float');
      target=new T.WebGLRenderTarget(width,height,{type:hdr?T.HalfFloatType:T.UnsignedByteType,depthBuffer:true,generateMipmaps:false});
      target.texture.name='Coastal planar reflection';uniforms.uReflection.value=target.texture;
    }
    if(target.width!==width||target.height!==height)target.setSize(width,height);
    uniforms.uTexel.value.set(1/width,1/height);
    camera.updateMatrixWorld();camera.getWorldPosition(reflectedCamera.position);
    reflectedCamera.position.y=2*SEA_LEVEL-reflectedCamera.position.y;
    camera.getWorldDirection(direction);direction.y=-direction.y;
    up.set(0,1,0).transformDirection(camera.matrixWorld);up.y=-up.y;
    reflectedCamera.up.copy(up);look.copy(reflectedCamera.position).add(direction);reflectedCamera.lookAt(look);
    reflectedCamera.near=camera.near;reflectedCamera.far=camera.far;
    reflectedCamera.projectionMatrix.copy(camera.projectionMatrix);reflectedCamera.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    reflectedCamera.updateMatrixWorld();
    uniforms.uReflectionMatrix.value.copy(bias).multiply(reflectedCamera.projectionMatrix).multiply(reflectedCamera.matrixWorldInverse);
    const oldTarget=renderer.getRenderTarget(),oldClip=renderer.clippingPlanes,oldTone=renderer.toneMapping,oldXR=renderer.xr.enabled,oldAutoClear=renderer.autoClear;
    const oldShadowUpdate=renderer.shadowMap.needsUpdate,oldShadowAuto=renderer.shadowMap.autoUpdate;
    renderer.shadowMap.needsUpdate=false;renderer.shadowMap.autoUpdate=false;
    sea.visible=false;for(const shore of shores)shore.visible=false;
    try{
      renderer.xr.enabled=false;renderer.clippingPlanes=clip;renderer.toneMapping=T.NoToneMapping;renderer.autoClear=true;
      renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,reflectedCamera);uniforms.uReflectionReady.value=1;
      if(prepare)return renderer.compileAsync(scene,reflectedCamera);
    } finally {
      sea.visible=true;for(const shore of shores)shore.visible=true;
      renderer.shadowMap.needsUpdate=oldShadowUpdate;renderer.shadowMap.autoUpdate=oldShadowAuto;
      renderer.setRenderTarget(oldTarget);renderer.clippingPlanes=oldClip;renderer.toneMapping=oldTone;renderer.xr.enabled=oldXR;renderer.autoClear=oldAutoClear;
    }
  }
  return {render,setQuality(profile){
    reflectionHz=profile.reflectionHz;reflectionSize=profile.reflectionSize;
    uniforms.uWaterDetail.value=profile.waterDetail;uniforms.uReflectionReady.value=0;lastReflection=-Infinity;
  },dispose(){target?.dispose();}};
}
// Shared obstacle geometry: the top is y=1; the base is y=0.
const stackGeometry=(()=>{
  const g=new T.CylinderGeometry(.63,1,1,12,9),p=g.attributes.position,colors=[],c=new T.Color();
  for(let i=0;i<p.count;i++) {
    const x=p.getX(i),z=p.getZ(i),y=p.getY(i)+.5;
    const wobble=1+.075*Math.sin(y*24+Math.atan2(z,x)*5);
    p.setXYZ(i,x*wobble,y,z*wobble);
    c.setHex(y>.84?0x596855:0x717775);c.multiplyScalar(.9+.1*Math.sin(y*30+x*3));colors.push(c.r,c.g,c.b);
  }
  g.setAttribute('color',new T.Float32BufferAttribute(colors,3));g.computeVertexNormals();return g;
})();
const stackFoam=new T.MeshBasicMaterial({color:0x8fbfb6,transparent:true,opacity:.25,depthWrite:false});
const foamGeometry=new T.TorusGeometry(1,.075,4,32);foamGeometry.rotateX(Math.PI/2);
export function createSeaStack(x,y,z,r=1.8) {
  const group=new T.Group();group.position.set(x,y,z);
  const top=y+r, height=top-SEA_LEVEL;
  const body=createImportedSeaStack()||new T.Mesh(stackGeometry,stone);body.position.y=SEA_LEVEL-y;body.scale.set(r,height,r);group.add(body);
  const foam=new T.Mesh(foamGeometry,stackFoam);foam.position.y=SEA_LEVEL-y+.07;foam.scale.set(r*1.1,1,r*1.1);group.add(foam);
  // A small warm navigation light makes the silhouette legible at range.
  box(group,metal,0,r+.22,0,.12,.45,.12);box(group,beacon,0,r+.5,0,.22,.15,.22);
  return {mesh:group,bottom:SEA_LEVEL,top:top+.6,r:r*1.075};
}
export function createIslandMap(scene) {
  const root=new T.Group();root.name='Notion island theaters';scene.add(root);
  const sea=ocean();root.add(sea);root.add(sky());
  const shores=[],imported=createNotionIslands(root,shores,SEA_LEVEL);
  const reflection=createWaterReflection(sea,shores);
  function update(distance,elapsed){
    time.value=elapsed;sea.material.uniforms.uDistance.value=distance;imported.update(distance,elapsed);
  }
  return {root,update,reset:()=>{imported.reset();update(0,0);},get ready(){return imported.ready;},
    flyover:imported.flyover,get region(){return imported.region;},get loaded(){return imported.loaded;},prepareGPU:imported.prepareGPU,
    renderReflection:reflection.render,setQuality(profile){reflection.setQuality(profile);imported.setQuality(profile);},
    dispose(){reflection.dispose();imported.dispose();}};
}
