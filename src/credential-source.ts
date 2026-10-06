/**
 * 凭据来源：环境变量优先，文件兜底。
 *
 * 为什么需要这个模块
 * ------------------
 * 本项目曾经只从**工作目录下的文件**读凭据（`deepseek-cookies.txt`、
 * `trae-auth.json`、`workbuddy-auth.json`……）。本地跑没问题，**一上云就全
 * 坏**：Deno Deploy 与容器化平台没有「项目工作目录」这个概念，`Deno.statSync`
 * 拿不到那些文件，于是渠道静默变成「未配置」——而本地明明好用。
 *
 * cnb 是最先踩到这个的渠道（云端一律 `401 cnb requires login`），当时的修法是
 * 给它单开一个 `CNB_LOGIN_COOKIES`。**那是按渠道打补丁，改一个渠道要救一个
 * 渠道。** 这个模块把那条规则提出来共用。
 *
 * 优先级：**环境变量赢**
 * --------------------
 * 与 `credentialEnv` 的既有约定一致（「环境的副本最权威」）。理由是实践上的：
 * 本地想验证云端那套凭据时，只改环境变量就能覆盖文件，不必先把文件搬走。
 *
 * 为什么不用「文件存在就用文件」
 * ----------------------------
 * 容器里文件系统是**临时的**（Render 明说 ephemeral filesystem），重新部署即
 * 重置。若优先级反过来，一次 `restart.ps1` 留下的旧文件会永久盖住控制台上
 * 刚改的环境变量——而用户改的是环境变量，看到的却是旧凭据，无从解释。
 */

/** 读环境变量的安全包装：无 `--allow-env` 时返回空串而不是抛错。 */
export function readEnv(name: string): string {
  try {
    return Deno.env.get(name) ?? "";
  } catch {
    return "";
  }
}

/** 去 `\r` 与首尾空白。Windows 上粘出来的文件常带 CRLF，直接发进请求头会坏。 */
function normalize(raw: string): string {
  return raw.replace(/\r/g, "").trim();
}

export type CredentialSource = "env" | "file" | "none";

export type CredentialFileIo = {
  /** 返回文件的 mtime（毫秒）；文件不存在或不是普通文件时返回 `undefined`。 */
  stamp: (path: string) => number | undefined;
  read: (path: string) => string;
};

const DENO_FILE_IO: CredentialFileIo = {
  stamp: (path) => {
    try {
      const st = Deno.statSync(path);
      return st.isFile ? st.mtime?.getTime() ?? 0 : undefined;
    } catch {
      // 文件不存在是**正常状态**（云端就是这样），不是错误。
      return undefined;
    }
  },
  read: (path) => Deno.readTextFileSync(path),
};

/**
 * 一份「环境变量优先、文件兜底」的凭据，带热加载缓存。
 *
 * 缓存键是「这份内容从哪来」：环境变量那一路键里带着值本身（读环境变量很便宜），
 * 文件那一路只 `stat` 不读——**请求路径上每次都整文件同步读一遍是不必要的 IO**，
 * mtime 没变就不碰内容。
 *
 * `load()` 返回的 `changed` 让调用方只在内容真的换了时做副作用（重置会话、打日志），
 * 而不是每次请求都做。
 */
export class CachedCredential {
  #key: string | null = null;
  #value = "";
  #source: CredentialSource = "none";

  constructor(
    readonly envName: string,
    readonly filePath: string,
    private readonly io: CredentialFileIo = DENO_FILE_IO,
    private readonly env: (name: string) => string = readEnv,
  ) {}

