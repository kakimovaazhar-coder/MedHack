# Инструкция разработчику frontend

Актуальный интерфейс уже находится в `frontend/`. Новый сценарий истории, аудио,
OpenAI и калькуляторов описан в [demo-workspace.md](demo-workspace.md).
Разделы ниже описывают прежний отдельный контракт `/api/consultations`.

Можно начинать экран React + TypeScript: пациент, слева транскрипт, справа шесть textarea,
«Сохранить», «Подтвердить», «Тестовый экспорт», «Загрузить демопример».
Запись и загрузка аудио описаны в контракте, но распознавание пока возвращает 503.

## Поля и типы

Все имена в `snake_case`. Источник истины — `contracts/openapi.json`;
`patientId` и `medications` из ранних эскизов в API не используются.

| Поле | Подпись | Тип |
|---|---|---|
| complaints | Жалобы | string или null |
| anamnesis | Анамнез | string или null |
| allergies | Аллергии | string или null |
| diagnosis | Диагноз | string или null |
| prescriptions | Назначения | string или null |
| recommendations | Рекомендации | string или null |

Назначения пока единый текст. В textarea отображайте `value ?? ''`, перед сохранением
используйте `value.trim() || null`. Null означает «Не указано», а не «Отсутствует».

## Подключение

В корне скопировать `.env.example` в `.env`, затем `docker compose up --build`.
Swagger: http://localhost:8000/docs. Базовый URL клиента **включает `/api`**:

```dotenv
VITE_API_BASE_URL=http://localhost:8000/api
```

Если backend на другом компьютере, вместо localhost — его доступный IP/HTTPS-адрес.
На backend задайте точный origin frontend, например:

```dotenv
MEDHUB_BIND_HOST=0.0.0.0
MEDHUB_CORS_ORIGINS=["http://localhost:5173","http://192.168.1.30:5173"]
```

IP здесь пример. После изменения настроек перезапустить backend. Без Docker для LAN
также нужен `--host 0.0.0.0`. Только доверенная сеть и синтетические данные: авторизации
пока нет. CORS не контролирует доступ к данным. OpenAI-ключ не помещать во frontend.

## Порядок вызовов

1. `GET /api/health`: доступность и возможности. `status: ok` не означает готовность AI;
   проверять `speech`, `llm`, `pii`, `demo_enabled`.
2. `POST /api/consultations` → `201`:

```json
{"patient_id":"demo-patient-001","language":"ru"}
```

Сохранить весь ответ, особенно `id` и `revision`. Язык: ru/kk/auto — настройка будущего
распознавания; готовая поддержка языка пока не заявляется.

3. `POST /api/consultations/{id}/demo` → `202`:

```json
{"expected_revision":1}
```

Сохранить `job.id`. Демо доступно только для новой пустой консультации при
`MEDHUB_DEMO_ENABLED=true`, использует русский синтетический пример.

Будущая загрузка: `POST /api/consultations/{id}/audio`, multipart-поля `file` и
`expected_revision`. Не задавать Content-Type вручную для FormData. Сегодня ответ
`503 WHISPERX_NOT_CONFIGURED`; не показывать успех или фиктивный транскрипт.

4. Опрос `GET /api/jobs/{job_id}` раз в 1–2 секунды. Остановить при completed/failed
   и при уходе со страницы; предусмотреть предел ожидания и повторную загрузку.

| Статус | UI |
|---|---|
| queued | Ожидание |
| transcribing | Распознавание речи |
| masking | Маскирование данных |
| structuring | Заполнение полей |
| completed | Готово к проверке |
| failed | Показать error.message |

Демо быстро переходит queued → completed, промежуточные этапы можно не увидеть.
Примеры всех статусов в `contracts/examples/` предназначены для разработки UI,
они не свидетельствуют о готовности интеграций.

5. После completed: `GET /api/consultations/{id}`. Показать `transcript.segments`,
   `fields`, `warnings`; для `source: demo` — «Синтетический пример».
6. `PATCH /api/consultations/{id}` — полная замена шести полей:

```json
{
  "expected_revision": 2,
  "fields": {
    "complaints": "Температура, сухой кашель",
    "anamnesis": "Три дня",
    "allergies": "Со слов пациента: пенициллин",
    "diagnosis": null,
    "prescriptions": null,
    "recommendations": null
  }
}
```

Пропущенные поля станут null. Ответ — новая сохранённая версия. Пока есть несохранённые
правки, отключить подтверждение/экспорт. При конфликте не терять локальные правки,
загрузить новую версию сервера и предложить сопоставление.

7. `POST /api/consultations/{id}/confirm` с `expected_revision` последней сохранённой
   формы. Пустую форму подтвердить нельзя. Сохранить ответ.
8. `POST /api/consultations/{id}/export` с тем же `expected_revision`.
   Ответ: `mode: mock`, `external_id`, `revision`. Подпись — «Тестовый экспорт
   (локальная имитация)». Сетевого вызова МИС пока нет.

Повтор экспорта одной версии возвращает ту же квитанцию. Правка увеличивает revision
и сбрасывает подтверждение/квитанцию; подтвердить нужно снова.

## Статусы консультации

`draft` → `processing` → `review` → `confirmed` → `exported`.
Правка confirmed/exported возвращает в review. Статус задания и статус консультации
различаются. Во время processing правки блокируются.

## TypeScript-клиент

```ts
import { createMedHubClient } from "../../contracts/client";

const api = createMedHubClient(import.meta.env.VITE_API_BASE_URL);
let consultation = await api.create("demo-patient-001");
const job = await api.demo(consultation);
// Опрос api.job(job.id); после completed:
consultation = await api.get(consultation.id);
consultation = await api.save(consultation, {
  ...consultation.fields, complaints: "Исправленный текст",
});
consultation = await api.confirm(consultation);
const receipt = await api.export(consultation);
```

Путь импорта зависит от расположения файла. Типы генерируются, не дублируйте их вручную.
Ловите ApiError для HTTP-ошибок и сетевые ошибки при недоступности backend. AbortError
при отмене опроса не является ошибкой обработки.

Формат ошибок:

```json
{"error":{"code":"CONFIRMATION_REQUIRED","message":"Сначала подтвердите текущую форму.","details":[]}}
```

| HTTP / code | Действие |
|---|---|
| 403 DEMO_DISABLED | Отключить демо |
| 404 NOT_FOUND | Запись не найдена |
| 409 REVISION_CONFLICT | Обновить версию, сохранить локальные правки |
| 409 PROCESSING_IN_PROGRESS | Дождаться задания |
| 409 CONFIRMATION_REQUIRED | Предложить подтверждение |
| 409 EMPTY_CONSULTATION | Заполнить поля |
| 422 VALIDATION_ERROR | Проверить запрос |
| 503 WHISPERX_NOT_CONFIGURED | Распознавание не подключено |
| 503 MIS_NOT_CONFIGURED | Экспорт недоступен |

Критерий готовности: создать → демо → получить форму → изменить → сохранить → подтвердить
→ получить mock-квитанцию. Отдельно проверить пустые поля, конфликт версии и сетевую ошибку.
