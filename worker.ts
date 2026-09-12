// Cloudflare Workers 入口（wrangler main）；vars 绑定注入到 ENV
import { handler, ENV } from "./main.ts";

export default {
  fetch(request: Request, env: any): Promise<Response> {
    if (env && typeof env === "object") {
      for (const k of Object.keys(ENV)) {
        const v = env[k];
        if (typeof v === "string" && v) (ENV as any)[k] = v;
      }
    }
    return handler(request);
  },
};
