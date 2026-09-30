import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUpRight,
  AudioLines,
  Check,
  CheckCheck,
  ChevronDown,
  FileText,
  History,
  Info,
  LoaderCircle,
  Mic,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Square,
  Upload,
  X,
} from 'lucide-react'
import { useLiveTranscription } from './hooks/useLiveTranscription'
import { useVisitWorkspace, visitApi } from './hooks/useVisitWorkspace'
import { getErrorMessage, isAbortError, type Workspace } from './lib/api'
import {
  DEMO_HISTORY,
  annotateConversation,
  historyFromApi,
  mapWorkspace,
  previousRecommendations,
  type HistoryRecord,
} from './lib/visitWorkspace'
import {
  DEMO_SEGMENTS,
  FIELD_DEFINITIONS,
  FIELD_IDS,
  VITAL_DEFINITIONS,
  type FieldId,
  type PatientMetadata,
  type TemplateValues,
  type TemplateVitals,
  type TranscriptSegment,
} from './lib/visitTemplate'
import { downloadConsultation } from './lib/docx'
import { sendToMis, type MisReceipt } from './lib/mis'
import {
  AUDIO_ACCEPT,
  beginAudioUpload,
  validateAudio,
} from './lib/audioUpload'
import './styles.css'

const today = () => new Date().toLocaleDateString('en-CA')
const blankMetadata = (): PatientMetadata => ({
  date: today(),
  name: '',
  iin: '',
  doctor: '',
})
const displayDate = (date: string | null) =>
  date
    ? new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : 'Дата не указана'
