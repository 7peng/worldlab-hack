import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/api": "http://localhost:3001",
      "/chunks": "http://localhost:3001",
    },
  },
});
