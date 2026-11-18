import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const distDir = path.join(__dirname, 'dist');

// MIME types for static file serving
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

const server = http.createServer((req, res) => {
  // Only serve static files in production if dist directory exists
  if (!fs.existsSync(distDir)) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Sendfile signaling server running.');
    return;
  }

  let reqPath = req.url.split('?')[0];
  if (reqPath === '/' || reqPath === '' || reqPath.startsWith('/join/')) {
    reqPath = '/index.html';
  }

  const safePath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(distDir, safePath);

  // If path doesn't exist, fall back to index.html for SPA routing
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end('Server Error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000'
    });
    res.end(content);
  });
});

// WebSocket Server for WebRTC signaling only
const wss = new WebSocketServer({ server, path: '/ws' });

// In-memory room registry
// roomId -> { peers: Set<WebSocket>, createdAt: number }
const rooms = new Map();

function generateRoomId() {
  for (let i = 0; i < 20; i++) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    if (!rooms.has(code)) return code;
  }
  return String(Date.now()).slice(-6);
}

function sendJson(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

wss.on('connection', (ws) => {
  let currentRoom = null;

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString());

      switch (msg.type) {
        case 'create-room': {
          if (currentRoom && rooms.has(currentRoom)) {
            const oldRoom = rooms.get(currentRoom);
            oldRoom.peers.delete(ws);
            if (oldRoom.peers.size === 0) {
              rooms.delete(currentRoom);
            }
          }
          const roomId = generateRoomId();
          currentRoom = roomId;
          rooms.set(roomId, {
            peers: new Set([ws]),
            createdAt: Date.now()
          });
          sendJson(ws, { type: 'room-created', roomId });
          break;
        }

        case 'join-room': {
          const roomId = String(msg.roomId || '').trim();
          const room = rooms.get(roomId);

          if (!room) {
            sendJson(ws, { type: 'error', message: 'Room not found or expired' });
            return;
          }

          if (room.peers.size >= 2) {
            sendJson(ws, { type: 'error', message: 'Room is already full' });
            return;
          }

          // Leave previous auto-created room if joining another room
          if (currentRoom && currentRoom !== roomId && rooms.has(currentRoom)) {
            const oldRoom = rooms.get(currentRoom);
            oldRoom.peers.delete(ws);
            if (oldRoom.peers.size === 0) {
              rooms.delete(currentRoom);
            }
          }

          currentRoom = roomId;
          const [creator] = room.peers;
          room.peers.add(ws);

          sendJson(ws, { type: 'room-joined', roomId });
          // Notify creator that peer joined, creator will initiate WebRTC offer
          sendJson(creator, { type: 'peer-joined' });
          break;
        }

        case 'signal': {
          if (!currentRoom) return;
          const room = rooms.get(currentRoom);
          if (!room) return;

          // Forward signaling data to the other peer in the room
          for (const peer of room.peers) {
            if (peer !== ws) {
              sendJson(peer, { type: 'signal', data: msg.data });
            }
          }
          break;
        }

        default:
          break;
      }
    } catch {
      // Ignore malformed payloads
    }
  });

  const handleDisconnect = () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    room.peers.delete(ws);
    if (room.peers.size === 0) {
      rooms.delete(currentRoom);
    } else {
      // Notify remaining peer
      for (const peer of room.peers) {
        sendJson(peer, { type: 'peer-left' });
      }
    }
    currentRoom = null;
  };

  ws.on('close', handleDisconnect);
  ws.on('error', handleDisconnect);
});

// Periodic cleanup of stale empty/old rooms (> 2 hours)
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    if (room.peers.size === 0 || now - room.createdAt > 2 * 60 * 60 * 1000) {
      rooms.delete(id);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Sendfile server running on http://localhost:${PORT}`);
});
