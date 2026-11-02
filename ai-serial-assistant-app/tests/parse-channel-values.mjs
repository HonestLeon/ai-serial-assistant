/**
 * 统一通道解析（BE-16 回归）。
 *
 * 历史上 App / DataMonitor / WorkspaceChart / 智能体各自抄了一份同样的正则，
 * 且都不支持科学计数法：`-4.2e-05` 会被切成 `-4.2` 与 `05`，
 * 小信号通道（电压/电流/误差）因此全错，通道顺序也跟着错位。
 */
import assert from 'node:assert/strict'
import { parseChannelValues } from '../src/renderer/src/services/parseChannelValues.mjs'

// 1. FireWater「标签:值」：只取冒号后
{
  assert.deepEqual(parseChannelValues('target,feedback,output: 1,2,3'), ['1', '2', '3'])
  assert.deepEqual(parseChannelValues('target,feedback,output: 1,2,3', { numeric: true }), [1, 2, 3])
}

// 2. 科学计数法（核心回归）：必须是一个数值，不能被切开
{
  assert.deepEqual(
    parseChannelValues('voltage,current: -4.2e-05,3E+8', { numeric: true }),
    [-4.2e-5, 3e8]
  )
  // 旧实现会得到 ["-4.2", "05", "3", "8"]（两个通道变四个）
  const legacy = '-4.2e-05,3E+8'.match(/[-+]?\d*\.?\d+/g)
  assert.notEqual(legacy.length, 2, '旧正则应把 2 个通道切成 4 段（说明该用例确实覆盖回归点）')
}

// 3. 符号与小数形式
{
  assert.deepEqual(parseChannelValues('a,b,c: +1.5,-.5,0.', { numeric: true }), [1.5, -0.5, 0])
}

// 4. 无冒号：整行取数
{
  assert.deepEqual(parseChannelValues('10 20 30', { numeric: true }), [10, 20, 30])
}

// 5. maxChannels 上限（界面 8 通道 / 智能体只取前 3）
{
  const line = 'a,b,c,d: 1,2,3,4,5,6'
  assert.deepEqual(parseChannelValues(line), ['1', '2', '3', '4', '5', '6'])
  assert.deepEqual(parseChannelValues(line, { maxChannels: 3 }), ['1', '2', '3'])
  assert.deepEqual(parseChannelValues(line, { numeric: true, maxChannels: 2 }), [1, 2])
}

// 6. 无匹配：字符串模式返回 null，数值模式返回空数组（保持原调用方契约）
{
  assert.equal(parseChannelValues('no numbers here'), null)
  assert.deepEqual(parseChannelValues('no numbers here', { numeric: true }), [])
  assert.equal(parseChannelValues(''), null)
  assert.deepEqual(parseChannelValues('', { numeric: true }), [])
  assert.deepEqual(parseChannelValues(null, { numeric: true }), [])
}

// 7. 标签里带数字时不能被误读（只取冒号后）
{
  assert.deepEqual(parseChannelValues('ch1,ch2: 7,8', { numeric: true }), [7, 8])
}

console.log('✅ tests/parse-channel-values.mjs 全部通过')
