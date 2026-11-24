import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export const defaultMicroVmProbe = {
    isFile: async (path) => access(path).then(() => true, () => false),
    isCommand: async (command) => execFileAsync('which', [command])
        .then(() => true, () => false)
};
export const detectMicroVmCapability = async (probe = defaultMicroVmProbe) => {
    const [hasKvm, hasFirecracker, hasQemu] = await Promise.all([
        probe.isFile('/dev/kvm'),
        probe.isCommand('firecracker'),
        probe.isCommand('qemu-system-x86_64')
    ]);
    if (!hasFirecracker && !hasQemu) {
        return { available: false, kind: 'microvm', reason: '未发现 qemu/firecracker 可执行文件' };
    }
    if (!hasKvm) {
        return { available: false, kind: 'microvm', reason: '未发现 /dev/kvm，microVM 不会退化为软件模拟' };
    }
    // 仅报告真实二进制和 KVM 前置条件；当前 MVP 尚未构建 microVM 镜像与启动合同。
    return { available: true, kind: 'microvm', backend: hasFirecracker ? 'firecracker' : 'qemu' };
};
//# sourceMappingURL=microvm-runtime.js.map