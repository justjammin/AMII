import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Miku, MikuSettings, Timers } from '../src/core/miku';
import { Reaction } from '../src/core/personality';
import { DEFAULT_EMOTION_CONFIG, Mood, UserEventCategory as Cat, UserEventType as T } from '../src/core/types';
import { seeded } from './helpers';

class FakeTimers implements Timers {
  private now = 0;
  private queue: { at: number; fn: () => void; id: number }[] = [];
  private next = 0;
  setTimeout(fn: () => void, ms: number) {
    const id = this.next++;
    this.queue.push({ at: this.now + ms, fn, id });
    return id;
  }
  clearTimeout(id: unknown) {
    this.queue = this.queue.filter((t) => t.id !== id);
  }
  /** Runs timers in order, including ones scheduled by timers, up to `now + ms`. */
  advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      const due = this.queue.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.now = due.at;
      this.clearTimeout(due.id);
      due.fn();
    }
    this.now = until;
  }
}

const settings = (overrides: Partial<MikuSettings> = {}): MikuSettings => ({
  ...DEFAULT_EMOTION_CONFIG,
  probabilityOfFrustration: 100,
  soundEnabled: true,
  discreetMode: false,
  enabledEvents: new Set(Object.values(T)),
  ...overrides,
});

function setup(overrides: Partial<MikuSettings> = {}) {
  const timers = new FakeTimers();
  const reactions: Reaction[] = [];
  const moods: Mood[] = [];
  const miku = new Miku(settings(overrides), { react: (r) => reactions.push(r), onMood: (m) => moods.push(m) }, seeded(11), timers);
  return { miku, timers, reactions, moods };
}

const fail = { type: T.Test, category: Cat.Negative, name: 'tests' };
const pass = { type: T.Test, category: Cat.Positive, name: 'tests' };

describe('Miku', () => {
  it('debounces bursts of events into one reaction', () => {
    const { miku, timers, reactions } = setup();
    miku.dispatch(fail);
    miku.dispatch(fail);
    miku.dispatch(pass);
    timers.advance(100);
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0].event.category, Cat.Positive);
  });

  it('stays quiet in discreet mode and for disabled events', () => {
    const quiet = setup({ discreetMode: true });
    quiet.miku.dispatch(fail);
    quiet.timers.advance(100);
    assert.equal(quiet.reactions.length, 0);

    const noTests = setup({ enabledEvents: new Set([T.Task]) });
    noTests.miku.dispatch(fail);
    noTests.timers.advance(100);
    assert.equal(noTests.reactions.length, 0);
  });

  it('minimal mode only reacts when the outcome changes', () => {
    const { miku, timers, reactions } = setup({ minimalMode: true });
    for (const e of [fail, fail, fail, pass, pass]) {
      miku.dispatch(e);
      timers.advance(100);
    }
    assert.deepEqual(reactions.map((r) => r.event.category), [Cat.Negative, Cat.Positive]);
  });

  it('cools down from frustration over time', () => {
    const { miku, timers } = setup({ eventsBeforeFrustration: 1 });
    for (let i = 0; i < 3; i++) {
      miku.dispatch(fail);
      timers.advance(100);
    }
    assert.ok([Mood.Frustrated, Mood.Enraged].includes(miku.mood));
    timers.advance(10 * 60 * 1000);
    assert.equal(miku.mood, Mood.Calm);
  });

  it('relax resets the mood and acknowledges it', () => {
    const { miku, timers, reactions } = setup({ eventsBeforeFrustration: 1 });
    miku.dispatch(fail);
    timers.advance(100);
    miku.relax();
    assert.equal(miku.mood, Mood.Calm);
    assert.equal(reactions.at(-1)?.event.type, T.Relax);
  });
});
