import { useEffect, useState } from 'react';
import type { Workspace } from './api';

type Props = { workspace: Workspace | null; locked: boolean; apply: (body: object) => void; openSource: (record: string, segment: string) => void };
type Values = { height_cm: string; weight_kg: string; hb_g_l: string; target_hb_g_l: string; iron_store_mg: string };
const blank: Values = { height_cm: '', weight_kg: '', hb_g_l: '', target_hb_g_l: '', iron_store_mg: '' };
const captions: Record<keyof Values, string> = { height_cm: 'Рост, см', weight_kg: 'Вес, кг', hb_g_l: 'Гемоглобин, г/л', target_hb_g_l: 'Целевой Hb, г/л', iron_store_mg: 'Запас железа, мг' };

export function Calculator({ workspace, locked, apply, openSource }: Props) {
  const [values, setValues] = useState<Values>(blank);
  const [mode, setMode] = useState<'bmi' | 'iron_deficit'>('iron_deficit');
  const [drug, setDrug] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const measurements = JSON.stringify(workspace?.measurements || []);
  useEffect(() => {
    const next = { ...blank };
    for (const key of Object.keys(next) as (keyof Values)[]) {
      const candidates = (workspace?.measurements || []).filter(m => m.kind === key && m.record_kind === 'current');
      const unique = [...new Set(candidates.map(m => String(m.value)))];
      if (unique.length === 1) next[key] = unique[0];
    }
    setValues(next); setReviewed(false); setDrug('');
  }, [workspace?.id, measurements]);
  const n = (key: keyof Values) => Number(values[key].replace(',', '.'));
  const validBmi = n('height_cm') >= 30 && n('height_cm') <= 300 && n('weight_kg') >= 1 && n('weight_kg') <= 1000;
  const validIron = validBmi && n('hb_g_l') > 0 && n('target_hb_g_l') <= 250 && n('target_hb_g_l') > n('hb_g_l') && values.iron_store_mg !== '' && n('iron_store_mg') >= 0 && n('iron_store_mg') <= 3000;
  const bmi = validBmi ? n('weight_kg') / (n('height_cm') / 100) ** 2 : null;
  const deficit = validIron ? n('weight_kg') * (n('target_hb_g_l') - n('hb_g_l')) * 0.24 + n('iron_store_mg') : null;
  const changed = (key: keyof Values, value: string) => { setValues({ ...values, [key]: value }); setReviewed(false); };
  return <section className="calculator"><div className="calc-heading"><div><span className="eyebrow">ИЗ РАЗГОВОРА → В РАСЧЁТ</span><h3>ИМТ и дефицит железа</h3></div><span className="calc-symbol">ƒ</span></div>
    <p className="small muted">Значения с однозначными единицами подставляются из текущей записи. Проверьте их по источнику.</p>
    <label className="small">Расчёт<select value={mode} disabled={locked} onChange={e => { setMode(e.target.value as typeof mode); setReviewed(false); }}><option value="iron_deficit">Анемия: ИМТ + формула Ганзони</option><option value="bmi">Только ИМТ</option></select></label>
    <div className="calc-grid">{(Object.keys(captions) as (keyof Values)[]).filter(k => mode === 'iron_deficit' || k === 'height_cm' || k === 'weight_kg').map(key => <label key={key}>{captions[key]}<input inputMode="decimal" aria-label={captions[key]} value={values[key]} disabled={locked} onChange={e => changed(key, e.target.value)} placeholder="Уточнить" />
      {(workspace?.measurements || []).filter(m => m.kind === key).map((m,i) => <span className="measurement" key={i}><button title={String(m.quote)} disabled={locked} onClick={() => changed(key, String(m.value))}>{String(m.value)} · {m.record_kind === 'history' ? `история ${m.visit_date || 'без даты'}` : 'из разговора'}</button><button aria-label={`Источник ${captions[key]} ${i+1}`} onClick={() => openSource(String(m.record_id), String(m.segment_id))}>↗</button></span>)}
    </label>)}</div>
    {bmi !== null && <div className="calc-result"><span>ИМТ <strong>{bmi.toFixed(1)}</strong> кг/м²</span><small>{values.weight_kg} ÷ ({values.height_cm} / 100)²</small></div>}
    {mode === 'iron_deficit' && <>
      <label className="small">Препарат — выбирает врач<input list="iron-drugs" value={drug} disabled={locked} maxLength={200} placeholder="Выбрать или ввести название" onChange={e => { setDrug(e.target.value); setReviewed(false); }} /><datalist id="iron-drugs"><option value="Венофер (железа сахарозный комплекс)" /></datalist></label>
      {deficit !== null ? <div className="calc-result iron"><span>Общий дефицит железа <strong>{Number(deficit.toFixed(2))}</strong> мг</span><small>{values.weight_kg} × ({values.target_hb_g_l} − {values.hb_g_l}) × 0,24 + {values.iron_store_mg}</small></div> : <p className="empty-note">Для расчёта нужны актуальный Hb, целевой Hb и запас железа. Целевые параметры задаёт врач.</p>}
      <p className="calc-disclaimer">Это общая потребность в элементарном железе. Разовую дозу, путь и схему введения врач определяет по инструкции выбранного препарата. ИМТ не задаёт дозировку.</p>
      <a className="reference" href="https://www.medicines.org.uk/emc/product/5911/smpc" target="_blank" rel="noreferrer">Формула Ганзони · источник ↗</a>
    </>}
    <label className="check-label"><input type="checkbox" checked={reviewed} disabled={locked || !(mode === 'bmi' ? validBmi : validIron)} onChange={e => setReviewed(e.target.checked)} /><span>Проверены исходные данные, их актуальность и применимость формулы</span></label>
    <button className="secondary full" disabled={locked || !workspace || !reviewed || !(mode === 'bmi' ? validBmi : validIron)} onClick={() => apply({
      mode, height_cm: n('height_cm'), weight_kg: n('weight_kg'), reviewed,
      medication: mode === 'iron_deficit' ? drug : '',
      ...(mode === 'iron_deficit' ? { hb_g_l: n('hb_g_l'), target_hb_g_l: n('target_hb_g_l'), iron_store_mg: n('iron_store_mg') } : {}),
    })}>В рекомендации справа →</button>
  </section>;
}
