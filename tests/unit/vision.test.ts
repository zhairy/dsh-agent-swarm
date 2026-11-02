import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ValidateImagePaths, getImageBlocks } from '../../src/vision.js'

const root = resolve('/workspace/project')

describe('ValidateImagePaths', () => {
  it('接受工作区内的常见图片格式', () => {
    const result = ValidateImagePaths(['shots/a.png', 'b.JPG', join(root, 'c.webp')], root)
    expect(result.ok).toBe(true)
    expect(result.resolved.map((r) => r.mediaType)).toEqual(['image/png', 'image/jpeg', 'image/webp'])
    expect(result.resolved[0]?.absolute).toBe(join(root, 'shots', 'a.png'))
  })

  it('拒绝越界路径与不支持的格式', () => {
    const result = ValidateImagePaths(['../outside.png', 'doc.pdf', resolve('/elsewhere/x.png')], root)
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(3)
    expect(result.errors[0]).toContain('不在工作区内')
    expect(result.errors[1]).toContain('不支持的图片格式')
  })

  it('空列表视为不合法', () => {
    expect(ValidateImagePaths([], root)).toMatchObject({ ok: false, errors: ['image_paths 不能为空'] })
  })
})

describe('getImageBlocks', () => {
  it('读取文件并通过附件服务入库，返回图片块', async () => {
    const saveImages = vi.fn(async (inputs: unknown[]) => inputs.map((_, index) => ({ id: `ref-${index}` })))
    const blocks = await getImageBlocks(
      [{ path: 'a.png', absolute: '/w/a.png', mediaType: 'image/png' }],
      { readFile: async () => new Uint8Array([1, 2, 3]), attachments: { saveImages } }
    )
    expect(blocks).toEqual([{ type: 'image', attachment: { id: 'ref-0' } }])
    expect(saveImages).toHaveBeenCalledWith([{ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', name: 'a.png' }])
  })

  it('附件服务不可用时抛错', async () => {
    await expect(getImageBlocks([{ path: 'a.png', absolute: '/w/a.png', mediaType: 'image/png' }], { readFile: async () => new Uint8Array() }))
      .rejects.toThrow('附件服务不可用')
  })
})
