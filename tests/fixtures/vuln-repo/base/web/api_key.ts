export function getApiKey(): string {
  return process.env.API_KEY || ''
}
