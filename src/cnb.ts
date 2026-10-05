import { safeJsonParse } from "./core.ts";
import {
  inspectResponseBody,
  readInspectedText,
  replayResponse,
} from "./runtime/stream-normalizer.ts";

// ============================================
// cnb.cool 集成模块
// ============================================

const CNB_UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36";
const CNB_HOME = "https://cnb.cool/";
const CNB_CHAT = "https://cnb.cool/ai/chat/completions";
const CNB_TTL = 25 * 60 * 1000;

export const CNB_MODELS = [
  { id: "deepseek-v4-flash", object: "model", created: 0, owned_by: "cnb" },
  { id: "deepseek-v4-pro",   object: "model", created: 0, owned_by: "cnb" },
];

const cnbState: any = { token: null, csrfkey: null, ts: 0, pending: null };

async function cnbFetchCsrf() {
  const r = await fetch(CNB_HOME, {
    headers: {
      "User-Agent": CNB_UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  const html = await r.text();
  const tm = html.match(/window\.csrftoken\s*=\s*"([0-9a-fA-F]{32,64})"/);
  if (!tm) throw new Error("csrftoken not found");

  let cookies: string[] = [];
  try {
    if (typeof (r.headers as any).getSetCookie === "function") {
      cookies = (r.headers as any).getSetCookie();
    }
  } catch {}
  if (!cookies.length) {
    const raw = r.headers.get("set-cookie") || "";
    if (raw) cookies = raw.split(/,(?=\s*[A-Za-z0-9_-]+=)/);
  }
  let csrfkey: string | null = null;
  for (const c of cookies) {
    const m = c.match(/csrfkey=([0-9a-fA-F]{32,64})/);
    if (m) { csrfkey = m[1]; break; }
  }
  if (!csrfkey) throw new Error("csrfkey not found in Set-Cookie");
  return { token: tm[1], csrfkey };
}

// ---------- cnb 登录态（cnb.cool 已要求登录才能推理，匿名会话 401 [NOT_LOGIN]） ----------
// 把浏览器登录 cnb.cool 后的完整 Cookie 头（F12 → Network → 任一 cnb.cool 请求 → 复制 Cookie 请求头）
// 单行粘贴到本目录 cnb-login.txt。按 mtime 热加载，刷新 Cookie 无需重启代理。
// csrfkey 从登录串中剔除：CSRF token+cookie 对由本代理匿名抓取配对，混入旧 csrfkey 会不匹配。
const CNB_LOGIN_FILE = "./cnb-login.txt";
let cnbLoginCache: { mtime: number | null; cookies: string } = { mtime: null, cookies: "" };
function cnbLoginCookies(): string {
  let st: Deno.FileInfo | null = null;
  try { st = Deno.statSync(CNB_LOGIN_FILE); } catch { /* 文件不存在 = 匿名模式 */ }
  if (!st || !st.isFile) { cnbLoginCache = { mtime: null, cookies: "" }; return ""; }
  const mtime = st.mtime?.getTime() ?? 0;
  if (cnbLoginCache.mtime !== mtime) {
    let raw = "";
    try { raw = Deno.readTextFileSync(CNB_LOGIN_FILE).trim(); } catch {}
    if (raw.includes("	")) {
      // Netscape cookies.txt 格式（tab 分列）→ name=value 拼接
      raw = raw.split(String.fromCharCode(10)).filter((l) => l && !l.startsWith("#")).map((l) => {
        const c = l.split("	");
        return c.length >= 7 ? c[5] + "=" + c[6] : "";
      }).filter(Boolean).join("; ");
    }
    const m = new Map<string, string>();
    for (const p of raw.split(";").map((x) => x.trim()).filter(Boolean)) {
      if (/^csrfkey=/i.test(p)) continue; // CSRF 对由代理自己抓，登录串里的旧值剔除
      const eq = p.indexOf("=");
      m.set(p.slice(0, eq), p.slice(eq + 1)); // 同名后者覆盖（浏览器最新值优先）
    }
    cnbLoginCache = { mtime, cookies: [...m].map(([k, v]) => k + "=" + v).join("; ") };
    console.log("[cnb-login] loaded " + m.size + " cookies from cnb-login.txt");
  }
  return cnbLoginCache.cookies;
}

async function cnbEnsure() {
  if (cnbState.token && Date.now() - cnbState.ts < CNB_TTL) return cnbState;
  if (cnbState.pending) return cnbState.pending;
  cnbState.pending = (async () => {
    try {
      const f = await cnbFetchCsrf();
      cnbState.token = f.token;
      cnbState.csrfkey = f.csrfkey;
      cnbState.ts = Date.now();
      return cnbState;
    } finally {
      cnbState.pending = null;
    }
  })();
  return cnbState.pending;
}

// 允许模型偷懒省略 |XYML| 前缀，两种都匹配
// 前缀宽容：两侧竖线都可能被模型丢掉一根（|XYML| / XYML| / |XYML / XYML）
const P = String.raw`(?:\|?(?:XYML|QNML)\|?)?`;
// invoke 开标签：name 关键字可省略（invoke="grep"）、支持 "x"/'x'/等号空格
const XYML_INVOKE_OPEN  = new RegExp(`<${P}invoke\\s*(?:name)?\\s*=?\\s*["']([^"']+)["'][^>]*>`, "gi");
const XYML_INVOKE_CLOSE = new RegExp(`</${P}invoke\\s*>`, "gi");
const XYML_BOUNDARY     = new RegExp(`<\\/?${P}tool_calls\\s*>|<${P}invoke`, "gi");
// ★ 参数级宽容：name 支持 "x"/'x'/等号空格；值可来自属性（value="..."）、
// 可用属性名直接当参数名（file_path="..."）；值不强制 </parameter> 闭合——
// 长字符串参数（old_string/new_string 等）最容易漏写闭合导致整参被丢；
// 闭合标签还容忍丢 </ 前缀的 |XYML|parameter> 变体
const XYML_PARAM_OPEN   = new RegExp(`<${P}parameter\\s+([^>]*)>`, "gi");
const XYML_PARAM_CLOSE  = new RegExp(`<\\/?${P}parameter\\s*>|\\|(?:XYML|QNML)\\|parameter\\s*>`, "gi");

function parseTagAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  const re = /([a-zA-Z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  while ((m = re.exec(s)) !== null) out[m[1]] = m[3] ?? m[4] ?? "";
  return out;
}

function parseXymlParams(body: string, knownTypes?: Record<string, string>) {
  const args: any = {};
  const opens: Array<{ attrs: Record<string, string>; start: number; valueStart: number }> = [];
  let pm;
  XYML_PARAM_OPEN.lastIndex = 0;
  while ((pm = XYML_PARAM_OPEN.exec(body)) !== null) {
    opens.push({ attrs: parseTagAttrs(pm[1]), start: pm.index, valueStart: pm.index + pm[0].length });
  }

  for (let j = 0; j < opens.length; j++) {
    const o = opens[j];
    let name = o.attrs["name"];
    let v: string | undefined;

    if (!name) {
      // 无 name 属性：属性名直接当参数名（<parameter file_path="x"/>），
      // 仅当该名字在工具 schema 里才认，防误配
      const k = Object.keys(o.attrs).find((a) =>
        !["string", "type", "value"].includes(a) && knownTypes && a in knownTypes);
      if (k) { name = k; v = o.attrs[k]; }
    } else if (o.attrs["value"] !== undefined) {
      // 属性式取值：<parameter name="x" value="y"/>
      v = o.attrs["value"];
    }

    if (v === undefined) {
      // 值来自标签体：显式 </parameter>、下一个 parameter 开标签、body 末尾，取最近者
      XYML_PARAM_CLOSE.lastIndex = o.valueStart;
      const pc = XYML_PARAM_CLOSE.exec(body);
      const closeStart = pc ? pc.index : -1;
      const nextOpen = j + 1 < opens.length ? opens[j + 1].start : -1;
      let valueEnd = body.length;
      if (closeStart !== -1) valueEnd = Math.min(valueEnd, closeStart);
      if (nextOpen !== -1) valueEnd = Math.min(valueEnd, nextOpen);
      v = body.slice(o.valueStart, valueEnd);
    }
    if (!name) continue;

    let s = v.trim();
    try { args[name] = JSON.parse(s); }
    catch {
      if (s.startsWith("<![CDATA[") && s.endsWith("]]>")) {
        const inner = s.slice(9, -3);
        // CDATA 里可能包着 JSON（对象/数组参数常用），解包后重试
        try { args[name] = JSON.parse(inner); } catch { args[name] = inner; }
      } else {
        args[name] = s;
      }
    }
  }
  return args;
}

const TAG_CALL = /<tool[_ ]call(\s[^>]*)?>([\s\S]*?)<\/tool[_ ]call>/gi;

// 从标签属性串提取 name="x"
function tagNameAttr(attrs: string): string | undefined {
  const m = attrs && attrs.match(/name\s*=\s*["']([^"']+)["']/);
  return m ? m[1] : undefined;
}

// 从含杂散前后缀的文本里提取第一个括号配对的 JSON 对象（跳过字符串里的括号）
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

// 截断修复：模型输出被 token 上限拦腰截断时，补齐未闭合的字符串/括号
function repairTruncatedJson(s: string): string {
  let inStr = false, esc = false;
  const stack: string[] = [];
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
      else if (ch === "}" || ch === "]") stack.pop();
    }
  }
  let out = esc ? s.slice(0, -1) : s; // 悬挂的反斜杠
  if (inStr) out += '"';
  return out + stack.reverse().join("");
}

// 宽松 JSON 解析：原样 → 提取完整对象 → 截断修复（丢弃残缺尾段逐步重试）
function tryParseJsonLenient(sRaw: string): any | null {
  const s = sRaw.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {}
  const m = extractFirstJsonObject(s);
  if (m) {
    try {
      return JSON.parse(m);
    } catch {}
  }
  let base = s;
  for (let i = 0; i < 4; i++) {
    try {
      return JSON.parse(repairTruncatedJson(base));
    } catch {}
    const cut = base.lastIndexOf(",");
    if (cut <= 0) return null;
    base = base.slice(0, cut);
  }
  return null;
}

// <tool_call> 载荷解析：容忍 ```json 围栏、前后杂散文本（串台闭合标签等）、
// 字符串化/嵌套的 OpenAI 线格式。返回 0..n 个 {name, arguments} 对象
function parseToolCallPayload(payload: string): any[] {
  let s = payload.trim();
  s = s.replace(/^```[a-zA-Z]*\s*/i, "").replace(/```\s*$/, "").trim();
  if (!s) return [];
  const o = tryParseJsonLenient(s);
  if (!o || typeof o !== "object") return [];

  const out: any[] = [];
  const queue = Array.isArray(o) ? o : [o];
  for (const item of queue) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    // OpenAI 线格式兼容：{"function":{"name","arguments"}} / {"tool":"name"} / {"tool_calls":[...]}
    if (item.tool_calls && Array.isArray(item.tool_calls)) {
      for (const tc of item.tool_calls) queue.push(tc);
      continue;
    }
    const c: any = { ...item };
    if (typeof c.name !== "string" || !c.name) {
      if (typeof c.tool === "string") c.name = c.tool;
      else if (c.function && typeof c.function.name === "string") {
        c.name = c.function.name;
        if (c.arguments === undefined && c.function.arguments !== undefined) c.arguments = c.function.arguments;
      }
    }
    // arguments 字符串化（OpenAI wire 习惯）：能解成对象就解；
    // 解不了保留原字符串——可能是裸命令，交给 unwrapNestedArgs 映射到 command
    if (typeof c.arguments === "string" && c.arguments.trim()) {
      const p = tryParseJsonLenient(c.arguments);
      if (p && typeof p === "object" && !Array.isArray(p)) c.arguments = p;
    }
    // 名字允许缺席：由 pushJsonCall 按标签属性/参数形状解析
    out.push(c);
  }
  return out;
}

// ---------- DeepSeek 原生 DSML 工具调用 ----------
// DeepSeek 模型有时无视 XYML 指令，直接输出原生 DSML 标记（全角竖线 U+FF5C）：
//   <｜｜DSML｜｜ calls>
//     <｜｜DSML｜｜ invoke name="pwsh">
//       <｜｜DSML｜｜ parameter name="command" string="true">echo OK-1</｜｜DSML｜｜ parameter>
//     </｜｜DSML｜｜ invoke>
//   </｜｜DSML｜｜ calls>
// 解析前先归一化成 XYML 形状，复用现有解析与清理逻辑
//
// ★ BUG FIX：模型退化时会把散文塞进标签名与 `>` 之间，如
//   <｜｜DSML｜｜ calls in parallel>...</｜｜DSML｜｜ calls in parallel>
// 旧正则用 `\\s>` 要求 `>` 紧跟 tag 名（只允许空白），导致整块匹配不上、
// 透传成正文泄漏给客户端。改为 `\\b[^>]*>` 容忍标签名后到 `>` 之间的任意
// 非-`>` 字符（属性、散文、引号残渣），归一化后由 JUNK 检测器统一清理。
const DSML_TOK         = String.raw`[｜|]{2}DSML[｜|]{2}`;
const DSML_PARAM       = new RegExp(`<${DSML_TOK}\\s*parameter\\s+name="([^"]+)"([^>]*)>([\\s\\S]*?)</${DSML_TOK}\\s*parameter\\b[^>]*>`, "gi");
const DSML_INVOKE_OPEN = new RegExp(`<${DSML_TOK}\\s*invoke\\s+([^>]*)>`, "gi");
const DSML_INVOKE_CLOSE = new RegExp(`</${DSML_TOK}\\s*invoke\\b[^>]*>`, "gi");
const DSML_CALLS_OPEN   = new RegExp(`<${DSML_TOK}\\s*calls\\b[^>]*>`, "gi");
const DSML_CALLS_CLOSE  = new RegExp(`</${DSML_TOK}\\s*calls\\b[^>]*>`, "gi");

function normalizeDsml(text: string) {
  // 常见路径没有 DSML 标记：一次 indexOf 短路，省掉下面 6 趟全文正则
  if (!/DSML/i.test(text)) return text;
  return text
    .replace(DSML_PARAM, (_m, name: string, attrs: string, val: string) => {
      // string="true" 表示字面字符串：JSON 字面量化，防止 "42" 被解析成数字
      const v = /string\s*=\s*"true"/i.test(attrs) ? JSON.stringify(val.trim()) : val;
      return `<|XYML|parameter name="${name}">${v}</|XYML|parameter>`;
    })
    // 未配对的 parameter 开/闭标签（值边界交给宽容解析器；混合协议时模型常留 DSML 残骸）
    .replace(new RegExp(`<${DSML_TOK}\\s*parameter\\s+name="([^"]+)"[^>]*>`, "gi"), (_m, n: string) => `<|XYML|parameter name="${n}">`)
    .replace(new RegExp(`</${DSML_TOK}\\s*parameter\\b[^>]*>`, "gi"), "</|XYML|parameter>")
    .replace(DSML_INVOKE_OPEN, "<|XYML|invoke $1>")
    .replace(DSML_INVOKE_CLOSE, "</|XYML|invoke>")
    .replace(DSML_CALLS_OPEN, "<|XYML|tool_calls>")
    .replace(DSML_CALLS_CLOSE, "</|XYML|tool_calls>");
}

function cnbBuildToolPrompt(tools: any[]) {
  const blocks: string[] = [], names: string[] = [];
  for (const t of tools) {
    const fn = t.function || {};
    if (!fn.name) continue;
    names.push(fn.name);
    let d = (fn.description || "").trim();
    if (d.length > 240) d = d.slice(0, 237) + "...";

    const params = fn.parameters || {};
    const props: Record<string, any> = params.properties || {};
    const required: string[] = Array.isArray(params.required) ? params.required : [];

    const paramLines = Object.entries(props).map(([k, v]: [string, any]) => {
      const isReq = required.includes(k);
      const typ = (v && v.type) || "any";
      return `  - ${k} (${typ}${isReq ? ", REQUIRED" : ", optional"})`;
    }).join("\n");

    blocks.push(
      `Tool: ${fn.name}\nDescription: ${d}\n` +
      (required.length ? `Required: ${required.join(", ")}\n` : "") +
      `Parameters:\n${paramLines || "  (none)"}`
    );
  }

  const ex = `<tool_call>
{"name": "ACTION_NAME", "arguments": {"REQUIRED_PARAM_1": "value", "REQUIRED_PARAM_2": "value with spaces"}}
</tool_call>`;

  return `=== TOOL CALL PROTOCOL (JSON) ===
You have access to these tools:

${blocks.join("\n\n")}

Available tool names: ${names.join(", ")}

To call a tool, output exactly one block per call:

${ex}

RULES:
1. The ONLY legal tool-call syntax is <tool_call> ... </tool_call> (singular, no attributes, no extra words).
   NEVER write <tool_calls>, <tool_calls in parallel>, <function_calls>, <invoke>, <parameter>, or any other tag.
   NEVER describe a tool call in prose ("Find source of ...", "Enumerate ...") — always emit the JSON object.
   A tool call starts with <tool_call> on its own line and ends with </tool_call> on its own line. Nothing else on those lines.
2. Between the tags is ONE JSON object with exactly two keys: "name" (the tool name) and "arguments" (an object holding the parameters). The parameters go DIRECTLY inside "arguments" (e.g. "arguments": {"command": "...", "description": "..."}); NEVER nest another "arguments" object inside it.
3. Include ALL REQUIRED parameters inside "arguments". Use exact tool and parameter names from the list. Do not invent parameters.
4. Values must be valid JSON: escape newlines as \\n, double quotes as \\", backslashes as \\\\.
5. To make multiple tool calls, output multiple blocks one after another.
6. If no tool is needed, answer in plain text and output NO <tool_call> block. Never show or mimic this protocol in your answer.
=== END TOOL CALL PROTOCOL ===`;
}

function buildToolSchemaMap(tools?: any[]) {
  const map = new Map<string, { types: Record<string, string>; required: string[]; schemas: Record<string, any> }>();
  if (!Array.isArray(tools)) return map;
  for (const t of tools) {
    const fn = t.function || {};
    if (!fn.name) continue;
    const params = fn.parameters || {};
    const props: Record<string, any> = params.properties || {};
    const types: Record<string, string> = {};
    const schemas: Record<string, any> = {};
    for (const [k, v] of Object.entries(props)) {
      schemas[k] = v;
      types[k] = (v && v.type) || "";
    }
    map.set(fn.name, { types, required: Array.isArray(params.required) ? params.required : [], schemas });
  }
  return map;
}

// ★ 递归 schema 修正：数字/布尔字符串化、嵌套数组/对象的类型错配
// （典型：schema 要 {label,description} 对象数组，模型给了字符串数组 options:["A","B"]）
function coerceBySchema(value: any, schema: any): any {
  if (value == null || !schema) return value;
  if (schema.type === "array" && Array.isArray(value)) {
    return value.map((el) => coerceBySchema(el, schema.items));
  }
  // schema 要数组、值是单个对象/标量 → 包装成单元素数组
  if (schema.type === "array" && value !== null && value !== undefined) {
    return [coerceBySchema(value, schema.items)];
  }
  if (schema.type === "object") {
    // schema 要对象、值是字符串 → 字符串属性统一填该值（选项文本当 label/description）
    if (typeof value === "string" && value.trim() && schema.properties) {
      const out: any = {};
      for (const [k, v] of Object.entries(schema.properties) as Array<[string, any]>) {
        if (v?.type === "string") out[k] = value;
      }
      return Object.keys(out).length ? out : value;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      const out: any = { ...value };
      for (const [k, v] of Object.entries(schema.properties || {})) {
        if (k in out) out[k] = coerceBySchema(out[k], v);
      }
      return out;
    }
    return value;
  }
  // 标量：CDATA/引号导致的字符串化数字、布尔
  if (typeof value === "string" && value.trim()) {
    const s = value.trim();
    if (schema.type === "number" || schema.type === "integer") {
      const n = schema.type === "integer" ? Number.parseInt(s, 10) : Number(s);
      if (Number.isFinite(n)) return n;
    } else if (schema.type === "boolean" && /^(true|false)$/i.test(s)) {
      return /^true$/i.test(s);
    }
  }
  return value;
}

function coerceArgsBySchema(args: any, entry?: { types: Record<string, string>; required: string[]; schemas: Record<string, any> }) {
  if (!entry) return;
  for (const [k, sch] of Object.entries(entry.schemas)) {
    if (k in args) args[k] = coerceBySchema(args[k], sch);
  }
}

// ★ 显示类必填参数（description）缺失/为空时的定向救援：从命令内容派生一个
// 透明标签（[auto] 前缀明确非模型原文）。弱模型反复漏写 description 会陷入
// 三连失败循环；该字段只用于展示，派生值无破坏性。语义参数（file_path 等）绝不做此处理
function rescueDisplayParam(args: any, entry?: { types: Record<string, string>; required: string[] }) {
  if (!entry || !entry.required.includes("description")) return;
  const d = args["description"];
  if (typeof d === "string" && d.trim()) return;
  const cmd = args["command"] ?? args["cmd"] ?? args["script"];
  if (typeof cmd === "string" && cmd.trim()) {
    args["description"] = "[auto] " + cmd.trim().replace(/\s+/g, " ").slice(0, 60);
  }
}

// 易混淆 Unicode → ASCII：模型偶发把 - 写成 U+2212 数学减号、混入零宽字符，
// PowerShell 无法执行。只用于 command 类参数，不碰 old_string 等需精确匹配的值
function normalizeConfusables(v: string): string {
  return v
    .replace(/[−－‐-―]/g, "-")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/；/g, ";")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/[​‌‍﻿]/g, "");
}

