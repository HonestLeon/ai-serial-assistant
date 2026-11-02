/**
 * JustFloat（VOFA+ 浮点流）切帧器 —— 纯 Node 模块，不依赖 Electron / serialport，可直接单测。
 *
 * 协议：每帧 = N 个 little-endian float32 + 帧尾 `00 00 80 7F`（4 字节）。
 *
 * 三条边界规则（对应历史缺陷）：
 *   1. **单个 chunk 超过缓冲上限时不整块丢弃**：chunk 里可能装着完整帧，
 *      先切出所有完整帧，只有「剩余半帧」超限时才作为脏数据丢弃；
 *   2. **非 4 字节对齐的帧不静默丢弃**：计数并回调，调用方可提示"数据引擎/波特率可能选错"；
 *   3. **溢出可观测**：丢弃时回调实际字节数与累计异常帧数，便于上层上报与排障。
 */

// 帧尾标识：0x00 0x00 0x80 0x7F（VOFA+ JustFloat）
export const JUSTFLOAT_TAIL = Buffer.from([0x00, 0x00, 0x80, 0x7f])

// 默认缓冲上限：协议错配时帧尾永远不出现，必须有上限否则缓冲只增不减会吃满主进程内存
export const DEFAULT_MAX_BUFFER = 64 * 1024

/**
 * 创建 JustFloat 切帧器。
 *
 * @param {object} options
 * @param {(frame: {floats: number[], byteLength: number}) => void} options.onFrame 每切出完整帧时回调
 * @param {(info: {droppedBytes: number, misalignedFrames: number}) => void} [options.onOverflow]
 *   剩余半帧超过上限、被丢弃时回调（未提供时静默丢弃）
 * @param {(info: {misalignedFrames: number}) => void} [options.onMisaligned]
 *   切出长度非 4 倍数（协议错位）的帧时回调
 * @param {number} [options.maxBuffer] 缓冲上限（字节）
 * @returns {{push: (chunk: Buffer) => void, reset: () => void, stats: () => {bufferedBytes: number, misalignedFrames: number}}}
 */
export function createJustFloatFramer({ onFrame, onOverflow = null, onMisaligned = null, maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
  const limit = Math.max(16, Number(maxBuffer) || DEFAULT_MAX_BUFFER)
  /** @type {Buffer[]} 待拼接的分片（避免每块都对全量缓冲做 O(n) 拷贝累积） */
  let chunks = []
  let bufferedBytes = 0
  let misalignedFrames = 0

  const reset = () => {
    chunks = []
    bufferedBytes = 0
  }

  const emitFrame = (frame) => {
    const floats = []
    for (let i = 0; i < frame.length; i += 4) floats.push(frame.readFloatLE(i))
    onFrame?.({ floats, byteLength: frame.length + JUSTFLOAT_TAIL.length })
  }

  return {
    /** 喂入一段串口数据；内部按帧尾切分并回调 onFrame */
    push(chunk) {
      if (!Buffer.isBuffer(chunk) || chunk.length === 0) return
      chunks.push(chunk)
      bufferedBytes += chunk.length

      const buffer = Buffer.concat(chunks, bufferedBytes)
      let offset = 0
      while (true) {
        const tailIndex = buffer.indexOf(JUSTFLOAT_TAIL, offset)
        if (tailIndex < 0) break
        const frame = buffer.subarray(offset, tailIndex)
        if (frame.length >= 4 && frame.length % 4 === 0) {
          emitFrame(frame)
        } else if (frame.length > 0) {
          // 协议错位：长度不是 float32 的整数倍，无法还原，计数后跳过该段
          misalignedFrames += 1
          onMisaligned?.({ misalignedFrames })
        }
        offset = tailIndex + JUSTFLOAT_TAIL.length
      }

      const rest = buffer.subarray(offset)
      if (rest.length > limit) {
        // 剩余半帧超限：丢弃并上报（此前单 chunk > 上限会把整块合法数据一起丢掉）
        reset()
        onOverflow?.({ droppedBytes: rest.length, misalignedFrames })
        return
      }
      if (rest.length) {
        chunks = [Buffer.from(rest)]
        bufferedBytes = rest.length
      } else {
        reset()
      }
    },

    /** 清空缓冲（关闭串口 / 协议切换时调用）；异常帧计数一并归零 */
    reset() {
      reset()
      misalignedFrames = 0
    },

    /** 当前缓冲与异常计数（供日志/诊断使用） */
    stats: () => ({ bufferedBytes, misalignedFrames })
  }
}
