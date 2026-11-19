import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The hub serves this app as plain static files (see `hub/server.ts`): the
 * build lands in `hub/ui/dist/` and the server streams `dist/index.html` at
 * `/` plus everything under `dist/assets/`. Nothing is rendered server-side,
 * so the output has to be self-contained and reference its assets by a
 * root-relative path — hence `base: "/"` and the default `assets/` layout.
 *
 * `server.proxy` only matters for `npm run dev` (Vite's own port): API calls
 * are forwarded to the running hub so the dev server behaves like production
 * without CORS or a second token. The hub's port comes from
 * ~/.target/config.json; 8893 is its default (see scripts/start.ts).
 */
const HUB_ORIGIN = (process.env.TARGET_HUB_ORIGIN ?? "http://127.0.0.1:8893").replace(/\/+$/, "");

export default defineConfig({
	plugins: [react()],
	base: "/",
	build: {
		outDir: "dist",
		emptyOutDir: true,
		// A local single-user tool — sourcemaps cost nothing here and make a
		// production stack trace readable.
		sourcemap: true,
	},
	server: {
		port: 5173,
		proxy: {
			// changeOrigin rewrites Host to the hub. The browser's Origin is
			// still this dev server (port 5173), which the hub refuses on
			// POST/PUT/PATCH/DELETE. Rewrite Origin to the hub so dev writes
			// stay a same-origin call. A page on another port never passes
			// through this proxy, so it cannot hide behind the rewrite.
			"/api": {
				target: HUB_ORIGIN,
				changeOrigin: true,
				configure: (proxy) => {
					proxy.on("proxyReq", (proxyReq, req) => {
						if (req.headers.origin) proxyReq.setHeader("origin", HUB_ORIGIN);
					});
				},
			},
			"/health": { target: HUB_ORIGIN, changeOrigin: true },
			"/favicon.svg": { target: HUB_ORIGIN, changeOrigin: true },
		},
	},
});
