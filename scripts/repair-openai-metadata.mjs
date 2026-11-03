#!/usr/bin/env node
/**
 * Check or repair known direct OpenAI API model metadata in a DSH profile.
 *
 * The default mode is read-only. `--apply` creates a backup and atomically
 * replaces only the contextWindow fields of existing models under
 * llm-pi-ai.config.providers.openai. Subscription and third-party providers do
 * not share the public API limits and are deliberately left untouched.
 */
import { chmodSync, copyFileSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isMap, isSeq, parseDocument } from 'yaml'
import { getOpenAIAPIMetadataMismatches, OPENAI_API_MODEL_METADATA } from '../lib/model-metadata.js'

const option = (args, name, fallback) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}

export const findDirectOpenAIModels = (document) => {
  if (!isSeq(document.contents)) throw new Error('cordis.patch.yml 根节点必须是序列')
  const entry = document.contents.items.find((item) => isMap(item) && item.get('id') === 'llm-pi-ai')
  if (entry === undefined) return []
  const models = entry.getIn(['config', 'providers', 'openai', 'models'], true)
  if (models === undefined) return []
  if (!isSeq(models)) throw new Error('llm-pi-ai.config.providers.openai.models 必须是序列')
  return models.items.filter((item) => isMap(item) && typeof item.get('id') === 'string')
}

export const inspectOpenAIProfileText = (text) => {
  const document = parseDocument(text, { prettyErrors: true })
  if (document.errors.length > 0) throw new Error(document.errors.map((error) => error.message).join('; '))
  const nodes = findDirectOpenAIModels(document)
  const models = nodes.map((node) => {
    const id = node.get('id')
    const contextWindow = node.get('contextWindow')
    return { id, ...(typeof contextWindow === 'number' ? { contextWindow } : {}) }
  })
  return { document, nodes, models, mismatches: getOpenAIAPIMetadataMismatches(models) }
}

export const repairOpenAIProfileText = (text) => {
  const inspected = inspectOpenAIProfileText(text)
  const changes = []
  for (const node of inspected.nodes) {
    const id = node.get('id')
    const expected = Object.hasOwn(OPENAI_API_MODEL_METADATA, id) ? OPENAI_API_MODEL_METADATA[id] : undefined
    if (expected === undefined || node.get('contextWindow') === expected.contextWindow) continue
    const previous = node.get('contextWindow')
    node.set('contextWindow', expected.contextWindow)
    changes.push({ id, previous, contextWindow: expected.contextWindow, source: expected.source })
  }
  const models = inspected.nodes.map((node) => {
    const id = node.get('id')
    const contextWindow = node.get('contextWindow')
    return { id, ...(typeof contextWindow === 'number' ? { contextWindow } : {}) }
  })
  return { ...inspected, models, changes, text: inspected.document.toString({ lineWidth: 0 }) }
}

const main = () => {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const dshHome = resolve(option(args, '--dsh-home', process.env.DSH_HOME ?? join(homedir(), '.dsh')))
  const profileDir = resolve(option(args, '--profile-dir', join(dshHome, 'profiles', option(args, '--profile', 'web'))))
  const target = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(target)) throw new Error(`profile 缺少 cordis.patch.yml：${target}`)
  const targetStat = lstatSync(target)
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error(`拒绝修改非普通文件或符号链接：${target}`)
  const targetMode = targetStat.mode & 0o777
  const original = readFileSync(target, 'utf8')
  const inspected = inspectOpenAIProfileText(original)
  if (apply && inspected.mismatches.length > 0) {
    const repaired = repairOpenAIProfileText(original)
    const backup = `${target}.bak-openai-metadata-${Date.now()}`
    copyFileSync(target, backup)
    chmodSync(backup, targetMode)
    const temporary = `${target}.tmp-${process.pid}`
    try {
      writeFileSync(temporary, repaired.text, { mode: targetMode })
      chmodSync(temporary, targetMode)
      renameSync(temporary, target)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
    const verified = inspectOpenAIProfileText(readFileSync(target, 'utf8'))
    if (verified.mismatches.length > 0) throw new Error(`修复后复检仍失败；请恢复备份：${backup}`)
    process.stdout.write(JSON.stringify({ target, backup, models: repaired.models, changes: repaired.changes }, null, 2) + '\n')
    return
  }
  process.stdout.write(JSON.stringify({ target, models: inspected.models, mismatches: inspected.mismatches, applied: false }, null, 2) + '\n')
  if (inspected.mismatches.length > 0) process.exitCode = 1
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main()
