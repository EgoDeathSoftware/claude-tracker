/** Default number of transcripts parsed at once across every source. */
export const DEFAULT_PARSE_LIMIT = 8;

/**
 * Caps how many async tasks run concurrently.
 *
 * One instance is shared by every watcher, so a startup scan across many
 * sources holds a bounded number of parsed transcripts in flight rather than
 * all of them. Without it, each source starts every one of its files at once
 * and 20 sources multiply that into a heap spike several times the steady
 * state.
 */
export class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number = DEFAULT_PARSE_LIMIT) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    // The releasing task hands its slot straight over, so `active` is never
    // decremented on this path — a caller arriving between the release and
    // this resolution can't steal the slot out from under us.
    await new Promise<void>(resolve => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}
