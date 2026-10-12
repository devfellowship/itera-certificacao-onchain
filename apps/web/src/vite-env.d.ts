/// <reference types="vite/client" />

// @solana/web3.js expects Node's Buffer global; polyfilled in main.tsx.
interface Window {
  Buffer: typeof import('buffer').Buffer
}

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  /** 'design' = MSW fixture mode (U2). Never set in production. */
  readonly VITE_FIXTURE_MODE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
