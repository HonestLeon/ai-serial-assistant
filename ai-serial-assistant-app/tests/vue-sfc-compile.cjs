const fs = require('node:fs')
const path = require('node:path')
const compilerDirectory = fs.readdirSync(path.resolve('node_modules/.pnpm'))
  .find((name) => name.startsWith('@vue+compiler-sfc@'))
if (!compilerDirectory) throw new Error('未找到 @vue/compiler-sfc')
const {
  compileScript,
  compileTemplate,
  parse
} = require(path.resolve('node_modules/.pnpm', compilerDirectory, 'node_modules/@vue/compiler-sfc'))

function collectVueFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return collectVueFiles(target)
    return entry.name.endsWith('.vue') ? [target] : []
  })
}

for (const filename of collectVueFiles(path.resolve('src/renderer/src'))) {
  const source = fs.readFileSync(filename, 'utf8')
  const id = Buffer.from(filename).toString('hex').slice(-12)
  const { descriptor, errors } = parse(source, { filename })
  if (errors.length) throw errors[0]
  if (descriptor.scriptSetup) compileScript(descriptor, { id })
  if (descriptor.template) {
    const result = compileTemplate({
      id,
      filename,
      source: descriptor.template.content,
      scoped: descriptor.styles.some((style) => style.scoped)
    })
    if (result.errors.length) throw result.errors[0]
  }
}

console.log('vue-sfc-compile: ok')
