import { useEffect, useRef, useState } from "react";
import { CheckCheck, Info, LoaderCircle, Send, X } from "lucide-react";
import { visitApi } from "./hooks/useVisitWorkspace";
import { getErrorMessage, type MisReceipt, type MisSettings } from "./lib/api";
import { createMisDelivery } from "./lib/mis";
import {
  FIELD_DEFINITIONS,
  type TemplateValues,
  type TemplateVitals,
} from "./lib/visitTemplate";

export function TemplateMis({
  values,
  vitals,
  reviewed,
  locked,
  onBusy,
}: {
  values: TemplateValues;
  vitals: TemplateVitals;
  reviewed: boolean;
  locked: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<MisSettings | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<
    (MisReceipt & { snapshot: string }) | null
  >(null);
  const [stored, setStored] = useState<Record<string, string> | null>(null);
  const delivery = useRef(createMisDelivery(visitApi));
  const request = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const fingerprint = JSON.stringify([values, vitals]);
  const sent = receipt?.snapshot === fingerprint;

  useEffect(
    () => () => {
      request.current?.abort();
      delivery.current.dispose();
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const abort = new AbortController();
    setChecking(true);
    setError("");
    void visitApi
      .misSettings({ signal: abort.signal, timeoutMs: 8000 })
      .then((value) => {
        if (!abort.signal.aborted) setSettings(value);
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(getErrorMessage(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setChecking(false);
      });
    return () => abort.abort();
  }, [open]);
  function close() {
    if (!busyRef.current) {
      setOpen(false);
      setConfirmed(false);
    }
  }
  async function send() {
    if (
      busyRef.current ||
      !reviewed ||
      locked ||
      !confirmed ||
      !settings?.configured
    )
      return;
    busyRef.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await delivery.current.send(values, vitals, confirmed, {
        signal: controller.signal,
        timeoutMs: 20000,
      });
      if (!controller.signal.aborted) {
        setReceipt({ ...result, snapshot: fingerprint });
        setStored(null);
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(getErrorMessage(reason));
    } finally {
      busyRef.current = false;
      if (!controller.signal.aborted) {
        setBusy(false);
        onBusy(false);
      }
    }
  }
  async function readBack() {
    if (!receipt || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await visitApi.misDocument(receipt.document_id, {
        signal: controller.signal,
        timeoutMs: 15000,
      });
      if (!controller.signal.aborted)
        setStored(result.document.document_fields);
    } catch (reason) {
      if (!controller.signal.aborted) setError(getErrorMessage(reason));
    } finally {
      busyRef.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <>
      <button
        className="button primary"
        disabled={!reviewed || locked || busy}
        onClick={() => setOpen(true)}
      >
        {sent ? <CheckCheck size={17} /> : <Send size={17} />}
        {sent ? "Отправлено в МИС" : "Отправить в МИС"}
      </button>
      {open && (
        <dialog
          ref={dialog}
          className="modal mis-dialog"
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
        >
          <header>
            <h2>{sent ? "Бланк в тестовой МИС" : "Отправка в тестовую МИС"}</h2>
            <button
              className="icon-button"
              aria-label="Закрыть окно МИС"
              disabled={busy}
              onClick={close}
            >
              <X size={20} />
            </button>
          </header>
          {sent ? (
            <>
              <div className="mis-result">
                <CheckCheck size={32} />
                <p>
                  Получение подтверждено.
                  <br />
                  <small>Документ: {receipt.document_id}</small>
                </p>
              </div>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void readBack()}
              >
                {busy ? "Проверяем…" : "Прочитать из МИС"}
              </button>
              {stored && (
                <details className="mis-stored" open>
                  <summary>Сохранённый бланк</summary>
                  {FIELD_DEFINITIONS.filter((field) => stored[field.id]).map(
                    (field) => (
                      <p key={field.id}>
                        <strong>{field.label}</strong>
                        <br />
                        {stored[field.id]}
                      </p>
                    ),
                  )}
                </details>
              )}
            </>
          ) : (
            <>
              <p className="modal-intro">
                Проверенный бланк будет сохранён в тестовую карточку «Пациент
                А».
              </p>
              {checking ? (
                <p className="mis-status">
                  <LoaderCircle size={16} className="spin" />
                  Проверяем подключение…
                </p>
              ) : settings && !settings.configured ? (
                <p className="mis-status">
                  <Info size={16} />
                  МИС пока не подключена. Скачайте бланк в Word.
                </p>
              ) : null}
              <label className="mis-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                Подтверждаю: данные вымышленные
              </label>
            </>
          )}
          {error && (
            <p className="ai-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={close}
              disabled={busy}
            >
              {sent ? "Готово" : "Отмена"}
            </button>
            {!sent && (
              <button
                className="button primary"
                disabled={
                  !confirmed ||
                  !reviewed ||
                  locked ||
                  busy ||
                  checking ||
                  !settings?.configured
                }
                onClick={() => void send()}
              >
                {busy ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <Send size={17} />
                )}
                {busy ? "Отправляем…" : "Отправить"}
              </button>
            )}
          </div>
        </dialog>
      )}
    </>
  );
}
