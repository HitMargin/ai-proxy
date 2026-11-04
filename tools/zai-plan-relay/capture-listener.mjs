// capture-listener.mjs — 明文捕获 ZCode 发往 zcodeEndpointOrigin 的真实请求（用户侧真值捕获）
// 输出：.tmp-capture/req-NNN.json + listener.log；响应 500 让客户端快速失败，不影响账号。
import http from "node:http";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), ".tmp-capture");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "listener.log");
let n = 0;

function log(s) {
  const line = `[${new Date().toISOString()}] ${s}`;
  console.log(line);
  try { appendFileSync(LOG, line + "\n"); } catch {}
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const record = {
      seq: ++n,
      t: new Date().toISOString(),
      method: req.method,
      url: req.url,
      httpVersion: req.httpVersion,
      rawHeaders: req.rawHeaders,
      headers: req.headers,
      bodyPreview: body.subarray(0, 65536).toString("utf8"),
      bodyLen: body.length,
    };
    writeFileSync(join(OUT, `req-${String(record.seq).padStart(3, "0")}.json`), JSON.stringify(record, null, 2));
    log(`#${record.seq} ${req.method} ${req.url} (${body.length}B) ua=${req.headers["user-agent"] ?? "-"}`);
    // 让客户端快速失败但拿到结构化错误
    const isMessages = req.url.includes("messages");
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: { type: "api_error", message: "[capture relay] 已捕获本请求，此为捕获模式的一次性错误，请正常重启 ZCode。" },
    }));
    if (isMessages) log(`!!! 模型调用已捕获：req-${String(record.seq).padStart(3, "0")}.json —— 可以关闭 ZCode 了`);
  });
});
server.on("clientError", (_e, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
server.listen(9999, "127.0.0.1", () => log(`listener ready on 127.0.0.1:9999, out=${OUT}`));
