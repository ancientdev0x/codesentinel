import { execFile } from 'node:child_process'

export function listDir(dir: string, cb: (err: Error | null, stdout: string) => void) {
  execFile('ls', [dir], cb)
}
