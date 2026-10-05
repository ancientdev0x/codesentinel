import { execSync } from 'node:child_process'

export function viewFile(fileName: string): string {
  return execSync('cat ' + fileName, { encoding: 'utf8' })
}
