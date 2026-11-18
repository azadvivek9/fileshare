import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

export function QRScanner({ onScan, onCancel }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const animFrameRef = useRef(null);

  const [cameraError, setCameraError] = useState('');
  const [manualCode, setManualCode] = useState('');

  useEffect(() => {
    let active = true;

    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }
        });
        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute('playsinline', 'true');
          await videoRef.current.play();
          requestScanFrame();
        }
      } catch (err) {
        console.warn('Camera access failed:', err);
        setCameraError('Camera access unavailable. Enter code below.');
      }
    }

    startCamera();

    return () => {
      active = false;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };
  }, []);

  const requestScanFrame = () => {
    animFrameRef.current = requestAnimationFrame(scanTick);
  };

  const scanTick = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert'
      });

      if (code && code.data) {
        // Extract 6-digit code from URL or text
        const match = code.data.match(/(\d{6})/);
        if (match) {
          if (streamRef.current) {
            streamRef.current.getTracks().forEach((t) => t.stop());
          }
          onScan(match[1]);
          return;
        }
      }
    }

    requestScanFrame();
  };

  const handleManualSubmit = (e) => {
    e.preventDefault();
    const clean = manualCode.trim();
    if (/^\d{6}$/.test(clean)) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      onScan(clean);
    }
  };

  return (
    <div className="view-container">
      <header className="header-bar">
        <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>
          ← Back
        </button>
        <span className="header-title">Scan QR</span>
        <span style={{ width: 48 }} />
      </header>

      <div className="scanner-container" style={{ marginTop: 16 }}>
        {/* Camera Viewfinder */}
        {!cameraError ? (
          <div className="scanner-viewport">
            <video ref={videoRef} className="scanner-video" />
            <canvas ref={canvasRef} style={{ display: 'none' }} />
            <div className="scanner-overlay">
              <div className="scanner-frame" />
            </div>
          </div>
        ) : (
          <div className="scanner-fallback-msg">
            <span>{cameraError}</span>
          </div>
        )}

        {/* Fallback Manual Code Entry */}
        <div className="scanner-manual">
          <span className="text-muted text-xs">OR ENTER CODE</span>
          <form onSubmit={handleManualSubmit} className="scanner-manual-form">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              className="input-field code-input"
              style={{ width: '100%', maxWidth: 220, fontSize: 24, letterSpacing: 4 }}
              placeholder="000000"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value.replace(/\D/g, ''))}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={manualCode.length !== 6}
            >
              Join
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
