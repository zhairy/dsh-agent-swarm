#!/usr/bin/env node
/** 仅生成 user-service 内容；不写 systemd 目录，不启停任何服务。 */
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const renderExecutionService = ({ root, node, image }) => {
  for (const [name, value] of Object.entries({ root, node })) {
    if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n\0%@$]/.test(value)) throw new Error(`${name} 必须是无控制字符的绝对路径`)
  }
  if (typeof image !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/.test(image)) throw new Error('image 必须是合法镜像名或 digest')
  const escape = value => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  const template = readFileSync(new URL('./swarm-execution-daemon.service.in', import.meta.url), 'utf8')
  return template.replaceAll('@REPO_ROOT@', escape(root)).replaceAll('@NODE_BIN@', escape(node)).replaceAll('@RUNTIME_IMAGE@', image)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const option = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1] }
  process.stdout.write(renderExecutionService({ root: option('--root') ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'), node: option('--node') ?? process.execPath, image: option('--image') ?? 'dsh-swarm-runtime:3.4.2' }))
}
