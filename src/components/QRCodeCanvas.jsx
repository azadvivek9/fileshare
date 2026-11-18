import React, { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

export function QRCodeCanvas({ text, size = 180 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (canvasRef.current && text) {
      QRCode.toCanvas(canvasRef.current, text, {
        width: size,
        margin: 1,
        color: {
          dark: '#1e293b',
          light: '#ffffff'
        }
      }).catch((err) => {
        console.error('Failed to generate QR code:', err);
      });
    }
  }, [text, size]);

  return (
    <div className="qr-canvas-wrap">
      <canvas ref={canvasRef} />
    </div>
  );
}
