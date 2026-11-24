import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ExecutionError } from './runtime.js';
const CONTAINER_NAME_PREFIX = 'swarm-exec-';
const EXECUTION_LABEL = 'dev.dsh.swarm.execution';
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const READINESS_ATTEMPTS = 50;
const READINESS_INTERVAL_MS = 100;
const PYTHON_KERNEL_SERVER = String.raw `
import ast
import atexit
import contextlib
import io
import json
import os
import signal
import socketserver
import time

SOCKET_PATH = "/tmp/swarm-execution.sock"
NAMESPACE = {"__name__": "__main__"}

class CellTimeout(Exception):
    pass

def on_alarm(signum, frame):
    raise CellTimeout("cell exceeded wall clock limit")

def trim_utf8(text, limit):
    encoded = text.encode("utf-8")
    if len(encoded) <= limit:
        return text
    marker = "\n...[truncated]"
    keep = max(0, limit - len(marker.encode("utf-8")))
    return encoded[:keep].decode("utf-8", errors="ignore") + marker

def execute_cell(code, timeout_ms, max_output_bytes):
    started = time.monotonic()
    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()
    def captured():
        return {"stdout": trim_utf8(stdout_buffer.getvalue(), max_output_bytes), "stderr": trim_utf8(stderr_buffer.getvalue(), max_output_bytes)}
    signal.signal(signal.SIGALRM, on_alarm)
    signal.setitimer(signal.ITIMER_REAL, timeout_ms / 1000.0)
    try:
        with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
            tree = ast.parse(code, filename="<swarm-cell>", mode="exec")
            value = None
            body = tree.body
            if body and isinstance(body[-1], ast.Expr):
                prefix = ast.Module(body=body[:-1], type_ignores=[])
                if prefix.body:
                    exec(compile(prefix, "<swarm-cell>", "exec"), NAMESPACE, NAMESPACE)
                expression = ast.Expression(body[-1].value)
                value = eval(compile(expression, "<swarm-cell>", "eval"), NAMESPACE, NAMESPACE)
            else:
                exec(compile(tree, "<swarm-cell>", "exec"), NAMESPACE, NAMESPACE)
        try:
            encoded = json.dumps(value, ensure_ascii=False)
            decoded = json.loads(encoded)
        except Exception:
            decoded = repr(value)
            encoded = json.dumps(decoded, ensure_ascii=False)
        if len(encoded.encode("utf-8")) > max_output_bytes:
            return {"ok": False, "error": {"type": "OutputLimitError", "message": "cell output exceeds limit"}, "durationMs": int((time.monotonic() - started) * 1000), **captured()}
        return {"ok": True, "value": decoded, "durationMs": int((time.monotonic() - started) * 1000), **captured()}
    except CellTimeout:
        return {"ok": False, "error": {"type": "TimeoutError", "message": "cell exceeded wall clock limit"}, "durationMs": int((time.monotonic() - started) * 1000), "timedOut": True, **captured()}
    except BaseException as error:
        return {"ok": False, "error": {"type": type(error).__name__, "message": str(error)[:4096]}, "durationMs": int((time.monotonic() - started) * 1000), **captured()}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            request = json.loads(self.rfile.readline().decode("utf-8"))
            code = request.get("code")
            timeout_ms = request.get("timeoutMs")
            max_output_bytes = request.get("maxOutputBytes")
            if not isinstance(code, str) or not isinstance(timeout_ms, int) or not isinstance(max_output_bytes, int):
                raise ValueError("invalid cell request")
            response = execute_cell(code, timeout_ms, max_output_bytes)
        except BaseException as error:
            response = {"ok": False, "error": {"type": type(error).__name__, "message": str(error)[:4096]}, "durationMs": 0, "stdout": "", "stderr": ""}
        self.wfile.write((json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8"))

class Server(socketserver.UnixStreamServer):
    pass

try:
    os.unlink(SOCKET_PATH)
except FileNotFoundError:
    pass
server = Server(SOCKET_PATH, Handler)
os.chmod(SOCKET_PATH, 0o600)
atexit.register(lambda: os.path.exists(SOCKET_PATH) and os.unlink(SOCKET_PATH))
server.serve_forever()
`;
const NODE_KERNEL_SERVER = String.raw `
const fs = require('node:fs')
const net = require('node:net')
const util = require('node:util')
const vm = require('node:vm')

const socketPath = '/tmp/swarm-execution.sock'
let capture = { stdout: '', stderr: '' }
let captureLimit = 256 * 1024
const appendCapture = (stream, values) => {
  const current = capture[stream]
  if (Buffer.byteLength(current, 'utf8') >= captureLimit) return
  const text = util.format(...values) + '\n'
  const combined = current + text
  const bytes = Buffer.from(combined, 'utf8')
  if (bytes.byteLength <= captureLimit) {
    capture[stream] = combined
    return
  }
  const marker = '\n...[truncated]'
  let end = Math.max(0, captureLimit - Buffer.byteLength(marker, 'utf8'))
  let decoded = bytes.subarray(0, end).toString('utf8')
  while (Buffer.byteLength(decoded + marker, 'utf8') > captureLimit && decoded.length > 0) decoded = decoded.slice(0, -1)
  capture[stream] = decoded + marker
}
const captured = () => ({ stdout: capture.stdout, stderr: capture.stderr })
const context = vm.createContext({
  console: {
    log: (...values) => appendCapture('stdout', values),
    info: (...values) => appendCapture('stdout', values),
    debug: (...values) => appendCapture('stdout', values),
    dir: (...values) => appendCapture('stdout', values),
    warn: (...values) => appendCapture('stderr', values),
    error: (...values) => appendCapture('stderr', values),
    trace: (...values) => appendCapture('stderr', values)
  },
  process,
  Buffer,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  performance
})

try { fs.unlinkSync(socketPath) } catch (error) { if (error.code !== 'ENOENT') throw error }

const encodeValue = value => {
  if (value === undefined) return undefined
  const seen = new WeakSet()
  const encoded = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString()
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[Circular]'
      seen.add(item)
    }
    return item
  })
  return encoded === undefined ? undefined : JSON.parse(encoded)
}

const execute = request => {
  const started = performance.now()
  capture = { stdout: '', stderr: '' }
  captureLimit = request.maxOutputBytes
  try {
    const value = vm.runInContext(request.code, context, {
      timeout: request.timeoutMs,
      displayErrors: false,
      filename: '<swarm-cell>'
    })
    const encoded = JSON.stringify({ ok: true, value: encodeValue(value), durationMs: Math.round(performance.now() - started) })
    if (Buffer.byteLength(encoded) > request.maxOutputBytes) {
      return { ok: false, error: { type: 'OutputLimitError', message: 'cell output exceeds limit' }, durationMs: Math.round(performance.now() - started), ...captured() }
    }
    return { ...JSON.parse(encoded), ...captured() }
  } catch (error) {
    const isTimeout = error && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
    return {
      ok: false,
      error: { type: isTimeout ? 'TimeoutError' : (error && error.name) || 'Error', message: String(error && error.message || error).slice(0, 4096) },
      durationMs: Math.round(performance.now() - started),
      ...captured(),
      ...(isTimeout ? { timedOut: true } : {})
    }
  }
}

const server = net.createServer(socket => {
  let input = ''
  socket.on('data', chunk => {
    input += chunk.toString('utf8')
    const newline = input.indexOf('\n')
    if (newline < 0) return
    try {
      const request = JSON.parse(input.slice(0, newline))
      if (typeof request.code !== 'string' || !Number.isInteger(request.timeoutMs) || !Number.isInteger(request.maxOutputBytes)) {
        throw new Error('invalid cell request')
      }
      socket.end(JSON.stringify(execute(request)) + '\n')
    } catch (error) {
      socket.end(JSON.stringify({ ok: false, error: { type: 'ProtocolError', message: String(error && error.message || error) }, durationMs: 0, stdout: '', stderr: '' }) + '\n')
    }
  })
})

server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`;
const PYTHON_CLIENT = String.raw `
import socket
import sys

request = sys.stdin.buffer.readline()
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.connect("/tmp/swarm-execution.sock")
client.sendall(request)
response = b""
while not response.endswith(b"\n"):
    chunk = client.recv(65536)
    if not chunk:
        break
    response += chunk
sys.stdout.buffer.write(response)
`;
const PYTHON_READY = String.raw `
import socket

client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.connect("/tmp/swarm-execution.sock")
client.close()
`;
const NODE_CLIENT = String.raw `
const net = require('node:net')
let input = ''
process.stdin.on('data', chunk => { input += chunk.toString('utf8') })
process.stdin.on('end', () => {
  const socket = net.createConnection('/tmp/swarm-execution.sock')
  let response = ''
  socket.on('connect', () => socket.end(input))
  socket.on('data', chunk => { response += chunk.toString('utf8') })
  socket.on('end', () => process.stdout.write(response))
  socket.on('error', error => {
    process.stderr.write(String(error.message) + '\n')
    process.exitCode = 1
  })
})
`;
const NODE_READY = String.raw `
const net = require('node:net')
const socket = net.createConnection('/tmp/swarm-execution.sock')
socket.on('connect', () => socket.end(() => process.exit(0)))
socket.on('error', () => process.exit(1))
`;
const sleep = async (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));
const getScopeHash = (request) => createHash('sha256')
    .update(request.scope.projectId)
    .update('\0')
    .update(request.scope.ownerId)
    .digest('hex')
    .slice(0, 16);
