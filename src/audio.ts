// Real recorded cat purr sample (looping), with a synthesized fallback so the pet is never silent
// if the sample cannot be decoded. Two behaviours on top of the raw sample:
//   1) 抚摸结束约 2 秒后呼噜声自然停止（保留一点点尾巴，不硬切）
//   2) 「呼噜声常驻」开关：开着的时候猫猫平时就小声呼噜，摸头时再变响
import purrSampleUrl from './assets/purr.mp3?url';
import squeakSampleUrl from './assets/squeak.mp3?url';

/** 松开抚摸后还要继续呼噜多久（毫秒） */
const RELEASE_TAIL_MS = 2000;
/** 常驻模式下平时的呼噜音量（0-1，相对抚摸时的满档） */
const ALWAYS_ON_LEVEL = 0.32;
/** 主输出增益上限，避免样本本身偏响时破音 */
const MAX_GAIN = 0.42;
/** 按住小猫时的哼唧基础音量（还会再乘上「呼噜声音量」滑块，两者联动） */
const SQUEAK_LEVEL = 0.72;
/** 按住多久之后才开始哼唧（毫秒）——太短会把随手点一下也算成抚摸 */
const SQUEAK_HOLD_DELAY_MS = 1000;
/** 一旦开始叫，最少叫满多久（毫秒），避免刚出声就被掐断 */
const SQUEAK_MIN_PLAY_MS = 2000;
/**
 * 松手判定宽限（毫秒）：鼠标钩子偶尔会丢帧/抖动，把一次真实长按拆成「松开 + 再按下」。
 * 这个窗口内的再次按下算作同一次长按——既不会重新数 1 秒，也不会把哼唧掐断重来。
 */
const SQUEAK_RELEASE_GRACE_MS = 260;

class CatAudio {
  private ctx: AudioContext | null = null;
  private enabled = true;
  private alwaysOn = false;
  /** 呼噜总音量系数（0 = 静音，1 = 默认，1.5 = 上限），常驻底噪与摸头呼噜共用 */
  private volume = 1;
  private graphReady = false;
  private master: GainNode | null = null;
  private loopSource: AudioBufferSourceNode | null = null;
  private sampleBuffer: AudioBuffer | null = null;
  private sampleLoading: Promise<AudioBuffer | null> | null = null;
  private sampleFailed = false;
  private petIntensity = 0;
  private appliedLevel = 0;
  private stopTimer: number | null = null;
  private squeakBuffer: AudioBuffer | null = null;
  private squeakLoading: Promise<AudioBuffer | null> | null = null;
  private squeakSource: AudioBufferSourceNode | null = null;
  private squeakGain: GainNode | null = null;
  private squeakHeld = false;
  private squeakArmTimer: number | null = null;
  private squeakMinTimer: number | null = null;
  private squeakReleaseTimer: number | null = null;
  private squeakStartedAt = 0;
  private squeakListeners = new Set<(active: boolean) => void>();

  /** 注册「是否正在哼唧」的回调（猫猫的眼睛要用它来变妩媚） */
  public onSqueakChange(cb: (active: boolean) => void): void {
    this.squeakListeners.add(cb);
  }

  public isSqueaking(): boolean {
    return this.squeakSource !== null;
  }

