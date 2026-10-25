import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { tma } from "vite-plugin-telegram-mini-app";
import { devkitSdk } from "./devkit-sdk.mjs";

// This token only authorizes the disposable scripts/qa_server.py environment.
export const QA_TOKEN = "123:local-qa-only";
const mode = process.env.QA_TOOL || "vite";
const source = fileURLToPath(new URL("../../app/miniapp_static/index.html", import.meta.url));
const appSource = fileURLToPath(new URL("../../app/miniapp_static/app.js", import.meta.url)).replaceAll("\\", "/");
const releaseVersion = readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim();

export default defineConfig({
  cacheDir: `node_modules/.vite-${mode}`,
  plugins: [
    {
      name: "polyrental-original-html",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (mode === "devkit" && req.url?.split("?")[0] === "/qa/devkit-sdk.js") {
            _res.setHeader("Content-Type", "application/javascript");
            _res.end(devkitSdk());
            return;
          }
          if (req.url?.split("?")[0] === "/miniapp") req.url = req.url.replace("/miniapp", "/index.html");
          next();
        });
      },
      transformIndexHtml: {
        order: "pre",
        handler(_html, context) {
          let html = readFileSync(source, "utf8").replaceAll("__APP_VERSION__", releaseVersion);
          if (new URL(context.originalUrl || "/", "http://localhost").searchParams.has("legacyCrypto")) {
            html = html.replace("</head>", '<script>Object.defineProperty(crypto,"randomUUID",{value:undefined});</script></head>');
          }
          // Keep startup ordered after the injected mock's module in Vite mode.
          if (mode === "vite") {
            const appScript = html.match(/<script defer src="([^"]*app\.js[^"]*)"><\/script>/);
            html = html.replace(appScript[0], "").replace("</body>", `<script type="module" src="/@fs/${appSource}"></script></body>`);
          }
          if (mode === "emulator") html = html.replace(/<script src="https:\/\/telegram.org\/js\/telegram-web-app.js\?64"><\/script>/,
            '<script src="http://localhost:1234/sdk.js"></script>');
          if (mode === "devkit") html = html.replace(/<script src="https:\/\/telegram.org\/js\/telegram-web-app.js\?64"><\/script>/,
            '<script src="/qa/devkit-sdk.js"></script>');
          return html;
        },
      },
    },
    ...(mode === "vite" ? [tma({
      botToken: QA_TOKEN, mode: "webapp", eruda: false,
      users: [{id:42, first_name:"Alice", last_name:"Adams"}, {id:43, first_name:"Bob"},
        {id:100, first_name:"QA Склад"}, {id:200, first_name:"QA Документы"}],
    })] : []),
  ],
  server: {
    host: "127.0.0.1",
    port: mode === "vite" ? 15173 : mode === "devkit" ? 15174 : 15175,
    strictPort: true,
    watch: { ignored: ["**/vendor/**", "**/artifacts/**", "**/.tma-devkit/**"] },
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url)), fileURLToPath(new URL("../../app/miniapp_static", import.meta.url))] },
    proxy: { "/api": "http://127.0.0.1:8001", "/miniapp/static": "http://127.0.0.1:8001" },
  },
});
