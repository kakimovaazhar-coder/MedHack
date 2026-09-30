import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUpRight,
  AudioLines,
  Check,
  CheckCheck,
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
  Sparkles,
  Square,
  Upload,
  X,
} from "lucide-react";
import { useLiveTranscription } from "./hooks/useLiveTranscription";
import { useVisitWorkspace, visitApi } from "./hooks/useVisitWorkspace";
import { getErrorMessage, isAbortError, type Workspace } from "./lib/api";
import {
  DEMO_HISTORY,
  annotateConversation,
  historyFromApi,
  mapWorkspace,
  previousRecommendations,
  type HistoryRecord,
} from "./lib/visitWorkspace";
import {
  DEMO_SEGMENTS,
  FIELD_IDS,
  type FieldId,
  type PatientMetadata,
  type TemplateValues,
  type TemplateVitals,
  type TranscriptSegment,
} from "./lib/visitTemplate";
import { downloadConsultation } from "./lib/docx";
import { TemplatePaper } from "./TemplatePaper";
import { TemplateMis } from "./TemplateMis";
import { matchesHistory } from "./lib/historySearch";
import {
  AUDIO_ACCEPT,
  beginAudioUpload,
  validateAudio,
} from "./lib/audioUpload";
import "./styles.css";

const today = () => new Date().toLocaleDateString("en-CA");
const blankMetadata = (): PatientMetadata => ({
  date: today(),
  name: "",
  iin: "",
  doctor: "",
});
const displayDate = (date: string | null) =>
  date
    ? new Date(date + "T12:00:00").toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "Дата не указана";
const time = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
const speaker = (role: string) =>
  role === "doctor" ? "Врач" : role === "patient" ? "Пациент" : "Реплика";
