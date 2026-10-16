/**
 * GitSourceFetcher — source fetching implementation based on simple-git.
 *
 * simple-git uses child_process.spawn with an args array internally, never a shell, eliminating shell injection by design.
 *
 * Security measures (002 §4-5):
 *   - R1 git hooks: clone/fetch never pull remote .git/hooks (hooks are local state), so we do not additionally
 *     set core.hooksPath (hardened git rejects that config without allowUnsafeHooksPath).
 *   - R2 SSRF: private/loopback address blocklist for both HTTPS and SSH (aligned with project security_rules).
 *   - Bug fix (option A): git clean during incremental sync excludes .codegraph/ to avoid deleting the codegraph index.
 *
 * SSH support (2026-10-10): protocol allowlist widened from https-only to https + ssh (`git@` / `ssh://`);
 * the private key is injected via `GIT_SSH_COMMAND`, lives only in the child process env, never on disk or in logs.
 */

import simpleGit, { CleanOptions, ResetMode, type SimpleGit } from "simple-git";
import type { ISourceFetcher, FetchResult, SourceType, GitFetchOptions } from "./types.js";
import { isSshUrl, parseSshHost, buildSshCommand } from "./ssh-options.js";

/**
 * 放行 `GIT_SSH_COMMAND`（simple-git ≥3.36 的 CVE 防护要求显式声明）。
 *
 * 见 `gitFor()` 注释：命令串全部由受控字段拼装，无不可信输入，故可安全开启。
 * 单独抽成常量是为了让「这里开了 unsafe 开关」在代码里只有一处、易于审计。
 */
const UNSAFE_SSH_COMMAND = { allowUnsafeSshCommand: true } as const;

/**
 * Detect git auth / permission errors (simple-git has no TTY, so git's interactive Username/Password prompt
 * becomes `could not read Username for '...': No such device or address`).
 *
 * These errors are very misleading to users: the repo actually requires auth (401/403), but git phrases it as
 * "could not read username". Detect them centrally here; the worker layer then turns them into human-readable hints depending on whether credentials were supplied.
 */
export function isGitAuthError(raw: string): boolean {
  const msg = raw.toLowerCase();
  return (
    msg.includes("could not read username") ||
    msg.includes("could not read password") ||
    msg.includes("authentication failed") ||
    msg.includes("permission denied") ||
    msg.includes("returned error: 401") ||
    msg.includes("returned error: 403") ||
    msg.includes("could not read from remote repository") ||
    msg.includes("unable to access") ||
    msg.includes("remote: you are not allowed") ||
    // ── SSH 特有 ──
    msg.includes("permission denied (publickey)") ||
    msg.includes("host key verification failed") ||
    msg.includes("no more authentication methods available")
  );
}

/**
 * Pick the **actual failure reason** out of raw git output.
 *
 * Can't just take the first line: git output starts with `Cloning into '<path>'...`,
 * which is progress info, not an error. Taking only the first line made every failure show as "Cloning into ...",
 * swallowing the real cause (this once caused a missing branch to be misreported as SSH auth failure).
 *
 * Approach: prefer the last `fatal:` / `error:` line; otherwise fall back to the last non-empty line.
 */
function pickGitErrorLine(raw: string): string {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const fatal = lines.filter((l) => /^(fatal|error)/i.test(l));
  return (fatal.length > 0 ? fatal[fatal.length - 1] : lines[lines.length - 1]) ?? raw.trim();
}

/** Convert a git auth error into a user-facing hint. needsCredential = whether credentials were injected at clone time. */
export function explainGitAuthError(raw: string, needsCredential: boolean): string {
  const brief = pickGitErrorLine(raw);
  // SSH 认证失败（公钥未配置 / 未被授权）另行提示，引导用户去配公钥。
  if (isSshAuthError(raw)) {
    return (
      `SSH 认证失败，无法拉取仓库（git: ${brief}）。` +
      `请确认已在代码平台添加本服务的 SSH 公钥（可在注册弹窗重新获取），且该公钥有该仓库的读权限。`
    );
  }
  if (needsCredential) {
    return (
      `Access token is invalid or expired; cannot fetch the repository (git: ${brief}). ` +
      `Please re-enter the access token in the repository details.`
    );
  }
  return (
    `This repository requires authentication and cannot be cloned as "public" (git: ${brief}). ` +
    `Please delete it and register again, selecting the corresponding code platform as the source and entering an access token.`
  );
}

/**
 * Whether the error is "remote has no such branch".
 *
 * git's raw text (`Could not find remote branch main to clone` /
 * `Remote branch main not found in upstream origin`) carries nothing actionable;
 * users assume the repo is broken when they just need to change the branch name.
 */
