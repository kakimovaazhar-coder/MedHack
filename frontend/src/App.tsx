import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUpRight,
  AudioLines,
  Check,
  CheckCheck,
  ChevronDown,
  Clock3,
  Copy,
  FilePlus2,
  FileText,
  History,
  Info,
  LoaderCircle,
  Mic,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Stethoscope,
  Upload,
  X,
} from 'lucide-react'
import { useLiveTranscription } from './hooks/useLiveTranscription'
import {
  API_BASE,
  useVisitWorkspace,
  visitApi,
} from './hooks/useVisitWorkspace'
import { getErrorMessage, isAbortError, type Workspace } from './lib/api'
import {
  DEMO_HISTORY,
  annotateConversation,
  historyFromApi,
  mapWorkspace,
  previousRecommendations,
  relatedHistory,
  type HistoryRecord,
} from './lib/visitWorkspace'
import {
  ANEMIA_QUESTIONS,
  DEMO_SEGMENTS,
  FIELD_DEFINITIONS,
  FIELD_IDS,
  VITAL_DEFINITIONS,
  formatTemplate,
  type FieldId,
  type PatientMetadata,
  type TemplateValues,
  type TemplateVitals,
  type TranscriptSegment,
} from './lib/visitTemplate'
import { downloadConsultation } from './lib/docx'
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
    if (ref.current) {
      ref.current.style.height = 'auto'
      ref.current.style.height = ref.current.scrollHeight + 'px'
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
  const [manual, setManual] = useState<Partial<TemplateValues>>({})
  const [manualVitals, setManualVitals] = useState<Partial<TemplateVitals>>({})
  const [metadata, setMetadata] = useState(blankMetadata)
  const [session, setSession] = useState(0)
  const [seed, setSeed] = useState<Workspace | null>(null)
  const [source, setSource] = useState<'demo' | 'real'>('real')
  const [demo, setDemo] = useState<'idle' | 'playing' | 'paused' | 'finished'>(
    'idle',
  )
  const [cursor, setCursor] = useState({ index: 0, words: 0 })
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [dialog, setDialog] = useState<
    'text' | 'history' | 'new' | 'example' | 'privacy' | 'connection' | null
  >(null)
  const [text, setText] = useState('')
  const [historyTitle, setHistoryTitle] = useState('Предыдущая консультация')
  const [historyDate, setHistoryDate] = useState('')
  const [openedHistory, setOpenedHistory] = useState<HistoryRecord | null>(null)
  const [editing, setEditing] = useState<TranscriptSegment | null>(null)
  const [highlight, setHighlight] = useState<string[]>([])
  const [pane, setPane] = useState<'history' | 'conversation' | 'document'>(
    'conversation',
  )
  const [historyFilter, setHistoryFilter] = useState<'all' | 'related'>('all')
  const [search, setSearch] = useState('')
  const [menu, setMenu] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [pending, setPending] = useState<{
    workspaceId: string
    jobId: string
    kind: 'current' | 'history'
    title: string
  } | null>(null)
  const [proposal, setProposal] = useState<FieldId | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [speechReady, setSpeechReady] = useState(false)
  const [capabilityError, setCapabilityError] = useState(false)
  const [following, setFollowing] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const segmentRefs = useRef(new Map<string, HTMLElement>())
  const fieldRefs = useRef(new Map<string, HTMLElement>())
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadKind = useRef<'current' | 'history'>('current')
  const uploadController = useRef<AbortController | null>(null)
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
  const related = useMemo(
    () => relatedHistory(history, segments, ai.workspace),
    [history, segments, ai.workspace],
  )
  const displayedHistory = (
    historyFilter === 'related' ? related : history
  ).filter((r) =>
    `${r.title} ${r.segments.map((s) => s.text).join(' ')}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  )
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
  const demoActive = demo === 'playing' || demo === 'paused'
  const active = captureActive || demoActive || uploading
  const pendingProcessing =
    !!pending || live.pendingChunks > 0 || (source === 'real' && ai.waiting)
  const canExport = filled > 0 && !active && !pendingProcessing
  const listening = demo === 'playing' || live.status === 'recording'
  const paused = demo === 'paused' || live.status === 'paused'
  const currentDemo = DEMO_SEGMENTS[cursor.index]
  const interim =
    demoActive && currentDemo
      ? currentDemo.text.split(/\s+/).slice(0, cursor.words).join(' ')
      : ''
  const seconds =
    source === 'demo'
      ? currentDemo
        ? currentDemo.start +
          (currentDemo.end - currentDemo.start) *
            Math.min(1, cursor.words / currentDemo.text.split(/\s+/).length)
        : (DEMO_SEGMENTS.at(-1)?.end ?? 0)
      : Math.max(offset.current + live.seconds, segments.at(-1)?.end ?? 0)
  const hasContent =
    segments.length > 0 || filled > 0 || history.length > 0 || pendingProcessing
  const status =
    demo === 'playing'
      ? 'Учебный разговор'
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
  const engineLabel =
    source === 'demo'
      ? 'Учебный пример'
      : ai.busy
        ? 'Заполняем по разговору'
        : ai.capabilities?.engine === 'openai'
          ? 'AI подключён'
          : 'Предпросмотр · локальные правила'

  async function refreshConnection() {
    try {
      const response = await fetch(`${API_BASE}/live/capabilities`, {
        cache: 'no-store',
      })
      if (!response.ok && ![404, 405].includes(response.status))
        throw new Error()
      const caps = response.ok
        ? await response.json()
        : await visitApi.capabilities()
      setSpeechReady(caps.enabled && caps.speech === 'configured_unverified')
      setCapabilityError(false)
      return caps.enabled && caps.speech === 'configured_unverified'
    } catch {
      setCapabilityError(true)
      setSpeechReady(false)
      return false
    }
  }
  useEffect(() => {
    mounted.current = true
    void refreshConnection()
    return () => {
      mounted.current = false
      epoch.current++
      uploadController.current?.abort()
    }
  }, [])
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('workspace')
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
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [segments, interim, following])
  useEffect(() => {
    if (!hasContent) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasContent])
  useEffect(() => {
    if (demo !== 'playing') return
    if (!currentDemo) {
      setDemo('finished')
      return
    }
    const words = currentDemo.text.split(/\s+/).length
    const timer = setTimeout(
      () => {
        if (cursor.words >= words) {
          setSegments((old) => [...old, { ...currentDemo }])
          setCursor({ index: cursor.index + 1, words: 0 })
        } else
          setCursor((old) => ({
            ...old,
            words: Math.min(words, old.words + 2),
          }))
      },
      cursor.words >= words ? 700 : 140,
    )
    return () => clearTimeout(timer)
  }, [demo, cursor, currentDemo])
  function clearForm(clearHistory = true) {
    setSegments([])
    setManual({})
    setManualVitals({})
    setMetadata(blankMetadata())
    setReviewed(false)
    setDemo('idle')
    setCursor({ index: 0, words: 0 })
    setSource('real')
    setError('')
    setHighlight([])
    setFollowing(true)
    setProposal(null)
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
    setDemo('playing')
    setPane('conversation')
  }
  function finishExample() {
    setSegments((old) =>
      DEMO_SEGMENTS.map(
        (s) => old.find((item) => item.id === s.id) ?? { ...s },
      ),
    )
    setCursor({ index: DEMO_SEGMENTS.length, words: 0 })
    setDemo('finished')
  }
  async function start() {
    if (!(await refreshConnection())) {
      setDialog('connection')
      return
    }
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
  }
  function pause() {
    if (demoActive) setDemo(demo === 'paused' ? 'playing' : 'paused')
    else if (live.status === 'paused') void live.resume()
    else live.pause()
  }
  async function stop() {
    if (demoActive) setDemo('finished')
    else await live.stop()
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
  function jump(id: FieldId) {
    setPane('document')
    requestAnimationFrame(() =>
      fieldRefs.current
        .get(id)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    )
  }
  function addText() {
    if (!text.trim()) return
    const item: TranscriptSegment = {
      id: crypto.randomUUID(),
      role: 'unknown',
      text: text.trim(),
      start: seconds,
      end: seconds + 1,
      final: true,
    }
    if (dialog === 'history') {
      if (history.length >= 10) {
        setError('В одной сессии можно использовать до 10 прошлых записей.')
        return
      }
      if (source === 'demo') {
        clearForm()
        setHistory([
          {
            id: crypto.randomUUID(),
            title: historyTitle.trim() || 'Предыдущая запись',
            date: historyDate || null,
            segments: [item],
          },
        ])
      } else
        setHistory((old) => [
          ...old,
          {
            id: crypto.randomUUID(),
            title: historyTitle.trim() || 'Предыдущая запись',
            date: historyDate || null,
            segments: [item],
          },
        ])
    } else {
      if (source === 'demo') {
        clearForm()
        item.start = 0
        item.end = 1
      }
      setSegments((old) => [...old, item])
      setReviewed(false)
    }
    setDialog(null)
    setText('')
  }
  async function processAudio(file?: File) {
    if (uploading) return
    if (file && file.size > 30 * 1024 * 1024) {
      setError('Максимальный размер файла — 30 МБ.')
      return
    }
    if (file && uploadKind.current === 'history' && history.length >= 10) {
      setError('Доступно до 10 прошлых записей на сессию.')
      return
    }
    if (file && !(await refreshConnection())) {
      setDialog('connection')
      return
    }
    const own = epoch.current
    const abort = new AbortController()
    uploadController.current = abort
    setUploading(true)
    setReviewed(false)
    setError('')
    let task = pending
    try {
      if (file) {
        const ws = await visitApi.create({ signal: abort.signal })
        const job = await visitApi.uploadAudio(
          ws,
          file,
          { title: file.name, kind: 'current', language: 'auto' },
          { signal: abort.signal },
        )
        task = {
          workspaceId: ws.id,
          jobId: job.id,
          kind: uploadKind.current,
          title: file.name,
        }
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
            'JOB_NOT_FOUND',
          ].includes(String(e.code))
        ) {
          setPending(null)
          if (task) void visitApi.remove(task.workspaceId).catch(() => {})
        }
      }
    } finally {
      if (own === epoch.current) setUploading(false)
    }
  }
  function chooseAudio(kind: 'current' | 'history') {
    uploadKind.current = kind
    setMenu(false)
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
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        formatTemplate({ values, vitals, metadata }),
      )
      setToast('Бланк скопирован.')
    } catch {
      setError('Браузер не разрешил копирование. Используйте файл Word.')
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
            <Stethoscope size={24} />
          </span>
          <span>
            MedScribe<small>АССИСТЕНТ ВРАЧА</small>
          </span>
        </a>
        <div className="topbar-center">
          <span className="online-dot" />
          Рабочее место врача
        </div>
        <button
          className="privacy-button"
          aria-label="Об обработке данных"
          onClick={() => setDialog('privacy')}
        >
          <ShieldCheck size={17} />
          <span>Обработка данных</span>
        </button>
      </header>
      <main id="main">
        <div className="visit-heading">
          <div>
            <div className="eyebrow">
              МЕНЬШЕ БУМАГ · БОЛЬШЕ ВНИМАНИЯ ПАЦИЕНТУ
            </div>
            <h1>Вы ведёте приём. Мы заполняем бланк.</h1>
            <p>История под рукой, разговор превращается в готовый документ.</p>
          </div>
          <div className="visit-actions">
            <button
              className="button secondary"
              disabled={active}
              onClick={() => (hasContent ? setDialog('example') : example())}
            >
              <Play size={15} />
              Пример приёма
            </button>
            <button
              className="button quiet"
              disabled={active || !!pending || live.pendingChunks > 0}
              onClick={() => (hasContent ? setDialog('new') : reset())}
            >
              <Plus size={17} />
              Новый приём
            </button>
          </div>
        </div>
        <div className="visit-strip">
          <span>
            <span className={`status-dot ${listening ? 'pulse' : ''}`} />
            {status}
          </span>
          <span>
            <Clock3 size={13} />
            {displayDate(metadata.date)}
          </span>
          <span className="visit-strip-right">
            Осмотр терапевта / ВОП
            {source === 'demo' && <b className="demo-badge">ДЕМО</b>}
          </span>
        </div>
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
                <History size={19} />
                <h2>История пациента</h2>
              </div>
              <span className="count-badge">{history.length}</span>
            </header>
            <div className="history-tools">
              <label className="search">
                <Search size={15} />
                <input
                  aria-label="Поиск в истории"
                  placeholder="Найти в истории"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <div className="segmented">
                <button
                  className={historyFilter === 'all' ? 'selected' : ''}
                  onClick={() => setHistoryFilter('all')}
                >
                  Все записи
                </button>
                <button
                  className={historyFilter === 'related' ? 'selected' : ''}
                  onClick={() => setHistoryFilter('related')}
                >
                  По разговору <small>{related.length}</small>
                </button>
              </div>
            </div>
            <div className="history-scroll">
              {history.length === 0 ? (
                <div className="history-empty">
                  <div className="empty-icon">
                    <History size={26} />
                  </div>
                  <h3>Вся история рядом</h3>
                  <p>
                    Прошлые консультации, анализы и рекомендации появятся здесь
                    из подключённой истории.
                  </p>
                  <button
                    className="text-button"
                    onClick={() => {
                      setText('')
                      setDialog('history')
                    }}
                  >
                    <Plus size={14} />
                    Добавить прошлую запись
                  </button>
                </div>
              ) : (
                <>
                  {source === 'demo' && (
                    <div className="history-demo-note">
                      Синтетическая история для примера
                    </div>
                  )}
                  {displayedHistory.length === 0 && (
                    <div className="small-empty">
                      Подходящих записей не найдено.
                    </div>
                  )}
                  {displayedHistory.map((record) => (
                    <article
                      className={`history-card ${related.includes(record) ? 'related' : ''}`}
                      key={record.id}
                    >
                      <div className="history-date">
                        <span>{displayDate(record.date)}</span>
                        {related.includes(record) && (
                          <span
                            className="related-mark"
                            title="Связано с текущим разговором"
                          >
                            <Sparkles size={12} />
                          </span>
                        )}
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
                            Рекомендации тогда
                          </span>
                          {previousRecommendations(record).map((s) => (
                            <p key={s.id}>{s.text}</p>
                          ))}
                        </div>
                      )}
                      <button
                        className="history-source"
                        onClick={() => setOpenedHistory(record)}
                      >
                        Открыть запись <ArrowUpRight size={12} />
                      </button>
                    </article>
                  ))}
                </>
              )}
              {history.length > 0 && (
                <div className="history-footnote">
                  <Info size={14} />
                  <p>
                    Прошлые назначения — для контекста. В сегодняшний бланк они
                    не переносятся автоматически.
                  </p>
                </div>
              )}
            </div>
            <footer className="history-footer">
              <button
                className="button secondary"
                disabled={active || !!pending}
                onClick={() => {
                  setText('')
                  setDialog('history')
                }}
              >
                <FilePlus2 size={15} />
                Добавить запись
              </button>
              <button
                className="icon-button"
                aria-label="Добавить прошлую аудиозапись"
                disabled={active || !!pending}
                onClick={() => chooseAudio('history')}
              >
                <Upload size={17} />
              </button>
            </footer>
          </aside>
          <section
            className="panel conversation-panel"
            aria-label="Транскрипция разговора"
          >
            <header className="panel-heading">
              <div>
                <span className="heading-icon">
                  <AudioLines size={20} />
                </span>
                <span>
                  <h2>Разговор</h2>
                  <small>Расшифровка в реальном времени</small>
                </span>
              </div>
              <div className="menu-anchor">
                <button
                  className="icon-button"
                  aria-label="Добавить материалы"
                  disabled={active || !!pending || live.pendingChunks > 0}
                  onClick={() => setMenu(!menu)}
                >
                  <MoreHorizontal size={20} />
                </button>
                {menu && (
                  <div className="dropdown">
                    <button
                      onClick={() => {
                        setText('')
                        setDialog('text')
                        setMenu(false)
                      }}
                    >
                      <FileText size={15} />
                      Вставить текст
                    </button>
                    <button onClick={() => chooseAudio('current')}>
                      <Upload size={15} />
                      Загрузить аудио
                    </button>
                  </div>
                )}
              </div>
            </header>
            <div className="conversation-status">
              <span>
                <span className={`status-dot ${listening ? 'pulse' : ''}`} />
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
                !demoActive &&
                !captureActive &&
                !uploading && (
                  <div className="conversation-empty">
                    <div className="mic-orbit">
                      <Mic size={31} />
                      <span />
                      <span />
                    </div>
                    <h3>Просто начните разговор</h3>
                    <p>
                      Говорите с пациентом как обычно.
                      <br />
                      Расшифровка появится здесь, а бланк справа заполнится по
                      её содержанию.
                    </p>
                    <div className="automatic-note">
                      <Sparkles size={14} />
                      Язык определяется автоматически
                    </div>
                  </div>
                )}
              {annotated.map((segment) => {
                const fields = FIELD_IDS.filter((id) =>
                  derived.sources[id].includes(segment.id),
                )
                return (
                  <article
                    className={`utterance ${segment.role} ${highlight.includes(segment.id) ? 'source-highlight' : ''}`}
                    key={segment.id}
                    ref={(el) => {
                      if (el) segmentRefs.current.set(segment.id, el)
                      else segmentRefs.current.delete(segment.id)
                    }}
                  >
                    <div className="utterance-avatar">
                      {segment.role === 'doctor' ? (
                        <Stethoscope size={15} />
                      ) : segment.role === 'patient' ? (
                        <span>П</span>
                      ) : (
                        <AudioLines size={15} />
                      )}
                    </div>
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
                      {fields.length > 0 && (
                        <div className="mapped-fields">
                          {fields.map((id) => (
                            <button key={id} onClick={() => jump(id)}>
                              <Check size={11} />
                              {
                                FIELD_DEFINITIONS.find((f) => f.id === id)
                                  ?.label
                              }
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </article>
                )
              })}
              {(interim || listening) && (
                <div className="interim">
                  <span className="interim-dot" />
                  <p>
                    {interim ||
                      'Слушаем… Новая реплика появится после короткой фразы.'}
                    <span className="typing-cursor" />
                  </p>
                </div>
              )}
              {segments.length > 0 && !listening && !paused && !active && (
                <div className="transcript-end">
                  <CheckCircle />
                  Расшифровка сохранена в этой вкладке
                </div>
              )}
            </div>
            {!following && segments.length > 0 && (
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
            <footer className="recorder-footer">
              <div className="audio-strip">
                <div
                  className={`audio-meter ${listening ? 'active' : ''}`}
                  aria-hidden="true"
                >
                  {Array.from({ length: 30 }, (_, i) => (
                    <span
                      key={i}
                      style={{
                        height: `${listening ? 5 + Math.abs(Math.sin(i * 1.5 + seconds)) * (source === 'demo' ? 17 : 6 + live.level * 32) : 3 + Math.abs(Math.sin(i * 1.5)) * 3}px`,
                      }}
                    />
                  ))}
                </div>
                <span>
                  {source === 'demo'
                    ? 'Учебный разговор'
                    : listening
                      ? 'Язык: авто · запись включена'
                      : 'Микрофон выключен'}
                </span>
              </div>
              <div className="record-actions">
                {active ? (
                  <>
                    <button
                      className="button secondary pause-button"
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
                      {segments.length ? 'Продолжить запись' : 'Начать приём'}
                    </button>
                    <button
                      className="button secondary"
                      aria-label="Вставить текст разговора"
                      disabled={!!pending || live.pendingChunks > 0}
                      onClick={() => {
                        setText('')
                        setDialog('text')
                      }}
                    >
                      <FileText size={18} />
                    </button>
                  </>
                )}
              </div>
              {demoActive ? (
                <button className="skip-demo" onClick={finishExample}>
                  Показать пример целиком <ArrowUpRight size={12} />
                </button>
              ) : (
                <p className="record-notice">
                  {source === 'demo' ? (
                    'Пример работает без микрофона.'
                  ) : speechReady ? (
                    'Начинайте запись с согласия пациента.'
                  ) : (
                    <button onClick={() => setDialog('connection')}>
                      Микрофон готов к подключению сервера
                    </button>
                  )}
                </p>
              )}
            </footer>
          </section>
          <section
            className="panel document-panel"
            aria-label="Бланк консультации"
          >
            <header className="panel-heading">
              <div>
                <FileText size={20} />
                <span>
                  <h2>Бланк консультации</h2>
                  <small>По вашему шаблону Word</small>
                </span>
              </div>
              <span
                className={`document-status ${listening || ai.busy ? 'updating' : ''}`}
              >
                {listening || ai.busy ? (
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
            <div className="document-toolbar">
              <span>
                <span className="word-icon">W</span>Осмотр терапевта / ВОП.docx
              </span>
              <span>{filled}/13</span>
            </div>
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
                    onClick={() => setShowDetails(!showDetails)}
                  >
                    <Pencil size={11} />
                    Реквизиты документа
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
              <div className="document-help">
                <Info size={13} />
                <p>
                  Неозвученные сведения остаются пустыми. Любую запись можно
                  исправить прямо в бланке.
                </p>
              </div>
              <details className="question-checklist">
                <summary>
                  Подсказки для сбора анамнеза анемии <ChevronDown size={13} />
                </summary>
                <ul>
                  {ANEMIA_QUESTIONS.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </details>
            </div>
            <footer className="document-footer">
              <div className="engine-status">
                <Sparkles size={13} />
                <span>{engineLabel}</span>
                {ai.busy && <LoaderCircle size={13} className="spin" />}
              </div>
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
                  Бланк проверен, можно выдать пациенту
                </label>
              </div>
              <div className="export-actions">
                <button
                  className="button primary"
                  disabled={!reviewed || !canExport || exporting}
                  onClick={() => void exportWord()}
                >
                  {exporting ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <ArrowDownToLine size={17} />
                  )}
                  Скачать Word
                </button>
                <button
                  className="button secondary"
                  disabled={!reviewed || !canExport}
                  onClick={() => void copy()}
                  aria-label="Скопировать бланк"
                >
                  <Copy size={17} />
                </button>
              </div>
              <p>Откройте файл в Word и распечатайте</p>
            </footer>
          </section>
        </div>
        <footer className="page-footer">
          <span>
            <ShieldCheck size={12} />
            Документ остаётся доступным в текущей вкладке
          </span>
          <button onClick={() => setDialog('privacy')}>
            Об обработке данных
          </button>
        </footer>
      </main>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.wav,.mp3,.m4a,.webm"
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
      {(dialog === 'text' || dialog === 'history') && (
        <Modal
          title={
            dialog === 'history'
              ? 'Добавить прошлую запись'
              : 'Добавить текст разговора'
          }
          onClose={() => setDialog(null)}
        >
          <p className="modal-intro">
            {dialog === 'history'
              ? 'Запись будет доступна в истории и учтена при поиске контекста.'
              : 'Текст появится в расшифровке. Бланк обновится автоматически.'}
          </p>
          {source === 'demo' && (
            <div className="notice">
              Добавленный материал начнёт чистый приём. Учебные данные будут
              убраны.
            </div>
          )}
          {dialog === 'history' && (
            <div className="modal-grid">
              <label>
                Название
                <input
                  value={historyTitle}
                  onChange={(e) => setHistoryTitle(e.target.value)}
                  maxLength={150}
                />
              </label>
              <label>
                Дата записи, если известна
                <input
                  type="date"
                  value={historyDate}
                  onChange={(e) => setHistoryDate(e.target.value)}
                />
              </label>
            </div>
          )}
          <textarea
            className="large-textarea"
            aria-label="Текст разговора"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Вставьте текст записи…"
            maxLength={10000}
          />
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setDialog(null)}
            >
              Отмена
            </button>
            <button
              className="button primary"
              disabled={!text.trim()}
              onClick={addText}
            >
              Добавить
            </button>
          </div>
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
            Когда подключение будет настроено, достаточно нажать «Начать приём».
            Язык определяется автоматически, дополнительных настроек для врача
            нет.
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
              Микрофон включается только после нажатия «Начать приём».
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
