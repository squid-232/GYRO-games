"""Convert the user's Island Maps v2 archive into deterministic browser assets.
Requires Python, numpy and Pillow. Never executes source Unity scripts.
Usage: python tools/import_notion_islands.py <IslandMaps_v2_Unity directory>
"""
import argparse, hashlib, json, pathlib
import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'game/dist/assets/notion-islands'
SOURCE_PAGE = 'https://app.notion.com/p/f9b3579d22f940e69843286b6abb1f15'

def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

def clustered_lod(vertices, indices, groups, target):
    """Spatial vertex clustering, per material and normal sector, for distant props.
    UV tile boundaries remain separate; close-up assets keep their source geometry.
    """
    verts=np.asarray(vertices,dtype=np.float32)
    extent=max(float(np.ptp(verts[:,:3],axis=0).max()),.01)
    result=None
    for resolution in (48,32,24,16,12,8):
        packed=[];triangles=[];out_groups=[]
        for group in groups:
            src=np.asarray(indices[group['start']:group['start']+group['count']],dtype=np.int32)
            unique,remap=np.unique(src,return_inverse=True);v=verts[unique]
            keys=np.concatenate((np.round(v[:,:3]/(extent/resolution)),np.round(v[:,3:6]*2),np.floor(v[:,6:8]+1e-5)),axis=1).astype(np.int32)
            _,inverse=np.unique(keys,axis=0,return_inverse=True)
            count=np.bincount(inverse);merged=np.zeros((len(count),8),dtype=np.float32)
            for axis in range(8):merged[:,axis]=np.bincount(inverse,weights=v[:,axis])/count
            merged[:,3:6]/=np.maximum(np.linalg.norm(merged[:,3:6],axis=1,keepdims=True),1e-8)
            faces=inverse[remap].reshape(-1,3)
            faces=faces[(faces[:,0]!=faces[:,1])&(faces[:,1]!=faces[:,2])&(faces[:,0]!=faces[:,2])]
            if not len(faces):continue
            used,compact=np.unique(faces,return_inverse=True)
            # NumPy 2 preserves the input shape of inverse indices. The binary
            # format and material draw ranges count scalar indices, not faces.
            compact=compact.reshape(-1)
            out_groups.append({'material':group['material'],'start':len(triangles),'count':len(compact)})
            triangles.extend((compact+len(packed)).tolist());packed.extend(merged[used].tolist())
        result=(packed,triangles,out_groups)
        if len(triangles)//3<=target:break
    return result

