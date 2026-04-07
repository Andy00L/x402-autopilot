import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",      // Bind all interfaces (required for WSL2 Windows browser access)
    port: 5173,
    strictPort: false,     // Try next port if 5173 is taken
    allowedHosts: true,    // Allow all Host headers (WSL2 forwarding, GHSA-vg6x-rcgg-rjx6)
  },
});
