import { deepseekWebBusinessError } from "./deepseek-web.ts";

Deno.test("classifies outer rate-limit envelope with null data", () => {
  const error = deepseekWebBusinessError({ code: 429, msg: "quota exceeded", data: null });
  if (!error || error.status !== 429 || error.kind !== "rate_limit_exceeded") {
    throw new Error(`unexpected error: ${JSON.stringify(error)}`);
  }
});

Deno.test("classifies outer auth envelope with null data", () => {
  const error = deepseekWebBusinessError({ code: 40003, msg: "Authorization Failed", data: null });
  if (!error || error.status !== 403 || error.kind !== "auth") {
    throw new Error(`unexpected error: ${JSON.stringify(error)}`);
  }
});

Deno.test("prefers a non-zero outer code over inner zero", () => {
  const error = deepseekWebBusinessError({ code: 40003, msg: "Authorization Failed", data: { code: 0 } });
  if (!error || error.kind !== "auth") {
    throw new Error(`unexpected error: ${JSON.stringify(error)}`);
  }
});

Deno.test("does not classify ordinary content keywords as errors", () => {
  const error = deepseekWebBusinessError({ content: "The server looks busy right now" });
  if (error !== null) throw new Error(`ordinary content was misclassified: ${JSON.stringify(error)}`);
});
