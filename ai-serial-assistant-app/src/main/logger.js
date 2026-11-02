/**
 * 主进程结构化日志 —— 纯 Node 模块（不依赖 electron），便于单独测试与复用。
 *
 * 设计要点：
 *   - **按事件记录**，不做逐帧日志：串口每帧写盘会把主进程拖死，这里只记录
 *     连接/断开/写超时/丢帧/LLM 请求这类低频但排障关键的事件；
 *   - **异步串行写入**：appendFile 排队执行，避免并发写交错，也不阻塞串口与 IPC；
 *   - **按大小滚动**：main.log 超限后滚动为 main.1.log / main.2.log（保留 3 份）；
 *   - **未初始化即静默**：单测/纯 Node 环境直接 import 也不会建目录、不会写盘。
 *
 * 日志行格式：`<ISO 时间> <LEVEL> <event> {<JSON fields>}`
 * 敏感字段（API Key / Authorization / 完整请求体）一律不记录。
 */
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_KEEP_FILES = 3

let logDir = ''
let logFile = ''
let initialized = false
let bytesWritten = 0
/** 滚动策略（initLogger 可覆盖，便于单测用小文件触发滚动） */
let maxBytes = DEFAULT_MAX_BYTES
let keepFiles = DEFAULT_KEEP_FILES
/** 写入队列：所有 append 串行执行，单次失败不影响后续日志 */
let writeChain = Promise.resolve()

/**
 * 初始化日志目录（应用启动时调用一次）。
 * @param {string} directory 日志目录（通常是 app.getPath('userData')/logs）
 * @param {{maxBytes?: number, keepFiles?: number}} [options] 滚动阈值与保留份数
 * @returns {Promise<string|null>} 日志文件路径（失败返回 null）
 */
export async function initLogger(directory, options = {}) {
  if (!directory) return null
  try {
    logDir = directory
    maxBytes = Math.max(256, Number(options.maxBytes) || DEFAULT_MAX_BYTES)
    keepFiles = Math.max(1, Math.round(Number(options.keepFiles) || DEFAULT_KEEP_FILES))
    await mkdir(logDir, { recursive: true })
    logFile = join(logDir, 'main.log')
    try {
      const info = await stat(logFile)
      bytesWritten = info.size
    } catch {
      bytesWritten = 0
    }
    initialized = true
    return logFile
  } catch (error) {
    initialized = false
    console.error('[main] 日志初始化失败：', error?.message || error)
    return null
  }
}

/** 当前日志文件路径（未初始化返回空串） */
export function getLogPath() {
  return logFile
}

/** 关闭日志（退出前 flush 未写完的队列） */
export async function flushLogger() {
  await writeChain.catch(() => {})
}

/**
 * 滚动日志文件：删除最旧一份，其余依次后移，main.log 空出。
 * 滚动失败（文件不存在/权限）按"没有旧日志"处理，不影响后续写入。
 */
async function rotateFiles() {
  try {
    await unlink(join(logDir, `main.${keepFiles - 1}.log`))
  } catch { /* 最旧文件可能不存在 */ }
  for (let index = keepFiles - 2; index >= 1; index -= 1) {
    try {
      await rename(join(logDir, `main.${index}.log`), join(logDir, `main.${index + 1}.log`))
    } catch { /* 该代文件可能不存在 */ }
  }
  try {
    await rename(logFile, join(logDir, 'main.1.log'))
  } catch { /* 首次写入时 main.log 可能还不存在 */ }
  bytesWritten = 0
}

/**
 * 记录一条事件。
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} event 事件名（蛇形/点分，便于检索，如 'serial.open'）
 * @param {object} [fields] 结构化字段（不得包含 API Key 等敏感值）
 */
export function logEvent(level, event, fields) {
  if (!initialized) return
  let payload = ''
  if (fields && typeof fields === 'object') {
    try {
      payload = ` ${JSON.stringify(fields)}`
    } catch {
      payload = ' {"fields":"<unserializable>"}'
    }
  }
  const line = `${new Date().toISOString()} ${String(level).toUpperCase()} ${event}${payload}\n`
  const size = Buffer.byteLength(line, 'utf8')
  writeChain = writeChain.then(async () => {
    try {
      if (bytesWritten + size > maxBytes) await rotateFiles()
      await appendFile(logFile, line, 'utf8')
      bytesWritten += size
    } catch {
      /* 磁盘满/权限问题：日志失败绝不影响主流程 */
    }
  })
}
