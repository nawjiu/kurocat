// Real recorded cat purr sample (looping), with a synthesized fallback so the pet is never silent
// if the sample cannot be decoded. Two behaviours on top of the raw sample:
//   1) 抚摸结束约 2 秒后呼噜声自然停止（保留一点点尾巴，不硬切）
//   2) 「呼噜声常驻」开关：开着的时候猫猫平时就小声呼噜，摸头时再变响
import purrSampleUrl from './assets/purr.mp3?url';

/** 松开抚摸后还要继续呼噜多久（毫秒） */
const RELEASE_TAIL_MS = 2000;
/** 常驻模式下平时的呼噜音量（0-1，相对抚摸时的满档） */
const ALWAYS_ON_LEVEL = 0.32;
/** 主输出增益上限，避免样本本身偏响时破音 */
const MAX_GAIN = 0.42;

class CatAudio {
  private ctx: AudioContext | null = null;
  private enabled = true;
  private alwaysOn = false;
  private graphReady = false;
  private master: GainNode | null = null;
  private loopSource: AudioBufferSourceNode | null = null;
  private sampleBuffer: AudioBuffer | null = null;
  private sampleLoading: Promise<AudioBuffer | null> | null = null;
  private sampleFailed = false;
  private petIntensity = 0;
  private appliedLevel = 0;
  private stopTimer: number | null = null;

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.petIntensity = 0;
      this.rampTo(0, 0.06);
      this.scheduleStop(120);
    } else {
      this.applyLevel();
    }
  }

  /** 呼噜声常驻：不摸也一直在小声呼噜 */
  public setAlwaysOn(alwaysOn: boolean): void {
    if (this.alwaysOn === alwaysOn) return;
    this.alwaysOn = alwaysOn;
    this.applyLevel();
  }

  public isAlwaysOn(): boolean {
    return this.alwaysOn;
  }

  /** 0 = 静音, 1 = 摸到最舒服时的满档呼噜 */
  public setPurrIntensity(intensity: number): void {
    const next = Math.max(0, Math.min(1, intensity));
    if (Math.abs(next - this.petIntensity) < 0.004) return;
    this.petIntensity = next;
    this.applyLevel();
  }

  /** 目标音量：常驻模式给一个底噪，抚摸强度越高越响 */
  private currentTarget(): number {
    if (!this.enabled) return 0;
    if (this.alwaysOn) {
      return Math.max(ALWAYS_ON_LEVEL, this.petIntensity);
    }
    return this.petIntensity;
  }

  private applyLevel(): void {
    const target = this.currentTarget();
    if (target <= 0.001) {
      if (this.appliedLevel <= 0.001 && !this.loopSource) return;
      // 停止抚摸：先自然衰减，约 2 秒后彻底停掉（省电，也让耳朵休息）
      this.rampTo(0, 0.62);
      this.scheduleStop(RELEASE_TAIL_MS);
      return;
    }
    if (!this.ensureGraph()) return;
    this.cancelStop();
    this.rampTo(target * MAX_GAIN, 0.16);
  }

  private rampTo(level: number, timeConst: number): void {
    this.appliedLevel = level;
    if (!this.ctx || !this.master) return;
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    this.master.gain.setTargetAtTime(level, this.ctx.currentTime, Math.max(0.02, timeConst));
  }

  private scheduleStop(delayMs: number): void {
    this.cancelStop();
    this.stopTimer = window.setTimeout(() => {
      this.stopTimer = null;
      if (this.currentTarget() > 0.001) return;
      const src = this.loopSource;
      this.loopSource = null;
      if (src) {
        try {
          src.stop();
        } catch {
          // Already stopped
        }
      }
    }, Math.max(0, delayMs));
  }

  private cancelStop(): void {
    if (this.stopTimer !== null) {
      window.clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  private ensureContext(): boolean {
    if (this.ctx) return true;
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return false;
    try {
      this.ctx = new AC();
    } catch {
      return false;
    }
    return true;
  }

  private ensureGraph(): boolean {
    if (!this.enabled) return false;
    if (this.graphReady) {
      if (!this.loopSource) {
        if (this.sampleBuffer) this.startSampleLoop();
        else if (this.sampleFailed) this.buildSynthPurr();
        else void this.loadSample().then((buf) => (buf ? this.startSampleLoop() : this.buildSynthPurr()));
      }
      return true;
    }
    if (!this.ensureContext()) return false;
    const ctx = this.ctx as AudioContext;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }

    const master = ctx.createGain();
    master.gain.value = 0;
    // 轻低通：把样本里偶尔的齿音磨平，贴耳更软
    const polish = ctx.createBiquadFilter();
    polish.type = 'lowpass';
    polish.frequency.value = 2600;
    polish.Q.value = 0.4;
    master.connect(polish);
    polish.connect(ctx.destination);
    this.master = master;
    this.graphReady = true;

    if (this.sampleBuffer) {
      this.startSampleLoop();
    } else {
      void this.loadSample().then((buf) => {
        if (buf) this.startSampleLoop();
        else this.buildSynthPurr();
      });
    }
    return true;
  }

  private loadSample(): Promise<AudioBuffer | null> {
    if (this.sampleBuffer) return Promise.resolve(this.sampleBuffer);
    if (this.sampleFailed) return Promise.resolve(null);
    if (this.sampleLoading) return this.sampleLoading;
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve(null);
    this.sampleLoading = fetch(purrSampleUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`purr sample ${res.status}`);
        return res.arrayBuffer();
      })
      .then((raw) => ctx.decodeAudioData(raw))
      .then((buf) => {
        this.sampleBuffer = buf;
        return buf;
      })
      .catch(() => {
        this.sampleFailed = true;
        return null;
      })
      .finally(() => {
        this.sampleLoading = null;
      });
    return this.sampleLoading;
  }

  private startSampleLoop(): void {
    const ctx = this.ctx;
    const buf = this.sampleBuffer;
    if (!ctx || !buf || !this.master || this.loopSource) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.master);
    try {
      src.start();
    } catch {
      return;
    }
    this.loopSource = src;
  }

  /** 样本解码失败时的兜底：老版本的合成呼噜（噪声 + 带通 + 猫科颤音） */
  private buildSynthPurr(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.loopSource) return;

    const bufLen = Math.floor(ctx.sampleRate * 3.0);
    const noiseBuf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;
    noiseSrc.loop = true;

    const warm = ctx.createBiquadFilter();
    warm.type = 'bandpass';
    warm.frequency.value = 190;
    warm.Q.value = 1.15;
    const warmGain = ctx.createGain();
    warmGain.gain.value = 1.45;

    const breath = ctx.createBiquadFilter();
    breath.type = 'bandpass';
    breath.frequency.value = 520;
    breath.Q.value = 1.4;
    const breathGain = ctx.createGain();
    breathGain.gain.value = 0.34;

    const flutter = ctx.createGain();
    flutter.gain.value = 0.65;
    const flutterLfo = ctx.createOscillator();
    flutterLfo.type = 'sine';
    flutterLfo.frequency.value = 24.5;
    const flutterDepth = ctx.createGain();
    flutterDepth.gain.value = 0.35;
    flutterLfo.connect(flutterDepth);
    flutterDepth.connect(flutter.gain);

    const cadence = ctx.createGain();
    cadence.gain.value = 0.76;
    const breathLfo = ctx.createOscillator();
    breathLfo.type = 'sine';
    breathLfo.frequency.value = 0.68;
    const breathDepth = ctx.createGain();
    breathDepth.gain.value = 0.24;
    breathLfo.connect(breathDepth);
    breathDepth.connect(cadence.gain);

    noiseSrc.connect(warm);
    warm.connect(warmGain);
    warmGain.connect(flutter);
    noiseSrc.connect(breath);
    breath.connect(breathGain);
    breathGain.connect(flutter);
    flutter.connect(cadence);
    cadence.connect(master);

    noiseSrc.start();
    flutterLfo.start();
    breathLfo.start();
    this.loopSource = noiseSrc;
  }
}

export const catAudio = new CatAudio();
