# Next-Session Prompt — Verify omcp orchestrator-v1 end-to-end

This file contains the verbatim prompt to paste into your next Copilot CLI or Claude Code session. The session's job is to **runtime-verify** that omcp's orchestrator-v1 features (shipped code-complete in the prior session) actually work in a real Copilot loop.

---

## Copy-paste prompt (中文版)

```
继续 oh-my-copilot 工作，工作目录 C:\Users\runjiashi\oh-my-copilot-r2，HEAD 应该在 3d2ed79（v0.13.0 + orchestrator-v1 code-complete）。

第一步（必做）：
1. cd 进工作目录后跑 `git log -5 --oneline` 确认 HEAD 是 3d2ed79，跑 `git status` 确认 tree clean
2. `npx vitest run 2>&1 | tail -5` 确认 916 passing 0 failed
3. 读 HANDOFF.md 整篇——里面有完整 28 commit 总账 + 还没做的 5 件事
4. 读 docs/handoff-archive/2026-05-23-orchestrator-v1.md 了解历史背景（v0.11 之前到 v0.13 之间的全部脉络）

本 session 主要任务：runtime-verify orchestrator-v1 是不是真能跑

按优先级做：

A. **Real Copilot 端到端 ralph loop smoke（最重要）**
   - 先临时把 OMC 插件禁了避免噪音：
     `node -e "const fs=require('fs'); const sp='C:/Users/runjiashi/.copilot/settings.json'; const s=JSON.parse(fs.readFileSync(sp,'utf8')); s.enabledPlugins['oh-my-claudecode@omc']=false; fs.writeFileSync(sp, JSON.stringify(s,null,2));"`
   - 跑 `omcp setup` 确保 omcp 自己的 hooks 写到 settings.json
   - 在 .omcp/ 下手写一个最小 PRD（2 个 story，都 passes:false，简单任务比如「写一个 hello world」）
   - 跑 `omcp ralph --prd .omcp/prd.json "implement the prd stories one at a time"`
   - 观察：
     * .omcp/state/ralph-state.json 应该被写出来 (active=true, iteration=1)
     * ~/.copilot/logs/process-*.log 里 omcp 自己的 hook fire 应该 0 error
     * 每轮 Stop event 之后 iteration 应该 +1
     * 当 PRD allComplete 时 ralph 应该 noop exit + state 清空
   - 全程跑通 = orchestrator-v1 真正可用。跑不通 = 暴露剩下的最后实战隐患（八成是 PATH/绝对路径回退那块）
   - 实测完后 OMC 插件改回 enabled（不要长期禁着影响别的工作）

B. **omcp on PATH pre-mortem 验证**
   - 临时把 omcp 从 PATH 上拿掉（开个新 shell，不 source omcp 的 PATH 注入）
   - 跑 `omcp setup`，看 hook command 是不是回退到绝对路径
   - 如果代码里其实没实现这个回退（八成情况），就实现：编辑 `src/runtime/copilot-config.ts` 的 `omcpHookCommand()`，加 PATH 检测 + 绝对路径回退
   - 加单元测试覆盖这个 fallback
   - 这是 orchestrator-v1 plan pre-mortem #1，承诺过但没真做

C. **`omcp verify <phase-id>` CLI 实现**（如果 A+B 跑顺了再做）
   - docs/workflows/team-critic-verification.md 写成 placeholder，没真建
   - 实现：新 CLI 子命令 `omcp verify <phase-id>`，spawn architect 和 critic 子进程（独立上下文），收集 APPROVE/ITERATE/REJECT，loop 最多 5 次
   - 实际能让验证协议自动化跑

D. **OMC 上游 patch**（low priority）
   - omc 的 hooks.json 用 Bash-style $CLAUDE_PLUGIN_ROOT，在 pwsh 下崩
   - 这是 omc 仓库的事，不是 omcp。如果有时间可以去 omc repo 开 PR

E. **小尾巴（任何顺序）**
   - src/__tests__/cli-wiring-invariants.test.ts:155 检查所有 4 个 manifest（现在只检查 3 个）
   - src/cli/commands/session.ts:32 的 new RegExp(query) 没用 escapeRegExp，retrofit 一下
   - HANDOFF.md 整理过了，但 docs/handoff-archive/ 里的 610-line 老 HANDOFF 之后可以再 pruning

工作模式：
- 任何「调查 + 修复」用 team + critic 模式（独立上下文交叉验证），不要单线程瞎弄
- 每个 task 一个 commit，omc-style trailers（Constraint/Rejected/Confidence/Scope-risk）
- 不变量违反不接受：assertSafeSlug、atomicWriteFileSync、4 manifest sync、escapeRegExp before RegExp、no tokens in tracked files
- A 完成后如果暴露 bug，按 ralplan → team-fix 流程修，不要直接糊补丁

如果 A 全跑通（关键路径），可以 cut v1.0.0 tag（前置：所有 4 manifest 改 1.0.0 + CHANGELOG + 跑全套测试）。
```

