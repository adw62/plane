// Procity city generator — Web Worker entry point
// Port of the Python procity package. Runs via: new Worker('./generator.js', {type:'module'})

import { Delaunay } from 'https://cdn.jsdelivr.net/npm/d3-delaunay@6/+esm';

// ── Seeded RNG (mulberry32) ───────────────────────────────────────────────────
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function rngRange(rng, lo, hi) { return lo + rng() * (hi - lo); }
function rngInt(rng, lo, hi)   { return lo + Math.floor(rng() * (hi - lo + 1 - 1e-9)); }

function rngWeighted(rng, arr, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < arr.length; i++) { r -= weights[i]; if (r <= 0) return arr[i]; }
  return arr[arr.length - 1];
}

// ── Sampler ───────────────────────────────────────────────────────────────────
const GUMBEL_LO = -1.0, GUMBEL_HI = 4.5;

function gumbel01(rng) {
  const u = Math.max(1e-9, Math.min(1 - 1e-9, rng()));
  const g = -Math.log(-Math.log(u));
  return Math.max(0, Math.min(1, (g - GUMBEL_LO) / (GUMBEL_HI - GUMBEL_LO)));
}

function normal01(rng) {
  const u1 = Math.max(1e-9, rng()), u2 = rng();
  const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0, Math.min(1, g * 0.18 + 0.5));
}

class Sampler {
  constructor(rng, dist = 'uniform') { this.rng = rng; this.dist = dist; }
  _01() {
    if (this.dist === 'gumbel') return gumbel01(this.rng);
    if (this.dist === 'normal') return normal01(this.rng);
    return this.rng();
  }
  uniform(lo, hi) { return lo + this._01() * (hi - lo); }
  randint(lo, hi) { return lo + Math.floor(this._01() * (hi - lo + 1 - 1e-9)); }
  random()        { return this.rng(); }
  choice(arr)     { return arr[Math.floor(this.rng() * arr.length)]; }
  choices(arr, weights) { return rngWeighted(this.rng, arr, weights); }
}

// ── Mesh helpers ──────────────────────────────────────────────────────────────
// Mesh = { verts: [x,y,z][], faces: [a,b,c][] }

function emptyMesh() { return { verts: [], faces: [] }; }

function transformMesh(mesh, pos = [0,0,0], rotY = 0) {
  const [px, py, pz] = pos;
  const c = rotY ? Math.cos(rotY) : 1, s = rotY ? Math.sin(rotY) : 0;
  const verts = mesh.verts.map(([x, y, z]) => [x*c - z*s + px, y + py, x*s + z*c + pz]);
  const faces = mesh.faces.map(f => [f[0], f[1], f[2]]);
  const out = { verts, faces };
  if (mesh.uvs) out.uvs = mesh.uvs;
  if (mesh.subUVs) out.subUVs = mesh.subUVs;
  return out;
}

function mergeMeshes(meshes) {
  const verts = [], faces = [], uvs = [], subUVs = [];
  let off = 0, hasUVs = false, hasSubUVs = false;
  for (const m of meshes) {
    if (!m || !m.verts.length) continue;
    for (const v of m.verts) verts.push(v);
    for (const f of m.faces) faces.push([f[0]+off, f[1]+off, f[2]+off]);
    if (m.uvs && m.uvs.length) { for (const uv of m.uvs) uvs.push(uv); hasUVs = true; }
    else if (hasUVs) { for (let i = 0; i < m.verts.length; i++) uvs.push([0, 0]); }
    if (m.subUVs && m.subUVs.length) { for (const uv of m.subUVs) subUVs.push(uv); hasSubUVs = true; }
    else if (hasSubUVs) { for (let i = 0; i < m.verts.length; i++) subUVs.push([0, 0]); }
    off += m.verts.length;
  }
  const out = { verts, faces };
  if (hasUVs) out.uvs = uvs;
  if (hasSubUVs) out.subUVs = subUVs;
  return out;
}

function place(mesh, cx, y, cz) { return transformMesh(mesh, [cx, y, cz]); }

// ── Geometry primitives ───────────────────────────────────────────────────────
function box(w, h, d) {
  const x = w/2, z = d/2;
  return {
    verts: [[-x,0,-z],[x,0,-z],[x,0,z],[-x,0,z],[-x,h,-z],[x,h,-z],[x,h,z],[-x,h,z]],
    faces: [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]],
  };
}

function prism(n, r, h) {
  const bot = Array.from({length:n}, (_,i) => [Math.cos(2*Math.PI*i/n)*r, 0, Math.sin(2*Math.PI*i/n)*r]);
  const top = bot.map(([x,,z]) => [x, h, z]);
  const verts = [...bot, ...top];
  const faces = [];
  for (let i = 1; i < n-1; i++) faces.push([0, i+1, i]);
  for (let i = 1; i < n-1; i++) faces.push([n, n+i, n+i+1]);
  for (let i = 0; i < n; i++) { const j=(i+1)%n; faces.push([i,j,n+j],[i,n+j,n+i]); }
  return { verts, faces };
}

function cylinder(r, h, segs=16) { return prism(segs, r, h); }

function windowedPrism(n, r, h, nFloors, winDepth=-0.05) {
  const bot = Array.from({length:n}, (_,i) => [Math.cos(2*Math.PI*i/n)*r, 0, Math.sin(2*Math.PI*i/n)*r]);
  const top = bot.map(([x,,z]) => [x, h, z]);
  const wVerts=[...bot,...top], wFaces=[];
  for (let i=1;i<n-1;i++) wFaces.push([0,i+1,i]);
  for (let i=1;i<n-1;i++) wFaces.push([n,n+i,n+i+1]);
  for (let i=0;i<n;i++) { const j=(i+1)%n; wFaces.push([i,j,n+j],[i,n+j,n+i]); }

  const gVerts=[], gFaces=[], gUVs=[], gSubUVs=[];
  const floorH = h/nFloors;
  for (let i=0;i<n;i++) {
    const j=(i+1)%n;
    const [blx,,blz]=bot[i], [brx,,brz]=bot[j];
    const faceW=Math.hypot(brx-blx,brz-blz);
    if (faceW<3) continue;
    const ux=(brx-blx)/faceW, uz=(brz-blz)/faceW;
    const mx=(blx+brx)*0.5, mz=(blz+brz)*0.5, mLen=Math.hypot(mx,mz);
    const onx=mx/mLen, onz=mz/mLen;
    const nBays=Math.max(1,Math.round(faceW/4));
    const bayW=faceW/nBays, mu=bayW*0.20, wu=bayW*0.60;
    const mvB=floorH*0.15, wv=floorH*0.70;
    for (let b=0;b<nBays;b++) {
      const u0=b*bayW+mu, u1=u0+wu;
      for (let f=0;f<nFloors;f++) {
        const v0=f*floorH+mvB, v1=v0+wv;
        const base=gVerts.length;
        for (const [[u,v],[du,dv]] of [[[u0,v0],[0,0]],[[u1,v0],[1,0]],[[u1,v1],[1,1]],[[u0,v1],[0,1]]]) {
          gVerts.push([blx+u*ux-onx*winDepth, v, blz+u*uz-onz*winDepth]);
          gUVs.push([b+i/n, f]);
          gSubUVs.push([du,dv]);
        }
        gFaces.push([base,base+1,base+2],[base,base+2,base+3]);
      }
    }
  }
  return {wall:{verts:wVerts,faces:wFaces}, window:{verts:gVerts,faces:gFaces,uvs:gUVs,subUVs:gSubUVs}};
}

function pyramid(w, h, d) {
  const x=w/2, z=d/2;
  return {
    verts: [[-x,0,-z],[x,0,-z],[x,0,z],[-x,0,z],[0,h,0]],
    faces: [[0,2,1],[0,3,2],[0,1,4],[1,2,4],[2,3,4],[3,0,4]],
  };
}

