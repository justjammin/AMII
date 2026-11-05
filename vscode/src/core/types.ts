// Domain types ported from the IntelliJ plugin (io.unthrottled.amii).
// Kept free of `vscode` imports so the emotion engine is unit-testable in plain Node.

export enum UserEventType {
  Idle = 'IDLE',
  Return = 'RETURN',
  Logs = 'LOGS',
  OnDemand = 'ON_DEMAND',
  Process = 'PROCESS',
  Startup = 'STARTUP',
  Task = 'TASK',
  Test = 'TEST',
  Relax = 'RELAX',
  Silence = 'SILENCE',
}

export enum UserEventCategory {
  Positive = 'POSITIVE',
  Negative = 'NEGATIVE',
  Neutral = 'NEUTRAL',
}

export interface UserEvent {
  readonly type: UserEventType;
  readonly category: UserEventCategory;
  readonly name: string;
}

export const USER_TRIGGERED_EVENTS: ReadonlySet<UserEventType> = new Set([
  UserEventType.Test,
  UserEventType.Task,
  UserEventType.Process,
]);

export enum Mood {
  Enraged = 'enraged',
  Frustrated = 'frustrated',
  Agitated = 'agitated',
  Happy = 'happy',
  Relieved = 'relieved',
  Excited = 'excited',
  Proud = 'proud',
  Amazed = 'amazed',
  Smug = 'smug',
  Shocked = 'shocked',
  Surprised = 'surprised',
  Calm = 'calm',
  Patient = 'patient',
  Bored = 'bored',
  Tired = 'tired',
  Disappointed = 'disappointed',
  MildlyDisappointed = 'mildly disappointed',
  Attentive = 'attentive',
}

export enum MutationType {
  CoolDown = 'COOL_DOWN',
  Reset = 'RESET',
}

export enum MoodCategory {
  Positive = 'POSITIVE',
  Negative = 'NEGATIVE',
  Neutral = 'NEUTRAL',
}

export interface EmotionalMutation {
  readonly type: MutationType;
  readonly moodCategory: MoodCategory;
}

/** Numeric ids match the remote API's `cat` field. */
export enum MemeCategory {
  Acknowledgement = 0,
  Frustration = 1,
  Enraged = 2,
  Celebration = 3,
  Happy = 4,
  Smug = 5,
  Waiting = 6,
  Motivation = 7,
  Welcoming = 8,
  Departure = 9,
  Encouragement = 10,
  Mocking = 11,
  Shocked = 12,
  Disappointment = 13,
  Alert = 14,
  Bored = 15,
  Tired = 16,
  PatientlyWaiting = 17,
  Pouting = 18,
}

export const MEME_CATEGORY_NAMES: Record<string, MemeCategory> = Object.fromEntries(
  Object.entries(MemeCategory)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => [k.toLowerCase(), v as MemeCategory]),
);

export function categoryFromName(name: string): MemeCategory | undefined {
  return MEME_CATEGORY_NAMES[name.toLowerCase().replace(/[^a-z]/g, '')];
}

/** Settings the emotion engine and modality processor depend on. */
export interface EmotionConfig {
  allowFrustration: boolean;
  eventsBeforeFrustration: number;
  /** 0..100 */
  probabilityOfFrustration: number;
  minimalMode: boolean;
}

export const DEFAULT_EMOTION_CONFIG: EmotionConfig = {
  allowFrustration: true,
  eventsBeforeFrustration: 5,
  probabilityOfFrustration: 75,
  minimalMode: false,
};

/** Returns a float in [0, 1). Injected so tests are deterministic. */
export type Rng = () => number;
