/**
 * Spoken or typed agendas for meeting mode:
 *   "agenda: pricing 15, timeline 10, next steps 5"
 *   "pricing fifteen minutes and timeline ten, then next steps five"
 * Each item is a title followed (or preceded) by its minutes, in digits or
 * words. Items without minutes are dropped.
 */
export type AgendaItem = { title: string; minutes: number }

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60 }

/** Number words to digits: "twenty five" -> "25", "half an hour" -> "30". */
function wordsToDigits(text: string): string {
  return text
    .replace(/\bhalf an hour\b/gi, '30')
    .replace(/\ban hour\b/gi, '60')
    .replace(
      /\b(twenty|thirty|forty|fifty|sixty)(?:[\s-]+(one|two|three|four|five|six|seven|eight|nine))?\b/gi,
      (_m, t: string, u?: string) => String(TENS[t.toLowerCase()] + (u ? UNITS[u.toLowerCase()] : 0)),
    )
    .replace(
      /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/gi,
      (w) => String(UNITS[w.toLowerCase()]),
    )
}

export function parseAgenda(text: string): AgendaItem[] {
  const body = wordsToDigits(text)
    // "Q and A", "R and D": one item, not two halves split at "and".
    .replace(/\b([a-z])\s+(?:and|&)\s+([a-z])\b/gi, (_m, a: string, b: string) => `${a.toUpperCase()}&${b.toUpperCase()}`)
    .replace(/^.*?\bagenda\b\s*(?:is|:)?\s*/i, '')
    .replace(/[.!?]+$/, '')
  const items: AgendaItem[] = []
  for (const chunk of body.split(/\s*(?:[,;]|\band then\b|\bthen\b|\band\b)\s*/i)) {
    const m =
      /^(.*?)\s*(?:for\s+)?(\d{1,3})\s*(?:m|min|mins|minutes?)?$/i.exec(chunk.trim()) ??
      /^(\d{1,3})\s*(?:m|min|mins|minutes?)?\s+(?:of\s+|on\s+)?(.+)$/i.exec(chunk.trim())
    if (!m) continue
    const [title, minutes] = /^\d/.test(m[1]) ? [m[2], Number(m[1])] : [m[1], Number(m[2])]
    const clean = title.replace(/^(?:item|then|and)\s+/i, '').replace(/\s+/g, ' ').trim()
    if (clean && minutes > 0 && minutes <= 240) items.push({ title: clean, minutes })
  }
  return items
}

/** "Pricing, fifteen minutes; timeline, ten minutes" for reading back. */
export function describeAgenda(items: AgendaItem[]): string {
  return items.map((i) => `${i.title}, ${i.minutes} minute${i.minutes === 1 ? '' : 's'}`).join('; ')
}
