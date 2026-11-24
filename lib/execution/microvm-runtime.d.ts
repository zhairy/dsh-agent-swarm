export type MicroVmCapability = {
    available: false;
    kind: 'microvm';
    reason: string;
} | {
    available: true;
    kind: 'microvm';
    backend: 'firecracker' | 'qemu';
};
export interface MicroVmProbe {
    isFile(path: string): Promise<boolean>;
    isCommand(command: string): Promise<boolean>;
}
export declare const defaultMicroVmProbe: MicroVmProbe;
export declare const detectMicroVmCapability: (probe?: MicroVmProbe) => Promise<MicroVmCapability>;
