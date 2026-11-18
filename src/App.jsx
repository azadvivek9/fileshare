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

function FilePreview({ item, mode = 'list' }) {
  const isImage =
    item.mimeType?.startsWith('image/') ||
    /\.(jpe?g|png|gif|webp|svg|bmp)$/i.test(item.name);
  const isPdf =
    item.mimeType === 'application/pdf' || /\.pdf$/i.test(item.name);
  const isVideo =
    item.mimeType?.startsWith('video/') ||
    /\.(mp4|mov|webm|mkv|avi)$/i.test(item.name);
  const isAudio =
    item.mimeType?.startsWith('audio/') ||
    /\.(mp3|wav|ogg|m4a|flac)$/i.test(item.name);
  const isZip =
    item.mimeType?.includes('zip') ||
    item.mimeType?.includes('compressed') ||
    /\.(zip|rar|7z|tar|gz)$/i.test(item.name);

  const previewSource = item.blobUrl || item.previewUrl;

  if (isImage && previewSource) {
    return (
      <img
        src={previewSource}
        alt={item.name}
        className={mode === 'grid' ? 'grid-file-thumb' : 'list-file-thumb'}
      />
    );
  }

  if (isPdf) {
    return (
      <div className={`file-badge file-badge-pdf ${mode === 'grid' ? 'grid-badge' : 'list-badge'}`}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
          <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9.5 8.5h-2v1h2c.28 0 .5-.22.5-.5s-.22-.5-.5-.5zm5 0h-1.5v3H14v-1h.5c.28 0 .5-.22.5-.5v-1c0-.28-.22-.5-.5-.5zm-8-3H5v5h1.5v-1.5h1c.55 0 1-.45 1-1v-1.5c0-.55-.45-1-1-1zm4.5 0h-2.5v5H10c.55 0 1-.45 1-1v-3c0-.55-.45-1-1-1zm6 0h-3v5h1.5v-1.5h1.5v-1h-1.5V10h1.5V8.5z"/>
        </svg>
        <span className="file-badge-text">PDF</span>
      </div>
    );
  }

  let badgeColor = '#6b7280';
  let badgeLabel = 'FILE';
  if (isVideo) {
    badgeColor = '#8b5cf6';
    badgeLabel = 'VID';
  } else if (isAudio) {
    badgeColor = '#ec4899';
    badgeLabel = 'AUD';
  } else if (isZip) {
    badgeColor = '#f59e0b';
    badgeLabel = 'ZIP';
  }

  return (
    <div
      className={`file-badge ${mode === 'grid' ? 'grid-badge' : 'list-badge'}`}
      style={{ backgroundColor: `${badgeColor}15`, color: badgeColor }}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <span className="file-badge-text">{badgeLabel}</span>
    </div>
  );
}

