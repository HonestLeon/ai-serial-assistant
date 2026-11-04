# AGENTS.md

> 给 AI 编码代理的仓库指南。动手前先读对应子项目的 README / AGENTS.md。
> 项目：**AI 串口调试助手（TUNER / 智串AI）**——面向电赛、智能车、RC、RM 的桌面串口调试与 PID 调参工具。

## 一句话定位

Electron 桌面应用：串口数据实时波形 + 本地确定性响应分析 + AI 解释 + 对话式 PID 调参智能体（支持仿真与真实串口模式）。

## 技术栈

- 桌面：Electron 42 · Vue 3.5 · Element Plus 2.14 · ECharts 6 · serialport 13
- 构建：electron-vite 5 / Vite 7 · electron-builder 26
- 运行环境：Node.js 20.19+（20 系列）或 22.12+；Windows 10+ / macOS / Linux
- AI：OpenAI 兼容 API（默认 DeepSeek），API Key 仅存当前会话
- 文档、注释与提交信息：中文

## 目录地图

| 路径 | 内容 |
|------|------|
| `ai-serial-assistant-app/` | **主工程**（Electron 应用）。开发者文档见其 `README.md`，设计与策略文档见 `docs/` |
| `ai-serial-assistant-app/src/` | `main/` 主进程、`preload/` 桥接、`renderer/src/` Vue 渲染层与 PID 智能体服务 |
| `ai-serial-assistant-app/tests/` | Node 回归测试（`.mjs`），无需 API Key |
| `ai-serial-assistant-app/promo-video/` | HyperFrames 宣传片工程，**独立子项目**，自带 `AGENTS.md` / `CLAUDE.md`，改动前务必先读 |
| `docs/` | 仓库级项目文档：计划、规格、排查与修复、评审反馈、方案报告等（由根目录散落文档归集） |
| `参赛材料/` | 答辩 PPT/PDF、演示视频、问卷、评审记录等竞赛交付物 |
| `发布包/` | 安装包、使用说明书、嵌入式端指南、界面截图 |
| `已有竞品分析报告/` | 竞品调研 HTML 报告 |
| `AI串口助手前端界面设计/` | 界面设计源文件（已被忽略，仅供本地参考） |

> 根目录 `README.md` 面向最终用户；`ai-serial-assistant-app/README.md` 面向开发者。

## 常用命令

均在 `ai-serial-assistant-app/` 目录执行：

```bash
npm install
npm run dev              # 开发预览
npm run build            # 构建
npm run dist             # electron-builder 打包
npm run test:analysis    # 解析 / 分析 / PID 安全等回归测试
npm run test:strategies  # 确定性策略工具测试
npm run test:main        # 主进程相关测试
```

测试均为纯 Node 脚本，不需要 API Key。修改逻辑后至少跑 `test:analysis`、`test:strategies` 与 `build`。

## 约定

- 文档与提交信息用中文；代码风格与周围保持一致。
- 大二进制与生成产物不要提交：构建输出、安装包、视频 `renders/`、缓存 `*.db`、预览图、重复压缩包等；规则见根 `.gitignore` 与 `ai-serial-assistant-app/.gitignore`。
- 竞赛交付物（PPT/PDF/视频）按现有惯例可入库；文件体积很大时先与维护人确认。
- `docs/` 下的计划/排查文档多为历史记录；`参赛材料/` 中部分旧文档仍以裸文件名（如 `项目计划.md`、`问题反馈.md`）引用它们，实际文件已移至 `docs/`。
- 子项目 `promo-video/` 有独立的代理指南与渲染流程，不要套用本仓库前端约定。

## Git 状态（重要）

- 当前分支 `master` 与 `origin/master` **处于分叉状态，尚未合并**：
  - 本地 `70b5e44`：「后端五批加固与前端问题修复」——对 PID 智能体核心文件做了大量加固 / 修复。
  - 远端 `cd94ec9`、`b4e101a`：确定性策略工具重构 + TUNER 展示站 `website/`（并把换行统一为 LF）。
- 直接 `git merge origin/master` 会在 7 个核心文件（`package.json`、`PidAgentPanel.vue`、`usePidAgent.mjs`、`systemPrompt.mjs`、`tools/index.mjs`、`strategies.mjs`、`tests/pid-agent-tools.mjs`）产生内容冲突：两边并行大改，且远端做了 CRLF→LF 规范化。
- **不要自行 merge / rebase / 强推，也不要任意丢弃其中一边的改动**；合并策略需由维护人决定。