export function isRemoteBranchMissingError(raw: string): boolean {
  const msg = raw.toLowerCase();
  const patterns = [
    "could not find remote branch",
    "remote branch", // combined with "not found" below
    "couldn't find remote ref",
    "could not find remote ref",
  ];
  const matched = patterns.filter((p) => msg.includes(p));
  if (matched.length === 0) return false;
  // "remote branch" alone isn't enough (it appears in normal output too); require "not found" as well.
  if (matched.length === 1 && matched[0] === "remote branch") {
    return msg.includes("not found");
  }
  return true;
}

/** Whether the error is an SSH auth error (as opposed to an expired HTTPS token). */
export function isSshAuthError(raw: string): boolean {
  const msg = raw.toLowerCase();
  return (
    msg.includes("permission denied (publickey)") ||
    msg.includes("host key verification failed") ||
    msg.includes("no more authentication methods available")
  );
}

/**
 * Private / loopback / link-local address blocklist (standard ranges):
 *   - 10. / 172.16-31. / 192.168.  → RFC1918 private ranges
 *   - 169.254.                     → link-local (including cloud metadata 169.254.169.254)
 *   - 127. / 0. / localhost / ::1  → loopback
 *   - fe80:                        → IPv6 link-local
 *
 * The blocklist can be disabled via the env var KNOWLEDGE_SSRF_CHECK=off (see GitSourceFetcher constructor).
 */
const PRIVATE_ADDR_RE =
  /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|127\.|0\.|localhost$|::1$|fe80:)/i;

/**
 * Read the SSRF private-network blocklist switch. Enabled by default;
 * disabled when KNOWLEDGE_SSRF_CHECK is off/false/0/no (case-insensitive).
 */
