// Watches what the flush loop learns about the collector and turns it into two things the device
// user can see: a notice on their screen when the link changes state, and an early retry when the
// network comes back, instead of waiting for the next scheduled heartbeat.
//
// The state machine has one input -- the outcome of a heartbeat, which is the only request the
// agent makes that runs on a timer whether or not there is anything to send. That keeps "am I
// connected" and "do I have data" separate, which is the distinction the offline spool depends on.
export function createConnectionWatch({ notifier, log, onRetry, retryCapMs = 60000, announceFirstOnline = false }) {
  let state = 'unknown';
  let retryTimer = null;
  let transitions = 0;

  function setState(next, reason) {
    if (next === state) return false;
    const previous = state;
    state = next;
    transitions += 1;
    log(`connection ${previous} -> ${next}${reason ? ` (${reason})` : ''}`);
    return previous;
  }

  function cancelRetry() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  // The retry a backoff asks for is capped: a long outage should not end with the agent sleeping
  // for fifteen minutes after the collector is already back. The cost is one extra unanswered
  // request per minute, which is nothing against the spool it protects.
  function scheduleRetry(delayMs) {
    cancelRetry();
    if (typeof onRetry !== 'function') return;
    const wait = Math.max(1000, Math.min(delayMs, retryCapMs));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      Promise.resolve().then(onRetry).catch((err) => log(`retry tick: ${err.code ?? err.message}`));
    }, wait);
    // The retry must not be the only thing keeping a resident agent alive, and it must not fire
    // after stop() if the process is already winding down.
    retryTimer.unref?.();
  }

  function observe(res) {
    if (!res) return state;
    if (res.terminal) {
      const code = res.terminal.code;
      // A pin mismatch is the one failure the person at the keyboard can usefully act on: it means
      // something other than the collector answered, and nothing will be uploaded until IT fixes it.
      // It is also repeatable -- an attacker or a misconfigured proxy sitting on the path does not
      // get to be announced once and then go quiet.
      if (code === 'tls_pin_mismatch' || code === 'tls_no_certificate') {
        setState('unverified', code);
        notifier.show('unverified');
      }
      // Other terminal codes are this device's consent or token state, not the link. The dashboard
      // and `status` are where those are visible; popping a balloon about them would tell the user
      // nothing they have not already answered.
      cancelRetry();
      return state;
    }
    if (res.retryInMs !== undefined) {
      setState('offline', res.code ?? 'unreachable');
      notifier.show('offline');
      scheduleRetry(res.retryInMs);
      return state;
    }
    const previous = setState('online');
    cancelRetry();
    if (previous && previous !== 'unknown') notifier.show('online');
    else if (previous === 'unknown' && announceFirstOnline) notifier.show('online');
    return state;
  }

  return {
    state: () => state,
    transitions: () => transitions,
    observe,
    stop: cancelRetry,
  };
}