  private notifySqueak(active: boolean): void {
    for (const cb of this.squeakListeners) {
      try {
        cb(active);
      } catch {
        // 回调里的异常不该影响声音
      }
    }
  }


  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.petIntensity = 0;
      this.rampTo(0, 0.06);
      this.scheduleStop(120);
      this.killSqueak();
    } else {
      this.applyLevel();
    }
  }

  /** 按住小猫：满 1 秒后开始哼唧（循环播放，松开前一直叫） */
  public startSqueak(): void {
    this.squeakHeld = true;
    this.clearSqueakMinTimer();
    // 松手宽限期内又按下 = 同一次长按，直接撤销这次“假松开”，计时与声音都不重来
    if (this.squeakReleaseTimer !== null) {
      this.clearSqueakReleaseTimer();
      if (this.squeakSource || this.squeakArmTimer !== null) return;
    }
    if (!this.enabled) return;
    if (!this.ensureContext()) return;
    const ctx = this.ctx as AudioContext;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
    // 已经在叫：把被“最少播放时长”压低的音量抬回来
    if (this.squeakSource) {
      if (this.squeakGain) {
        this.squeakGain.gain.setTargetAtTime(this.squeakTarget(), ctx.currentTime, 0.04);
      }
      this.notifySqueak(true);
      return;
    }
    // 已经进入长按倒计时：不要重置，避免“短按一次 + 长按一次”的错觉
    if (this.squeakArmTimer !== null) return;
    this.squeakArmTimer = window.setTimeout(() => {
      this.squeakArmTimer = null;
      if (!this.squeakHeld) return;
      void this.playSqueakLoop();
    }, SQUEAK_HOLD_DELAY_MS);
  }

  /** 松开鼠标：先等一个极短的宽限期，确认真的松开了再收尾 */
  public stopSqueak(): void {
    if (!this.squeakHeld) return;
    if (this.squeakReleaseTimer !== null) return;
    this.squeakReleaseTimer = window.setTimeout(() => {
      this.squeakReleaseTimer = null;
      this.commitRelease();
    }, SQUEAK_RELEASE_GRACE_MS);
  }

  /** 宽限期结束（确实松手了）：不足 2 秒的话把剩下的叫完再停，超过 2 秒立刻淡出 */
  private commitRelease(): void {
    this.squeakHeld = false;
    this.clearSqueakArmTimer();
    if (!this.squeakSource) return;
    const remain = SQUEAK_MIN_PLAY_MS - (performance.now() - this.squeakStartedAt);
    if (remain > 0) {
      if (this.squeakMinTimer !== null) return;
      this.squeakMinTimer = window.setTimeout(() => {
        this.squeakMinTimer = null;
        if (this.squeakHeld) return;
        this.fadeOutSqueak();
      }, remain);
      return;
    }
    this.fadeOutSqueak();
  }

  /** 预热解码：第一次长按出声不再拖拍 */
  public preload(): void {
    if (!this.ensureContext()) return;
    void this.loadSample();
    void this.loadSqueak();
  }

  /** 关掉声音 / 切静音等场景：不给尾巴，直接掐断 */
  private killSqueak(): void {
    this.squeakHeld = false;
    this.clearSqueakArmTimer();
    this.clearSqueakMinTimer();
    this.clearSqueakReleaseTimer();
    this.fadeOutSqueak();
  }

  private clearSqueakArmTimer(): void {
    if (this.squeakArmTimer !== null) {
      window.clearTimeout(this.squeakArmTimer);
      this.squeakArmTimer = null;
    }
  }

  private clearSqueakMinTimer(): void {
    if (this.squeakMinTimer !== null) {
      window.clearTimeout(this.squeakMinTimer);
      this.squeakMinTimer = null;
    }
  }

  private clearSqueakReleaseTimer(): void {
    if (this.squeakReleaseTimer !== null) {
      window.clearTimeout(this.squeakReleaseTimer);
      this.squeakReleaseTimer = null;
    }
  }

  /** 哼唧跟呼噜共用同一个音量滑块 */
  private squeakTarget(): number {
    return Math.min(1.1, SQUEAK_LEVEL * this.volume);
  }

  private fadeOutSqueak(): void {
    const ctx = this.ctx;
    const src = this.squeakSource;
    const gain = this.squeakGain;
    this.squeakSource = null;
    this.squeakGain = null;
    this.squeakStartedAt = 0;
    if (!ctx || !src) return;
    this.notifySqueak(false);
    if (gain) {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    }
    window.setTimeout(() => {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }, 240);
  }

  private async playSqueakLoop(): Promise<void> {
    const buf = await this.loadSqueak();
    if (!buf || !this.squeakHeld || !this.enabled) return;
    const ctx = this.ctx;
    if (!ctx || this.squeakSource) return;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(gain);
    gain.connect(ctx.destination);
    try {
      src.start();
    } catch {
      return;
    }
    this.squeakGain = gain;
    this.squeakSource = src;
    this.squeakStartedAt = performance.now();
    gain.gain.setTargetAtTime(this.squeakTarget(), ctx.currentTime, 0.045);
    if (!this.squeakHeld) {
      // 加载音频的瞬间刚好松开了：按最少播放时长收尾，不要凭空冒出一声
      this.commitRelease();
      return;
    }
    this.notifySqueak(true);
  }

  private loadSqueak(): Promise<AudioBuffer | null> {
    if (this.squeakBuffer) return Promise.resolve(this.squeakBuffer);
    if (this.squeakLoading) return this.squeakLoading;
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve(null);
    this.squeakLoading = fetch(squeakSampleUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`squeak sample ${res.status}`);
        return res.arrayBuffer();
      })
      .then((raw) => ctx.decodeAudioData(raw))
      .then((buf) => {
        this.squeakBuffer = buf;
        return buf;
      })
      .catch(() => null)
      .finally(() => {
        this.squeakLoading = null;
      });
    return this.squeakLoading;
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

  /** 呼噜音量滑块：同时作用于「常驻底噪」和「摸头呼噜」 */
  public setVolume(volume: number): void {
    const raw = Number.isFinite(volume) ? volume : 1;
    const next = Math.max(0, Math.min(1.5, raw));
    if (Math.abs(next - this.volume) < 0.002) return;
    this.volume = next;
    if (this.enabled) this.applyLevel();
    // 正在哼唧时立刻跟着滑块变响/变轻
    if (this.squeakGain && this.ctx) {
      this.squeakGain.gain.setTargetAtTime(this.squeakTarget(), this.ctx.currentTime, 0.05);
      if (next <= 0.001) this.killSqueak();
    }
  }

  public getVolume(): number {
    return this.volume;
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
    // 音量系数在最外层统一相乘，所以两个音量来源（常驻 / 摸头）都跟随同一个滑块
    const target = this.currentTarget() * this.volume;
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
