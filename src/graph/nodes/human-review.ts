import type { ReviewStateType, ReviewStateUpdate } from '../state'

export const humanReview = () => {
  return async (state: ReviewStateType): Promise<ReviewStateUpdate> => {
    const attempts = {
      ...state.attempts,
      human_review: (state.attempts?.human_review ?? 0) + 1,
    }

    // In E4, this is a pass-through node.
    // E5 will integrate LangGraph interrupt() for HITL patch reviews.
    return {
      attempts,
    }
  }
}
