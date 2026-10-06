import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { CachedCredential, envBackedStore } from "./credential-source.ts";

// `deno task test` 只开 --allow-env，所以文件与环境都用内存假件。

function fakeFs() {
  const files = new Map<string, { data: string; mtime: number }>();
  let reads = 0;
  let clock = 1;
  return {
    files,
    get reads() {
      return reads;
    },
    put(path: string, data: string) {
      files.set(path, { data, mtime: clock++ });
    },
    io: {
      stamp: (path: string) => files.get(path)?.mtime,
      read: (path: string) => {
        reads++;
        const f = files.get(path);
        if (f === undefined) throw new Error("ENOENT " + path);
        return f.data;
      },
    },
  };
}

function fakeEnv(initial: Record<string, string> = {}) {
  const vars = { ...initial };
  return { vars, get: (name: string) => vars[name] ?? "" };
}

// ---------- CachedCredential ----------

Deno.test("an env var wins over the file and is normalised", () => {
  const fs = fakeFs();
  fs.put("./c.txt", "from-file");
  const env = fakeEnv({ C: "  from-env\r\n" });
  const c = new CachedCredential("C", "./c.txt", fs.io, env.get);
  assertEquals(c.load(), { value: "from-env", source: "env", changed: true });
  assertEquals(fs.reads, 0);
});

Deno.test("the file is read once and then only stat'ed while unchanged", () => {
  const fs = fakeFs();
  fs.put("./c.txt", "v1");
  const c = new CachedCredential("C", "./c.txt", fs.io, fakeEnv().get);
  assertEquals(c.load().changed, true);
  assertEquals(c.load(), { value: "v1", source: "file", changed: false });
  assertEquals(c.load().changed, false);
  assertEquals(fs.reads, 1);
});

Deno.test("a rewritten file is hot-reloaded", () => {
  const fs = fakeFs();
  fs.put("./c.txt", "v1");
  const c = new CachedCredential("C", "./c.txt", fs.io, fakeEnv().get);
  c.load();
  fs.put("./c.txt", "v2");
  assertEquals(c.load(), { value: "v2", source: "file", changed: true });
});

Deno.test("deleting the file reports none and clears the value", () => {
  const fs = fakeFs();
  fs.put("./c.txt", "v1");
  const c = new CachedCredential("C", "./c.txt", fs.io, fakeEnv().get);
  c.load();
  fs.files.delete("./c.txt");
  assertEquals(c.load(), { value: "", source: "none", changed: true });
  assertEquals(c.load().changed, false);
});

Deno.test("a whitespace-only env var falls through to the file", () => {
  const fs = fakeFs();
  fs.put("./c.txt", "v1");
  const c = new CachedCredential(
    "C",
    "./c.txt",
    fs.io,
    fakeEnv({ C: "  " }).get,
  );
  assertEquals(c.load().source, "file");
});

Deno.test("an empty file counts as no credential", () => {
  const fs = fakeFs();
  fs.put("./c.txt", "\r\n  ");
  const c = new CachedCredential("C", "./c.txt", fs.io, fakeEnv().get);
  assertEquals(c.load(), { value: "", source: "none", changed: false });
});

// ---------- envBackedStore ----------

function memoryIo() {
  const files = new Map<string, string>();
  const writes: string[] = [];
  let failWrites = false;
  return {
    files,
    writes,
    set failWrites(v: boolean) {
      failWrites = v;
    },
    io: {
      read: (path: string) => {
        const v = files.get(path);
        return v === undefined
          ? Promise.reject(new Error("ENOENT"))
          : Promise.resolve(v);
      },
      write: (path: string, data: string) => {
        writes.push(path);
        if (failWrites) return Promise.reject(new Error("EROFS"));
        files.set(path, data);
        return Promise.resolve();
      },
    },
  };
}

Deno.test("a refresh is seen by the next read when the credential comes from env", async () => {
  const mem = memoryIo();
  const env = fakeEnv({ T: "old" });
  const store = envBackedStore("T", mem.io, env.get);
  assertEquals(await store.read("/t.json"), "old");
  await store.write("/t.json", "refreshed");
  // 否则每个请求都会拿回过期的环境变量、再续期一次。
  assertEquals(await store.read("/t.json"), "refreshed");
  assertEquals(await store.read("/t.json"), "refreshed");
});

Deno.test("an env-backed credential is never written to the file", async () => {
  const mem = memoryIo();
  mem.files.set("/t.json", "local-account");
  const store = envBackedStore("T", mem.io, fakeEnv({ T: "cloud" }).get);
  await store.read("/t.json");
  await store.write("/t.json", "refreshed");
  assertEquals(mem.writes, []);
  assertEquals(mem.files.get("/t.json"), "local-account");
});

Deno.test("a failing write is swallowed and the refresh still takes effect", async () => {
  const mem = memoryIo();
  mem.files.set("/t.json", "old");
  mem.failWrites = true;
  const store = envBackedStore("T", mem.io, fakeEnv().get);
  await store.read("/t.json");
  await store.write("/t.json", "refreshed");
  assertEquals(mem.writes, ["/t.json"]);
  assertEquals(await store.read("/t.json"), "refreshed");
});

Deno.test("a new login on disk beats an older in-memory refresh", async () => {
  const mem = memoryIo();
  mem.files.set("/t.json", "old");
  mem.failWrites = true;
  const store = envBackedStore("T", mem.io, fakeEnv().get);
  await store.read("/t.json");
  await store.write("/t.json", "refreshed");
  mem.files.set("/t.json", "new-login");
  assertEquals(await store.read("/t.json"), "new-login");
  assertEquals(await store.read("/t.json"), "new-login");
});

Deno.test("a new env value beats an older in-memory refresh", async () => {
  const mem = memoryIo();
  const env = fakeEnv({ T: "old" });
  const store = envBackedStore("T", mem.io, env.get);
  await store.read("/t.json");
  await store.write("/t.json", "refreshed");
  env.vars.T = "rotated-by-operator";
  assertEquals(await store.read("/t.json"), "rotated-by-operator");
});

Deno.test("once the refresh lands on disk the file is the truth again", async () => {
  const mem = memoryIo();
  mem.files.set("/t.json", "old");
  const store = envBackedStore("T", mem.io, fakeEnv().get);
  await store.read("/t.json");
  await store.write("/t.json", "refreshed");
  assertEquals(await store.read("/t.json"), "refreshed");
  // 之后再登录一次：不能被已作废的覆盖层挡住。
  mem.files.set("/t.json", "old");
  assertEquals(await store.read("/t.json"), "old");
});

Deno.test("deleting the file is a sign-out, not masked by the overlay", async () => {
  const mem = memoryIo();
  mem.files.set("/t.json", "old");
  mem.failWrites = true;
  const store = envBackedStore("T", mem.io, fakeEnv().get);
  await store.read("/t.json");
  await store.write("/t.json", "refreshed");
  mem.files.delete("/t.json");
  await assertRejects(() => store.read("/t.json"));
});
