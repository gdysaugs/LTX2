type RekognitionEnv = {
  AWS_ACCESS_KEY_ID?: string
  AWS_SECRET_ACCESS_KEY?: string
  AWS_REGION?: string
}

// Rekognition is intentionally disabled for this project.
// Keep the same function signature to avoid touching caller code.
export const isUnderageImage = async (_base64: string, _env: RekognitionEnv) => false
