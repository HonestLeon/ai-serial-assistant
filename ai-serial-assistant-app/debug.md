### 排查工作交接说明（已解决 ✅）

#### 一、问题背景
用户反馈项目执行 `npm run dev` 后，无法检测到连接的串口、也无法打开串口。项目为 Electron + Vue + electron-vite 架构，串口功能基于 `serialport` v13 实现。

#### 二、根因总结（共 3 个问题，已全部修复）

##### 问题 1：`package.json` 中 `"type": "module"` 导致 ESM/CJS 冲突
- **现象**：主进程启动报错 `SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'`
- **原因**：Electron 42.5.1 对 ESM 格式主进程的命名导出支持存在兼容性问题
- **修复**：移除 `package.json` 中的 `"type": "module"` 字段

##### 问题 2：配置文件扩展名
- **现象**：移除 `"type": "module"` 后，`electron.vite.config.js` 中的 ESM 语法（`import`/`export`）会报错
- **修复**：将 `electron.vite.config.js` 重命名为 `electron.vite.config.mjs`，保留 ESM 语法

##### 问题 3：`ELECTRON_RUN_AS_NODE=1` 环境变量（核心根因）
- **现象**：移除 `"type": "module"` 后，`require('electron')` 返回字符串路径而非 Electron API 对象，`electron.app` 为 `undefined`
- **原因**：VS Code 扩展宿主进程设置了 `ELECTRON_RUN_AS_NODE=1`，导致 Electron 以纯 Node.js 模式运行，跳过主进程运行时初始化。此环境变量在父进程中设定，会传播到所有子进程（npm → electron-vite → Electron）
- **关键发现**：
  - `ELECTRON_RUN_AS_NODE=`（设为空字符串）**无效** — Electron native 代码检查变量是否存在，而非值是否为空
  - 必须彻底 `unset` 或 `delete process.env.ELECTRON_RUN_AS_NODE`
  - `process.type` 为 `undefined`（正常应为 `"browser"`）是该问题的特征标志
- **修复**：创建 `scripts/dev.js` 包装脚本，在启动 `electron-vite dev` 前删除该环境变量

---

#### 三、文件改动汇总

| 文件 | 操作 | 说明 |
|------|------|------|
| `package.json` | 修改 | 移除 `"type": "module"`；`dev` 脚本改为 `node scripts/dev.js` |
| `electron.vite.config.js` | 重命名 | → `electron.vite.config.mjs` |
| `src/main/index.js` | 修改 | `isDev` 改用 `process.env.ELECTRON_RENDERER_URL` 检测，避免顶层调用 `app.isPackaged` |
| `scripts/dev.js` | 新建 | 包装脚本，删除 `ELECTRON_RUN_AS_NODE` 后启动 electron-vite |
| `test-serial.cjs` | 删除 | 临时排查文件 |
| `test-serial-node.cjs` | 删除 | 临时排查文件 |
| `test-electron.cjs` | 删除 | 临时排查文件 |

---

#### 四、验证结果

- ✅ `npm run dev` 启动正常，主进程不再报错
- ✅ 构建产物格式正确（CJS），preload 路径匹配
- ✅ Electron 窗口正常打开，DevTools 可用
- ✅ 串口刷新、打开功能正常，数据区能显示收发数据
- ✅ 用户已确认功能可用

---

#### 五、关键环境信息
- 项目路径：`d:\HUST\Study\Computer\Trae_contest\ai-serial-assistant\ai-serial-assistant-app`
- 环境版本：Node v24.17.0、Electron 42.5.1、electron-vite 5.0.0、serialport ^13.0.0
- 系统环境：Windows 11 Pro
- npm 镜像：npmmirror.com（淘宝镜像）
