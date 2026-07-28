"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

// `@creit.tech/stellar-wallets-kit` touches browser-only APIs at module scope,
// so it must never be statically imported from a module that Next.js
// server-renders (every page, via this context living in the root layout).
// Loading it lazily keeps it out of the SSR pass entirely.
function loadWalletsKit() {
  return import("./wallets-kit");
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080/api/v1";
const SESSION_STORAGE_KEY = "lingualayer.sep10.session";

interface StoredSession {
  address: string;
  token: string;
}

interface WalletContextValue {
  address: string | null;
  token: string | null;
  isAuthenticated: boolean;
  isConnecting: boolean;
  isAuthenticating: boolean;
  error: string | null;
  walletConnectUri: string | null;
  connect: () => Promise<void>;
  connectWithLedger: () => Promise<void>;
  connectWithWalletConnect: () => Promise<void>;
  cancelWalletConnect: () => void;
  disconnect: () => void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

/**
 * SEP-0010 Stellar Web Authentication: fetch a challenge transaction from the
 * backend, have the connected wallet sign it, then exchange the signed
 * challenge for a JWT. Replaces the previous custom Sign-In-With-Stellar flow.
 */
async function authenticate(account: string): Promise<string> {
  const challengeRes = await fetch(
    `${API_BASE}/auth/challenge?account=${encodeURIComponent(account)}`,
  );
  if (!challengeRes.ok) {
    const body = await challengeRes.json().catch(() => null);
    throw new Error(body?.error ?? "Failed to fetch SEP-0010 challenge");
  }
  const { transaction, network_passphrase: networkPassphrase } = await challengeRes.json();

  const { signTransaction } = await loadWalletsKit();
  const signedTransaction = await signTransaction(transaction, networkPassphrase);

  const tokenRes = await fetch(`${API_BASE}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: signedTransaction }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.json().catch(() => null);
    throw new Error(body?.error ?? "SEP-0010 verification failed");
  }
  const { token } = await tokenRes.json();
  return token as string;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletConnectUri, setWalletConnectUri] = useState<string | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!stored) return;
    try {
      const session = JSON.parse(stored) as StoredSession;
      setAddress(session.address);
      setToken(session.token);
    } catch {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }, []);

  const persistSession = useCallback((session: StoredSession) => {
    setAddress(session.address);
    setToken(session.token);
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  }, []);

  const connect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);
    try {
      const { openWalletModal } = await loadWalletsKit();
      const { address: connectedAddress } = await openWalletModal();
      setIsConnecting(false);
      setIsAuthenticating(true);
      const jwt = await authenticate(connectedAddress);
      persistSession({ address: connectedAddress, token: jwt });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet connection failed");
    } finally {
      setIsConnecting(false);
      setIsAuthenticating(false);
    }
  }, [persistSession]);

  const connectWithLedger = useCallback(async () => {
    setIsConnecting(true);
    setError(null);
    try {
      const { connectLedger } = await loadWalletsKit();
      const { address: connectedAddress } = await connectLedger();
      setIsConnecting(false);
      setIsAuthenticating(true);
      const jwt = await authenticate(connectedAddress);
      persistSession({ address: connectedAddress, token: jwt });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ledger connection failed");
    } finally {
      setIsConnecting(false);
      setIsAuthenticating(false);
    }
  }, [persistSession]);

  const connectWithWalletConnect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);
    setWalletConnectUri(null);
    try {
      const { connectWalletConnect } = await loadWalletsKit();
      const { address: connectedAddress } = await connectWalletConnect((uri) => {
        setWalletConnectUri(uri);
      });
      setIsConnecting(false);
      setIsAuthenticating(true);
      const jwt = await authenticate(connectedAddress);
      persistSession({ address: connectedAddress, token: jwt });
    } catch (err) {
      setError(err instanceof Error ? err.message : "WalletConnect connection failed");
    } finally {
      setIsConnecting(false);
      setIsAuthenticating(false);
      setWalletConnectUri(null);
    }
  }, [persistSession]);

  const cancelWalletConnect = useCallback(() => {
    setWalletConnectUri(null);
    setIsConnecting(false);
    setError(null);
  }, []);

  const disconnect = useCallback(() => {
    loadWalletsKit().then(({ disconnectWallet }) => disconnectWallet().catch(() => {}));
    setAddress(null);
    setToken(null);
    setError(null);
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  }, []);

  const value = useMemo<WalletContextValue>(
    () => ({
      address,
      token,
      isAuthenticated: Boolean(token),
      isConnecting,
      isAuthenticating,
      error,
      walletConnectUri,
      connect,
      connectWithLedger,
      connectWithWalletConnect,
      cancelWalletConnect,
      disconnect,
    }),
    [
      address,
      token,
      isConnecting,
      isAuthenticating,
      error,
      walletConnectUri,
      connect,
      connectWithLedger,
      connectWithWalletConnect,
      cancelWalletConnect,
      disconnect,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used within a WalletProvider");
  }
  return ctx;
}