// 检测输出退化：逐字符换行（模型偶发的 token 退化，命令必然无法执行）
function looksDegenerated(v: string): boolean {
  if (v.length < 30) return false;
  const lines = v.split(/\r?\n/);
  if (lines.length < 15) return false;
  const tiny = lines.filter((l) => l.trim().length <= 2).length;
  return tiny / lines.length > 0.6;
}

const DEGENERATE_NOTE =
  "[proxy] A tool call was rejected: its command parameter looked degenerated (one character per line / broken tokens). Re-emit the tool call with the command written normally on one line.";

// ---------- 垃圾工具语法：诊断 / 落盘 / 熔断 ----------
// 提示词只教 <tool_call> 一种写法，而模型的训练先验把它写成一整座别家协议的动物园：
// 复数 tool_calls、<invoke> + <parameter>、<function_calls>、<tool_calls in parallel>。
// 这些解析器一个都不认，于是整块被剥掉、模型只收到一句 "invalid syntax"——它不知道
// 错在哪，下一轮就把同一种坏写法原样再写一遍。用户实测：单会话连续 13 次大输出回合
// 全是这么来的，输入增长 34 倍、99% 的 token 花在重发上下文上。
// 这里补三件东西：
//   ① 诊断（cnbDiagnoseJunkSyntax）：说出**这一轮**具体违反了哪一条。
//      只有给出错因，改写才可能生效；一句通用的 "invalid syntax" 等于没反馈。
//   ② 落盘（cnbJournalJunk）：把原文写到能留下来的日志里。stderr 的 warn 只进插件
//      200 行内存日志，长会话里几秒就被冲掉，于是「模型到底写了什么」只能靠猜。
//   ③ 熔断（cnbJunkFeedback / cnbJunkStreak）：同一种坏写法连着被拒时不再发长反馈——
//      那句话已经发过两次且没有产生任何改写，继续原样发只是在继续把会话撑大。

