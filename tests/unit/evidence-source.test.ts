import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createPublicEvidenceSourceResolver, extractEvidenceSourceText, isPublicEvidenceAddress, validateEvidenceSourceUrl } from '../../src/evidence-source.js'

const requestMock = vi.hoisted(() => vi.fn())
vi.mock('node:https', () => ({ request: requestMock }))
vi.mock('node:http', () => ({ request: requestMock }))

interface ResponseSpec { status?: number; headers?: Record<string, string>; chunks?: string[]; address?: string; hang?: boolean }
const respond = (...specs: ResponseSpec[]) => {
  requestMock.mockImplementation((_url: URL, options: { signal: AbortSignal }) => {
    const spec = specs.shift() ?? {}
    const request = new EventEmitter() as EventEmitter & { end: () => void }
    const response = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; socket: { remoteAddress: string }; destroy: () => void }
    let destroyed = false
    response.statusCode = spec.status ?? 200
    response.headers = spec.headers ?? { 'content-type': 'text/html; charset=utf-8' }
    response.socket = { remoteAddress: spec.address ?? '93.184.215.14' }
    response.destroy = () => { destroyed = true }
    request.end = () => { if (!spec.hang) queueMicrotask(() => { request.emit('response', response); if (!destroyed) { for (const chunk of spec.chunks ?? ['<p>Original documented sum(values)</p>']) response.emit('data', Buffer.from(chunk)); response.emit('end') } }) }
    options.signal.addEventListener('abort', () => request.emit('error', new Error('aborted')), { once: true })
    return request
  })
}
const publicDns = async () => [{ address: '93.184.215.14', family: 4 }]
beforeEach(() => { requestMock.mockReset() })

describe('public evidence source capture', () => {
  it.each(['127.0.0.1', '0.0.0.0', '10.0.0.1', '172.16.2.3', '192.168.0.1', '100.100.100.200', '169.254.169.254', '168.63.129.16', '198.18.0.1', '192.0.2.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '64:ff9b::a00:1', '2001:db8::1', '2002:a00:1::', '2001::1', '3fff::1'])('rejects internal, metadata, reserved or tunnel address %s', (address) => {
    expect(isPublicEvidenceAddress(address)).toBe(false)
  })

  it('accepts globally routable IPv4 and IPv6 addresses', () => {
    expect(isPublicEvidenceAddress('93.184.215.14')).toBe(true)
    expect(isPublicEvidenceAddress('2606:4700:4700::1111')).toBe(true)
  })

  it.each(['file:///etc/passwd', 'https://localhost/a', 'https://metadata.google.internal/', 'https://127.1/', 'http://2130706433/', 'https://[::1]/', 'https://docs.example.com:8443/', 'https://user:password@docs.example.com/', 'https://docs.example.com/?access_token=secret', 'https://something.local/a'])('rejects dangerous or credential-bearing URL %s', (url) => {
    expect(() => validateEvidenceSourceUrl(url)).toThrow()
  })

  it('retrieves original public text through one checked DNS result pinned in the transport', async () => {
    respond()
    const resolveAddresses = vi.fn(publicDns)
    const captured = await createPublicEvidenceSourceResolver({ resolveAddresses, now: () => 1234 })('https://docs.example.org/api#sum')
    expect(captured).toEqual({ text: 'Original documented sum(values)', finalUrl: 'https://docs.example.org/api', retrievedAt: 1234 })
    expect(resolveAddresses).toHaveBeenCalledTimes(1)
    const [url, options] = requestMock.mock.calls[0] as [URL, { agent: boolean; servername: string; headers: Record<string, string>; lookup: (host: string, config: unknown, callback: (error: unknown, ip: string, family: number) => void) => void }]
    expect(url.hostname).toBe('docs.example.org')
    expect(options).toMatchObject({ agent: false, servername: 'docs.example.org' })
    const callback = vi.fn()
    options.lookup('docs.example.org', {}, callback)
    expect(callback).toHaveBeenCalledWith(null, '93.184.215.14', 4)
    expect(Object.keys(options.headers).some((key) => /authorization|cookie/i.test(key))).toBe(false)
  })

  it('rejects mixed public/private DNS responses before sending a request', async () => {
    const resolver = createPublicEvidenceSourceResolver({ resolveAddresses: async () => [...await publicDns(), { address: '10.0.0.1', family: 4 }] })
    await expect(resolver('https://docs.example.org/')).rejects.toMatchObject({ code: 'SOURCE_ADDRESS_REJECTED' })
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('checks every redirect destination and rejects private DNS, downgrade and excessive redirects', async () => {
    respond({ status: 302, headers: { location: 'https://private.example.org/' } })
    const dns = vi.fn(async (host: string) => host === 'private.example.org' ? [{ address: '169.254.169.254', family: 4 }] : publicDns())
    await expect(createPublicEvidenceSourceResolver({ resolveAddresses: dns })('https://docs.example.org/')).rejects.toMatchObject({ code: 'SOURCE_ADDRESS_REJECTED' })
    expect(requestMock).toHaveBeenCalledTimes(1)
    respond({ status: 302, headers: { location: 'http://docs.example.org/' } })
    await expect(createPublicEvidenceSourceResolver({ resolveAddresses: publicDns })('https://docs.example.org/')).rejects.toMatchObject({ code: 'SOURCE_REDIRECT_REJECTED' })
    respond({ status: 302, headers: { location: '/again' } })
    await expect(createPublicEvidenceSourceResolver({ resolveAddresses: publicDns, maxRedirects: 0 })('https://docs.example.org/')).rejects.toMatchObject({ code: 'SOURCE_REDIRECT_REJECTED' })
  })

  it('rejects changed transport addresses, compressed bodies and responses beyond byte limits', async () => {
    for (const [spec, code] of [
      [{ address: '127.0.0.1' }, 'SOURCE_ADDRESS_REJECTED'],
      [{ headers: { 'content-encoding': 'gzip', 'content-type': 'text/html' } }, 'SOURCE_CONTENT_UNSUPPORTED'],
      [{ chunks: ['one', 'two', 'three'] }, 'SOURCE_TOO_LARGE']
    ] as const) {
      respond(spec as ResponseSpec)
      await expect(createPublicEvidenceSourceResolver({ resolveAddresses: publicDns, maxBytes: 5 })('https://docs.example.org/')).rejects.toMatchObject({ code })
    }
  })

  it('bounds both pending DNS and hanging requests, and honors caller cancellation', async () => {
    await expect(createPublicEvidenceSourceResolver({ timeoutMs: 10, resolveAddresses: async () => new Promise(() => {}) })('https://docs.example.org/')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
    respond({ hang: true })
    await expect(createPublicEvidenceSourceResolver({ timeoutMs: 10, resolveAddresses: publicDns })('https://docs.example.org/')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
    const controller = new AbortController(); controller.abort()
    await expect(createPublicEvidenceSourceResolver({ resolveAddresses: publicDns })('https://docs.example.org/', controller.signal)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
  })

  it('extracts bounded text without script/style contents, false end tags or quoted attribute leakage', () => {
    expect(extractEvidenceSourceText('<p title="hidden > attribute">A &amp; &#x3b2;</p><script/>secret</scriptx>still secret</script><style>x</style><!-- secret --><p>B</p>', 'text/html')).toBe('A & β B')
    expect(extractEvidenceSourceText('<p>visible</p><script>unterminated secret', 'text/html')).toBe('visible')
    expect(extractEvidenceSourceText('  plain original  ', 'text/plain')).toBe('plain original')
    expect(() => extractEvidenceSourceText('pdf', 'application/pdf')).toThrow()
  })
})
