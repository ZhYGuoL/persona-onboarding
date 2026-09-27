// All timers go through a Clock so tests and the reviewer panel can move time.

export interface TimerHandle {
  cancel(): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
}

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const h = setTimeout(fn, Math.max(0, ms));
    h.unref?.();
    return { cancel: () => clearTimeout(h) };
  }
}

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

/** A manual clock. `advance()` fires due timers in time order and settles between them. */
export class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private timers: FakeTimer[] = [];

  constructor(start = Date.UTC(2026, 8, 26, 23, 0, 0)) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const timer = { id: ++this.seq, at: this.t + Math.max(0, ms), fn };
    this.timers.push(timer);
    return {
      cancel: () => {
        this.timers = this.timers.filter((x) => x !== timer);
      },
    };
  }

  pendingTimers(): number {
    return this.timers.length;
  }

  nextAt(): number | null {
    let min: number | null = null;
    for (const t of this.timers) if (min === null || t.at < min) min = t.at;
    return min;
  }

  /** Move time forward, firing each due timer and awaiting `settle` after each one. */
  async advance(ms: number, settle: () => Promise<void> = async () => {}): Promise<void> {
    const target = this.t + ms;
    await settle();
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await settle();
    }
    this.t = target;
  }
}
