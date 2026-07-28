"use client";

import { useEffect, useState } from "react";

interface WalletConnectQrProps {
  uri: string | null;
  onClose: () => void;
}

export function WalletConnectQr({ uri, onClose }: WalletConnectQrProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!uri) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    import("qrcode").then((QRCode) => {
      QRCode.toDataURL(uri, { margin: 1, width: 240 }).then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  useEffect(() => {
    setCopied(false);
  }, [uri]);

  async function handleCopy() {
    if (!uri) return;
    await navigator.clipboard.writeText(uri);
    setCopied(true);
  }

  return (
    <div className="wc-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="wc-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Connect with WalletConnect"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="wc-modal-title">Scan with your mobile wallet</p>
        <p className="wc-modal-subtitle">
          Open a WalletConnect-compatible Stellar wallet and scan this code, or copy the link
          below and paste it into your wallet app.
        </p>

        <div className="wc-qr-frame">
          {qrDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qrDataUrl} alt="WalletConnect pairing QR code" width={240} height={240} />
          ) : (
            <span className="wc-qr-spinner" aria-label="Generating connection link" />
          )}
        </div>

        <button className="wc-copy-btn" onClick={handleCopy} disabled={!uri}>
          {copied ? "Copied!" : "Copy Link"}
        </button>

        <button className="wc-close-btn" onClick={onClose} aria-label="Cancel WalletConnect">
          Cancel
        </button>
      </div>
    </div>
  );
}