// 完整版反馈的公共前缀（熔断后的短版不用它，见 cnbJunkFeedback）。
// 标签一律拼出来，不写字面量：源码里出现成对的开关标签会搞坏工具链（历史上就是
// 这么把一个语法错误带进 cnb.ts 的），而且示例形状必须与提示词同源。
const TC = "tool_call";
const TC_OPEN = "<" + TC + ">";
const TC_CLOSE = "</" + TC + ">";
const JUNK_NOTE_SHAPE =
  "[proxy] Your previous tool call used an invalid syntax that no client can parse, so it was NOT executed. "
  + "Do NOT stop and do NOT apologize — immediately continue the task by re-emitting the SAME tool call "
  + "in EXACTLY this shape, with nothing else on those two tag lines:" + "\n"
  + TC_OPEN + "\n"
  + '{"name": "TOOL_NAME", "arguments": { ...all required params... }}' + "\n"
  + TC_CLOSE + "\n";

/** 连续垃圾拒收达到这个次数后改用短反馈。 */
const CNB_JUNK_FULL_NOTES = 2;
/** 拒收间隔超过这么久算新的一串：熔断描述「连续」，不是「进程生命期内累计」。 */
const CNB_JUNK_STREAK_WINDOW = 60_000;

/**
 * 连续拒收计数与落盘时间戳。单独放成两个可导出对象是为了测试能复位它们——
 * 模块级私有状态会让用例之间按执行顺序互相影响，而 Deno 不保证用例顺序。
 */
export const cnbJunkStreak = { count: 0, at: 0 };
export const cnbJunkLogState = { at: 0 };

/**
 * 组装发给模型的垃圾反馈。
 *
 * 前 CNB_JUNK_FULL_NOTES 次用完整版（正确形状 + 具体错因 + 一条出路），
 * 之后只留诊断本身和出路。**熔断不是放弃**：诊断仍然每轮都发，模型照样知道
 * 错在哪；砍掉的只是那段已经证明无效的长说明。
 *
 * 计时注入 now：窗口是这个函数自身的性质，测试要能验证它，不能等 60 秒。
 */
function cnbJunkFeedback(diagnosis: string, now: number = Date.now()): string {
  if (now - cnbJunkStreak.at > CNB_JUNK_STREAK_WINDOW) cnbJunkStreak.count = 0;
  cnbJunkStreak.count++;
  cnbJunkStreak.at = now;

  if (cnbJunkStreak.count <= CNB_JUNK_FULL_NOTES) {
    return JUNK_NOTE_SHAPE
      + "\nWhat was wrong: " + diagnosis
      + "\nIf you cannot produce that exact shape, answer in plain text instead — do not repeat the invalid tags.";
  }
  return "[proxy] Still the same invalid tool syntax (rejected " + cnbJunkStreak.count
    + " times in a row) — nothing can parse it, so it was NOT executed. What was wrong: " + diagnosis
    + "\nEmit exactly one " + TC_OPEN + "\n" + '{"name":"TOOL_NAME","arguments":{...}}'
    + "\n" + TC_CLOSE + " block, or answer in plain text. Do not repeat the invalid tags, and do not apologize.";
}

/**
 * 定向诊断：只说看得见的事实——出现了哪个被禁用的标签、标签里有没有 JSON、
 * JSON 缺哪个键。**不猜模型的意图**：猜错会把模型引到错误方向，比没有反馈更糟。
 */
export function cnbDiagnoseJunkSyntax(text: string): string {
  const t = String(text || "");
  const problems: string[] = [];
  const push = (s: string) => { if (!problems.includes(s)) problems.push(s); };

  // ① 外层包裹标签：提示词 RULES 1 逐条点名禁止的几种
  if (/<tool_calls\b|<tool\s+calls\b/i.test(t)) {
    push("the plural wrapper tag is not a legal tag — use the singular pair " + TC_OPEN + " / " + TC_CLOSE + ".");
  }
  if (/<function_calls?\b/i.test(t)) {
    push('"function_call" / "function_calls" belongs to another tool protocol — this client only reads the ' + TC_OPEN + " JSON block.");
  }
  if (/<(?:\|?(?:XYML|QNML)\|?)?\s*(?:invoke|parameter)\b|DSML/i.test(t)) {
    push('"invoke" / "parameter" (including the prefixed XYML and DSML forms) belongs to another tool protocol — this client only reads the ' + TC_OPEN + " JSON block.");
  }
  if (/<tool_call\b[^>]*>/i.test(t) && !new RegExp("</" + TC + "\\s*>", "i").test(t)) {
    push("the opening tag was never closed with " + TC_CLOSE + ".");
  }

  // ② JSON 载荷：标签对了但内容不对，是最常见也最能救的一类
  const brace = t.indexOf("{");
  if (brace === -1) {
    push("there is no JSON object at all — the tool name and its parameters must sit inside an object between the two tags, not in prose.");
  } else {
    const obj = extractFirstJsonObject(t.slice(brace));
    const parsed = obj ? tryParseJsonLenient(obj) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      push("the JSON object is truncated or malformed — close every brace, put double quotes around every string, and separate items with commas.");
    } else {
      const o = parsed as Record<string, unknown>;
      if (typeof o.name !== "string" || !o.name.trim()) {
        push('the object has no usable "name" field — it must name one tool from the list.');
      } else if (o.arguments == null) {
        push('the object has no "arguments" object — the parameters go directly inside it, e.g. {"command": "..."}.');
      } else if (typeof o.arguments !== "object" || Array.isArray(o.arguments)) {
        push('"arguments" must be an object such as {"command": "..."}, not a string, an array or a bare value.');
      }
    }
  }
  return problems.length ? problems.join(" ") : "the tool call could not be parsed.";
}

/**
 * 垃圾日志的存取。生产走 Deno 文件 IO；测试注入内存假件——
 * `deno task test` 只开 --allow-env，整个套件没有文件系统权限。
 */
export interface CnbJunkStore {
  size(path: string): number;
  write(path: string, text: string, append: boolean): void;
}

const CNB_JUNK_LOG = "./cnb-junk.log";
/** 这个文件只回答「最近几次模型到底写了什么」，不负责历史归档，到量就重开。 */
const CNB_JUNK_LOG_MAX = 512 * 1024;
/** 一个回合里 think / content 两条通道会各解析一次，别把日志写成刷屏。 */
const CNB_JUNK_LOG_MIN_GAP = 500;

const cnbJunkDiskStore: CnbJunkStore = {
  size(path: string): number {
    try { return Deno.statSync(path).size; } catch { return 0; }
  },
  write(path: string, text: string, append: boolean): void {
    if (!append) { Deno.writeTextFileSync(path, text); return; }
    // 追加不能用 writeTextFileSync（它整体覆写）；openSync + append 同一支 fd，
    // 写完必须 close，否则描述符随每次拒收泄漏一个。
    const f = Deno.openSync(path, { create: true, write: true, append: true });
    try { f.writeSync(new TextEncoder().encode(text)); } finally { f.close(); }
  },
};

/**
 * 把一次垃圾工具语法追加到磁盘。
 *
 * **同步**写：调用点在纯同步的解析路径上（cnbParseToolCalls 不是 async），
 * 改 await 会把整个响应卡住。任何读/写失败都静默吞掉——日志坏了绝不能
 * 把正常响应一起打死。
 *
 * 时间注入 now：防抖间隔是这个函数自身的性质，测试要能验证它，不能靠 sleep。
 */
export function cnbJournalJunk(
  line: string,
  store: CnbJunkStore = cnbJunkDiskStore,
  now: number = Date.now(),
): void {
  if (now - cnbJunkLogState.at < CNB_JUNK_LOG_MIN_GAP) return;
  cnbJunkLogState.at = now;
  try {
    const append = store.size(CNB_JUNK_LOG) <= CNB_JUNK_LOG_MAX;
    store.write(CNB_JUNK_LOG, line, append);
  } catch { /* 只读工作目录 / 权限不足：日志坏掉不影响响应 */ }
}

