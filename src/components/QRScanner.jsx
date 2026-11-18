import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

export function QRScanner({ onScan, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const animFrameRef = useRef(null);
  const fileInputRef = useRef(null);

  const [cameraError, setCameraError] = useState('');
  const [isScanning, setIsScanning] = useState(false);

  useEffect(() => {
    let active = true;

    async function startCamera() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraError(
          'Live camera requires HTTPS or localhost. You can upload a QR image below.'
        );
        return;
      }

      let stream = null;

      try {
        // Ideal back camera for mobile
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        });
      } catch {
        try {
          // Fallback to any camera (laptop webcam, front cam)
          stream = await navigator.mediaDevices.getUserMedia({ video: true });
        } catch (err) {
          console.warn('Camera access error:', err);
          if (active) {
            setCameraError(
              'Camera permission was denied or camera is unavailable. You can upload a QR image below.'
            );
          }
          return;
        }
      }

      if (!active) {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;
      const video = videoRef.current;

      if (video) {
        video.srcObject = stream;
        video.muted = true;
        video.setAttribute('playsinline', 'true');
        video.setAttribute('autoplay', 'true');

        try {
          await video.play();
          if (active) {
            setIsScanning(true);
            requestScanFrame();
          }
        } catch (playErr) {
          console.warn('Video play error:', playErr);
        }
      }
    }

    startCamera();

    return () => {
      active = false;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
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

    if (
      video &&
      canvas &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      video.videoWidth > 0
    ) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      try {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert'
        });

        if (code && code.data) {
          const match = code.data.match(/(\d{6})/);
          if (match) {
            handleCodeFound(match[1]);
            return;
          }
        }
      } catch (err) {
        console.warn('QR scan frame error:', err);
      }
    }

    requestScanFrame();
  };

  const handleCodeFound = (sixDigitCode) => {
    // 1. Immediately stop camera stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    // 2. Haptic feedback if available
    try { navigator.vibrate?.(50); } catch {}

    // 3. Immediately trigger connection
    onScan(sixDigitCode);
  };

  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = canvasRef.current || document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        try {
          const imageData = ctx.getImageData(0, 0, img.width, img.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'attemptBoth'
          });

          if (code && code.data) {
            const match = code.data.match(/(\d{6})/);
            if (match) {
              handleCodeFound(match[1]);
              return;
            }
          }
          alert('No 6-digit QR code found in this image. Please try another image.');
        } catch {
          alert('Could not decode QR from image.');
        }
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleClose = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    onClose();
  };

  return (
    <div className="fullscreen-scanner">
      {/* Hidden canvas for image decoding */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* Hidden file input for QR photo upload */}
      <input
        type="file"
        ref={fileInputRef}
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleImageUpload}
      />

      {/* Fullscreen Camera Video */}
      {!cameraError ? (
        <video
          ref={videoRef}
          className="scanner-fullscreen-video"
          autoPlay
          playsInline
          muted
        />
      ) : (
        <div className="scanner-fullscreen-error">
          <svg
            width="36"
            height="36"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            style={{ marginBottom: 12, color: '#f87171' }}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <p>{cameraError}</p>
        </div>
      )}

      {/* Top Navigation Bar */}
      <div className="scanner-fullscreen-header">
        <button
          type="button"
          className="btn-scanner-back"
          onClick={handleClose}
          aria-label="Close scanner"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="scanner-header-title">Scan QR Code</span>
        <div style={{ width: 40 }} />
      </div>

      {/* Center QR Cutout Frame */}
      <div className="scanner-fullscreen-reticle-wrap">
        <div className={`scanner-fullscreen-reticle ${isScanning ? 'active' : ''}`}>
          <span className="corner top-left" />
          <span className="corner top-right" />
          <span className="corner bottom-left" />
          <span className="corner bottom-right" />
          {isScanning && <div className="scanner-laser" />}
        </div>
      </div>

      {/* Bottom Controls */}
      <div className="scanner-fullscreen-footer">
        <p className="scanner-instruction-text">
          Align QR code within the frame to scan
        </p>

        <button
          type="button"
          className="btn-fullscreen-upload"
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <span>Upload from Gallery</span>
        </button>
      </div>
    </div>
  );
}
