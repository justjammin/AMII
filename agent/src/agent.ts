import Anthropic from '@anthropic-ai/sdk';
import { CATEGORIES } from './categories';
import { ManifestEntry } from './manifest';
import { Character, CharacterSession, makeTools, SessionOptions } from './tools';

export interface AgentOptions extends Omit<SessionOptions, 'knownIds'> {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** How many new GIFs to aim for per character. */
  target: number;
  minConfidence: number;
  maxIterations: number;
}

export interface CharacterResult {
  character: Character;
  entries: ManifestEntry[];
  searches: number;
  shown: number;
  stopReason: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  summary: string;
}

// Kept byte-for-byte stable across characters so the system prompt + tools prefix is cached.
export const SYSTEM_PROMPT = `You curate anime reaction GIFs for AMII, an editor plugin where an anime character reacts to a developer's work: celebrating passing tests, getting frustrated at failing builds, getting bored while they're idle.

Your job for each request: find GIFs on GIPHY that show one specific character, look at each candidate's first frame, and record the ones that are clearly that character, tagged with the AMII reaction categories they fit.

What to accept:
- The named character is the clear main subject, from the anime itself (official animation, or edits and subtitled clips of it).
- Skip cosplay, live action, AI renders, fan art in a noticeably different style, and other characters from the same show. Titles and uploader names are often wrong or generic, so judge mainly from the frame. If you can't tell it's the right character, skip it: a wrong character is worse than a missing GIF.
- Skip anything sexual or suggestive, and frames dominated by unrelated text or watermarks.
- A first frame doesn't show the whole GIF. Tag what the frame and title make clear, and lower your confidence when the reaction is ambiguous.

AMII categories (use 1-3 per GIF, most fitting first):
${CATEGORIES.map((c) => `- ${c.name}: ${c.hint}`).join('\n')}

How to work:
- Start with the character's name plus the anime title, then search name + emotion for categories you haven't covered yet. Page with offset when a query keeps giving good results.
- Record accepted GIFs with record_gifs as you go, so nothing is lost if you run out of searches.
- Aim for variety across categories rather than many GIFs of one reaction.
- Stop when you reach the target, run out of searches, or results stop turning up the character. Then reply with one or two sentences: how many you recorded and which categories are still thin.`;

export function userPrompt(character: Character, target: number, maxSearches: number, alreadyHave: number): string {
  return [
    `Character: ${character.name}`,
    `Anime: ${character.anime}`,
    `AMII character id: ${character.id}`,
    `Already in the manifest: ${alreadyHave} GIFs (they won't appear in your results).`,
    `Target: up to ${target} new GIFs. Search budget: ${maxSearches} searches.`,
  ].join('\n');
}

export async function runCharacter(
  client: Anthropic,
  character: Character,
  knownIds: ReadonlySet<string>,
  opts: AgentOptions,
): Promise<CharacterResult> {
  const session = new CharacterSession(character, { ...opts, knownIds });
  const runner = client.beta.messages.toolRunner({
    model: opts.model,
    max_tokens: 16000,
    max_iterations: opts.maxIterations,
    thinking: { type: 'adaptive' },
    output_config: { effort: opts.effort },
    // Route policy declines to a suitable fallback model instead of failing the character.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    // Auto-cache the growing prefix (system + tools + earlier turns, including the images).
    cache_control: { type: 'ephemeral' },
    system: SYSTEM_PROMPT,
    tools: makeTools(session),
    messages: [{ role: 'user', content: userPrompt(character, opts.target, opts.maxSearches, knownIds.size) }],
  });

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let last: Anthropic.Beta.BetaMessage | undefined;
  for await (const message of runner) {
    last = message;
    usage.input += message.usage.input_tokens;
    usage.output += message.usage.output_tokens;
    usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;
  }

  const stopReason = last?.stop_reason ?? null;
  const summary =
    stopReason === 'refusal'
      ? `Declined (${last?.stop_details?.category ?? 'unknown'}); keeping ${session.accepted.size} GIFs recorded before that.`
      : (last?.content ?? [])
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
          .trim();

  const now = new Date().toISOString();
  const model = last?.model ?? opts.model;
  const entries: ManifestEntry[] = [...session.accepted.values()]
    .filter((a) => a.confidence >= opts.minConfidence)
    .map((a) => ({
      giphyId: a.gif.id,
      characterId: character.id,
      characterName: character.name,
      anime: character.anime,
      cat: a.cat,
      confidence: Math.round(a.confidence * 100) / 100,
      reason: a.reason,
      url: a.gif.url,
      still: a.gif.still,
      page: a.gif.page,
      rating: a.gif.rating,
      addedAt: now,
      model,
    }));

  return { character, entries, searches: session.searches, shown: session.shown.size, stopReason, usage, summary };
}
