import * as T from './vendor/three.module.js';

// 预分配粒子数据并用一次实例化绘制替代逐粒 Mesh/Material。
// 活跃粒子紧密排列，回收时交换末尾元素，飞行中不创建/销毁材质。
export function createParticleSystem(parent, sourceGeometry, capacity = 384) {
  const geometry = sourceGeometry.clone();
  const opacity = new T.InstancedBufferAttribute(new Float32Array(capacity), 1);
  geometry.setAttribute('particleOpacity', opacity);
  const material = new T.MeshBasicMaterial({color:0xffffff,transparent:true,depthWrite:false,blending:T.AdditiveBlending});
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float particleOpacity;\nvarying float vParticleOpacity;');
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvParticleOpacity = particleOpacity;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vParticleOpacity;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vParticleOpacity;');
  };
  material.customProgramCacheKey = () => 'gyro-instanced-particles-v1';
  const mesh = new T.InstancedMesh(geometry, material, capacity);
  mesh.name='Pooled combat particles';mesh.userData.routeBatch=true; mesh.count=0; mesh.frustumCulled=false;
  mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
  // 初始化颜色属性，让预编译与正式渲染使用完全相同的 shader 变体。
  mesh.setColorAt(0,new T.Color(0xffffff));mesh.instanceColor.setUsage(T.DynamicDrawUsage);
  parent.add(mesh);
  const slots = Array.from({length:capacity},()=>({position:new T.Vector3(),velocity:new T.Vector3(),color:new T.Color(),life:0,size:1,alpha:1}));
  const transform = new T.Object3D(), velocity = new T.Vector3();
  let count=0;
  function emit(position, vel, color, life, size=1, alpha=1) {
    if(count>=capacity)return false;
    const p=slots[count++];p.position.copy(position);p.velocity.copy(vel);p.color.set(color);
    p.life=life;p.size=size;p.alpha=alpha;return true;
  }
  function burst(position,color,amount=16) {
    for(let i=0;i<amount;i++){
      velocity.set((Math.random()-.5)*12,(Math.random()-.5)*10,(Math.random()-.5)*12);
      emit(position,velocity,color,.5+Math.random()*.4);
    }
  }
  function update(dt) {
    for(let i=count-1;i>=0;i--){
      const p=slots[i];p.life-=dt;
      if(p.life<=0){count--;slots[i]=slots[count];slots[count]=p;}
      else p.position.addScaledVector(p.velocity,dt);
    }
  }
  function flush(project) {
    mesh.count=count;
    for(let i=0;i<count;i++){
      const p=slots[i];transform.position.copy(p.position);transform.quaternion.identity();transform.scale.setScalar(p.size);if(project)project(transform);transform.updateMatrix();
      mesh.setMatrixAt(i,transform.matrix);mesh.setColorAt(i,p.color);opacity.setX(i,Math.min(1,p.life)*p.alpha);
    }
    if(count){mesh.instanceMatrix.needsUpdate=true;mesh.instanceColor.needsUpdate=true;opacity.needsUpdate=true;}
  }
  function clear(){count=0;mesh.count=0;}
  function dispose(){clear();parent.remove(mesh);mesh.dispose();geometry.dispose();material.dispose();}
  return {mesh,capacity,get count(){return count;},emit,burst,update,flush,clear,dispose};
}
