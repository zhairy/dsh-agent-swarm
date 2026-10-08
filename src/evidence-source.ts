import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ObservedExternalSource } from './evidence-assessment.js'

export class EvidenceSourceError extends Error {
  constructor (readonly code: 'SOURCE_URL_REJECTED' | 'SOURCE_ADDRESS_REJECTED' | 'SOURCE_REDIRECT_REJECTED' | 'SOURCE_UNAVAILABLE' | 'SOURCE_TOO_LARGE' | 'SOURCE_CONTENT_UNSUPPORTED', message: string) { super(message); this.name = 'EvidenceSourceError' }
}
export interface EvidenceSourcePolicy {
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  now?: () => number
  /** Test/host DNS adapter; every returned address is still subjected to the public-address policy. */
  resolveAddresses?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
}

/** Conservative globally routable destination policy, including IPv4-in-IPv6/tunnel exclusions. */
export const isPublicEvidenceAddress = (address: string): boolean => {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    if (a === undefined || b === undefined || c === undefined || a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113) || address === '168.63.129.16') return false
    return true
  }
  if (isIP(address) === 6) {
    const parts = address.toLowerCase().split(':')
    const first = Number.parseInt(parts[0] || '0', 16)
    const second = Number.parseInt(parts[1] || '0', 16)
    if (first < 0x2000 || first > 0x3fff || first === 0x2002 || first === 0x3fff || (first === 0x2001 && (second === 0 || second === 2 || second === 0xdb8 || (second >= 0x10 && second <= 0x2f)))) return false
    return true
  }
  return false
}

export const validateEvidenceSourceUrl = (input: string): URL => {
  let url: URL
  try { url = new URL(input) } catch { throw new EvidenceSourceError('SOURCE_URL_REJECTED', 'Evidence source URL is invalid') }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const credentialQuery = [...url.searchParams.keys()].some((key) => /(?:api[-_]?key|access[-_]?token|token|password|secret|authorization|signature|credential)/i.test(key))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || credentialQuery || !host || isIP(host.replace(/^\[|\]$/g, '')) !== 0 || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host) || host === 'metadata.google.internal' || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))) throw new EvidenceSourceError('SOURCE_URL_REJECTED', 'Only public HTTP(S) domain sources without credentials or custom ports are supported')
  url.hostname = host
  url.hash = ''
  return url
}

/** Parse text without executing scripts, fetching subresources, cookies or external resource loaders. */
export const extractEvidenceSourceText = (body: string, contentType: string): string => {
  if (/^(?:text\/plain|text\/markdown|application\/json)(?:;|$)/i.test(contentType)) return body.trim()
  if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) throw new EvidenceSourceError('SOURCE_CONTENT_UNSUPPORTED', 'Evidence source is not supported text/HTML')
  // A bounded linear text scan avoids building an untrusted DOM or recursively walking deeply nested markup.
  const lower = body.toLowerCase()
  const endOfTag = (start: number): number => {
    let quote = ''
    for (let index = start; index < body.length; index++) {
      const char = body[index]
      if (quote) { if (char === quote) quote = '' }
      else if (char === '"' || char === "'") quote = char
      else if (char === '>') return index
    }
    return -1
  }
  const chunks: string[] = []
  let cursor = 0
  let skipped: string | undefined
  while (cursor < body.length) {
    if (skipped) {
      let close = lower.indexOf('</' + skipped, cursor)
      while (close >= 0 && !/[\s/>]/.test(lower[close + skipped.length + 2] ?? '')) close = lower.indexOf('</' + skipped, close + 2)
      if (close < 0) break
      const end = endOfTag(close + 2)
      if (end < 0) break
      cursor = end + 1; skipped = undefined
      continue
    }
    const start = body.indexOf('<', cursor)
    if (start < 0) { chunks.push(body.slice(cursor)); break }
    chunks.push(body.slice(cursor, start))
    if (body.startsWith('<!--', start)) { const end = body.indexOf('-->', start + 4); if (end < 0) break; cursor = end + 3; continue }
    const end = endOfTag(start + 1)
    if (end < 0) break
    const tag = body.slice(start + 1, end)
    const name = /^\s*\/?\s*([a-z][a-z0-9:-]*)/i.exec(tag)?.[1]?.toLowerCase()
    // HTML script/style elements are not void even if an untrusted source writes <script/>.
    if (name && ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe'].includes(name) && !/^\s*\//.test(tag)) skipped = name
    chunks.push(' '); cursor = end + 1
  }
  return chunks.join('').replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[0-9a-f]{1,6});/gi, (entity) => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' }
    if (named[entity.toLowerCase()] !== undefined) return named[entity.toLowerCase()]!
    const number = entity.toLowerCase().startsWith('&#x') ? Number.parseInt(entity.slice(3, -1), 16) : Number.parseInt(entity.slice(2, -1), 10)
    return number > 0 && number <= 0x10ffff && (number < 0xd800 || number > 0xdfff) ? String.fromCodePoint(number) : '\ufffd'
  }).replace(/\s+/g, ' ').trim()
}

