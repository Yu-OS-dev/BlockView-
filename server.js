import express from "express";
import multer from "multer";
import unzipper from "unzipper";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { LevelDB } from "@8crafter/leveldb-zlib";
import {
  entryContentTypeToFormatMap,
  getContentTypeFromDBKey,
  getChunkKeyIndices,
  chunkBlockIndexToOffset
} from "mcbe-leveldb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 5000);
const STORAGE = path.resolve(process.env.WORLD_STORAGE || "./worlds");
fs.mkdirSync(STORAGE,{recursive:true});
app.use(express.static(path.join(__dirname,"public")));
const upload = multer({dest:os.tmpdir(),limits:{fileSize:250*1024*1024}});
const worlds = new Map();

function isInside(parent, child) {
  const rel=path.relative(parent,child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
async function extractZipSafely(zipPath,dest) {
  const directory=await unzipper.Open.file(zipPath);
  for(const entry of directory.files) {
    const name=entry.path.replaceAll("\\","/");
    if(name.startsWith("/") || name.split("/").includes("..")) throw new Error("Unsafe path in world archive.");
    const target=path.resolve(dest,name);
    if(!isInside(dest,target)) throw new Error("Unsafe path in world archive.");
    if(entry.type==="Directory"){fs.mkdirSync(target,{recursive:true});continue;}
    fs.mkdirSync(path.dirname(target),{recursive:true});
    await pipeline(entry.stream(),fs.createWriteStream(target,{flags:"wx"}));
  }
}
function findWorldDir(folder) {
  const stack=[folder];
  while(stack.length) {
    const dir=stack.pop();
    const entries=fs.readdirSync(dir,{withFileTypes:true});
    const names=new Set(entries.map(e=>e.name));
    if(names.has("level.dat") && names.has("db") && fs.statSync(path.join(dir,"db")).isDirectory()) return dir;
    for(const e of entries) if(e.isDirectory()) stack.push(path.join(dir,e.name));
  }
  throw new Error("This does not look like a Bedrock world: level.dat and db/ were not found.");
}
function tagValue(tag) {
  if(tag == null) return undefined;
  if(typeof tag !== "object") return tag;
  if("value" in tag) return tag.value;
  return tag;
}
function blockFromPaletteTag(tag) {
  const root=tag?.value ?? tag ?? {};
  const name=tagValue(root.name);
  const states=tagValue(root.states) ?? {};
  return {name:typeof name==="string" ? name : "minecraft:unknown",states};
}
function dimensionName(v) {
  if(typeof v==="string") return v;
  if(v===1) return "nether";
  if(v===2) return "the_end";
  return "overworld";
}
function parseSubchunk(raw) {
  const parser=entryContentTypeToFormatMap.SubChunkPrefix;
  return parser.parse(raw);
}
function decodeSubchunk(parsed, chunkX, chunkZ, subY) {
  const root=parsed?.value ?? {};
  const version=Number(tagValue(root.version) ?? 0);
  const blocks=[];
  if(version<=7) {
    // Legacy pre-palette subchunks store numeric block IDs and metadata.
    const ids=tagValue(root.block_ids) ?? [];
    const data=tagValue(root.block_data) ?? [];
    for(let i=0;i<Math.min(ids.length,4096);i++) {
      const id=Number(ids[i]);
      if(!id) continue;
      const off=chunkBlockIndexToOffset(i);
      blocks.push({
        x:chunkX*16+off.x,y:subY*16+off.y,z:chunkZ*16+off.z,
        name:`legacy:block_${id}`,legacyId:id,meta:Number(data[i]??0)
      });
    }
    return blocks;
  }
  const layers=tagValue(root.layers)?.value ?? [];
  if(!Array.isArray(layers)) return blocks;
  // Layer 0 is the primary block layer. Further layers can contain waterlogging;
  // render non-air secondary blocks only when the primary cell is air.
  const decodedLayers=layers.map(layer=>{
    const lv=layer?.value ?? {};
    const paletteCompound=tagValue(lv.palette)?.value ?? {};
    const palette=Object.keys(paletteCompound).sort((a,b)=>Number(a)-Number(b)).map(k=>blockFromPaletteTag(paletteCompound[k]));
    const indices=tagValue(lv.block_indices)?.value ?? [];
    return {palette,indices};
  });
  for(let i=0;i<4096;i++) {
    let selected=null;
    for(const layer of decodedLayers) {
      const idx=Number(layer.indices[i]??0);
      const candidate=layer.palette[idx];
      if(candidate && candidate.name!=="minecraft:air" && candidate.name!=="air") {selected=candidate;break;}
    }
    if(!selected) continue;
    const off=chunkBlockIndexToOffset(i);
    blocks.push({
      x:chunkX*16+off.x,y:subY*16+off.y,z:chunkZ*16+off.z,
      name:selected.name,states:selected.states
    });
  }
  return blocks;
}
async function indexWorld(worldDir) {
  const db=new LevelDB(path.join(worldDir,"db"));
  await db.open();
  const chunkKeys=new Map();
  let scanned=0,subchunks=0;
  try {
    for await (const [rawKey] of db.getIterator({keyAsBuffer:true,valueAsBuffer:true,keys:true,values:false})) {
      scanned++;
      let type;
      try { type=getContentTypeFromDBKey(rawKey); } catch { continue; }
      if(type!=="SubChunkPrefix") continue;
      let ix;
      try { ix=getChunkKeyIndices(rawKey); } catch { continue; }
      if(!Number.isInteger(ix.subChunkIndex)) continue;
      const dim=dimensionName(ix.dimension);
      const key=`${dim}|${ix.x}|${ix.z}`;
      if(!chunkKeys.has(key)) chunkKeys.set(key,{dimension:dim,x:ix.x,z:ix.z,subchunks:[]});
      chunkKeys.get(key).subchunks.push({y:ix.subChunkIndex,key:rawKey.toString("hex")});
      subchunks++;
    }
  } catch(e) {
    await db.close?.();
    throw e;
  }
  const chunks=[...chunkKeys.values()].map(c=>({...c,subchunks:c.subchunks.sort((a,b)=>a.y-b.y)}));
  return {db,chunks,scanned,subchunks};
}
app.post("/api/worlds",upload.single("world"),async(req,res)=>{
  if(!req.file) return res.status(400).json({error:"Choose a .mcworld file."});
  if(!req.file.originalname.toLowerCase().endsWith(".mcworld")) {
    fs.rmSync(req.file.path,{force:true});
    return res.status(400).json({error:"Please upload a .mcworld export."});
  }
  const id=crypto.randomBytes(8).toString("hex");
  const root=path.join(STORAGE,id),unpacked=path.join(root,"upload");
  try {
    fs.mkdirSync(unpacked,{recursive:true});
    await extractZipSafely(req.file.path,unpacked);
    const worldDir=findWorldDir(unpacked);
    const indexed=await indexWorld(worldDir);
    const record={...indexed,name:path.basename(worldDir),root,created:Date.now()};
    worlds.set(id,record);
    fs.writeFileSync(path.join(root,"world-path.txt"),worldDir);
    res.json({
      id,name:record.name,shareUrl:`/w/${id}`,
      dimensions:[...new Set(record.chunks.map(c=>c.dimension))],
      chunkCount:record.chunks.length,subchunkCount:record.subchunks,
      scannedKeys:record.scanned,
      chunks:record.chunks.map(({dimension,x,z})=>({dimension,x,z}))
    });
  } catch(e) {
    fs.rmSync(root,{recursive:true,force:true});
    res.status(400).json({error:`Could not index this Bedrock world: ${String(e.message).slice(0,240)}`});
  } finally {
    fs.rmSync(req.file.path,{force:true});
  }
});
function getWorld(id) {
  if(!/^[a-f0-9]{16}$/.test(id)) return null;
  return worlds.get(id) ?? null;
}
app.get("/w/:id",(req,res)=>{
  if(!getWorld(req.params.id)) return res.sendStatus(404);
  res.sendFile(path.join(__dirname,"public","index.html"));
});
app.get("/api/worlds/:id/info",(req,res)=>{
  const w=getWorld(req.params.id);if(!w)return res.sendStatus(404);
  res.json({id:req.params.id,name:w.name,dimensions:[...new Set(w.chunks.map(c=>c.dimension))],chunkCount:w.chunks.length,subchunkCount:w.subchunks});
});
app.get("/api/worlds/:id/chunks",(req,res)=>{
  const w=getWorld(req.params.id);if(!w)return res.sendStatus(404);
  const dimension=String(req.query.dimension||"overworld");
  const chunks=w.chunks.filter(c=>c.dimension===dimension).map(({x,z})=>({x,z}));
  res.json({chunks});
});
app.get("/api/worlds/:id/chunk/:x/:z",(req,res)=>{
  const w=getWorld(req.params.id);if(!w)return res.sendStatus(404);
  const x=Number(req.params.x),z=Number(req.params.z),dimension=String(req.query.dimension||"overworld");
  if(!Number.isSafeInteger(x)||!Number.isSafeInteger(z))return res.status(400).json({error:"Invalid chunk coordinates."});
  const chunk=w.chunks.find(c=>c.x===x&&c.z===z&&c.dimension===dimension);
  if(!chunk)return res.status(404).json({error:"Chunk not found."});
  res.setHeader("Cache-Control","public, max-age=3600");
  (async()=>{
    const blocks=[];
    for(const sub of chunk.subchunks) {
      const raw=await w.db.get(Buffer.from(sub.key,"hex"),{asBuffer:true});
      if(!raw)continue;
      try {
        const parsed=await parseSubchunk(raw);
        blocks.push(...decodeSubchunk(parsed,x,z,sub.y));
      } catch(err) {
        console.warn("Subchunk parse skipped",x,z,sub.y,err.message);
      }
    }
    res.json({x,z,dimension,blocks});
  })().catch(e=>{if(!res.headersSent)res.status(500).json({error:e.message});});
});
app.get("/health",(req,res)=>res.json({ok:true,version:"0.3.0",engine:"node"}));
async function restoreStoredWorlds() {
  for (const entry of fs.readdirSync(STORAGE,{withFileTypes:true})) {
    if (!entry.isDirectory() || !/^[a-f0-9]{16}$/.test(entry.name)) continue;
    const root=path.join(STORAGE,entry.name);
    const marker=path.join(root,"world-path.txt");
    if (!fs.existsSync(marker)) continue;
    const worldDir=fs.readFileSync(marker,"utf8");
    if (!fs.existsSync(path.join(worldDir,"db"))) continue;
    try {
      const indexed=await indexWorld(worldDir);
      worlds.set(entry.name,{...indexed,name:path.basename(worldDir),root,created:Date.now()});
      console.log(`Restored world ${entry.name}: ${indexed.chunks.length} chunks`);
    } catch (e) {
      console.warn(`Could not restore world ${entry.name}: ${e.message}`);
    }
  }
}

await restoreStoredWorlds();
app.listen(PORT,"0.0.0.0",()=>console.log(`Blockview v0.3 listening on ${PORT}`));
