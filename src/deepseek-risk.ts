export type DeepSeekRiskLevel = "low" | "moderate" | "high" | "critical";

interface RiskState {
  recentRequests: number[];
  totalRequests: number;
  consecutiveRequests: number;
  lastPromptChars: number;
  lastRequestAt: number;
  lastSuccessAt: number;
  restrictedUntil: number;
  restrictionReason: string;
}

const state: RiskState = {
  recentRequests: [],
  totalRequests: 0,
  consecutiveRequests: 0,
  lastPromptChars: 0,
  lastRequestAt: 0,
  lastSuccessAt: 0,
  restrictedUntil: 0,
  restrictionReason: "",
};

const WINDOW_MS = 5 * 60_000;

function prune(now: number): void {
  state.recentRequests = state.recentRequests.filter((at) => now - at < WINDOW_MS);
}

export function noteDeepSeekRequest(promptChars: number): void {
  const now = Date.now();
  prune(now);
  state.recentRequests.push(now);
  state.totalRequests++;
  state.consecutiveRequests++;
  state.lastPromptChars = promptChars;
  state.lastRequestAt = now;
}

export function noteDeepSeekSuccess(): void {
  state.lastSuccessAt = Date.now();
}

export function noteDeepSeekRestriction(reason: string, durationMs: number): void {
  const until = Date.now() + durationMs;
  state.restrictedUntil = Math.max(state.restrictedUntil, until);
  state.restrictionReason = reason;
}

export interface DeepSeekRiskSnapshot {
  riskScore: number;
  riskLevel: DeepSeekRiskLevel;
  estimatedRiskPercent: number;
  requestsLast5m: number;
  totalRequests: number;
  consecutiveRequests: number;
  lastPromptChars: number;
  cooldownRemainingMs: number;
  factors: string[];
  disclaimer: string;
  updatedAt: string;
}

export function getDeepSeekRiskSnapshot(): DeepSeekRiskSnapshot {
  const now = Date.now();
  prune(now);
  const recent = state.recentRequests.length;
  const cooldownRemainingMs = Math.max(0, state.restrictedUntil - now);
  const factors: string[] = [];
  let score = 5;

  if (recent > 5) {
    const excess = recent - 5;
    score += Math.min(35, excess * 3);
    factors.push(`最近 5 分钟请求 ${recent} 次`);
  }
  if (state.consecutiveRequests > 10) {
    score += Math.min(25, (state.consecutiveRequests - 10) * 3);
    factors.push(`连续请求 ${state.consecutiveRequests} 次`);
  }
  if (state.lastPromptChars >= 100_000) {
    score += 10;
    factors.push(`最近 prompt ${state.lastPromptChars} 字符`);
  }
  if (cooldownRemainingMs > 0) {
    score = Math.max(score, 85);
    factors.push(`上游限制冷却中：${Math.ceil(cooldownRemainingMs / 60_000)} 分钟`);
  }
  if (state.lastSuccessAt > 0 && now - state.lastSuccessAt > 30 * 60_000) {
    score += 5;
    factors.push("超过 30 分钟没有成功请求");
  }
  if (factors.length === 0) factors.push("暂无明显异常请求模式");

  score = Math.max(0, Math.min(100, Math.round(score)));
  const riskLevel: DeepSeekRiskLevel = score >= 85 ? "critical" : score >= 60 ? "high" : score >= 30 ? "moderate" : "low";
  return {
    riskScore: score,
    riskLevel,
    estimatedRiskPercent: score,
    requestsLast5m: recent,
    totalRequests: state.totalRequests,
    consecutiveRequests: state.consecutiveRequests,
    lastPromptChars: state.lastPromptChars,
    cooldownRemainingMs,
    factors,
    disclaimer: "这是基于本地请求行为的启发式风险分数，不是 DeepSeek 官方封号概率。",
    updatedAt: new Date(now).toISOString(),
  };
}
