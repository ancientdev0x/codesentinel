import { interrupt } from '@langchain/langgraph'
import {
  buildPatches,
  writePatchFiles,
  applyApproved,
  runWithStdin,
  type Patch,
} from '../../review/patch'
import type { Finding } from '../../review/findings'
import type { ReviewStateType, ReviewStateUpdate } from '../state'

export interface HumanReviewDeps {
  buildPatches?: (workspace: string, findings: Finding[]) => Promise<Patch[]>
  writePatchFiles?: (workspace: string, patches: Patch[]) => Promise<string[]>
  applyApproved?: (
    workspace: string,
    patches: Patch[],
    decisions: Record<string, 'approve' | 'reject' | { edit: string }>
  ) => Promise<string[]>
  runWithStdin?: (
    cmd: string,
    args: string[],
    input: string,
    cwd?: string
  ) => Promise<{ stdout: string; stderr: string }>
}

export const humanReview = (deps?: HumanReviewDeps) => {
  const doBuildPatches = deps?.buildPatches ?? buildPatches
  const doWritePatchFiles = deps?.writePatchFiles ?? writePatchFiles
  const doApplyApproved = deps?.applyApproved ?? applyApproved
  const doRunWithStdin = deps?.runWithStdin ?? runWithStdin

  return async (state: ReviewStateType): Promise<ReviewStateUpdate> => {
    const attempts = {
      ...state.attempts,
      human_review: (state.attempts?.human_review ?? 0) + 1,
    }

    const workspace = state.cfg?.workspace || process.cwd()

    // Collect confirmed findings that have a fix attached
    const candidateFindings = [...state.llmFindings, ...state.staticFindings].filter(
      (f) => f.status === 'confirmed' && f.fix
    )

    const patches = await doBuildPatches(workspace, candidateFindings)

    if (patches.length > 0) {
      try {
        await doWritePatchFiles(workspace, patches)
      } catch (err: unknown) {
        console.warn(
          '[CodeSentinel] Failed to write patch files to disk:',
          err instanceof Error ? err.message : String(err)
        )
      }
    }

    if (state.cfg?.hitlMode === 'interactive' && patches.length > 0) {
      let decisions = interrupt({
        type: 'patch_approval',
        patches: patches.map((p) => ({
          id: p.id,
          findingId: p.findingId,
          file: p.file,
          diff: p.diff,
          stats: p.stats,
        })),
      }) as Record<string, 'approve' | 'reject' | { edit: string }>

      // Re-check edited patches with git apply --check (loop at most 2 times)
      for (let attempt = 0; attempt < 2; attempt++) {
        const badEditPatchIds: string[] = []

        if (decisions && typeof decisions === 'object') {
          for (const [id, decision] of Object.entries(decisions)) {
            if (typeof decision === 'object' && decision.edit) {
              try {
                await doRunWithStdin(
                  'git',
                  ['-C', workspace, 'apply', '--check', '-'],
                  decision.edit
                )
              } catch {
                badEditPatchIds.push(id)
              }
            }
          }
        }

        if (badEditPatchIds.length === 0) {
          break
        }

        decisions = interrupt({
          type: 'patch_approval',
          error: `Edited patch failed git apply --check for: ${badEditPatchIds.join(', ')}. Please re-edit or reject.`,
          patches: patches.filter((p) => badEditPatchIds.includes(p.id)),
        }) as Record<string, 'approve' | 'reject' | { edit: string }>
      }

      const applied = await doApplyApproved(workspace, patches, decisions || {})

      return {
        attempts,
        patches,
        approvals: decisions || {},
        applied,
      }
    }

    return {
      attempts,
      patches,
    }
  }
}
