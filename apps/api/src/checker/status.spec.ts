import { applyOutcome, type EndpointState } from './status.js';

const up: EndpointState = { currentStatus: 'UP', consecutiveFailures: 0 };
const unknown: EndpointState = { currentStatus: 'UNKNOWN', consecutiveFailures: 0 };

/** Feeds a string like "..FFF.F" (. = success, F = failure) through the state machine. */
function run(start: EndpointState, results: string, threshold: number) {
  let state = start;
  const transitions: (string | null)[] = [];
  for (const ch of results) {
    const r = applyOutcome(state, ch === '.', threshold);
    state = r.state;
    transitions.push(r.transition);
  }
  return { state, transitions };
}

describe('applyOutcome', () => {
  it('marks an unknown endpoint UP on its first success, with no transition', () => {
    const r = applyOutcome(unknown, true, 3);
    expect(r.state).toEqual({ currentStatus: 'UP', consecutiveFailures: 0 });
    expect(r.transition).toBeNull();
  });

  it('does not go DOWN until the threshold is reached', () => {
    const r = run(up, 'FF', 3);
    expect(r.state).toEqual({ currentStatus: 'UP', consecutiveFailures: 2 });
    expect(r.transitions).toEqual([null, null]);
  });

  it('goes DOWN exactly once at the threshold', () => {
    const r = run(up, 'FFF', 3);
    expect(r.state.currentStatus).toBe('DOWN');
    expect(r.transitions).toEqual([null, null, 'WENT_DOWN']);
  });

  it('does not re-trigger while it stays down', () => {
    const r = run(up, 'FFFFFF', 3);
    expect(r.transitions.filter((t) => t === 'WENT_DOWN')).toHaveLength(1);
    expect(r.state.consecutiveFailures).toBe(6);
  });

  it('recovers on the first success after being DOWN', () => {
    const r = run(up, 'FFF.', 3);
    expect(r.transitions).toEqual([null, null, 'WENT_DOWN', 'RECOVERED']);
    expect(r.state).toEqual({ currentStatus: 'UP', consecutiveFailures: 0 });
  });

  it('a success resets the counter, so scattered blips never trip the threshold', () => {
    const r = run(up, 'FF.FF.FF.', 3);
    expect(r.state.currentStatus).toBe('UP');
    expect(r.transitions.every((t) => t === null)).toBe(true);
  });

  it('flapping produces one pair of transitions per outage', () => {
    const r = run(up, 'FFF.FFF.', 3);
    expect(r.transitions).toEqual([null, null, 'WENT_DOWN', 'RECOVERED', null, null, 'WENT_DOWN', 'RECOVERED']);
  });

  it('threshold 1 goes DOWN on the first failure', () => {
    expect(run(up, 'F', 1).transitions).toEqual(['WENT_DOWN']);
  });

  it('an UNKNOWN endpoint that has only failed below the threshold stays UNKNOWN', () => {
    const r = run(unknown, 'FF', 3);
    expect(r.state).toEqual({ currentStatus: 'UNKNOWN', consecutiveFailures: 2 });
  });

  it('an UNKNOWN endpoint can go DOWN, and then RECOVER', () => {
    const r = run(unknown, 'FFF.', 3);
    expect(r.transitions).toEqual([null, null, 'WENT_DOWN', 'RECOVERED']);
  });
});
