/**
 * Wallet Standard test wallet for the browser e2e scripts (browser-e2e.mts, browser-hermetic.mts).
 *
 * No Phantom extension. `initScript()` returns a plain-JavaScript init script that registers a Wallet
 * Standard wallet in the page (`addInitScript`). The page sees only the public key. Every signature
 * (SIWS message, payment transaction) runs in THIS Node process through the exposed binding
 * `window.__tmaSign`, so the secret key never enters the page.
 */
import { createPrivateKey, sign as edSign } from "node:crypto";
import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface TestWallet {
  /** base58 public key */
  pub: string;
  keypair: Keypair;
  /** Number of signatures made, per kind. */
  signCalls: { message: number; transaction: number };
  signMessageB64(b64: string): string;
  signTransactionB64(b64: string): string;
  /** The binding for `context.exposeFunction("__tmaSign", ...)`. */
  sign(kind: string, b64: string): string;
  initScript(name: string): string;
}

/** `secretBytes` is the 64-byte Solana secret key. It is kept in this process and never printed. */
export function createTestWallet(secretBytes: Uint8Array): TestWallet {
  const keypair = Keypair.fromSecretKey(secretBytes);
  const pub = keypair.publicKey.toBase58();
  const edKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(secretBytes.subarray(0, 32))]), format: "der", type: "pkcs8" });
  const signCalls = { message: 0, transaction: 0 };

  function signMessageB64(b64: string): string {
    signCalls.message++;
    return edSign(null, Buffer.from(b64, "base64"), edKey).toString("base64");
  }

  function signTransactionB64(b64: string): string {
    signCalls.transaction++;
    const bytes = Buffer.from(b64, "base64");
    try {
      const tx = Transaction.from(bytes);
      tx.partialSign(keypair);
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    } catch {
      const vtx = VersionedTransaction.deserialize(bytes);
      vtx.sign([keypair]);
      return Buffer.from(vtx.serialize()).toString("base64");
    }
  }

  return {
    pub,
    keypair,
    signCalls,
    signMessageB64,
    signTransactionB64,
    sign: (kind, b64) => (kind === "message" ? signMessageB64(b64) : signTransactionB64(b64)),
    initScript: (name) => walletInitScript(pub, name),
  };
}

/**
 * Init script (plain JavaScript, kept as a string so the TypeScript loader cannot inject helpers into it).
 * It runs in the page before any app script and registers a Wallet Standard wallet that calls back
 * into Node (`window.__tmaSign`) to sign.
 */
function walletInitScript(pub: string, name: string): string {
  return `(() => {
  const pub = ${JSON.stringify(pub)};
  const name = ${JSON.stringify(name)};
  const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58dec = (s) => {
    const bytes = [0];
    for (const c of s) {
      let carry = ALPH.indexOf(c);
      for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
      while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (const c of s) { if (c === '1') bytes.push(0); else break; }
    return new Uint8Array(bytes.reverse());
  };
  const chains = ['solana:devnet', 'solana:mainnet', 'solana:testnet'];
  const account = { address: pub, publicKey: b58dec(pub), chains, features: ['solana:signMessage', 'solana:signTransaction'], label: 'TMA test', icon: undefined };
  const wallet = {
    version: '1.0.0',
    name,
    icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#3fd17f"/></svg>'),
    chains,
    get accounts() { return window.__tmaConnected ? [account] : []; },
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { window.__tmaConnected = true; return { accounts: [account] }; } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { window.__tmaConnected = false; } },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async (...inputs) => Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: unb64(await window.__tmaSign('message', b64(i.message))) }))),
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs) => Promise.all(inputs.map(async (i) => ({ signedTransaction: unb64(await window.__tmaSign('tx', b64(i.transaction))) }))),
      },
    },
  };
  const register = ({ register }) => register(wallet);
  window.addEventListener('wallet-standard:app-ready', (e) => register(e.detail));
  try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register })); } catch (e) {}
})();`;
}