  load(): { value: string; source: CredentialSource; changed: boolean } {
    const fromEnv = this.env(this.envName);
    let key: string;
    let source: CredentialSource;
    if (fromEnv.trim()) {
      key = "env\0" + fromEnv;
      source = "env";
    } else {
      const stamp = this.io.stamp(this.filePath);
      if (stamp === undefined) {
        key = "none";
        source = "none";
      } else {
        key = "file\0" + stamp;
        source = "file";
      }
    }
    if (key === this.#key) {
      return { value: this.#value, source: this.#source, changed: false };
    }

    let value = "";
    if (source === "env") {
      value = normalize(fromEnv);
    } else if (source === "file") {
      try {
        value = normalize(this.io.read(this.filePath));
      } catch {
        // stat 与 read 之间文件被删：按「没有」处理，下次 stat 会再试。
        source = "none";
        key = "none";
      }
    }
    if (!value) source = "none";
    const changed = value !== this.#value;
    this.#key = key;
    this.#value = value;
    this.#source = source;
    return { value, source, changed };
  }
}

/**
 * 给「注入式读写」的渠道（trae / workbuddy）用的凭据存储。
 *
 * 这两个模块的读写函数是**注入**的（见 `WorkBuddyReadFile` 的注释），所以接
 * 环境变量不需要改它们内部——只要在 `main.ts` 传进来的这对 read/write 上分流。
 *
 * 为什么不能只是「读时 env 优先、写时写文件」
 * ----------------------------------------
 * 续期会产出**新**令牌（多数上游还会轮换 refresh_token）。若凭据来自环境变量，
 * 写回文件的新令牌永远读不到：下一个请求又拿到环境变量里那份过期的，于是
 * **每个请求都续期一次**，而轮换过的旧 refresh_token 第二次就会被拒。云上文件
 * 系统只读/临时时，文件那一路同样写不进去，是同一个问题。
 *
 * 所以续期结果进**内存覆盖层**，并记下它替换的是哪一份原文（`supersedes`）：
 * 只要底层来源仍是那份旧原文，就返回覆盖层；底层一变（登录脚本写了新文件、
 * 进程带着新环境变量重启），覆盖层自动作废——新登录永远赢过旧续期。
 *
 * 环境变量是来源时**不写文件**：那份文件此刻被环境变量盖着，写进去只会把本地
 * 文件里的账号悄悄换成环境里那个账号。
 *
 * 写入从不抛错：续期已经成功，内存态已生效，落不了盘不该把一次成功的续期变成
 * 请求失败。
 */
export function envBackedStore(
  envName: string,
  io: {
    read: (path: string) => Promise<string>;
    write: (path: string, data: string) => Promise<void>;
  },
  env: (name: string) => string = readEnv,
): {
  read: (path: string) => Promise<string>;
  write: (path: string, data: string) => Promise<void>;
} {
  // 路径参数对环境变量这一路没有意义：调用方拼的是 `root + "/trae-auth.json"`，
  // 云端 root 为空串时拼出 `/trae-auth.json`，照样按这个键命中覆盖层。
  const lastRaw = new Map<string, string>();
  const overlay = new Map<string, { data: string; supersedes: string }>();

  const readSource = async (path: string): Promise<string> => {
    const fromEnv = env(envName);
    return fromEnv.trim() ? fromEnv : await io.read(path);
  };

  return {
    read: async (path) => {
      // 底层读不到（文件被删 = 登出）时照常抛出，覆盖层不复活一个已删的登录。
      const raw = await readSource(path);
      lastRaw.set(path, raw);
      const memo = overlay.get(path);
      if (memo !== undefined) {
        // 底层仍是续期前那份原文 → 用续期结果。
        if (memo.supersedes === raw) return memo.data;
        // 否则要么续期结果已经落盘（底层 === 续期结果），要么底层换了新登录；
        // 两种情况都以底层为准——新登录永远赢过旧续期。
        overlay.delete(path);
      }
      return raw;
    },
    write: async (path, data) => {
      overlay.set(path, { data, supersedes: lastRaw.get(path) ?? "" });
      if (env(envName).trim()) return;
      try {
        await io.write(path, data);
      } catch { /* 只读/临时文件系统：内存覆盖层已生效，见上面的说明 */ }
    },
  };
}
