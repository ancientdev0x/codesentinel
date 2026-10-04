import { exec } from 'node:child_process'

export function listDir(
  req: { query: { dir: string } },
  cb: (err: Error | null, stdout: string) => void
) {
  exec(`ls ${req.query.dir}`, cb)
}
