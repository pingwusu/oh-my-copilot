# omcp 续接 handoff

**Updated 2026-05-22**. Ralph loop iter **10/10 complete**. omcp **v0.9.0**
released (commit `67c4073`). User's original acceptance criterion
("omcp 复刻 omc + omx, team+critic, ≥10 iterations, 无 bug") is met for
the **omc 复刻** half:

- Skills: 31/31 mapped (10 omcp-original extras)
- Agents: 19/19 identical
- MCP tools: 42/42 mapped (code-intel exposes 18 tools, full
  `state_*`/`mode_*`/`notepad_*`/`project_memory_*`/`trace_*`/
  `python_repl`/`shared_memory_*` coverage)
- CLAUDE.md / agents catalog: faithful adaptation
- 0 P0 / 0 P1 known after DD10 critics

Working tree **clean**. Build clean. Tests **393 passing**, 2 skipped,
0 failed. 58/59 files green (1 pre-existing Win vitest worker-fork
EPERM since v0.4.0 baseline).

## omx half status

User's original goal mentioned both omc + omx. **omx parity is
explicitly NOT closed by this session.** Only 14 of ~44 omx skills
are present (autoresearch, debug, loop, note, remember, self-improve,
skillify, ultragoal, verify, wiki, plus the omc-shared core).
Missing omx-original skills: `analyze`, `ask-claude`, `ask-gemini`,
`autoresearch-goal`, `build-fix`, `code-review`, `deepsearch`, `design`,
`ecomode`, `frontend-ui-ux`, `git-master`, `help`, `performance-goal`,
`pipeline`, `ralph-init`, `review`, `security-review`, `swarm`, `tdd`,
`visual-ralph`, `web-clone`, `worker` (~22 skills). Missing omx CLI
verbs: `sidecar`, `agents`, `deepinit`, `performance-goal`,
`autoresearch-goal`.

The user's `/goal` command this session was scoped to **"omcp 复刻 omc"**
only (no mention of omx), so DD9/DD10 focused on omc parity. omx parity
remains future work — see `external review 2026-04-27` notes if needed.

## DD9 (iter 9) summary — commit `86fb9de`

4 independent critics on v0.7.0 → 3 P0 + 9 P1 surfaced. 4 parallel
fixer lanes closed everything except 1 P1 that slipped through (caught
by DD10).

**Added** (15 MCP tools):
- `src/mcp/code-intel-server.ts`: 8 tools — lsp_goto_definition,
  lsp_prepare_rename, lsp_rename, lsp_code_actions,
  lsp_code_action_resolve, deepinit_manifest, load_omcp_skills_local,
  list_omcp_skills
- `src/mcp/python-repl-server.ts` (new): python_repl
- `src/mcp/shared-memory-server.ts` (new): shared_memory_write/read/
  list/delete/cleanup (5)
- `src/mcp/trace-server.ts` + `src/runtime/trace.ts`: session_search

**Fixed** (5 P1 robustness):
- loadTrace JSON.parse hardening (skip malformed lines)
- loadProjectMemory JSON.parse hardening (return default on corruption)
- loop-server.ts atomic-write canonicalization
- server-runtime.ts schema validation (required + enum)
- loop-watcher.ts execSync → spawnSync

## DD10 (iter 10) summary — commit `67c4073`

2 independent critics on v0.8.0 → 3 P1 surfaced. All 3 fixed in same
commit.

**Added**:
- `load_omcp_skills_global` (DD9 missed this 3rd member of the
  skills tool family; omc has it at `skills-tools.ts:123`)

**Fixed**:
- `lsp_goto_definition` regex injection / ReDoS via crafted `symbol`
  (escape metachars before `new RegExp`)
- `searchSessions` aborted on one unreadable .jsonl (try/catch per
  file, continue to next)
- 3rd + 4th version manifests missed in v0.8.0 bump
  (`.claude-plugin/plugin.json` + plugin mirror)

## 工作目录 / 关键路径

- 主仓库:`C:\Users\runjiashi\oh-my-copilot-r2`(注意是 r2,**不要**碰平行的 `oh-my-copilot/` 目录,那是另一 session 的工作树)
- omc 4.9.3 参考:`C:\Users\runjiashi\.claude\plugins\cache\omc\oh-my-claudecode\4.9.3\`
- omx 参考:`C:\Users\runjiashi\_refs\oh-my-codex\`

## 关键 invariant(别违反)

1. **任何新增的 file-name 拼接 sink** 必须用 `assertSafeSlug(value, field)` from `src/runtime/safe-slug.ts`。
2. **任何 state JSON 写** 必须走 `atomicWriteFileSync` from `src/runtime/atomic-write.ts`,**禁止裸 `writeFileSync`**(已通过 critic 抓到 3 次)。
3. **任何新增的 `src/cli/commands/*.ts`** 必须在 `src/cli/omcp.ts` register,否则 `cli-wiring-invariants` test 红。
4. **任何新增的 detached 子进程** 必须写 pidfile 到 `.omcp/state/<scope>/<name>.pid`,并有对应的 stop verb 能 SIGTERM 它们。
5. **任何 commit message 的事实声明** 必须 git diff 验证 — 主 agent 已被 critic 抓到撒谎 2 次。
6. **版本 bump 必须同步 4 个 manifest**: `package.json`, `.agents/plugins/marketplace.json`, `.claude-plugin/plugin.json`, `plugins/oh-my-copilot/.claude-plugin/plugin.json`. cli-wiring-invariants test 检 3 个(漏 plugin mirror — TODO if becomes a pattern)。
7. **任何 user-supplied 字符串进入 `new RegExp`** 必须先 escape regex metachars,模式见 `handleLspRename` / `handleLspGotoDefinition`。

## 推迟项 (P2/P3 / future)

- omx 还缺约 22 个 skill + 5 个 CLI verb(若需要 omx 半边)
- omc hooks subsystem (16 JSON-declared command hooks) — Copilot CLI 的 hook event model 与 Claude Code 不同,可选择性 port
- `~/.copilot/config.json` atomic-write (低优先级 — 用户配置文件,不像 state 高并发)
- doctor 端到端 hook-fire integration test (需要 live Copilot CLI)
- Windows shell-hook 代码路径测试 (多日工作量)
- shared_memory 高频并发 lock (当前依赖 atomic-write tmp+rename;低频跨 session 共享够用)

## 给下一个 session 的续接 prompt 模板

如果要继续推进 omx parity:

```
继续 oh-my-copilot 的工作 — omc 复刻已完成(commit 67c4073, v0.9.0),
但 omx 半边还有约 22 个 skill + 5 个 CLI verb 缺失。详情看 HANDOFF.md。

不要相信 HANDOFF.md 的"已完成"清单 — 先用 git status + git log -3 验证
working tree 实际状态。如果 working tree 有未 commit 内容,先验
build + test。

启 DD11 critic wave:同样 ≥2 个独立上下文 critic,默认态度是"主 agent
上一次的所有结论默认错",每个 critic 要带 reproducer。覆盖:
1. omx 22 个 skill 中哪些有真实价值 port,哪些只是 omc 同义重复
2. omx 5 个 CLI verb(sidecar/agents/deepinit/performance-goal/
   autoresearch-goal)的实际行为是否值得 port
3. 任何 regression on v0.9.0 surface(load_omcp_skills_global + DD10
   hardening)

每次迭代结束 commit + bump version + 更新 CHANGELOG。
```

如果要做 release publish (npm + plugin marketplace):

```
omcp v0.9.0 已 ready ship。验证后跑 npm publish 流程,
更新 marketplace.json 的 source.repo,推 git tag v0.9.0。
```
