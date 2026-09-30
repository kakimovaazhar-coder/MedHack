import { useEffect, useRef, useState } from 'react'
import {
  createMedHubClient,
  getErrorMessage,
  isAbortError,
  type Capabilities,
  type RecordInput,
  type Workspace,
} from '../lib/api'
import { annotateConversation, type HistoryRecord } from '../lib/visitWorkspace'
import type { TranscriptSegment } from '../lib/visitTemplate'

export const API_BASE =
  import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE_URL || '/api'
export const visitApi = createMedHubClient(API_BASE)
type Input = {
  segments: TranscriptSegment[]
  history: HistoryRecord[]
  enabled: boolean
  session: number
  seed?: Workspace | null
}
const fingerprint = (input: Input) =>
  JSON.stringify([input.session, input.segments, input.history])
/** One serial worker, latest snapshot wins. No overlapping revisioned mutations or stale UI results. */
export function useVisitWorkspace(input: Input) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  const [capabilityError, setCapabilityError] = useState('')
  const [checking, setChecking] = useState(true)
  const [result, setResult] = useState<{
    key: string
    workspace: Workspace
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retryCount, retry] = useState(0)
  const latest = useRef(input)
  latest.current = input
  const remote = useRef<Workspace | null>(null)
  const worker = useRef(false)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const done = useRef('')
  const key = fingerprint(input)
  useEffect(() => {
    if (!input.enabled) {
      setChecking(false)
      return
    }
    const abort = new AbortController()
    setChecking(true)
    setCapabilityError('')
    void visitApi
      .capabilities({ signal: abort.signal })
      .then((value) => {
        if (abort.signal.aborted) return
        setCapabilities(value)
        if (!value.enabled)
          setCapabilityError(
            'Сервис заполнения недоступен. Повторите подключение.',
          )
      })
      .catch((reason) => {
        if (!abort.signal.aborted) {
          setCapabilities(null)
          setCapabilityError(getErrorMessage(reason))
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setChecking(false)
      })
    return () => abort.abort()
  }, [retryCount, input.enabled])
  useEffect(() => {
    generation.current++
    controller.current?.abort()
    remote.current = input.seed ?? null
    done.current = ''
    worker.current = false
    setResult(null)
    setBusy(false)
    setError('')
    return () => {
      generation.current++
      controller.current?.abort()
    }
  }, [input.session, input.seed])
  useEffect(() => {
    if (!input.enabled || !input.segments.length || !capabilities?.enabled)
      return
    const timer = setTimeout(() => void pump(), 800)
    return () => clearTimeout(timer)
    async function pump() {
      if (worker.current) return
      const own = generation.current
      worker.current = true
      setBusy(true)
      setError('')
      const abort = new AbortController()
      controller.current = abort
      const opts = { signal: abort.signal }
      let attemptedKey = ''
      try {
        while (own === generation.current && latest.current.enabled) {
          const snapshot = latest.current
          const snapshotKey = fingerprint(snapshot)
          attemptedKey = snapshotKey
          if (snapshotKey === done.current || !snapshot.segments.length) break
          let ws = remote.current
            ? await visitApi.get(remote.current.id, opts)
            : await visitApi.create(opts)
          remote.current = ws
          const inputs: RecordInput[] = [
            ...snapshot.history.map((h) => ({
              title: h.title,
              kind: 'history' as const,
              visit_date: h.date,
              segments: annotateConversation(h.segments).map(
                ({ final: _, ...s }) => s,
              ),
            })),
            {
              title: 'Текущий приём',
              kind: 'current',
              segments: annotateConversation(snapshot.segments).map(
                ({ final: _, ...s }) => s,
              ),
            },
          ]
          // Segment IDs are stable across retries; recover an accepted mutation from GET.
          for (const record of inputs) {
            const existing = ws.records.find((r) =>
              record.kind === 'current'
                ? r.kind === 'current'
                : r.kind === 'history' &&
                  r.segments.some((s) =>
                    record.segments.some((next) => next.id === s.id),
                  ),
            )
            if (existing) {
              const same =
                JSON.stringify(
                  existing.segments.map(({ speaker_id: _, ...s }) => s),
                ) ===
                JSON.stringify(
                  record.segments.map(({ speaker_id: _, ...s }) => s),
                )
              if (!same)
                ws = await visitApi.editRecord(ws, existing.id, record, opts)
            } else ws = await visitApi.addRecord(ws, record, opts)
            remote.current = ws
          }
          ws = await visitApi.analyze(
            ws,
            {
              engine: capabilities!.engine,
              allow_cloud_processing: capabilities!.cloud_llm,
              focus: '',
            },
            opts,
          )
          remote.current = ws
          done.current = snapshotKey
          if (
            own === generation.current &&
            snapshotKey === fingerprint(latest.current)
          )
            setResult({ key: snapshotKey, workspace: ws })
        }
      } catch (reason) {
        if (own === generation.current && !isAbortError(reason))
          setError(getErrorMessage(reason))
      } finally {
        if (own === generation.current) {
          worker.current = false
          setBusy(false)
          if (attemptedKey && attemptedKey !== fingerprint(latest.current))
            retry((n) => n + 1)
        }
      }
    }
  }, [key, input.enabled, capabilities, retryCount])
  return {
    capabilities,
    workspace: result?.key === key ? result.workspace : null,
    busy,
    waiting:
      input.enabled &&
      input.segments.length > 0 &&
      (checking ||
        !!capabilityError ||
        (!!capabilities?.enabled && result?.key !== key)),
    error:
      input.enabled && input.segments.length ? error || capabilityError : '',
    retry: () => retry((n) => n + 1),
  }
}
