/** Helpers for waiting on Ink renders in tests. */
export const frames = {
  /** Waits long enough for pending input and renders to flush. */
  settle: () => new Promise((resolve) => setTimeout(resolve, 40)),

  /**
   * Polls `check` until it returns without throwing.
   * @param check An assertion to retry.
   * @param timeoutMs How long to keep trying.
   */
  async until(check: () => void, timeoutMs = 3000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        check();
        return;
      } catch (err) {
        if (Date.now() > end) throw err;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  },
};
