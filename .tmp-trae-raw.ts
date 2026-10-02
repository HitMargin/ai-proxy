const cred = JSON.parse(await Deno.readTextFile("./trae-auth.json"));
const resp = await fetch(
  "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat",
  {
    method: "POST",
    headers: {
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
    },
    body: JSON.stringify({
      model: "deepseek-v4.1-flash",
      config_name: "deepseek-v4.1-flash",
      function: "solo_agent_remote",
      stream: true,
      max_tokens: 24,
      messages: [{
        role: "user",
        content: [{ type: "text", text: "Say only: ok" }],
      }],
    }),
    signal: AbortSignal.timeout(45_000),
  },
);
const body = await resp.text();
console.log("HTTP " + resp.status + "  bytes=" + body.length);
console.log("---- RAW (first 1800 chars) ----");
console.log(body.slice(0, 1800));
