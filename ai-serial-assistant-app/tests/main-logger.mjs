/**
 * 主进程结构化日志单测（BE-22 回归）。
 *
 * 覆盖：未初始化时静默、落盘格式、结构化字段、按大小滚动、flush 后内容完整。
 * 使用临时目录 + 小阈值，几毫秒内即可触发滚动。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushLogger, getLogPath, initLogger, logEvent } from '../src/main/logger.js'

// 1. 未初始化：不建目录、不写盘、不抛错
{
  assert.equal(getLogPath(), '')
  assert.doesNotThrow(() => logEvent('info', 'before.init', { a: 1 }))
  await flushLogger()
}

const dir = await mkdtemp(join(tmpdir(), 'asa-log-'))
try {
  // 2. 初始化 + 落盘：写入路径、事件名与 JSON 字段
  const filePath = await initLogger(dir, { maxBytes: 4096, keepFiles: 2 })
  assert.equal(filePath, join(dir, 'main.log'))
  assert.equal(getLogPath(), filePath)

  logEvent('info', 'serial.opened', { path: 'COM3', baudRate: 115200 })
  logEvent('error', 'serial.error', { message: 'Access denied' })
  logEvent('info', 'llm.request', { host: 'api.example.com', status: 200, ok: true })
  // 不可序列化字段不应抛错
  const circular = {}
  circular.self = circular
  assert.doesNotThrow(() => logEvent('warn', 'bad.fields', circular))
  await flushLogger()

  const text = await readFile(filePath, 'utf8')
  assert.match(text, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO serial\.opened \{"path":"COM3","baudRate":115200\}$/m)
  assert.match(text, /ERROR serial\.error \{"message":"Access denied"\}/)
  assert.match(text, /INFO llm\.request \{"host":"api\.example\.com","status":200,"ok":true\}/)
  assert.match(text, /WARN bad\.fields \{"fields":"<unserializable>"\}/)

    // 3. 滚动：超过 maxBytes 后 main.log 移为 main.1.log，保留份数受 keepFiles 约束
  for (let index = 0; index < 80; index += 1) {
    logEvent('info', 'bulk.write', { index, payload: 'x'.repeat(80) })
  }
  await flushLogger()
  const files = await readdir(dir)
  assert.ok(files.includes('main.log'), '当前日志文件必须存在')
  assert.ok(files.includes('main.1.log'), '超限后应滚动出 main.1.log')
  assert.equal(files.includes('main.2.log'), false, 'keepFiles=2 时不应出现 main.2.log')

  // 当前文件仍可正常写入（滚动后从头开始）
  logEvent('info', 'after.rotation')
  await flushLogger()
  const current = await readFile(join(dir, 'main.log'), 'utf8')
  assert.match(current, /after\.rotation/)
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log('✅ tests/main-logger.mjs 全部通过')
