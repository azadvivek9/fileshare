# FileShare

Peer-to-peer file sharing and live text scratchpad application for mobile and desktop browsers.

## Overview

FileShare enables direct device-to-device transfers over WebRTC DataChannels. The signaling server is solely responsible for exchanging session descriptions (SDP) and ICE candidates; transferred files and live text messages travel directly between connected peers and are never sent to or stored on any server.

## Features

- **Direct P2P DataChannel Transfers**: End-to-end binary streaming using ArrayBuffer chunks.
- **Dynamic Flow Control**: Monitored backpressure using buffer thresholds to prevent memory exhaustion and browser stalls.
- **6-Digit Room Pairing & QR Code**: Instant automatic room creation with scannable join URLs.
- **Built-In QR Scanner**: In-app camera scanner powered by jsqr with manual 6-digit fallback.
- **Live Text Synchronization**: Shared text area with debounced peer synchronization.
- **Progress & Metrics**: Real-time throughput calculations in MB/s derived directly from transferred bytes.
- **PWA Ready**: Offline-capable application shell, installable manifest, and service worker.

## Tech Stack

- **Frontend**: React, Vite
- **Transport**: WebRTC RTCDataChannel (`binaryType = 'arraybuffer'`)
- **Signaling**: Node.js WebSocket (`ws`)
- **QR Utilities**: qrcode (generation), jsqr (detection)

## Environment Variables

Copy `.env.example` to `.env` if custom configuration is needed:

| Variable | Description | Default |
| --- | --- | --- |
| `VITE_SIGNALING_URL` | WebSocket signaling endpoint | `wss://<host>/ws` (or `ws://localhost:3000/ws` in dev) |
| `VITE_ICE_SERVERS` | JSON array of STUN/TURN servers | Google public STUN servers |
| `PORT` | Node.js signaling server port | `3000` |

## Local Development

```bash
# Install dependencies
npm install

# Start signaling server (Terminal 1)
npm run server

# Start Vite development server (Terminal 2)
npm run dev
```

## Production Deployment

### Option A: Unified Container / VPS (Render, Railway, Fly.io, Heroku)

The Node.js server serves both the built static assets from `dist/` and the WebSocket endpoint on `/ws`:

```bash
npm run build
npm start
```

### Option B: Decoupled Hosting (Vercel / Netlify + Node Server)

1. Deploy `server.js` on a Node-capable host (e.g. Render, Railway).
2. Set `VITE_SIGNALING_URL=wss://your-signaling-service.com/ws` in your static host environment.
3. Build and deploy frontend: `npm run build`.

## Security & Architecture Note

- File data and live text messages travel strictly peer-to-peer via encrypted WebRTC DataChannels.
- The WebSocket server does not store, inspect, relay, or cache any file payloads.
