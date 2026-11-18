/**
 * High-performance WebRTC DataChannel engine for Sendfile.
 * Handles peer connection, dual data channels (control & binary streaming),
 * flow control, chunked binary transfer, and real-time speed metrics.
 */

export const CHUNK_SIZE = 64 * 1024; // 64 KB optimal chunk size
const BUFFER_THRESHOLD = 512 * 1024; // 512 KB backpressure threshold

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

function getRtcConfig() {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ICE_SERVERS) {
    try {
      const parsed = JSON.parse(import.meta.env.VITE_ICE_SERVERS);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return { iceServers: parsed };
      }
    } catch {}
  }
  return { iceServers: DEFAULT_ICE_SERVERS };
}

export class WebRTCConnection {
  constructor({ onStateChange, onTextMessage, onTransferUpdate, onError }) {
    this.onStateChange = onStateChange;
    this.onTextMessage = onTextMessage;
    this.onTransferUpdate = onTransferUpdate;
    this.onError = onError;

    this.pc = null;
    this.controlChannel = null;
    this.transferChannel = null;
    this.ws = null;
    this.isInitiator = false;
    this.roomId = null;

    // File transfer state
    this.activeReceiving = null; // { id, name, size, mimeType, chunks, receivedBytes, lastSpeedBytes, lastSpeedTime }
    this.activeSending = null;   // { id, file, offset, cancelled }
    this.sendQueue = [];
    this.isSending = false;
    this.transfers = new Map(); // id -> transfer status object
    this.pendingCandidates = [];

    this.speedInterval = null;
  }