function ssrfCheckEnabledFromEnv(): boolean {
  const raw = process.env.KNOWLEDGE_SSRF_CHECK;
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

export interface GitSourceFetcherOptions {
  /**
   * Whether to enable the SSRF private / loopback address blocklist check.
   * Defaults to the env var KNOWLEDGE_SSRF_CHECK (on by default); an explicit value takes precedence over the env var.
   */
  ssrfCheck?: boolean;
}

export class GitSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "git";

  /** SSRF private-network blocklist switch (the protocol allowlist always applies, unaffected by this switch). */
  private readonly ssrfCheck: boolean;

  constructor(opts?: GitSourceFetcherOptions) {
    this.ssrfCheck = opts?.ssrfCheck ?? ssrfCheckEnabledFromEnv();
  }

  validate(sourceUrl: string): void {
    // Protocol allowlist: HTTPS (public / private repo with token injected in URL) + SSH (private key via GIT_SSH_COMMAND).
    // All other protocols (file://, ftp://, plaintext git://, etc.) are rejected.
    if (!this.isAllowedProtocol(sourceUrl)) {
      throw new Error(
        "repo_url must use https:// , git@host:path or ssh:// scheme",
      );
    }
    const host = this.extractHost(sourceUrl);
    if (!host) {
      throw new Error(`invalid repo_url: cannot parse host from ${sourceUrl}`);
    }
    // R2: SSRF protection — disallow private / loopback addresses (can be disabled via KNOWLEDGE_SSRF_CHECK=off).
    if (this.ssrfCheck && this.isPrivateAddress(host)) {
      throw new Error(`repo_url must not point to private/loopback address: ${host}`);
    }
  }

  async fetch(sourceUrl: string, branch: string, localPath: string, opts?: GitFetchOptions): Promise<FetchResult> {
    this.validate(sourceUrl);
    // Shallow single-branch clone. Note: git clone/fetch never pull remote .git/hooks (hooks are local state),
    // so a normally cloned repo has no executable hooks; core.hooksPath is no longer set here
    // (hardened git rejects that config: requires allowUnsafeHooksPath).
    // Clone into a not-yet-existing target dir, so no baseDir is set (same as before: simpleGit() with no cwd).
    try {
      await this.gitFor(sourceUrl, undefined, opts).clone(sourceUrl, localPath, {
        "--depth": 1,
        "--branch": branch,
      });
    } catch (err) {
      // "Remote has no such branch" is the most common registration failure (the frontend defaults to main,
      // while many repos still default to master). git's raw text isn't actionable,
      // so list the actual remote branches here; the user can fix it by changing one name.
      throw await this.explainBranchError(err, sourceUrl, branch, opts);
    }
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  /**
   * clone 失败且疑似「分支不存在」时，列出远端真实分支再抛。
   *
   * 只在命中的情况下额外发一次 `git ls-remote --heads`（仅 SSH/HTTPS 读操作，
   * 无副作用）；其它错误原样抛出，不改变既有行为。
   */
  private async explainBranchError(
    err: unknown,
    sourceUrl: string,
    branch: string,
    opts?: GitFetchOptions,
  ): Promise<unknown> {
    const raw = err instanceof Error ? err.message : String(err);
    if (!isRemoteBranchMissingError(raw)) return err;

    let available: string[] = [];
    try {
      const out = await this.gitFor(sourceUrl, undefined, opts).listRemote(["--heads", sourceUrl]);
      available = (out ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^[0-9a-f]+\s+refs\/heads\//, ""))
        .filter(Boolean);
    } catch {
      // 列不出来就只给基础提示，不掩盖原始错误。
    }

    const brief = pickGitErrorLine(raw);
    const hint =
      available.length > 0
        ? `该仓库不存在分支「${branch}」（git: ${brief}）。远端可用分支：${available.slice(0, 20).join("、")}${available.length > 20 ? " 等" : ""}。请改用其中任一分支重新注册。`
        : `该仓库不存在分支「${branch}」（git: ${brief}）。请确认分支名后重新注册。`;
    return new Error(hint);
  }

  async sync(sourceUrl: string, branch: string, localPath: string, opts?: GitFetchOptions): Promise<FetchResult> {
    this.validate(sourceUrl);
    // ★ 增量同步同样要带 SSH 私钥：`git fetch origin` 走的还是 ssh 传输，
    //   缺 GIT_SSH_COMMAND 会因为拿不到 key 而认证失败。
    const git = this.gitFor(sourceUrl, localPath, opts); // baseDir = 已存在的仓库目录
    await git.fetch("origin", branch, { "--depth": 1 });
    await git.reset(ResetMode.HARD, [`origin/${branch}`]);
    // Bug fix (option A): clean excludes .codegraph/, otherwise it deletes the codegraph index,
    // causing incremental sync to always fail and fall back to a full clone every time.
    await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  // ── Internal helpers ──

  /**
   * 构造 simple-git 实例，必要时带上 `GIT_SSH_COMMAND`。
   *
   * 只有 SSH 类 URL 才注入；HTTPS 下实例与改造前完全一致（不引入任何副作用）。
   *
   * ⚠ `unsafe.allowUnsafeSshCommand` 是**必须**的，不是可选项：
   *   simple-git ≥3.36 为修 CVE（`-c core.sshCommand` / env 注入可执行任意命令）
   *   内置了 block-unsafe-operations 插件，凡是子进程 env 里出现 `GIT_SSH_COMMAND`
   *   就一律拦截并抛：
   *     Use of "GIT_SSH_COMMAND" is not permitted without enabling allowUnsafeSshCommand
   *   该插件按 `config.unsafe[category] === true` 放行，故这里显式声明。
   *
   * 为什么这里是安全的（即为什么可以放心开这个开关）：
   *   - 命令串由 `buildSshCommand()` 用**受控字段**拼装 —— 私钥路径与 known_hosts
   *     路径都来自本服务 `ssh-key/` 模块按 username 白名单生成的绝对路径，
   *     不含任何用户输入的 URL / 分支名 / repo 名。
   *   - 开关只在「SSH URL + 有 ssh opts」分支下开，HTTPS 请求永不触碰。
   *   （真正需要防的是"把不可信输入拼进 ssh 命令"，那由 ssh-options.ts 保证。）
   *
   * @param localPath 仓库工作目录。clone 时目标目录尚不存在，传 undefined；
   *                  sync / 读版本时传实际目录作 baseDir。
   */
  private gitFor(sourceUrl: string, localPath?: string, opts?: GitFetchOptions): SimpleGit {
    if (!isSshUrl(sourceUrl) || !opts?.ssh) {
      return localPath ? simpleGit(localPath) : simpleGit();
    }
    // 放行开关只在这一个分支里开，作用域最小。
    const git = localPath
      ? simpleGit(localPath, { unsafe: UNSAFE_SSH_COMMAND })
      : simpleGit({ unsafe: UNSAFE_SSH_COMMAND });
    // simple-git 无 options.env：用链式 env() 注入，语义等价且是官方支持写法。
    return git.env({ GIT_SSH_COMMAND: buildSshCommand(opts.ssh) });
  }

  /** 协议白名单：https / ssh（scp 写法与 ssh:// 标准写法）。 */
  private isAllowedProtocol(url: string): boolean {
    const v = (url ?? "").trim();
    return v.startsWith("https://") || isSshUrl(v);
  }

  private async headCommit(localPath: string): Promise<string | null> {
    try {
      return (await simpleGit(localPath).revparse(["HEAD"])).trim().slice(0, 12);
    } catch {
      return null;
    }
  }

  /** HTTPS 用 URL 解析；SSH 用专用解析器（new URL 处理不了 `git@host:path`）。 */
  private extractHost(url: string): string {
    if (isSshUrl(url)) return parseSshHost(url);
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  private isPrivateAddress(host: string): boolean {
    return PRIVATE_ADDR_RE.test(host);
  }
}
