type RekognitionEnv = {
  AWS_ACCESS_KEY_ID?: string
  AWS_SECRET_ACCESS_KEY?: string
  AWS_REGION?: string
}

const encoder = new TextEncoder()

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

const sha256Hex = async (value: string) => {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return toHex(hash)
}

const hmac = async (key: ArrayBuffer, value: string) => {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value))
}

const deriveSigningKey = async (secret: string, date: string, region: string, service: string) => {
  const kDate = await hmac(encoder.encode(`AWS4${secret}`), date)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, service)
  return hmac(kService, 'aws4_request')
}

const buildSignedHeaders = async (
  url: URL,
  body: string,
  env: RekognitionEnv,
  target: string,
) => {
  const accessKeyId = env.AWS_ACCESS_KEY_ID
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY
  const region = env.AWS_REGION
  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error('AWS credentials are not configured.')
  }
  const service = 'rekognition'
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = await sha256Hex(body)

  const headers: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.1',
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-target': target,
    'x-amz-content-sha256': payloadHash,
  }

  const sortedHeaderKeys = Object.keys(headers).sort()
  const canonicalHeaders = sortedHeaderKeys.map((key) => `${key}:${headers[key].trim()}`).join('\n') + '\n'
  const signedHeaders = sortedHeaderKeys.join(';')

  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const canonicalRequestHash = await sha256Hex(canonicalRequest)
  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${canonicalRequestHash}`

  const signingKey = await deriveSigningKey(secretAccessKey, dateStamp, region, service)
  const signature = toHex(await hmac(signingKey, stringToSign))

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    'Content-Type': headers['content-type'],
    'X-Amz-Date': headers['x-amz-date'],
    'X-Amz-Target': headers['x-amz-target'],
    'X-Amz-Content-Sha256': headers['x-amz-content-sha256'],
    Authorization: authorization,
  }
}

export const isUnderageImage = async (base64: string, env: RekognitionEnv) => {
  const region = env.AWS_REGION
  if (!region) {
    throw new Error('AWS_REGION is not configured.')
  }
  const url = new URL(`https://rekognition.${region}.amazonaws.com/`)
  const payload = JSON.stringify({
    Image: { Bytes: base64 },
    Attributes: ['ALL'],
  })
  const headers = await buildSignedHeaders(url, payload, env, 'RekognitionService.DetectFaces')
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body: payload,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Rekognition error: ${response.status} ${text}`)
  }
  const data = await response.json().catch(() => null)
  const faces = Array.isArray(data?.FaceDetails) ? data.FaceDetails : []
  return faces.some((face: any) => Number(face?.AgeRange?.High) < 13)
}