/** DNS is validated and pinned for each redirect hop; environment proxy agents and credentials are not inherited. */
export const createPublicEvidenceSourceResolver = (policy: EvidenceSourcePolicy = {}): ((input: string, signal?: AbortSignal) => Promise<ObservedExternalSource>) => {
  const timeoutMs = policy.timeoutMs ?? 5000
  const maxBytes = policy.maxBytes ?? 1024 * 1024
  const maxRedirects = policy.maxRedirects ?? 3
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) throw new EvidenceSourceError('SOURCE_URL_REJECTED', 'Invalid evidence retrieval policy')
  const addressesFor = policy.resolveAddresses ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }))
  return async (input, signal) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, timeoutMs)
    const deadline = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new EvidenceSourceError('SOURCE_UNAVAILABLE', 'Evidence source request cancelled or timed out')), { once: true }))
    try {
      if (controller.signal.aborted) throw new EvidenceSourceError('SOURCE_UNAVAILABLE', 'Evidence source request cancelled')
      let url = validateEvidenceSourceUrl(input)
      for (let redirect = 0; ; redirect++) {
        const addresses = await Promise.race([addressesFor(url.hostname), deadline])
        if (addresses.length === 0 || addresses.some((entry) => !isPublicEvidenceAddress(entry.address) || isIP(entry.address) !== entry.family)) throw new EvidenceSourceError('SOURCE_ADDRESS_REJECTED', 'Evidence source DNS resolved to a non-public or ambiguous destination')
        const pinned = addresses[0]!
        const result = await Promise.race([new Promise<{ location?: string; body?: string; contentType?: string }>((resolveResult, reject) => {
          const options = { agent: false as const, signal: controller.signal, family: pinned.family, autoSelectFamily: false,
            lookup: (_hostname: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => callback(null, pinned.address, pinned.family),
            headers: { Accept: 'text/html,text/plain,application/json;q=0.8', 'Accept-Encoding': 'identity', 'User-Agent': 'dsh-agent-swarm-evidence/2.3' } }
          const request = url.protocol === 'https:' ? httpsRequest(url, { ...options, servername: url.hostname }) : httpRequest(url, options)
          request.once('error', () => reject(new EvidenceSourceError('SOURCE_UNAVAILABLE', 'Evidence source transport failed')))
          request.once('response', (response) => {
            const canonicalAddress = (address: string | undefined): string | undefined => {
              if (!address) return undefined
              const plain = address.replace(/^::ffff:/i, '')
              return isIP(plain) === 6 ? new URL('http://[' + plain + ']').hostname : plain
            }
            if (canonicalAddress(response.socket.remoteAddress) !== canonicalAddress(pinned.address)) { response.destroy(); reject(new EvidenceSourceError('SOURCE_ADDRESS_REJECTED', 'Evidence source connection did not match its pinned address')); return }
            const status = response.statusCode ?? 0
            if ([301, 302, 303, 307, 308].includes(status)) { const location = response.headers.location ?? ''; response.destroy(); resolveResult({ location }); return }
            if (status < 200 || status >= 300) { response.destroy(); reject(new EvidenceSourceError('SOURCE_UNAVAILABLE', 'Evidence source returned an unsuccessful status')); return }
            const encoding = response.headers['content-encoding']
            if (encoding && encoding !== 'identity') { response.destroy(); reject(new EvidenceSourceError('SOURCE_CONTENT_UNSUPPORTED', 'Compressed evidence responses are not accepted')); return }
            const contentType = String(response.headers['content-type'] ?? '')
            const chunks: Buffer[] = []; let bytes = 0
            response.on('data', (chunk: Buffer | string) => {
              const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
              bytes += buffer.length
              if (bytes > maxBytes) { response.destroy(); reject(new EvidenceSourceError('SOURCE_TOO_LARGE', 'Evidence source exceeds the capture byte limit')); return }
              chunks.push(buffer)
            })
            response.once('error', () => reject(new EvidenceSourceError('SOURCE_UNAVAILABLE', 'Evidence source body was interrupted')))
            response.once('end', () => resolveResult({ body: Buffer.concat(chunks).toString('utf8'), contentType }))
          })
          request.end()
        }), deadline])
        if (result.location !== undefined) {
          if (redirect >= maxRedirects || result.location === '') throw new EvidenceSourceError('SOURCE_REDIRECT_REJECTED', 'Evidence redirect limit or target is invalid')
          const next = validateEvidenceSourceUrl(new URL(result.location, url).href)
          if (url.protocol === 'https:' && next.protocol !== 'https:') throw new EvidenceSourceError('SOURCE_REDIRECT_REJECTED', 'Evidence HTTPS source cannot downgrade on redirect')
          url = next
          continue
        }
        const body = extractEvidenceSourceText(result.body ?? '', result.contentType ?? '')
        if (!body) throw new EvidenceSourceError('SOURCE_CONTENT_UNSUPPORTED', 'Evidence source has no captured text')
        return { text: body, finalUrl: url.href, retrievedAt: (policy.now ?? Date.now)() }
      }
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }
}
