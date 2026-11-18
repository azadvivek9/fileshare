import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

export function QRScanner({ onScan, isConnecting = false }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const animFrameRef = useRef(null);
  const fileInputRef = useRef(null);

  const [cameraError, setCameraError] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [detectedToast, setDetectedToast] = useState('');

  // Start Camera
  useEffect(() => {
    let active = true;

    async function startCamera() {
      // Check if mediaDevices is supported (requires HTTPS or localhost)
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraError(
          'Live camera requires HTTPS or localhost. Enter the 6-digit code or upload a QR image below.'
        );
        return;
      }

      let stream = null;

      try {
        // Try ideal back camera for mobile devices
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } }
        });
      } catch {
        // Fallback to any available camera (laptop webcam, front cam)
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true
          });
        } catch (err2) {
          console.warn('Camera access denied or unavailable:', err2);
          if (active) {
            setCameraError(
              'Camera access was denied or unavailable. Enter code or upload image below.'
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
          setIsScanning(true);
          requestScanFrame();
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
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
    }
    setIsScanning(false);
    setDetectedToast(`Found code: ${sixDigitCode}`);
    if (navigator.vibrate) {
      try { navigator.vibrate(50); } catch {}
    }
    onScan(sixDigitCode);
  };

  // Upload QR Image from gallery / file
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
          alert('No 6-digit QR code found in this image. Please enter code manually.');
        } catch {
          alert('Could not decode QR from image. Please enter code manually.');
        }
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div className="scanner-container">
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

      {/* Success detection toast */}
      {detectedToast && (
        <div className="code-detected-toast">
          ✓ {detectedToast}
        </div>
      )}

      {/* Camera Viewfinder */}
      {!cameraError ? (
        <div className="scanner-viewport">
          <video
            ref={videoRef}
            className="scanner-video"
            autoPlay
            playsInline
            muted
          />
          <div className="scanner-overlay">
            <div className={`scanner-frame ${isScanning ? 'active' : ''}`}>
              <span className="corner top-left" />
              <span className="corner top-right" />
              <span className="corner bottom-left" />
              <span className="corner bottom-right" />
              {isScanning && <div className="scanner-laser" />}
            </div>
          </div>
        </div>
      ) : (
        <div className="scanner-fallback-msg">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            style={{ margin: '0 auto 8px', color: '#6b7280' }}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <span>{cameraError}</span>
        </div>
      )}

      {/* Action to scan from image / screenshot */}
      <button
        type="button"
        className="btn-upload-qr"
        onClick={() => fileInputRef.current && fileInputRef.current.click()}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
        <span>Upload QR image / screenshot</span>
      </button>
    </div>
  );
}
