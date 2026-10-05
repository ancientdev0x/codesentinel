import { execFileSync } from 'node:child_process'

export function viewFile(fileName: string): string {
  return execFileSync('cat', [fileName], { encoding: 'utf8' })
}
