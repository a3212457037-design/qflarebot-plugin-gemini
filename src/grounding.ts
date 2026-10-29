function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function hideKey(text: string, apiKey: string): string {
  for (const key of new Set([apiKey, encodeURIComponent(apiKey)])) {
    if (key) text = text.split(key).join('[密钥已隐藏]')
  }
  return text
}

// 正文已经过现有长度限制；只在剩余空间内追加真实来源，不截断链接或挤掉正文。
export function appendSources(answer: string, metadata: unknown, maxChars: number, apiKey: string): string {
  const chunks = record(metadata).groundingChunks
  if (!Array.isArray(chunks)) return answer
  const encoder = new TextEncoder()
  const seen = new Set<string>()
  let result = answer
  let count = 0
  for (const chunk of chunks) {
    if (count === 2) break
    const web = record(record(chunk).web)
    if (typeof web.uri !== 'string' || /[\u0000-\u0020\u007f]/u.test(web.uri)) continue
    let url: URL
    try { url = new URL(web.uri) } catch { continue }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) continue
    // URL 不做密钥替换：含 Key 的链接直接丢弃，避免展示损坏链接或泄露凭据。
    let decoded = web.uri
    try { decoded = decodeURIComponent(web.uri) } catch { /* 保留原值供检查 */ }
    if (hideKey(web.uri, apiKey) !== web.uri || hideKey(decoded, apiKey) !== decoded) continue
    url.hash = ''
    const href = url.href
    if (seen.has(href)) continue
    const title = hideKey(typeof web.title === 'string' && web.title.trim() ? web.title : url.hostname, apiKey)
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim()
    const prefix = count ? '\n' : '\n来源：\n'
    const base = result + prefix + ' ' + href
    const availableChars = maxChars - Array.from(base).length
    const availableBytes = 1500 - encoder.encode(base).byteLength
    let label = ''
    let bytes = 0
    for (const ch of Array.from(title).slice(0, Math.max(0, Math.min(24, availableChars)))) {
      const size = encoder.encode(ch).byteLength
      if (bytes + size > availableBytes) break
      label += ch
      bytes += size
    }
    if (!label) continue
    result += prefix + label + ' ' + href
    seen.add(href)
    count++
  }
  return result
}