function polyPrism(vertsXZ, h) {
  const n = vertsXZ.length;
  const bot = vertsXZ.map(([x,z]) => [x, 0, z]);
  const top = vertsXZ.map(([x,z]) => [x, h, z]);
  const verts = [...bot, ...top];
  const faces = [];
  for (let i = 1; i < n-1; i++) faces.push([0, i+1, i]);
  for (let i = 1; i < n-1; i++) faces.push([n, n+i, n+i+1]);
  for (let i = 0; i < n; i++) { const j=(i+1)%n; faces.push([i,j,n+j],[i,n+j,n+i]); }
  return { verts, faces };
}

function windowedBox(w, h, d, nFloors, winDepth=0.5) {
  const hw=w/2, hd=d/2, wd=winDepth;
  const panels = [
    [w, (u,v)=>[ u-hw, v, -hd],    (u,v)=>[ u-hw, v, -hd+wd]],
    [w, (u,v)=>[ hw-u, v,  hd],    (u,v)=>[ hw-u, v,  hd-wd]],
    [d, (u,v)=>[ hw,   v,  u-hd],  (u,v)=>[ hw-wd,v,  u-hd ]],
    [d, (u,v)=>[-hw,   v,  hd-u],  (u,v)=>[-hw+wd,v,  hd-u ]],
  ];
  const wVerts=[], wFaces=[];   // wall (frame + surround)
  const gVerts=[], gFaces=[], gUVs=[], gSubUVs=[];   // glass panes + pane IDs + sub-pane coords
  for (let pi=0; pi<panels.length; pi++) {
    const [panelW, ofn, ifn] = panels[pi];
    const nBays = Math.max(1, Math.round(panelW/4));
    const bayW  = panelW/nBays, floorH=h/nFloors;
    const mu=bayW*0.20, mvB=floorH*0.15, wu=bayW-2*mu, wv=floorH*0.70;
    const uGrid=[], vGrid=[];
    for (let b=0;b<nBays;b++) { const o=b*bayW; uGrid.push(o,o+mu,o+mu+wu); } uGrid.push(panelW);
    for (let f=0;f<nFloors;f++) { const o=f*floorH; vGrid.push(o,o+mvB,o+mvB+wv); } vGrid.push(h);
    const nu=uGrid.length, nv=vGrid.length, wbase=wVerts.length;
    for (let iv=0;iv<nv;iv++) for (let iu=0;iu<nu;iu++) wVerts.push(ofn(uGrid[iu],vGrid[iv]));
    const oi=(iu,iv)=>wbase+iv*nu+iu;
    const innerMap=new Map();
    for (let iu=0;iu<nu-1;iu++) for (let iv=0;iv<nv-1;iv++) {
      if (iu%3===1 && iv%3===1) {
        const b=Math.floor(iu/3), f=Math.floor(iv/3);
        for (const [du,dv] of [[0,0],[1,0],[0,1],[1,1]]) {
          const key=`${iu+du},${iv+dv}`;
          if (!innerMap.has(key)) {
            const v=ifn(uGrid[iu+du],vGrid[iv+dv]);
            innerMap.set(key,{wi:wVerts.length,gi:gVerts.length});
            wVerts.push(v); gVerts.push(v);
            gUVs.push([b + pi*0.25, f]);
            gSubUVs.push([du, dv]);
          }
        }
      }
    }
    for (let iu=0;iu<nu-1;iu++) for (let iv=0;iv<nv-1;iv++) {
      const a=oi(iu,iv),b=oi(iu+1,iv),c=oi(iu,iv+1),dd=oi(iu+1,iv+1);
      if (iu%3===1 && iv%3===1) {
        const {wi:ai,gi:gai}=innerMap.get(`${iu},${iv}`);
        const {wi:bi,gi:gbi}=innerMap.get(`${iu+1},${iv}`);
        const {wi:ci,gi:gci}=innerMap.get(`${iu},${iv+1}`);
        const {wi:di,gi:gdi}=innerMap.get(`${iu+1},${iv+1}`);
        wFaces.push([a,b,bi],[a,bi,ai],[c,ci,di],[c,di,dd],[a,ci,c],[a,ai,ci],[b,dd,di],[b,di,bi]);
        gFaces.push([gai,gbi,gdi],[gai,gdi,gci]);
      } else {
        wFaces.push([a,b,dd],[a,dd,c]);
      }
    }
  }
  const bv=wVerts.length;
  wVerts.push([-hw,0,-hd],[hw,0,-hd],[hw,0,hd],[-hw,0,hd],[-hw,h,-hd],[hw,h,-hd],[hw,h,hd],[-hw,h,hd]);
  wFaces.push([bv,bv+2,bv+1],[bv,bv+3,bv+2],[bv+4,bv+5,bv+6],[bv+4,bv+6,bv+7]);
  return { wall:{verts:wVerts,faces:wFaces}, window:{verts:gVerts,faces:gFaces,uvs:gUVs,subUVs:gSubUVs} };
}

function roadStrip(x1,z1,x2,z2,width,height=0.5) {
  const len=Math.hypot(x2-x1,z2-z1), angle=Math.atan2(z2-z1,x2-x1);
  const nx=Math.max(1,Math.ceil(len/10)), segLen=len/nx;
  const parts=[];
  for (let i=0;i<nx;i++) parts.push(transformMesh(box(segLen,height,width),[-len/2+(i+0.5)*segLen,0,0]));
  return transformMesh(mergeMeshes(parts),[(x1+x2)/2,0,(z1+z2)/2],angle);
}

function basePlate(w,d,thickness) { return transformMesh(box(w,thickness,d),[0,-thickness,0]); }

// ── Polygon helpers ───────────────────────────────────────────────────────────
function polyArea(v) {
  let a=0;
  for (let i=0;i<v.length;i++) { const [x1,z1]=v[i],[x2,z2]=v[(i+1)%v.length]; a+=x1*z2-x2*z1; }
  return Math.abs(a)*0.5;
}

function polyCentroid(v) {
  return [v.reduce((s,p)=>s+p[0],0)/v.length, v.reduce((s,p)=>s+p[1],0)/v.length];
}

function shrinkPoly(verts,amount) {
  const [cx,cz]=polyCentroid(verts);
  return verts.map(([x,z])=>{
    const dx=x-cx,dz=z-cz,dist=Math.hypot(dx,dz);
    if (dist<=amount) return [cx,cz];
    const f=(dist-amount)/dist; return [cx+dx*f,cz+dz*f];
  });
}

function clipPolygon(subject,clipPoly) {
  const inside=(p,a,b)=>(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0])>=0;
  const intersect=(p1,p2,a,b)=>{
    const dx1=p2[0]-p1[0],dz1=p2[1]-p1[1],dx2=b[0]-a[0],dz2=b[1]-a[1];
    const denom=dx1*dz2-dz1*dx2;
    if (Math.abs(denom)<1e-10) return p1;
    const t=((a[0]-p1[0])*dz2-(a[1]-p1[1])*dx2)/denom;
    return [p1[0]+t*dx1,p1[1]+t*dz1];
  };
  let out=[...subject];
  for (let i=0;i<clipPoly.length;i++) {
    if (!out.length) break;
    const a=clipPoly[i],b=clipPoly[(i+1)%clipPoly.length];
    const inp=out; out=[];
    for (let j=0;j<inp.length;j++) {
      const cur=inp[j],prev=inp[(j-1+inp.length)%inp.length];
      if (inside(cur,a,b)) { if (!inside(prev,a,b)) out.push(intersect(prev,cur,a,b)); out.push(cur); }
      else if (inside(prev,a,b)) out.push(intersect(prev,cur,a,b));
    }
  }
  return out;
}

function containmentRatio(bv,blv) {
  const cl=clipPolygon(bv,blv);
  return cl.length ? polyArea(cl)/Math.max(polyArea(bv),1e-6) : 0;
}

