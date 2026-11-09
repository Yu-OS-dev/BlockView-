import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { OrbitControls } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js";

const $=id=>document.getElementById(id);
let worldId=location.pathname.startsWith("/w/")?location.pathname.split("/")[2]:null;
let scene,camera,renderer,controls,raycaster,mouse;
let chunkIndex=[],loaded=new Set(),blockMeshes=[],worldDimension="overworld";
let blockPickables=[],keysDown=new Set();
const BLOCK_SIZE=1;
const colorCache=new Map();

function blockColor(name){
  if(colorCache.has(name))return colorCache.get(name);
  const n=name.replace(/^minecraft:/,"");
  let color=0x8b8b8b;
  if(n.includes("air"))color=0x000000;
  else if(n.includes("water"))color=0x3d79bd;
  else if(n.includes("lava"))color=0xe56b25;
  else if(n.includes("grass")||n.includes("leaves")||n.includes("moss")||n.includes("vine")||n.includes("sapling"))color=0x57964b;
  else if(n.includes("sand")||n.includes("sandstone"))color=0xd6c17a;
  else if(n.includes("snow")||n.includes("ice")||n.includes("quartz"))color=0xdce8ed;
  else if(n.includes("wood")||n.includes("log")||n.includes("planks")||n.includes("stem")||n.includes("hyphae"))color=0x98704a;
  else if(n.includes("stone")||n.includes("deepslate")||n.includes("cobble")||n.includes("ore"))color=0x777e86;
  else if(n.includes("dirt")||n.includes("mud")||n.includes("clay"))color=0x79563c;
  else if(n.includes("brick")||n.includes("terracotta"))color=0x9d6654;
  else if(n.includes("wool")||n.includes("concrete")||n.includes("carpet"))color=0xaaaaaa;
  else if(n.includes("glass"))color=0x9bc9d8;
  else if(n.includes("flower")||n.includes("tulip")||n.includes("rose")||n.includes("dandelion"))color=0xc879a9;
  else if(n.includes("torch")||n.includes("lantern")||n.includes("glowstone")||n.includes("sea_lantern"))color=0xe9c66f;
  colorCache.set(name,color);return color;
}
function materialFor(name){
  const transparent=/glass|water|ice|leaves|slime|honey/.test(name);
  return new THREE.MeshLambertMaterial({
    color:blockColor(name),
    transparent,
    opacity:name.includes("water")?0.58:(name.includes("glass")?0.38:1),
    depthWrite:!transparent
  });
}
function init(){
  const host=$("viewport");
  scene=new THREE.Scene();scene.background=new THREE.Color(0x0a0f15);
  camera=new THREE.PerspectiveCamera(65,host.clientWidth/Math.max(1,host.clientHeight),0.1,5000);
  camera.position.set(24,26,32);
  renderer=new THREE.WebGLRenderer({antialias:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(host.clientWidth,host.clientHeight);
  host.appendChild(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff,0x526070,2.0));
  const sun=new THREE.DirectionalLight(0xffffff,2.1);sun.position.set(80,140,50);scene.add(sun);
  controls=new OrbitControls(camera,renderer.domElement);
  controls.enableDamping=true;controls.dampingFactor=.07;controls.target.set(8,8,8);
  controls.mouseButtons={LEFT:THREE.MOUSE.ROTATE,MIDDLE:THREE.MOUSE.DOLLY,RIGHT:THREE.MOUSE.PAN};
  raycaster=new THREE.Raycaster();raycaster.params.Mesh.threshold=.1;mouse=new THREE.Vector2();
  const grid=new THREE.GridHelper(128,128,0x3b4a59,0x1b2936);grid.position.y=-.52;scene.add(grid);
  const animate=()=>{
    requestAnimationFrame(animate);
    const forward=new THREE.Vector3();camera.getWorldDirection(forward);forward.y=0;forward.normalize();
    const right=new THREE.Vector3().crossVectors(forward,camera.up).normalize();
    const speed=keysDown.has("shift")?.9:.28;
    if(keysDown.has("w"))camera.position.addScaledVector(forward,speed);
    if(keysDown.has("s"))camera.position.addScaledVector(forward,-speed);
    if(keysDown.has("d"))camera.position.addScaledVector(right,speed);
    if(keysDown.has("a"))camera.position.addScaledVector(right,-speed);
    controls.update();renderer.render(scene,camera);
  };animate();
  new ResizeObserver(()=>{camera.aspect=host.clientWidth/Math.max(1,host.clientHeight);camera.updateProjectionMatrix();renderer.setSize(host.clientWidth,host.clientHeight)}).observe(host);
  renderer.domElement.addEventListener("click",inspectBlock);
  window.addEventListener("keydown",e=>{if(["INPUT","SELECT"].includes(document.activeElement.tagName))return;const k=e.key.toLowerCase();if(["w","a","s","d","shift"].includes(k)){keysDown.add(k);if(k!=="shift")e.preventDefault();}});
  window.addEventListener("keyup",e=>keysDown.delete(e.key.toLowerCase()));
}
function clearWorldMeshes(){
  for(const m of blockMeshes){scene.remove(m);m.geometry.dispose();m.material.dispose();}
  blockMeshes=[];blockPickables=[];loaded.clear();
}
function buildChunkMeshes(blocks){
  // Individual block cubes, batched into InstancedMeshes by block type.
  const groups=new Map();
  for(const b of blocks){
    if(!b.name||b.name.endsWith(":air")||b.name==="air")continue;
    const name=b.name;
    if(!groups.has(name))groups.set(name,[]);
    groups.get(name).push(b);
  }
  const cube=new THREE.BoxGeometry(BLOCK_SIZE,BLOCK_SIZE,BLOCK_SIZE);
  for(const [name,list] of groups){
    const material=materialFor(name);
    const mesh=new THREE.InstancedMesh(cube,material,list.length);
    mesh.name=name;mesh.userData.blockName=name;
    const dummy=new THREE.Object3D();
    list.forEach((b,i)=>{dummy.position.set(b.x+.5,b.y+.5,b.z+.5);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);});
    mesh.instanceMatrix.needsUpdate=true;
    mesh.userData.blocks=list;
    scene.add(mesh);blockMeshes.push(mesh);blockPickables.push(mesh);
  }
}
async function loadChunk(x,z){
  const id=`${worldDimension}|${x}|${z}`;
  if(loaded.has(id))return;
  const r=await fetch(`/api/worlds/${worldId}/chunk/${x}/${z}?dimension=${encodeURIComponent(worldDimension)}`);
  if(!r.ok)return;
  const data=await r.json();buildChunkMeshes(data.blocks||[]);loaded.add(id);
}
async function loadNearby(){
  if(!worldId)return;
  $("loading").hidden=false;
  try{
    const candidates=chunkIndex.filter(c=>c.dimension===worldDimension);
    if(!candidates.length)throw new Error("No chunks indexed for this dimension.");
    let center=candidates.find(c=>c.x===0&&c.z===0)||candidates[0];
    const sorted=candidates.sort((a,b)=>(Math.abs(a.x-center.x)+Math.abs(a.z-center.z))-(Math.abs(b.x-center.x)+Math.abs(b.z-center.z)));
    // Load a compact 5x5-ish area to avoid overwhelming mobile browsers.
    const chosen=sorted.slice(0,25);
    for(const c of chosen)await loadChunk(c.x,c.z);
    const centerX=center.x*16+8,centerZ=center.z*16+8;
    controls.target.set(centerX,8,centerZ);
    camera.position.set(centerX+25,center.y??25,centerZ+32);
    $("hud").textContent=`${loaded.size} chunks loaded · ${worldDimension}`;
    $("status").textContent=`Loaded ${loaded.size} chunks. Blocks are individual selectable 3D cubes.`;
  }catch(e){$("status").textContent=e.message;}
  finally{$("loading").hidden=true;}
}
function inspectBlock(event){
  if(!blockPickables.length)return;
  const rect=renderer.domElement.getBoundingClientRect();
  mouse.x=((event.clientX-rect.left)/rect.width)*2-1;
  mouse.y=-((event.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(mouse,camera);
  const hits=raycaster.intersectObjects(blockPickables,false);
  if(!hits.length){$("inspect").style.display="none";return;}
  const hit=hits[0],mesh=hit.object,block=mesh.userData.blocks?.[hit.instanceId];
  if(!block)return;
  $("inspect").style.display="block";
  $("inspect").textContent=`${block.name}\nX ${block.x} · Y ${block.y} · Z ${block.z}`;
}
function resetCamera(){
  controls.target.set(8,8,8);camera.position.set(24,26,32);
}
async function openWorld(){
  if(!worldId)return;
  $("uploadPanel").hidden=true;$("worldPanel").hidden=false;
  const r=await fetch(`/api/worlds/${worldId}/info`);
  if(!r.ok)throw new Error("This world link is not available on this server.");
  const info=await r.json();
  $("worldName").textContent=info.name||"Bedrock world";
  $("worldStats").textContent=`${info.chunkCount} chunks · ${info.subchunkCount} subchunks`;
  $("share").textContent=location.href;
  const dims=info.dimensions||["overworld"];
  $("dimension").innerHTML=dims.map(d=>`<option value="${d}">${d}</option>`).join("");
  worldDimension=dims[0]||"overworld";
  const cr=await fetch(`/api/worlds/${worldId}/chunks?dimension=${encodeURIComponent(worldDimension)}`);
  chunkIndex=(await cr.json()).chunks||[];
  clearWorldMeshes();await loadNearby();
}
$("upload").onclick=async()=>{
  const file=$("file").files[0];if(!file){alert("Choose a .mcworld file first.");return;}
  $("upload").disabled=true;$("status").textContent="Uploading world and indexing Bedrock chunks…";$("loading").hidden=false;
  try{
    const fd=new FormData();fd.append("world",file);
    const r=await fetch("/api/worlds",{method:"POST",body:fd});const d=await r.json();
    if(!r.ok)throw new Error(d.error||"Upload failed");
    worldId=d.id;history.pushState({}, "",d.shareUrl);
    $("uploadPanel").hidden=true;$("worldPanel").hidden=false;
    $("worldName").textContent=d.name||"Bedrock world";
    $("worldStats").textContent=`${d.chunkCount} chunks · ${d.subchunkCount} subchunks`;
    $("share").textContent=location.origin+d.shareUrl;
    $("dimension").innerHTML=d.dimensions.map(x=>`<option value="${x}">${x}</option>`).join("");
    worldDimension=d.dimensions[0]||"overworld";chunkIndex=d.chunks||[];
    init();await loadNearby();
  }catch(e){$("status").textContent=e.message;alert(e.message);}
  finally{$("upload").disabled=false;$("loading").hidden=true;}
};
$("dimension").addEventListener("change",async()=>{
  worldDimension=$("dimension").value;
  const r=await fetch(`/api/worlds/${worldId}/chunks?dimension=${encodeURIComponent(worldDimension)}`);
  chunkIndex=(await r.json()).chunks||[];clearWorldMeshes();await loadNearby();
});
$("home").onclick=resetCamera;
$("nearby").onclick=async()=>{clearWorldMeshes();await loadNearby();};
if(worldId){init();openWorld().catch(e=>$("status").textContent=e.message);}