function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
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
  );
}
export default function App() {
  type PageMode = "demo" | "platform";
  type ModeSnapshot = {
    segments: TranscriptSegment[];
    history: HistoryRecord[];
    manual: Partial<TemplateValues>;
    manualVitals: Partial<TemplateVitals>;
    metadata: PatientMetadata;
    source: "demo" | "real";
    demoCursor: number;
    savedDemoCursor: number | null;
  };
  const [pageMode, setPageMode] = useState<PageMode>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("mode") === "platform" || params.has("workspace")
      ? "platform"
      : "demo";
  });
  const modeSnapshots = useRef<Partial<Record<PageMode, ModeSnapshot>>>({});
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [demoNotice, setDemoNotice] = useState("");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [historyQuery, setHistoryQuery] = useState("");
  const [demoPlaying, setDemoPlaying] = useState(false);
  const [demoCursor, setDemoCursor] = useState(0);
  const [savedDemoCursor, setSavedDemoCursor] = useState<number | null>(null);
  const [manual, setManual] = useState<Partial<TemplateValues>>({});
  const [manualVitals, setManualVitals] = useState<Partial<TemplateVitals>>({});
  const [metadata, setMetadata] = useState(blankMetadata);
  const [session, setSession] = useState(0);
  const [seed, setSeed] = useState<Workspace | null>(null);
  const [source, setSource] = useState<"demo" | "real">(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("mode") !== "platform" && !params.has("workspace")
      ? "demo"
      : "real";
  });
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [dialog, setDialog] = useState<
    "new" | "example" | "privacy" | "connection" | null
  >(null);
  const [openedHistory, setOpenedHistory] = useState<HistoryRecord | null>(
    null,
  );
  const [editing, setEditing] = useState<TranscriptSegment | null>(null);
  const [highlight, setHighlight] = useState<string[]>([]);
  const [pane, setPane] = useState<"history" | "conversation" | "document">(
    "conversation",
  );
  const [reviewed, setReviewed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [starting, setStarting] = useState(false);
  const startBusy = useRef(false);
  const [pending, setPending] = useState<{
    workspaceId: string;
    jobId: string;
    kind: "current" | "history";
    title: string;
  } | null>(null);
  const [capabilityError, setCapabilityError] = useState(false);
  const [following, setFollowing] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef(new Map<string, HTMLElement>());
  const fieldRefs = useRef(new Map<string, HTMLElement>());
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadKind = useRef<"current" | "history">("current");
  const uploadController = useRef<AbortController | null>(null);
  const uploadBusy = useRef(false);
  const epoch = useRef(0);
  const offset = useRef(0);
  const mounted = useRef(true);
  const live = useLiveTranscription({
    language: "auto",
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
      ]);
      setReviewed(false);
    },
    onError: setError,
  });
  const ai = useVisitWorkspace({
    segments,
    history,
    enabled: source === "real",
    session,
    seed,
  });
  const visibleSegments = useMemo(
    () =>
      savedDemoCursor === null ? segments : segments.slice(0, savedDemoCursor),
    [segments, savedDemoCursor],
  );
  const annotated = useMemo(
    () => annotateConversation(visibleSegments),
    [visibleSegments],
  );
  const derived = useMemo(
    () =>
      mapWorkspace(
        savedDemoCursor !== null && savedDemoCursor < segments.length
          ? null
          : ai.workspace,
        visibleSegments,
      ),
    [segments.length, visibleSegments, ai.workspace, savedDemoCursor],
  );
  const values = { ...derived.values, ...manual } as TemplateValues;
  const vitals = { ...derived.vitals, ...manualVitals } as TemplateVitals;
  const filled = FIELD_IDS.filter(
    (id) =>
      values[id].trim() ||
      (id === "objective_status" && Object.values(vitals).some(Boolean)),
  ).length;
  const captureActive = [
    "recording",
    "paused",
    "connecting",
    "finishing",
  ].includes(live.status);
  const active =
    captureActive || uploading || starting || sending || loadingDemo;
  const pendingProcessing =
    !!pending || live.pendingChunks > 0 || (source === "real" && ai.waiting);
  const demoIncomplete =
    source === "demo"
      ? demoCursor < DEMO_SEGMENTS.length
      : savedDemoCursor !== null && savedDemoCursor < segments.length;
  const canExport =
    filled > 0 && !active && !pendingProcessing && !demoIncomplete;
  const matchingHistory = history.filter((record) =>
    matchesHistory(record, historyQuery),
  );
  const listening = live.status === "recording";
  const paused = live.status === "paused";
  const seconds =
    source === "demo" || savedDemoCursor !== null
      ? (visibleSegments.at(-1)?.end ?? 0)
      : Math.max(offset.current + live.seconds, segments.at(-1)?.end ?? 0);
  const hasContent =
    segments.length > 0 ||
    filled > 0 ||
    history.length > 0 ||
    pendingProcessing;
  const status = loadingDemo
    ? "Открываем демо"
    : demoIncomplete
      ? demoPlaying
        ? "Демо · идёт разговор"
        : "Демо · на паузе"
      : listening
        ? "Идёт запись"
        : paused
          ? "На паузе"
          : live.status === "finishing"
            ? "Распознаём последние фразы"
            : uploading
              ? "Распознаём аудиофайл"
              : segments.length
                ? "Разговор записан"
                : "Готов к приёму";
  async function refreshConnection() {
    try {
      const caps = await visitApi.capabilities({ timeoutMs: 8000 });
      setCapabilityError(false);
      return caps.enabled && caps.speech === "configured_unverified";
    } catch {
      setCapabilityError(true);
      return false;
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
      uploadController.current?.abort();
    };
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mode") !== "platform" && !params.has("workspace")) {
      const timer = setTimeout(
        () => (params.get("demo") === "1" ? example() : void loadSavedDemo()),
        0,
      );
      return () => clearTimeout(timer);
    }
    const id = params.get("workspace");
    if (!id) return;
    const controller = new AbortController();
    void visitApi
      .get(id, { signal: controller.signal })
      .then((ws) => {
        setSeed(ws);
        setHistory(
          ws.records.filter((r) => r.kind === "history").map(historyFromApi),
        );
        setSegments(
          ws.records
            .find((r) => r.kind === "current")
            ?.segments.map((s) => ({ ...s, final: true })) ?? [],
        );
      })
      .catch((e) => {
        if (!isAbortError(e)) setError(getErrorMessage(e));
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (source !== "demo" || !demoPlaying || demoCursor >= DEMO_SEGMENTS.length)
      return;
    const timer = setTimeout(
      () => {
        setSegments((old) => [...old, { ...DEMO_SEGMENTS[demoCursor] }]);
        setDemoCursor((cursor) => cursor + 1);
        setReviewed(false);
        if (demoCursor + 1 === DEMO_SEGMENTS.length) setDemoPlaying(false);
      },
      demoCursor === 0
        ? 450
        : Math.min(
            3200,
            Math.max(1800, DEMO_SEGMENTS[demoCursor - 1].text.length * 18),
          ),
    );
    return () => clearTimeout(timer);
  }, [source, demoPlaying, demoCursor]);
  useEffect(() => {
    if (
      source !== "real" ||
      !demoPlaying ||
      savedDemoCursor === null ||
      savedDemoCursor >= segments.length
    )
      return;
    const timer = setTimeout(
      () => {
        setSavedDemoCursor((cursor) => (cursor ?? 0) + 1);
        if (savedDemoCursor + 1 === segments.length) setDemoPlaying(false);
      },
      savedDemoCursor === 0
        ? 400
        : Math.min(
            2400,
            Math.max(
              1200,
              (segments[savedDemoCursor - 1]?.text.length ?? 0) * 16,
            ),
          ),
    );
    return () => clearTimeout(timer);
  }, [source, demoPlaying, savedDemoCursor, segments]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!highlight.length) return;
    const t = setTimeout(() => setHighlight([]), 5500);
    return () => clearTimeout(t);
  }, [highlight]);
  useEffect(() => {
    if (following && scrollRef.current)
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior:
          source === "demo" &&
          !window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "smooth"
            : "instant",
      });
  }, [segments, savedDemoCursor, following]);
  useEffect(() => {
    if (!hasContent) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasContent]);
  function clearForm(clearHistory = true) {
    setSegments([]);
    setDemoPlaying(false);
    setDemoCursor(0);
    setSavedDemoCursor(null);
    setHistoryQuery("");
    setManual({});
    setManualVitals({});
    setMetadata(blankMetadata());
    setReviewed(false);
    setSource("real");
    setError("");
    setDemoNotice("");
    setHighlight([]);
    setFollowing(true);
    setSeed(null);
    setSession((n) => n + 1);
    if (clearHistory) setHistory([]);
  }
  function reset() {
    epoch.current++;
    uploadController.current?.abort();
    live.reset();
    offset.current = 0;
    setPending(null);
    setUploading(false);
    setLoadingDemo(false);
    clearForm();
    setDialog(null);
  }
  function example() {
    reset();
    setSource("demo");
    setHistory(DEMO_HISTORY.map((r) => ({ ...r })));
    setDemoPlaying(true);
    setDemoCursor(0);
    setFollowing(true);
    setPane("conversation");
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0 }));
  }
  function selectMode(next: PageMode) {
    if (next === pageMode || active || pending || live.pendingChunks) return;
    modeSnapshots.current[pageMode] = {
      segments,
      history,
      manual,
      manualVitals,
      metadata,
      source,
      demoCursor,
      savedDemoCursor,
    };
    reset();
    setPageMode(next);
    const url = new URL(window.location.href);
    url.searchParams.delete("workspace");
    url.searchParams.delete("demo");
    url.searchParams.set("mode", next);
    window.history.replaceState(null, "", url);
    const saved = modeSnapshots.current[next];
    if (saved) {
      setSegments(saved.segments);
      setHistory(saved.history);
      setManual(saved.manual);
      setManualVitals(saved.manualVitals);
      setMetadata(saved.metadata);
      setSource(saved.source);
      setDemoCursor(saved.demoCursor);
      setSavedDemoCursor(saved.savedDemoCursor);
      setDemoPlaying(
        saved.source === "demo"
          ? saved.demoCursor < DEMO_SEGMENTS.length
          : saved.savedDemoCursor !== null &&
              saved.savedDemoCursor < saved.segments.length,
      );
    } else if (next === "demo") void loadSavedDemo();
  }
  async function loadSavedDemo() {
    reset();
    setSource("demo");
    const own = epoch.current;
    const abort = new AbortController();
    uploadController.current = abort;
    setLoadingDemo(true);
    let created: Workspace | null = null;
    try {
      const list = await visitApi.savedTranscripts({
        signal: abort.signal,
        timeoutMs: 6000,
      });
      if (!list.length) {
        example();
        setDemoNotice("Учебный пример · сохранённая запись не импортирована");
        return;
      }
      created = await visitApi.create({ signal: abort.signal });
      const ws = await visitApi.loadSavedTranscript(created, list[0].id, {
        signal: abort.signal,
      });
      if (own !== epoch.current || !mounted.current) {
        await visitApi.remove(ws.id).catch(() => {});
        return;
      }
      const current = ws.records.find((record) => record.kind === "current");
      if (!current?.segments.length)
        throw new Error("Сохранённая расшифровка пуста.");
      setSeed(ws);
      setSegments(
        current.segments.map((segment) => ({ ...segment, final: true })),
      );
      setHistory(DEMO_HISTORY.map((record) => ({ ...record })));
      setSource("real");
      setSavedDemoCursor(0);
      setDemoPlaying(true);
      setFollowing(true);
      setDemoNotice("Сохранённая демо-запись");
    } catch (reason) {
      if (created) void visitApi.remove(created.id).catch(() => {});
      if (own === epoch.current && mounted.current && !isAbortError(reason)) {
        example();
        setDemoNotice("Учебный пример · сохранённое демо недоступно");
      }
    } finally {
      if (own === epoch.current && mounted.current) setLoadingDemo(false);
    }
  }
  function enterPlatform() {
    if (pageMode !== "demo") return;
    modeSnapshots.current.demo = {
      segments,
      history,
      manual,
      manualVitals,
      metadata,
      source,
      demoCursor,
      savedDemoCursor,
    };
    const saved = modeSnapshots.current.platform;
    clearForm();
    setPageMode("platform");
    if (saved?.source === "real") {
      setSegments(saved.segments);
      setHistory(saved.history);
      setManual(saved.manual);
      setManualVitals(saved.manualVitals);
      setMetadata(saved.metadata);
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("workspace");
    url.searchParams.delete("demo");
    url.searchParams.set("mode", "platform");
    window.history.replaceState(null, "", url);
  }
  const platformOffset =
    pageMode === "demo"
      ? modeSnapshots.current.platform?.source === "real"
        ? (modeSnapshots.current.platform.segments.at(-1)?.end ?? 0)
        : 0
      : source === "demo"
        ? 0
        : seconds;
  async function start() {
    if (startBusy.current || uploadBusy.current) return;
    startBusy.current = true;
    setStarting(true);
    const own = epoch.current;
    try {
      if (!(await refreshConnection())) {
        if (mounted.current && own === epoch.current) setDialog("connection");
        return;
      }
      if (!mounted.current || own !== epoch.current) return;
      const nextOffset = platformOffset;
      enterPlatform();
      if (
        live.status === "finished" ||
        (live.status === "error" && !live.pendingChunks)
      )
        live.reset();
      offset.current = nextOffset;
      if (await live.start("unknown")) {
        setSavedDemoCursor(null);
        setDemoPlaying(false);
        if (pageMode !== "demo" && source === "demo") clearForm();
        setReviewed(false);
        setPane("conversation");
      }
    } finally {
      startBusy.current = false;
      if (mounted.current) setStarting(false);
    }
  }
  function pause() {
    if (live.status === "paused") void live.resume();
    else live.pause();
  }
  async function stop() {
    await live.stop();
  }
  function editField(id: FieldId, value: string) {
    setManual((old) => ({ ...old, [id]: value }));
    setReviewed(false);
  }
  function reveal(id: FieldId) {
    const ids = [
      ...derived.sources[id],
      ...(id === "objective_status"
        ? Object.values(derived.vitalSources).flat()
        : []),
    ];
    if (!ids.length) return;
    setPane("conversation");
    setHighlight(ids);
    setFollowing(false);
    requestAnimationFrame(() =>
      segmentRefs.current
        .get(ids[0])
        ?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
  }
  async function processAudio(file?: File) {
    if (uploadBusy.current || captureActive) return;
    const kind = uploadKind.current;
    try {
      if (file) validateAudio(file);
      if (file && kind === "history" && history.length >= 10)
        throw new Error("В истории уже 10 записей. Начните новый приём.");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Не удалось прочитать файл.",
      );
      return;
    }
    uploadBusy.current = true;
    const own = epoch.current;
    const abort = new AbortController();
    uploadController.current = abort;
    setUploading(true);
    setReviewed(false);
    setError("");
    let task = pending;
    try {
      if (file) {
        if (!(await refreshConnection())) {
          setDialog("connection");
          return;
        }
        if (own !== epoch.current || abort.signal.aborted) return;
        const accepted = await beginAudioUpload(visitApi, file, abort.signal);
        if (own !== epoch.current || !mounted.current) {
          void visitApi.remove(accepted.workspaceId).catch(() => {});
          return;
        }
        task = { ...accepted, kind, title: file.name };
        setPending(task);
      }
      if (!task) return;
      const ws = await visitApi.pollAudioJob(task.workspaceId, task.jobId, {
        signal: abort.signal,
      });
      if (own !== epoch.current || !mounted.current) return;
      const job = ws.jobs.find((j) => j.id === task!.jobId);
      const record = ws.records.find((r) => r.id === job?.record_id);
      if (!record) throw new Error("Распознанная запись не найдена.");
      const next = record.segments.map((s) => ({ ...s, final: true }));
      if (pageMode === "demo") enterPlatform();
      else if (source === "demo") clearForm();
      setSavedDemoCursor(null);
      setDemoPlaying(false);
      if (task.kind === "history")
        setHistory((old) => [
          ...old,
          {
            id: record.id,
            title: task!.title,
            date: record.visit_date ?? null,
            segments: next,
          },
        ]);
      else
        setSegments((old) => [
          ...old,
          ...next.map((s) => ({
            ...s,
            start: s.start + platformOffset,
            end: s.end + platformOffset,
          })),
        ]);
      setPending(null);
      void visitApi.remove(task.workspaceId).catch(() => {});
      setToast("Запись распознана. Бланк обновляется автоматически.");
    } catch (e) {
      if (!isAbortError(e) && own === epoch.current) {
        setError(getErrorMessage(e));
        if (
          e instanceof Error &&
          "code" in e &&
          [
            "TRANSCRIPTION_FAILED",
            "WORKSPACE_EXPIRED",
            "WORKSPACE_NOT_FOUND",
            "JOB_NOT_FOUND",
          ].includes(String(e.code))
        ) {
          setPending(null);
          if (task) void visitApi.remove(task.workspaceId).catch(() => {});
        }
      }
    } finally {
      uploadBusy.current = false;
      if (own === epoch.current) setUploading(false);
    }
  }
  function chooseAudio(kind: "current" | "history") {
    uploadKind.current = kind;
    fileRef.current?.click();
  }
  async function exportWord() {
    if (!canExport || !reviewed) return;
    setExporting(true);
    try {
      await downloadConsultation({ values, vitals, metadata });
      setToast("Документ Word подготовлен. Его можно открыть и распечатать.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось подготовить Word.");
    } finally {
      setExporting(false);
    }
  }
  function newVisit() {
    if (pageMode === "demo") {
      selectMode("platform");
      setDialog(null);
      return;
    }
    if (source === "real" && segments.length) {
      const r: HistoryRecord = {
        id: crypto.randomUUID(),
        title: "Консультация терапевта",
        date: metadata.date,
        segments: annotated,
      };
      setHistory((old) => [r, ...old].slice(0, 10));
    }
    live.reset();
    offset.current = 0;
    clearForm(source === "demo");
    setDialog(null);
    setPane("conversation");
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
            {loadingDemo ? (
              <button className="button primary" disabled>
                <LoaderCircle size={22} className="spin" />
                Открываем демо…
              </button>
            ) : starting ? (
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
                  aria-label={paused ? "Продолжить запись" : "Пауза"}
                  title={paused ? "Продолжить запись" : "Пауза"}
                  disabled={
                    uploading ||
                    live.status === "finishing" ||
                    live.status === "connecting"
                  }
                  onClick={pause}
                >
                  {paused ? <Play size={17} /> : <Pause size={17} />}
                  <span>{paused ? "Продолжить" : "Пауза"}</span>
                </button>
                <button
                  className="button primary"
                  disabled={
                    uploading ||
                    live.status === "finishing" ||
                    live.status === "connecting"
                  }
                  onClick={() => void stop()}
                >
                  {live.status === "finishing" || uploading ? (
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
                  {segments.length && source !== "demo" && pageMode !== "demo"
                    ? "Продолжить запись"
                    : "Начать запись"}
                </button>
              </>
            )}
          </div>
          <button
            className="button secondary upload-button"
            disabled={active || !!pending || live.pendingChunks > 0}
            onClick={() => chooseAudio("current")}
          >
            <Upload size={20} />
            Добавить аудио
          </button>
        </div>

        <div className="utility-actions">
          <nav className="mode-switch" aria-label="Режим MedRep">
            <button
              aria-pressed={pageMode === "demo"}
              disabled={active || !!pending || live.pendingChunks > 0}
              onClick={() => selectMode("demo")}
            >
              Демо
            </button>
            <button
              aria-pressed={pageMode === "platform"}
              disabled={active || !!pending || live.pendingChunks > 0}
              onClick={() => selectMode("platform")}
            >
              Приём
            </button>
          </nav>

          {hasContent && (
            <button
              className="icon-button"
              aria-label="Новый приём"
              title="Новый приём"
              disabled={active || !!pending || live.pendingChunks > 0}
              onClick={() => setDialog("new")}
            >
              <Plus size={21} />
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Об обработке данных"
            title="Об обработке данных"
            onClick={() => setDialog("privacy")}
          >
            <Info size={19} />
          </button>
        </div>
      </header>
      <main id="main">
        <nav className="mobile-panes" aria-label="Рабочие панели">
          {(
            [
              ["history", "История", History],
              ["conversation", "Разговор", AudioLines],
              ["document", "Бланк", FileText],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              className={pane === id ? "selected" : ""}
              aria-pressed={pane === id}
              onClick={() => setPane(id)}
            >
              <Icon size={16} />
              {label}
              <small>
                {id === "history"
                  ? history.length
                  : id === "conversation"
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
                  onClick={() => setHistoryQuery("")}
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
                        {record.synthetic && <small>Пример</small>}
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
                onClick={() => chooseAudio("history")}
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
              {pageMode === "demo" && (
                <button
                  className="demo-control"
                  aria-label={
                    demoIncomplete
                      ? demoPlaying
                        ? "Приостановить демо"
                        : "Продолжить демо"
                      : "Повторить демо"
                  }
                  onClick={() =>
                    demoIncomplete
                      ? setDemoPlaying((playing) => !playing)
                      : source === "demo"
                        ? example()
                        : void loadSavedDemo()
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
                      ? "Пауза"
                      : "Продолжить"
                    : "Повторить"}
                </button>
              )}
            </header>
            <div className="conversation-status">
              <span>
                <span
                  className={`status-dot ${listening || demoPlaying ? "pulse" : ""}`}
                />
                {status}
              </span>
              <time>{time(seconds)}</time>
            </div>
            {pageMode === "demo" && demoNotice && (
              <div className="demo-notice">{demoNotice}</div>
            )}
            <div
              className="transcript-scroll"
              ref={scrollRef}
              onScroll={() => {
                const el = scrollRef.current;
                if (el)
                  setFollowing(
                    el.scrollHeight - el.scrollTop - el.clientHeight < 70,
                  );
              }}
            >
              {!segments.length &&
                !captureActive &&
                !uploading &&
                !loadingDemo &&
                !demoPlaying && (
                  <div className="conversation-empty">
                    <div className="mic-orbit">
                      <Mic size={31} />
                      <span />
                      <span />
                    </div>
                    <h3>
                      {demoIncomplete ? "Демо на паузе" : "Готовы слушать"}
                    </h3>
                    <p>
                      {demoIncomplete
                        ? "Нажмите «Продолжить»."
                        : "Начните запись или добавьте аудио."}
                    </p>
                  </div>
                )}
              {annotated.map((segment) => {
                return (
                  <article
                    className={`utterance ${pageMode === "demo" ? "demo-utterance" : ""} ${segment.role} ${highlight.includes(segment.id) ? "source-highlight" : ""}`}
                    key={segment.id}
                    ref={(el) => {
                      if (el) segmentRefs.current.set(segment.id, el);
                      else segmentRefs.current.delete(segment.id);
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
                );
              })}
              {(listening || demoPlaying) && (
                <div className="interim" role="status">
                  <span className="interim-dot" />
                  <p>
                    {demoPlaying ? "Следующая реплика" : "Слушаем…"}
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
                  setFollowing(true);
                  scrollRef.current?.scrollTo({
                    top: scrollRef.current.scrollHeight,
                    behavior: "smooth",
                  });
                }}
              >
                <ArrowDown size={13} />К последней реплике
              </button>
            )}
            {(error || live.status === "error" || (pending && !uploading)) && (
              <div className="inline-error" role="alert">
                <Info size={16} />
                <div>
                  {error || "Остались необработанные аудиофрагменты."}
                  {live.pendingChunks > 0 && live.status === "error" && (
                    <button
                      className="text-button"
                      onClick={() => {
                        setError("");
                        void live.retry();
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
                    onClick={() => setError("")}
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
                className={`document-status ${listening || demoPlaying || ai.busy ? "updating" : reviewed ? "reviewed" : ""}`}
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
                  "Черновик"
                )}
              </span>
            </header>
            <div className="document-scroll">
              <TemplatePaper
                values={values}
                vitals={vitals}
                metadata={metadata}
                onChange={editField}
                onMetadata={(key, value) => {
                  setMetadata((old) => ({ ...old, [key]: value }));
                  setReviewed(false);
                }}
                onVitals={(id, value) => {
                  setManualVitals((old) => ({ ...old, [id]: value }));
                  setReviewed(false);
                }}
                edited={manual}
                register={(id, el) => {
                  if (el) fieldRefs.current.set(id, el);
                  else fieldRefs.current.delete(id);
                }}
                reveal={reveal}
              />
            </div>
            <footer className="document-footer">
              {ai.error && source === "real" && (
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
                <TemplateMis
                  key={session}
                  values={values}
                  vitals={vitals}
                  reviewed={reviewed}
                  locked={!canExport || exporting}
                  onBusy={setSending}
                />
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
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void processAudio(file);
        }}
      />
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
      {(dialog === "new" || dialog === "example") && (
        <Modal
          title={
            dialog === "new"
              ? "Начать следующий приём?"
              : "Открыть учебный пример?"
          }
          onClose={() => setDialog(null)}
        >
          <p className="modal-intro">
            {dialog === "new"
              ? "Текущий разговор останется в истории этой вкладки. Перед началом сохраните готовый бланк в Word."
              : "Учебный пример заменит текущие данные в этой вкладке. Сохраните бланк перед переходом."}
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
              onClick={dialog === "new" ? newVisit : example}
            >
              {dialog === "new" ? "Следующий приём" : "Открыть пример"}
            </button>
          </div>
          {dialog === "new" && (
            <button className="new-patient" onClick={reset}>
              Другой пациент — очистить историю и начать заново
            </button>
          )}
        </Modal>
      )}
      {dialog === "connection" && (
        <Modal
          title="Подключение к распознаванию"
          onClose={() => setDialog(null)}
        >
          <div className="connection-illustration">
            <AudioLines size={31} />
          </div>
          <h3>
            {capabilityError
              ? "Нет связи с сервером"
              : "Сервер речи ещё не подключён к этому интерфейсу"}
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
                  ai.retry();
                  if (ok) {
                    setDialog(null);
                    setToast("Распознавание подключено. Можно начинать приём.");
                  }
                });
              }}
            >
              <RotateCcw size={15} />
              Проверить связь
            </button>
            <button
              className="button primary"
              onClick={() => (hasContent ? setDialog("example") : example())}
            >
              <Play size={15} />
              Посмотреть пример
            </button>
          </div>
        </Modal>
      )}
      {dialog === "privacy" && (
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
            {openedHistory.synthetic ? " · Учебная запись" : ""}
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
                );
                setReviewed(false);
                setEditing(null);
              }}
            >
              Сохранить исправление
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function CheckCircle() {
  return (
    <span className="small-check">
      <Check size={10} />
    </span>
  );
}
