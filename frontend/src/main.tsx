import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, upload, type Capabilities, type Evidence, type Fields, type RecordItem, type Workspace } from './api';
import './styles.css';
import { Calculator } from './Calculator';

const labels: Record<keyof Fields, string> = {
  complaints: 'Жалобы', anamnesis: 'Анамнез', allergies: 'Аллергии', diagnosis: 'Диагноз',
  prescriptions: 'Назначения', recommendations: 'Рекомендации',
};
const emptyFields: Fields = Object.fromEntries(Object.keys(labels).map(k => [k, null]));
const roles = { doctor: 'Врач', patient: 'Пациент', unknown: 'Уточните роль' };
const formatDate = (value?: string | null) => value ? new Date(value + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Дата не указана';

function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [cap, setCap] = useState<Capabilities | null>(null);
  const [activeId, setActiveId] = useState('');
  const [editor, setEditor] = useState<RecordItem | null>(null);
  const [fields, setFields] = useState<Fields>(emptyFields);
  const [focus, setFocus] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [panel, setPanel] = useState<'transcript' | 'context'>('transcript');
  const [modal, setModal] = useState<'audio' | 'text' | null>(null);
  const [kind, setKind] = useState<'history' | 'current'>('history');
  const [title, setTitle] = useState('');
  const [day, setDay] = useState('');
  const [language, setLanguage] = useState('ru');
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState('');
  const [highlight, setHighlight] = useState('');
  const [cloudReviewed, setCloudReviewed] = useState(false);
  const [engine, setEngine] = useState<'local_rules' | 'openai'>('local_rules');
  const audioUrls = useRef<Record<string, string>>({});
  const currentId = useRef<string | null>(null);
  const mounted = useRef(true);
  const polling = useRef(false);
  const record = workspace?.records.find(r => r.id === activeId);
  const formDirty = JSON.stringify(fields) !== JSON.stringify(workspace?.fields || emptyFields);
  const recordDirty = !!editor && JSON.stringify(editor) !== JSON.stringify(record);
  const transcribing = workspace?.jobs.some(j => j.status === 'transcribing') || false;
  const locked = !!busy || transcribing;

  function accept(next: Workspace, select?: string) {
    currentId.current = next.id;
    setCloudReviewed(false);
    setWorkspace(next); setFields(next.fields); setFocus(next.focus);
    const nextId = select || activeId || next.records.find(r => r.kind === 'current')?.id || next.records[0]?.id || '';
    setActiveId(nextId); setEditor(next.records.find(r => r.id === nextId) || null);
  }
  async function run(label: string, action: () => Promise<void>) {
    setBusy(label); setError(''); setNotice('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось выполнить действие.'); }
    finally { if (mounted.current) setBusy(''); }
  }
  async function fresh() {
    const next = await api<Workspace>('/workspaces', 'POST');
    if (!mounted.current) { await api(`/workspaces/${next.id}`, 'DELETE'); return; }
    accept(next);
  }
  useEffect(() => {
    mounted.current = true;
    void run('Открываем сессию', async () => {
      const capabilities = await api<Capabilities>('/workspaces/capabilities');
      setCap(capabilities); setEngine(capabilities.cloud_llm ? 'openai' : 'local_rules');
      await fresh();
    });
    return () => {
      mounted.current = false;
      Object.values(audioUrls.current).forEach(URL.revokeObjectURL);
    };
  }, []);

  useEffect(() => {
    if (!workspace?.id || !transcribing || busy) return;
    const id = workspace.id;
    const timer = window.setInterval(async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const next = await api<Workspace>(`/workspaces/${id}`);
        if (currentId.current === id) {
          accept(next);
          const failed = next.jobs.filter(j => j.status === 'failed').at(-1);
          if (failed) setError(failed.error || 'Ошибка расшифровки');
        }
      } catch (e) { setError(String(e)); }
      finally { polling.current = false; }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [workspace?.id, transcribing, busy]);

  async function command(action: string, body: object = {}, method = 'POST') {
    if (!workspace) return;
    accept(await api<Workspace>(`/workspaces/${workspace.id}/${action}`, method, {
      expected_revision: workspace.revision, ...body,
    }));
  }
  function canLeave() {
    return !(formDirty || recordDirty) || window.confirm('Есть несохранённые правки. Продолжить без сохранения?');
  }
  function selectRecord(id: string, segmentId = '') {
    if (recordDirty && !window.confirm('Отменить несохранённые правки расшифровки?')) return;
    setActiveId(id); setEditor(workspace?.records.find(r => r.id === id) || null);
    setPanel('transcript'); setHighlight(segmentId);
    if (segmentId) window.setTimeout(() => document.getElementById(segmentId)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
  }
  function openUpload(type: 'audio' | 'text', recordKind: 'history' | 'current') {
    if (!canLeave()) return;
    setKind(recordKind); setModal(type); setFiles([]); setTitle(''); setText(''); setDay(''); setError('');
  }
  async function addText() {
    if (!workspace) return;
    const segments = text.split('\n').map(s => s.trim()).filter(Boolean).map(line => {
      const match = line.match(/^(Врач|Пациент)\s*:\s*(.+)$/i);
      return { text: match ? match[2] : line, role: match ? (match[1].toLowerCase() === 'врач' ? 'doctor' : 'patient') : 'unknown' };
    });
    await command('records', { title: title.trim() || 'Текстовая запись', visit_date: day || null, kind, segments });
    setModal(null);
  }
  async function addAudio() {
    if (!workspace || !cap) return;
    let latest = workspace;
    for (const file of files) {
      if (!file.size || file.size > cap.max_audio_bytes) throw new Error('Выберите непустое аудио до 30 МБ.');
      const query = new URLSearchParams({ title: title.trim() || 'Аудиозапись приёма', kind,
        language, expected_revision: String(latest.revision), ...(day ? { visit_date: day } : {}),
      });
      const job = await upload(latest.id, file, query);
      setModal(null);
      // Upload multiple previous visits sequentially to avoid overloading the speech computer.
      while (true) {
        latest = await api<Workspace>(`/workspaces/${latest.id}`);
        if (currentId.current !== latest.id || !mounted.current) return;
        accept(latest);
        const status = latest.jobs.find(j => j.id === job.id);
        if (status?.status === 'failed') throw new Error(status.error || 'Ошибка расшифровки');
        if (status?.status === 'completed') {
          if (status.record_id) {
            audioUrls.current[status.record_id] = URL.createObjectURL(file);
            accept(latest, status.record_id);
          }
          break;
        }
        await new Promise(resolve => window.setTimeout(resolve, 2000));
      }
    }
    setNotice('Аудио расшифровано. Проверьте текст и укажите, где говорит врач, а где пациент.');
  }
  function sourceLink(e: Evidence, index: number) {
    const source = workspace?.records.find(r => r.id === e.record_id);
    return <button className="quote" key={`${e.segment_id}-${index}`} onClick={() => selectRecord(e.record_id, e.segment_id)}>
      <span className="quote-meta">{formatDate(source?.visit_date)} · {source?.title}</span>
      <span>«{e.quote}»</span><small>{e.reason} · Открыть источник ↗</small>
    </button>;
  }

  return <>
    <header className="topbar"><a className="brand" href="/" onClick={e => e.preventDefault()}><span className="brand-icon">m<span>+</span></span>medhub<span className="brand-divider" /> <span className="brand-caption">Ассистент врача</span></a>
      <div className="top-actions"><span className="pill"><i />Локальное демо</span><span className="avatar">ВР</span></div></header>
    <main>
      <div className="page-heading"><div><div className="eyebrow">РАБОЧЕЕ МЕСТО / КОНСУЛЬТАЦИЯ</div><h1>Весь контекст. Один приём.</h1><p>История разговоров и черновик документа рядом с врачом.</p></div>
        <button className="secondary" disabled={locked || !workspace} onClick={() => {
          if (!window.confirm('Удалить историю и форму этой сессии?')) return;
          void run('Удаляем сессию', async () => {
            await api(`/workspaces/${workspace!.id}`, 'DELETE');
            Object.values(audioUrls.current).forEach(URL.revokeObjectURL); audioUrls.current = {};
            currentId.current = null; setWorkspace(null); setActiveId(''); setEditor(null); setFields(emptyFields);
            await fresh();
          });
        }}>Очистить сессию</button>
      </div>
      <div className="privacy-strip"><span>◷</span><span>Временная сессия · до {workspace ? new Date(workspace.expires_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '1 часа'} · история в памяти backend</span><span className="engine">{cap?.cloud_llm ? 'OpenAI подключён · отправка после проверки текста' : 'Локальный подбор по ключевым словам'}</span></div>
      {error && <div className="alert error" role="alert">{error}<button aria-label="Закрыть ошибку" onClick={() => setError('')}>×</button></div>}
      {notice && <div className="alert" role="status">{notice}</div>}
      {busy && <div className="progress" role="status"><span className="spinner" />{busy}…</div>}
      <div className="workspace-grid">
        <aside className="card history-panel"><div className="section-head"><div><span className="step">01</span><h2>История приёмов</h2></div><span className="count">{workspace?.records.filter(r => r.kind === 'history').length || 0}</span></div>
          <p className="muted intro">Прошлые разговоры помогают восстановить контекст.</p>
          <button className="upload-button" disabled={locked || !workspace} onClick={() => openUpload('audio', 'history')}><span>＋</span> Добавить аудиозапись</button>
          <div className="timeline">{workspace?.records.filter(r => r.kind === 'history').sort((a,b) => (b.visit_date || '').localeCompare(a.visit_date || '')).map(r =>
            <button key={r.id} className={`record-card ${activeId === r.id ? 'selected' : ''}`} onClick={() => selectRecord(r.id)}>
              <span className="record-date">{formatDate(r.visit_date)}</span><strong>{r.title}</strong><span>{r.segments.length} фрагм. · {r.origin === 'example' ? 'Синтетический пример' : r.origin === 'audio' ? 'Аудиозапись' : 'Текст'}</span>
            </button>)}</div>
          {!workspace?.records.length && <div className="empty-history"><div className="empty-glyph">≋</div><h3>История начнётся здесь</h3><p>Загрузите прошлый разговор с врачом или откройте пример.</p></div>}
          <div className="history-footer"><button className="text-button" disabled={locked || !workspace} onClick={() => openUpload('text', 'history')}>Вставить готовую расшифровку</button>
            {!workspace?.records.length && <button className="secondary full" disabled={locked || !workspace} onClick={() => void run('Загружаем пример', async () => { await command('example'); setNotice('Синтетические данные для проверки интерфейса. Аудио и языковая модель не использовались.'); })}>Открыть демо-пример</button>}
            <small>Записи этой сессии относятся к одному человеку. Его идентификатор не требуется.</small></div>
        </aside>
        <section className="card conversation-panel"><div className="section-head"><div><span className="step">02</span><h2>Разговор и контекст</h2></div><span className="live-dot" /></div>
          <div className="tabs"><button className={panel === 'transcript' ? 'active' : ''} onClick={() => setPanel('transcript')}>Расшифровка</button><button className={panel === 'context' ? 'active' : ''} onClick={() => setPanel('context')}>Из прошлых записей <span>{workspace?.evidence.length || 0}</span></button></div>
          <div className="focus-box"><label htmlFor="focus">Что важно на текущем приёме?</label><div><input id="focus" value={focus} disabled={locked} onChange={e => setFocus(e.target.value)} placeholder="Например, анемия и анализы на железо" maxLength={1000} /></div><small>Оставьте пустым — используем слова текущего разговора.</small></div>
          {workspace?.records.find(r => r.kind === 'current') ? <button className="current-link" onClick={() => selectRecord(workspace.records.find(r => r.kind === 'current')!.id)}>● Открыть текущий приём →</button> : <div className="current-actions"><button className="primary" disabled={locked || !workspace} onClick={() => openUpload('audio', 'current')}>Загрузить текущий разговор</button><button className="text-button" disabled={locked || !workspace} onClick={() => openUpload('text', 'current')}>Вставить текст</button></div>}
          {panel === 'transcript' ? <div className="transcript-content">
            {editor ? <><div className="record-heading"><div><span className="eyebrow">{editor.kind === 'current' ? 'ТЕКУЩИЙ ПРИЁМ' : 'ПРОШЛАЯ ЗАПИСЬ'}</span><h3>{editor.title}</h3></div><button className="text-button danger" disabled={locked} onClick={() => {
              if (!canLeave() || !window.confirm('Удалить эту запись из истории?')) return;
              void run('Удаляем запись', async () => {
                const next = await api<Workspace>(`/workspaces/${workspace!.id}/records/${editor.id}?expected_revision=${workspace!.revision}`, 'DELETE');
                if (audioUrls.current[editor.id]) { URL.revokeObjectURL(audioUrls.current[editor.id]); delete audioUrls.current[editor.id]; }
                accept(next, next.records[0]?.id || '');
              });
            }}>Удалить</button></div>
              <div className="record-metadata"><label>Название<input value={editor.title} maxLength={200} disabled={locked} onChange={e => setEditor({ ...editor, title: e.target.value })} /></label><label>Дата приёма<input type="date" value={editor.visit_date || ''} disabled={locked} onChange={e => setEditor({ ...editor, visit_date: e.target.value || null })} /></label></div>
              {audioUrls.current[editor.id] && <audio controls src={audioUrls.current[editor.id]} aria-label="Аудиозапись выбранного приёма" />}
              <p className="muted small">Проверьте текст и роли говорящих. Неопределённые роли не попадут в форму автоматически.</p>
              {editor.segments.map((s, i) => <div key={s.id} id={s.id} className={`utterance ${s.role === 'doctor' ? 'doctor' : ''} ${highlight === s.id ? 'highlight' : ''}`}>
                <div className="utterance-head"><select aria-label={`Роль фрагмента ${i + 1}`} value={s.role} disabled={locked} onChange={e => setEditor({ ...editor, segments: editor.segments.map((v, j) => j === i ? { ...v, role: e.target.value as typeof v.role } : v) })}>{Object.entries(roles).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select><span>{s.speaker_id && `${s.speaker_id} · `}{Math.floor(s.start / 60)}:{String(Math.floor(s.start % 60)).padStart(2,'0')}</span></div>
                <textarea aria-label={`Текст фрагмента ${i + 1}`} value={s.text} rows={Math.max(2, Math.ceil(s.text.length / 60))} maxLength={10000} disabled={locked} onChange={e => setEditor({ ...editor, segments: editor.segments.map((v, j) => j === i ? { ...v, text: e.target.value } : v) })} />
              </div>)}
              <button className="secondary full" disabled={locked || !recordDirty || !editor.title.trim() || editor.segments.some(s => !s.text.trim())} onClick={() => void run('Сохраняем расшифровку', async () => {
                if (formDirty && !window.confirm('Несохранённые правки формы будут сброшены. Продолжить?')) return;
                const { id, origin: _origin, ...body } = editor;
                await command(`records/${id}`, body, 'PATCH'); setNotice('Расшифровка сохранена. Соберите форму заново, чтобы учесть правки.');
              })}>Сохранить расшифровку и роли</button>
            </> : <div className="center-empty"><div className="sound-bars">▂ ▅ ▃ ▇ ▅ ▂ ▄</div><h3>Сначала — разговор</h3><p>Добавьте текущую аудиозапись.<br />После расшифровки здесь появятся реплики.</p><span className="subtle-badge">{cap?.speech === 'not_configured' ? 'WhisperX ещё не подключён' : 'WhisperX настроен · доступность не проверена'}</span></div>}
          </div> : <div className="context-content"><h3>По теме текущего приёма</h3><p className="muted small">Точные цитаты из истории. Нажмите, чтобы проверить источник.</p>{workspace?.evidence.length ? workspace.evidence.map(sourceLink) : <p className="empty-note">{workspace?.generated ? 'Совпадений по теме не найдено. Уточните запрос или добавьте историю.' : 'После добавления записей нажмите «Собрать форму».'}</p>}
            <h3 className="past-heading">Что врач рекомендовал раньше</h3><p className="muted small">Исторические рекомендации; их актуальность проверяет врач.</p>{workspace?.previous_recommendations.length ? workspace.previous_recommendations.map(sourceLink) : <p className="empty-note">Подходящих рекомендаций с указанной ролью врача пока нет.</p>}</div>}
          <Calculator workspace={workspace} locked={locked || recordDirty} openSource={selectRecord} apply={body => void run('Проверяем расчёт и переносим в форму', async () => {
            if (!workspace) return;
            let next = workspace;
            if (formDirty) next = await api<Workspace>(`/workspaces/${next.id}/form`, 'PATCH', { expected_revision: next.revision, fields });
            next = await api<Workspace>(`/workspaces/${next.id}/calculate`, 'POST', { ...body, expected_revision: next.revision });
            next = await api<Workspace>(`/workspaces/${next.id}/calculation/apply`, 'POST', { expected_revision: next.revision });
            accept(next); setNotice('Расчёт проверен backend и добавлен в рекомендации. Препарат и текст можно исправить.');
          })} />
        </section>
        <section className="card form-panel"><div className="section-head"><div><span className="step">03</span><h2>Лист консультации</h2></div></div>
          <div className="form-status"><span className={`pill ${workspace?.confirmed_revision === workspace?.revision && workspace ? 'confirmed' : ''}`}>{workspace && workspace.confirmed_revision === workspace.revision ? '✓ Проверено врачом' : 'Черновик · требует проверки'}</span></div>
          <div className="engine-controls"><label>Обработка<select value={engine} disabled={locked} onChange={e => { setEngine(e.target.value as typeof engine); setCloudReviewed(false); }}><option value="local_rules">Локальные правила</option><option value="openai" disabled={!cap?.cloud_llm}>OpenAI — разбор разговора</option></select></label>{engine === 'openai' && <label className="check-label"><input type="checkbox" checked={cloudReviewed} disabled={locked} onChange={e => setCloudReviewed(e.target.checked)} /><span>Текст проверен: разрешаю отправить расшифровки этой сессии и тему в OpenAI. Имена автоматически не удаляются.</span></label>}</div>
          <button className="primary full generate" disabled={locked || (engine === 'openai' && !cloudReviewed) || !workspace?.records.some(r => r.kind === 'current')} onClick={() => {
            if (recordDirty) { setError('Сначала сохраните расшифровку и роли.'); return; }
            if ((workspace?.generated || formDirty) && !window.confirm('Пересобрать форму? Текущие правки полей будут заменены цитатами из источников.')) return;
            void run('Собираем форму и контекст', async () => { await command('analyze', { focus, engine, allow_cloud_processing: cloudReviewed }); setPanel('context'); });
          }}>✧ Собрать форму</button>
          <p className="generation-note">{workspace?.generated ? `Последний разбор: ${workspace.engine === 'openai' ? 'OpenAI' : 'локальные правила'}. ` : ''}Поля связаны с цитатами. Диагноз и назначения проверяет врач.</p>
          {workspace?.context_stale && <div className="stale">Источники изменились. Пересоберите форму перед подтверждением.</div>}
          <div className="fields">{Object.entries(labels).map(([key,label]) => <label key={key} className="field-label"><span>{label}<small>{workspace?.field_sources.some(s => s.field === key) ? 'Из разговора' : fields[key as keyof Fields] ? 'Ручной ввод' : 'Нет данных'}</small></span><textarea value={fields[key as keyof Fields] || ''} aria-label={label} disabled={locked} maxLength={10000} rows={key === 'recommendations' ? Math.min(14, Math.max(3, Math.ceil((fields.recommendations || '').length / 48))) : key === 'anamnesis' ? 4 : 2} placeholder="Врач может дополнить" onChange={e => setFields({ ...fields, [key]: e.target.value || null })} />
            <div className="source-chips">{workspace?.field_sources.filter(s => s.field === key).map((s,i) => <button key={s.segment_id} disabled={formDirty} onClick={() => selectRecord(s.record_id,s.segment_id)}>Источник {i+1} ↗</button>)}</div></label>)}</div>
          <div className="form-actions"><button className="secondary full" disabled={locked || !formDirty || recordDirty} onClick={() => void run('Сохраняем правки', async () => { await command('form', { fields }, 'PATCH'); setNotice('Правки сохранены в этой временной сессии.'); })}>Сохранить правки</button><button className="primary full" disabled={locked || !workspace || formDirty || recordDirty || workspace.context_stale || !Object.values(fields).some(Boolean)} onClick={() => void run('Подтверждаем', async () => { await command('confirm'); setNotice('Форма подтверждена. Теперь её можно скачать.'); })}>Подтвердить после проверки</button>
            <button className="text-button" disabled={locked || formDirty || recordDirty || !workspace || workspace.confirmed_revision !== workspace.revision} onClick={() => void run('Готовим документ', async () => {
              const result = await api(`/workspaces/${workspace!.id}/export`, 'POST', { expected_revision: workspace!.revision });
              const url = URL.createObjectURL(new Blob([JSON.stringify(result,null,2)], { type: 'application/json' }));
              const a = document.createElement('a'); a.href=url; a.download='consultation.json'; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
              setNotice('Файл подготовлен для скачивания. В МИС данные не отправлялись.');
            })}>Скачать подтверждённую форму ↓</button><small>Экспорт в JSON · подключение к МИС пока отсутствует</small></div>
        </section>
      </div>
      <footer className="page-footer"><span>medhub · меньше поиска, больше внимания пациенту</span><span>Демо-сессия {workspace?.id.slice(0,8) || '—'}</span></footer>
    </main>
    {modal && <div className="modal-overlay"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-title"><div className="section-head"><h2 id="upload-title">{modal === 'audio' ? 'Добавить аудиозапись' : 'Вставить расшифровку'}</h2><button aria-label="Закрыть окно" disabled={locked} onClick={() => setModal(null)}>×</button></div>
      <p className="muted">{kind === 'history' ? 'Прошлый приём — для истории и поиска контекста.' : 'Текущий приём — для заполнения консультации.'}</p>
      <label>Название<input value={title} maxLength={200} placeholder="Например, повторный приём" onChange={e => setTitle(e.target.value)} /></label><label>Дата приёма <span className="muted">(необязательно)</span><input type="date" value={day} onChange={e => setDay(e.target.value)} /></label>
      {modal === 'audio' ? <><label>Язык разговора<select value={language} onChange={e => setLanguage(e.target.value)}><option value="ru">Русский</option><option value="kk">Казахский</option><option value="auto">Определить автоматически</option></select></label><label className="file-drop">Выбрать аудио<input type="file" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,.mp4" multiple={kind === 'history'} onChange={e => setFiles(Array.from(e.target.files || []))} /><small>До 30 МБ и 30 минут на файл. Для разных дат добавляйте записи отдельно.</small></label>{files.length > 0 && <p>{files.length} файл(а/ов) выбрано</p>}
        {cap?.speech === 'not_configured' && <div className="stale">WhisperX ещё не запущен. Для аудио сначала подключите сервис на компьютере команды.</div>}
        <p className="small muted">Аудио передаётся настроенному WhisperX. Временный файл на нём удаляется после обработки. Текст остаётся в памяти этой сессии; автоматического удаления имён из речи пока нет.</p></> : <label>Текст разговора<textarea rows={9} value={text} maxLength={100000} placeholder={'Пациент: Жалобы: слабость.\nВрач: Рекомендации: принести прошлые анализы.'} onChange={e => setText(e.target.value)} /><small>Каждая реплика — с новой строки. Префиксы «Врач:» и «Пациент:» задают роли.</small></label>}
      {error && <div className="alert error" role="alert">{error}</div>}
      <button className="primary full" disabled={locked || (modal === 'audio' ? !files.length || cap?.speech === 'not_configured' : !text.trim())} onClick={() => void run(modal === 'audio' ? 'Загружаем и расшифровываем аудио' : 'Добавляем запись', modal === 'audio' ? addAudio : addText)}>{modal === 'audio' ? 'Загрузить и расшифровать' : 'Добавить запись'}</button>
    </section></div>}
  </>;
}

createRoot(document.getElementById('root')!).render(<App />);
