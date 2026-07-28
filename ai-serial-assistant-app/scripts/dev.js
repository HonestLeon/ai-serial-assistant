/**
 * 开发启动脚本
 *
 * 清除 ELECTRON_RUN_AS_NODE 环境变量后启动 electron-vite dev。
 * 该环境变量由部分 VS Code 扩展设置，会导致 Electron 以纯 Node.js 模式运行，
 * 从而导致 require('electron') 返回 npm 包导出路径而非 Electron API 对象。
 *
 * 同时显式设置 ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR 环境变量，
 * 让 electron 与 electron-builder 在安装/打包阶段走国内镜像（写在 .npmrc 中已不再被 npm 识别）。
 */

delete process.env.ELECTRON_RUN_AS_NODE;

// Electron 二进制镜像（原 .npmrc 中的 electron_mirror，npm 7+ 不再支持自定义键，改用环境变量）
if (!process.env.ELECTRON_MIRROR) {
  process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
}
if (!process.env.ELECTRON_BUILDER_BINARIES_MIRROR) {
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';
}

const { spawn } = require('child_process');

// Windows 下 npx 是 .cmd 批处理，必须经 shell 才能执行；其他平台可直接 spawn。
// Node DEP0190 警告是针对 "args 数组 + shell:true" 的组合（参数未转义有注入风险），
// 这里改用「整条命令字符串 + shell:true」，由 shell 自行拆词，规避该警告。
const isWin = process.platform === 'win32';
const child = isWin
  ? spawn('npx electron-vite dev', { stdio: 'inherit', env: process.env, shell: true })
  : spawn('npx', ['electron-vite', 'dev'], { stdio: 'inherit', env: process.env });

child.on('exit', (code) => process.exit(code));

