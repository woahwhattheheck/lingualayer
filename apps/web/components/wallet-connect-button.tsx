"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@/lib/wallet-context";
import { WalletConnectQr } from "@/components/wallet-connect-qr";

function short(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function WalletConnectButton() {
  const {
    address,
    isAuthenticated,
    isConnecting,
    isAuthenticating,
    error,
    walletConnectUri,
    connect,
    connectWithWalletConnect,
    cancelWalletConnect,
    disconnect,
  } = useWallet();
  const [wcModalOpen, setWcModalOpen] = useState(false);

  useEffect(() => {
    if (isAuthenticated || error) setWcModalOpen(false);
  }, [isAuthenticated, error]);

  if (isAuthenticated && address) {
    return (
      <button className="wallet-btn wallet-btn--connected" onClick={disconnect}>
        <span className="wallet-btn-dot" aria-hidden="true" />
        {short(address)}
      </button>
    );
  }

  const busy = isConnecting || isAuthenticating;

  function handleWalletConnectClick() {
    setWcModalOpen(true);
    connectWithWalletConnect();
  }

  function handleClose() {
    setWcModalOpen(false);
    cancelWalletConnect();
  }

  return (
    <div className="wallet-btn-wrap">
      <button className="wallet-btn" onClick={connect} disabled={busy}>
        {busy ? "Connecting…" : "Connect Wallet"}
      </button>
      <button className="wc-trigger-btn" onClick={handleWalletConnectClick} disabled={busy}>
        WalletConnect (QR)
      </button>
      {error && <span className="wallet-btn-error">{error}</span>}
      {wcModalOpen && <WalletConnectQr uri={walletConnectUri} onClose={handleClose} />}
    </div>
  );
}
