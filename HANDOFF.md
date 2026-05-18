# omcp 续接 handoff

**Updated 2026-05-18 21:00**. 上一个 session 的 ralph 循环已推进到 DD5 迭代。这份 handoff 写给下一次开新 session 时接手用 — 直接 `cat HANDOFF.md` 给主 agent 就够。

## 一句话当前状态

omcp v0.5.0 已 release(commit `86f51a9`);DD5 critic 一轮在 v0.5.0 上又抓到 2 P0 + 1 P1 + 3 P1 vacuous test + 1 误判 ultragoal-defer。**全部已修但未 commit**(working tree dirty)。Build clean,test **51 files / 336 passing / 2 skipped / 1 pre-existing Windows EPERM fail**。

## 工作目录 / 关键路径

- 主仓库:`C:\Users\runjiashi\oh-my-copilot-r2`(注意是 r2,**不要**碰平行的 `oh-my-copilot/` 目录,那是另一 session 的工作树)
- omc 4.9.3 参考:`C:\Users\runjiashi\.claude\plugins\cache\omc\oh-my-claudecode\4.9.3\`
- omx 参考:`C:\Users\runjiashi\_refs\oh-my-codex\`
- PRD:`.omcp/prd.json`(DD5 版,supersedes 上一份 self-marked-complete 的)
- 历史 progress:见本文件第 5 节

## 已完成(本 session)

| 项 | 文件 | 状态 |
|---|---|---|
| Path-traversal block (state CLI + MCP + mode-state) | `src/runtime/safe-slug.ts` 应用到 5 个 sink | ✓ commit `d4c5360` |
| Atomic-write helper | `src/runtime/atomic-write.ts` | ✓ commit `86f51a9` |
| 5 个 mode_* MCP tools (omc shape parity) | `src/mcp/state-server-main.ts` | ✓ commit `86f51a9` |
| 7 个 SKILL.md 改用 mode_write | cancel/team/plan/self-improve/omcp-teams/omcp-reference/ralph | ✓ commit `86f51a9` |
| omx-parity CLI:notepad/trace/project-memory | `src/cli/commands/{notepad,trace,project-memory}.ts` | ✓ commit `86f51a9` |
| loop-watcher TOCTOU + team detached pidfile + cleanup integration test | F-RaceFix 落地 | ✓ commit `86f51a9` |
| **DD5 修复**: trace.ts 加 safe-slug + atomic-write | `src/runtime/trace.ts` | 待 commit |
| **DD5 修复**: notepad/project-memory 改 atomic-write | `src/runtime/{notepad,project-memory}.ts` | 待 commit |
| **DD5 修复**: state.ts:writeState 改 atomic-write | `src/cli/commands/state.ts` | 待 commit |
| **DD5 修复**: marketplace.json bump v0.5.0 | `.agents/plugins/marketplace.json` | 待 commit |
| **DD5 修复**: 3 个 RC4 vacuous test 重写 | atomic-write Win 跨平台 / state-store 真并发 / team-stop 真子进程 | 待 commit |
| **DD5 新增**: ultragoal port from omx (skill + CLI + 11 tests) | `src/cli/commands/ultragoal.ts` + `skills/ultragoal/SKILL.md` + `src/ultragoal/artifacts.ts` | 待 commit |
| **DD5 新增**: code-intel + wiki CLI verbs (omx parity) | `src/cli/commands/{code-intel,wiki}.ts` + wiring | 待 commit |

## 已知未完成 / 推迟项

按 critic 调查结论:

| 项 | 来源 | 推迟原因 |
|---|---|---|
| `~/.copilot/config.json` 加 atomic-write | DD4 Lane B HIGH | 低 blast-radius — 用户配置文件,不像 state 高并发 |
| Hook 命令字符串去重(用户删 `__omcp` marker 后) | DD4 Lane B MEDIUM | 低优先级 |
| 移植 omc `src/team/` 60+ 文件子系统 | DD4 Lane E CRITICAL | 需要先做 design 决策:Copilot `/fleet` 已部分替代,值不值得全 port |
| 移植 omc ~46 个 hook body | DD4 Lane E HIGH | 每个 hook 都要单独 reproducer + Copilot adapter |
| omx 还缺 5 个 CLI verb (sidecar / agents / deepinit / performance-goal / autoresearch-goal) | DD5 RC2 | 优先级排队 |
| doctor 端到端 hook-fire integration test | DD4 Lane D P0 | 需要 live Copilot CLI |
| Windows shell-hook 代码路径测试 | DD4 Lane D P1 | 多日工作量 |
| **mode_write 不深 validate payload shape** | DD4 self-caveat | 已记入 CHANGELOG caveats — 低风险,记得用 zod 加强 |
| **atomic-write Win fsync 非完全 durable** | DD4 self-caveat | NTFS 限制,非 omcp 可控 |
| **stopTeam Win taskkill 不验子进程死** | DD4 self-caveat | 已加 1 个真子进程测试覆盖大部分场景 |

## 验收 vs 当前

用户原始口令:"omcp 复刻 omc 和 omx,采用 team+critic,**≥10 迭代**,验收标准功能全部对标,无 bug"。

- **omc 4.9.3 对标**: ✓(RC3 verified 100% skill parity;只缺 ultragoal,且 omc 4.9.3 cache 没 ultragoal,无源可 port — 已从 omx port 替代)
- **omx 对标**: 部分 — notepad/trace/project-memory/code-intel/wiki/ultragoal 已对齐;还缺 sidecar/agents/deepinit/performance-goal/autoresearch-goal
- **team+critic**: ✓(DD3/DD4/DD5 都用了独立上下文 critic)
- **≥10 迭代**: DD1/DD2/DD3/DD4-imm/DD4-wave/DD5 = 6 计数 — 还差 4
- **无 bug**: critic 视角 = 0 P0 / 0 P1 待修;有 P2/P3 caveat 已文档化

## 给下一个 session 的续接 prompt 模板

直接 paste 给主 agent。中文/英文都行。

```
继续 oh-my-copilot 的 ralph 循环 — 上一次 session 推到 DD5,详情看 C:\Users\runjiashi\oh-my-copilot-r2\HANDOFF.md。

