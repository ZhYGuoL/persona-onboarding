// A soft marimba-style ringtone, synthesized so the app ships no audio files.

const NOTES = [659.25, 830.61, 987.77, 1318.51, 987.77, 830.61];
const NOTE_S = 0.13;
const CYCLE_MS = 2400;

export class Ringtone {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  start(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    this.phrase();
    this.timer = setInterval(() => this.phrase(), CYCLE_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    void this.ctx?.close();
    this.ctx = null;
  }

  private phrase(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.05;
    NOTES.forEach((freq, i) => {
      const at = t0 + i * NOTE_S;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.08, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.4);
    });
  }
}