def convert(source):
    OUT.mkdir(parents=True, exist_ok=True)
    textures, materials, models = {}, {}, {}
    def texture(path):
        path = path.resolve()
        if not path.is_file():
            raise FileNotFoundError(path)
        if path in textures:
            return textures[path]
        normal = path.stem.endswith('_N')
        name = 'textures/' + path.stem + ('.png' if normal else '.webp')
        dest = OUT / name
        dest.parent.mkdir(exist_ok=True)
        with Image.open(path) as img:
            img.thumbnail((512, 512), Image.Resampling.LANCZOS)
            img.save(dest, **({'optimize': True} if normal else {'quality': 88}))
        textures[path] = name
        return name
    for mtl in sorted(source.rglob('*.mtl')):
        current = None
        for line in mtl.read_text('utf-8-sig').splitlines():
            fields = line.split()
            if not fields or fields[0].startswith('#'):
                continue
            key, values = fields[0], fields[1:]
            if key == 'newmtl':
                current = materials.setdefault(values[0], {'color': [1,1,1], 'roughness': .8, 'metalness': 0, 'opacity': 1})
            elif current is not None:
                if key in ('Kd', 'Ke'):
                    current['color' if key == 'Kd' else 'emissive'] = list(map(float, values[:3]))
                elif key in ('Pr','Pm','d'):
                    current[{'Pr':'roughness','Pm':'metalness','d':'opacity'}[key]] = float(values[0])
                elif key.lower() in ('map_kd','map_bump','map_ke'):
                    current[{'map_kd':'map','map_bump':'normalMap','map_ke':'emissiveMap'}[key.lower()]] = texture(mtl.parent / values[-1])
    # Unity's builder supplies these maps separately from the fallback MTL.
    for material_name in ('LavaLake','RiverWater','LakeWater'):
        target=materials[material_name]
        if material_name=='LavaLake':
            target.update(color=[1,1,1],emissive=[1,1,1],roughness=.65)
            for slot,suffix in [('map','A'),('normalMap','N'),('emissiveMap','E')]:
                target[slot]=texture(source/'IslandMaps/Textures'/f'T_LavaLake_{suffix}.png')
        else:
            target['normalMap']=texture(source/'IslandMaps/Textures/T_Water_N.png')
    materials['Iceberg']['roughness']=.38
    def obj(path, key):
        if key in models:
            return
        pos, uv, normals, vertices, indices, lookup, groups = [], [], [], [], [], {}, []
        mat = None
        def finish():
            start = sum(g['count'] for g in groups)
            if len(indices) > start:
                groups.append({'material':mat, 'start':start, 'count':len(indices)-start})
        for line in path.read_text('utf-8-sig').splitlines():
            v = line.split()
            if not v: continue
            if v[0] == 'v': pos.append(tuple(map(float,v[1:4])))
            elif v[0] == 'vt': uv.append(tuple(map(float,v[1:3])))
            elif v[0] == 'vn': normals.append(tuple(map(float,v[1:4])))
            elif v[0] == 'usemtl': finish(); mat=v[1]
            elif v[0] == 'f':
                face=[]
                for token in v[1:]:
                    parts=token.split('/'); refs=tuple(int(x) if x else 0 for x in parts)
                    if refs not in lookup:
                        p=pos[refs[0]-1]; t=uv[refs[1]-1] if len(refs)>1 and refs[1] else (0,0)
                        n=normals[refs[2]-1] if len(refs)>2 and refs[2] else (0,1,0)
                        lookup[refs]=len(vertices); vertices.append((-p[0],p[1],p[2],-n[0],n[1],n[2],*t))
                    face.append(lookup[refs])
                # Source OBJ mirrors X for Unity's importer; undo mirror and winding.
                for i in range(1,len(face)-1): indices.extend((face[0],face[i+1],face[i]))
        finish()
        # Merge disconnected OBJ parts sharing a material into one draw group.
        buckets={}
        for group in groups:
            buckets.setdefault(group['material'],[]).extend(indices[group['start']:group['start']+group['count']])
        indices=[];groups=[]
        for material, triangles in buckets.items():
            groups.append({'material':material,'start':len(indices),'count':len(triangles)})
            indices.extend(triangles)
        vertex_data=np.asarray(vertices,dtype='<f4').tobytes()
        index_data=np.asarray(indices,dtype='<u4').tobytes()
        dest=OUT/'models'/f'{key}.bin'; dest.parent.mkdir(exist_ok=True)
        dest.write_bytes(vertex_data+index_data)
        models[key]={'file':f'models/{key}.bin','vertices':len(vertices),'indices':len(indices),'groups':groups}
        if not key[:2].isdigit():
            target=700 if key.startswith(('Palm','Pine','Bush')) else 500 if key.startswith(('Rock','Iceberg')) else 1800
            low_v,low_i,low_g=clustered_lod(vertices,indices,groups,target)
            low_key=key+'_low'
            (OUT/'models'/f'{low_key}.bin').write_bytes(np.asarray(low_v,dtype='<f4').tobytes()+np.asarray(low_i,dtype='<u4').tobytes())
            models[low_key]={'file':f'models/{low_key}.bin','vertices':len(low_v),'indices':len(low_i),'groups':low_g}
            models[key]['lod']=low_key
    names=set()
    catalog=[]
    for p in sorted((source/'IslandMaps/Islands').glob('*/Island.json')):
        data=json.loads(p.read_text('utf-8-sig')); key=data['name']; target=OUT/key; target.mkdir(exist_ok=True)
        heights=np.fromfile(p.parent/data['heightmap'],dtype='<u2').reshape(data['heightRes'],data['heightRes'])[::4,::4].copy()
        heights.tofile(target/'height.r16')
        with Image.open(p.parent/data['colormap']) as img:
            img.save(target/'color.webp',quality=90)
        with Image.open(p.parent/data['minimap']) as img:
            img.thumbnail((192,192),Image.Resampling.LANCZOS); img.save(target/'minimap.webp',quality=85)
        for tree in data['trees']: names.add(data['protos'][tree['p']])
        for prop in data['props']: names.add(prop['prefab'])
        for mesh in data['meshes']:
            model=key+'_'+pathlib.Path(mesh['file']).stem
            obj(p.parent/mesh['file'],model); mesh['model']=model
        layout={k:data[k] for k in ['name','cn','size','sizeY','depth','protos','trees','props','meshes']}
        layout['heightRes']=257
        save_json(target/'layout.json',layout)
        catalog.append({'id':key,'name':data['cn'],'height':data['hmax']})
    for name in sorted(names):
        candidates=list(source.rglob(name+'_LOD1.obj')) or list(source.rglob(name+'.obj'))
        if not candidates: raise FileNotFoundError(name)
        obj(candidates[0],name)
    used={g['material'] for m in models.values() for g in m['groups']}
    materials={k:v for k,v in materials.items() if k in used}
    # Water definitions are supplied by the source archive; keep them in the manifest.
    manifest={'version':1,'source':SOURCE_PAGE,'catalog':catalog,'materials':materials,'models':models,
              'coordinates':'Y up; source mirrored OBJ X restored; height row 0 is south; UV north is +Z',
              'heightEncoding':'uint16 little-endian; height = value/65535*sizeY-depth'}
    archive=source.parent/'IslandMaps_v2_Unity.zip'
    if archive.is_file():manifest['sourceArchiveSha256']=hashlib.sha256(archive.read_bytes()).hexdigest()
    save_json(OUT/'manifest.json',manifest)
    print(f'Converted {len(catalog)} islands, {len(models)} models, {len(materials)} materials; {sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())/1e6:.1f} MB')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('source',type=pathlib.Path)
    convert(parser.parse_args().source.resolve())
