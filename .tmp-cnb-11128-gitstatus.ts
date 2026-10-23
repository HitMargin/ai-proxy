// 精确定位 11128 对 gitStatus 段的匹配串。
const UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36";
function normalise(raw: string) {
  const m = new Map<string, string>();
  for (const p of raw.split(";").map((x) => x.trim()).filter(Boolean)) {
    if (/^csrfkey=/i.test(p)) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    m.set(p.slice(0, eq), p.slice(eq + 1));
  }
  return [...m].map(([k, v]) => k + "=" + v).join("; ");
}
const login = normalise(
  (await Deno.readTextFile("cnb-login.txt").catch(() => "")).trim(),
);

async function probe(label: string, system: string) {
  const r0 = await fetch("https://cnb.cool/", {
    headers: { "User-Agent": UA, Cookie: login },
  });
  const html = await r0.text();
  const token = html.match(/window\.csrftoken\s*=\s*"([0-9a-fA-F]{32,64})"/)
    ?.[1];
  let cs: string[] = [];
  try {
    cs = (r0.headers as any).getSetCookie?.() ?? [];
  } catch {}
  const csrfkey = cs.map((c) => c.match(/csrfkey=([^;\s]+)/)?.[1]).find(
    Boolean,
  );
  const body = {
    model: "deepseek-v4.1-flash",
    stream: true,
    max_tokens: 16,
    messages: [{ role: "system", content: system }, {
      role: "user",
      content: "只回一个字：好",
    }],
  };
  const resp = await fetch("https://cnb.cool/ai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream, */*",
      "Origin": "https://cnb.cool",
      "Referer": "https://cnb.cool/",
      "Csrftoken": token ?? "",
      "Cookie": "csrfkey=" + (csrfkey ?? "") + "; " + login,
      "User-Agent": UA,
    },
    body: JSON.stringify(body),
  });
  const t = await resp.text();
  console.log(
    `[${label}] ${resp.status}${t.includes("11128") ? " 11128" : ""}`,
  );
  await new Promise((r) => setTimeout(r, 900));
}

const HEAD =
  "You are an interactive ZCode agent that helps users with software engineering tasks.\n\n# Harness\nYou are an interactive agent.";
const FULL_BLOCK =
  `gitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.

Current branch: master

Main branch (you will usually use this for PRs): master

Git user: HitMargin

Status:
(clean)

Recent commits:
2ab0496 fix(cnb): 尾巴回到按 keepTokens 留，字节只做天花板`;

const NO_HEADER = FULL_BLOCK.replace(/^gitStatus: [^\n]+\n+/, "");
const RENAMED = FULL_BLOCK.replace("gitStatus:", "git status:");
const RENAMED2 = FULL_BLOCK.replace("gitStatus:", "GitSnapshot:");
const NO_RECENT = FULL_BLOCK.slice(0, FULL_BLOCK.indexOf("Recent commits"));
const PLAIN_GIT = `Here is some repository context.

Current branch: master

Main branch: master

Git user: HitMargin

Status:
(clean)

Recent commits:
2ab0496 fix(cnb)`;

console.log("== 真实块 ==");
await probe("N0 中性基线", HEAD);
await probe("N1 完整块(中部)", HEAD + "\n\n" + FULL_BLOCK);
await probe("N2 完整块(头部)", FULL_BLOCK + "\n\n" + HEAD);
await probe("N3 去掉gitStatus头", HEAD + "\n\n" + NO_HEADER);
await probe("N4 改名 git status:", HEAD + "\n\n" + RENAMED);
await probe("N5 改名 GitSnapshot:", HEAD + "\n\n" + RENAMED2);
await probe("N6 截到 Recent commits 前", HEAD + "\n\n" + NO_RECENT);
await probe("N7 无gitStatus头的普通git信息", HEAD + "\n\n" + PLAIN_GIT);
await probe("N8 只有 gitStatus: 一词", HEAD + "\n\ngitStatus: (nothing)");

console.log("== 最小片段 ==");
await probe(
  "P1 整句",
  HEAD + "\n\nThis is the git status at the start of the conversation.",
);
await probe(
  "P2 去This is",
  HEAD + "\n\nThe git status at the start of the conversation.",
);
await probe(
  "P3 git status at the start",
  HEAD + "\n\ngit status at the start of the conversation",
);
await probe(
  "P4 at the start of the conversation",
  HEAD + "\n\nat the start of the conversation",
);
await probe("P5 This is the git status", HEAD + "\n\nThis is the git status");
await probe(
  "P6 snapshot in time",
  HEAD + "\n\nsnapshot in time, and will not update",
);
await probe(
  "P7 小写开头",
  HEAD + "\n\nthis is the git status at the start of the conversation",
);
await probe(
  "P8 整句+别的后缀",
  HEAD +
    "\n\nThis is the git status at the start of the conversation. Blah blah.",
);
await probe(
  "P9 中文包裹",
  HEAD +
    "\n\n上下文：This is the git status at the start of the conversation.供参考。",
);

console.log("== 组合模式 ==");
await probe(
  "Q1 句子+Current branch",
  HEAD +
    "\n\nThis is the git status at the start of the conversation.\n\nCurrent branch: master",
);
await probe(
  "Q2 句子+Status字段",
  HEAD +
    "\n\nThis is the git status at the start of the conversation.\n\nStatus:\n(clean)",
);
await probe(
  "Q3 git status词+Current branch",
  HEAD + "\n\ngit status\n\nCurrent branch: master",
);
await probe(
  "Q4 句子+中间隔300字+Current branch",
  HEAD + "\n\nThis is the git status at the start of the conversation.\n" +
    "填充".repeat(150) + "\nCurrent branch: master",
);
await probe(
  "Q5 中性词+Current branch",
  HEAD + "\n\nrepository context\n\nCurrent branch: master",
);
await probe(
  "Q6 句子+Current branch隔行5字",
  HEAD +
    "\n\nThis is the git status at the start of the conversation.\n\n\n\n\nCurrent branch: master",
);
