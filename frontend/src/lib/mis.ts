import { ApiError } from './api'
import type {
  PatientMetadata,
  TemplateValues,
  TemplateVitals,
} from './visitTemplate'

export interface MisDocument {
  metadata: PatientMetadata
  fields: TemplateValues
  vitals: TemplateVitals
}
export interface MisReceipt {
  mode: 'demo' | 'sent'
  receipt_id: string
}

/** The team's MIS gateway is optional. Never use the workspace download as proof of delivery. */
export async function sendToMis(
  document: MisDocument,
  options: {
    demo: boolean
    idempotencyKey: string
    endpoint?: string
    signal?: AbortSignal
    fetcher?: typeof fetch
  },
): Promise<MisReceipt> {
  if (options.demo) return { mode: 'demo', receipt_id: options.idempotencyKey }
  if (!options.endpoint?.trim())
    throw new ApiError(
      503,
      'MIS_NOT_CONFIGURED',
      'МИС пока не подключена. Бланк можно скачать в Word.',
    )
  const response = await (options.fetcher ?? fetch)(options.endpoint.trim(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': options.idempotencyKey,
    },
    body: JSON.stringify({ ...document, reviewed: true }),
    signal: options.signal,
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (!response.ok)
    throw new ApiError(
      response.status,
      'MIS_SEND_FAILED',
      'МИС не подтвердила отправку. Бланк сохранён на экране.',
    )
  const result: unknown = await response.json().catch(() => null)
  if (
    !result ||
    typeof result !== 'object' ||
    !('status' in result) ||
    result.status !== 'sent' ||
    !('receipt_id' in result) ||
    typeof result.receipt_id !== 'string' ||
    !result.receipt_id.trim()
  )
    throw new ApiError(
      502,
      'MIS_UNCONFIRMED',
      'Подтверждение от МИС не получено. Проверьте статус перед повторной отправкой.',
    )
  return { mode: 'sent', receipt_id: result.receipt_id }
}
