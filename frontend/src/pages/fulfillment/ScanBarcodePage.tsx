// Camera barcode scanner (mobile-first) for reading tracking numbers off printed
// airway bills. Test harness for now - scans are only listed on screen, nothing
// is sent to the backend yet.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Text } from '@shopify/polaris';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { useToast } from '../../toast/ToastContext';

const COOLDOWN_MS = 10_000;
const HIT_FLASH_MS = 2500;

interface Scan { code: string; at: number; }

export function ScanBarcodePage() {
  const { showToast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const lastSeen = useRef(new Map<string, number>());
  const stopRef = useRef<(() => void) | null>(null);
  const hitTimer = useRef<number>();
  const [scanning, setScanning] = useState(false);
  const [engine, setEngine] = useState('');
  const [scans, setScans] = useState<Scan[]>([]);
  const [hit, setHit] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const record = useCallback((code: string) => {
    const now = Date.now();
    const seen = lastSeen.current.get(code);
    if (seen && now - seen < COOLDOWN_MS) return;
    lastSeen.current.set(code, now);
    setScans((prev) => [{ code, at: now }, ...prev]);
    setHit(code);
    clearTimeout(hitTimer.current);
    hitTimer.current = window.setTimeout(() => setHit(null), HIT_FLASH_MS);
    showToast(`Tracking number read: ${code}`, 'success');
    navigator.vibrate?.(80);
  }, [showToast]);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setScanning(false);
  }, []);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      // Native BarcodeDetector (Android Chrome) reads 1D codes far better than the
      // JS fallback; ZXing covers iOS/desktop where it isn't implemented.
      const Detector = (window as any).BarcodeDetector;
      const detector = Detector && new Detector();
      const zxing = new BrowserMultiFormatReader();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      // Only the region under .scan-frame is decoded, so codes outside it are ignored.
      // The video is object-fit: cover, so map the frame's screen rect back into
      // video pixels through the cover scale/offset.
      const timer = window.setInterval(async () => {
        const frame = frameRef.current;
        if (!frame || !video.videoWidth) return;
        const v = video.getBoundingClientRect();
        const f = frame.getBoundingClientRect();
        const scale = Math.max(v.width / video.videoWidth, v.height / video.videoHeight);
        const sx = (f.left - v.left - (v.width - video.videoWidth * scale) / 2) / scale;
        const sy = (f.top - v.top - (v.height - video.videoHeight * scale) / 2) / scale;
        canvas.width = f.width / scale;
        canvas.height = f.height / scale;
        ctx.drawImage(video, sx, sy, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
        try {
          if (detector) for (const code of await detector.detect(canvas)) record(code.rawValue);
          else record(zxing.decodeFromCanvas(canvas).getText());
        } catch { /* nothing decodable in the frame */ }
      }, 200);
      stopRef.current = () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); };
      setEngine(detector ? 'Native detector' : 'ZXing fallback');
      setScanning(true);
    } catch (e: any) {
      setError(e?.message || 'Could not start the camera. It needs HTTPS (or localhost) and camera permission.');
    }
  }

  useEffect(() => () => { stopRef.current?.(); clearTimeout(hitTimer.current); }, []);

  usePageHeader({ title: 'Scan Barcode' });

  return (
    <div className="scan-page">
      <div className="scan-viewport">
        <video ref={videoRef} muted playsInline className="scan-video" />
        {scanning && <div ref={frameRef} className="scan-frame" />}
        {scanning && <span className="scan-chip">{engine}</span>}
        {!scanning && !error && (
          <div className="scan-placeholder">
            <Text as="p" variant="bodyMd">Start the camera and hold a barcode inside the frame</Text>
          </div>
        )}
        {error && <div className="scan-placeholder scan-placeholder--error"><Text as="p" variant="bodyMd">{error}</Text></div>}
        {hit && (
          <div className="scan-hit" role="status">
            <span>Tracking number read</span>
            <strong>{hit}</strong>
          </div>
        )}
      </div>

      <Button variant="primary" size="large" fullWidth tone={scanning ? 'critical' : undefined} onClick={scanning ? stop : start}>
        {scanning ? 'Stop scanning' : 'Start scanning'}
      </Button>

      <div className="scan-results">
        <div className="scan-results__head">
          <Text as="h2" variant="headingSm">Scanned</Text>
          <Text as="span" variant="headingSm" tone="subdued">{scans.length}</Text>
        </div>
        <div className="scan-results__list">
          {scans.length === 0
            ? <Text as="p" tone="subdued">Nothing scanned yet.</Text>
            : scans.map((s) => (
              <div key={`${s.code}-${s.at}`} className="scan-results__row">
                <span className="scan-results__code">{s.code}</span>
                <Text as="span" tone="subdued" variant="bodySm">{new Date(s.at).toLocaleTimeString()}</Text>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
