import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'
import { createConsultationDocx } from './docx'
import { emptyTemplate, emptyVitals } from './visitTemplate'
const template = new Uint8Array(
  readFileSync(
    new URL('../../public/templates/therapist.docx', import.meta.url),
  ),
)
describe('Word export', () => {
  it('fills real OOXML, preserves untouched package parts and does not retain template clinical examples', () => {
    const values = emptyTemplate()
    values.complaints = 'Слабость & усталость <месяц> $&\nСо слов пациента.'
    const vitals = emptyVitals()
    vitals.bp = '120/80'
    const result = unzipSync(
      createConsultationDocx(template, {
        values,
        vitals,
        metadata: { date: '2026-09-30', name: '', iin: '', doctor: '' },
      }),
    )
    const xml = strFromU8(result['word/document.xml'])
    expect(xml).toContain('Слабость &amp; усталость &lt;месяц&gt; $&')
    expect(xml).toContain('<w:br/>')
    expect(xml).toContain('АД: 120/80 мм рт. ст.')
    expect(xml).toContain('30.09.2026')
    expect(xml).not.toContain('{{')
    expect(xml).not.toMatch(
      /Сорбифер|Тотема|Тардиферон|отрицает|Туберкулез нет/,
    )
    const original = unzipSync(template)
    for (const name of Object.keys(original))
      if (name !== 'word/document.xml')
        expect(result[name]).toEqual(original[name])
  })
  it('fails visibly on a missing template instead of exporting corrupt text', () => {
    expect(() =>
      createConsultationDocx(new Uint8Array(), {
        values: emptyTemplate(),
        vitals: emptyVitals(),
        metadata: { date: '', name: '', iin: '', doctor: '' },
      }),
    ).toThrow()
  })
})
