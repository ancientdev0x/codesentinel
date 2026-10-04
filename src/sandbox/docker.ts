import type { RunResult, RunSpec } from './run'

/**
 * Placeholder for docker runner, implemented in E3.2.
 */
export const runDocker = async (spec: RunSpec): Promise<RunResult> => {
  return {
    status: 'unavailable',
    reason: `Docker backend not yet initialized for ${spec.tool}`,
  }
}