  /**
   * Connect to WebSocket signaling server
   */
  connectSignaling(url) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve) => {
        const onOpen = () => {
          this.ws.removeEventListener('open', onOpen);
          resolve();
        };
        this.ws.addEventListener('open', onOpen);
      });
    }

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        return reject(err);
      }

      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('Signaling connection error'));
      this.ws.onclose = () => {
        this.onStateChange('disconnected');
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleSignalingMessage(msg);
        } catch (e) {
          console.error('Failed to parse signaling message:', e);
        }
      };
    });
  }

  sendSignaling(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  createRoom() {
    this.isInitiator = true;
    this.sendSignaling({ type: 'create-room' });
  }

  joinRoom(roomId) {
    this.isInitiator = false;
    this.roomId = roomId;
    this.sendSignaling({ type: 'join-room', roomId });
  }

  async handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'room-created':
        this.roomId = msg.roomId;
        this.onStateChange('created', { roomId: msg.roomId });
        break;

      case 'room-joined':
        this.roomId = msg.roomId;
        this.onStateChange('joined', { roomId: msg.roomId });
        break;

      case 'peer-joined':
        // As initiator, create RTCPeerConnection and send offer
        this.onStateChange('connecting');
        await this.initPeerConnection(true);
        break;

      case 'signal':
        await this.handleRemoteSignal(msg.data);
        break;

      case 'peer-left':
        this.onStateChange('peer-left');
        this.cleanupPeer();
        break;

      case 'error':
        if (this.onError) this.onError(msg.message);
        break;

      default:
        break;
    }
  }

  async initPeerConnection(isInitiator) {
    this.cleanupPeer();

    this.pc = new RTCPeerConnection(getRtcConfig());

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignaling({
          type: 'signal',
          data: { type: 'candidate', candidate: event.candidate }
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === 'connected') {
        this.startSpeedTracker();
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.stopSpeedTracker();
        this.onStateChange(state);
      }
    };

    if (isInitiator) {
      // Create control channel for messages and metadata
      this.controlChannel = this.pc.createDataChannel('control', { ordered: true });
      this.setupControlChannel(this.controlChannel);

      // Create high-speed binary transfer channel
      this.transferChannel = this.pc.createDataChannel('transfer', { ordered: true });
      this.setupTransferChannel(this.transferChannel);

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.sendSignaling({
        type: 'signal',
        data: { type: 'offer', sdp: this.pc.localDescription }
      });
    } else {
      this.pc.ondatachannel = (event) => {
        const channel = event.channel;
        if (channel.label === 'control') {
          this.controlChannel = channel;
          this.setupControlChannel(channel);
        } else if (channel.label === 'transfer') {
          this.transferChannel = channel;
          this.setupTransferChannel(channel);
        }
      };
    }
  }

  async handleRemoteSignal(data) {
    if (data.type === 'offer') {
      await this.initPeerConnection(false);
      await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (this.pendingCandidates && this.pendingCandidates.length > 0) {
        for (const candidate of this.pendingCandidates) {
          try { await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
        }
        this.pendingCandidates = [];
      }
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.sendSignaling({
        type: 'signal',
        data: { type: 'answer', sdp: this.pc.localDescription }
      });
    } else if (data.type === 'answer') {
      if (this.pc && this.pc.signalingState !== 'closed') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (this.pendingCandidates && this.pendingCandidates.length > 0) {
          for (const candidate of this.pendingCandidates) {
            try { await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
          }
          this.pendingCandidates = [];
        }
      }
    } else if (data.type === 'candidate') {
      if (this.pc && this.pc.remoteDescription && this.pc.remoteDescription.type) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch {}
      } else {
        if (!this.pendingCandidates) this.pendingCandidates = [];
        this.pendingCandidates.push(data.candidate);
      }
    }
  }

  setupControlChannel(channel) {
    channel.onopen = () => {
      this.checkBothChannelsOpen();
    };

    channel.onclose = () => {
      this.onStateChange('disconnected');
    };

    channel.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleControlMessage(msg);
      } catch (err) {
        console.error('Failed to parse control message:', err);
      }
    };
  }

  setupTransferChannel(channel) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      this.checkBothChannelsOpen();
    };

    channel.onclose = () => {
      this.onStateChange('disconnected');
    };

    // Incoming raw binary chunk
    channel.onmessage = (event) => {
      this.handleIncomingChunk(event.data);
    };
  }

  checkBothChannelsOpen() {
    if (
      this.controlChannel &&
      this.controlChannel.readyState === 'open' &&
      this.transferChannel &&
      this.transferChannel.readyState === 'open'
    ) {
      this.onStateChange('connected');
    }
  }

  // --- Text Messaging ---

  sendTextMessage(text) {
    if (!this.controlChannel || this.controlChannel.readyState !== 'open') {
      throw new Error('Not connected');
    }
    const payload = {
      type: 'text',
      text,
      timestamp: Date.now()
    };
    this.controlChannel.send(JSON.stringify(payload));
  }

  // --- Control Message Protocol ---

  handleControlMessage(msg) {
    switch (msg.type) {
      case 'text':
        this.onTextMessage({ text: msg.text, sender: 'peer', timestamp: msg.timestamp });
        break;

      case 'file-start':
        this.activeReceiving = {
          id: msg.id,
          name: msg.name,
          size: msg.size,
          mimeType: msg.mimeType,
          chunks: [],
          receivedBytes: 0,
          lastSpeedBytes: 0,
          lastSpeedTime: performance.now(),
          currentSpeed: 0,
          cancelled: false
        };
        this.updateTransfer(msg.id, {
          id: msg.id,
          name: msg.name,
          size: msg.size,
          mimeType: msg.mimeType,
          progress: 0,
          speed: 0,
          status: 'receiving',
          direction: 'download',
          timestamp: Date.now()
        });
        break;

      case 'file-complete':
        if (this.activeReceiving && this.activeReceiving.id === msg.id) {
          const { chunks, mimeType, name, id, size } = this.activeReceiving;
          const blob = new Blob(chunks, { type: mimeType || 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const previewUrl =
            mimeType?.startsWith('image/') || mimeType === 'application/pdf'
              ? url
              : null;

          this.updateTransfer(id, {
            id,
            name,
            size,
            mimeType,
            progress: 100,
            speed: 0,
            status: 'completed',
            blobUrl: url,
            previewUrl,
            direction: 'download'
          });
          this.activeReceiving = null;
        }
        break;

      case 'file-cancel':
        if (this.activeReceiving && this.activeReceiving.id === msg.id) {
          this.updateTransfer(msg.id, {
            status: 'cancelled',
            speed: 0
          });
          this.activeReceiving = null;
        }
        break;

      default:
        break;
    }
  }

  // --- Binary Chunk Handling ---

  handleIncomingChunk(arrayBuffer) {
    if (!this.activeReceiving || this.activeReceiving.cancelled) return;

    this.activeReceiving.chunks.push(arrayBuffer);
    this.activeReceiving.receivedBytes += arrayBuffer.byteLength;

    const progress = Math.min(
      99,
      Math.round((this.activeReceiving.receivedBytes / this.activeReceiving.size) * 100)
    );

    // Throttled update through activeReceiving state; speed tracker will push progress to UI
    this.activeReceiving.lastProgress = progress;
  }

  // --- File Sending with Flow Control ---

  enqueueFiles(files) {
    for (const file of files) {
      const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const previewUrl =
        file.type.startsWith('image/') || file.type === 'application/pdf'
          ? URL.createObjectURL(file)
          : null;

      const transferItem = {
        id,
        name: file.name,
        size: file.size,
        mimeType: file.type,
        progress: 0,
        speed: 0,
        status: 'queued',
        direction: 'upload',
        timestamp: Date.now(),
        previewUrl
      };

      this.transfers.set(id, transferItem);
      this.sendQueue.push({ id, file });
    }

    this.emitTransfers();

    if (!this.isSending) {
      this.processSendQueue();
    }
  }

  async processSendQueue() {
    if (this.sendQueue.length === 0) {
      this.isSending = false;
      return;
    }

    this.isSending = true;
    const { id, file } = this.sendQueue.shift();
    const transfer = this.transfers.get(id);

    if (!transfer || transfer.status === 'cancelled') {
      return this.processSendQueue();
    }

    this.activeSending = {
      id,
      file,
      sentBytes: 0,
      lastSpeedBytes: 0,
      lastSpeedTime: performance.now(),
      cancelled: false
    };

    this.updateTransfer(id, { status: 'sending', progress: 0 });

    // Announce file metadata over control channel
    this.controlChannel.send(
      JSON.stringify({
        type: 'file-start',
        id,
        name: file.name,
        size: file.size,
        mimeType: file.type
      })
    );

    const channel = this.transferChannel;
    channel.bufferedAmountLowThreshold = BUFFER_THRESHOLD;

    let offset = 0;

    try {
      while (offset < file.size) {
        if (this.activeSending.cancelled) {
          this.controlChannel.send(JSON.stringify({ type: 'file-cancel', id }));
          break;
        }

        // Proper Flow Control: pause until buffered amount is low
        if (channel.bufferedAmount > BUFFER_THRESHOLD) {
          await new Promise((resolve) => {
            const onLow = () => {
              channel.removeEventListener('bufferedamountlow', onLow);
              resolve();
            };
            channel.addEventListener('bufferedamountlow', onLow);
          });
        }

        // Stream slice from disk without loading full file into memory
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await slice.arrayBuffer();

        channel.send(buffer);

        offset += buffer.byteLength;
        this.activeSending.sentBytes = offset;
        this.activeSending.lastProgress = Math.min(
          99,
          Math.round((offset / file.size) * 100)
        );
      }

      if (!this.activeSending.cancelled) {
        // Send file-complete after last bytes clear
        if (channel.bufferedAmount > 0) {
          await new Promise((resolve) => {
            const onDrained = () => {
              if (channel.bufferedAmount === 0) {
                channel.removeEventListener('bufferedamountlow', onDrained);
                resolve();
              }
            };
            channel.addEventListener('bufferedamountlow', onDrained);
            setTimeout(resolve, 200);
          });
        }

        this.controlChannel.send(JSON.stringify({ type: 'file-complete', id }));
        this.updateTransfer(id, { status: 'completed', progress: 100, speed: 0 });
      }
    } catch (err) {
      console.error('File send error:', err);
      this.updateTransfer(id, { status: 'failed', speed: 0 });
    }

    this.activeSending = null;
    this.processSendQueue();
  }

  cancelTransfer(id) {
    const item = this.transfers.get(id);
    if (!item) return;

    if (item.status === 'queued') {
      this.sendQueue = this.sendQueue.filter((q) => q.id !== id);
      this.updateTransfer(id, { status: 'cancelled', speed: 0 });
      return;
    }

    if (this.activeSending && this.activeSending.id === id) {
      this.activeSending.cancelled = true;
      this.updateTransfer(id, { status: 'cancelled', speed: 0 });
    }

    if (this.activeReceiving && this.activeReceiving.id === id) {
      this.activeReceiving.cancelled = true;
      if (this.controlChannel && this.controlChannel.readyState === 'open') {
        this.controlChannel.send(JSON.stringify({ type: 'file-cancel', id }));
      }
      this.updateTransfer(id, { status: 'cancelled', speed: 0 });
      this.activeReceiving = null;
    }
  }

  // --- Real Speed Tracker (calculated from bytes / elapsed time) ---

  startSpeedTracker() {
    this.stopSpeedTracker();
    this.speedInterval = setInterval(() => {
      const now = performance.now();
      let changed = false;

      // Track active send speed
      if (this.activeSending && !this.activeSending.cancelled) {
        const dt = (now - this.activeSending.lastSpeedTime) / 1000;
        if (dt > 0.2) {
          const db = this.activeSending.sentBytes - this.activeSending.lastSpeedBytes;
          const speedMBps = db / (1024 * 1024) / dt;
          this.activeSending.lastSpeedBytes = this.activeSending.sentBytes;
          this.activeSending.lastSpeedTime = now;

          const item = this.transfers.get(this.activeSending.id);
          if (item && item.status === 'sending') {
            item.progress = this.activeSending.lastProgress || item.progress;
            item.speed = Math.max(0, speedMBps);
            changed = true;
          }
        }
      }

      // Track active receive speed
      if (this.activeReceiving && !this.activeReceiving.cancelled) {
        const dt = (now - this.activeReceiving.lastSpeedTime) / 1000;
        if (dt > 0.2) {
          const db = this.activeReceiving.receivedBytes - this.activeReceiving.lastSpeedBytes;
          const speedMBps = db / (1024 * 1024) / dt;
          this.activeReceiving.lastSpeedBytes = this.activeReceiving.receivedBytes;
          this.activeReceiving.lastSpeedTime = now;

          const item = this.transfers.get(this.activeReceiving.id);
          if (item && item.status === 'receiving') {
            item.progress = this.activeReceiving.lastProgress || item.progress;
            item.speed = Math.max(0, speedMBps);
            changed = true;
          }
        }
      }

      if (changed) {
        this.emitTransfers();
      }
    }, 250); // 4Hz throttled UI update
  }

  stopSpeedTracker() {
    if (this.speedInterval) {
      clearInterval(this.speedInterval);
      this.speedInterval = null;
    }
  }

  emitTransfers() {
    // Sort transfers with the most recently added file at the TOP (timestamp descending)
    const list = Array.from(this.transfers.values()).sort(
      (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
    );
    this.onTransferUpdate(list);
  }

  updateTransfer(id, updates) {
    const existing = this.transfers.get(id) || {};
    const updated = { ...existing, ...updates };
    this.transfers.set(id, updated);
    this.emitTransfers();
  }

  cleanupPeer() {
    this.pendingCandidates = [];
    if (this.controlChannel) {
      try { this.controlChannel.close(); } catch {}
      this.controlChannel = null;
    }
    if (this.transferChannel) {
      try { this.transferChannel.close(); } catch {}
      this.transferChannel = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch {}
      this.pc = null;
    }
    this.stopSpeedTracker();
  }

  disconnect() {
    this.cleanupPeer();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}
