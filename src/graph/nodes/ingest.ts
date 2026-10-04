import type { ReviewConfig } from '../../review/config'
import { applyPayloadToEnv } from '../../review/config'
import { type ReviewFileWithDiff, getChangedFiles } from '../../review/diff'
import { materializePr, parsePrUrl } from '../../review/source'
import { filterFiles } from '../../review/utils/filterFiles'
import type { ReviewStateType, ReviewStateUpdate, StageError } from '../state'

export interface IngestDeps {
  materializePr?: typeof materializePr
  parsePrUrl?: typeof parsePrUrl
  getChangedFiles?: typeof getChangedFiles
  filterFiles?: typeof filterFiles
  applyPayloadToEnv?: typeof applyPayloadToEnv
  onCleanupPr?: (cleanup: () => Promise<void>) => void
}

export const ingest = (deps: IngestDeps = {}) => {
  const doMaterializePr = deps.materializePr ?? materializePr
  const doParsePrUrl = deps.parsePrUrl ?? parsePrUrl
  const doGetChangedFiles = deps.getChangedFiles ?? getChangedFiles
  const doFilterFiles = deps.filterFiles ?? filterFiles
  const doApplyPayloadToEnv = deps.applyPayloadToEnv ?? applyPayloadToEnv

  return async (state: ReviewStateType): Promise<ReviewStateUpdate> => {
    const attempts = {
      ...state.attempts,
      ingest: (state.attempts?.ingest ?? 0) + 1,
    }

    try {
      const cfg: ReviewConfig = { ...state.cfg }

      if (cfg.prUrl) {
        const prRef = doParsePrUrl(cfg.prUrl)
        const token = process.env.GITHUB_TOKEN
        const materialized = await doMaterializePr(prRef, token)
        if (deps.onCleanupPr) {
          deps.onCleanupPr(materialized.cleanup)
        }
        cfg.workspace = materialized.workspace
        cfg.baseSha = materialized.baseSha
        cfg.headSha = materialized.headSha
        if (token && process.env.CodeSentinel_INPUT_PLATFORM !== 'local') {
          cfg.github = {
            owner: prRef.owner,
            repo: prRef.repo,
            prNumber: prRef.number,
            token,
          }
          cfg.platform = 'github'
        }
      }

      doApplyPayloadToEnv(cfg, process.env)

      const { files } = await doGetChangedFiles(cfg)
      let filtered = doFilterFiles(
        files,
        cfg.ignore,
        cfg.workspace
      ) as ReviewFileWithDiff[]

      if (filtered.length > 300) {
        console.warn(
          `[CodeSentinel] PR contains ${filtered.length} changed files; capping review at 300 files.`
        )
        filtered = filtered.slice(0, 300)
      }

      return {
        cfg,
        files: filtered,
        attempts,
      }
    } catch (err) {
      const error: StageError = {
        stage: 'ingest',
        kind: 'crash',
        detail: err instanceof Error ? err.message : String(err),
      }
      return {
        errors: [error],
        attempts,
      }
    }
  }
}
