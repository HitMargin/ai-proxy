# ai-proxy —— Render 容器镜像
#
# 为什么用容器而不是 Render 的原生运行时：本项目是 **Deno** 写的，而 Render 的原生
# 运行时只有 Node.js / Python / Ruby / Go / Rust / Elixir —— 没有 Deno。容器里跑的是
# 真正的 `deno`，所以与 Deno Deploy 同一个运行时，**零改代码**。
#
# ★ 镜像 tag 必须与开发机对齐，且**不用 `latest`**：latest 会随上游发布漂移，某次
#   部署可能因为上游改了 Deno 版本而出现与本地不同的行为。本机实测 `deno 2.9.7`，
#   所以这里 pin `2.9.7`（该 tag 在 Docker Hub 上确认为 Debian 变体）。
FROM denoland/deno:2.9.7

# 官方镜像的 entrypoint（`/tini -- docker-entrypoint.sh`）在第一个参数是已知 deno
# 子命令时会自动补上 `deno`，所以 CMD 两种写法都可以。这里写全，让它不依赖那层魔法。
#
# 为什么带 `-A`：与本地 `restart.ps1 -Local` 的启动方式完全一致（`deno run -A main.ts`）。
# 读凭据文件、读 wasm、监听端口都需要权限；按需最小化会与本地行为产生差异，而
# **「本地能跑、云上不能」正是这一轮要消灭的问题**。
#
# 注意：这里**不设 `--allow-net` 白名单**。上游渠道很多且会变（kilo/zen/cnb/trae/
# workbuddy/commandcode/custom…），白名单写死会在上游换 IP 或加渠道时静默失效——
# 那种失败看起来像「渠道挂了」，排查成本远高于这里省下的那点权限收窄。
WORKDIR /app

# 先只拷依赖清单与锁文件：这一层基本不变，改动源码时不会让依赖重新解析。
# 本项目运行时不依赖 npm/jsr 包（只有测试用 @std/assert），所以这一步主要是让
# deno.lock 与源码分处不同层，构建缓存更稳。
COPY deno.jsonc deno.lock ./

# 源码。注意 `deepseek-sha3.wasm` 必须一起进镜像：`src/deepseek-web.ts` 用
# `Deno.readFile(new URL("../deepseek-sha3.wasm", import.meta.url))` 读它，
# 而那条路径是按**模块自身位置**解析的，所以仓库的相对结构不能变。
COPY main.ts worker.ts ./
COPY src/ ./src/
COPY third_party/ ./third_party/
COPY deepseek-sha3.wasm ./

# Render 会在运行时注入 PORT（默认 10000）。main.ts:2090 的绑定逻辑认三件事：
# 显式 `HOST` > `RENDER`（自动 0.0.0.0）> 非 Deno Deploy 时回环。
# 这里显式设 HOST=0.0.0.0 而不是依赖 `RENDER`：Render 的构建阶段也会带上 `RENDER`
# 之类的变量，而**运行地址不该由「有没有某个平台变量」决定**，写死更不容易出意外。
#
# PORT 故意**不设默认值**：main.ts 自己回落到 8000，但 Render 一定会注入它自己的
# 10000。在这里写一个默认值只会让人误以为容器固定在某个端口上。
ENV HOST=0.0.0.0
# 跳过 Deno 的更新检查：容器里升级不了自己，这次联网只会拖慢健康检查的首次响应。
ENV DENO_NO_UPDATE_CHECK=1

# 以 root 运行是**刻意的**：官方镜像里有一个 uid 1993 的 `deno` 用户，但容器部署时
# 文件系统是临时的、/app 由构建阶段以 root 写入，切用户需要额外的 chown 层。这个
# 容器只跑一个监听进程、不对外开放 shell，收益不值得那份复杂度。
# （若将来要收紧：`RUN chown -R deno:deno /app` + `USER deno`，并确认 Deno 仍能
#  写 DENO_DIR=/deno-dir/ —— 那个目录在官方镜像里已经 chown 给 deno 了。）

EXPOSE 8000

CMD ["deno", "run", "-A", "main.ts"]