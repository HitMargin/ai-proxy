/// <reference lib="dom" />
// 匿名探测各平台推理端点：不问你要账号的话，这些类似 cnb 的平台能不能直接用。
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const targets: Array<{ name: string; url: string; post?: boolean }> = [
  {
    name: "github-models/catalog",
    url: "https://models.github.ai/catalog/models",
  },
  {
    name: "github-models/inference",
    url: "https://models.github.ai/inference/chat/completions",
    post: true,
  },
  {
    name: "modelscope/v1/models",
    url: "https://api-inference.modelscope.cn/v1/models",
  },
  {
    name: "modelscope/chat",
    url: "https://api-inference.modelscope.cn/v1/chat/completions",
    post: true,
  },
  { name: "gitee-ai/v1/models", url: "https://ai.gitee.com/v1/models" },
  {
    name: "gitee-ai/chat",
    url: "https://ai.gitee.com/v1/chat/completions",
    post: true,
  },
  { name: "gitcode/api/v5", url: "https://api.gitcode.com/api/v5/" },
  { name: "gitcode/ai", url: "https://gitcode.com/ai" },
  { name: "codeberg/api", url: "https://codeberg.org/api/v1/version" },
  { name: "gitlab/metadata", url: "https://gitlab.com/api/v4/metadata" },
];
async function one(t: any) {
  const started = Date.now();
  try {
    const r = await fetch(t.url, {
      method: t.post ? "POST" : "GET",
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        ...(t.post ? { "content-type": "application/json" } : {}),
      },
      body: t.post
        ? JSON.stringify({
          model: "deepseek-v4.1-flash",
          stream: false,
          max_tokens: 4,
          messages: [{ role: "user", content: "hi" }],
        })
        : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const txt = await r.text();
    return t.name.padEnd(26) + " http=" + r.status + " " +
      (Date.now() - started) + "ms  " + txt.replace(/\s+/g, " ").slice(0, 150);
  } catch (e: any) {
    return t.name.padEnd(26) + " EXC " + (Date.now() - started) + "ms " +
      (e?.name || "") + ": " + String(e?.message || e).slice(0, 90);
  }
}
for (const t of targets) console.log(await one(t));
console.log("PROBE-DONE");
