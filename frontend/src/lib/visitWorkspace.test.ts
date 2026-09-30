import { describe, it, expect } from 'vitest'
import {
  annotateConversation,
  mapWorkspace,
  DEMO_HISTORY,
  relatedHistory,
  previousRecommendations,
} from './visitWorkspace'
import type { TranscriptSegment } from './visitTemplate'
function s(
  text: string,
  role: TranscriptSegment['role'] = 'unknown',
): TranscriptSegment {
  return { id: crypto.randomUUID(), role, text, start: 0, end: 1, final: true }
}
describe('automatic frontend adapter', () => {
  it('shows explicit recommendations from uploaded history without moving them into the current form', () => {
    const record = {
      id: 'history',
      title: 'Прошлый приём',
      date: null,
      segments: [
        s('Рекомендации: контроль анализов.'),
        s('Мне назначали железо месяц назад.'),
      ],
    }
    expect(previousRecommendations(record).map((item) => item.text)).toEqual([
      'Рекомендации: контроль анализов.',
    ])
    expect(
      mapWorkspace(null, [s('Беспокоит слабость.')]).values.recommendations,
    ).toBe('')
  })
  it('keeps patient-reported past prescriptions out of current treatment', () => {
    const input = [s('Мне назначали железо месяц назад.')]
    expect(annotateConversation(input)[0].role).toBe('patient')
    expect(mapWorkspace(null, input).values.treatment).toBe('')
  })
  it('does not guess ambiguous roles but recognizes explicit dictated sections', () => {
    expect(annotateConversation([s('Нужно посмотреть.')])[0].role).toBe(
      'unknown',
    )
    const result = mapWorkspace(null, [
      s('Жалобы: слабость.\nПлан обследования: ферритин.'),
    ])
    expect(result.values.complaints).toContain('слабость')
    expect(result.values.examination_plan).toContain('ферритин')
  })
  it('finds prior anemia sources without copying historical numbers to current examination', () => {
    const current = [s('Ранее была анемия.', 'patient')]
    expect(relatedHistory(DEMO_HISTORY, current, null)).toHaveLength(2)
    expect(mapWorkspace(null, current).values.laboratory_results).toBe('')
  })
  it('uses a patient answer after a doctor question without requiring role controls', () => {
    const input = [
      s('Как давно появились эти жалобы?'),
      s('Около двух месяцев.'),
    ]
    expect(annotateConversation(input).map((i) => i.role)).toEqual([
      'doctor',
      'patient',
    ])
  })
})
