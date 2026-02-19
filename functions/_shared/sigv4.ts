const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

const toUtf8 = (text: string) => new TextEncoder().encode(text)

const hmacSha256 = async (key: ArrayBuffer, data: string) => {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', cryptoKey, toUtf8(data))
}

const sha256Hex = async (data: string) => {
  const digest = await crypto.subtle.digest('SHA-256', toUtf8(data))
  return toHex(digest)
}

const isoAmzDate = (date = new Date()) => date.toISOString().replace(/[:-]|\.\d{3}/g, '')

const yyyymmdd = (amzDate: string) => amzDate.slice(0, 8)

const encodePath = (path: string) =>
  path
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join('/')

const encodeQueryRFC3986 = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

const canonicalQuery = (params: Record<string, string>) =>
  Object.keys(params)
    .sort()
    .map((key) => `${encodeQueryRFC3986(key)}=${encodeQueryRFC3986(params[key] || '')}`)
    .join('&')

export type PresignConfig = {
  method: 'PUT' | 'GET'
  host: string
  canonicalUri: string
  accessKeyId: string
  secretAccessKey: string
  region?: string
  service?: string
  expiresSeconds: number
  additionalSignedHeaders?: Record<string, string>
}

export const presignUrl = async (config: PresignConfig) => {
  const service = config.service || 's3'
  const region = config.region || 'auto'
  const amzDate = isoAmzDate()
  const date = yyyymmdd(amzDate)

  const scope = `${date}/${region}/${service}/aws4_request`
  const algorithm = 'AWS4-HMAC-SHA256'
  const signedHeaders = ['host', ...Object.keys(config.additionalSignedHeaders || {})]
    .map((name) => name.toLowerCase())
    .sort()
  const credential = `${config.accessKeyId}/${scope}`

  const params: Record<string, string> = {
    'X-Amz-Algorithm': algorithm,
    'X-Amz-Credential': credential,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(config.expiresSeconds),
    'X-Amz-SignedHeaders': signedHeaders.join(';'),
  }

  const canonicalRequest = [
    config.method,
    encodePath(config.canonicalUri),
    canonicalQuery(params),
    signedHeaders
      .map((header) => {
        if (header === 'host') return `host:${config.host}\n`
        const value = (config.additionalSignedHeaders || {})[header] || ''
        return `${header}:${String(value).trim()}\n`
      })
      .join(''),
    signedHeaders.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  const stringToSign = [algorithm, amzDate, scope, await sha256Hex(canonicalRequest)].join('\n')

  const kDate = await hmacSha256(toUtf8(`AWS4${config.secretAccessKey}`).buffer, date)
  const kRegion = await hmacSha256(kDate, region)
  const kService = await hmacSha256(kRegion, service)
  const kSigning = await hmacSha256(kService, 'aws4_request')
  const signature = toHex(await hmacSha256(kSigning, stringToSign))

  const query = `${canonicalQuery(params)}&X-Amz-Signature=${signature}`
  const url = `https://${config.host}${encodePath(config.canonicalUri)}?${query}`
  return { url, amzDate, scope, signedHeaders }
}