export default function App() {
  // Views: 'home' (first screen with tab switcher) | 'connected'
  const [view, setView] = useState('home');
  const [activeTab, setActiveTab] = useState('my-qr'); // 'my-qr' | 'scan'
  const [roomId, setRoomId] = useState('');
  const [qrExpiresIn, setQrExpiresIn] = useState(60);
  const [connectionStatus, setConnectionStatus] = useState('disconnected'); // 'disconnected' | 'connecting' | 'connected' | 'peer-left'
  const [errorMsg, setErrorMsg] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [manualJoinCode, setManualJoinCode] = useState('');

  // File view mode: 'list' | 'grid' (persisted in localStorage)
  const [viewMode, setViewMode] = useState(() => {
    return localStorage.getItem('filebhejo_view_mode') || 'list';
  });

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

  // Clean up and reset session back to Home screen
  const handlePeerDisconnected = useCallback((msg = '') => {
    if (webrtcRef.current) {
      webrtcRef.current.cleanupPeer();
      webrtcRef.current.disconnect();
      webrtcRef.current = null;
    }
    setConnectionStatus('disconnected');
    setView('home');
    setActiveTab('my-qr');
    setTransfers([]);
    setSharedText('');
    lastSentTextRef.current = '';
    lastReceivedTextRef.current = '';
    if (msg) setErrorMsg(msg);
    // Immediately create a fresh room for the new session
    handleAutoCreateRoom();
  }, []);

  // Initialize WebRTC instance
  const getWebRTC = useCallback(() => {
    if (!webrtcRef.current) {
      webrtcRef.current = new WebRTCConnection({
        onStateChange: (state, meta) => {
          if (state === 'created' || state === 'joined') {
            setRoomId(meta.roomId);
            setQrExpiresIn(60);
          } else if (state === 'connecting') {
            setConnectionStatus('connecting');
          } else if (state === 'connected') {
            setConnectionStatus('connected');
            setView('connected');
            setErrorMsg('');
          } else if (state === 'peer-left' || state === 'disconnected' || state === 'failed') {
            // Immediately clean up and return to the first home screen
            handlePeerDisconnected(state === 'peer-left' ? 'Peer disconnected' : '');
          }
        },
        onTextMessage: (item) => {
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
  }, [handlePeerDisconnected]);

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
      handleJoinRoom(targetRoom);
      window.history.replaceState({}, document.title, '/');
    } else {
      handleAutoCreateRoom();
    }
  }, []);

  // QR Code 60-Second Auto-Regeneration Timer
  // Runs ONLY when on home screen and waiting for connection
  useEffect(() => {
    if (view !== 'home' || connectionStatus !== 'disconnected') {
      return;
    }

    const timer = setInterval(() => {
      setQrExpiresIn((prev) => {
        if (prev <= 1) {
          // Time expired: auto-regenerate fresh room code and QR
          if (webrtcRef.current && connectionStatus === 'disconnected') {
            webrtcRef.current.createRoom();
          }
          return 60;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [view, connectionStatus]);

  const handleAutoCreateRoom = async () => {
    setErrorMsg('');
    const client = getWebRTC();
    try {
      await client.connectSignaling(getWebSocketUrl());
      client.createRoom();
      setQrExpiresIn(60);
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
    } catch {
      setErrorMsg('Unable to connect to signaling server');
    }
  };

  const handleDisconnect = () => {
    handlePeerDisconnected();
  };

  const handleManualRefreshQR = () => {
    if (webrtcRef.current && connectionStatus === 'disconnected') {
      webrtcRef.current.createRoom();
      setQrExpiresIn(60);
    }
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
        } catch {}
      }
    }, 200);
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

  const toggleViewMode = () => {
    const next = viewMode === 'list' ? 'grid' : 'list';
    setViewMode(next);
    localStorage.setItem('filebhejo_view_mode', next);
  };

  return (
    <main className="app-shell">
      {/* App Header */}
      <header className="app-header">
        <h1 className="app-brand">FileBhejo</h1>
      </header>

      {/* Error Banner */}
      {errorMsg && (
        <div className="error-banner">
          <span>{errorMsg}</span>
          <button
            type="button"
            className="btn-close-error"
            onClick={() => setErrorMsg('')}
          >
            ✕
          </button>
        </div>
      )}

      {/* 1. FIRST / HOME SCREEN: WHATSAPP-STYLE TWO-TAB SWITCHER */}
      {view === 'home' && (
        <section className="home-container">
          {/* Top Tab Bar */}
          <nav className="tab-bar">
            <button
              type="button"
              className={`tab-btn ${activeTab === 'my-qr' ? 'active' : ''}`}
              onClick={() => setActiveTab('my-qr')}
            >
              My QR Code
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'scan' ? 'active' : ''}`}
              onClick={() => setActiveTab('scan')}
            >
              Scan Code
            </button>
          </nav>

          {/* TAB A: MY QR CODE */}
          {activeTab === 'my-qr' && (
            <div className="tab-content my-qr-tab">
              {/* 6-Digit Code */}
              <div className="code-display-group">
                <span className="code-label">SESSION CODE</span>
                <div
                  className="code-digits"
                  onClick={copyRoomCode}
                  title="Click to copy code"
                >
                  {roomId || '------'}
                </div>
                {copiedCode && (
                  <span className="code-copied-toast">Code copied!</span>
                )}
              </div>

              {/* QR Code Container */}
              <div className="qr-box">
                {roomId ? (
                  <QRCodeCanvas
                    text={`${window.location.origin}/join/${roomId}`}
                    size={200}
                  />
                ) : (
                  <div className="qr-placeholder" />
                )}
              </div>

              {/* 60-Second Refresh Indicator */}
              <div className="qr-timer-row">
                <span className="qr-timer-text">
                  New code in {qrExpiresIn}s
                </span>
                <button
                  type="button"
                  className="btn-refresh-qr"
                  onClick={handleManualRefreshQR}
                  title="Generate a fresh QR now"
                >
                  Refresh now
                </button>
              </div>

              {connectionStatus === 'connecting' && (
                <div className="status-pill status-connecting">
                  <span className="dot pulse" />
                  <span>Connecting to peer...</span>
                </div>
              )}
            </div>
          )}

          {/* TAB B: SCAN CODE */}
          {activeTab === 'scan' && (
            <div className="tab-content scan-tab">
              <QRScanner
                onScan={(code) => handleJoinRoom(code)}
                isConnecting={connectionStatus === 'connecting'}
              />
              {connectionStatus === 'connecting' && (
                <div className="status-pill status-connecting" style={{ marginTop: 12 }}>
                  <span className="dot pulse" />
                  <span>Connecting to peer session...</span>
                </div>
              )}
            </div>
          )}

          {/* JOIN WITH CODE SECTION (DIRECTLY ON FIRST SCREEN) */}
          <div className="home-manual-join">
            <span className="scanner-manual-label">OR ENTER 6-DIGIT CODE TO JOIN</span>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleJoinRoom(manualJoinCode);
              }}
              className="scanner-manual-form"
            >
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                className="input-field code-input"
                placeholder="000000"
                value={manualJoinCode}
                onChange={(e) => setManualJoinCode(e.target.value.replace(/\D/g, ''))}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={manualJoinCode.length !== 6 || connectionStatus === 'connecting'}
              >
                {connectionStatus === 'connecting' ? 'Connecting...' : 'Connect'}
              </button>
            </form>
          </div>
        </section>
      )}

      {/* 2. CONNECTED / TRANSFER SCREEN */}
      {view === 'connected' && (
        <section className="view-container">
          {/* Connected Header Bar */}
          <header className="header-bar">
            <div className="status-pill status-connected">
              <span className="dot connected" />
              <span>Connected</span>
              {roomId && <span className="room-badge">#{roomId}</span>}
            </div>

            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={handleDisconnect}
            >
              Disconnect
            </button>
          </header>

          {/* Live Comment-Box Style Text Sharing */}
          <section className="scratchpad">
            <textarea
              className="live-textarea"
              placeholder="Type anything to share live..."
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
            <span className="dropzone-sub">Supports any file type</span>
          </div>

          {/* Transfers Section */}
          {transfers.length > 0 && (
            <section className="transfer-section">
              {/* Header with Title and List / Grid Toggle */}
              <div className="transfer-header">
                <div className="transfer-title-group">
                  <span className="transfer-title">Transfers</span>
                  <span className="transfer-count">{transfers.length}</span>
                </div>

                <button
                  type="button"
                  className="btn-view-toggle"
                  onClick={toggleViewMode}
                  title={viewMode === 'list' ? 'Switch to Grid view' : 'Switch to List view'}
                >
                  {viewMode === 'list' ? (
                    // Grid Icon
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="7" height="7" rx="1.5" />
                      <rect x="14" y="3" width="7" height="7" rx="1.5" />
                      <rect x="14" y="14" width="7" height="7" rx="1.5" />
                      <rect x="3" y="14" width="7" height="7" rx="1.5" />
                    </svg>
                  ) : (
                    // List Icon
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="8" y1="6" x2="21" y2="6" strokeLinecap="round" />
                      <line x1="8" y1="12" x2="21" y2="12" strokeLinecap="round" />
                      <line x1="8" y1="18" x2="21" y2="18" strokeLinecap="round" />
                      <circle cx="4" cy="6" r="1.5" fill="currentColor" />
                      <circle cx="4" cy="12" r="1.5" fill="currentColor" />
                      <circle cx="4" cy="18" r="1.5" fill="currentColor" />
                    </svg>
                  )}
                  <span className="view-toggle-text">
                    {viewMode === 'list' ? 'Grid' : 'List'}
                  </span>
                </button>
              </div>

              {/* A. LIST VIEW */}
              {viewMode === 'list' && (
                <div className="transfer-list">
                  {transfers.map((item) => (
                    <div key={item.id} className="transfer-row">
                      <div className="transfer-row-main">
                        <FilePreview item={item} mode="list" />

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
                            <span className="file-status">{item.status}</span>
                          </div>
                        </div>

                        {/* Action Button */}
                        <div className="file-action-col">
                          {(item.status === 'sending' ||
                            item.status === 'receiving' ||
                            item.status === 'queued') && (
                            <button
                              type="button"
                              className="btn btn-xs btn-danger"
                              onClick={() => handleCancelTransfer(item.id)}
                            >
                              Cancel
                            </button>
                          )}
                          {item.status === 'completed' && item.blobUrl && (
                            <a
                              href={item.blobUrl}
                              download={item.name}
                              className="btn btn-xs btn-primary"
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
              )}

              {/* B. GRID VIEW */}
              {viewMode === 'grid' && (
                <div className="transfer-grid">
                  {transfers.map((item) => (
                    <div key={item.id} className="grid-card">
                      {/* Top Preview Box */}
                      <div className="grid-card-preview">
                        <FilePreview item={item} mode="grid" />
                      </div>

                      {/* Bottom Details Box */}
                      <div className="grid-card-body">
                        <span className="grid-file-name" title={item.name}>
                          {item.name}
                        </span>

                        <div className="grid-file-meta">
                          <span>{formatBytes(item.size)}</span>
                          <span>•</span>
                          <span>{item.status}</span>
                        </div>

                        {item.speed > 0 && (
                          <div className="file-speed text-xs">
                            {formatSpeed(item.speed)}
                          </div>
                        )}

                        {/* Progress Bar */}
                        <div className="progress-container" style={{ marginTop: 4 }}>
                          <div
                            className={`progress-bar ${item.status}`}
                            style={{ width: `${item.progress}%` }}
                          />
                        </div>

                        {/* Actions */}
                        <div className="grid-card-action">
                          {(item.status === 'sending' ||
                            item.status === 'receiving' ||
                            item.status === 'queued') && (
                            <button
                              type="button"
                              className="btn btn-xs btn-danger"
                              style={{ width: '100%' }}
                              onClick={() => handleCancelTransfer(item.id)}
                            >
                              Cancel
                            </button>
                          )}
                          {item.status === 'completed' && item.blobUrl && (
                            <a
                              href={item.blobUrl}
                              download={item.name}
                              className="btn btn-xs btn-primary"
                              style={{ width: '100%', textDecoration: 'none', textAlign: 'center' }}
                            >
                              Save
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </section>
      )}
    </main>
  );
}
