/// <reference types="vite/client" />

// @solana/web3.js expects Node's Buffer global; polyfilled in main.tsx.
interface Window {
  Buffer: typeof import('buffer').Buffer
}
