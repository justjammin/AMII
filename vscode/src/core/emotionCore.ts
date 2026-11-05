import { ProbabilityTools, Weighted } from './probability';
import {
  EmotionConfig,
  EmotionalMutation,
  Mood,
  MoodCategory,
  MutationType,
  Rng,
  UserEvent,
  UserEventCategory,
  UserEventType,
} from './types';

const MAX_USER_HISTORY = 10;

export interface EmotionalState {
  readonly mood: Mood;
  /** Most recent first. */
  readonly previousEvents: readonly UserEvent[];
  readonly observedPositiveEvents: number;
  readonly observedNeutralEvents: number;
  readonly observedNegativeEvents: number;
}

export const initialState = (mood: Mood = Mood.Calm): EmotionalState => ({
  mood,
  previousEvents: [],
  observedPositiveEvents: 0,
  observedNeutralEvents: 0,
  observedNegativeEvents: 0,
});

// ---------------------------------------------------------------- negative

const OTHER_NEGATIVE = [Mood.Shocked, Mood.Disappointed, Mood.MildlyDisappointed] as const;
const FRUSTRATION_WEIGHT = 0.75;
const TOTAL_NEGATIVE_WEIGHT = 500;
const REACTABLE = new Set([UserEventType.Test, UserEventType.Task, UserEventType.Process]);

class NegativeUnit {
  private readonly p: ProbabilityTools;
  constructor(private readonly config: EmotionConfig, rng: Rng) {
    this.p = new ProbabilityTools(rng);
  }

  derive(event: UserEvent, state: EmotionalState): EmotionalState {
    if (event.type === UserEventType.Idle) return state;
    const observed = state.observedNegativeEvents;
    return { ...state, mood: this.pickNegativeMood(observed, state), observedNegativeEvents: observed + 1 };
  }

  mutate(mutation: EmotionalMutation, state: EmotionalState): EmotionalState {
    if (mutation.type === MutationType.Reset) {
      return { ...state, mood: Mood.Calm, observedNegativeEvents: 0 };
    }
    const cooled = Math.max(0, state.observedNegativeEvents - 1);
    const calmedDown = Math.floor(this.config.eventsBeforeFrustration / 2) >= cooled;
    return {
      ...state,
      mood: calmedDown ? Mood.Calm : this.pickNegativeMood(cooled, state),
      observedNegativeEvents: cooled,
    };
  }

  private shouldBeFrustrated(observed: number): boolean {
    return this.config.allowFrustration && this.config.eventsBeforeFrustration <= observed;
  }

  private pickNegativeMood(observed: number, state: EmotionalState): Mood {
    if (this.shouldBeFrustrated(observed) && observed >= this.config.eventsBeforeFrustration * 2) {
      const rage = Math.floor(this.config.probabilityOfFrustration * FRUSTRATION_WEIGHT);
      return this.pickNegative([
        [Mood.Enraged, rage],
        [Mood.Frustrated, this.config.probabilityOfFrustration - rage],
      ]);
    }
    if (this.shouldBeFrustrated(observed)) {
      return this.pickNegative([[Mood.Frustrated, this.config.probabilityOfFrustration]]);
    }
    return this.pickNextNegativeMood(state);
  }

  private pickNegative(primary: Weighted<Mood>): Mood {
    return this.p.pickEmotion(this.config.probabilityOfFrustration, primary, OTHER_NEGATIVE);
  }

  private pickNextNegativeMood(state: EmotionalState): Mood {
    const history = state.previousEvents.filter((e) => REACTABLE.has(e.type)).map((e) => e.category);
    let weighted: Weighted<Mood>;
    if (history[0] === UserEventCategory.Negative) {
      const combo = comboLength(history);
      const disappointed = Math.floor(TOTAL_NEGATIVE_WEIGHT / Math.log2(combo));
      weighted = [
        [Mood.MildlyDisappointed, TOTAL_NEGATIVE_WEIGHT - disappointed],
        [Mood.Disappointed, disappointed],
      ];
    } else {
      const third = Math.floor(TOTAL_NEGATIVE_WEIGHT / 3);
      weighted = [
        [Mood.Shocked, TOTAL_NEGATIVE_WEIGHT - third],
        [Mood.Disappointed, third],
        [Mood.MildlyDisappointed, Math.floor(third / 3)],
      ];
    }
    return this.p.pickFromWeightedList(weighted) ?? this.p.pick(OTHER_NEGATIVE);
  }
}

