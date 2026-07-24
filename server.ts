import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import app from "./artifacts/api-server/src/app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? "3000");

function serveStatic(expressApp: express.Express) {
  const candidates = [
    path.resolve(process.cwd(), "dist/public"),
    path.resolve(process.cwd(), "artifacts/pos-system/dist/public"),
    path.resolve(__dirname, "dist/public"),
    path.resolve(__dirname, "artifacts/pos-system/dist/public"),
  ];
  const distPath = candidates.find((p) => fs.existsSync(path.join(p, "index.html"))) || candidates[0];

  process.env.FRONTEND_DIST = distPath;
  expressApp.use(express.static(distPath));
  expressApp.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) {
      res.sendStatus(404);
      return;
    }
    res.sendFile(path.join(distPath, "index.html"), (err) => {
      if (err) next(err);
    });
  });
}

async function startServer() {
  const viteConfigPath = path.resolve(process.cwd(), "artifacts/pos-system/vite.config.ts");
  const hasViteConfig = fs.existsSync(viteConfigPath);

  if (process.env.NODE_ENV !== "production" && hasViteConfig) {
    try {
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
        configFile: viteConfigPath,
      });
      app.use(vite.middlewares);
    } catch (err) {
      console.warn("Failed to start Vite middleware, falling back to static dist:", err);
      serveStatic(app);
    }
  } else {
    serveStatic(app);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 OmniSystem POS Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
