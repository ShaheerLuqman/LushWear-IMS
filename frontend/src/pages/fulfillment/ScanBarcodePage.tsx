// Camera barcode scanner (mobile-first) for reading tracking numbers off printed
// airway bills. Test harness for now - scans are only listed on screen, nothing
// is sent to the backend yet.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Banner, BlockStack, Button, Card, InlineStack, Text } from '@shopify/polaris';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { usePageHeader } from '../../layout/PageHeaderContext';
import { useToast } from '../../toast/ToastContext';

const COOLDOWN_MS = 10_000;

interface Scan { code: string; at: number; }

export function ScanBarcodePage() {
  const { showToast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastSeen = useRef(new Map<string, number>());
  const stopRef = useRef<(() => void) | null>(null);
  const [scanning, setScanning] = useState(false);
  const [engine, setEngine] = useState('');
  const [scans, setScans] = useState<Scan[]>([]);
  const [error, setError] = useState<string | null>(null);

  const record = useCallback((code: string) => {
    const now = Date.now();
    const seen = lastSeen.current.get(code);
    if (seen && now - seen < COOLDOWN_MS) return;
    lastSeen.current.set(code, now);
    setScans((prev) => [{ code, at: now }, ...prev]);
    showToast(`Tracking number read: ${code}`, 'success');
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
      const stopTracks = () => stream.getTracks().forEach((t) => t.stop());
      // Native BarcodeDetector (Android Chrome) reads 1D codes far better than the
      // JS fallback; ZXing covers iOS/desktop where it isn't implemented.
      const Detector = (window as any).BarcodeDetector;
      if (Detector) {
        const detector = new Detector();
        video.srcObject = stream;
        await video.play();
        const timer = window.setInterval(async () => {
          try {
            for (const code of await detector.detect(video)) record(code.rawValue);
          } catch { /* frame not ready */ }
        }, 200);
        stopRef.current = () => { clearInterval(timer); stopTracks(); };
        setEngine('BarcodeDetector (native)');
      } else {
        const controls = await new BrowserMultiFormatReader().decodeFromStream(stream, video, (result) => {
          if (result) record(result.getText());
        });
        stopRef.current = () => { controls.stop(); stopTracks(); };
        setEngine('ZXing (JS fallback)');
      }
      setScanning(true);
    } catch (e: any) {
      setError(e?.message || 'Could not start the camera. It needs HTTPS (or localhost) and camera permission.');
    }
  }

  useEffect(() => () => stopRef.current?.(), []);

  usePageHeader({ title: 'Scan Barcode', subtitle: 'Point the camera at an airway bill barcode' });

  return (
    <BlockStack gap="400">
      {error && <Banner tone="critical">{error}</Banner>}
      <Card>
        <BlockStack gap="300">
          <video
            ref={videoRef}
            muted
            playsInline
            style={{ width: '100%', maxWidth: 480, aspectRatio: '3 / 4', objectFit: 'cover', background: '#000', borderRadius: 8 }}
          />
          <InlineStack gap="300" blockAlign="center">
            <Button variant="primary" tone={scanning ? 'critical' : undefined} onClick={scanning ? stop : start}>
              {scanning ? 'Stop camera' : 'Start camera'}
            </Button>
            {engine && <Text as="span" tone="subdued">{engine}</Text>}
          </InlineStack>
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">Scanned ({scans.length})</Text>
          {scans.length === 0 && <Text as="p" tone="subdued">Nothing scanned yet.</Text>}
          {scans.map((s) => (
            <InlineStack key={`${s.code}-${s.at}`} align="space-between" blockAlign="center">
              <Text as="span" fontWeight="semibold">{s.code}</Text>
              <Badge>{new Date(s.at).toLocaleTimeString()}</Badge>
            </InlineStack>
          ))}
        </BlockStack>
      </Card>
    </BlockStack>
  );
}
