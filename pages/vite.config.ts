import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  // Place React Router first so Tailwind scans transformed modules
  plugins: [reactRouter(), tsconfigPaths(), tailwindcss()],
  server: {
    proxy: {
      // Proxy admin API to backend during dev to avoid CORS
      "/admin": {
        target: "http://localhost:51818",
        changeOrigin: true,
      },
    },
  },
});
