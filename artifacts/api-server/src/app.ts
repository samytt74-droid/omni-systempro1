import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import fs from "node:fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "6mb" }));
app.use(express.urlencoded({ extended: true, limit: "6mb" }));

app.use("/api", router);

// Dynamically resolve static dist folder
function getDistPath(): string | null {
  const envDist = process.env["FRONTEND_DIST"];
  if (envDist && fs.existsSync(path.join(envDist, "index.html"))) {
    return path.resolve(envDist);
  }

  const baseDir = typeof __dirname !== "undefined" ? __dirname : process.cwd();

  const candidates = [
    path.resolve(process.cwd(), "artifacts/pos-system/dist/public"),
    path.resolve(process.cwd(), "dist/public"),
    path.resolve(baseDir, "artifacts/pos-system/dist/public"),
    path.resolve(baseDir, "dist/public"),
    path.resolve(baseDir, "../dist/public"),
    path.resolve(baseDir, "../../dist/public"),
    path.resolve(process.cwd(), "dist"),
  ];

  for (const cand of candidates) {
    if (fs.existsSync(path.join(cand, "index.html"))) {
      return cand;
    }
  }
  return null;
}

// Serve static frontend files dynamically
app.use((req, res, next) => {
  const distPath = getDistPath();
  if (distPath) {
    express.static(distPath)(req, res, next);
  } else {
    next();
  }
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) {
    res.sendStatus(404);
    return;
  }
  const distPath = getDistPath();
  if (distPath) {
    res.sendFile(path.join(distPath, "index.html"), (err) => {
      if (err) {
        next();
      }
    });
  } else {
    next();
  }
});

export default app;
