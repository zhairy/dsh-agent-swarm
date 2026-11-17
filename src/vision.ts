import { basename, extname, isAbsolute, relative, resolve } from 'node:path'
import type { AttachmentsLike, ContentBlockLike } from './host-contract.js'
import { SwarmError } from './util/errors.js'

/** DSH 附件服务支持的源图片格式 */
export const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/** 通过校验的图片路径 */
export interface ImagePathInfo {
  path: string
  absolute: string
  mediaType: string
}

/**
 * 校验图片路径：必须位于工作区内且格式受支持
 * @param {string[]} paths - 相对工作区或绝对路径
 * @param {string} workspaceRoot - 工作区根目录
 * @returns {{ ok: boolean; resolved: ImagePathInfo[]; errors: string[] }} 校验结果
 */
export const ValidateImagePaths = (paths: string[], workspaceRoot: string) => {
  if (paths.length === 0) return { ok: false, resolved: [] as ImagePathInfo[], errors: ['image_paths 不能为空'] }
  const errors: string[] = []
  const resolved: ImagePathInfo[] = []
  for (const path of paths) {
    const absolute = resolve(workspaceRoot, path)
    const rel = relative(workspaceRoot, absolute)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      errors.push(`${path} 不在工作区内`)
      continue
    }
    const mediaType = IMAGE_MEDIA_TYPES[extname(absolute).toLowerCase()]
    if (mediaType === undefined) {
      errors.push(`${path} 是不支持的图片格式（支持 png/jpg/jpeg/webp/gif）`)
      continue
    }
    resolved.push({ path, absolute, mediaType })
  }
  return { ok: errors.length === 0, resolved, errors }
}

/**
 * 读取图片并通过附件服务入库，得到可放入 prompt 的图片块
 * @param {ImagePathInfo[]} images - 已校验的图片
 * @param {{ readFile: (path: string) => Promise<Uint8Array>; attachments?: AttachmentsLike }} deps - 文件读取与附件服务
 * @returns {Promise<ContentBlockLike[]>} 图片块
 */
export const getImageBlocks = async (
  images: ImagePathInfo[],
  deps: { readFile: (path: string) => Promise<Uint8Array>; attachments?: AttachmentsLike }
): Promise<ContentBlockLike[]> => {
  const attachments = deps.attachments
  if (attachments === undefined) throw new SwarmError('SERVICE_UNAVAILABLE', '附件服务不可用，无法把图片交给观象')
  const inputs = await Promise.all(images.map(async (image) => ({
    data: await deps.readFile(image.absolute),
    mediaType: image.mediaType,
    name: basename(image.absolute)
  })))
  const refs = await attachments.saveImages(inputs)
  return refs.map((attachment) => ({ type: 'image', attachment }))
}