function rectFP(cx,cz,w,d) {
  const hw=w/2,hd=d/2;
  return [[cx-hw,cz-hd],[cx+hw,cz-hd],[cx+hw,cz+hd],[cx-hw,cz+hd]];
}

// ── Layout ────────────────────────────────────────────────────────────────────
function clipSegBBox(ax,az,bx,bz,x0,z0,x1,z1) {
  const dx=bx-ax,dz=bz-az; let tmin=0,tmax=1;
  for (const [p,q] of [[-dx,ax-x0],[dx,x1-ax],[-dz,az-z0],[dz,z1-az]]) {
    if (Math.abs(p)<1e-10) { if (q<0) return null; }
    else { const r=q/p; p<0?(tmin=Math.max(tmin,r)):(tmax=Math.min(tmax,r)); }
  }
  if (tmin>=tmax) return null;
  return [ax+tmin*dx,az+tmin*dz,ax+tmax*dx,az+tmax*dz];
}

function blvdPoly(x1,z1,x2,z2,width) {
  const dx=x2-x1,dz=z2-z1,dist=Math.hypot(dx,dz),px=-dz/dist,pz=dx/dist,hw=width/2;
  return [[x1-px*hw,z1-pz*hw],[x2-px*hw,z2-pz*hw],[x2+px*hw,z2+pz*hw],[x1+px*hw,z1+pz*hw]];
}

function voronoiBoulevards(cfg, rng) {
  const {city_width:w,city_depth:d,voronoi_sites:n}=cfg;
  const x0=-w/2,z0=-d/2,x1=w/2,z1=d/2;
  const cols=Math.max(1,Math.round(n**0.5)), rows=Math.max(1,Math.ceil(n/cols));
  const seeds=[];
  for (let r=0;r<rows&&seeds.length<n;r++)
    for (let c=0;c<cols&&seeds.length<n;c++) {
      const cx=x0+(c+0.5)*w/cols+rngRange(rng,-w/cols*0.35,w/cols*0.35);
      const cz=z0+(r+0.5)*d/rows+rngRange(rng,-d/rows*0.35,d/rows*0.35);
      seeds.push([Math.max(x0,Math.min(x1,cx)),Math.max(z0,Math.min(z1,cz))]);
    }
  const mirrored=[...seeds];
  for (const [sx,sz] of seeds)
    mirrored.push([2*x0-sx,sz],[2*x1-sx,sz],[sx,2*z0-sz],[sx,2*z1-sz]);

  const delaunay=Delaunay.from(mirrored);
  const voronoi=delaunay.voronoi([x0-1,z0-1,x1+1,z1+1]);
  const seen=new Set(), segs=[];
  for (let i=0;i<n;i++) {
    const cell=voronoi.cellPolygon(i);
    if (!cell) continue;
    for (let k=0;k<cell.length-1;k++) {
      const [ax,az]=cell[k],[bx,bz]=cell[k+1];
      const norm=ax<bx||(ax===bx&&az<bz)
        ?`${ax.toFixed(2)},${az.toFixed(2)},${bx.toFixed(2)},${bz.toFixed(2)}`
        :`${bx.toFixed(2)},${bz.toFixed(2)},${ax.toFixed(2)},${az.toFixed(2)}`;
      if (seen.has(norm)) continue; seen.add(norm);
      const cl=clipSegBBox(ax,az,bx,bz,x0,z0,x1,z1);
      if (cl) segs.push(cl);
    }
  }
  return segs;
}

function sliceDim(total,lo,hi,smp) {
  const sizes=[]; let rem=total;
  while (rem>lo) { const s=Math.min(rem,smp.uniform(lo,hi)); sizes.push(s); rem-=s; }
  if (!sizes.length) sizes.push(total);
  const f=total/sizes.reduce((a,b)=>a+b,0);
  return sizes.map(s=>s*f);
}

function subdivideBlock(cx,cz,bw,bd,cfg,smp,centrality,heightCap) {
  const cols=sliceDim(bw,cfg.min_lot_size,cfg.max_lot_size,smp);
  const rows=sliceDim(bd,cfg.min_lot_size,cfg.max_lot_size,smp);
  const lots=[]; let px=cx-bw/2;
  for (const cw of cols) {
    let pz=cz-bd/2;
    for (const rd of rows) {
      lots.push({cx:px+cw/2,cz:pz+rd/2,width:cw,depth:rd,centrality,heightCap,verts:null,blockVerts:null});
      pz+=rd;
    }
    px+=cw;
  }
  return lots;
}

function generateLots(cfg,rng,smp,centers) {
  const pitchX=cfg.block_width+cfg.street_width, pitchZ=cfg.block_depth+cfg.street_width;
  const nBx=Math.max(1,Math.floor(cfg.city_width/pitchX)), nBz=Math.max(1,Math.floor(cfg.city_depth/pitchZ));
  const totalW=nBx*pitchX-cfg.street_width, totalD=nBz*pitchZ-cfg.street_width;
  const ox=-totalW/2, oz=-totalD/2;
  const halfDiag=Math.hypot(totalW,totalD)/2, cityRadius=Math.hypot(totalW,totalD)*0.4;
  const maxCap=Math.floor(cfg.max_floors*cfg.downtown_boost*0.7);
  const lots=[];
  for (let bx=0;bx<nBx;bx++) for (let bz=0;bz<nBz;bz++) {
    const bcx=ox+bx*pitchX+cfg.block_width/2, bcz=oz+bz*pitchZ+cfg.block_depth/2;
    const centrality=1-Math.min(1,Math.hypot(bcx,bcz)/(halfDiag*0.6));
    const dist=centers.length?Math.min(...centers.map(([cx,cz])=>Math.hypot(bcx-cx,bcz-cz))):cityRadius;
    const proximity=Math.max(0,1-dist/cityRadius);
    const exp=0.5+3.5*(1-proximity);
    const cap=Math.max(cfg.min_floors,Math.floor(maxCap*Math.pow(smp.random(),exp)));
    lots.push(...subdivideBlock(bcx,bcz,cfg.block_width,cfg.block_depth,cfg,smp,centrality,cap));
  }
  return lots;
}

// ── Building helpers ──────────────────────────────────────────────────────────
function lotDims(lot,cfg) {
  const sb=cfg.lot_setback;
  return [Math.max(1,(lot.width-2*sb)*cfg.size_scale),Math.max(1,(lot.depth-2*sb)*cfg.size_scale)];
}

function numFloors(lot,cfg,smp) {
  let ceiling=lot.heightCap||cfg.max_floors;
  const fp=Math.max(1,Math.min(lot.width,lot.depth)*cfg.size_scale);
  ceiling=Math.floor(Math.max(cfg.min_floors,Math.min(ceiling,fp*cfg.max_aspect_ratio/cfg.floor_height)));
  const em=-Math.log(Math.max(1e-9,smp.random()));
  return Math.max(cfg.min_floors,Math.min(Math.floor(em*ceiling*0.7),ceiling));
}

