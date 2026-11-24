import type { AttachmentsLike, ContentBlockLike } from './host-contract.js';
/** DSH 附件服务支持的源图片格式 */
export declare const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>>;
/** 通过校验的图片路径 */
export interface ImagePathInfo {
    path: string;
    absolute: string;
    mediaType: string;
}
/**
 * 校验图片路径：必须位于工作区内且格式受支持
 * @param {string[]} paths - 相对工作区或绝对路径
 * @param {string} workspaceRoot - 工作区根目录
 * @returns {{ ok: boolean; resolved: ImagePathInfo[]; errors: string[] }} 校验结果
 */
export declare const ValidateImagePaths: (paths: string[], workspaceRoot: string) => {
    ok: boolean;
    resolved: ImagePathInfo[];
    errors: string[];
};
/**
 * 读取图片并通过附件服务入库，得到可放入 prompt 的图片块
 * @param {ImagePathInfo[]} images - 已校验的图片
 * @param {{ readFile: (path: string) => Promise<Uint8Array>; attachments?: AttachmentsLike }} deps - 文件读取与附件服务
 * @returns {Promise<ContentBlockLike[]>} 图片块
 */
export declare const getImageBlocks: (images: ImagePathInfo[], deps: {
    readFile: (path: string) => Promise<Uint8Array>;
    attachments?: AttachmentsLike;
}) => Promise<ContentBlockLike[]>;
