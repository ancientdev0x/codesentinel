import { runAstChecks } from '../../review/ast/checks'
import { extractAllFragments } from '../../review/ast/fragments'
import type { ReviewStateType, ReviewStateUpdate, StageError } from '../state'

export interface ExtractAstDeps {
  extractAllFragments?: typeof extractAllFragments
  runAstChecks?: typeof runAstChecks
}

export const extractAst = (deps: ExtractAstDeps = {}) => {
  const doExtractFragments = deps.extractAllFragments ?? extractAllFragments
  const doRunAstChecks = deps.runAstChecks ?? runAstChecks

  return async (state: ReviewStateType): Promise<ReviewStateUpdate> => {
    const attempts = {
      ...state.attempts,
      extract_ast: (state.attempts?.extract_ast ?? 0) + 1,
    }

    try {
      if (!state.cfg.astChecks) {
        return {
          fragments: [],
          attempts,
        }
      }

      const fragments = doExtractFragments(state.files)
      const astFindings = doRunAstChecks(state.files, state.cfg?.workspace)

      return {
        fragments,
        staticFindings: astFindings,
        attempts,
      }
    } catch (err) {
      const error: StageError = {
        stage: 'extract_ast',
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