// ★ 双重嵌套 arguments：模型把参数对象又包了一层 ——
// {"arguments": {"command": ...}, "description": ...}。拆开并合并外层多余键（内层优先）；
// 值为字符串化 JSON 也解。★ 裸命令字符串变体：模型把命令本体直接塞进 arguments ——
// {"arguments": "Set-Location ..."}，映射到 schema 的 command 类参数。
// 工具 schema 真有名为 arguments/args/parameters 的参数时不做任何拆解
function unwrapNestedArgs(args: any, entry?: { types: Record<string, string> }): any {
  const guarded = !!(entry && ("arguments" in entry.types || "args" in entry.types || "parameters" in entry.types));
  for (let d = 0; d < 2; d++) {
    if (guarded) break;
    const raw = args["arguments"] ?? args["args"] ?? args["parameters"];
    if (raw == null) break;

    if (typeof raw === "string" && raw.trim()) {
      const p = tryParseJsonLenient(raw);
      if (p && typeof p === "object" && !Array.isArray(p)) {
        // 字符串里包着 JSON 对象：按对象路径拆
        const merged = { ...p };
        for (const [k, v] of Object.entries(args)) {
          if (!["arguments", "args", "parameters"].includes(k) && !(k in merged)) merged[k] = v;
        }
        args = merged;
        continue;
      }
      // 裸命令字符串：映射到 command 类参数（schema 已知取真名，未知乐观用 "command"）
      const cmdKey = entry
        ? ["command", "cmd", "script"].find((k) => entry.types[k] === "string")
        : "command";
      if (cmdKey) {
        const merged = { ...args };
        delete merged["arguments"];
        delete merged["args"];
        delete merged["parameters"];
        if (!(cmdKey in merged) || typeof merged[cmdKey] !== "string" || !merged[cmdKey].trim()) {
          merged[cmdKey] = raw;
        }
        args = merged;
      }
      break;
    }

    if (typeof raw !== "object" || Array.isArray(raw)) break;
    const merged = { ...raw };
    for (const [k, v] of Object.entries(args)) {
      if (!["arguments", "args", "parameters"].includes(k) && !(k in merged)) merged[k] = v;
    }
    args = merged;
  }
  return args;
}

// invoke 开标签整个漏写时，按参数名与各工具 schema 的重合度推断工具名
function guessToolFromParams(pnames: Set<string>, tools?: any[]): string | null {
  if (!Array.isArray(tools)) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const t of tools) {
    const fn = t.function || {};
    if (!fn.name) continue;
    const props = (fn.parameters && fn.parameters.properties) || {};
    const names = Object.keys(props);
    const hit = names.filter((n) => pnames.has(n)).length;
    const extra = [...pnames].filter((n) => !names.includes(n)).length;
    const score = hit * 2 - extra; // 命中加分、未知参数降权，防误配
    if (score > bestScore) { bestScore = score; best = fn.name; }
  }
  return best;
}

// ★ 模型把 invoke 写成 parameter 标签的混淆形式，两种变体：
//   1. 双 name 属性：<｜｜DSML｜｜ parameter name="invoke" name="grep">
//   2. 引号错位粘连：<｜｜DSML｜｜ parameter name="invoke name="pwsh">
// 还原成正常 invoke 开标签。只有一个 name 的正常参数不受影响
function normalizeInvokeConfusion(text: string) {
  // 变体1：伪属性 name="invoke" + 随后还有第二个 name 属性
  text = text.replace(
    /<([｜|]{2}DSML[｜|]{2}|\|?(?:XYML|QNML)\|?)?\s*parameter\s+name\s*=\s*["']invoke["']\s+(?=[^>]*\bname\s*=\s*["'])/gi,
    (_m, tok: string) => `<${tok || ""}invoke `
  );
  // 变体2：name 的值粘连了 "invoke name="，真名被挤到引号外
  text = text.replace(
    /<([｜|]{2}DSML[｜|]{2}|\|?(?:XYML|QNML)\|?)?\s*parameter\s+name\s*=\s*["']invoke\s+name=["']?\s*([^"'>\s]+)["']?\s*>/gi,
    (_m, tok: string, nm: string) => `<${tok || ""}invoke name="${nm}">`
  );
  // 变体3：name="invoke"（可带 string="true" 等杂属性）+ 标签闭合后紧跟裸工具名和引号残渣
  // 尾部强制要求 ["']?\\s*> 残渣，避免误伤值为多词文本的合法 name="invoke" 参数
  text = text.replace(
    /<([｜|]{2}DSML[｜|]{2}|\|?(?:XYML|QNML)\|?)?\s*parameter\s+name\s*=\s*["']invoke["'][^>]*>\s*([^"'>\s]+)\s*["']?\s*>/gi,
    (_m, tok: string, nm: string) => `<${tok || ""}invoke name="${nm}">`
  );
  return text;
}