function smallBuildingWindows(w, h, d, smp) {
  const hw=w/2, hd=d/2;
  const EPS = 0.05;
  const panels = [
    [w, (u,v)=>[ u-hw,  v, -hd-EPS]],
    [w, (u,v)=>[ hw-u,  v,  hd+EPS]],
    [d, (u,v)=>[ hw+EPS,v,  u-hd  ]],
    [d, (u,v)=>[-hw-EPS,v,  hd-u  ]],
  ];
  const gVerts=[], gFaces=[], gUVs=[], gSubUVs=[];
  for (let pi=0; pi<panels.length; pi++) {
    const [panelW, pfn] = panels[pi];
    const nCols = Math.max(1, Math.floor(panelW / 3.5));
    const nRows = Math.max(1, Math.floor(h / 3.0));
    const winW = (panelW / nCols) * 0.55;
    const winH = (h / nRows) * 0.60;
    if (winW < 1.2 || winH < 1.2) continue;
    const colW = panelW / nCols, rowH = h / nRows;
    for (let c=0; c<nCols; c++) {
      for (let r=0; r<nRows; r++) {
        if (smp.random() < 0.40) continue;
        const u0=(c+0.5)*colW-winW/2, u1=u0+winW;
        const v0=(r+0.5)*rowH-winH/2, v1=v0+winH;
        const base=gVerts.length;
        for (const [[u,v],[du,dv]] of [[[u0,v0],[0,0]],[[u1,v0],[1,0]],[[u1,v1],[1,1]],[[u0,v1],[0,1]]]) {
          gVerts.push(pfn(u,v));
          gUVs.push([c+pi*0.25, r]);
          gSubUVs.push([du,dv]);
        }
        gFaces.push([base,base+1,base+2],[base,base+2,base+3]);
      }
    }
  }
  return {verts:gVerts, faces:gFaces, uvs:gUVs, subUVs:gSubUVs};
}

function bodyMesh(w,h,d,floors,cfg,smp) {
  const aspect=Math.max(w,d)/Math.max(Math.min(w,d),0.1);
  const hasWin=floors>=cfg.window_min_floors;
  if (aspect<1.4&&floors>=5&&Math.min(w,d)>=8&&smp.random()<0.20) { const sides=smp.choice([6,8]),r=Math.min(w,d)/2; if (hasWin) { const {wall,window}=windowedPrism(sides,r,h,floors); return {wall,window,isprism:true}; } return {wall:prism(sides,r,h),window:emptyMesh(),isprism:true}; }
  if (hasWin) { const {wall,window}=windowedBox(w,h,d,floors,cfg.window_depth); return {wall,window,isprism:false}; }
  return {wall:box(w,h,d), window:cfg.windows_enabled?smallBuildingWindows(w,h,d,smp):emptyMesh(), isprism:false};
}

function rooftopClutter(w,d,cx,y,cz,smp) {
  const parts=[], n=Math.min(10,smp.randint(2,Math.max(3,Math.floor(w*d/25)))), mg=0.5;
  for (let i=0;i<n;i++) {
    const r=smp.random();
    if (r<0.45||(r<0.68&&y<=15)) {
      const ow=smp.uniform(0.5,Math.min(3.5,w*0.28)),oh=smp.uniform(0.4,Math.min(2,ow*1.2)),od=smp.uniform(0.5,Math.min(3.5,d*0.28));
      parts.push(place(box(ow,oh,od),cx+smp.uniform(-Math.max(0,w/2-mg-ow/2),Math.max(0,w/2-mg-ow/2)),y,cz+smp.uniform(-Math.max(0,d/2-mg-od/2),Math.max(0,d/2-mg-od/2))));
    } else if (r<0.68) {
      const ow=smp.uniform(0.15,0.45),oh=smp.uniform(2,Math.min(6,w*0.4));
      parts.push(place(box(ow,oh,ow),cx+smp.uniform(-Math.max(0,w/2-mg-ow/2),Math.max(0,w/2-mg-ow/2)),y,cz+smp.uniform(-Math.max(0,d/2-mg-ow/2),Math.max(0,d/2-mg-ow/2))));
    } else if (r<0.83) {
      const rad=smp.uniform(0.3,Math.min(1.5,Math.min(w,d)*0.12)),oh=smp.uniform(1,3);
      const hpw=w/2-mg-rad,hpd=d/2-mg-rad;
      if (hpw>0&&hpd>0) parts.push(place(cylinder(rad,oh,8),cx+smp.uniform(-hpw,hpw),y,cz+smp.uniform(-hpd,hpd)));
    } else {
      const ow=smp.uniform(1.5,Math.min(4,w*0.35)),oh=smp.uniform(2.5,4.5),od=smp.uniform(1.5,Math.min(4,d*0.35));
      parts.push(place(box(ow,oh,od),cx+smp.uniform(-Math.max(0,w/2-mg-ow/2),Math.max(0,w/2-mg-ow/2)),y,cz+smp.uniform(-Math.max(0,d/2-mg-od/2),Math.max(0,d/2-mg-od/2))));
    }
  }
  return mergeMeshes(parts);
}

function roofMesh(w,d,cx,y,cz,cfg,smp,allowPyramid=true) {
  const parts=[], r=smp.random(); let flat=true;
  if (allowPyramid&&r<cfg.roof_pyramid_chance&&w>4&&d>4) {
    parts.push(place(pyramid(w,cfg.roof_pyramid_height*smp.uniform(0.6,1.4),d),cx,y,cz)); flat=false;
  } else if (allowPyramid&&r<cfg.roof_pyramid_chance+0.15&&w>6&&d>6) {
    const t=smp.uniform(0.5,1.2),br=Math.max(1,Math.min(w,d)*0.12);
    parts.push(place(box(w,t,br),cx,y,cz-d/2+br/2),place(box(w,t,br),cx,y,cz+d/2-br/2),
               place(box(br,t,d-2*br),cx-w/2+br/2,y,cz),place(box(br,t,d-2*br),cx+w/2-br/2,y,cz));
  }
  if (flat&&w>5&&d>5&&smp.random()<0.72) parts.push(rooftopClutter(w,d,cx,y,cz,smp));
  if (y>30&&smp.random()<0.15) {
    const sr=smp.uniform(0.25,0.55), sh=y*smp.uniform(0.10,0.20);
    parts.push(place(prism(4,sr,sh),cx,y,cz));
  }
  return mergeMeshes(parts);
}

// ── Building styles ───────────────────────────────────────────────────────────
function styleSimple(lot,cfg,smp) {
  const [w,d]=lotDims(lot,cfg), floors=numFloors(lot,cfg,smp), h=floors*cfg.floor_height;
  if (floors>=cfg.setback_min_floors&&smp.random()<0.35) {
    const lf=Math.floor(floors*smp.uniform(0.55,0.72)),hf=Math.max(1,floors-lf);
    const lh=lf*cfg.floor_height,hh=hf*cfg.floor_height,sb=smp.uniform(2,4.5);
    const w2=Math.max(3,w-2*sb),d2=Math.max(3,d-2*sb);
    const {wall:lw,window:lwn}=bodyMesh(w,lh,d,lf,cfg,smp);
    const {wall:hw,window:hwn,isprism:hp}=bodyMesh(w2,hh,d2,hf,cfg,smp);
    return {wall:mergeMeshes([place(lw,lot.cx,0,lot.cz),place(hw,lot.cx,lh,lot.cz)]),window:mergeMeshes([place(lwn,lot.cx,0,lot.cz),place(hwn,lot.cx,lh,lot.cz)]),roof:roofMesh(w2,d2,lot.cx,lh+hh,lot.cz,cfg,smp,!hp)};
  }
  const {wall,window,isprism}=bodyMesh(w,h,d,floors,cfg,smp);
  return {wall:place(wall,lot.cx,0,lot.cz),window:place(window,lot.cx,0,lot.cz),roof:roofMesh(w,d,lot.cx,h,lot.cz,cfg,smp,!isprism)};
}

function styleStepped(lot,cfg,smp) {
  const [w0,d0]=lotDims(lot,cfg), tf=numFloors(lot,cfg,smp);
  const ns=smp.randint(2,Math.min(4,Math.max(2,Math.floor(tf/3))));
  const walls=[],windows=[]; let y=0,w=w0,d=d0,isp=false;
  for (let i=0;i<ns;i++) {
    const fh=Math.max(1,Math.floor(tf/ns)+(i===0?1:0)),h=fh*cfg.floor_height;
    const {wall,window,isprism}=bodyMesh(w,h,d,fh,cfg,smp); isp=isprism;
    walls.push(place(wall,lot.cx,y,lot.cz)); windows.push(place(window,lot.cx,y,lot.cz)); y+=h;
    const sh=smp.uniform(1.5,3.5); w=Math.max(2,w-2*sh); d=Math.max(2,d-2*sh);
  }
  return {wall:mergeMeshes(walls),window:mergeMeshes(windows),roof:roofMesh(w,d,lot.cx,y,lot.cz,cfg,smp,!isp)};
}

