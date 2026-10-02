/**
 * 一次性探针：逐模型实发一次对话，确认哪些真能推理。
 * 需要 .tmp-trae-login.ts 跑出的 trae-auth.json。零目录成本，只烧少量 token。
 */
const cred = JSON.parse(await Deno.readTextFile("./trae-auth.json"));
const ENDPOINT = "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat";

function headers() {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": "TraeAgent/1.0.0",
    Authorization: `Cloud-IDE-JWT ${cred.access_token}`,
    "X-Cloudide-Token": cred.access_token,
    "X-Ide-Token": cred.access_token,
    "X-Uid": cred.uid,
    "X-App-Id": "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
    "X-App-Version": "default",
    "X-Ide-Version": "0.1.52",
    "X-Ide-Version-Code": "20260811",
    "X-App-Version-Code": "20260811",
    "X-Ide-Version-Type": "stable",
    "X-Device-Type": "macos",
    "X-OS-Version": "macOS 15.7.4",
    "X-Device-Brand": "Apple",
    "X-Machine-Id": cred.machine_id,
    "X-Device-Id": cred.device_id,
    "Request-Traffic-Type": "prod",
  };
}

async function ask(model: string, channel: string, label: string) {
  const body = {
    model,
    config_name: model,
    function: channel,
    stream: true,
    max_tokens: 32,
    // ⚠️ SOLO 的 content 必须是**数组**（实测：传字符串 → HTTP 400
    // "cannot unmarshal string into Go struct field ... of type []*LLMRawMessageContent"），
    // 不是我第一版以为的 OpenAI 标准字符串形态。
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "reply with the single word: ok" },
        ],
      },
    ],
  };
  const started = Date.now();
  try {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      const text = (await resp.text().catch(() => "")).slice(0, 160);
      console.log(`${label.padEnd(34)} HTTP ${resp.status}  ${text}`);
      return;
    }
    if (resp.body === null) {
      console.log(`${label.padEnd(34)} (empty body)`);
      return;
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "", frames = 0, text = "", sawError = null;
    let reasoningSeen = false, firstFrame = "";
    let usage = "", finishReason = "", textFrame = "";
    let tokens = "", upstreamModel = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      // SOLO 用的是 `event: <name>` + `data: {...}` 两行一组，
      // 事件名有 output / token_usage / done / error 四种。
      let eventName = "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload.length === 0 || payload === "[DONE]") continue;
        frames++;
        if (frames === 1) {
          firstFrame = `event=${eventName} data=${payload.slice(0, 220)}`;
        }
        try {
          const ev = JSON.parse(payload) as Record<string, unknown>;
          if (eventName === "error" || ev.error !== undefined) {
            sawError = JSON.stringify(ev.error ?? payload).slice(0, 140);
          }
          // ⚠️ 实测（2026-10-02 抓包）SOLO 的 `output` 事件形状是
          //   {"response":"正文增量","reasoning_content":"思考增量",
          //    "tool_calls":null,"multimodal_contents":null,"phase":null}
          // **正文字段叫 `response`，不是 `content`，也没有 `delta` 这一层。**
          // 我按 OpenAI 习惯连试 `delta.content` 与 `content` 都恒为 undefined，
          // 而流是通的（frames/finish=stop 都在）—— **「流通了但正文读不到」
          // 很容易被当成模型没说话。判据：读不到字段时先 dump 原始帧，别猜字段名。**
          if (eventName === "output") {
            if (typeof ev.response === "string" && ev.response.length > 0) {
              text += ev.response;
              if (textFrame.length === 0) textFrame = payload.slice(0, 160);
            }
            if (
              typeof ev.reasoning_content === "string" &&
              ev.reasoning_content.length > 0
            ) {
              reasoningSeen = true;
            }
          }
          // token_usage 走独立事件；extra_info 带真实 model 名与 token 数。
          if (eventName === "token_usage" || eventName === "extra_info") {
            if (ev.usage !== undefined) {
              usage = JSON.stringify(ev.usage).slice(0, 110);
            }
            const inTok = ev.input_token ??
              (ev.usage as Record<string, unknown> | undefined)?.prompt_tokens;
            const outTok = ev.output_token ??
              (ev.usage as Record<string, unknown> | undefined)
                ?.completion_tokens;
            if (inTok !== undefined || outTok !== undefined) {
              tokens = `in=${inTok ?? "?"} out=${outTok ?? "?"}`;
            }
            if (typeof ev.model === "string" && ev.model.length > 0) {
              upstreamModel = ev.model;
            }
          }
          if (eventName === "done") {
            finishReason = String(ev.reason ?? ev.finish_reason ?? "done");
          }
        } catch { /* 非 JSON 帧，跳过 */ }
      }
    }
    const ms = Date.now() - started;
    const got = text.trim().length > 0
      ? text.trim().replace(/\s+/g, " ").slice(0, 44)
      : "(NO TEXT)";
    console.log(
      `${label.padEnd(26)} ${String(frames).padStart(3)}f ${
        String(ms).padStart(5)
      }ms finish=${(finishReason || "-").padEnd(7)} think=${
        reasoningSeen ? "y" : "n"
      } text=[${got}]` +
        (sawError ? `\n     ERR=${sawError}` : ""),
    );
    if (label === SHOW_FRAME_FOR) {
      console.log("   textframe: " + textFrame);
      console.log("   tokens   : " + tokens + "  upstream=" + upstreamModel);
      console.log("   usage    : " + usage);
    }
  } catch (e) {
    console.log(
      `${label.padEnd(34)} ${
        (e instanceof Error ? e.message : String(e)).slice(0, 120)
      }`,
    );
  }
}

const SHOW_FRAME_FOR = "deepseek-v4.1-flash";
const targets = [
  ["deepseek-v4.1-flash", "solo_agent_remote"],
  ["glm-5.3-flash", "solo_agent"],
  ["qwen3.8-flash", "solo_agent"],
  ["DeepSeek-V4-Flash-Official", "solo_agent_remote"],
  ["Doubao-Seed-Code", "solo_agent_remote"],
  ["glm-5.3", "solo_agent_remote"],
  ["qwen3.8-max", "solo_agent_remote"],
];
console.log("model/channel                      frames     time  reply");
console.log("-".repeat(90));
for (const [m, c] of targets) await ask(m, c, m);
