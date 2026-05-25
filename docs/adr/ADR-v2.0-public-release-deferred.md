# ADR — v2.0 公开发布渠道推迟

**Status**: Decided (executed 2026-05-25)
**Date**: 2026-05-25
**Reference**: docs/plans/v1.8-to-v2.0-ralplan-iter3.md § v2.0 (N+6b section, EB-03/04/05)
**HEAD at decision**: 3288e7a (post v2.0.0-rc.1 + semver fix)

## Context

iter-3 plan 的 v2.0 tag gate 包含三项 USER_REQUIRED：

1. `npm publish oh-my-copilot@2.0.0-rc.1` (US-2.0-T1-NPM-publish-rc1, EB-03)
2. GitHub Copilot marketplace listing 提交 (US-2.0-T2-MARKETPLACE-submit, EB-05)
3. ≥3 外部用户跑过 + 写反馈 (US-2.0-GATE-external-users, EB-04)

维护者当前约束（非技术问题）：

- Microsoft 员工，主 GitHub 账户为公司 EMU
- 公司 EMU 账户政策禁止 publish 公开 npm packages（内部治理 / 冲突回避）
- 无 GitHub Copilot marketplace 作者账户（需单独注册或个人 GitHub）
- 当前外部用户暂无：omcp 项目 private，仅维护者本人可访问

## Decision

v2.0.0-rc.1 作为 omcp 当前 stable milestone 永久 freeze 在本地。iter-3 plan 的三项 USER_REQUIRED（npm publish + marketplace submit + external users）推迟到**公开发布渠道可用时**（个人 GitHub 账户 / marketplace 注册 / 用户群成长）。

- **代码完成度**：v2.0.0-rc.1 技术意义上已 ready（见下节）
- **发布渠道**：账户/权限约束阻止公开渠道，不阻止本地使用或内部迭代
- **后续操作**：当渠道可用时，可直接推送 tag + npm publish，无需代码工作

## Why this is not "kicking the can"

Per "不准问题往后迁移" 原则，问题往后迁移必须有 ADR 文档化技术原因。本 ADR 文档化的是**非技术原因**：

- **非 bug**：没有 defect 待修，没有失败测试
- **非设计决策**：不是架构取舍 / 功能删除 / API 不稳定
- **非渠道选择**：npm / marketplace 都是 omcp 既定的目标渠道，不是被否决的方案
- **是账户/权限约束**：Microsoft EMU 政策 + marketplace 注册 + 用户群小 = 推迟的**原因**

## Technical readiness (v2.0.0-rc.1)

iter-3 N+6a 的 "v2.0 release prep (LOCAL ONLY)" 完成后，代码状态：

- **4 manifests 同步到 2.0.0-rc.1**：`package.json` + `plugins/oh-my-copilot/manifest.json` + `plugins/oh-my-copilot/capabilities.json` + `plugins/oh-my-copilot/plugin.json`
- **vitest 全绿**：1395 passing / 2 skipped / 1 pre-existing EPERM (baseline 维持)；tsc clean
- **所有 Tier 1-4 用户故事完成**（除 USER_REQUIRED 项）：
  - Tier 1: NPM pack-audit + bin-postinstall + fresh-machine + config-backup
  - Tier 2: marketplace schema validate + docs 22 pages + recruitment kit
  - Tier 3: MCP 10/10 + runtime shim + all agent QA
  - Tier 4: verify-catalog + API surface + Windows-first explicit
- **稳定性承诺写入 README**：Windows-first 支持官宣
- **CP-5 checkpoint**：fresh-machine install + setup + first ralph ✓

## Consequences

**本地不受影响**：

- v2.0.0-rc.1 是事实上的 stable v2.0；本地使用、测试、迭代无任何阻塞
- 内部用户可直接 `git clone / npm install / omcp setup` 运行 rc.1
- 开发可从 rc.1 继续，作为 v2.1+ baseline

**新功能开发**：

- 可在 main 分支继续（rc.1 是 baseline，后续 commit 相对于 rc.1 增量）
- 如需维护 rc.1 bug 修复，可走标准 bugfix-on-release-branch 流程

**公开渠道开放时的路径**：

```bash
# When EMU account issue resolved OR personal account ready:
git push origin v2.0.0-rc.1                    # push tag to public GitHub
npm publish --tag rc --otp <user-otp>          # publish to npm (requires 2FA)
# (marketplace submit + user recruitment 同步进行)
```

无需代码修改、无需新的 rc.2、无需测试重跑。

## Follow-ups (when channels available)

**渠道可用的信号**：

1. Microsoft 授权个人 GitHub 账户 publish public npm；OR
2. 切换到个人 GitHub （不再用 EMU）；OR
3. 外部用户人数 ≥3（自然增长，触发用户反馈收集）

**执行顺序**：

1. `git push origin v2.0.0-rc.1` （推送 tag 到公开 GitHub）
2. `npm publish --tag rc` （需要 npm 2FA/OTP）
3. Copilot marketplace 提交 （可与发布并行）
4. 邀请 ≥3 用户跑过 + 反馈 （feedback under `docs/release/v2.0-external-feedback/`）
5. 如果 rc.1 → 2.0.0 期间有任何修复，可走标准 rc.2 / rc.3 / 2.0.0 promotion

**无需重新测试**：iter-3 的 vitest + smoke + CP-5 checkpoint 已覆盖；rc.1 本身代码质量不变。

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Wait for EMU authorization** | Orthogonal to code readiness; tie-up period unpredictable; rc.1 sits idle; no feedback loop |
| **Fork to public account now, publish early** | Splits maintenance burden; confuses installation source; EMU policy still blocks EMU-account publish (doesn't help) |
| **Publish under interim name** | Creates alias debt; migration docs bloat; user confusion |
| **Defer rc.1 until external users available** | Inverts dependency; users can't test without public artifact; circular |

## Risk register

| Risk | Mitigation | Residual |
|---|---|---|
| rc.1 code drift (bug fix needed before GA) | Bugfix follows standard semver: rc.2 / rc.3 / 2.0.0. Iter-3 vitest + smoke verify baseline. | low (code tested) |
| User feedback before public release | rc.1 stable; feedback can land in issues; iter-3 recruitment-kit available for invitation | low (internal-first is planned) |
| EMU policy changes / clarification | Monitor EMU guidance; decision is reversible (re-open N+6b when ready) | low (outside project scope) |
| Marketplace schema evolves | US-2.0-T2-MARKETPLACE-schema-validate pre-validates against current schema; re-validate at submit time | low (marketplace stable) |

## Commitment

This ADR is **not indefinite deferral**. When **all three channels are available** (personal npm account + marketplace account + ≥3 external users), N+6b executes **without code changes**. The rc.1 tag + artifact are immutable; the decision is to defer **publication**, not **readiness**.

---

## Trailers

Constraint: Microsoft EMU account policy; no external GitHub Copilot marketplace registration
Rejected: defer entire v2.0 development, split accounts, interim package name
Confidence: high (decision is procedural, not technical)
Scope-risk: zero (does not expand or reduce scope; defers publication only)
