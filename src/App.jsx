import React, { useState, useEffect, useRef, useCallback } from 'react';
import { WebRTCConnection } from './lib/webrtc.js';
import { QRCodeCanvas } from './components/QRCodeCanvas.jsx';
import { QRScanner } from './components/QRScanner.jsx';
import { formatBytes, formatSpeed } from './lib/format.js';

function getWebSocketUrl() {
  const envUrl = import.meta.env.VITE_SIGNALING_URL;
  if (envUrl && typeof envUrl === 'string' && envUrl.trim()) {
    let clean = envUrl.trim();
    if (clean.startsWith('https://')) {
      clean = clean.replace(/^https:\/\//, 'wss://');
    } else if (clean.startsWith('http://')) {
      clean = clean.replace(/^http:\/\//, 'ws://');
    }
    return clean;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (window.location.port === '5173') {
    return `${protocol}//${window.location.hostname}:3000/ws`;
  }
  return `${protocol}//${window.location.host}/ws`;
}

export default function App() {
  // Views: 'ready' (auto-created room with code & QR) | 'scanner' | 'connected'
  const [view, setView] = useState('ready');
  const [roomId, setRoomId] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('disconnected'); // 'disconnected' | 'connecting' | 'connected' | 'peer-left'
  const [errorMsg, setErrorMsg] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedText, setCopiedText] = useState(false);

  // Live synchronized shared text
  const [sharedText, setSharedText] = useState('');
  const textDebounceTimerRef = useRef(null);
  const lastSentTextRef = useRef('');
  const lastReceivedTextRef = useRef('');

  // File transfers state
  const [transfers, setTransfers] = useState([]);
  const [dragActive, setDragActive] = useState(false);

  const webrtcRef = useRef(null);
  const fileInputRef = useRef(null);

  // Initialize WebRTC instance
  const getWebRTC = useCallback(() => {
    if (!webrtcRef.current) {
      webrtcRef.current = new WebRTCConnection({
        onStateChange: (state, meta) => {
          if (state === 'created' || state === 'joined') {
            setRoomId(meta.roomId);
          } else if (state === 'connecting') {
            setConnectionStatus('connecting');
          } else if (state === 'connected') {
            setConnectionStatus('connected');
            setView('connected');
            setErrorMsg('');
          } else if (state === 'peer-left') {
            setConnectionStatus('peer-left');
            setErrorMsg('Peer disconnected');
          } else if (state === 'disconnected' || state === 'failed') {
            setConnectionStatus('disconnected');
          }
        },
        onTextMessage: (item) => {
          // Live text received from peer
          const received = item.text ?? '';
          lastReceivedTextRef.current = received;
          lastSentTextRef.current = received;
          setSharedText(received);
        },
        onTransferUpdate: (updatedTransfers) => {
          setTransfers([...updatedTransfers]);
        },
        onError: (err) => {
          setErrorMsg(err);
          setConnectionStatus('disconnected');
        }
      });
    }
    return webrtcRef.current;
  }, []);

  // Check URL on load for join link (/join/482731 or ?room=482731)
  useEffect(() => {
    const pathname = window.location.pathname;
    const joinMatch = pathname.match(/\/join\/(\d{6})/i);
    const searchParams = new URLSearchParams(window.location.search);
    const queryRoom = searchParams.get('room');
    const hashMatch = window.location.hash.match(/(?:join\/|room=)?(\d{6})/);

    const targetRoom =
      joinMatch?.[1] ||
      (queryRoom && /^\d{6}$/.test(queryRoom) ? queryRoom : null) ||
      hashMatch?.[1];

    if (targetRoom) {
      // Automatically join the room specified in the URL
      handleJoinRoom(targetRoom);
      window.history.replaceState({}, document.title, '/');
    } else {
      // Automatically create a room immediately on app open
      handleAutoCreateRoom();
    }
  }, []);

  const handleAutoCreateRoom = async () => {
    setErrorMsg('');
    const client = getWebRTC();
    try {
      await client.connectSignaling(getWebSocketUrl());
      client.createRoom();
      setView('ready');
    } catch {
      setErrorMsg('Unable to connect to signaling server');
    }
  };

  const handleJoinRoom = async (codeToJoin) => {
    const code = String(codeToJoin || '').trim();
    if (!/^\d{6}$/.test(code)) {
      setErrorMsg('Invalid 6-digit code');
      return;
    }
    setErrorMsg('');
    const client = getWebRTC();
    try {
      await client.connectSignaling(getWebSocketUrl());
      client.joinRoom(code);
      setConnectionStatus('connecting');
      setView('ready');
    } catch {
      setErrorMsg('Unable to connect to signaling server');
    }
  };

  const handleDisconnect = () => {
    if (webrtcRef.current) {
      webrtcRef.current.disconnect();
      webrtcRef.current = null;
    }
    setRoomId('');
    setConnectionStatus('disconnected');
    setTransfers([]);
    setSharedText('');
    lastSentTextRef.current = '';
    lastReceivedTextRef.current = '';
    // Re-create a fresh room immediately
    handleAutoCreateRoom();
  };

  // --- Live Debounced Text Sync ---
  const handleTextChange = (e) => {
    const nextText = e.target.value;
    setSharedText(nextText);

    if (textDebounceTimerRef.current) {
      clearTimeout(textDebounceTimerRef.current);
    }

    textDebounceTimerRef.current = setTimeout(() => {
      if (
        nextText !== lastSentTextRef.current &&
        nextText !== lastReceivedTextRef.current &&
        webrtcRef.current &&
        connectionStatus === 'connected'
      ) {
        lastSentTextRef.current = nextText;
        try {
          webrtcRef.current.sendTextMessage(nextText);
        } catch {
          // Channel might be busy or closed
        }
      }
    }, 200); // 200ms debounce
  };

  const handleCopyText = () => {
    if (!sharedText) return;
    navigator.clipboard.writeText(sharedText);
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 1500);
  };

  const handleClearText = () => {
    setSharedText('');
    lastSentTextRef.current = '';
    lastReceivedTextRef.current = '';
    if (webrtcRef.current && connectionStatus === 'connected') {
      try {
        webrtcRef.current.sendTextMessage('');
      } catch {}
    }
  };

  const copyRoomCode = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  // --- File Selection & Drag-and-Drop ---
  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0 && webrtcRef.current) {
      webrtcRef.current.enqueueFiles(files);
      e.target.value = '';
    }
  };

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0 && webrtcRef.current) {
      const files = Array.from(e.dataTransfer.files);
      webrtcRef.current.enqueueFiles(files);
    }
  };

  const handleCancelTransfer = (id) => {
    if (webrtcRef.current) {
      webrtcRef.current.cancelTransfer(id);
    }
  };

  return (
    <main className="app-shell">
      {/* Error Banner */}
      {errorMsg && (
        <div className="error-banner">
          <span>{errorMsg}</span>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => setErrorMsg('')}
          >
            ✕
          </button>
        </div>
      )}

      {/* 1. FIRST SCREEN: AUTOMATIC ROOM (6-digit code, QR, [Scan QR]) */}
      {view === 'ready' && (
        <section className="home-screen" style={{ gap: 20 }}>
          {/* 6-Digit Code */}
          <div
            className="code-digits"
            onClick={copyRoomCode}
            title="Click to copy code"
          >
            {roomId || '------'}
          </div>
          {copiedCode && (
            <span className="text-xs" style={{ color: 'var(--primary)', marginTop: -12 }}>
              Code copied!
            </span>
          )}

          {/* QR Code with Join URL */}
          {roomId ? (
            <QRCodeCanvas
              text={`${window.location.origin}/join/${roomId}`}
              size={180}
            />
          ) : (
            <div
              className="qr-canvas-wrap"
              style={{ width: 180, height: 180, margin: '0 auto' }}
            />
          )}

          {/* Scan QR Button */}
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%', maxWidth: 220, margin: '0 auto' }}
            onClick={() => {
              setErrorMsg('');
              setView('scanner');
            }}
          >
            Scan QR
          </button>

          {connectionStatus === 'connecting' && (
            <div className="status-pill" style={{ margin: '0 auto' }}>
              <span className="dot pulse" />
              <span>Connecting to peer...</span>
            </div>
          )}
        </section>
      )}

      {/* 2. SCAN QR SCREEN (Camera Scanner + Manual Code fallback) */}
      {view === 'scanner' && (
        <QRScanner
          onScan={(code) => handleJoinRoom(code)}
          onCancel={() => setView('ready')}
        />
      )}

      {/* 3. CONNECTED / TRANSFER SCREEN */}
      {view === 'connected' && (
        <section className="view-container" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Header Bar */}
          <header className="header-bar">
            <div className="status-pill">
              <span className="dot connected" />
              <span>Connected</span>
              {roomId && <span className="text-muted">({roomId})</span>}
            </div>

            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={handleDisconnect}
            >
              Disconnect
            </button>
          </header>

          {/* Live Synchronized Comment-Box Style Text Sharing */}
          <section className="scratchpad">
            <textarea
              className="live-textarea"
              placeholder="Type anything here..."
              value={sharedText}
              onChange={handleTextChange}
            />
            <div className="scratchpad-actions">
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={handleCopyText}
                disabled={!sharedText}
              >
                {copiedText ? 'Copied!' : 'Copy'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={handleClearText}
                disabled={!sharedText}
              >
                Clear
              </button>
            </div>
          </section>

          {/* File Picker & Drag-and-Drop Dropzone */}
          <input
            type="file"
            multiple
            ref={fileInputRef}
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />

          <div
            className={`dropzone ${dragActive ? 'drag-active' : ''}`}
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
          >
            <svg
              className="dropzone-icon"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            <span className="dropzone-label">Select or drop files</span>
            <span className="dropzone-sub">Supports any file format</span>
          </div>

          {/* Transfer List */}
          {transfers.length > 0 && (
            <section className="transfer-section">
              <div className="transfer-header">
                <span>Transfers</span>
                <span className="text-xs">
                  {transfers.length} file{transfers.length > 1 ? 's' : ''}
                </span>
              </div>

              <div className="transfer-list">
                {transfers.map((item) => (
                  <div key={item.id} className="transfer-card">
                    <div className="transfer-top">
                      <div className="file-info">
                        <span className="file-name" title={item.name}>
                          {item.name}
                        </span>
                        <div className="file-meta">
                          <span>{formatBytes(item.size)}</span>
                          <span>•</span>
                          <span>{item.progress}%</span>
                          {item.speed > 0 && (
                            <>
                              <span>•</span>
                              <span className="file-speed">
                                {formatSpeed(item.speed)}
                              </span>
                            </>
                          )}
                          <span>•</span>
                          <span style={{ textTransform: 'capitalize' }}>
                            {item.status}
                          </span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div>
                        {(item.status === 'sending' ||
                          item.status === 'receiving' ||
                          item.status === 'queued') && (
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={() => handleCancelTransfer(item.id)}
                          >
                            Cancel
                          </button>
                        )}
                        {item.status === 'completed' && item.blobUrl && (
                          <a
                            href={item.blobUrl}
                            download={item.name}
                            className="btn btn-sm btn-primary"
                            style={{ textDecoration: 'none' }}
                          >
                            Save
                          </a>
                        )}
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="progress-container">
                      <div
                        className={`progress-bar ${item.status}`}
                        style={{ width: `${item.progress}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </section>
      )}
    </main>
  );
}
