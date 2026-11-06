// AMII meme categories. Ids match `cat` in /public/assets/visuals and the API's CATEGORY_QUERIES.
export const CATEGORIES = [
  { id: 0, name: 'acknowledgement', hint: 'nodding, thumbs up, "got it", okay gesture' },
  { id: 1, name: 'frustration', hint: 'annoyed, exasperated, head in hands, grumbling' },
  { id: 2, name: 'enraged', hint: 'furious, screaming, flipping a table, rage aura' },
  { id: 3, name: 'celebration', hint: 'cheering, dancing, victory pose, confetti' },
  { id: 4, name: 'happy', hint: 'smiling, laughing warmly, cheerful' },
  { id: 5, name: 'smug', hint: 'smirk, self-satisfied, "heh", hair flip' },
  { id: 6, name: 'waiting', hint: 'waiting around, looking at a watch, sitting idle' },
  { id: 7, name: 'motivation', hint: 'determined, fist pump, "you can do it", fired up' },
  { id: 8, name: 'welcoming', hint: 'waving hello, greeting, welcoming gesture' },
  { id: 9, name: 'departure', hint: 'waving goodbye, leaving, walking away' },
  { id: 10, name: 'encouragement', hint: 'cheering someone on, supportive, pom-poms' },
  { id: 11, name: 'mocking', hint: 'laughing at someone, pointing and laughing, teasing' },
  { id: 12, name: 'shocked', hint: 'jaw drop, wide eyes, gasp, stunned' },
  { id: 13, name: 'disappointment', hint: 'sigh, facepalm, let down, dejected' },
  { id: 14, name: 'alert', hint: 'startled, alarmed, "!" reaction, sudden attention' },
  { id: 15, name: 'bored', hint: 'yawning, slumped, uninterested, chin on hand' },
  { id: 16, name: 'tired', hint: 'sleepy, falling asleep, exhausted' },
  { id: 17, name: 'patiently_waiting', hint: 'tapping foot or fingers, waiting patiently' },
  { id: 18, name: 'pouting', hint: 'pout, puffed cheeks, sulking, "hmph"' },
] as const;

export type CategoryName = (typeof CATEGORIES)[number]['name'];
export const CATEGORY_NAMES = CATEGORIES.map((c) => c.name) as unknown as [CategoryName, ...CategoryName[]];
export const categoryId = (name: CategoryName): number => CATEGORIES.find((c) => c.name === name)!.id;