function styleTowerPodium(lot,cfg,smp) {
  const [w0,d0]=lotDims(lot,cfg), tf=Math.max(4,numFloors(lot,cfg,smp));
  const pf=smp.randint(1,Math.max(1,Math.floor(tf/4))), twf=tf-pf;
  const ph=pf*cfg.floor_height, th=twf*cfg.floor_height;
  const tw=Math.max(2,w0*smp.uniform(0.3,0.6)), td=Math.max(2,d0*smp.uniform(0.3,0.6));
  const dx=smp.uniform(-(w0-tw)/2*0.6,(w0-tw)/2*0.6), dz=smp.uniform(-(d0-td)/2*0.6,(d0-td)/2*0.6);
  const {wall:pw,window:pwn}=bodyMesh(w0,ph,d0,pf,cfg,smp);
  const {wall:tw2,window:twn,isprism:tp}=bodyMesh(tw,th,td,twf,cfg,smp);
  return {wall:mergeMeshes([place(pw,lot.cx,0,lot.cz),place(tw2,lot.cx+dx,ph,lot.cz+dz)]),window:mergeMeshes([place(pwn,lot.cx,0,lot.cz),place(twn,lot.cx+dx,ph,lot.cz+dz)]),roof:roofMesh(tw,td,lot.cx+dx,ph+th,lot.cz+dz,cfg,smp,!tp)};
}

function styleLShaped(lot,cfg,smp) {
  const [w,d]=lotDims(lot,cfg);
  if (Math.min(w,d)<8) return styleSimple(lot,cfg,smp);
  const floors=numFloors(lot,cfg,smp),h=floors*cfg.floor_height;
  const sx=smp.uniform(0.45,0.65),sz=smp.uniform(0.45,0.65);
  const z0=lot.cz-d/2,a1d=d*sz,a2w=w*sx,a2d=d*(1-sz);
  const h2=h*smp.uniform(0.65,1),f2=Math.max(1,Math.round(h2/cfg.floor_height));
  const {wall:w1,window:wn1}=bodyMesh(w,h,a1d,floors,cfg,smp);
  const {wall:w2,window:wn2}=bodyMesh(a2w,h2,a2d,f2,cfg,smp);
  return {wall:mergeMeshes([place(w1,lot.cx,0,z0+a1d/2),place(w2,lot.cx-w/2+a2w/2,0,z0+a1d+a2d/2)]),window:mergeMeshes([place(wn1,lot.cx,0,z0+a1d/2),place(wn2,lot.cx-w/2+a2w/2,0,z0+a1d+a2d/2)]),roof:roofMesh(w,a1d,lot.cx,h,z0+a1d/2,cfg,smp,false)};
}

function styleCourtyard(lot,cfg,smp) {
  const [w,d]=lotDims(lot,cfg);
  if (Math.min(w,d)<12) return styleLShaped(lot,cfg,smp);
  const floors=numFloors(lot,cfg,smp),h=floors*cfg.floor_height;
  const ww=w*smp.uniform(0.18,0.30),bd=d*smp.uniform(0.22,0.38);
  const h3=h*smp.uniform(0.65,1),f3=Math.max(1,Math.round(h3/cfg.floor_height));
  const {wall:wl,window:wln}=bodyMesh(ww,h,d,floors,cfg,smp);
  const {wall:wr,window:wrn}=bodyMesh(ww,h,d,floors,cfg,smp);
  const {wall:wb,window:wbn}=bodyMesh(w-2*ww,h3,bd,f3,cfg,smp);
  return {wall:mergeMeshes([place(wl,lot.cx-w/2+ww/2,0,lot.cz),place(wr,lot.cx+w/2-ww/2,0,lot.cz),place(wb,lot.cx,0,lot.cz+d/2-bd/2)]),window:mergeMeshes([place(wln,lot.cx-w/2+ww/2,0,lot.cz),place(wrn,lot.cx+w/2-ww/2,0,lot.cz),place(wbn,lot.cx,0,lot.cz+d/2-bd/2)]),roof:emptyMesh()};
}

function styleChamfered(lot,cfg,smp) {
  const [w,d]=lotDims(lot,cfg),floors=numFloors(lot,cfg,smp);
  if (floors<5) return styleSimple(lot,cfg,smp);
  const h=floors*cfg.floor_height,r=Math.min(w,d)/2;
  const validSides=r>=6?[6,8,12]:r>=4?[6,8]:r>=3?[6]:null;
  if (!validSides) return styleSimple(lot,cfg,smp);
  const sides=smp.choice(validSides);
  const hasWin=floors>=cfg.window_min_floors;
  const {wall:mainWall,window:mainWin}=hasWin?windowedPrism(sides,r,h,floors):{wall:prism(sides,r,h),window:emptyMesh()};
  const wallParts=[place(mainWall,lot.cx,0,lot.cz)];
  const winParts=[place(mainWin,lot.cx,0,lot.cz)];
  if (h>12&&smp.random()<0.55) {
    const topR=r*smp.uniform(0.35,0.65), topH=h*smp.uniform(0.18,0.35);
    const topFloors=Math.max(1,Math.round(topH/cfg.floor_height));
    const topFaceW=2*topR*Math.sin(Math.PI/sides);
    if (topFloors>=cfg.window_min_floors&&topFaceW>=3) {
      const {wall:tw,window:twin}=windowedPrism(sides,topR,topH,topFloors);
      wallParts.push(place(tw,lot.cx,h,lot.cz));
      winParts.push(place(twin,lot.cx,h,lot.cz));
    } else {
      wallParts.push(place(prism(sides,topR,topH),lot.cx,h,lot.cz));
    }
  }
  return {wall:mergeMeshes(wallParts),window:mergeMeshes(winParts),roof:emptyMesh()};
}

const STYLES=[styleSimple,styleStepped,styleTowerPodium,styleLShaped,styleCourtyard,styleChamfered];
const BASE_W=[0.20,0.18,0.14,0.24,0.12,0.12];

function generateBuilding(lot,cfg,smp) {
  if (lot.width<cfg.min_lot_size*0.4||lot.depth<cfg.min_lot_size*0.4) return {wall:emptyMesh(),window:emptyMesh(),roof:emptyMesh()};
  const w=[...BASE_W];
  if (lot.centrality>0.6)      { w[2]+=0.10;w[5]+=0.10;w[1]+=0.05;w[3]-=0.15;w[4]-=0.10; }
  else if (lot.centrality<0.3) { w[3]+=0.10;w[4]+=0.08;w[0]+=0.07;w[2]-=0.15;w[5]-=0.10; }
  return smp.choices(STYLES,w)(lot,cfg,smp);
}

function lotBlvdOverlap(lot,cfg,poly,angle=0) {
  const sb=cfg.lot_setback,lw=Math.max(1,lot.width-2*sb),ld=Math.max(1,lot.depth-2*sb);
  const fp=angle
    ? (()=>{const hw=lw/2,hd=ld/2,c=Math.cos(angle),s=Math.sin(angle);return[[-hw,-hd],[hw,-hd],[hw,hd],[-hw,hd]].map(([x,z])=>[lot.cx+x*c-z*s,lot.cz+x*s+z*c]);})()
    : rectFP(lot.cx,lot.cz,lw,ld);
  const cl=clipPolygon(fp,poly);
  return cl.length?polyArea(cl)/Math.max(polyArea(fp),1e-6):0;
}

