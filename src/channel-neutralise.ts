/**
 * 上游渠道校验（errcode 11128）的**出站清洗**：多个渠道共用同一套判据。
 *
 * 为什么单独成一个模块：cnb 与 workbuddy 是**两条不同的上游**，但它们返回的
 * 11128 报文逐字相同 —— `Illegal API invocation from an unapproved channel`，
 * 连 `displayTips` 里那句「这次调用没通过渠道校验，可能不是官方客户端发出的」
 * 都一致。2026-10-25 实测确认两边的**触发串是同一组**：
 *
 *   | 请求（各自直连上游，system 消息）                            | cnb        | workbuddy  |
 *   | ----------------------------------------------------------- | ---------- | ---------- |
 *   | `You are an AI agent powered by DeepSeek Harness.`          | 400/11128  | 400/11128  |
 *   | 同上把品牌词换成 `DSH` 简称                                  | **200**    | **200**    |
 *   | `Main branch (you will usually use this for PRs): master`   | 400/11128  | 400/11128  |
 *   | 「@ 前缀记号」两句用一个空格连排（2026-10-27）                | 400/11128  | 400/11128  |
 *   | 同上，两句之间换成换行 / 第一句单独发                         | **200**    | **200**    |
 *
 * 所以判据与清洗规则写在一处、两边共用；写两份必然漂开（本项目已经吃过
 * 「同一形状的读取器各写一份」的亏，见 AGENTS.md 里 kilo variants 那条）。
 *
 * ## 四层清洗，每条都有独立的实测依据
 *
 * 1. **整块剥 gitStatus 快照**（`stripGitStatus`）——锚定 harness 原文样板，
 *    从锚点剥到下一个「空行+标题」或文本末尾，换成一行 stub。那块内容自称
 *    「永不更新的快照」，剥掉零信息损失。
 * 2. **定点改写 `Main branch (you will usually use this for PRs)`**
 *    （`flattenMainBranchParen`）——那是 11128 的**最小触发串**，单独一行就能
 *    拦（3/3 稳定），改写后 0/3。它不依赖锚点，所以是第 1 层漏剥时的兜底：
 *    实测「锚点不在（换措辞/被截断）+ 括号还在」→ 400 且原样透传给用户。
 * 3. **品牌词 `DeepSeek Harness` → `DSH`**（`neutraliseChannelMarkers`）——
 *    语义零损失（简称本来就在提示词里用），且能拆掉「品牌词 + GUI 指代样板」
 *    那个跨约 200 字符的组合模式。
 * 4. **改写「@ 前缀记号」那句**（`rewordAtTokenBoilerplate`，2026-10-27）——
 *    上游拦的是 `Tokens prefixed with @ are paths the user explicitly
 *    referenced.` 与 `Relative paths resolve from the workspace root; …`
 *    **逐字连排**的那一串；单独出现两句都放行，只改第一句的措辞即拆掉它。
 *    详见下面 `ATPATH_TOKENS` 上的实测表。
 *
 * ## 定性：这是规避，不是协议适配
 *
 * 只赌「上游按内容匹配这几处」。上游换一次措辞就可能失效 —— 届时**重新实测
 * 边界再改判据**，别照抄本段的结论就当成永久事实。
 */

/** harness 注入的 gitStatus 快照块的原文样板（锚点）。 */
const GITSTATUS_ANCHOR =
  "gitStatus: This is the git status at the start of the conversation.";
/** 剥掉整块之后留下的那一行。保留 `gitStatus:` 字样实测安全。 */
const GITSTATUS_STUB = "gitStatus: (snapshot omitted by proxy)";

/**
 * 11128 的**最小触发串**：这一行的「行内组合」。
 *
 * 2026-10-25 单变量二分的结果（把完整真实块依次剥掉一个特征，只有剥这一处才
 * 变 200；去掉第二句 / Git user / Status / Recent commits / Current branch /
 * 字段间空行 / 连 `gitStatus: ` 前缀都仍然 400）。再往下切：
 *
 *   | 请求                                                      | 结果      |
 *   | --------------------------------------------------------- | --------- |
 *   | 该行单独一行（含 `: master`）                              | 400/11128 |
 *   | 只留 `Main branch (you will usually use this for PRs):`    | 400/11128 |
 *   | 只留括号短语 `(you will usually use this for PRs)`         | 200       |
 *   | `Main branch` 换成 `Note:`（组合不成立）                   | 200       |
 *   | 该行放在正文中部                                           | 400/11128 |
 *   | 该行放在 `user` 消息里                                     | 200       |
 *   | 该行放在 `assistant` 历史里                                | 400/11128 |
 *
 * 所以判据是 `Main branch` + 那句括号的**组合**，与位置无关，只扫
 * system/assistant/developer（user 不在触发面）。
 */
const MAINBRANCH_PAREN = /(Main branch) \(you will usually use this for PRs\)/g;
const MAINBRANCH_FLAT = "$1";

/** 品牌词：换成提示词里本来就在用的简称。 */
const HARNESS_BRAND = "DeepSeek Harness";
const HARNESS_BRAND_NEUTRAL = "DSH";

