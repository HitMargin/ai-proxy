// relay-capture.mjs — 捕获+透明转发代理
// ZCode → 127.0.0.1:9999（明文，全量落盘）→ https://zcode.z.ai（原样转发，流式回传）
import http from "node:http";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), ".tmp-capture");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "listener.log");
const UPSTREAM = "https://zcode.z.ai";
let n = 0;

function log(s) {
  const line = `[${new Date().toISOString()}] ${s}`;
  console.log(line);
  try { appendFileSync(LOG, line + "\n"); } catch {}
}

// 逐跳头不转发
const HOP = new Set(["host", "connection", "content-length", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "accept-encoding"]);

const server = http.createServer(async (req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const seq = ++n;
    const record = {
      seq, t: new Date().toISOString(),
      method: req.method, url: req.url, httpVersion: req.httpVersion,
      rawHeaders: req.rawHeaders, headers: req.headers,
      bodyPreview: body.subarray(0, 65536).toString("utf8"), bodyLen: body.length,
    };
    try { writeFileSync(join(OUT, `req-${String(seq).padStart(3, "0")}.json`), JSON.stringify(record, null, 2)); } catch {}
    const isMessages = req.url.includes("/messages");
    log(`#${seq} ${req.method} ${req.url} (${body.length}B)${isMessages ? "  <<< MODEL CALL CAPTURED" : ""}`);

    // 转发
    const fwdHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP.has(k.toLowerCase())) fwdHeaders[k] = v;
    }
    try {
      const upstream = await fetch(UPSTREAM + req.url, {
        method: req.method,
        headers: fwdHeaders,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
        redirect: "manual",
      });
      const respHeaders = {};
      upstream.headers.forEach((v, k) => {
        const lk = k.toLowerCase();
        if (lk === "content-encoding" || lk === "content-length" || lk === "transfer-encoding") return;
        respHeaders[k] = v;
      });
      res.writeHead(upstream.status, respHeaders);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      res.end();
      log(`#${seq} forwarded -> ${upstream.status}`);
    } catch (e) {
      log(`#${seq} forward ERROR ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "[capture relay] forward failed: " + e.message } }));
    }
  });
});
server.on("clientError", (_e, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
server.listen(9999, "127.0.0.1", () => log(`capture+forward relay ready on 127.0.0.1:9999 -> ${UPSTREAM}`));
