import http from "http";
import fs from "fs";
import path from "path";

// Production replacement for `python3 -m http.server 8880`.
// Serves only /alerts.json so nginx's /alerts.json proxy keeps working,
// but handles many concurrent pollers instead of serialising them on one thread.

const PORT = Number(process.env.FEED_PORT || 8880);
const HOST = process.env.FEED_HOST || "127.0.0.1";
const FEED_FILE = process.env.FEED_FILE || path.join(process.cwd(), "scanner", "data", "alerts.json");

const MIME_JSON = "application/json; charset=utf-8";

const server = http.createServer((req, res) => {
  if (req.url !== "/alerts.json") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  fs.readFile(FEED_FILE, "utf-8", (err, data) => {
    if (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Feed not ready");
      } else {
        console.error(`[FEED] Failed to read ${FEED_FILE}: ${err.message}`);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal error");
      }
      return;
    }

    res.writeHead(200, {
      "Content-Type": MIME_JSON,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(data);
  });
});

server.on("error", (err) => {
  console.error("[FEED] Server error:", err.message);
  process.exit(1);
});

server.on("clientError", (err, socket) => {
  console.error("[FEED] Client error:", err.message);
  try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch { /* socket already gone */ }
});

server.listen(PORT, HOST, () => {
  console.log(`[FEED] Serving ${FEED_FILE} at http://${HOST}:${PORT}/alerts.json`);
});
