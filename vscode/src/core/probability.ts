import { Mood, Rng } from './types';

const TOTAL_WEIGHT = 100;

export type Weighted<T> = ReadonlyArray<readonly [T, number]>;

/** Integer in [min, max). Mirrors kotlin.random.Random.nextLong(from, until). */
export function nextInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min));
}

function shuffled<T>(items: T[], rng: Rng): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pickWithRoll<T>(roll: number, weighted: Weighted<T>): T | undefined {
  let remaining = roll;
  for (const [item, weight] of weighted) {
    if (remaining <= weight) return item;
    remaining -= weight;
  }
  return weighted.find(([, w]) => w > 0)?.[0];
}

export class ProbabilityTools {
  constructor(private readonly rng: Rng) {}

  pickFromWeightedList<T>(weighted: Weighted<T>): T | undefined {
    const total = weighted.reduce((sum, [, w]) => sum + w, 0);
    return pickWithRoll(nextInt(this.rng, 1, total <= 1 ? 2 : total), weighted);
  }

  /**
   * Primary emotions share `probabilityOfPrimary` (0..100) of the weight;
   * the remainder is split evenly between the secondary emotions.
   */
  pickEmotion(probabilityOfPrimary: number, primary: Weighted<Mood>, secondary: readonly Mood[]): Mood {
    const clamped = Math.max(0, Math.min(TOTAL_WEIGHT, probabilityOfPrimary));
    const secondaryWeight = Math.floor((TOTAL_WEIGHT - clamped) / secondary.length);
    const weighted = shuffled(
      [...primary, ...secondary.map((m) => [m, secondaryWeight] as const)],
      this.rng,
    );
    return pickWithRoll(nextInt(this.rng, 1, TOTAL_WEIGHT), weighted) ?? weighted[0][0];
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rng() * items.length)];
  }
}
