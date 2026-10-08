# TUNER 产品展示网站

静态官网与可交互的电机速度环实验台，目标发布地址为
<https://HonestLeon.github.io/ai-serial-assistant/>。

## 本地运行

需要 Node.js 22.12+。在 `ai-serial-assistant-app` 目录运行：

```sh
npm ci --ignore-scripts
npm run test:site
npm run site:dev
```

打开终端提示的 `http://127.0.0.1:4173`。停止开发服务后，可验证生产版本：

```sh
npm run site:build
npm run site:preview
```

`--ignore-scripts` 仅适用于构建这个静态网站；运行 Electron 桌面应用请按项目根 README 安装依赖。

## 演示范围

- 产品介绍、4 张真实软件截图、团队与项目进展。
- 复用桌面项目 `pidSimulation.mjs` 和 `controlAnalysis.mjs`，不是预先绘制的假数据。
- 电机速度环 4 组参数场景，可修改 Kp/Ki/Kd、目标和噪声，保存对照，查看采样值，导出 CSV。
- 固定随机种子；仿真时长 4 秒、步长 2 毫秒，稳定带宽 ±5%。
- 全部在浏览器本地计算；不连接串口、不调用 AI、不收集 API Key。
- 教学模型无控制输出限幅；结果不代表真实硬件安全参数或产品商业收益。

## GitHub Pages

仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
将变更推送到 `master` 后，`Deploy TUNER website` 工作流自动测试、构建并部署。
也可以在 **Actions** 中手动运行该工作流。

仅 `website/dist` 进入发布产物，不发布仓库其余文件。Vite 使用相对资源路径，支持仓库子路径。
不要直接上传整个源码目录或 `node_modules`。构建目录已被根 `.gitignore` 忽略。

## 内容维护

- 文字与布局：`index.html`、`style.css`。
- 交互与图表：`main.js`；仿真包装与参数范围：`simulation.mjs`。
- 产品截图引用 `发布包/images` 中已有图片；更新截图前检查是否含密钥、账号或个人信息。
- 不将仿真或自测结果写成真实用户测试；Releases 按钮仅链接实际发布列表。