// ── Highway ───────────────────────────────────────────────────────────────────
function catmullRom(pts, spacing) {
  if (pts.length<2) return pts;
  const ext=[[2*pts[0][0]-pts[1][0],2*pts[0][1]-pts[1][1]],...pts,[2*pts[pts.length-1][0]-pts[pts.length-2][0],2*pts[pts.length-1][1]-pts[pts.length-2][1]]];
  const result=[];
  for (let i=1;i<ext.length-2;i++) {
    const [p0,p1,p2,p3]=[ext[i-1],ext[i],ext[i+1],ext[i+2]];
    const steps=Math.max(1,Math.ceil(Math.hypot(p2[0]-p1[0],p2[1]-p1[1])/spacing));
    for (let s=0;s<steps;s++) {
      const t=s/steps,t2=t*t,t3=t2*t;
      result.push([
        0.5*((2*p1[0])+(-p0[0]+p2[0])*t+(2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2+(-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3),
        0.5*((2*p1[1])+(-p0[1]+p2[1])*t+(2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2+(-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3),
      ]);
    }
  }
  result.push(pts[pts.length-1]);
  return result;
}

function getTangent(poly,i) {
  const n=poly.length;
  const [ax,az]=i===0?[poly[1][0]-poly[0][0],poly[1][1]-poly[0][1]]:i===n-1?[poly[n-1][0]-poly[n-2][0],poly[n-1][1]-poly[n-2][1]]:[poly[i+1][0]-poly[i-1][0],poly[i+1][1]-poly[i-1][1]];
  const dist=Math.hypot(ax,az);
  return dist>1e-9?[ax/dist,az/dist]:[1,0];
}

function offsetPoly(poly,offset) {
  return poly.map((pt,i)=>{const[tx,tz]=getTangent(poly,i);return[pt[0]+(-tz)*offset,pt[1]+tx*offset];});
}

function deckMesh(poly,width,elev,thick) {
  const n=poly.length,hw=width/2,verts=[],faces=[];
  for (let i=0;i<n;i++) {
    const[x,z]=poly[i],[tx,tz]=getTangent(poly,i),px=-tz,pz=tx;
    verts.push([x-px*hw,elev+thick,z-pz*hw],[x+px*hw,elev+thick,z+pz*hw],[x-px*hw,elev,z-pz*hw],[x+px*hw,elev,z+pz*hw]);
  }
  for (let i=0;i<n-1;i++) {
    const[a,b,c,d]=[i*4,i*4+1,i*4+2,i*4+3],[e,f,g,h]=[a+4,b+4,c+4,d+4];
    faces.push([a,e,f],[a,f,b],[c,d,h],[c,h,g],[a,c,g],[a,g,e],[b,f,h],[b,h,d]);
  }
  faces.push([0,1,3],[0,3,2]);
  const L=(n-1)*4; faces.push([L,L+2,L+3],[L,L+3,L+1]);
  return {verts,faces};
}

function generateHighway(cfg,rng) {
  const hw=cfg.city_width/2,hd=cfg.city_depth/2;
  const edgePt=e=>{const sx=hw*0.8,sz=hd*0.8;if(e===0)return[-hw,rngRange(rng,-sz,sz)];if(e===1)return[hw,rngRange(rng,-sz,sz)];if(e===2)return[rngRange(rng,-sx,sx),-hd];return[rngRange(rng,-sx,sx),hd];};
  const edge=rngInt(rng,0,3),entry=edgePt(edge),exit=edgePt((edge+2)%4);
  const mx=(entry[0]+exit[0])/2,mz=(entry[1]+exit[1])/2;
  const dx=exit[0]-entry[0],dz=exit[1]-entry[1],len=Math.hypot(dx,dz);
  const px=len>1e-9?-dz/len:1,pz=len>1e-9?dx/len:0;
  const nudge=rngRange(rng,-cfg.city_width*0.12,cfg.city_width*0.12);
  const fine=catmullRom([entry,[mx+px*nudge,mz+pz*nudge],exit],3);
  const coarse=catmullRom([entry,[mx+px*nudge,mz+pz*nudge],exit],12);
  const off=cfg.highway_carriage_width/2+cfg.highway_median_width/2;
  const leftDeck=deckMesh(offsetPoly(fine,+off),cfg.highway_carriage_width,cfg.highway_elevation,cfg.highway_deck_thickness);
  const rightDeck=deckMesh(offsetPoly(fine,-off),cfg.highway_carriage_width,cfg.highway_elevation,cfg.highway_deck_thickness);
  const pillars=[]; let acc=0,next=cfg.highway_pillar_spacing*0.5,prev=fine[0];
  for (let j=1;j<fine.length;j++) {
    const pt=fine[j],seg=Math.hypot(pt[0]-prev[0],pt[1]-prev[1]);
    while (acc+seg>=next) {
      const t=(next-acc)/seg,cx=prev[0]+t*(pt[0]-prev[0]),cz=prev[1]+t*(pt[1]-prev[1]);
      const[tx,tz]=getTangent(fine,j),px2=-tz,pz2=tx;
      for (const side of[+off,-off]) pillars.push(transformMesh(box(cfg.highway_pillar_size,cfg.highway_elevation,cfg.highway_pillar_size),[cx+px2*side,0,cz+pz2*side]));
      next+=cfg.highway_pillar_spacing;
    }
    acc+=seg; prev=pt;
  }
  const cw=2*cfg.highway_carriage_width+cfg.highway_median_width;
  const blvds=[];
  for (let i=0;i<coarse.length-1;i++) {
    const[x1,z1]=coarse[i],[x2,z2]=coarse[i+1];
    blvds.push([x1,z1,x2,z2,blvdPoly(x1,z1,x2,z2,cw),Math.atan2(z2-z1,x2-x1)]);
  }
  return [[['left_deck',leftDeck],['right_deck',rightDeck],...pillars.map((p,i)=>[`pillar_${String(i).padStart(3,'0')}`,p])],blvds];
}

// ── Traffic intersection splitting ────────────────────────────────────────────
// Splits boulevard and street segments wherever they cross, so that every
// junction gets a shared endpoint node that buildAdjacency can wire up.
// Without this, streets and boulevards are independent full-length lines that
// never share a point, so cars can never turn between road types.
function splitAtIntersections(segs) {
  function xsect(ax, az, bx, bz, cx, cz, dx, dz) {
    const d1x=bx-ax, d1z=bz-az, d2x=dx-cx, d2z=dz-cz;
    const cross=d1x*d2z - d1z*d2x;
    if (Math.abs(cross) < 1e-10) return null;
    const ex=cx-ax, ez=cz-az;
    const t=(ex*d2z - ez*d2x)/cross;
    const u=(ex*d1z - ez*d1x)/cross;
    const eps=1e-6;
    if (t>eps && t<1-eps && u>eps && u<1-eps) return {t, u};
    return null;
  }
  const n=segs.length;
  const tBuf=Array.from({length:n}, ()=>[]);
  for (let i=0;i<n;i++) for (let j=i+1;j<n;j++) {
    const si=segs[i], sj=segs[j];
    const h=xsect(si.start[0],si.start[2],si.end[0],si.end[2],
                  sj.start[0],sj.start[2],sj.end[0],sj.end[2]);
    if (h) { tBuf[i].push(h.t); tBuf[j].push(h.u); }
  }
  const out=[];
  for (let i=0;i<n;i++) {
    const seg=segs[i], ts=tBuf[i];
    if (!ts.length) { out.push(seg); continue; }
    ts.sort((a,b)=>a-b);
    let prevT=0, prevPt=seg.start;
    for (const t of ts) {
      if (t-prevT<1e-6) continue;
      const pt=[seg.start[0]+(seg.end[0]-seg.start[0])*t,
                seg.start[1]+(seg.end[1]-seg.start[1])*t,
                seg.start[2]+(seg.end[2]-seg.start[2])*t];
      out.push({start:prevPt, end:pt, type:seg.type});
      prevPt=pt; prevT=t;
    }
    if (1-prevT>1e-6) out.push({start:prevPt, end:seg.end, type:seg.type});
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function generateCity(config) {
  const cfg={
    seed:42,city_width:400,city_depth:400,scale:0.001,dist:'uniform',
    block_width:40,block_depth:40,street_width:8,min_lot_size:8,max_lot_size:20,lot_setback:0.5,
    floor_height:3,min_floors:1,max_floors:18,downtown_boost:2.5,max_aspect_ratio:4,
    roof_pyramid_chance:0.25,roof_pyramid_height:3,add_base:true,base_thickness:2,base_margin:5,
    voronoi_boulevards:false,voronoi_sites:8,diagonal_road:false,road_height:0.5,
    windows_enabled:true,window_min_floors:4,window_depth:0.5,setback_min_floors:10,num_highways:1,
    highway_elevation:10,highway_carriage_width:6,highway_median_width:3,
    highway_deck_thickness:1.5,highway_pillar_spacing:30,highway_pillar_size:2.5,
    ...config
  };
  const distScale={uniform:1.0,gumbel:1.2,normal:1.0};
  cfg.size_scale=distScale[cfg.dist]??1.0;

  const rng=makeRng(cfg.seed), smp=new Sampler(rng,cfg.dist);
  const nC=rngInt(rng,0,3), hw=cfg.city_width*0.4, hd=cfg.city_depth*0.4;
  const centers=Array.from({length:nC},()=>[rngRange(rng,-hw,hw),rngRange(rng,-hd,hd)]);

  const boulevards=[];
  if (cfg.voronoi_boulevards) {
    for (const [x1,z1,x2,z2] of voronoiBoulevards(cfg,rng))
      boulevards.push([x1,z1,x2,z2,blvdPoly(x1,z1,x2,z2,cfg.street_width),Math.atan2(z2-z1,x2-x1)]);
  }
  if (cfg.diagonal_road) {
    const px=cfg.block_width+cfg.street_width,pz=cfg.block_depth+cfg.street_width;
    const nx=Math.max(1,Math.floor(cfg.city_width/px)),nz=Math.max(1,Math.floor(cfg.city_depth/pz));
    const tw=nx*px-cfg.street_width,td=nz*pz-cfg.street_width;
    boulevards.push([-tw/2,-td/2,tw/2,td/2,blvdPoly(-tw/2,-td/2,tw/2,td/2,cfg.street_width),Math.atan2(td,tw)]);
  }

  const nSB=boulevards.length, hwObjects=[];
  for (let hi=0;hi<cfg.num_highways;hi++) {
    const [meshes,blvds]=generateHighway(cfg,rng);
    boulevards.push(...blvds);
    for (const [pn,pm] of meshes) hwObjects.push([`highway_${String(hi).padStart(2,'0')}_${pn}`,pm]);
  }

  const lots=generateLots(cfg,rng,smp,centers);
  const nearBlvd=lot=>{
    let bd=Infinity,ba=0;
    for (const [x1,z1,x2,z2,,a] of boulevards) {
      const dx=x2-x1,dz=z2-z1,lsq=dx*dx+dz*dz;
      const t=lsq>0?Math.max(0,Math.min(1,((lot.cx-x1)*dx+(lot.cz-z1)*dz)/lsq)):0;
      const dist=Math.hypot(lot.cx-(x1+t*dx),lot.cz-(z1+t*dz));
      if (dist<bd){bd=dist;ba=a;}
    }
    return [bd,ba];
  };

  const rotateAround=(m,cx,cz,a)=>transformMesh(transformMesh(m,[-cx,0,-cz]),[cx,0,cz],a);
  const objects=[];
  for (let i=0;i<lots.length;i++) {
    const lot=lots[i];
    let parts=generateBuilding(lot,cfg,smp);
    if (!parts.wall.verts.length&&!parts.window.verts.length&&!parts.roof.verts.length) { continue; }
    let rotAngle=null;
    if (boulevards.length) {
      const [dist,angle]=nearBlvd(lot);
      if (dist<cfg.block_width&&rng()<0.70) {
        parts={wall:rotateAround(parts.wall,lot.cx,lot.cz,angle),window:rotateAround(parts.window,lot.cx,lot.cz,angle),roof:rotateAround(parts.roof,lot.cx,lot.cz,angle)};
        rotAngle=angle;
      }
    }
    if (boulevards.length&&boulevards.some(([,,,, poly])=>lotBlvdOverlap(lot,cfg,poly,rotAngle||0)>0.01)) { continue; }
    const idx=String(i).padStart(4,'0');
    const wallTag = parts.window.verts.length ? 'wall' : 'smallwall';
    if (parts.wall.verts.length)   objects.push([`${wallTag}_${idx}`,parts.wall]);
    if (parts.window.verts.length) objects.push([`window_${idx}`,parts.window]);
    if (parts.roof.verts.length)   objects.push([`roof_${idx}`,parts.roof]);
  }

  for (let i=0;i<nSB;i++) { const [x1,z1,x2,z2]=boulevards[i]; objects.push([`boulevard_${String(i).padStart(3,'0')}`,roadStrip(x1,z1,x2,z2,cfg.street_width,cfg.road_height)]); }
  objects.push(...hwObjects);
  if (cfg.add_base) objects.unshift(['base_plate',basePlate(cfg.city_width+2*cfg.base_margin,cfg.city_depth+2*cfg.base_margin,cfg.base_thickness)]);

  // Traffic
  const px=cfg.block_width+cfg.street_width,pz2=cfg.block_depth+cfg.street_width;
  const nbx=Math.max(1,Math.floor(cfg.city_width/px)),nbz=Math.max(1,Math.floor(cfg.city_depth/pz2));
  const tw=nbx*px-cfg.street_width,td=nbz*pz2-cfg.street_width;
  const ox=-tw/2,oz=-td/2,sc=cfg.scale,ry=cfg.road_height*sc;
  const trafficSegs=[];
  for (let bx=0;bx<nbx-1;bx++){const x=(ox+(bx+1)*px-cfg.street_width/2)*sc;trafficSegs.push({start:[x,ry,oz*sc],end:[x,ry,(oz+td)*sc],type:'street'});}
  for (let bz=0;bz<nbz-1;bz++){const z=(oz+(bz+1)*pz2-cfg.street_width/2)*sc;trafficSegs.push({start:[ox*sc,ry,z],end:[(ox+tw)*sc,ry,z],type:'street'});}
  for (let i=0;i<nSB;i++){const[x1,z1,x2,z2]=boulevards[i];trafficSegs.push({start:[x1*sc,ry,z1*sc],end:[x2*sc,ry,z2*sc],type:'boulevard'});}

  // Split segments at boulevard/street crossings so junctions have shared nodes
  const splitResult=splitAtIntersections(trafficSegs);
  trafficSegs.length=0;
  for (const s of splitResult) trafficSegs.push(s);

  // Surface warp
  const surface = cfg.surface || 'flat';
  if (surface !== 'flat') {
    let warpFn, baseMesh;
    if (surface === 'sphere') {
      const r = cfg.sphere_radius || cfg.city_width / 2;
      warpFn = v => sphereWarp(v, r);
      if (cfg.add_base) baseMesh = sphereMesh(r);
    } else if (surface === 'hemisphere') {
      const r = cfg.sphere_radius || cfg.city_width / 2;
      const autoOff = (cfg.city_depth / (2 * r)) * (180 / Math.PI) + 15;
      const poleDeg = cfg.pole_offset != null ? cfg.pole_offset : autoOff;
      const latOff = poleDeg * Math.PI / 180;
      warpFn = v => hemisphereWarp(v, r, latOff);
      if (cfg.add_base) baseMesh = hemisphereMesh(r);
    } else if (surface === 'torus') {
      const major = cfg.torus_major || cfg.city_width * 1.5;
      const minor = cfg.torus_minor || cfg.city_width * 0.3;
      warpFn = v => torusWarp(v, major, minor);
      if (cfg.add_base) baseMesh = torusMesh(major, minor);
    }
    if (!warpFn) throw new Error('Unknown surface: ' + surface);
    const warped = [];
    for (const [name, mesh] of objects) {
      if (name === 'base_plate') {
        if (baseMesh) warped.push(['base_plate', baseMesh]);
      } else {
        const wm = { verts: warpFn(mesh.verts), faces: mesh.faces };
        if (mesh.uvs)    wm.uvs    = mesh.uvs;
        if (mesh.subUVs) wm.subUVs = mesh.subUVs;
        warped.push([name, wm]);
      }
    }
    objects.length = 0; objects.push(...warped);

    // Warp traffic segments: subdivide then project each point onto the surface
    const warpedSegs = [];
    for (const seg of trafficSegs) {
      const [sx,sy,sz] = seg.start, [ex,ey,ez] = seg.end;
      // convert scaled→metres for warp, subdivide every 10 m
      const p0 = [sx/sc, sy/sc, sz/sc], p1 = [ex/sc, ey/sc, ez/sc];
      const n = Math.max(1, Math.ceil(Math.hypot(p1[0]-p0[0], p1[2]-p0[2]) / 10));
      for (let i = 0; i < n; i++) {
        const t0 = i/n, t1 = (i+1)/n;
        const q0 = [p0[0]+(p1[0]-p0[0])*t0, p0[1]+(p1[1]-p0[1])*t0, p0[2]+(p1[2]-p0[2])*t0];
        const q1 = [p0[0]+(p1[0]-p0[0])*t1, p0[1]+(p1[1]-p0[1])*t1, p0[2]+(p1[2]-p0[2])*t1];
        const w0 = warpFn([q0])[0].map(v => v*sc);
        const w1 = warpFn([q1])[0].map(v => v*sc);
        warpedSegs.push({start: w0, end: w1, type: seg.type});
      }
    }
    trafficSegs.length = 0; trafficSegs.push(...warpedSegs);
  }

  // Serialise to typed arrays
  const out=[];
  for (const [name,mesh] of objects) {
    if (!mesh.verts.length) continue;
    const verts=new Float32Array(mesh.verts.length*3);
    for (let i=0;i<mesh.verts.length;i++){verts[i*3]=mesh.verts[i][0]*sc;verts[i*3+1]=mesh.verts[i][1]*sc;verts[i*3+2]=mesh.verts[i][2]*sc;}
    const faces=new Uint32Array(mesh.faces.length*3);
    for (let i=0;i<mesh.faces.length;i++){faces[i*3]=mesh.faces[i][0];faces[i*3+1]=mesh.faces[i][1];faces[i*3+2]=mesh.faces[i][2];}
    if (mesh.uvs && mesh.uvs.length) {
      const uvs=new Float32Array(mesh.uvs.length*2);
      for (let i=0;i<mesh.uvs.length;i++){uvs[i*2]=mesh.uvs[i][0];uvs[i*2+1]=mesh.uvs[i][1];}
      if (mesh.subUVs && mesh.subUVs.length) {
        const subUVs=new Float32Array(mesh.subUVs.length*2);
        for (let i=0;i<mesh.subUVs.length;i++){subUVs[i*2]=mesh.subUVs[i][0];subUVs[i*2+1]=mesh.subUVs[i][1];}
        out.push({name,verts,faces,uvs,subUVs});
      } else {
        out.push({name,verts,faces,uvs});
      }
    } else {
      out.push({name,verts,faces});
    }
  }
  const torusMajorSc = surface === 'torus' ? (cfg.torus_major || cfg.city_width*1.5)*sc : 0;
  return {objects:out, surface, traffic:{street_width:cfg.street_width*sc, surface, torus_major_sc:torusMajorSc, segments:trafficSegs}};
}

// ── Warp functions ────────────────────────────────────────────────────────────
function sphereWarp(verts, radius) {
  return verts.map(([x, y, z]) => {
    const phi=x/radius, theta=z/radius, r=radius+y;
    return [r*Math.cos(theta)*Math.sin(phi), r*Math.sin(theta), r*Math.cos(theta)*Math.cos(phi)];
  });
}

function hemisphereWarp(verts, radius, latOffset) {
  return verts.map(([x, y, z]) => {
    const phi=x/radius, theta=latOffset+z/radius, r=radius+y;
    return [r*Math.sin(theta)*Math.cos(phi), r*Math.cos(theta), r*Math.sin(theta)*Math.sin(phi)];
  });
}

function torusWarp(verts, major, minor) {
  return verts.map(([x, y, z]) => {
    const phi=x/major, theta=z/minor, r=minor+y;
    return [(major+r*Math.cos(theta))*Math.cos(phi), r*Math.sin(theta), (major+r*Math.cos(theta))*Math.sin(phi)];
  });
}

function sphereMesh(radius, uRes=64, vRes=32) {
  const verts=[], faces=[];
  for (let j=0;j<=vRes;j++) for (let i=0;i<uRes;i++) {
    const theta=j*Math.PI/vRes, phi=i*2*Math.PI/uRes;
    verts.push([radius*Math.sin(theta)*Math.cos(phi), radius*Math.cos(theta), radius*Math.sin(theta)*Math.sin(phi)]);
  }
  for (let j=0;j<vRes;j++) for (let i=0;i<uRes;i++) {
    const a=j*uRes+i, b=j*uRes+(i+1)%uRes, c=(j+1)*uRes+i, d=(j+1)*uRes+(i+1)%uRes;
    faces.push([a,c,d],[a,d,b]);
  }
  return {verts,faces};
}

function hemisphereMesh(radius, uRes=64, vRes=16) {
  const verts=[], faces=[];
  for (let j=0;j<=vRes;j++) for (let i=0;i<uRes;i++) {
    const theta=j*Math.PI/(2*vRes), phi=i*2*Math.PI/uRes;
    verts.push([radius*Math.sin(theta)*Math.cos(phi), radius*Math.cos(theta), radius*Math.sin(theta)*Math.sin(phi)]);
  }
  for (let j=0;j<vRes;j++) for (let i=0;i<uRes;i++) {
    const a=j*uRes+i, b=j*uRes+(i+1)%uRes, c=(j+1)*uRes+i, d=(j+1)*uRes+(i+1)%uRes;
    faces.push([a,c,d],[a,d,b]);
  }
  // flat disk cap
  const eq=vRes*uRes, ci=verts.length;
  verts.push([0,0,0]);
  for (let i=0;i<uRes;i++) faces.push([ci, eq+i, eq+(i+1)%uRes]);
  return {verts,faces};
}

function torusMesh(major, minor, uRes=80, vRes=40) {
  const verts=[], faces=[];
  for (let i=0;i<uRes;i++) for (let j=0;j<vRes;j++) {
    const phi=i*2*Math.PI/uRes, theta=j*2*Math.PI/vRes;
    const rr = major + minor*Math.cos(theta);
    verts.push([rr*Math.cos(phi), minor*Math.sin(theta), rr*Math.sin(phi)]);
  }
  for (let i=0;i<uRes;i++) for (let j=0;j<vRes;j++) {
    const a=i*vRes+j, b=i*vRes+(j+1)%vRes, c=((i+1)%uRes)*vRes+j, d=((i+1)%uRes)*vRes+(j+1)%vRes;
    faces.push([a,b,d],[a,d,c]);
  }
  return {verts,faces};
}

self.onmessage=e=>{
  try {
    const result=generateCity(e.data);
    self.postMessage({ok:true,...result},result.objects.flatMap(o=>{const t=[o.verts.buffer,o.faces.buffer];if(o.uvs)t.push(o.uvs.buffer);if(o.subUVs)t.push(o.subUVs.buffer);return t;}));
  } catch(err) {
    self.postMessage({ok:false,error:err.message+'\n'+err.stack});
  }
};