const time = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}`
const speaker = (role: string) =>
  role === 'doctor' ? 'Врач' : role === 'patient' ? 'Пациент' : 'Реплика'
function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  busy?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onClose()
      }}
    >
      <header>
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          disabled={busy}
          aria-label="Закрыть окно"
        >
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  )
}
function GrowText({
  value,
  onChange,
  label,
  placeholder = 'Не озвучено',
  id,
}: {
  value: string
  onChange: (text: string) => void
  label: string
  placeholder?: string
  id?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    let mounted = true
    const resize = () => {
      if (!mounted || !element.getBoundingClientRect().width) return
      element.style.height = 'auto'
      element.style.height = `${element.scrollHeight + 2}px`
    }
    resize()
    let previousWidth = -1
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === previousWidth) return
      previousWidth = entry.contentRect.width
      resize()
    })
    observer.observe(element)
    void document.fonts.ready.then(resize)
    return () => {
      mounted = false
      observer.disconnect()
    }
  }, [value])
  return (
    <textarea
      id={id}
      ref={ref}
      rows={1}
      aria-label={label}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      maxLength={10000}
    />
  )
}
export default function App() {
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [history, setHistory] = useState<HistoryRecord[]>([])
  const [historyQuery, setHistoryQuery] = useState('')
  const [demoPlaying, setDemoPlaying] = useState(false)
  const [demoCursor, setDemoCursor] = useState(0)
  const [manual, setManual] = useState<Partial<TemplateValues>>({})
  const [manualVitals, setManualVitals] = useState<Partial<TemplateVitals>>({})
  const [metadata, setMetadata] = useState(blankMetadata)
  const [session, setSession] = useState(0)
  const [seed, setSeed] = useState<Workspace | null>(null)
  const [source, setSource] = useState<'demo' | 'real'>(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('demo') === '1' && !params.has('workspace')
      ? 'demo'
      : 'real'
  })
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [dialog, setDialog] = useState<
    'new' | 'example' | 'privacy' | 'connection' | 'mis' | null
  >(null)
  const [openedHistory, setOpenedHistory] = useState<HistoryRecord | null>(null)
  const [editing, setEditing] = useState<TranscriptSegment | null>(null)
  const [highlight, setHighlight] = useState<string[]>([])
  const [pane, setPane] = useState<'history' | 'conversation' | 'document'>(
    'conversation',
  )
  const [reviewed, setReviewed] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [sending, setSending] = useState(false)
  const [misReceipt, setMisReceipt] = useState<MisReceipt | null>(null)
  const [misError, setMisError] = useState('')
  const misRequest = useRef<{ snapshot: string; key: string } | null>(null)
  const misController = useRef<AbortController | null>(null)
  const misBusy = useRef(false)
  const [uploading, setUploading] = useState(false)
  const [starting, setStarting] = useState(false)
  const startBusy = useRef(false)
  const [pending, setPending] = useState<{
    workspaceId: string
    jobId: string
    kind: 'current' | 'history'
    title: string
  } | null>(null)
  const [proposal, setProposal] = useState<FieldId | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [capabilityError, setCapabilityError] = useState(false)
  const [following, setFollowing] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const segmentRefs = useRef(new Map<string, HTMLElement>())
  const fieldRefs = useRef(new Map<string, HTMLElement>())
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadKind = useRef<'current' | 'history'>('current')
  const uploadController = useRef<AbortController | null>(null)
  const uploadBusy = useRef(false)
  const epoch = useRef(0)
  const offset = useRef(0)
  const mounted = useRef(true)
  const live = useLiveTranscription({
    language: 'auto',
    onSegments: (incoming) => {
      setSegments((old) => [
        ...old,
        ...incoming.map((s) => ({
          ...s,
          id: crypto.randomUUID(),
          start: s.start + offset.current,
          end: s.end + offset.current,
          final: true,
        })),
      ])
      setReviewed(false)
    },
    onError: setError,
  })
  const ai = useVisitWorkspace({
    segments,
    history,
    enabled: source === 'real',
    session,
    seed,
  })
  const annotated = useMemo(() => annotateConversation(segments), [segments])
  const derived = useMemo(
    () => mapWorkspace(ai.workspace, segments),
    [segments, ai.workspace],
  )
  const values = { ...derived.values, ...manual } as TemplateValues
  const vitals = { ...derived.vitals, ...manualVitals } as TemplateVitals
  const filled = FIELD_IDS.filter(
    (id) =>
      values[id].trim() ||
      (id === 'objective_status' && Object.values(vitals).some(Boolean)),
  ).length
  const captureActive = [
    'recording',
    'paused',
    'connecting',
    'finishing',
  ].includes(live.status)
  const active = captureActive || uploading || starting || sending
  const pendingProcessing =
    !!pending || live.pendingChunks > 0 || (source === 'real' && ai.waiting)
  const demoIncomplete = source === 'demo' && demoCursor < DEMO_SEGMENTS.length
  const canExport =
    filled > 0 && !active && !pendingProcessing && !demoIncomplete
  const matchingHistory = history.filter((record) => {
    const normalize = (text: string) =>
      text.toLocaleLowerCase('ru').replaceAll('ё', 'е')
    const text = normalize(
      [
        record.title,
        record.date ?? '',
        displayDate(record.date),
        ...record.segments.map((segment) => segment.text),
      ].join(' '),
    )
    return normalize(historyQuery)
      .trim()
      .split(/\s+/)
      .every((term) => text.includes(term))
  })
  const listening = live.status === 'recording'
  const paused = live.status === 'paused'
  const seconds =
    source === 'demo'
      ? (segments.at(-1)?.end ?? 0)
      : Math.max(offset.current + live.seconds, segments.at(-1)?.end ?? 0)
  const hasContent =
    segments.length > 0 || filled > 0 || history.length > 0 || pendingProcessing
  const status = demoIncomplete
    ? demoPlaying
      ? 'Демо · идёт разговор'
      : 'Демо · на паузе'
    : listening
      ? 'Идёт запись'
      : paused
        ? 'На паузе'
        : live.status === 'finishing'
          ? 'Распознаём последние фразы'
          : uploading
            ? 'Распознаём аудиофайл'
            : segments.length
              ? 'Разговор записан'
              : 'Готов к приёму'
  async function refreshConnection() {
    try {
      const caps = await visitApi.capabilities({ timeoutMs: 8000 })
      setCapabilityError(false)
      return caps.enabled && caps.speech === 'configured_unverified'
    } catch {
      setCapabilityError(true)
      return false
    }
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      epoch.current++
      uploadController.current?.abort()
      misController.current?.abort()
    }
  }, [])
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('demo') === '1' && !params.has('workspace')) {
      example()
      return
    }
    const id = params.get('workspace')
    if (!id) return
    const controller = new AbortController()
    void visitApi
      .get(id, { signal: controller.signal })
      .then((ws) => {
        setSeed(ws)
        setHistory(
          ws.records.filter((r) => r.kind === 'history').map(historyFromApi),
        )
        setSegments(
          ws.records
            .find((r) => r.kind === 'current')
            ?.segments.map((s) => ({ ...s, final: true })) ?? [],
        )
      })
      .catch((e) => {
        if (!isAbortError(e)) setError(getErrorMessage(e))
      })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (source !== 'demo' || !demoPlaying || demoCursor >= DEMO_SEGMENTS.length)
      return
    const timer = setTimeout(
      () => {
        setSegments((old) => [...old, { ...DEMO_SEGMENTS[demoCursor] }])
        setDemoCursor((cursor) => cursor + 1)
        setReviewed(false)
        if (demoCursor + 1 === DEMO_SEGMENTS.length) setDemoPlaying(false)
      },
      demoCursor === 0
        ? 450
        : Math.min(
            3200,
            Math.max(1800, DEMO_SEGMENTS[demoCursor - 1].text.length * 18),
          ),
    )
    return () => clearTimeout(timer)
  }, [source, demoPlaying, demoCursor])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 4500)
    return () => clearTimeout(t)
  }, [toast])
  useEffect(() => {
    if (!highlight.length) return
    const t = setTimeout(() => setHighlight([]), 5500)
    return () => clearTimeout(t)
  }, [highlight])
  useEffect(() => {
    if (following && scrollRef.current)
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior:
          source === 'demo' &&
          !window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'smooth'
            : 'instant',
      })
  }, [segments, following])
  useEffect(() => {
    if (!hasContent) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasContent])
  function clearForm(clearHistory = true) {
    setSegments([])
    setDemoPlaying(false)
    setDemoCursor(0)
    setHistoryQuery('')
    setMisReceipt(null)
    setMisError('')
    misRequest.current = null
    setManual({})
    setManualVitals({})
    setMetadata(blankMetadata())
    setReviewed(false)
    setSource('real')
    setError('')
    setHighlight([])
    setFollowing(true)
    setProposal(null)
    setShowDetails(false)
    setSeed(null)
    setSession((n) => n + 1)
    if (clearHistory) setHistory([])
  }
  function reset() {
    epoch.current++
    uploadController.current?.abort()
    live.reset()
    offset.current = 0
    setPending(null)
    setUploading(false)
    clearForm()
    setDialog(null)
  }
  function example() {
    reset()
    setSource('demo')
    setHistory(DEMO_HISTORY.map((r) => ({ ...r })))
    setDemoPlaying(true)
    setDemoCursor(0)
    setFollowing(true)
    setPane('conversation')
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0 }))
  }
  async function start() {
    if (startBusy.current || uploadBusy.current) return
    startBusy.current = true
    setStarting(true)
    const own = epoch.current
    try {
      if (!(await refreshConnection())) {
        if (mounted.current && own === epoch.current) setDialog('connection')
        return
      }
      if (!mounted.current || own !== epoch.current) return
      const nextOffset = source === 'demo' ? 0 : seconds
      if (
        live.status === 'finished' ||
        (live.status === 'error' && !live.pendingChunks)
      )
        live.reset()
      offset.current = nextOffset
      if (await live.start('unknown')) {
        if (source === 'demo') clearForm()
        setReviewed(false)
        setPane('conversation')
      }
    } finally {
      startBusy.current = false
      if (mounted.current) setStarting(false)
    }
  }
  function pause() {
    if (live.status === 'paused') void live.resume()
    else live.pause()
  }
  async function stop() {
    await live.stop()
  }
  function editField(id: FieldId, value: string) {
    setManual((old) => ({ ...old, [id]: value }))
    setReviewed(false)
  }
  function reveal(id: FieldId) {
    const ids = [
      ...derived.sources[id],
      ...(id === 'objective_status'
        ? Object.values(derived.vitalSources).flat()
        : []),
    ]
    if (!ids.length) return
    setPane('conversation')
    setHighlight(ids)
    setFollowing(false)
    requestAnimationFrame(() =>
      segmentRefs.current
        .get(ids[0])
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    )
  }
  async function processAudio(file?: File) {
    if (uploadBusy.current || captureActive) return
    const kind = uploadKind.current
    try {
      if (file) validateAudio(file)
      if (file && kind === 'history' && history.length >= 10)
        throw new Error('В истории уже 10 записей. Начните новый приём.')
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Не удалось прочитать файл.',
      )
      return
    }
    uploadBusy.current = true
    const own = epoch.current
    const abort = new AbortController()
    uploadController.current = abort
    setUploading(true)
    setReviewed(false)
    setError('')
    let task = pending
    try {
      if (file) {
        if (!(await refreshConnection())) {
          setDialog('connection')
          return
        }
        if (own !== epoch.current || abort.signal.aborted) return
        const accepted = await beginAudioUpload(visitApi, file, abort.signal)
        if (own !== epoch.current || !mounted.current) {
          void visitApi.remove(accepted.workspaceId).catch(() => {})
          return
        }
        task = { ...accepted, kind, title: file.name }
        setPending(task)
      }
      if (!task) return
      const ws = await visitApi.pollAudioJob(task.workspaceId, task.jobId, {
        signal: abort.signal,
      })
      if (own !== epoch.current || !mounted.current) return
      const job = ws.jobs.find((j) => j.id === task!.jobId)
      const record = ws.records.find((r) => r.id === job?.record_id)
      if (!record) throw new Error('Распознанная запись не найдена.')
      const next = record.segments.map((s) => ({ ...s, final: true }))
      if (source === 'demo') clearForm()
      if (task.kind === 'history')
        setHistory((old) => [
          ...old,
          {
            id: record.id,
            title: task!.title,
            date: record.visit_date ?? null,
            segments: next,
          },
        ])
      else
        setSegments((old) => [
          ...old,
          ...next.map((s) => ({
            ...s,
            start: s.start + (source === 'demo' ? 0 : seconds),
            end: s.end + (source === 'demo' ? 0 : seconds),
          })),
        ])
      setPending(null)
      void visitApi.remove(task.workspaceId).catch(() => {})
      setToast('Запись распознана. Бланк обновляется автоматически.')
    } catch (e) {
      if (!isAbortError(e) && own === epoch.current) {
        setError(getErrorMessage(e))
        if (
          e instanceof Error &&
          'code' in e &&
          [
            'TRANSCRIPTION_FAILED',
            'WORKSPACE_EXPIRED',
            'WORKSPACE_NOT_FOUND',
            'JOB_NOT_FOUND',
          ].includes(String(e.code))
        ) {
          setPending(null)
          if (task) void visitApi.remove(task.workspaceId).catch(() => {})
        }
      }
    } finally {
      uploadBusy.current = false
      if (own === epoch.current) setUploading(false)
    }
  }
  function chooseAudio(kind: 'current' | 'history') {
    uploadKind.current = kind
    fileRef.current?.click()
  }
  async function exportWord() {
    if (!canExport || !reviewed) return
    setExporting(true)
    try {
      await downloadConsultation({ values, vitals, metadata })
      setToast('Документ Word подготовлен. Его можно открыть и распечатать.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось подготовить Word.')
    } finally {
      setExporting(false)
    }
  }
  async function exportMis() {
    if (!canExport || !reviewed || misBusy.current) return
    const document = { metadata, fields: values, vitals }
    const snapshot = JSON.stringify(document)
    if (misRequest.current?.snapshot !== snapshot)
      misRequest.current = { snapshot, key: crypto.randomUUID() }
    const own = epoch.current
    const controller = new AbortController()
    misController.current = controller
    const timeout = setTimeout(() => controller.abort(), 15000)
    misBusy.current = true
    setSending(true)
    setMisReceipt(null)
    setMisError('')
    setDialog('mis')
    try {
      const receipt = await sendToMis(document, {
        demo: source === 'demo',
        idempotencyKey: misRequest.current.key,
        endpoint: import.meta.env.VITE_MIS_EXPORT_URL,
        signal: controller.signal,
      })
      if (mounted.current && epoch.current === own) setMisReceipt(receipt)
    } catch (reason) {
      if (mounted.current && epoch.current === own)
        setMisError(
          isAbortError(reason)
            ? 'МИС не ответила вовремя. Перед повтором проверьте статус отправки.'
            : getErrorMessage(reason),
        )
    } finally {
      clearTimeout(timeout)
      misBusy.current = false
      if (mounted.current && epoch.current === own) setSending(false)
    }
  }
  function newVisit() {
    if (source === 'real' && segments.length) {
      const r: HistoryRecord = {
        id: crypto.randomUUID(),
        title: 'Консультация терапевта',
        date: metadata.date,
        segments: annotated,
      }
      setHistory((old) => [r, ...old].slice(0, 10))
    }
    live.reset()
    offset.current = 0
    clearForm(source === 'demo')
    setDialog(null)
    setPane('conversation')
  }
  return (
    <div className="app-shell">
      <header className="topbar">
        <a href="#main" className="brand">
          <span className="brand-icon">
            <AudioLines size={25} />
          </span>
          <h1>MedRep</h1>
        </a>
        <div className="visit-actions">
          <div className="record-actions">
            {starting ? (
              <button className="button primary" disabled>
                <LoaderCircle size={22} className="spin" />
                Подключаем…
              </button>
            ) : uploading ? (
              <button className="button primary" disabled>
                <LoaderCircle size={22} className="spin" />
                Распознаём…
              </button>
            ) : active ? (
              <>
                <button
                  className="button secondary pause-button"
                  aria-label={paused ? 'Продолжить запись' : 'Пауза'}
                  title={paused ? 'Продолжить запись' : 'Пауза'}
                  disabled={
                    uploading ||
                    live.status === 'finishing' ||
                    live.status === 'connecting'
                  }
                  onClick={pause}
                >
                  {paused ? <Play size={17} /> : <Pause size={17} />}
                  <span>{paused ? 'Продолжить' : 'Пауза'}</span>
                </button>
                <button
                  className="button primary"
                  disabled={
                    uploading ||
                    live.status === 'finishing' ||
                    live.status === 'connecting'
                  }
                  onClick={() => void stop()}
                >
                  {live.status === 'finishing' || uploading ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <Square size={14} />
                  )}
                  Завершить запись
                </button>
              </>
            ) : (
              <>
                <button
                  className="button primary start-button"
                  disabled={!!pending || live.pendingChunks > 0}
                  onClick={() => void start()}
                >
                  <Mic size={18} />
                  {segments.length && source !== 'demo'
                    ? 'Продолжить запись'
                    : 'Начать запись'}
                </button>
              </>
            )}
          </div>
          <button
            className="button secondary upload-button"
            disabled={active || !!pending || live.pendingChunks > 0}
            onClick={() => chooseAudio('current')}
          >
            <Upload size={20} />
            Добавить аудио
          </button>
        </div>

        <div className="utility-actions">
          {source === 'demo' && (
            <span
              className="demo-badge"
              title="Учебный пример. Все данные вымышлены."
            >
              Демо
            </span>
          )}
          {hasContent && (
            <button
              className="icon-button"
              aria-label="Новый приём"
              title="Новый приём"
              disabled={active || !!pending || live.pendingChunks > 0}
              onClick={() => setDialog('new')}
            >
              <Plus size={21} />
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Об обработке данных"
            title="Об обработке данных"
            onClick={() => setDialog('privacy')}
          >
            <Info size={19} />
          </button>
        </div>
      </header>
      <main id="main">
        <nav className="mobile-panes" aria-label="Рабочие панели">
          {(
            [
              ['history', 'История', History],
              ['conversation', 'Разговор', AudioLines],
              ['document', 'Бланк', FileText],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              className={pane === id ? 'selected' : ''}
              aria-pressed={pane === id}
              onClick={() => setPane(id)}
            >
              <Icon size={16} />
              {label}
              <small>
                {id === 'history'
                  ? history.length
                  : id === 'conversation'
                    ? segments.length
                    : `${filled}/13`}
              </small>
            </button>
          ))}
        </nav>
        <div className={`workspace-grid active-${pane}`}>
          <aside
            className="panel history-panel"
            aria-label="История записей и рекомендаций"
          >
            <header className="panel-heading">
              <div>
                <span>
                  <h2>История</h2>
                </span>
              </div>
              <span className="count-badge">{history.length}</span>
            </header>
            <div className="history-search">
              <Search size={18} />
              <input
                type="search"
                aria-label="Поиск в истории"
                placeholder="Поиск в истории"
                value={historyQuery}
                onChange={(event) => setHistoryQuery(event.target.value)}
              />
              {historyQuery && (
                <button
                  className="icon-button"
                  aria-label="Очистить поиск"
                  onClick={() => setHistoryQuery('')}
                >
                  <X size={16} />
                </button>
              )}
            </div>
            <div className="history-scroll">
              {history.length === 0 ? (
                <div className="history-empty">
                  <div className="empty-icon">
                    <History size={26} />
                  </div>
                  <h3>История приёмов</h3>
                  <p>Здесь будут прошлые записи и рекомендации.</p>
                </div>
              ) : (
                <>
                  {matchingHistory.length === 0 && (
                    <div className="history-empty">
                      <h3>Ничего не найдено</h3>
                      <p>Попробуйте другое слово или дату.</p>
                    </div>
                  )}
                  {matchingHistory.map((record) => (
                    <article className="history-card" key={record.id}>
                      <div className="history-date">
                        <span>{displayDate(record.date)}</span>
                      </div>
                      <button
                        className="history-title"
                        onClick={() => setOpenedHistory(record)}
                      >
                        {record.title}
                        <ArrowUpRight size={15} />
                      </button>
                      <p>{record.segments[0]?.text}</p>
                      {previousRecommendations(record).length > 0 && (
                        <div className="past-recommendations">
                          <span>
                            <CheckCheck size={14} />
                            Прошлые рекомендации
                          </span>
                          {previousRecommendations(record).map((s) => (
                            <p key={s.id}>{s.text}</p>
                          ))}
                        </div>
                      )}
                    </article>
                  ))}
                </>
              )}
            </div>
            <footer className="history-footer">
              <button
                className="text-button"
                disabled={active || !!pending}
                onClick={() => chooseAudio('history')}
              >
                <Plus size={18} />
                Добавить прошлую запись
              </button>
            </footer>
          </aside>
          <section
            className="panel conversation-panel"
            aria-label="Транскрипция разговора"
          >
            <header className="panel-heading">
              <div>
                <span>
                  <h2>Разговор</h2>
                </span>
              </div>
              {source === 'demo' && (
                <button
                  className="demo-control"
                  aria-label={
                    demoIncomplete
                      ? demoPlaying
                        ? 'Приостановить демо'
                        : 'Продолжить демо'
                      : 'Повторить демо'
                  }
                  onClick={() =>
                    demoIncomplete
                      ? setDemoPlaying((playing) => !playing)
                      : example()
                  }
                  disabled={active}
                >
                  {demoIncomplete ? (
                    demoPlaying ? (
                      <Pause size={15} />
                    ) : (
                      <Play size={15} />
                    )
                  ) : (
                    <RotateCcw size={15} />
                  )}
                  {demoIncomplete
                    ? demoPlaying
                      ? 'Пауза'
                      : 'Продолжить'
                    : 'Повторить'}
                </button>
              )}
            </header>
            <div className="conversation-status">
              <span>
                <span
                  className={`status-dot ${listening || demoPlaying ? 'pulse' : ''}`}
                />
                {status}
              </span>
              <time>{time(seconds)}</time>
            </div>
            <div
              className="transcript-scroll"
              ref={scrollRef}
              onScroll={() => {
                const el = scrollRef.current
                if (el)
                  setFollowing(
                    el.scrollHeight - el.scrollTop - el.clientHeight < 70,
                  )
              }}
            >
              {!segments.length &&
                !captureActive &&
                !uploading &&
                !demoPlaying && (
                  <div className="conversation-empty">
                    <div className="mic-orbit">
                      <Mic size={31} />
                      <span />
                      <span />
                    </div>
                    <h3>
                      {demoIncomplete ? 'Демо на паузе' : 'Готовы слушать'}
                    </h3>
                    <p>
                      {demoIncomplete
                        ? 'Нажмите «Продолжить».'
                        : 'Начните запись или добавьте аудио.'}
                    </p>
                  </div>
                )}
              {annotated.map((segment) => {
                return (
                  <article
                    className={`utterance ${source === 'demo' ? 'demo-utterance' : ''} ${segment.role} ${highlight.includes(segment.id) ? 'source-highlight' : ''}`}
                    key={segment.id}
                    ref={(el) => {
                      if (el) segmentRefs.current.set(segment.id, el)
                      else segmentRefs.current.delete(segment.id)
                    }}
                  >
                    <div className="utterance-body">
                      <div className="utterance-meta">
                        <strong>{speaker(segment.role)}</strong>
                        <time>{time(segment.start)}</time>
                        <button
                          className="icon-button edit-utterance"
                          aria-label={`Исправить реплику: ${segment.text.slice(0, 45)}`}
                          onClick={() => setEditing(segment)}
                        >
                          <Pencil size={13} />
                        </button>
                      </div>
                      <p>{segment.text}</p>
                    </div>
                  </article>
                )
              })}
              {(listening || demoPlaying) && (
                <div className="interim" role="status">
                  <span className="interim-dot" />
                  <p>
                    {demoPlaying ? 'Следующая реплика' : 'Слушаем…'}
                    <span className="typing-cursor" />
                  </p>
                </div>
              )}
              {segments.length > 0 &&
                !listening &&
                !paused &&
                !active &&
                !demoIncomplete && (
                  <div className="transcript-end">
                    <CheckCircle />
                    Готово
                  </div>
                )}
            </div>
            {!following && segments.length > 0 && (active || demoPlaying) && (
              <button
                className="follow-button"
                onClick={() => {
                  setFollowing(true)
                  scrollRef.current?.scrollTo({
                    top: scrollRef.current.scrollHeight,
                    behavior: 'smooth',
                  })
                }}
              >
                <ArrowDown size={13} />К последней реплике
              </button>
            )}
            {(error || live.status === 'error' || (pending && !uploading)) && (
              <div className="inline-error" role="alert">
                <Info size={16} />
                <div>
                  {error || 'Остались необработанные аудиофрагменты.'}
                  {live.pendingChunks > 0 && live.status === 'error' && (
                    <button
                      className="text-button"
                      onClick={() => {
                        setError('')
                        void live.retry()
                      }}
                    >
                      Повторить распознавание
                    </button>
                  )}
                  {pending && !uploading && (
                    <button
                      className="text-button"
                      onClick={() => void processAudio()}
                    >
                      Продолжить обработку файла
                    </button>
                  )}
                </div>
                {error && (
                  <button
                    className="icon-button"
                    aria-label="Закрыть сообщение"
                    onClick={() => setError('')}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            )}
          </section>
          <section
            className="panel document-panel"
            aria-label="Бланк консультации"
          >
            <header className="panel-heading">
              <div>
                <span>
                  <h2>Бланк</h2>
                </span>
              </div>
              <span
                className={`document-status ${listening || demoPlaying || ai.busy ? 'updating' : reviewed ? 'reviewed' : ''}`}
              >
                {listening || demoPlaying || ai.busy ? (
                  <>
                    <Sparkles size={12} />
                    Заполняется
                  </>
                ) : reviewed ? (
                  <>
                    <Check size={12} />
                    Проверен
                  </>
                ) : (
                  'Черновик'
                )}
              </span>
            </header>
            <div className="document-scroll">
              <div className="paper">
                <div className="paper-top">
                  <h3>Осмотр терапевта/ВОП на приёме</h3>
                  <p>Дата: {displayDate(metadata.date)}</p>
                  <div className="paper-person">
                    <span>
                      ФИО: {metadata.name || '____________________________'}
                    </span>
                    <span>ИИН: {metadata.iin || '________________'}</span>
                  </div>
                  <button
                    className="metadata-toggle"
                    aria-expanded={showDetails}
                    onClick={() => setShowDetails(!showDetails)}
                  >
                    <Pencil size={11} />
                    Данные пациента и врача
                    <ChevronDown size={12} />
                  </button>
                  {showDetails && (
                    <div className="metadata-editor">
                      {(
                        [
                          ['name', 'ФИО'],
                          ['iin', 'ИИН'],
                          ['doctor', 'Врач'],
                          ['date', 'Дата'],
                        ] as const
                      ).map(([id, label]) => (
                        <label key={id}>
                          {label}
                          <input
                            type={id === 'date' ? 'date' : 'text'}
                            value={metadata[id]}
                            onChange={(e) => {
                              setMetadata((old) => ({
                                ...old,
                                [id]: e.target.value,
                              }))
                              setReviewed(false)
                            }}
                          />
                        </label>
                      ))}
                      <p>
                        Заполняются из карточки пациента при подключении МИС.
                        Здесь можно исправить.
                      </p>
                    </div>
                  )}
                </div>
                {FIELD_DEFINITIONS.map((field) => {
                  const edited = Object.hasOwn(manual, field.id)
                  const differs =
                    edited &&
                    values[field.id] !== derived.values[field.id] &&
                    !!derived.values[field.id]
                  return (
                    <section
                      className={`paper-field ${values[field.id] ? 'filled' : ''} ${edited ? 'edited' : ''}`}
                      key={field.id}
                      ref={(el) => {
                        if (el) fieldRefs.current.set(field.id, el)
                        else fieldRefs.current.delete(field.id)
                      }}
                    >
                      <div className="paper-field-heading">
                        <label htmlFor={`form-${field.id}`}>
                          {field.id === 'objective_status'
                            ? 'Status praesens / Объективный статус'
                            : field.label}
                          :
                        </label>
                        {edited ? (
                          <span
                            className="manual-mark"
                            title="Ручная правка сохранится при обновлении"
                          >
                            Ваша правка
                          </span>
                        ) : derived.sources[field.id].length > 0 ||
                          (field.id === 'objective_status' &&
                            Object.values(vitals).some(Boolean)) ? (
                          <button
                            className="source-button"
                            title="Показать исходную реплику"
                            aria-label={`Источник: ${field.label}`}
                            onClick={() => reveal(field.id)}
                          >
                            <AudioLines size={12} />
                          </button>
                        ) : null}
                      </div>
                      {field.id === 'objective_status' && (
                        <div className="paper-vitals">
                          {VITAL_DEFINITIONS.map((v) => (
                            <label key={v.id}>
                              <span>{v.label}</span>
                              <input
                                aria-label={`${v.label}, ${v.unit}`}
                                value={vitals[v.id]}
                                placeholder="—"
                                onChange={(e) => {
                                  setManualVitals((old) => ({
                                    ...old,
                                    [v.id]: e.target.value,
                                  }))
                                  setReviewed(false)
                                }}
                              />
                              <small>{v.unit}</small>
                            </label>
                          ))}
                        </div>
                      )}
                      <GrowText
                        id={`form-${field.id}`}
                        label={field.label}
                        value={values[field.id]}
                        onChange={(v) => editField(field.id, v)}
                      />
                      {differs && (
                        <button
                          className="compare-button"
                          onClick={() =>
                            setProposal(proposal === field.id ? null : field.id)
                          }
                        >
                          <Sparkles size={11} />
                          Есть текст из разговора — сравнить
                        </button>
                      )}
                      {proposal === field.id && (
                        <div className="proposal">
                          <p>{derived.values[field.id]}</p>
                          <button
                            className="text-button"
                            onClick={() => {
                              setManual((old) => {
                                const next = { ...old }
                                delete next[field.id]
                                return next
                              })
                              setProposal(null)
                              setReviewed(false)
                            }}
                          >
                            Взять из разговора
                          </button>
                          <button
                            className="text-button"
                            onClick={() => setProposal(null)}
                          >
                            Оставить мою правку
                          </button>
                        </div>
                      )}
                    </section>
                  )
                })}
                <div className="paper-signature">
                  <strong>Врач: </strong>
                  {metadata.doctor || '____________________________'}
                </div>
              </div>
            </div>
            <footer className="document-footer">
              {ai.error && source === 'real' && (
                <div className="ai-error" role="alert">
                  {ai.error}
                  <button className="text-button" onClick={ai.retry}>
                    Повторить заполнение
                  </button>
                </div>
              )}
              <div className="review-line">
                <label>
                  <input
                    type="checkbox"
                    checked={reviewed}
                    disabled={!canExport}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  Проверено
                </label>
              </div>
              <div className="export-actions">
                <button
                  className="button secondary"
                  disabled={!reviewed || !canExport || exporting}
                  onClick={() => void exportWord()}
                  aria-label="Скачать Word"
                >
                  {exporting ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <ArrowDownToLine size={17} />
                  )}
                  Word
                </button>
                <button
                  className="button primary"
                  disabled={!reviewed || !canExport || exporting}
                  onClick={() => void exportMis()}
                >
                  {sending ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <Send size={17} />
                  )}
                  Отправить в МИС
                </button>
              </div>
            </footer>
          </section>
        </div>
      </main>
      <input
        ref={fileRef}
        type="file"
        accept={AUDIO_ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void processAudio(file)
        }}
      />
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
      {dialog === 'mis' && (
        <Modal
          title={
            sending
              ? 'Отправляем в МИС…'
              : misReceipt?.mode === 'demo'
                ? 'Демо-отправка'
                : misReceipt
                  ? 'Отправлено в МИС'
                  : 'Отправка в МИС'
          }
          onClose={() => setDialog(null)}
          busy={sending}
        >
          <div className="mis-result" role="status">
            {sending ? (
              <LoaderCircle size={32} className="spin" />
            ) : misReceipt ? (
              <CheckCheck size={32} />
            ) : (
              <Info size={32} />
            )}
            <p>
              {sending
                ? 'Ожидаем подтверждение.'
                : misReceipt?.mode === 'demo'
                  ? 'Сценарий отправки показан. В настоящую МИС данные не передавались.'
                  : misReceipt
                    ? `МИС подтвердила получение. Квитанция: ${misReceipt.receipt_id}`
                    : misError}
            </p>
          </div>
          {!sending && (
            <div className="modal-actions">
              <button
                className="button primary"
                onClick={() => setDialog(null)}
              >
                Понятно
              </button>
            </div>
          )}
        </Modal>
      )}
      {(dialog === 'new' || dialog === 'example') && (
        <Modal
          title={
            dialog === 'new'
              ? 'Начать следующий приём?'
              : 'Открыть учебный пример?'
          }
          onClose={() => setDialog(null)}
        >
          <p className="modal-intro">
            {dialog === 'new'
              ? 'Текущий разговор останется в истории этой вкладки. Перед началом сохраните готовый бланк в Word.'
              : 'Учебный пример заменит текущие данные в этой вкладке. Сохраните бланк перед переходом.'}
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setDialog(null)}
            >
              Остаться
            </button>
            <button
              className="button primary"
              onClick={dialog === 'new' ? newVisit : example}
            >
              {dialog === 'new' ? 'Следующий приём' : 'Открыть пример'}
            </button>
          </div>
          {dialog === 'new' && (
            <button className="new-patient" onClick={reset}>
              Другой пациент — очистить историю и начать заново
            </button>
          )}
        </Modal>
      )}
      {dialog === 'connection' && (
        <Modal
          title="Подключение к распознаванию"
          onClose={() => setDialog(null)}
        >
          <div className="connection-illustration">
            <AudioLines size={31} />
          </div>
          <h3>
            {capabilityError
              ? 'Нет связи с сервером'
              : 'Сервер речи ещё не подключён к этому интерфейсу'}
          </h3>
          <p className="modal-intro">
            Когда подключение будет настроено, достаточно нажать «Начать
            запись». Язык определяется автоматически, дополнительных настроек
            для врача нет.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => {
                void refreshConnection().then((ok) => {
                  ai.retry()
                  if (ok) {
                    setDialog(null)
                    setToast('Распознавание подключено. Можно начинать приём.')
                  }
                })
              }}
            >
              <RotateCcw size={15} />
              Проверить связь
            </button>
            <button
              className="button primary"
              onClick={() => (hasContent ? setDialog('example') : example())}
            >
              <Play size={15} />
              Посмотреть пример
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'privacy' && (
        <Modal title="Обработка данных приёма" onClose={() => setDialog(null)}>
          <div className="privacy-content">
            <p>
              Микрофон включается только после нажатия «Начать запись».
              Записывайте разговор с согласия пациента.
            </p>
            <p>
              Аудио передаётся настроенному серверу распознавания. Если на
              backend включён OpenAI, текст разговора и выбранная история
              автоматически передаются туда для заполнения бланка. Полная
              автоматическая деперсонализация в текущем backend не реализована.
            </p>
            <p>
              Для этого прототипа используйте обезличенные или учебные записи.
              Документ Word создаётся в браузере. Перезагрузка страницы удаляет
              несохранённый бланк и историю вкладки; временные серверные сессии
              живут до часа.
            </p>
            <p>
              Роли говорящих распознаются по доступным данным и явным речевым
              признакам; неоднозначные реплики не превращаются в назначения.
              Врач проверяет итоговый документ.
            </p>
          </div>
          <button
            className="button primary full-width"
            onClick={() => setDialog(null)}
          >
            Понятно
          </button>
        </Modal>
      )}
      {openedHistory && (
        <Modal
          title={openedHistory.title}
          onClose={() => setOpenedHistory(null)}
        >
          <p className="modal-intro">
            {displayDate(openedHistory.date)}
            {openedHistory.synthetic ? ' · Учебная запись' : ''}
          </p>
          <div className="history-full">
            {openedHistory.segments.map((s) => (
              <p key={s.id}>
                <strong>{speaker(s.role)}: </strong>
                {s.text}
              </p>
            ))}
          </div>
          <div className="notice">
            Это прошлая запись. Она не заменяет сведения сегодняшнего приёма.
          </div>
        </Modal>
      )}
      {editing && (
        <Modal title="Исправить расшифровку" onClose={() => setEditing(null)}>
          <p className="modal-intro">
            После исправления бланк обновится. Ручные правки в документе
            сохранятся.
          </p>
          <textarea
            className="large-textarea"
            aria-label="Текст реплики"
            value={editing.text}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            maxLength={10000}
          />
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setEditing(null)}
            >
              Отмена
            </button>
            <button
              className="button primary"
              disabled={!editing.text.trim()}
              onClick={() => {
                setSegments((old) =>
                  old.map((s) =>
                    s.id === editing.id
                      ? { ...editing, text: editing.text.trim() }
                      : s,
                  ),
                )
                setReviewed(false)
                setEditing(null)
              }}
            >
              Сохранить исправление
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
function CheckCircle() {
  return (
    <span className="small-check">
      <Check size={10} />
    </span>
  )
}
