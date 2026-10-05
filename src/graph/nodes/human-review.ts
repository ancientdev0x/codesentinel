import { interrupt } from '@langchain/langgraph'
import {
  buildPatches,
  writePatchFiles,
  applyApproved,
  runWithStdin,
  type Patch,
} from '../../review/patch'
import type { Finding } from '../../review/findings'
import { getRejectedIds } from '../../review/patch-commands'
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
  promptTerminalDecisions?: (
    workspace: string,
    patches: Patch[]
  ) => Promise<Record<string, 'approve' | 'reject' | { edit: string }>>
}

const defaultPromptTerminalDecisions = async (
  _workspace: string,
  patches: Patch[]
): Promise<Record<string, 'approve' | 'reject' | { edit: string }>> => {
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const decisions: Record<string, 'approve' | 'reject' | { edit: string }> = {}
  try {
    for (const patch of patches) {
      process.stdout.write(
        `\nPatch ${patch.id} (${patch.file}) [+${patch.stats?.added ?? 0} -${patch.stats?.removed ?? 0}]:\n${patch.diff}\n`
      )
      let answered = false
      let attempts = 0
      while (!answered && attempts < 3) {
        attempts++
        const answer = (await rl.question('\n[a]pply / [r]eject / [e]dit / [q]uit: '))
          .trim()
          .toLowerCase()
        if (answer === 'a' || answer === 'apply') {
          decisions[patch.id] = 'approve'
          answered = true
        } else if (answer === 'r' || answer === 'reject') {
          decisions[patch.id] = 'reject'
          answered = true
        } else if (answer === 'q' || answer === 'quit') {
          answered = true
        } else if (!answer && !process.stdin.isTTY) {
          // If non-interactive piped input is exhausted, break to avoid hanging
          break
        }
      }
    }
  } finally {
    rl.close()
  }
  return decisions
}

export const humanReview = (deps?: HumanReviewDeps) => {
  const doBuildPatches = deps?.buildPatches ?? buildPatches
  const doWritePatchFiles = deps?.writePatchFiles ?? writePatchFiles
  const doApplyApproved = deps?.applyApproved ?? applyApproved
  const doRunWithStdin = deps?.runWithStdin ?? runWithStdin
  const doPromptTerminal = deps?.promptTerminalDecisions ?? defaultPromptTerminalDecisions

  return async (state: ReviewStateType): Promise<ReviewStateUpdate> => {
    const attempts = {
      ...state.attempts,
      human_review: (state.attempts?.human_review ?? 0) + 1,
    }

    const workspace = state.cfg?.workspace || process.cwd()
    const rejectedIds = workspace ? await getRejectedIds(workspace) : new Set<string>()

    // Collect confirmed findings that have a fix attached (skipping rejected)
    const candidateFindings = [...state.llmFindings, ...state.staticFindings].filter(
      (f) => f.status === 'confirmed' && f.fix && !rejectedIds.has(f.id)
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

    if (state.cfg?.hitlMode === 'terminal' && patches.length > 0) {
      const decisions = await doPromptTerminal(workspace, patches)
      const applied = await doApplyApproved(workspace, patches, decisions)

      return {
        attempts,
        patches,
        approvals: decisions,
        applied,
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
