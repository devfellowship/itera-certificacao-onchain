import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// apps/web2 is the web2 client of TestMyAgent (Login with DFL, no wallet). apps/web is the web3 client.
// Dev port 5174, so both clients run side by side (apps/web uses the Vite default 5173).
export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
})