---

## English version (if you prefer to start in English)

```
Continue oh-my-copilot work, working tree C:\Users\runjiashi\oh-my-copilot-r2, HEAD should be 3d2ed79 (v0.13.0 + orchestrator-v1 code-complete).

Step 1 (mandatory):
1. cd in, run `git log -5 --oneline`, confirm HEAD is 3d2ed79
2. `git status` confirms clean
3. `npx vitest run 2>&1 | tail -5` confirms 916 passing 0 failed
4. Read HANDOFF.md (slim, ~150 lines) and skim docs/handoff-archive/2026-05-23-orchestrator-v1.md for history

This session: runtime-verify the orchestrator-v1 features actually work.

In priority order:

A. **Real Copilot end-to-end ralph loop smoke** (most important)
   Pre-step: temporarily disable OMC plugin to avoid noise:
     `node -e "const fs=require('fs'); const sp='C:/Users/runjiashi/.copilot/settings.json'; const s=JSON.parse(fs.readFileSync(sp,'utf8')); s.enabledPlugins['oh-my-claudecode@omc']=false; fs.writeFileSync(sp, JSON.stringify(s,null,2));"`
   Then run `omcp setup` to ensure omcp's hooks land in settings.json.
   Hand-craft .omcp/prd.json with 2 simple stories (both passes:false).
   Run `omcp ralph --prd .omcp/prd.json "implement the prd stories one at a time"`.
   Verify:
   - .omcp/state/ralph-state.json written (active=true, iteration=1)
   - ~/.copilot/logs/process-*.log shows 0 hook errors from omcp's own commands
   - Each Stop event bumps iteration by 1
   - PRD allComplete triggers noop exit + state cleared
   Re-enable OMC plugin after the smoke.

B. **omcp-on-PATH pre-mortem validation**
   Remove omcp from PATH in a fresh shell, run `omcp setup`, check whether the
   wired hook command falls back to absolute path. If not implemented, edit
   src/runtime/copilot-config.ts omcpHookCommand() to add the fallback + tests.

C. **Implement `omcp verify <phase-id>` CLI verb**
   docs/workflows/team-critic-verification.md documents it as placeholder.
   Build it: subprocess-spawn architect + critic in fresh contexts, collect
   APPROVE/ITERATE/REJECT, max 5 iterations.

D. OMC upstream patch (separate repo, low priority)

E. Small follow-ups any order: cli-wiring-invariants test (3→4 manifests),
   session.ts:32 escapeRegExp retrofit, archive pruning.

Working mode:
- Investigation+fix uses team+critic in independent contexts
- One commit per task, omc-style trailers
- Invariants strict: assertSafeSlug, atomicWriteFileSync, 4-manifest sync, escapeRegExp before RegExp, no tokens
- If A exposes a bug, follow ralplan → team-fix flow, no patch-on-patch
- If A passes cleanly, cut v1.0.0 (bump 4 manifests + CHANGELOG + full test run)
```

---

## Why each item matters

| Item | Why |
|---|---|
| **A** (ralph loop smoke) | The Phase 4 e2e test uses **mock spawnSync**. It proves the LOGIC works. It does NOT prove Copilot actually fires the hook end-to-end. Until A passes, "omcp is an orchestrator" is a code-shape claim, not a runtime claim. |
| **B** (omcp on PATH) | orchestrator-v1 pre-mortem #1 explicitly called this out. We committed code-complete but never validated the fallback path. If a user installs omcp but `omcp` isn't on PATH, hooks fail with the same `[stdin]:1` SyntaxError pattern as OMC's `$CLAUDE_PLUGIN_ROOT` bug — silent failure mode. |
| **C** (verify CLI) | Phase 5 doc treats this as a future addition. Without it, the verification protocol is human-driven each time. Implementing it formalizes the team+critic loop. |
| **D** (OMC upstream) | OMC's `$CLAUDE_PLUGIN_ROOT` bug is the original mystery the user diagnosed at the start of this session. It's not omcp's concern, but if you have spare cycles, file the upstream PR — benefits the broader omc ecosystem. |
| **E** (cleanup) | Critic iter-2 minor findings that didn't make the orchestrator-v1 scope. Low-effort, high-hygiene. |

---

## Expected outputs from the next session

1. A commit (or commits) that prove A passes — likely a new `docs/smoke/orchestrator-v1-real-copilot-smoke.md` recording what was observed, with timestamps + log excerpts
2. A commit fixing B if the fallback isn't already in code (likely it isn't)
3. v1.0.0 release commit if A+B pass cleanly (4 manifests + CHANGELOG bump)
4. HANDOFF.md refresh after this session with: orchestrator-v1 runtime-verified, v1.0.0 shipped, remaining items