/** 1 + the number of consecutive negative events at the head of history. */
export function comboLength(history: readonly UserEventCategory[]): number {
  let combo = 1;
  for (const category of history) {
    if (category !== UserEventCategory.Negative) break;
    combo++;
  }
  return combo;
}

// ---------------------------------------------------------------- positive

const OTHER_POSITIVE = [Mood.Happy] as const;

class PositiveUnit {
  private readonly p: ProbabilityTools;
  constructor(rng: Rng) {
    this.p = new ProbabilityTools(rng);
  }

  derive(event: UserEvent, state: EmotionalState): EmotionalState {
    if (event.type === UserEventType.Idle) return state;
    return {
      ...state,
      mood: this.positiveMood(state),
      observedPositiveEvents: state.observedPositiveEvents + 1,
      observedNegativeEvents: Math.max(0, state.observedNegativeEvents - 1),
    };
  }

  private positiveMood(state: EmotionalState): Mood {
    if (state.mood === Mood.Frustrated) return Mood.Relieved;
    if (state.previousEvents[0]?.category === UserEventCategory.Negative) {
      // Problem solved: mostly smug.
      return this.p.pickEmotion(80, [[Mood.Smug, 60], [Mood.Excited, 20]], OTHER_POSITIVE);
    }
    return this.p.pickEmotion(75, [[Mood.Excited, 75]], OTHER_POSITIVE);
  }
}

// ----------------------------------------------------------------- neutral

const BOREDOM_THRESHOLD = 3;

class NeutralUnit {
  derive(event: UserEvent, state: EmotionalState): EmotionalState {
    if (event.type === UserEventType.Return) return initialState(Mood.Attentive);
    if (event.type !== UserEventType.Idle) return state;
    const seen = state.observedNeutralEvents;
    const mood = seen > BOREDOM_THRESHOLD ? Mood.Tired : seen >= 1 ? Mood.Bored : Mood.Patient;
    return { ...initialState(mood), observedNeutralEvents: seen + 1 };
  }
}

// -------------------------------------------------------------------- core

export class EmotionCore {
  private state: EmotionalState = initialState();
  private negative: NegativeUnit;
  private readonly positive: PositiveUnit;
  private readonly neutral = new NeutralUnit();

  constructor(config: EmotionConfig, private readonly rng: Rng = Math.random) {
    this.negative = new NegativeUnit(config, rng);
    this.positive = new PositiveUnit(rng);
  }

  get currentMood(): Mood {
    return this.state.mood;
  }

  get emotionalState(): EmotionalState {
    return this.state;
  }

  updateConfig(config: EmotionConfig): void {
    this.negative = new NegativeUnit(config, this.rng);
  }

  deriveMood(event: UserEvent): Mood {
    const next = this.unitFor(event.category)(event, this.state);
    this.state = { ...next, previousEvents: [event, ...next.previousEvents].slice(0, MAX_USER_HISTORY) };
    return this.state.mood;
  }

  mutateMood(mutation: EmotionalMutation): Mood {
    // Only negative moods have mutations (cool-down / reset) in the original engine.
    if (mutation.moodCategory === MoodCategory.Negative) {
      this.state = this.negative.mutate(mutation, this.state);
    }
    return this.state.mood;
  }

  private unitFor(category: UserEventCategory): (e: UserEvent, s: EmotionalState) => EmotionalState {
    switch (category) {
      case UserEventCategory.Positive:
        return (e, s) => this.positive.derive(e, s);
      case UserEventCategory.Negative:
        return (e, s) => this.negative.derive(e, s);
      case UserEventCategory.Neutral:
        return (e, s) => this.neutral.derive(e, s);
    }
  }
}
