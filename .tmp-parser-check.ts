// 临时：验证脚本的 cookie 解析与 src/cnb.ts 逐字一致。
//
// 为什么必须对拍：脚本写 cnb-login.txt，代理读 cnb-login.txt。两个实现若不一致，
// 脚本写的文件会被代理读成别的东西——**两边各自看都对，合起来是错的**，
// 而且是静默的（没有任何一处报错，只是推理时撞 403）。
//
// 做法：把脚本里那两个函数**原文抠出来**，交给 Deno 自己转译（而不是我手写正则
// 去剥 TS 语法——那样测的是我的正则，不是被测代码），保证跑的是写盘真正用的那份。

const scriptSrc = await Deno.readTextFile("./.tmp-cnb-login.ts");

function extract(name: string): string {
  const start = scriptSrc.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`not found in script: ${name}`);
  let depth = 0, began = false, i = start;
  for (; i < scriptSrc.length; i++) {
    const ch = scriptSrc[i];
    if (ch === "{") { depth++; began = true; }
    else if (ch === "}") { depth--; if (began && depth === 0) { i++; break; } }
  }
  return scriptSrc.slice(start, i);
}

// 用 Deno 的转译器读 TS → JS。手写正则剥类型注解会连着泛型一起踩坏。
async function toJs(tsSource: string, name: string): Promise<any> {
  const tmp = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(tmp, tsSource + `\nexport { ${name} };\n`);
    const mod = await import("file://" + tmp.replace(/\\/g, "/"));
    return mod[name];
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
}

const stripCsrfkey = await toJs(extract("stripCsrfkey"), "stripCsrfkey");
const normalizeInput = await toJs(extract("normalizeInput"), "normalizeInput");

/** src/cnb.ts 的 cnbLoginCookies 内联循环，照抄。 */
function proxyImpl(raw: string): string {
  const m = new Map<string, string>();
  for (const p of raw.split(";").map((x) => x.trim()).filter(Boolean)) {
    if (/^csrfkey=/i.test(p)) continue;
    const eq = p.indexOf("=");
    m.set(p.slice(0, eq), p.slice(eq + 1));
  }
  return [...m].map(([k, v]) => k + "=" + v).join("; ");
}

// ⚠️ 这里刻意用**假值**。第一版我把用户真实粘贴的会话串写进了夹具，
// 等于把活的账号凭据从聊天记录又抄进了一个**会被 git 跟踪**的文件里——
// 夹具要的只是「形状」（CNBSESSION=xxx; csrfkey=yyy），用假值一模一样。
// 判据：写夹具时先问「这一串是真的吗」；真的就换成假的，形状不变。
const cases: Array<[string, string]> = [
  ["session + csrfkey (real shape, fake values)", "CNBSESSION=0000000000.aaaa.bbbb; csrfkey=123456789"],
  ["csrfkey first", "csrfkey=123456789; CNBSESSION=xyz"],
  ["csrfkey uppercase", "CSRFKEY=123; A=1"],
  ["duplicate later wins", "A=1; A=2"],
  ["no csrfkey", "A=1; B=2"],
  ["value contains =", "A=b=c"],
  ["trailing semicolon", "A=1;"],
  ["empty", ""],
  // 已知且**有意**的差异：手工粘贴的 " A = 1 " 这种带空格写法，
  // 代理按首个 `=` 切开得到键名 "A "（带尾空格，服务端不会匹配）；
  // 本脚本 trim 键值，得到干净的 "A"。
  // 两者只在「人手粘了带空格的 cookie」时不同，而本脚本自己写盘时从不产生空格。
  // 这里记成预期差异而不是抹平它——抹平等于把一个代理侧的健壮性缺陷
  // 复制进脚本，让脚本无法察觉那个缺陷。
  ["spaces (expected divergence)", " A = 1 ; B = 2 "],
];

let bad = 0;
for (const [name, input] of cases) {
  const mine = stripCsrfkey(normalizeInput(input));
  const theirs = proxyImpl(input.trim());
  const expectedDivergence = name.includes("expected divergence");
  const same = mine === theirs;
  if (!same && !expectedDivergence) bad++;
  const mark = same ? "same" : (expectedDivergence ? "DIFF" : "FAIL");
  console.log(`${mark} ${name}`);
  if (!same) {
    console.log(`     script=${JSON.stringify(mine)}`);
    console.log(`     proxy =${JSON.stringify(theirs)}`);
  }
}

console.log(bad === 0 ? "\nPARSER MATCH OK (script == proxy on all cases)" : `\n${bad} MISMATCH`);
if (bad > 0) Deno.exit(1);
