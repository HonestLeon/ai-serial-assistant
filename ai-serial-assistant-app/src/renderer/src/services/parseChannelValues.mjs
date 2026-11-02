/**
 * FireWater 风格串口行解析（单一实现，供 App / DataMonitor / WorkspaceChart / 智能体共用）。
 *
 * 格式约定：「标签1,标签2,...: 值1,值2,...」——只取冒号之后的部分；
 * 无冒号时整行取数（兼容纯数值流）。
 *
 * 与旧的四处副本相比的关键差异：**支持科学计数法**。
 * 旧正则 /[-+]?\d*\.?\d+/g 会把 `-4.2e-05` 切成 `-4.2` 与 `05` 两个值，
 * 小信号（电压/电流/误差）通道全错，且同一行里的通道顺序从此错位。
 */

/** 数值字面量：可带符号、整数/小数、可选指数（1.5、-.5、-4.2e-05、3E+8） */
const NUMBER_PATTERN = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g

/**
 * 从一行串口文本中提取通道值。
 *
 * @param {string} rawText 原始行（可含标签前缀）
 * @param {{maxChannels?: number, numeric?: boolean}} [options]
 *   - maxChannels：最多取多少个通道（默认 8，与界面通道数一致）
 *   - numeric：true 返回 number[]（无匹配返回 []），false 返回字符串数组（无匹配返回 null）
 * @returns {string[] | number[] | null}
 */
export function parseChannelValues(rawText, { maxChannels = 8, numeric = false } = {}) {
  const text = String(rawText ?? '')
  if (!text) return numeric ? [] : null
  const colonIndex = text.indexOf(':')
  const dataPart = colonIndex >= 0 ? text.slice(colonIndex + 1) : text
  const matches = dataPart.match(NUMBER_PATTERN)
  if (!matches) return numeric ? [] : null
  const limit = Math.max(0, Math.round(Number(maxChannels) || 0))
  const picked = limit > 0 ? matches.slice(0, limit) : matches
  return numeric ? picked.map(Number) : picked
}
