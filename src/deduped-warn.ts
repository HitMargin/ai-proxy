/**
 * 按原因去重的告警器。
 *
 * ★ 2026-10-19 加。来源是一段生产日志：`[v1] custom: no custom providers are
 * configured yet` 连续出现约 60 行，把渠道报错、额度、上游 5xx 全挤出了插件的
 * 环形缓冲。原因是 `v1FetchMemberModels()` 在每个 `/v1/models` **和**每个
 * `/v1/chat/completions` 上都会跑，而「没配置自定义供应商」是一个**稳定状态**
 * ——它不会因为重试而恢复，所以每次调用的 warn 都是同一句话。
 *
 * 为什么不是直接把日志删掉：AGENTS.md 记着「静默零」这类缺陷——一个明明是
 * “配了但列不出模型”的渠道不能因为怕刷屏就完全不说话，那会让真正的故障消失。
 * 所以消息保留，只加去重：**原因变了才说**。
 *
 * 判据：同一个原因连续 N 次只输出 1 行；原因一变立刻输出（“还没配” →
 * “配了但空” 是一次真实的状态变化，用户需要看到它发生了）。
 */
export class DedupedWarn {
  private last = "";

  constructor(
    private readonly emit: (message: string) => void = (m) => console.warn(m),
  ) {}

  /**
   * 输出一行，除非与上一次的原因相同。
   *
   * @returns 是否真的输出了（测试靠它断言，不依赖 console 捕获）。
   */
  warn(reason: string): boolean {
    if (reason === this.last) return false;
    this.last = reason;
    this.emit(reason);
    return true;
  }

  /** 允许再次输出同一个原因（状态先恢复、后又变坏时用得上）。 */
  reset(): void {
    this.last = "";
  }

  get lastReason(): string {
    return this.last;
  }
}
