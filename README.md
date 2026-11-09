# Blockview v0.3 — Render-ready Bedrock 3D world viewer

Blockview is a Node.js web app for uploading Minecraft Bedrock `.mcworld` exports and viewing indexed chunks in a browser.

## Deploy on Render

1. Put the contents of this folder in a GitHub repository.
2. In Render, choose **New → Blueprint** and connect that repository.
3. Render will detect `render.yaml`. Review the service and create it.
4. The Blueprint uses a Starter web service and a 10 GB persistent disk mounted at `/var/data`. A persistent disk requires a paid Render service; the free web service does not provide persistent storage.
5. When deployment finishes, open the `onrender.com` URL. Upload a `.mcworld` file and share the generated world URL.

The configuration sets `PORT` through Render's environment automatically; the app listens on `0.0.0.0`, exposes `/health` for health checks, and stores uploaded worlds under `/var/data/worlds`.

### Manual setup (if not using the Blueprint)

Create a **Node** Web Service with:
- Build command: `npm install`
- Start command: `npm start`
- Node version: 20 or newer
- Health check path: `/health`
- Persistent disk mount path: `/var/data`
- Environment variable: `WORLD_STORAGE=/var/data/worlds`
- Environment variable: `NODE_ENV=production`

Do not use an ephemeral filesystem for worlds you want to keep. Without the persistent disk, uploaded worlds can disappear when the service restarts or redeploys.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm start
```

Open `http://localhost:5000`.

## What it currently does

- Extracts `.mcworld` ZIP archives with path traversal checks.
- Opens Bedrock LevelDB and indexes subchunk records.
- Parses supported modern palette-based subchunks and has a limited legacy fallback.
- Renders block positions as batched Three.js cubes.
- Provides orbit/zoom/pan, WASD movement, block inspection, dimension selection, and share URLs.
- Re-indexes worlds found on the persistent disk when the server starts.

## Current limitations

- Block colors are approximations, not the original Minecraft texture atlas.
- It loads up to 25 chunks nearest the origin (or the first available chunk), not the entire world.
- Complex block shapes, lighting, biome tinting, entities, signs, inventories, and block entities are not rendered.
- Some Bedrock palette variants and custom palettes may not be supported.
- The Bedrock database parsing path has not yet been validated against a broad collection of real-world exports. Test with a copy of a world first.
- This is an MVP, not a hardened public file-hosting service. Before making it broadly public, add authentication, upload quotas, automatic expiry, rate limiting, and abuse controls. Only share worlds you have permission to share.

## Architecture

`.mcworld` upload → safe extraction → Bedrock LevelDB → chunk/subchunk indexing and decoding → Three.js block viewer.
