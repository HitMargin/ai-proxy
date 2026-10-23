// 一次性取证查看器：读 .tmp-cnb-compact-*.json，回答三个问题——
// ① 那 ~830KB 的 system 是什么 ② 用户的任务在不在摘要里 ③ split 为何冻结
for (const f of Deno.args) {
  const d = JSON.parse(await Deno.readTextFile(f));
  console.log("=".repeat(80));
  console.log(f);
  const byRole = (rows: any[]) => {
    const m = new Map<string, { n: number; bytes: number }>();
    for (const r of rows) {
      const e = m.get(r.role) ?? { n: 0, bytes: 0 };
      e.n++;
      e.bytes += r.bytes;
      m.set(r.role, e);
    }
    return [...m].map(([k, v]) =>
      `${k}:${v.n}条/${(v.bytes / 1024).toFixed(0)}KB`
    ).join("  ");
  };
  console.log(
    "at:",
    new Date(d.at).toISOString(),
    "bytesIn:",
    d.bytesIn,
    "budget:",
    d.budget,
  );
  console.log("note:", d.note);
  console.log(
    "incoming:",
    byRole(d.incoming ?? []),
    "total",
    (d.incoming ?? []).length,
    "条",
  );
  console.log(
    "final:   ",
    byRole(d.final ?? []),
    "total",
    (d.final ?? []).length,
    "条",
  );
  if (d.state) {
    console.log("state.covered:", JSON.stringify(d.state.covered));
    console.log("state.coveredHash:", d.state.coveredHash);
    console.log("state.recent:", (d.state.recent ?? []).length, "条");
    console.log("state.summary:", (d.state.summary ?? "").length, "chars");
  } else {
    console.log("state: null（无既有压缩态）");
  }
  const s = d.summary ?? "";
  console.log("summary len:", s.length, "chars");
  console.log("summary head:", JSON.stringify(s.slice(0, 1500)));
  console.log("incoming 第一条 user（任务候选）:");
  const task = (d.incoming ?? []).find((r: any) =>
    r.role === "user" && !r.head.startsWith("<system-reminder")
  );
  if (task) {
    console.log(
      "  idx",
      task.i,
      "bytes",
      task.bytes,
      "head:",
      JSON.stringify(task.head.slice(0, 300)),
    );
  } else console.log("  （无）");
  console.log("incoming 最老 8 条:");
  for (const r of (d.incoming ?? []).slice(0, 8)) {
    console.log(
      `  [${r.i}] ${r.role} ${r.bytes}B ${
        JSON.stringify(r.head.slice(0, 110))
      }`,
    );
  }
  console.log("final 最老 8 条:");
  for (const r of (d.final ?? []).slice(0, 8)) {
    console.log(
      `  [${r.i}] ${r.role} ${r.bytes}B ${
        JSON.stringify(r.head.slice(0, 110))
      }`,
    );
  }
}
