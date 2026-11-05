import { EmotionCore } from './emotionCore';
import { planReaction, Reaction } from './personality';
import {
  EmotionConfig,
  Mood,
  MoodCategory,
  MutationType,
  Rng,
  USER_TRIGGERED_EVENTS,
  UserEvent,
  UserEventCategory,
  UserEventType,
} from './types';

const DEBOUNCE_MS = 80;
const COOL_DOWN_MS = 2 * 60 * 1000;
const SPICY = new Set([Mood.Agitated, Mood.Enraged, Mood.Frustrated]);

export interface MikuSettings extends EmotionConfig {
  soundEnabled: boolean;
  discreetMode: boolean;
  enabledEvents: ReadonlySet<UserEventType>;
}

export interface MikuHost {
  /** Show (or decline to show) a meme for the reaction. */
  react(reaction: Reaction): void;
  onMood(mood: Mood): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/**
 * Meme Inference Knowledge Unit: turns IDE events into moods and reactions.
 * Port of io.unthrottled.amii.core.MIKU + ModalityProcessor + CoolDownCore.
 */
export class Miku {
  private readonly emotions: EmotionCore;
  private lastSeen?: UserEvent;
  private debounce?: unknown;
  private coolDown?: unknown;
  private coolingDown = false;

  constructor(
    private settings: MikuSettings,
    private readonly host: MikuHost,
    rng: Rng = Math.random,
    private readonly timers: Timers = realTimers,
  ) {
    this.emotions = new EmotionCore(settings, rng);
  }

  get mood(): Mood {
    return this.emotions.currentMood;
  }

  updateSettings(settings: MikuSettings): void {
    this.settings = settings;
    this.emotions.updateConfig(settings);
  }

  dispatch(event: UserEvent): void {
    if (!this.isEnabled(event.type)) return;
    if (event.type === UserEventType.Idle || event.type === UserEventType.Return) {
      this.consume(event);
      return;
    }
    if (this.debounce !== undefined) this.timers.clearTimeout(this.debounce);
    this.debounce = this.timers.setTimeout(() => {
      this.debounce = undefined;
      this.consume(event);
    }, DEBOUNCE_MS);
  }

  /** "Relax" command: forget accumulated frustration. */
  relax(): void {
    this.emotions.mutateMood({ type: MutationType.Reset, moodCategory: MoodCategory.Negative });
    if (!this.settings.discreetMode) {
      const reaction = planReaction(
        { type: UserEventType.Relax, category: UserEventCategory.Neutral, name: 'Relax' },
        this.mood,
        this.settings.soundEnabled,
      );
      if (reaction) this.host.react(reaction);
    }
    this.publish();
  }

  dispose(): void {
    if (this.debounce !== undefined) this.timers.clearTimeout(this.debounce);
    if (this.coolDown !== undefined) this.timers.clearTimeout(this.coolDown);
  }

  private isEnabled(type: UserEventType): boolean {
    // Return is part of the Idle group, Relax is always allowed.
    const key = type === UserEventType.Return ? UserEventType.Idle : type;
    return key === UserEventType.Relax || this.settings.enabledEvents.has(key);
  }

  private consume(event: UserEvent): void {
    if (this.settings.discreetMode) return;
    const react = this.shouldReact(event);
    this.lastSeen = event;
    const mood = this.emotions.deriveMood(event);
    if (react) {
      const reaction = planReaction(event, mood, this.settings.soundEnabled);
      if (reaction) this.host.react(reaction);
    }
    this.publish();
  }

  /** Minimal mode only reacts when the outcome changes (pass -> fail, task -> test, ...). */
  private shouldReact(event: UserEvent): boolean {
    const last = this.lastSeen;
    if (!this.settings.minimalMode || !last) return true;
    if (event.type === UserEventType.Idle || event.type === UserEventType.Return) return true;
    if (!USER_TRIGGERED_EVENTS.has(event.type)) return true;
    return last.type !== event.type || last.category !== event.category;
  }

  private publish(): void {
    const mood = this.mood;
    this.trackCoolDown(mood);
    this.host.onMood(mood);
  }

  private trackCoolDown(mood: Mood): void {
    if (this.coolingDown) {
      if (this.coolDown !== undefined) this.timers.clearTimeout(this.coolDown);
      this.coolDown = undefined;
      if (mood === Mood.Calm) {
        this.coolingDown = false;
        return;
      }
    } else if (!SPICY.has(mood)) {
      return;
    }
    this.coolingDown = true;
    this.coolDown = this.timers.setTimeout(() => {
      this.coolDown = undefined;
      this.emotions.mutateMood({ type: MutationType.CoolDown, moodCategory: MoodCategory.Negative });
      this.publish();
    }, COOL_DOWN_MS);
  }
}