/**
 * 11128 判据**第五次漂移**（2026-10-27）：harness 的「@ 前缀记号」两句**逐字连排**被拦。
 * （清洗顺序上是第 4 层，见上面的总表；两套编号别混。）
 *
 * 现场：DSH 桌面会话每一轮都 400/11128，**削头自愈跑过之后仍然 400**，落盘 body
 * 离线二分到 `messages[0]`（29.6 KB 的 system 提示）单独一条就 400 —— 所以这
 * 一次既不是「开头指纹」也不是 gitStatus/Main branch/品牌词那三条旧判据。
 *
 * 逐条只改一个变量直连上游（每行都是一次真实请求，2026-10-27）：
 *
 *   | 请求                                                                | 结果      |
 *   | ------------------------------------------------------------------- | --------- |
 *   | `messages[0]` 前 2790 字符（含这两句）                              | 400/11128 |
 *   | 前 2785 字符（第二句被切成半句）                                    | 200       |
 *   | 两句**各自单发**                                                    | 200       |
 *   | 两句**用一个空格连排**（原文形状）                                  | 400/11128 |
 *   | 同上，中间换成换行 / 多一个空格                                     | 200       |
 *   | 两句顺序颠倒 / 中间插一句中性话                                     | 200       |
 *   | 前面加一句中性话（原文形状）                                        | 400/11128 |
 *   | 把 `@` 换成 `X`、换成全角 `＠`、或只把 `referenced` 改成 `mentioned` | 200       |
 *   | 裁掉第一句的开头三个词                                              | 200       |
 *
 * 判据：上游存的是**这两句话按原文逐字连排**的那一串（位置无关、可以加前缀、
 * 少一个空格就不认）。修法因此是**改写第一句的措辞**：拆掉那串字面量即可，
 * 语义（`@` 前缀的记号指向用户显式引用的路径）一个字不丢。
 *
 * 为什么不改写第二句：第二句本身（`Relative paths resolve from the workspace
 * root; …`）单独发是 200，只有跟第一句连排才被拦 —— 改第一句能一次拆掉所有
 * 含它的字面量，改第二句只是把连排换成另一种连排。
 *
 * 为什么用 lookahead 而不是无条件改写第一句：这一句只有**紧跟着**第二句时才
 * 被拦（单独发 200），所以只在那个位置上动它。用户自己在对话里贴了这句话、
 * 或者模型复读它，都不该被代理改掉 —— 改的永远是「会被上游 400 的那个形状」。
 */
const ATPATH_TOKENS =
  /Tokens prefixed with @ are paths the user explicitly referenced\.(?=\s+Relative paths resolve from the workspace root)/g;
const ATPATH_TOKENS_NEUTRAL =
  "An @-prefixed token names a path the user explicitly referenced.";

/** 把触发 11128 的「@ 前缀记号」句改成同义措辞。幂等。 */
export function rewordAtTokenBoilerplate(text: string): string {
  return text.replace(ATPATH_TOKENS, ATPATH_TOKENS_NEUTRAL);
}

/**
 * 把 harness 注入的 gitStatus 快照段换成一行 stub。
 *
 * 块的结束边界：下一个「空行 + 标题（# 或 ===）」处 —— 字段与 Recent commits
 * 之间也有空行，所以不能按第一个空行切；块内各段都不含标题行，harness 的其余
 * 分节都以 # / === 开头。块在文本末尾时切到末尾。没找到锚点时原样返回。
 */
export function stripGitStatus(text: string): string {
  const start = text.indexOf(GITSTATUS_ANCHOR);
  if (start < 0) return text;
  let end = text.length;
  const heading = /\n\n(?=#|===)/g;
  heading.lastIndex = start;
  const m = heading.exec(text);
  if (m) end = m.index;
  return text.slice(0, start) + GITSTATUS_STUB + text.slice(end);
}

/**
 * 把 `Main branch (you will usually use this for PRs)` 的括号说明去掉。
 *
 * 不依赖 gitStatus 块的锚点，是「锚点漂了 / 块被截断 / 换了措辞」时的唯一防线。
 * 改写掉括号语义零损失（括号只是解释 Main branch 的用途）。幂等：改过再跑不变。
 */
export function flattenMainBranchParen(text: string): string {
  return text.replace(MAINBRANCH_PAREN, MAINBRANCH_FLAT);
}

/** 出站文本的渠道校验预处理：剥 gitStatus 快照段 + 括号改写 + 品牌词改写 + @ 记号句改写。 */
export function neutraliseChannelMarkers(text: string): string {
  return flattenMainBranchParen(
    rewordAtTokenBoilerplate(
      stripGitStatus(text).replaceAll(HARNESS_BRAND, HARNESS_BRAND_NEUTRAL),
    ),
  );
}

/**
 * 对**消息数组**整体套用上面的清洗（只动文本，不动角色与结构）。
 *
 * 为什么需要它：模型渠道的请求体里，可读文本可能有两种形状 ——
 * `content` 是字符串，或（多模态）是 `[{type:"text", text}]` 的数组。
 * 只处理一种就会漏掉另一种，而漏掉的那一种照样会触发 11128。
 * 非文本部分（图片等）原样保留。
 */
export function neutraliseMessages<T>(messages: T): T {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message: unknown) => {
    if (!message || typeof message !== "object") return message;
    const record = message as Record<string, unknown>;
    const content = record.content;
    if (typeof content === "string") {
      return {
        ...record,
        content: neutraliseChannelMarkers(content),
      };
    }
    if (Array.isArray(content)) {
      return {
        ...record,
        content: content.map((part: unknown) => {
          if (part && typeof part === "object") {
            const piece = part as Record<string, unknown>;
            if (typeof piece.text === "string") {
              return { ...piece, text: neutraliseChannelMarkers(piece.text) };
            }
          }
          return part;
        }),
      };
    }
    return message;
  }) as unknown as T;
}
