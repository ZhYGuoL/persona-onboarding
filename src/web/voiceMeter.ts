// Watches the agent's audio on a call and reports when speech starts and
// stops. Latency on a phone call is the silence the caller hears, so it is
// measured on the audio the phone actually plays.

/** Louder than this (RMS, 0 to 1) counts as speech. GPT-Live's silence is near zero. */
const SPEECH_RMS = 0.012;
/** Speech must last this long to count, so a click is not a start. */
const START_HOLD_MS = 60;
/** Silence must last this long to count as the end of a reply, not a pause between words. */
const END_HOLD_MS = 450;
const POLL_MS = 20;

export interface VoiceMeterEvents {
  onStart(at: number): void;
  onEnd(at: number): void;
}

export class VoiceMeter {
  private readonly ctx: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly buffer: Float32Array<ArrayBuffer>;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly events: VoiceMeterEvents;
  private speaking = false;
  private loudSince: number | null = null;
  private quietSince: number | null = null;

  constructor(stream: MediaStream, events: VoiceMeterEvents) {
    this.events = events;
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.ctx.createMediaStreamSource(stream).connect(this.analyser);
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  private poll(): void {
    if (this.ctx.state === "suspended") void this.ctx.resume();
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (const x of this.buffer) sum += x * x;
    const rms = Math.sqrt(sum / this.buffer.length);
    const now = performance.now();
    if (rms >= SPEECH_RMS) {
      this.quietSince = null;
      this.loudSince ??= now;
      if (!this.speaking && now - this.loudSince >= START_HOLD_MS) {
        this.speaking = true;
        this.events.onStart(this.loudSince);
      }
    } else {
      this.loudSince = null;
      this.quietSince ??= now;
      if (this.speaking && now - this.quietSince >= END_HOLD_MS) {
        this.speaking = false;
        this.events.onEnd(this.quietSince);
      }
    }
  }

  stop(): void {
    clearInterval(this.timer);
    void this.ctx.close();
  }
}