const getContainerName = (request) => `${CONTAINER_NAME_PREFIX}${getScopeHash(request)}-${request.kernelId.replaceAll('-', '').slice(0, 16)}`;
const ValidateContainerName = (name) => {
    if (!new RegExp(`^${CONTAINER_NAME_PREFIX}[a-f0-9]{16}-[a-f0-9]{16}$`).test(name)) {
        throw new ExecutionError('INVALID_REQUEST', '拒绝操作非 Swarm execution kernel 容器');
    }
};
const getExecutionCommand = (language) => language === 'python'
    ? ['python3', '-c', PYTHON_CLIENT]
    : ['node', '-e', NODE_CLIENT];
const getReadinessCommand = (language) => language === 'python'
    ? ['python3', '-c', PYTHON_READY]
    : ['node', '-e', NODE_READY];
const getServerArgs = (language, image) => language === 'python'
    ? ['--entrypoint', 'python3', image, '-u', '-c', PYTHON_KERNEL_SERVER]
    : ['--entrypoint', 'node', image, '-e', NODE_KERNEL_SERVER];
const getErrorRecord = (value) => {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return { type: 'Error', message: 'invalid kernel error' };
    return {
        type: String(value.type ?? 'Error'),
        message: String(value.message ?? 'unknown error').slice(0, 4096)
    };
};
const parseIntResult = (stdout) => {
    const line = stdout.trim().split('\n').at(-1);
    if (!line)
        throw new ExecutionError('PROTOCOL_ERROR', 'kernel 没有返回执行结果');
    let decoded;
    try {
        decoded = JSON.parse(line);
    }
    catch {
        throw new ExecutionError('PROTOCOL_ERROR', 'kernel 返回了无效 JSON');
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
        throw new ExecutionError('PROTOCOL_ERROR', 'kernel 返回结构无效');
    }
    const result = decoded;
    if (typeof result.ok !== 'boolean' || typeof result.durationMs !== 'number') {
        throw new ExecutionError('PROTOCOL_ERROR', 'kernel 返回缺少 ok/durationMs');
    }
    const error = getErrorRecord(result.error);
    return {
        ok: result.ok,
        ...(result.value === undefined ? {} : { value: result.value }),
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
        ...(error === undefined ? {} : { error }),
        durationMs: result.durationMs,
        ...(result.timedOut === true ? { timedOut: true } : {})
    };
};
export class DockerSpawnCommandRunner {
    dockerPath;
    constructor(dockerPath = 'docker') {
        this.dockerPath = dockerPath;
    }
    async run(request) {
        return new Promise((resolve, reject) => {
            const child = spawn(this.dockerPath, request.args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: {
                    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
                    ...(process.env.DOCKER_HOST === undefined ? {} : { DOCKER_HOST: process.env.DOCKER_HOST }),
                    ...(process.env.DOCKER_CONTEXT === undefined ? {} : { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT })
                }
            });
            let stdout = '';
            let stderr = '';
            let isTimedOut = false;
            const timer = setTimeout(() => {
                isTimedOut = true;
                child.kill('SIGKILL');
            }, request.timeoutMs);
            timer.unref();
            child.stdout.on('data', chunk => {
                if (Buffer.byteLength(stdout) + chunk.length <= MAX_STDOUT_BYTES)
                    stdout += chunk.toString('utf8');
            });
            child.stderr.on('data', chunk => {
                if (Buffer.byteLength(stderr) + chunk.length <= MAX_STDERR_BYTES)
                    stderr += chunk.toString('utf8');
            });
            child.on('error', error => {
                clearTimeout(timer);
                reject(new ExecutionError('RUNTIME_UNAVAILABLE', `无法执行 Docker: ${error.message}`));
            });
            child.on('close', code => {
                clearTimeout(timer);
                resolve({ exitCode: code ?? 1, stdout, stderr, ...(isTimedOut ? { timedOut: true } : {}) });
            });
            child.stdin?.end(request.stdin);
        });
    }
}
export class DockerExecutionRuntime {
    kind = 'docker';
    options;
    constructor(options) {
        if (!options.image || /[\0\r\n]/.test(options.image))
            throw new ExecutionError('INVALID_REQUEST', 'Docker image 无效');
        this.options = {
            image: options.image,
            runner: options.runner ?? new DockerSpawnCommandRunner(options.dockerPath),
            dockerPath: options.dockerPath ?? 'docker',
            uid: options.uid ?? process.getuid?.() ?? 0,
            gid: options.gid ?? process.getgid?.() ?? 0,
            ...(options.proxySocketDirectory === undefined ? {} : { proxySocketDirectory: options.proxySocketDirectory })
        };
    }
    async start(request) {
        const containerName = getContainerName(request);
        const args = [
            'run',
            '--detach',
            '--name', containerName,
            '--label', `${EXECUTION_LABEL}=1`,
            '--label', `dev.dsh.swarm.projectHash=${getScopeHash(request)}`,
            '--network=none',
            '--read-only',
            '--cap-drop=ALL',
            `--pids-limit=${request.limits.pidsLimit}`,
            `--memory=${request.limits.memoryBytes}`,
            `--memory-swap=${request.limits.memoryBytes}`,
            `--cpus=${request.limits.cpuCount}`,
            `--user=${this.options.uid}:${this.options.gid}`,
            '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m',
            ...(this.options.proxySocketDirectory === undefined
                ? []
                : [`--mount=type=bind,src=${this.options.proxySocketDirectory},dst=/run/swarm-execution-proxy,readonly`]),
            ...getServerArgs(request.language, this.options.image)
        ];
        const handle = { containerName, language: request.language, ownerPid: process.pid };
        try {
            const result = await this.options.runner.run({ command: this.options.dockerPath, args, timeoutMs: 30_000 });
            if (result.timedOut === true)
                throw new ExecutionError('RUNTIME_UNAVAILABLE', 'Docker kernel 启动超时');
            if (result.exitCode !== 0) {
                throw new ExecutionError('RUNTIME_UNAVAILABLE', `Docker kernel 启动失败: ${result.stderr.trim().slice(0, 2048) || `exit ${result.exitCode}`}`);
            }
            await this.waitUntilReady(handle);
            return handle;
        }
        catch (error) {
            // docker run 的客户端超时不能证明启动失败，必须按预先登记的名字确认停止。
            await this.remove(handle);
            throw error;
        }
    }
    async waitUntilReady(handle) {
        let lastError = 'kernel socket 未就绪';
        for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
            const state = await this.inspect(handle);
            if (state !== 'running')
                throw new ExecutionError('RUNTIME_UNAVAILABLE', `kernel 启动后状态为 ${state}`);
            const result = await this.options.runner.run({
                command: this.options.dockerPath,
                args: ['exec', handle.containerName, ...getReadinessCommand(handle.language)],
                timeoutMs: 2_000
            });
            if (result.exitCode === 0 && result.timedOut !== true)
                return;
            lastError = result.stderr.trim().slice(0, 1024) || `readiness exit ${result.exitCode}`;
            await sleep(READINESS_INTERVAL_MS);
        }
        throw new ExecutionError('RUNTIME_UNAVAILABLE', `kernel socket 就绪超时: ${lastError}`);
    }
    async execute(handle, request) {
        ValidateContainerName(handle.containerName);
        try {
            const result = await this.options.runner.run({
                command: this.options.dockerPath,
                args: ['exec', '--interactive', handle.containerName, ...getExecutionCommand(handle.language)],
                timeoutMs: request.timeoutMs + 2_000,
                stdin: `${JSON.stringify({ code: request.code, timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes })}\n`
            });
            if (result.timedOut === true)
                throw new ExecutionError('EXECUTION_TIMEOUT', 'kernel cell 超过墙钟限制');
            if (result.exitCode !== 0) {
                throw new ExecutionError('PROTOCOL_ERROR', `kernel cell 通道失败: ${result.stderr.trim().slice(0, 2048) || `exit ${result.exitCode}`}`);
            }
            const parsed = parseIntResult(result.stdout);
            if (parsed.timedOut === true)
                throw new ExecutionError('EXECUTION_TIMEOUT', 'kernel cell 超过墙钟限制');
            return parsed;
        }
        catch (error) {
            // 杀掉 docker exec 只会关闭传输，容器内的子进程可能仍在写；隔离必须覆盖整个容器。
            await this.remove(handle);
            if (error instanceof ExecutionError)
                throw error;
            throw new ExecutionError('OUTCOME_UNKNOWN', 'Docker 执行通道中断，容器已确认停止');
        }
    }
    async inspect(handle) {
        ValidateContainerName(handle.containerName);
        const result = await this.options.runner.run({
            command: this.options.dockerPath,
            args: ['inspect', '--format', '{{.State.Running}}', handle.containerName],
            timeoutMs: 10_000
        });
        if (result.timedOut === true)
            throw new ExecutionError('OUTCOME_UNKNOWN', 'Docker inspect 超时，不能确认停止');
        if (result.exitCode !== 0) {
            if (/no such (object|container)/i.test(result.stderr))
                return 'missing';
            throw new ExecutionError('RUNTIME_UNAVAILABLE', `Docker inspect 失败: ${result.stderr.trim().slice(0, 2048)}`);
        }
        const running = result.stdout.trim();
        if (running === 'true')
            return 'running';
        if (running === 'false')
            return 'stopped';
        throw new ExecutionError('OUTCOME_UNKNOWN', 'Docker inspect 未返回明确的运行状态');
    }
    async remove(handle) {
        ValidateContainerName(handle.containerName);
        const inspect = await this.options.runner.run({
            command: this.options.dockerPath,
            args: ['inspect', '--format', `{{index .Config.Labels "${EXECUTION_LABEL}"}}`, handle.containerName],
            timeoutMs: 10_000
        });
        if (inspect.timedOut === true)
            throw new ExecutionError('OUTCOME_UNKNOWN', 'Docker 容器身份核对超时');
        if (inspect.exitCode !== 0) {
            if (/no such (object|container)/i.test(inspect.stderr))
                return;
            throw new ExecutionError('RUNTIME_UNAVAILABLE', `Docker 容器身份核对失败: ${inspect.stderr.trim().slice(0, 2048)}`);
        }
        if (inspect.stdout.trim() !== '1') {
            throw new ExecutionError('INVALID_REQUEST', '拒绝删除没有 Swarm execution 标签的容器');
        }
        let removalError = '';
        try {
            const removed = await this.options.runner.run({
                command: this.options.dockerPath,
                args: ['rm', '--force', handle.containerName],
                timeoutMs: 15_000
            });
            if (removed.exitCode !== 0 || removed.timedOut === true)
                removalError = removed.stderr.trim().slice(0, 2048) || 'Docker rm 失败或超时';
        }
        catch (error) {
            removalError = error instanceof Error ? error.message.slice(0, 2048) : 'Docker rm 传输失败';
        }
        // rm 返回成功也不作为停止证据，容量槽和取消回执都依赖后续独立的 inspect。
        const status = await this.inspect(handle);
        if (status !== 'stopped' && status !== 'missing') {
            throw new ExecutionError('OUTCOME_UNKNOWN', `执行 kernel 未确认停止${removalError ? `: ${removalError}` : ''}`);
        }
    }
}
//# sourceMappingURL=docker-runtime.js.map