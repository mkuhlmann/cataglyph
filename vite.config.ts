import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
    // Every SFC is a Vapor component (no virtual DOM); see the <script setup vapor> blocks.
    plugins: [vue({ features: { vapor: true } })],
    root: "src/view",
    base: "./",
    build: { outDir: "../../build/app/view", emptyOutDir: true, target: "esnext" },
    server: { port: 5173, strictPort: true },
});
