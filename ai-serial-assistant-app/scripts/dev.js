/**
 * 开发启动脚本
 *
 * 清除 ELECTRON_RUN_AS_NODE 环境变量后启动 electron-vite dev。
 * 该环境变量由部分 VS Code 扩展设置，会导致 Electron 以纯 Node.js 模式运行，
 * 从而导致 require('electron') 返回 npm 包导出路径而非 Electron API 对象。
 */

delete process.env.ELECTRON_RUN_AS_NODE;

const { spawn } = require('child_process');

const child = spawn('npx', ['electron-vite', 'dev'], {
  stdio: 'inherit',
  env: process.env,
  shell: true
});

child.on('exit', (code) => process.exit(code));
