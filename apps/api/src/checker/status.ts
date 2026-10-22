export type EndpointStatus = 'UNKNOWN' | 'UP' | 'DOWN' | 'PAUSED';

export interface EndpointState {
  currentStatus: EndpointStatus;
  consecutiveFailures: number;
}

/** WENT_DOWN / RECOVERED are what Phase 3 turns into incidents and alerts. */
export type Transition = 'WENT_DOWN' | 'RECOVERED' | null;

/**
 * Folds one check result into an endpoint's state.
 *
 *  - any success resets the failure counter and marks the endpoint UP
 *  - a failure only flips the endpoint to DOWN once `threshold` failures happen in a row,
 *    so a single blip never counts
 *  - a transition is reported only when the status actually changes to or from DOWN,
 *    so repeated failures after the first DOWN never re-trigger anything
 */
export function applyOutcome(
  state: EndpointState,
  success: boolean,
  threshold: number,
): { state: EndpointState; transition: Transition } {
  if (success) {
    return {
      state: { currentStatus: 'UP', consecutiveFailures: 0 },
      transition: state.currentStatus === 'DOWN' ? 'RECOVERED' : null,
    };
  }
  const consecutiveFailures = state.consecutiveFailures + 1;
  if (consecutiveFailures >= threshold) {
    return {
      state: { currentStatus: 'DOWN', consecutiveFailures },
      transition: state.currentStatus === 'DOWN' ? null : 'WENT_DOWN',
    };
  }
  return { state: { currentStatus: state.currentStatus, consecutiveFailures }, transition: null };
}
