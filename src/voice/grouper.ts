// GPT-Live streams transcript fragments with no end-of-turn marker. This
// groups them into finished utterances per speaker. A speaker's utterance ends
// when they go quiet, or when the other side answers. A short agent
// backchannel ("mm-hmm") while the user is still talking does not end the
// user's utterance.

import type { Clock, TimerHandle } from "../runtime/clock.ts";

export type Speaker = "user" | "agent";

export interface GrouperOptions {
  clock: Clock;
  /** Quiet time that ends a user utterance. */
  userQuietMs?: number;
  /** Quiet time that ends an agent utterance. */
  agentQuietMs?: number;
  /** An agent fragment ends the user's utterance only if the user has been quiet this long. */
  overlapMs?: number;
  onFinal: (speaker: Speaker, text: string, startedAt: number) => void;
  onUserStart: () => void;
}

interface Buffer {
  text: string;
  startedAt: number;
  lastAt: number;
  timer: TimerHandle | null;
}

export class UtteranceGrouper {
  private readonly opts: Required<Omit<GrouperOptions, "onFinal" | "onUserStart" | "clock">> &
    GrouperOptions;
  private readonly buffers: Record<Speaker, Buffer | null> = { user: null, agent: null };

  constructor(opts: GrouperOptions) {
    this.opts = { userQuietMs: 900, agentQuietMs: 1400, overlapMs: 300, ...opts };
  }

  delta(speaker: Speaker, text: string): void {
    const now = this.opts.clock.now();
    const other: Speaker = speaker === "user" ? "agent" : "user";
    const otherBuf = this.buffers[other];
    if (otherBuf) {
      // The agent answering ends the user's turn, unless the user is still mid-sentence.
      // The user speaking always ends the agent's turn.
      const userStillTalking = other === "user" && now - otherBuf.lastAt < this.opts.overlapMs;
      if (!userStillTalking) this.flush(other);
    }
    let buf = this.buffers[speaker];
    if (!buf) {
      buf = { text: "", startedAt: now, lastAt: now, timer: null };
      this.buffers[speaker] = buf;
      if (speaker === "user") this.opts.onUserStart();
    }
    buf.text += text;
    buf.lastAt = now;
    buf.timer?.cancel();
    const quiet = speaker === "user" ? this.opts.userQuietMs : this.opts.agentQuietMs;
    buf.timer = this.opts.clock.setTimeout(() => this.flush(speaker), quiet);
  }

  flush(speaker: Speaker): void {
    const buf = this.buffers[speaker];
    if (!buf) return;
    buf.timer?.cancel();
    this.buffers[speaker] = null;
    const text = buf.text.replace(/\s+/g, " ").trim();
    if (text) this.opts.onFinal(speaker, text, buf.startedAt);
  }

  flushAll(): void {
    this.flush("user");
    this.flush("agent");
  }
}
