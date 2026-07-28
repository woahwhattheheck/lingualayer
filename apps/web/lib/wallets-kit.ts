import { StellarWalletsKit, Networks } from "@creit.tech/stellar-wallets-kit";
import { FREIGHTER_ID } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { LEDGER_ID, LedgerModule } from "@creit.tech/stellar-wallets-kit/modules/ledger";
import {
  WALLET_CONNECT_ID,
  WalletConnectModule,
  WalletConnectTargetChain,
} from "@creit.tech/stellar-wallets-kit/modules/wallet-connect";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";

const NETWORK =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
    ? Networks.PUBLIC
    : Networks.TESTNET;

const WALLET_CONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

let _initialized = false;
let _wcModule: WalletConnectModule | null = null;

export function isWalletConnectConfigured(): boolean {
  return Boolean(WALLET_CONNECT_PROJECT_ID);
}

export function initWalletsKit(): void {
  if (_initialized) return;
  const modules = [...defaultModules(), new LedgerModule()];

  if (WALLET_CONNECT_PROJECT_ID) {
    _wcModule = new WalletConnectModule({
      projectId: WALLET_CONNECT_PROJECT_ID,
      metadata: {
        name: "LinguaLayer",
        description: "Decentralized multilingual dataset registry on Stellar",
        url: typeof window !== "undefined" ? window.location.origin : "https://lingualayer.xyz",
        icons: ["https://lingualayer.xyz/icon.png"],
      },
      allowedChains: [
        NETWORK === Networks.PUBLIC ? WalletConnectTargetChain.PUBLIC : WalletConnectTargetChain.TESTNET,
      ],
    });
    modules.push(_wcModule);
  }

  StellarWalletsKit.init({
    network: NETWORK,
    selectedWalletId: FREIGHTER_ID,
    modules,
  });
  _initialized = true;
}

export async function openWalletModal(): Promise<{ address: string; walletId: string }> {
  initWalletsKit();
  const { address } = await StellarWalletsKit.authModal();
  const walletId = FREIGHTER_ID;
  return { address, walletId };
}

export async function getConnectedAddress(): Promise<string> {
  initWalletsKit();
  const { address } = await StellarWalletsKit.getAddress();
  return address;
}

export async function signTransaction(
  xdr: string,
  networkPassphrase?: string
): Promise<string> {
  initWalletsKit();
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
    networkPassphrase: networkPassphrase ?? NETWORK,
  });
  return signedTxXdr;
}

export async function disconnectWallet(): Promise<void> {
  initWalletsKit();
  await StellarWalletsKit.disconnect();
}

export { LEDGER_ID };

async function waitForWalletConnectClient(timeoutMs = 8000): Promise<WalletConnectModule> {
  initWalletsKit();
  if (!_wcModule) {
    throw new Error(
      "WalletConnect is not configured. Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID."
    );
  }
  const start = Date.now();
  while (!_wcModule.signClient) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("WalletConnect failed to initialize. Check your connection and try again.");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return _wcModule;
}

/**
 * Connects via WalletConnect, invoking `onUri` with the raw pairing URI as
 * soon as it's available so the caller can render its own QR/copy-link UI
 * instead of the default modal the kit opens internally.
 */
// "display_uri" is emitted by the underlying WalletConnect Core pairing
// engine but isn't part of the (incomplete) SignClientTypes.Event union
// that @walletconnect/sign-client exposes on its typed on/off methods.
interface DisplayUriEmitter {
  on(event: "display_uri", listener: (uri: string) => void): void;
  off(event: "display_uri", listener: (uri: string) => void): void;
}

export async function connectWalletConnect(
  onUri: (uri: string) => void
): Promise<{ address: string; walletId: string }> {
  const wcModule = await waitForWalletConnectClient();
  const emitter = wcModule.signClient as unknown as DisplayUriEmitter;

  const handleDisplayUri = (uri: string) => {
    emitter.off("display_uri", handleDisplayUri);
    onUri(uri);
  };
  emitter.on("display_uri", handleDisplayUri);

  try {
    StellarWalletsKit.setWallet(WALLET_CONNECT_ID);
    const { address } = await StellarWalletsKit.getAddress();
    return { address, walletId: WALLET_CONNECT_ID };
  } finally {
    emitter.off("display_uri", handleDisplayUri);
  }
}

export async function connectLedger(): Promise<{ address: string; walletId: string }> {
  if (typeof window === "undefined") throw new Error("Must be called in the browser");
  const nav = navigator as Navigator & { usb?: unknown; hid?: unknown };
  if (!nav.usb && !nav.hid) {
    throw new Error(
      "WebUSB/WebHID is not supported in this browser. Please use Chrome or Edge."
    );
  }
  initWalletsKit();
  StellarWalletsKit.setWallet(LEDGER_ID);
  const { address } = await StellarWalletsKit.getAddress();
  return { address, walletId: LEDGER_ID };
}
