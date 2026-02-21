#!/usr/bin/env node

/**
 * Minimal static server for the browser compatibility harness.
 *
 * Serves repository files from project root and defaults `/` to `/harness/`.
 */

import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT_DIR = process.cwd();
const DEFAULT_PORT = 4173;
const NORMALIZED_ROOT = path.resolve(ROOT_DIR);
const NORMALIZED_ROOT_WITH_SEP = `${NORMALIZED_ROOT}${path.sep}`;

/**
 * Basic MIME map for static assets used by the harness and dist outputs.
 */
const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Resolve an HTTP path to a filesystem path rooted at `ROOT_DIR`.
 */
function resolvePathname(urlPathname) {
  let pathname = decodeURIComponent(urlPathname);

  if (pathname === "/") {
    pathname = "/harness/";
  }

  if (pathname === "/harness") {
    pathname = "/harness/";
  }

  if (pathname.endsWith("/")) {
    pathname = `${pathname}index.html`;
  }

  const fsPath = path.resolve(ROOT_DIR, `.${pathname}`);
  if (fsPath !== NORMALIZED_ROOT && !fsPath.startsWith(NORMALIZED_ROOT_WITH_SEP)) {
    return null;
  }

  return fsPath;
}

/**
 * Return a mime type based on file extension.
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

/**
 * Parse `--port` argument if provided.
 */
function parsePort() {
  const portArgIndex = process.argv.findIndex((arg) => arg === "--port");
  if (portArgIndex !== -1) {
    const maybePort = Number(process.argv[portArgIndex + 1]);
    if (Number.isInteger(maybePort) && maybePort > 0) {
      return maybePort;
    }
  }

  const envPort = Number(process.env.PORT);
  if (Number.isInteger(envPort) && envPort > 0) {
    return envPort;
  }

  return DEFAULT_PORT;
}

const port = parsePort();

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      res.statusCode = 400;
      res.end("Bad request");
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const filePath = resolvePathname(requestUrl.pathname);

    if (!filePath) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const fileContents = await fs.readFile(filePath);

    res.statusCode = 200;
    res.setHeader("Content-Type", getMimeType(filePath));
    res.setHeader("Cache-Control", "no-store");
    res.end(fileContents);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.statusCode = 500;
    res.end(`Server error: ${message}`);
  }
});

server.listen(port, () => {
  console.log(`mic-to-mp3 harness server running at http://localhost:${port}/harness/`);
  console.log("Press Ctrl+C to stop.");
});
