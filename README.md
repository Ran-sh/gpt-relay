# ChatGPT Workflow

**让 ChatGPT 负责任务编排，让 Codex 等能力完整的 Agent 直接完成代码、测试、浏览器、Git/GitHub 与真实环境工作。**

Current version: **1.9.0**

## 工作流

```text
你提出需求
   ↓
ChatGPT / Codex 分析当前可用能力并直接完成可执行工作
   ↓
遇到必须在真实电脑 / 环境里完成的工作
   ↓
ChatGPT 写入 docs/agent-tasks/ACTIVE_TASK.json
   ↓
你给 Codex 等执行器一句话
   ↓
执行器完成本地工作并提交 Result Contract
   ↓
ChatGPT 检查 GitHub，继续下一步
```

核心原则只有四个：

- **ChatGPT 负责编排；Codex 不被限制为只测试或只做本地工作。**
- **GitHub 保存任务和结果。**
- **按缺失能力交接，不按 Agent 名称分工。**
- **BLOCKED 保留任务与证据，可恢复续跑。**

## 一句话执行

推荐给执行器的提示词：

```text
拉取 <owner/repo> 的 <branch> 最新代码，读取 docs/agent-workflow.md，并执行 docs/agent-tasks/ACTIVE_TASK.json；完成后按协议提交结果。
```

如果执行器已经打开目标仓库，可以更短：

```text
拉取目标分支最新代码并执行 docs/agent-tasks/ACTIVE_TASK.json，按 Agent Workflow Protocol 完成即可。
```

任务细节不写进提示词。真正的任务来源只有：

```text
docs/agent-tasks/ACTIVE_TASK.json
```

## ChatGPT 什么时候交给 Executor

只有 GitHub 本身无法完成时才交接，例如：

- 本地 build / test / benchmark
- 真实应用、插件、浏览器、设备、GPU
- 本地文件或工作区状态
- 登录账号、凭据、签名、发布工具
- 真实运行环境才能确认的行为

能通过 GitHub 完成的修改，ChatGPT 直接做，不绕一圈交给 Executor。

## 安装

新项目，Node.js 20+：

```bash
npm exec --yes --package=github:Ran-sh/chatgpt_workflow -- agent-workflow install .
```

已有工作流文件的项目，可让任意 coding agent 执行：

```text
Install the latest stable workflow from `Ran-sh/chatgpt_workflow` into this repository, following `install/ONE_COMMAND_INSTALL_PROMPT.md` exactly.
```

安装不会创建 ACTIVE task。

## Task / Result

支持三种任务模式：

- `IMPLEMENT`
- `TEST_ONLY`
- `REVIEW_ONLY`

Result Contract v2 记录秒级、带时区的执行时间线。最终结果必须由 validator 自己盖章：

```bash
node .agent-workflow/validator/validate-contract.mjs result <result-file> --stamp
```

`--stamp` 成功后会写入 `result_validation` 的 PASS、验证时间、命令和证据；历史 v1 Result 仍可继续验证，无需重写。

普通验证：

```bash
agent-workflow validate task docs/agent-tasks/ACTIVE_TASK.json
agent-workflow validate result <result-file>
```

执行前预检和完成前联合校验：

```bash
agent-workflow doctor --target . --json
agent-workflow validate handoff --task docs/agent-tasks/ACTIVE_TASK.json --result <result-file> --target .
```

阻塞后不要删除 ACTIVE task：

```bash
agent-workflow status --target . --json
agent-workflow task resume --target .
```

`result_commit: null` 是正常值；包含最终 Result 的提交由 Git 历史读取，避免结果文件自引用。

卸载：

```bash
agent-workflow uninstall .
```

## 关键文件

```text
docs/agent-workflow.md                 执行协议
docs/agent-tasks/ACTIVE_TASK.json      当前任务
docs/agent-results/                    执行结果
schema/                                Task / Result Schema
validator/                             Contract Validator
bin/agent-workflow.mjs                 CLI
```

详细设计见：

- `protocol/orchestrator-executor-boundary.md`
- `protocol/local-execution-handoff.md`
- `protocol/capability-delegation.md`
- `protocol/reference-project-findings.md`
- `install/EXECUTE_TASK_PROMPT.md`

Reference projects: `Ran-sh/dsh-vision`, `Ran-sh/dsh-crew`.
