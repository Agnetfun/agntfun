// Privy for the site: email, Google or any Solana wallet, through one login window. Bundled by esbuild into
// public/privy-bridge.js and loaded only when someone picks "Email, Google or any wallet" (see wallet.js).
// It exposes window.PrivyBridge with the same shape wallet.js already uses for Phantom (connect, signMessage,
// signTransaction, disconnect), so launch, trade, vote and connect code needs no change. Keys stay with Privy or the
// user's wallet; this site never sees them.
import { createElement, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, useLogin, usePrivy } from "@privy-io/react-auth";
import { toSolanaWalletConnectors, useSignMessage, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";

type Listener = (address: string) => void;
interface Bridge {
  address: string;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  signTransactionBytes(tx: Uint8Array): Promise<Uint8Array>;
  onChange(f: Listener): void;
}

const cfg = (window as unknown as { PRIVY_CONFIG: { appId: string; cluster: string } }).PRIVY_CONFIG;
const mainnet = cfg.cluster === "mainnet-beta";
const chain = mainnet ? "solana:mainnet" : "solana:devnet";
// Public endpoints only for Privy's own wallet screens; the site's keyed RPC never reaches the browser.
const host = mainnet ? "api.mainnet-beta.solana.com" : "api.devnet.solana.com";

// Test networks only: forward console errors to the server (data/client-log.jsonl), so a failed wallet login shows
// its real reason without opening the browser console. Capped per page; never on mainnet.
if (!mainnet) {
  let sent = 0;
  const text = (a: unknown) => {
    if (a instanceof Error) return `${a.name}: ${a.message} ${a.stack ?? ""}`;
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  const send = (level: string, args: unknown[]) => {
    if (sent++ >= 40) return;
    void fetch("/api/client-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level, msg: args.map(text).join(" ") }),
    }).catch(() => {});
  };
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      send(level, args);
      original(...args);
    };
  }
  window.addEventListener("unhandledrejection", (e) => send("reject", [e.reason]));
}

const listeners: Listener[] = [];
let pending: { resolve: (a: string) => void; reject: (e: Error) => void } | null = null;
const bridge: Bridge = {
  address: "",
  connect: () => Promise.reject(new Error("Privy is still loading. Try again in a moment.")),
  disconnect: async () => {},
  signMessage: () => Promise.reject(new Error("Connect first.")),
  signTransactionBytes: () => Promise.reject(new Error("Connect first.")),
  onChange: (f) => void listeners.push(f),
};
(window as unknown as { PrivyBridge: Bridge }).PrivyBridge = bridge;

function Bind() {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const { signTransaction } = useSignTransaction();
  const { login } = useLogin({
    onError: (e) => {
      pending?.reject(new Error(e === "exited_auth_flow" ? "Wallet connection was cancelled." : `Login failed (${e}).`));
      pending = null;
    },
  });
  const wallet = authenticated ? wallets[0] : undefined;
  const ref = useRef(wallet);
  ref.current = wallet;

  useEffect(() => {
    const address = wallet?.address ?? "";
    if (address === bridge.address) return;
    bridge.address = address;
    if (address && pending) {
      pending.resolve(address);
      pending = null;
    }
    listeners.slice().forEach((f) => f(address));
  }, [wallet?.address]);

  bridge.connect = () =>
    new Promise((resolve, reject) => {
      if (!ready) return reject(new Error("Privy is still loading. Try again in a moment."));
      if (bridge.address) return resolve({ publicKey: { toString: () => bridge.address } });
      pending = { resolve: (a) => resolve({ publicKey: { toString: () => a } }), reject };
      login();
    });
  bridge.disconnect = async () => {
    await logout();
  };
  bridge.signMessage = async (message) => {
    if (!ref.current) throw new Error("Connect your wallet first.");
    return { signature: (await signMessage({ message, wallet: ref.current })).signature };
  };
  bridge.signTransactionBytes = async (transaction) => {
    if (!ref.current) throw new Error("Connect your wallet first.");
    return (await signTransaction({ transaction, wallet: ref.current, chain })).signedTransaction;
  };
  return null;
}

const root = document.createElement("div");
document.body.append(root);
createRoot(root).render(
  createElement(
    PrivyProvider,
    {
      appId: cfg.appId,
      config: {
        loginMethods: ["email", "google", "wallet"],
        appearance: { walletChainType: "solana-only", theme: "dark", accentColor: "#22c55e" },
        externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" } },
        solana: {
          rpcs: {
            [chain]: {
              rpc: createSolanaRpc(`https://${host}`),
              rpcSubscriptions: createSolanaRpcSubscriptions(`wss://${host}`),
            },
          },
        },
      },
      children: createElement(Bind),
    },
  ),
);