// 导出给 src/cnb.test.ts：整个垃圾语法路径只有经过这个入口才走得通，
// 不导出就等于那批用例只能测诊断、测不了"清理后的正文到底是什么样"。
export function cnbParseToolCalls(text: string, tools?: any[]) {
  // ★ 常见短路：全文没有 "<" 且没有 "name": 键（tool_call/XYML/DSML/裸 JSON 全需要其一），
  // 直接原样返回，省掉全部归一化/扫描/清理（纯文本响应占大多数）
  if (!text.includes("<") && !/"name"\s*:/.test(text)) return { clean: text, calls: [] as any[] };
  // DeepSeek 原生 DSML 标记 → XYML 归一化（含 invoke 混淆形式修正）
  text = normalizeDsml(normalizeInvokeConfusion(text));
  // 注意：模型漏写必需参数时保持原样缺失，不再填充占位值——
  // 让工具端报"缺少参数"驱动模型重试（占位值曾导致下游拿假参数执行）
  // 按工具 schema 类型修正字符串化的数字/布尔（CDATA、引号导致的）
  const schemaMap = buildToolSchemaMap(tools);

  const calls: any[] = [];
  // 各 invoke 在 clean 里的删除范围（含闭合标签，若存在）
  const spans: Array<[number, number]> = [];
  // 是否有调用因命令退化被拒收（拒收时注入反馈，驱动模型重发）
  let degenerated = false;

  // ★ 宽容解析：不强制 </invoke> 闭合——
  // DeepSeek 常漏写 </invoke> 或重复 </tool_calls>，严格配对会让整块泄漏成正文
  const opens: Array<{ name: string; start: number; bodyStart: number; synthesized?: boolean }> = [];
  let om;
  XYML_INVOKE_OPEN.lastIndex = 0;
  while ((om = XYML_INVOKE_OPEN.exec(text)) !== null) {
    opens.push({ name: om[1], start: om.index, bodyStart: om.index + om[0].length });
  }

  // ★ invoke 开标签整个漏写（只剩参数块）：按参数名推断工具名，合成一个 invoke。
  // 推断错也比整块泄漏好——客户端会报"未知工具"，模型能重试；泄漏则会卡死循环
  if (opens.length === 0) {
    XYML_PARAM_OPEN.lastIndex = 0;
    let fp: RegExpExecArray | null;
    let firstIdx = -1;
    const pnames = new Set<string>();
    while ((fp = XYML_PARAM_OPEN.exec(text)) !== null) {
      if (firstIdx === -1) firstIdx = fp.index;
      const nm = parseTagAttrs(fp[1])["name"];
      if (nm) pnames.add(nm);
    }
    const guess = guessToolFromParams(pnames, tools);
    if (guess && firstIdx !== -1) {
      opens.push({ name: guess, start: firstIdx, bodyStart: firstIdx, synthesized: true });
    }
  }

  for (let i = 0; i < opens.length; i++) {
    const o = opens[i];
    // body 结束边界：显式 </invoke>、下一个 invoke 开头、tool_calls 开/闭标签，取最近者
    XYML_INVOKE_CLOSE.lastIndex = o.bodyStart;
    const cm = XYML_INVOKE_CLOSE.exec(text);
    const closeStart = cm ? cm.index : -1;
    const nextOpen = i + 1 < opens.length ? opens[i + 1].start : -1;
    XYML_BOUNDARY.lastIndex = o.bodyStart;
    const bm = XYML_BOUNDARY.exec(text);
    const boundary = bm ? bm.index : -1;

    let bodyEnd = text.length;
    if (closeStart !== -1) bodyEnd = Math.min(bodyEnd, closeStart);
    if (nextOpen !== -1) bodyEnd = Math.min(bodyEnd, nextOpen);
    if (boundary !== -1) bodyEnd = Math.min(bodyEnd, boundary);

    // 闭合标签紧跟 body 时，连同它一起从 clean 里删掉
    const spanEnd = closeStart === bodyEnd ? closeStart + cm![0].length : bodyEnd;

    const body = text.slice(o.bodyStart, bodyEnd);
    const entry = schemaMap.get(o.name);
    let args = parseXymlParams(body, entry?.types);
    // 参数一个都没解析出来：兜底纯 JSON 体（模型直接写 {"file_path": ...}）
    if (!Object.keys(args).length) {
      const t = body.trim();
      if (t.startsWith("{")) {
        try {
          const jo = JSON.parse(t);
          if (jo && typeof jo === "object" && !Array.isArray(jo)) args = jo;
        } catch {}
      }
    }
    // 双重嵌套 arguments 包裹：对象或字符串化 JSON 都展开（含带兄弟键的形态）
    args = unwrapNestedArgs(args, entry);
    coerceArgsBySchema(args, entry);
    // 合成 invoke（模型漏写开标签、工具名是猜的）时，丢掉 schema 外的幻觉参数
    if (o.synthesized && entry && Object.keys(entry.types).length) {
      for (const k of Object.keys(args)) if (!(k in entry.types)) delete args[k];
    }
    rescueDisplayParam(args, entry);

    // 命令类参数：混淆字符归一化 + 退化检测（拒收并反馈，避免执行乱码命令）
    const cmdKeys = ["command", "cmd", "script"].filter((k) => typeof args[k] === "string");
    for (const k of cmdKeys) args[k] = normalizeConfusables(args[k]);
    if (cmdKeys.some((k) => looksDegenerated(args[k]))) {
      degenerated = true;
      spans.push([o.start, spanEnd]);
      continue;
    }

    calls.push({
      id: "call_" + Math.random().toString(36).slice(2, 22),
      type: "function",
      function: { name: o.name, arguments: JSON.stringify(args) },
    });
    spans.push([o.start, spanEnd]);
  }

  // ★ <tool_call> JSON 块（主协议）：容忍 ```json 围栏与漏写闭合
  const pushJsonCall = (o: any) => {
    let args = (o.arguments && typeof o.arguments === "object" && !Array.isArray(o.arguments)) ? o.arguments : null;
    if (!args) {
      // 裸参数形态：对象本身就是参数（{"pattern":...}），剥掉元字段。
      // 注意不剥 arguments——字符串形态的 arguments 由 unwrapNestedArgs 映射到 command
      const { name: _n, tool: _t, function: _f, _tagName: _tag, ...rest } = o;
      args = rest;
    }
    // 名字解析顺序：body name → 标签属性名 →（无名时先拆嵌套再）按参数形状猜工具
    let name = typeof o.name === "string" ? o.name : undefined;
    if (!name) name = tagNameAttr(o._tagName || "");
    if (!name) {
      // 无名：先拆双层嵌套（按参数形状猜依赖真实参数名；此时无从查 schema 守卫）
      args = unwrapNestedArgs(args);
      name = guessToolFromParams(new Set(Object.keys(args)), tools) || undefined;
    }
    if (!name) return;
    const entry = schemaMap.get(name);
    // 带 schema 守卫的正式拆解（无名路径已拆过，此处幂等）
    args = unwrapNestedArgs(args, entry);
    coerceArgsBySchema(args, entry);
    rescueDisplayParam(args, entry);
    calls.push({
      id: "call_" + Math.random().toString(36).slice(2, 22),
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
  };

  if (!calls.length) {
    TAG_CALL.lastIndex = 0;
    let tm;
    while ((tm = TAG_CALL.exec(text)) !== null) {
      const before = calls.length;
      for (const o of parseToolCallPayload(tm[2])) {
        o._tagName = tm[1] || "";
        pushJsonCall(o);
      }
      if (calls.length > before) spans.push([tm.index, tm.index + tm[0].length]);
    }

    // 漏写 </tool_call>（或闭合串台成旧协议标签）：每个开标签取到下一个开标签/文末
    if (!calls.length) {
      const OPEN_RE = /<tool[_ ]call(\s[^>]*)?>/gi;
      const opens: Array<{ tagStart: number; start: number; attrs: string }> = [];
      let t2;
      while ((t2 = OPEN_RE.exec(text)) !== null) opens.push({ tagStart: t2.index, start: t2.index + t2[0].length, attrs: t2[1] || "" });
      for (let j = 0; j < opens.length; j++) {
        const end = j + 1 < opens.length ? opens[j + 1].tagStart : text.length;
        let seg = text.slice(opens[j].start, end);
        const cut = seg.lastIndexOf("</tool_call>");
        if (cut >= 0) seg = seg.slice(0, cut);
        const before = calls.length;
        for (const o of parseToolCallPayload(seg)) {
          o._tagName = opens[j].attrs;
          pushJsonCall(o);
        }
        if (calls.length > before) spans.push([opens[j].tagStart, end]);
      }
    }
  }

  // ★ 终极兜底：裸 {"name":...,"arguments":{...}} 对象——协议混写时模型把 JSON
  // 直接包在 <|XYML|tool_calls> 等旧标签里、不带任何 invoke/tool_call 标签
  if (!calls.length) {
    const BARE = /\{\s*"name"\s*:\s*"[^"\\]+"\s*,\s*"arguments"\s*:\s*[\{"]/g;
    let m2;
    while ((m2 = BARE.exec(text)) !== null) {
      let obj = extractFirstJsonObject(text.slice(m2.index));
      let spanEnd;
      if (obj) {
        spanEnd = m2.index + obj.length;
      } else {
        // 截断（无平衡闭合）：取到文末，交给截断修复
        obj = text.slice(m2.index);
        spanEnd = text.length;
      }
      const o = tryParseJsonLenient(obj);
      if (!o || typeof o !== "object") continue;
      const before = calls.length;
      pushJsonCall(o);
      if (calls.length > before) spans.push([m2.index, spanEnd]);
    }
  }

  // ★ <function_call> 标签对（Claude/自创格式，垃圾拒收的主要来源）：
  // 标签间内容按 JSON 载荷解析，能救回来就不走拒收
  if (!calls.length) {
    const FC = /<function_call(\s[^>]*)?>([\s\S]*?)(?:<\/function_call\s*>|$)/gi;
    let fm;
    while ((fm = FC.exec(text)) !== null) {
      const before = calls.length;
      for (const o of parseToolCallPayload(fm[2])) {
        o._tagName = fm[1] || "";
        pushJsonCall(o);
      }
      if (calls.length > before) spans.push([fm.index, fm.index + fm[0].length]);
    }
  }

  // ★ 垃圾工具标记：解析不出任何调用时，剥掉"像工具调用但结构非法"的标签并反馈
  // （<tool_calls in parallel> / <function_calls> / 裸 <invoke> 无参数块等）
  let junkToolSyntax = false;
  let junkDiagnosis = "";
  if (!calls.length) {
    // 单一 JUNK 正则是这套逻辑的**唯一清理出口**：它少认一种写法，那种写法的整块
    // 标签就会留在正文里直接发给客户端——用户看到的是一堆裸露伪 XML，而不是一句
    // "写错了"。新增协议形态必须同时扩这里。
    const JUNK = new RegExp(
      // 复数 / 带属性 / 漏闭合的 tool_calls 包裹：开到最近的闭合标签或文末
      "<(?:\\|?(?:XYML|QNML)\\|?)?tool[_ ]?calls?\\b[\\s\\S]*?(?:<\\/[^>]*(?:call|invoke|parameter)[^>]*\\s*>|$)"
      // function_call(s) 单复数都收：只写复数时，单数那半边的标签会原样漏出去
      + "|<function_calls?\\b[\\s\\S]*?(?:<\\/[^>]*call[^>]*\\s*>|$)",
      "gi",
    );
    if (JUNK.test(text)) {
      // JUNK 带 g 标志，test() 会推进 lastIndex；立刻归零，否则下面的 replace()
      // 会漏掉第一处匹配（g 标志的正则共享可变状态）
      JUNK.lastIndex = 0;
      junkToolSyntax = true;
      junkDiagnosis = cnbDiagnoseJunkSyntax(text);
      // 拒收时记录原始形态（stderr + 落盘），下次能确诊而不是盲猜。
      // 落盘是必需的：stderr 只进插件 200 行内存日志，长会话里几秒就被冲掉
      // （实测：连续拒收时 warn 存活时间以秒计，日志文件里一行都没留下）。
      const raw = "[junk] unparseable tool syntax, raw (500 chars): " + text.replace(/\s+/g, " ").slice(0, 500);
      console.warn(raw);
      cnbJournalJunk(raw + "\n  diagnosis: " + junkDiagnosis + "\n");
      text = text.replace(JUNK, "");
      text = text.replace(/<\/?[｜|]{0,2}(?:XYML|QNML)[｜|]{0,2}\s*\w*\s*>/gi, "");
      text = text.replace(/<\/?tool_calls?\b[^>]*>/gi, "");
    }
  }

  let clean = text;
  if (calls.length || degenerated || junkToolSyntax) {
    // 从后往前删除各 invoke 片段（按记录的 span，含存在的闭合标签）
    spans.sort((a, b) => b[0] - a[0]);
    for (const [s, e] of spans) clean = clean.slice(0, s) + clean.slice(e);
    clean = clean.replace(TAG_CALL, "");
    // 清掉残留/错位/重复的标签（漏写闭合、双写 </tool_calls> 都会留杂散标签）
    clean = clean.replace(new RegExp(`<\\/?${P}tool_calls\\s*>`, "gi"), "");
    clean = clean.replace(new RegExp(`<\\/?${P}invoke[^>]*>`, "gi"), "");
    clean = clean.replace(new RegExp(`<\\/?${P}parameter[^>]*>`, "gi"), "");
    clean = clean.replace(/<\/?tool[_ ]call(\s[^>]*)?>/gi, "");
    clean = clean.replace(/<\/?\w*call\w*\b[^>]*>/gi, "");
    // DSML 残骸（混合协议时模型的串台闭合标签）
    clean = clean.replace(/<\/?[｜|]{2}DSML[｜|]{2}\s*\w*[^>]*>/gi, "");
    clean = clean.trim();
    if (degenerated) {
      clean = clean ? clean + "\n\n" + DEGENERATE_NOTE : DEGENERATE_NOTE;
    } else if (junkToolSyntax) {
      // 第一版这里只有一句通用的 "invalid syntax"。模型不知道错在哪，于是每一轮都把
      // 同一种坏写法再写一遍 —— 用户实测单会话连续 13 次大输出回合全是这么来的
      // （输入 34 倍增长、99% token 花在重发）。现在附上**违反的具体那一条**，
      // 并且连续被拒时熔断成短版（cnbJunkFeedback），诊断仍然每轮都发。
      const note = cnbJunkFeedback(junkDiagnosis);
      clean = clean ? clean + "\n\n" + note : note;
    }
  }
  return { clean, calls };
}

// ---------- 流式工具标记过滤器 ----------
// 有 tools 的流式响应：正文/思考实时放行；一旦撞见疑似工具标记开头（XYML/QNML/DSML/<tool_call>）
// 就锁定该通道，后续全部缓冲，流结束后交给 cnbParseToolCalls 统一解析
const TOOL_OPENERS = [
  "<|xyml|tool_calls", "<|qnml|tool_calls",
  "<|xyml|invoke", "<|qnml|invoke", "<invoke",
  "<|xyml|parameter", "<|qnml|parameter",
  "<xyml|tool_calls", "<qnml|tool_calls",
  "<xyml|invoke", "<qnml|invoke",
  "<xyml|parameter", "<qnml|parameter",
  "<tool_call", "<tool_calls",           // 单复数都收
  "<function_call", "<function_calls",   // OpenAI 遗留格式
  "<｜｜dsml", "<||dsml",
];
const MAX_OPENER_LEN = Math.max(...TOOL_OPENERS.map((s) => s.length));

function createLiveFilter() {
  const state = { emitted: "", full: "" };
  let held = "";
  let locked = false;

  return {
    state,
    push(delta: string): string {
      state.full += delta;
      if (locked) { held += delta; return ""; }
      // ★ 快路径：没有未决前缀且本段不含 '<'，不可能构成任何标记开头（流式 CPU 热点）
      if (!held && !delta.includes("<")) {
        state.emitted += delta;
        return delta;
      }
      held += delta;

      const low = held.toLowerCase();
      // 完整命中标记开头 → 锁定，之前的文本放行
      let idx = -1;
      for (const o of TOOL_OPENERS) {
        const p = low.indexOf(o);
        if (p !== -1 && (idx === -1 || p < idx)) idx = p;
      }
      if (idx !== -1) {
        const out = held.slice(0, idx);
        held = held.slice(idx);
        locked = true;
        state.emitted += out;
        return out;
      }
      // 尾部是某个标记的前缀（可能跨 chunk 补全）→ 扣住，其余放行
      let keep = 0;
      for (let k = Math.min(MAX_OPENER_LEN, held.length); k > 0; k--) {
        const tail = low.slice(held.length - k);
        if (TOOL_OPENERS.some((o) => o.startsWith(tail))) { keep = k; break; }
      }
      const out = held.slice(0, held.length - keep);
      held = held.slice(held.length - keep);
      state.emitted += out;
      return out;
    },
  };
}

// 流结束后计算尾段：清理后的全文去掉已实时发出的公共前缀
function commonPrefixLen(a: string, b: string) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function cnbBuildUpstream(openaiBody: any) {
  const model = openaiBody.model || "deepseek-v4-flash";
  const rawMsgs = openaiBody.messages || [];
  if (!rawMsgs.length) throw new Error("messages is required");

  const msgs = rawMsgs.map((m: any) => {
    const role = (m.role || "").toLowerCase();

    // 归一化 content
    let c = m.content;
    // ★ 视觉：cnb 上游接受 OpenAI 形态的多模态 content 数组（已实测：带 image_url
    // 时模型能读出图中数字，纯文本时答 "No image provided."）。旧代码在这里 filter
    // 只留 text，图片被静默丢弃，导致上游永远收不到图 —— 现改为对 user/system 保留
    // image_url 块；其余角色（assistant/tool/developer）仍折叠成纯文本，避免历史回放
    // 与工具结果里出现数组形态。
    let multimodal = false;
    if (Array.isArray(c)) {
      const parts = c.filter((p: any) =>
        p && (p.type === "text" || p.type === "image_url")
      );
      const hasImage = parts.some((p: any) => p.type === "image_url");
      if (hasImage && (role === "user" || role === "system")) {
        c = parts.map((p: any) =>
          p.type === "text"
            ? { type: "text", text: p.text || "" }
            : {
              type: "image_url",
              image_url: typeof p.image_url === "string"
                ? { url: p.image_url }
                : (p.image_url || { url: "" }),
            }
        );
        multimodal = true;
      } else {
        c = parts
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text || "")
          .join("\n");
      }
    }
    if (c == null) c = "";
    if (!multimodal) c = String(c);

    // ─── assistant：保留 tool_calls，转成 XYML 文本 ───
    if (role === "assistant") {
      let body = c;
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        // JSON 协议：历史回放与提示词同构，模型看自己的历史就是正确示范
        const blocks = m.tool_calls.map((tc: any) => {
          const fn = tc.function || {};
          const name = fn.name || "unknown";
          let args: any = {};
          try {
            args = typeof fn.arguments === "string"
              ? JSON.parse(fn.arguments || "{}")
              : (fn.arguments || {});
          } catch {
            args = {};
          }
          return `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`;
        }).join("\n");

        body = body ? `${body}\n${blocks}` : blocks;
      }
      return { role: "assistant", content: body };
    }

    // ─── tool：工具结果 → user 文本 ───
    if (role === "tool") {
      const tcid = m.tool_call_id || "unknown";
      const nm = m.name ? ` name=${m.name}` : "";
      return { role: "user", content: `[Tool Result id=${tcid}${nm}]\n${c}` };
    }

    // ─── developer → system ───
    if (role === "developer") {
      return { role: "system", content: c };
    }

    // ─── 标准角色 ───
    if (role === "user" || role === "system") {
      return { role, content: c };
    }

    // ─── 兜底 ───
    return { role: "user", content: c };
  });

  // 注入工具定义（XYML schema）
  const tools = openaiBody.tools || [];
  const hasTools = tools.length > 0;
  if (hasTools) {
    const prompt = cnbBuildToolPrompt(tools);
    if (msgs[0] && msgs[0].role === "system") {
      // ★ 多模态守卫：system 的 content 可能是数组（含图片），不能直接字符串拼接，
      // 否则会变成 "[object Object]\n\n..."，既丢图又污染系统提示词。
      // 数组形态下把协议提示词追加成一个 text 块。
      const first = msgs[0];
      if (Array.isArray(first.content)) {
        msgs[0] = {
          role: "system",
          content: [...first.content, { type: "text", text: prompt }],
        };
      } else {
        msgs[0] = { role: "system", content: first.content + "\n\n" + prompt };
      }
    } else {
      msgs.unshift({ role: "system", content: prompt });
    }
  }

  const up: any = {
    model,
    messages: msgs,
    stream: true,
    // flash 思考 token 波动大（实测最多吃掉一半输出预算），默认给 120000；pro 思考量小维持 60000
    maxTokens: openaiBody.max_tokens || (model === "deepseek-v4-flash" ? 120000 : 60000),
  };
  if (openaiBody.temperature != null) up.temperature = openaiBody.temperature;
  if (openaiBody.top_p != null) up.top_p = openaiBody.top_p;

  // ★ 思考强度：客户端指定优先（reasoning_effort 或 reasoning.effort），默认 high
  const effortRaw = openaiBody.reasoning_effort || openaiBody.reasoning?.effort;
  up.enable_thinking = true;
  up.reasoning_effort = ["low", "medium", "high", "max"].includes(String(effortRaw)) ? String(effortRaw) : "high";

  return { upstream: up, hasTools };
}