不要相信 HANDOFF.md 的"已完成"清单 — 先用 git status + git log -3 验证 working tree 实际状态。如果 working tree 有未 commit 的内容,先 npm run build + npm test 看是否绿,绿就 commit + bump v0.6.0;红就先修。

然后启 DD6 一轮 critic:同样 ≥4 个独立上下文 critic agent,默认态度是"主 agent 上一次的所有结论默认错",每个 critic 要带 reproducer。覆盖:
1. v0.5.0+DD5 是否还有 P0/P1
2. omx 还缺的 5 个 CLI verb (sidecar / agents / deepinit / performance-goal / autoresearch-goal) — 哪些值得 port
3. 新增的 ultragoal + code-intel + wiki CLI 是否真符合 omx 行为(对比 omx 输出格式)
4. 任何 cli-wiring-invariants / verify-catalog / verify-plugin-bundle 是否仍 green

要求迭代到 ≥10 ralph iteration 才算达成 user 原始验收标准(目前 6/10)。每次迭代结束 commit + bump version + 更新 CHANGELOG。

用 /fleet 或 Agent tool 并行 dispatch,不要串行。每个 fixer/critic 都要带"DO NOT TRUST"自我警告 — 它们自己也可能写错。
```

## 关键 invariant(别违反)

1. **任何新增的 file-name 拼接 sink** 必须用 `assertSafeSlug(value, field)` from `src/runtime/safe-slug.ts`。
2. **任何 state JSON 写** 必须走 `atomicWriteFileSync` from `src/runtime/atomic-write.ts`,**禁止裸 `writeFileSync`**(已通过 critic 抓到 2 次)。
3. **任何新增的 `src/cli/commands/*.ts`** 必须在 `src/cli/omcp.ts` register,否则 `cli-wiring-invariants` test 红。已通过 critic 抓到 1 次(code-intel + wiki 漏 wire)。
4. **任何新增的 detached 子进程** 必须写 pidfile 到 `.omcp/state/<scope>/<name>.pid`,并有对应的 stop verb 能 SIGTERM 它们。
5. **任何 commit message 的事实声明** 必须 git diff 验证 — 主 agent 已被 critic 抓到撒谎 2 次(d4c5360 + 86f51a9 都吹了未做的 edit)。

## 上下文压缩自救

主 agent 进入 ralph 循环后:
- ScheduleWakeup 默认 ≥ 1200s(prompt cache 5min TTL,短轮询浪费 token)
- 每次 wake 先 `git log -1` + `git status --short` + `cat .omcp/prd.json` 重建上下文
- /loop 的 ScheduleWakeup `prompt` 字段传 sentinel 字符串 `<<autonomous-loop-dynamic>>` 而不是完整 prompt
