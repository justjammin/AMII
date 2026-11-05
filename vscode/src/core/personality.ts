import { MemeCategory as C, Mood, USER_TRIGGERED_EVENTS, UserEvent, UserEventCategory, UserEventType } from './types';

export enum Comparison {
  Greater = 'GREATER',
  Equal = 'EQUAL',
  Lesser = 'LESSER',
}

export type Dismissal = 'timed' | 'focusLoss';

/**
 * What MIKU wants to show. `comparator` belongs to the meme once it is on screen:
 * it is called with an incoming reaction, and only `Greater` lets the incoming one replace it.
 */
export interface Reaction {
  readonly event: UserEvent;
  readonly mood: Mood;
  /** Candidate categories; duplicates weight the random choice. */
  readonly categories: readonly C[];
  readonly dismissal: Dismissal;
  readonly sound: boolean;
  /** Emit a RETURN event when the meme is dismissed (idle memes). */
  readonly notifyReturnOnDismiss: boolean;
  readonly comparator: (incoming: Reaction) => Comparison;
}

export function shouldReplace(displayed: Reaction | undefined, incoming: Reaction): boolean {
  return displayed === undefined || displayed.comparator(incoming) === Comparison.Greater;
}

const IDLE_INTENSITY: Partial<Record<Mood, number>> = {
  [Mood.Patient]: 1,
  [Mood.Bored]: 2,
  [Mood.Tired]: 3,
};

function taskCategories(event: UserEvent, mood: Mood): C[] {
  if (event.category === UserEventCategory.Positive) {
    if (mood === Mood.Smug) return [C.Smug];
    if (mood === Mood.Happy) return [C.Celebration, C.Happy];
    return [C.Celebration];
  }
  if (event.category === UserEventCategory.Negative) {
    switch (mood) {
      case Mood.Frustrated:
        return [C.Frustration];
      case Mood.Enraged:
        return [C.Enraged];
      case Mood.MildlyDisappointed:
        return [C.Pouting];
      case Mood.Disappointed:
        return [C.Disappointment, C.Disappointment, C.Mocking, C.Disappointment, C.Disappointment];
      default:
        return [C.Shocked];
    }
  }
  return [];
}

/** Port of the IntelliJ PersonalityCores: decides which kind of meme an event deserves. */
export function planReaction(event: UserEvent, mood: Mood, soundEnabled: boolean): Reaction | undefined {
  const base = { event, mood, dismissal: 'timed' as Dismissal, sound: soundEnabled, notifyReturnOnDismiss: false };

  if (USER_TRIGGERED_EVENTS.has(event.type)) {
    const categories = taskCategories(event, mood);
    if (categories.length === 0) return undefined;
    return {
      ...base,
      categories,
      comparator: (incoming) =>
        USER_TRIGGERED_EVENTS.has(incoming.event.type)
          ? incoming.event.category === event.category
            ? Comparison.Equal
            : Comparison.Greater
          : Comparison.Equal,
    };
  }

  switch (event.type) {
    case UserEventType.OnDemand:
    case UserEventType.Silence:
      return {
        ...base,
        categories: [C.Happy, C.Celebration, C.Alert],
        sound: event.type === UserEventType.Silence ? false : soundEnabled,
        comparator: () => Comparison.Greater,
      };
    case UserEventType.Idle: {
      const category = mood === Mood.Bored ? C.Bored : mood === Mood.Tired ? C.Tired : C.PatientlyWaiting;
      return {
        ...base,
        categories: [category],
        dismissal: 'focusLoss',
        notifyReturnOnDismiss: true,
        comparator: (incoming) => {
          if (incoming.event.type !== UserEventType.Idle) return Comparison.Greater;
          const delta = (IDLE_INTENSITY[incoming.mood] ?? 0) - (IDLE_INTENSITY[mood] ?? 0);
          return delta > 0 ? Comparison.Greater : delta < 0 ? Comparison.Lesser : Comparison.Equal;
        },
      };
    }
    case UserEventType.Logs:
      return { ...base, categories: [C.Alert], comparator: () => Comparison.Lesser };
    case UserEventType.Startup:
      return { ...base, categories: [C.Welcoming], comparator: () => Comparison.Greater };
    case UserEventType.Relax:
      return {
        ...base,
        categories: [C.Acknowledgement, C.Acknowledgement, C.Acknowledgement, C.Happy],
        comparator: () => Comparison.Greater,
      };
    default:
      return undefined;
  }
}
