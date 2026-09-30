import { describe, expect, it, vi } from 'vitest'
import { sendToMis, type MisDocument } from './mis'
import { emptyTemplate, emptyVitals } from './visitTemplate'

const document: MisDocument = {
  metadata: { date: '2026-09-30', name: '', iin: '', doctor: '' },
  fields: {
    ...emptyTemplate(),
    complaints: 'Учебная запись',
    treatment: 'Правка врача',
  },
  vitals: { ...emptyVitals(), bp: '120/80' },
}

describe('MIS delivery', () => {
  it('never sends the synthetic demo to a configured real endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const receipt = await sendToMis(document, {
      demo: true,
      endpoint: '/api/mis/export',
      idempotencyKey: 'demo-key',
      fetcher,
    })
    expect(receipt.mode).toBe('demo')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('requires configuration instead of pretending the document was sent', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(
      sendToMis(document, { demo: false, idempotencyKey: 'key', fetcher }),
    ).rejects.toMatchObject({ code: 'MIS_NOT_CONFIGURED' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('sends all reviewed fields and vitals with the supplied idempotency key', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ status: 'sent', receipt_id: 'receipt-1' }),
      )
    expect(
      await sendToMis(document, {
        demo: false,
        endpoint: '/api/mis/export',
        idempotencyKey: 'stable-key',
        fetcher,
      }),
    ).toEqual({ mode: 'sent', receipt_id: 'receipt-1' })
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('/api/mis/export')
    expect(init?.headers).toMatchObject({ 'Idempotency-Key': 'stable-key' })
    expect(JSON.parse(init!.body as string)).toEqual({
      ...document,
      reviewed: true,
    })
  })

  it.each([
    { mode: 'local_download', workspace_id: 'workspace' },
    { mode: 'mock', external_id: 'mock-1' },
    { status: 'queued', receipt_id: 'job-1' },
    { status: 'sent', receipt_id: '' },
  ])(
    'does not confuse a download, mock or incomplete acknowledgement with MIS delivery: %j',
    async (body) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(body))
      await expect(
        sendToMis(document, {
          demo: false,
          endpoint: '/api/mis/export',
          idempotencyKey: 'key',
          fetcher,
        }),
      ).rejects.toMatchObject({ code: 'MIS_UNCONFIRMED' })
    },
  )

  it('preserves a failed delivery as an error and does not retry automatically', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { status: 503 }))
    await expect(
      sendToMis(document, {
        demo: false,
        endpoint: '/api/mis/export',
        idempotencyKey: 'key',
        fetcher,
      }),
    ).rejects.toMatchObject({ code: 'MIS_SEND_FAILED' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
