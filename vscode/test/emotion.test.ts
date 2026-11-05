import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { comboLength, EmotionCore } from '../src/core/emotionCore';
import { Comparison, planReaction, shouldReplace } from '../src/core/personality';
import {
  DEFAULT_EMOTION_CONFIG,
  EmotionConfig,
  MemeCategory,
  Mood,
  MoodCategory,
  MutationType,
  UserEvent,
  UserEventCategory as Cat,
  UserEventType as T,
} from '../src/core/types';
import { seeded } from './helpers';

const ev = (type: T, category: Cat): UserEvent => ({ type, category, name: type });
const fail = ev(T.Test, Cat.Negative);
const pass = ev(T.Test, Cat.Positive);
const idle = ev(T.Idle, Cat.Neutral);

const cfg = (overrides: Partial<EmotionConfig>): EmotionConfig => ({
  ...DEFAULT_EMOTION_CONFIG,
  probabilityOfFrustration: 100,
  ...overrides,
});

describe('EmotionCore', () => {
  it('starts calm and becomes patient, bored, then tired while idle', () => {
    const core = new EmotionCore(cfg({}), seeded(1));
    assert.equal(core.currentMood, Mood.Calm);
    const moods = Array.from({ length: 6 }, () => core.deriveMood(idle));
    assert.deepEqual(moods, [Mood.Patient, Mood.Bored, Mood.Bored, Mood.Bored, Mood.Tired, Mood.Tired]);
  });

  it('returning from idle makes MIKU attentive', () => {
    const core = new EmotionCore(cfg({}), seeded(1));
    core.deriveMood(idle);
    assert.equal(core.deriveMood(ev(T.Return, Cat.Neutral)), Mood.Attentive);
  });

  it('gets frustrated after N failures and enraged after 2N', () => {
    const core = new EmotionCore(cfg({ eventsBeforeFrustration: 2 }), seeded(7));
    const moods = Array.from({ length: 6 }, () => core.deriveMood(fail));
    assert.ok(!([Mood.Frustrated, Mood.Enraged] as Mood[]).includes(moods[0]));
    assert.ok(!([Mood.Frustrated, Mood.Enraged] as Mood[]).includes(moods[1]));
    assert.equal(moods[2], Mood.Frustrated);
    assert.equal(moods[3], Mood.Frustrated);
    assert.ok(([Mood.Frustrated, Mood.Enraged] as Mood[]).includes(moods[4]));
  });

  it('never gets frustrated when frustration is disabled', () => {
    const core = new EmotionCore(cfg({ allowFrustration: false, eventsBeforeFrustration: 0 }), seeded(3));
    for (let i = 0; i < 42; i++) {
      const mood = core.deriveMood(fail);
      assert.ok([Mood.Shocked, Mood.Disappointed, Mood.MildlyDisappointed].includes(mood), mood);
    }
  });

  it('is relieved when a frustrating streak ends', () => {
    const core = new EmotionCore(cfg({ eventsBeforeFrustration: 1 }), seeded(5));
    core.deriveMood(fail);
    assert.equal(core.deriveMood(fail), Mood.Frustrated);
    assert.equal(core.deriveMood(pass), Mood.Relieved);
  });

  it('is mostly smug after fixing a failure', () => {
    let smug = 0;
    for (let seed = 0; seed < 200; seed++) {
      const core = new EmotionCore(cfg({ eventsBeforeFrustration: 99 }), seeded(seed));
      core.deriveMood(fail);
      if (core.deriveMood(pass) === Mood.Smug) smug++;
    }
    assert.ok(smug > 80 && smug < 160, `smug ${smug}/200`);
  });

  it('cools down and resets via mutations', () => {
    const core = new EmotionCore(cfg({ eventsBeforeFrustration: 1 }), seeded(9));
    core.deriveMood(fail);
    core.deriveMood(fail);
    assert.equal(core.emotionalState.observedNegativeEvents, 2);
    core.mutateMood({ type: MutationType.CoolDown, moodCategory: MoodCategory.Negative });
    assert.equal(core.emotionalState.observedNegativeEvents, 1);
    assert.equal(core.mutateMood({ type: MutationType.Reset, moodCategory: MoodCategory.Negative }), Mood.Calm);
    assert.equal(core.emotionalState.observedNegativeEvents, 0);
  });

  it('keeps at most 10 events of history', () => {
    const core = new EmotionCore(cfg({}), seeded(2));
    for (let i = 0; i < 25; i++) core.deriveMood(pass);
    assert.equal(core.emotionalState.previousEvents.length, 10);
  });

  it('counts negative combos', () => {
    assert.equal(comboLength([Cat.Negative, Cat.Negative, Cat.Positive, Cat.Negative]), 3);
    assert.equal(comboLength([Cat.Positive]), 1);
  });
});

describe('planReaction', () => {
  it('maps moods to meme categories', () => {
    assert.deepEqual(planReaction(fail, Mood.Frustrated, true)?.categories, [MemeCategory.Frustration]);
    assert.deepEqual(planReaction(pass, Mood.Smug, true)?.categories, [MemeCategory.Smug]);
    assert.deepEqual(planReaction(idle, Mood.Tired, true)?.categories, [MemeCategory.Tired]);
    assert.equal(planReaction(idle, Mood.Patient, true)?.dismissal, 'focusLoss');
    assert.equal(planReaction(ev(T.Silence, Cat.Neutral), Mood.Calm, true)?.sound, false);
    assert.equal(planReaction(ev(T.Task, Cat.Neutral), Mood.Calm, true), undefined);
  });

  it('only lets a different outcome replace a task meme', () => {
    const shown = planReaction(fail, Mood.Shocked, true)!;
    assert.equal(shouldReplace(shown, planReaction(fail, Mood.Shocked, true)!), false);
    assert.equal(shouldReplace(shown, planReaction(pass, Mood.Happy, true)!), true);
    assert.equal(shouldReplace(undefined, shown), true);
  });

  it('escalates idle memes but never downgrades them', () => {
    const bored = planReaction(idle, Mood.Bored, true)!;
    assert.equal(bored.comparator(planReaction(idle, Mood.Tired, true)!), Comparison.Greater);
    assert.equal(bored.comparator(planReaction(idle, Mood.Patient, true)!), Comparison.Lesser);
    assert.equal(bored.comparator(planReaction(fail, Mood.Shocked, true)!), Comparison.Greater);
  });
});