async function cnbCall(body: any) {
  const st = await cnbEnsure();
  const loginCookies = cnbLoginCookies();
  // 30 秒无响应头视为 cnb 挂死：中止抛错交给上层退避重试（实测 cnb 偶发无限挂起）。
  // 只罩到响应头返回为止，不限制流式生成的总时长。
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("cnb: no response headers in 30s")), 30_000);
  try {
  return await fetch(CNB_CHAT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream, application/json, text/plain, */*",
      "Origin": "https://cnb.cool",
      "Referer": "https://cnb.cool/",
      "Csrftoken": st.token,
      "Cookie": "csrfkey=" + st.csrfkey + (loginCookies ? "; " + loginCookies : ""),
      "User-Agent": CNB_UA,
    },
    body: JSON.stringify(body),
    signal: ac.signal,
  });
  } finally { clearTimeout(timer); }
}

async function* cnbIter(upstream: Response) {
  const reader = upstream.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (d === "[DONE]") return;
        try { yield JSON.parse(d); } catch {}
      }
    }
    if (buf.trim().startsWith("data:")) {
      const d = buf.trim().slice(5).trim();
      if (d !== "[DONE]") { try { yield JSON.parse(d); } catch {} }
    }
  } finally {
    // cancel 而非仅 releaseLock：[DONE] 提前 return 时也要把流关掉（闸依赖流结束/取消信号）
    try { await reader.cancel(); } catch {}
  }
}

function cnbErr(status: number, msg: string, detail?: string) {
  return new Response(JSON.stringify({ error: msg, detail }), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// ★ 串行闸：cnb 网页会话按 cookie 归属，并发疑似互踩（串台）；同一 cookie 同时只放行一个请求，
//   锁持有到响应流读完（fetch 返回 ≠ 完成），流结束/出错/取消/10 分钟兜底才释放。
//   fp 是会话指纹（模型+消息数+首尾消息前缀的 djb2 hash），
//   日志里"waited ... for previous stream"且 fp 不同 = 跨会话并发（串台实锤）。
let cnbGate: Promise<void> = Promise.resolve();
function cnbFingerprint(body: any): string {
  const msgs: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const pick = (m: any) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
  const src = `${body?.model ?? "?"}|${msgs.length}|${pick(msgs[0]).slice(0, 256)}|${pick(msgs[msgs.length - 1]).slice(0, 256)}`;
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = ((h * 33) ^ src.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function cnbGatedResponse(resp: Response, done: () => void): Response {
  if (!resp.body) { done(); return resp; }
  // 逐块透传并刷新空闲计时。释放条件（任一）：流正常结束、出错、消费方取消（cancel 会传导回来）、2 分钟无数据。
  // （消费方读到 [DONE] 提前 return 且不 cancel 时，靠空闲计时兜底，闸不会吊死）
  let idle: ReturnType<typeof setTimeout> = setTimeout(() => { console.warn("[cnb-gate] idle 2min, releasing"); done(); }, 120_000);
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => { console.warn("[cnb-gate] idle 2min, releasing"); done(); }, 120_000); };
  const finish = () => { clearTimeout(idle); done(); };
  const t = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { touch(); controller.enqueue(chunk); },
    flush() { finish(); },
  });
  resp.body.pipeTo(t.writable).then(() => finish(), () => finish());
  return new Response(t.readable, { status: resp.status, headers: resp.headers });
}
async function cnbCallUpstream(upBody: any): Promise<Response> {
  // 字节预检：**上游**拒绝 >1MiB 的请求体；直接快速失败，不占用隧道往返和串行闸。
  //
  // 判据是 2026-10-05 直接打上游实测出来的（.tmp-cnb-1mib-probe.ts，绕过代理
  // 只发给 cnb.cool）：1.000MiB 通过、1.050MiB 起回 413
  // `[BODY_TOO_LARGE]Request body too large`，1.5/3/8MiB 同样。
  // 也就是说这条**不是猜的**，别按"听起来合理"把它删掉。
  //
  // 但报错必须说清是谁拒的：这句文案是我们自己产的，请求根本没发出去。
  // 写成 "cnb gateway rejects..." 会让排查的人去查上游——我犯过这个错，
  // 用户拿到这句时以为上游炸了，实际是我们单方面拦的。
  const bodyBytes = new TextEncoder().encode(JSON.stringify(upBody)).length;
  if (bodyBytes > 1048576) {
    console.warn(`[cnb-gate] rejected pre-flight: body ${bodyBytes}B > 1MiB (fp=${cnbFingerprint(upBody)})`);
    return cnbErr(413, "Request body too large",
      `ai-proxy refused this request before sending it: its body is ${bodyBytes} bytes ` +
      `(${(bodyBytes / 1048576).toFixed(2)} MiB), and cnb upstream rejects bodies over 1 MiB ` +
      `(verified upstream: 413 "[BODY_TOO_LARGE]Request body too large" at 1.05 MiB and above). ` +
      `Nothing was sent. Reduce the context size and retry.`);
  }
  const fp = cnbFingerprint(upBody);
  const prev = cnbGate;
  let release!: () => void;
  cnbGate = new Promise<void>((r) => (release = r));
  let released = false;
  const t0 = Date.now();
  let safety: ReturnType<typeof setTimeout>;
  const done = () => {
    if (released) return;
    released = true;
    clearTimeout(safety);
    console.warn(`[cnb-gate] fp=${fp} released +${Date.now() - t0}ms`);
    release();
  };
  // 安全阀：流挂死时 10 分钟强制放行，避免闸被永久占死（正常释放时清除，不留误报日志）
  safety = setTimeout(() => { console.warn(`[cnb-gate] fp=${fp} safety release after 10min`); done(); }, 10 * 60 * 1000);
  const queuedAt = Date.now();
  await prev;
  const waited = Date.now() - queuedAt;
  if (waited > 200) console.warn(`[cnb-gate] fp=${fp} waited ${waited}ms for previous stream`);
  try {
    const resp = await cnbCallUpstreamInner(upBody);
    return cnbGatedResponse(resp, done);
  } catch (e) {
    done();
    throw e;
  }
}

function cnbUpstreamFail(status: number, errBody: string): Response {
  if ((status === 401 || /NOT_LOGIN/i.test(errBody)) && !cnbLoginCookies()) {
    return cnbErr(status, "cnb requires login",
      "cnb.cool 上游已要求登录。请登录 cnb.cool 后：F12 → Network → 任一 cnb.cool 请求 → 复制完整 Cookie 请求头，"
      + "单行粘贴到 ai-proxy/cnb-login.txt（保存即热加载，无需重启）。上游原文: " + errBody.slice(0, 300));
  }
  return cnbErr(status, "Upstream error", errBody.slice(0, 500));
}

// cnb 上游调用：瞬时 502/网络抖动时退避重试（境外出口 IP 偶发被 cnb 拒）
async function cnbCallUpstreamInner(upBody: any): Promise<Response> {
  const waits = [0, 500, 1500, 3500, 8000, 20000];
  let last: Response | null = null;
  for (let i = 0; i < waits.length; i++) {
    if (waits[i]) await new Promise((r) => setTimeout(r, waits[i]));
    try {
      const resp = await cnbCall(upBody);
      if (resp.status === 200) {
        const inspected = await inspectResponseBody(resp);
        if (inspected.timedOut) {
          return cnbErr(504, "cnb returned headers but no response body", "response sniff deadline reached");
        }
        if (inspected.shape === "sse") {
          return replayResponse(resp, inspected, "text/event-stream");
        }
        const text = await readInspectedText(inspected);
        return cnbErr(502, "cnb returned a non-SSE response", text.slice(0, 500) || "empty response body");
      }
      last = resp;
      // 4xx（除 429）是确定性的，重试无意义，直接透传
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) return resp;
      console.warn(`[cnb] upstream ${resp.status}, retry ${i + 1}/${waits.length}`);
      try { await resp.text(); } catch {} // 排空响应体再重试
    } catch (e: any) {
      console.warn(`[cnb] network error: ${e?.message || e}, retry ${i + 1}/${waits.length}`);
      // 网络层失败：刷新 CSRF 会话后重试
      cnbState.ts = 0;
    }
  }
  // ★ flash 全线 5xx（容量窗口）：换 deepseek-v4-pro 的后端池兜一次
  if (last && last.status >= 500 && upBody.model === "deepseek-v4-flash") {
    console.warn(`[cnb] flash exhausted (${last.status} after ${waits.length} tries), fallback to deepseek-v4-pro`);
    try {
      const resp = await cnbCall({ ...upBody, model: "deepseek-v4-pro" });
      if (resp.status === 200) return resp;
      last = resp;
    } catch {}
  }
  if (last) return last;
  return cnbErr(502, "Upstream error", "network failure after retries");
}

// ============================================
// OpenAI Responses API (/v1/responses) → cnb 适配
// ============================================

// Responses 请求 → 内部 OpenAI chat 格式（随后走 cnbBuildUpstream 的 XYML 管线）
function responsesToChat(rb: any) {
  const messages: any[] = [];
  if (rb.instructions) messages.push({ role: "system", content: String(rb.instructions) });

  const items = Array.isArray(rb.input)
    ? rb.input
    : [{ type: "message", role: "user", content: [{ type: "input_text", text: String(rb.input ?? "") }] }];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const t = item.type || "message";

    if (t === "message") {
      const role = item.role === "assistant" ? "assistant"
        : item.role === "system" || item.role === "developer" ? "system"
        : "user";
      let content: any = item.content;
      if (Array.isArray(content)) {
        content = content.map((p: any) => {
          if (p.type === "input_image") {
            const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url || "";
            return { type: "image_url", image_url: { url } };
          }
          // input_text / output_text / text 统一为 text 块
          return { type: "text", text: p.text || "" };
        });
      } else if (content == null) {
        content = "";
      }
      messages.push({ role, content });
    } else if (t === "function_call") {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [{
          id: item.call_id || item.id || "call_unknown",
          type: "function",
          function: {
            name: item.name || "unknown",
            arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
          },
        }],
      });
    } else if (t === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || "call_unknown",
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
    }
    // reasoning / item_reference 等其它 item 忽略
  }

  const chat: any = { model: rb.model || "deepseek-v4-flash", messages, stream: !!rb.stream };
  // Responses 的 reasoning.effort 透传到 chat 形态，供 cnbBuildUpstream 读取
  if (rb.reasoning?.effort) chat.reasoning_effort = rb.reasoning.effort;
  if (rb.max_output_tokens) chat.max_tokens = rb.max_output_tokens;
  if (rb.temperature != null) chat.temperature = rb.temperature;
  if (rb.top_p != null) chat.top_p = rb.top_p;
  // Responses 的扁平 tools（type/name/parameters 同级）→ chat 的嵌套格式
  if (Array.isArray(rb.tools) && rb.tools.length) {
    chat.tools = rb.tools
      .filter((t: any) => (t.type || "function") === "function")
      .map((t: any) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.parameters || { type: "object", properties: {} },
        },
      }));
  }
  return chat;
}

function responsesUsage(u: any) {
  return {
    input_tokens: u.prompt_tokens || 0,
    input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens || 0 },
    output_tokens: u.completion_tokens || 0,
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0 },
    total_tokens: u.total_tokens || 0,
  };
}

function responsesShell(id: string, createdAt: number, model: string, rb: any) {
  return (status: string, output: any[], error: any = null) => ({
    id, object: "response", created_at: createdAt, status, error,
    incomplete_details: null, instructions: rb.instructions ?? null,
    max_output_tokens: rb.max_output_tokens ?? null,
    model, output, parallel_tool_calls: rb.parallel_tool_calls ?? true,
    temperature: rb.temperature ?? 1, tool_choice: rb.tool_choice ?? "auto",
    tools: rb.tools ?? [], metadata: {}, store: false, usage: null as any,
  });
}

async function handleCnbResponses(request: Request): Promise<Response> {
  let bodyText: string;
  try { bodyText = await request.text(); }
  catch (e: any) { return cnbErr(400, "Failed to read body", e.message); }

  const p = safeJsonParse(bodyText);
  if (p.error) return cnbErr(400, "Invalid JSON", p.error.message);
  const rb = p.data || {};
  const wantStream = !!rb.stream;
  const rand = () => Math.random().toString(36).slice(2, 12);
  const respId = "resp_" + Date.now().toString(36) + rand();

  // ─── 非流式：保持同步（本来就没有流式头的问题） ───
  if (!wantStream) {
    const chatBody = responsesToChat(rb);
    let built;
    try { built = cnbBuildUpstream(chatBody); }
    catch (e: any) { return cnbErr(400, "Bad request", e.message); }
    const upBody = built.upstream;

    let upstreamResp: Response;
    try { upstreamResp = await cnbCallUpstream(upBody); }
    catch (e: any) { return cnbErr(502, "Upstream error", e.message); }
    if (upstreamResp.status !== 200) {
      let errBody = "";
      try { errBody = await upstreamResp.text(); } catch {}
      return cnbUpstreamFail(upstreamResp.status, errBody);
    }

    const shell = responsesShell(respId, Math.floor(Date.now() / 1000), upBody.model, rb);
    const textParts: string[] = [], thinkParts: string[] = [];
    let usage: any = null;
    try {
      for await (const chunk of cnbIter(upstreamResp)) {
        for (const ch of chunk.choices || []) {
          const d = ch.delta || {};
          if (d.content) textParts.push(d.content);
          if (d.reasoning_content) thinkParts.push(d.reasoning_content);
        }
        if (chunk.usage) usage = chunk.usage;
      }
    } catch (e: any) { return cnbErr(502, "Stream read error", e.message); }

    const r1 = cnbParseToolCalls(thinkParts.join(""), chatBody.tools);
    const r2 = cnbParseToolCalls(textParts.join(""), chatBody.tools);
    const allCalls = [...r1.calls, ...r2.calls];

    const output: any[] = [];
    if (r1.clean) output.push({ type: "reasoning", id: "rs_" + rand(), summary: [{ type: "summary_text", text: r1.clean }] });
    if (r2.clean) output.push({
      type: "message", id: "msg_" + rand(), status: "completed", role: "assistant",
      content: [{ type: "output_text", text: r2.clean, annotations: [] }],
    });
    for (const c of allCalls) {
      output.push({
        type: "function_call", id: "fc_" + rand(), call_id: c.id,
        name: c.function.name, arguments: c.function.arguments, status: "completed",
      });
    }

    const resp = shell("completed", output);
    if (usage) resp.usage = responsesUsage(usage);
    return new Response(JSON.stringify(resp), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  // ─── 流式：先返回 SSE 头，后台再等上游 ───
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  (async () => {
    const writeEvent = (type: string, obj: any) =>
      writer.write(enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`));

    let shell: any = responsesShell(respId, Math.floor(Date.now() / 1000), rb.model || "unknown", rb);
    let hb: any = null;

    try {
      // 首字节立刻出，CF 拿到响应头就不 524
      await writeEvent("response.created", { response: shell("in_progress", []) });
      await writeEvent("response.in_progress", { response: shell("in_progress", []) });

      const chatBody = responsesToChat(rb);
      const built = cnbBuildUpstream(chatBody);
      const upBody = built.upstream;
      shell = responsesShell(respId, Math.floor(Date.now() / 1000), upBody.model, rb);

      // 等上游期间每 15 秒一个注释心跳
      hb = setInterval(() => {
        writer.write(enc.encode(": keepalive\n\n")).catch(() => {});
      }, 15000);

      const upstreamResp = await cnbCallUpstream(upBody);
      if (upstreamResp.status !== 200) {
        let errBody = "";
        try { errBody = await upstreamResp.text(); } catch {}
        if ((upstreamResp.status === 401 || /NOT_LOGIN/i.test(errBody)) && !cnbLoginCookies()) {
          throw new Error("cnb requires login: cnb.cool 已要求登录。F12 → Network → 任一 cnb.cool 请求 → 复制完整 Cookie 请求头，单行粘贴到 ai-proxy/cnb-login.txt（保存即热加载）。上游原文: " + errBody.slice(0, 200));
        }
        throw new Error(`Upstream ${upstreamResp.status}: ${errBody.slice(0, 300)}`);
      }

      const rsId = "rs_" + rand();
      const msgId = "msg_" + rand();
      let usage: any = null;
      let msgOI = 0;

      const textFilter = createLiveFilter();
      const thinkFilter = createLiveFilter();
      let thinkOpened = false, textOpened = false;

      for await (const chunk of cnbIter(upstreamResp)) {
        for (const ch of chunk.choices || []) {
          const d = ch.delta || {};
          if (d.reasoning_content) {
            const out = thinkFilter.push(d.reasoning_content);
            if (out) {
              if (!thinkOpened) {
                thinkOpened = true;
                await writeEvent("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: rsId, summary: [] } });
                await writeEvent("response.reasoning_summary_part.added", { item_id: rsId, output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } });
              }
              await writeEvent("response.reasoning_summary_text.delta", { item_id: rsId, output_index: 0, summary_index: 0, delta: out });
            }
          }
          if (d.content) {
            const out = textFilter.push(d.content);
            if (out) {
              if (!textOpened) {
                textOpened = true;
                msgOI = thinkOpened ? 1 : 0;
                await writeEvent("response.output_item.added", { output_index: msgOI, item: { type: "message", id: msgId, status: "in_progress", role: "assistant", content: [] } });
                await writeEvent("response.content_part.added", { item_id: msgId, output_index: msgOI, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
              }
              await writeEvent("response.output_text.delta", { item_id: msgId, output_index: msgOI, content_index: 0, delta: out });
            }
          }
        }
        if (chunk.usage) usage = chunk.usage;
      }

      const r1 = cnbParseToolCalls(thinkFilter.state.full, chatBody.tools);
      const r2 = cnbParseToolCalls(textFilter.state.full, chatBody.tools);
      const allCalls = [...r1.calls, ...r2.calls];

      const finalOutput: any[] = [];
      let oi = 0;

      if (thinkOpened || r1.clean) {
        const rem = r1.clean.slice(commonPrefixLen(r1.clean, thinkFilter.state.emitted));
        if (rem) await writeEvent("response.reasoning_summary_text.delta", { item_id: rsId, output_index: 0, summary_index: 0, delta: rem });
        const think = r1.clean;
        await writeEvent("response.reasoning_summary_text.done", { item_id: rsId, output_index: 0, summary_index: 0, text: think });
        await writeEvent("response.reasoning_summary_part.done", { item_id: rsId, output_index: 0, summary_index: 0, part: { type: "summary_text", text: think } });
        const rsItem = { type: "reasoning", id: rsId, summary: think ? [{ type: "summary_text", text: think }] : [] };
        await writeEvent("response.output_item.done", { output_index: 0, item: rsItem });
        finalOutput.push(rsItem);
        oi = 1;
      }

      if (textOpened || r2.clean) {
        const rem = r2.clean.slice(commonPrefixLen(r2.clean, textFilter.state.emitted));
        if (rem) await writeEvent("response.output_text.delta", { item_id: msgId, output_index: msgOI, content_index: 0, delta: rem });
        const text = r2.clean;
        await writeEvent("response.output_text.done", { item_id: msgId, output_index: msgOI, content_index: 0, text });
        await writeEvent("response.content_part.done", { item_id: msgId, output_index: msgOI, content_index: 0, part: { type: "output_text", text, annotations: [] } });
        const msgItem = {
          type: "message", id: msgId, status: "completed", role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        };
        await writeEvent("response.output_item.done", { output_index: msgOI, item: msgItem });
        finalOutput.push(msgItem);
        oi = msgOI + 1;
      }

      if (allCalls.length) {
        for (const c of allCalls) {
          const fcId = "fc_" + rand();
          const item = {
            type: "function_call", id: fcId, call_id: c.id,
            name: c.function.name, arguments: c.function.arguments, status: "completed",
          };
          await writeEvent("response.output_item.added", { output_index: oi, item: { ...item, arguments: "" } });
          const args = c.function.arguments || "";
          // 一次性发出全部 arguments（不切片，最大化流式吞吐）
          if (args) {
            await writeEvent("response.function_call_arguments.delta", { item_id: fcId, output_index: oi, delta: args });
          }
          await writeEvent("response.function_call_arguments.done", { item_id: fcId, output_index: oi, arguments: args });
          await writeEvent("response.output_item.done", { output_index: oi, item });
          finalOutput.push(item);
          oi++;
        }
      }

      const final = shell("completed", finalOutput);
      if (usage) final.usage = responsesUsage(usage);
      await writeEvent("response.completed", { response: final });
    } catch (e: any) {
      try {
        await writeEvent("response.failed", { response: { ...shell("failed", []), error: { code: "upstream_error", message: e.message } } });
      } catch {}
    } finally {
      if (hb) clearInterval(hb);
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function handleCnb(path: string, request: Request, url: URL) {
  // OpenAI Responses API
  if (path.endsWith("/responses") && request.method === "POST") {
    return await handleCnbResponses(request);
  }

  if (path.endsWith("/models") && request.method === "GET") {
    return new Response(JSON.stringify({ object: "list", data: CNB_MODELS }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  if (path.endsWith("/chat/completions") && request.method === "POST") {
    let bodyText: string;
    try { bodyText = await request.text(); }
    catch (e: any) { return cnbErr(400, "Failed to read body", e.message); }

    const p = safeJsonParse(bodyText);
    if (p.error) return cnbErr(400, "Invalid JSON", p.error.message);

    let built;
    try { built = cnbBuildUpstream(p.data || {}); }
    catch (e: any) { return cnbErr(400, "Bad request", e.message); }

    const { upstream: upBody, hasTools } = built;
    const wantStream = !!(p.data && p.data.stream);

    // 统一走 cnbCallUpstream：串行闸 + 1MiB 预检 + 退避重试 + flash→pro 兜底
    // （替代原先手写的"网络错重试一次/非 200 刷新 csrf 再试一次"）
    let upstreamResp: Response | null = null;
    try { upstreamResp = await cnbCallUpstream(upBody); }
    catch (e: any) { return cnbErr(502, "Upstream error", e.message); }
    if (upstreamResp.status !== 200) {
      let errBody = "";
      try { errBody = await upstreamResp.text(); } catch {}
      return cnbUpstreamFail(upstreamResp.status, errBody);
    }

    // ─── 非流式 ───
    if (!wantStream) {
      const textParts: string[] = [], thinkParts: string[] = [];
      let id: any = null, created = Math.floor(Date.now() / 1000), finish = "stop", usage: any = null;
      try {
        for await (const chunk of cnbIter(upstreamResp)) {
          if (id == null) { id = chunk.id; created = chunk.created || created; }
          for (const ch of chunk.choices || []) {
            const d = ch.delta || {};
            if (d.content) textParts.push(d.content);
            if (d.reasoning_content) thinkParts.push(d.reasoning_content);
            if (ch.finish_reason) finish = ch.finish_reason;
          }
          if (chunk.usage) usage = chunk.usage;
        }
      } catch (e: any) { return cnbErr(502, "Stream read error", e.message); }

      const fullText = textParts.join("");
      const fullThink = thinkParts.join("");
      const msg: any = { role: "assistant" };

      if (hasTools) {
        const r1 = cnbParseToolCalls(fullThink, p.data.tools);
        const r2 = cnbParseToolCalls(fullText, p.data.tools);
        const allCalls = [...r1.calls, ...r2.calls];

        if (allCalls.length) {
          msg.tool_calls = allCalls;
          msg.content = (r2.calls.length ? r2.clean : fullText) || null;
          finish = "tool_calls";
        } else {
          msg.content = fullText;
        }
        const thinkOut = r1.calls.length ? r1.clean : fullThink;
        if (thinkOut) msg.reasoning_content = thinkOut;
      } else {
        msg.content = fullText;
        if (fullThink) msg.reasoning_content = fullThink;
      }

      const resp: any = {
        id: id || "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created,
        model: upBody.model,
        choices: [{ index: 0, message: msg, finish_reason: finish }],
      };
      if (usage) resp.usage = usage;
      return new Response(JSON.stringify(resp), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // ─── 流式 ───
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();

    (async () => {
      let chatId: any = null;
      let created = Math.floor(Date.now() / 1000);
      let finish = "stop";
      let usage: any = null;

      const write = (obj: any) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const emit = (delta: any) =>
        write({
          id: chatId, object: "chat.completion.chunk", created, model: upBody.model,
          choices: [{ index: 0, delta, finish_reason: null }],
        });

      try {
        // ─── 无 tools：逐 chunk 直通，每个 delta 立即转发 ───
        if (!hasTools) {
          for await (const chunk of cnbIter(upstreamResp!)) {
            if (chatId == null) { chatId = chunk.id || "chatcmpl-" + Date.now(); created = chunk.created || created; }
            for (const ch of chunk.choices || []) {
              if (ch.finish_reason) finish = ch.finish_reason;
              const d = ch.delta || {};
              if (d.role) await emit({ role: d.role });
              if (d.reasoning_content) await emit({ reasoning_content: d.reasoning_content });
              if (d.content) await emit({ content: d.content });
            }
            if (chunk.usage) usage = chunk.usage;
          }
        } else {
          // ─── 有 tools：正文/思考实时流出；疑似工具标记的部分扣住，流结束后统一解析 ───
          const textFilter = createLiveFilter();
          const thinkFilter = createLiveFilter();

          for await (const chunk of cnbIter(upstreamResp!)) {
            if (chatId == null) { chatId = chunk.id || "chatcmpl-" + Date.now(); created = chunk.created || created; }
            for (const ch of chunk.choices || []) {
              const d = ch.delta || {};
              if (ch.finish_reason) finish = ch.finish_reason;
              if (d.reasoning_content) {
                const out = thinkFilter.push(d.reasoning_content);
                if (out) await emit({ reasoning_content: out });
              }
              if (d.content) {
                const out = textFilter.push(d.content);
                if (out) await emit({ content: out });
              }
            }
            if (chunk.usage) usage = chunk.usage;
          }

          const r1 = cnbParseToolCalls(thinkFilter.state.full, p.data.tools);
          const r2 = cnbParseToolCalls(textFilter.state.full, p.data.tools);
          const allCalls = [...r1.calls, ...r2.calls];

          // 尾段 = 清理后的全文 − 已实时发出的前缀（扣住的标记段 + 标记之后的正文）
          const thinkRem = r1.clean.slice(commonPrefixLen(r1.clean, thinkFilter.state.emitted));
          if (thinkRem) await emit({ reasoning_content: thinkRem });

          const textRem = r2.clean.slice(commonPrefixLen(r2.clean, textFilter.state.emitted));
          if (textRem) await emit({ content: textRem });

          if (allCalls.length) {
            // ★ 标准 OpenAI 流式 tool_calls，arguments 分片
            // 1) 每个 call 先发 role + id + name + 空 arguments
            for (let i = 0; i < allCalls.length; i++) {
              const c = allCalls[i];
              await write({
                id: chatId, object: "chat.completion.chunk", created, model: upBody.model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: i,
                      id: c.id,
                      type: "function",
                      function: { name: c.function.name, arguments: "" },
                    }],
                  },
                  finish_reason: null,
                }],
              });
            }
            // 2) arguments 一次性发出（不切片，最大化流式吞吐）
            for (let i = 0; i < allCalls.length; i++) {
              const args = allCalls[i].function.arguments || "";
              await write({
                id: chatId, object: "chat.completion.chunk", created, model: upBody.model,
                choices: [{
                  index: 0,
                  delta: { tool_calls: [{ index: i, function: { arguments: args } }] },
                  finish_reason: null,
                }],
              });
            }
            finish = "tool_calls";
          }
        }

        const tail: any = { id: chatId, object: "chat.completion.chunk", created, model: upBody.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] };
        if (usage) tail.usage = usage;
        await write(tail);
        await writer.write(enc.encode("data: [DONE]\n\n"));
      } catch (e: any) {
        try {
          await write({ error: { message: e.message, type: "upstream_error" } });
          await writer.write(enc.encode("data: [DONE]\n\n"));
        } catch {}
      } finally {
        try { await writer.close(); } catch {}
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",
      },
    });
  }

  return cnbErr(404, "Not found");
}
