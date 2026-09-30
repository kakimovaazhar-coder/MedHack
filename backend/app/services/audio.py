from datetime import date
from uuid import UUID

import httpx
from pydantic import ValidationError

from app.config import Settings
from app.workspace_models import Record, SpeechResult

from .workspaces import WorkspaceStore


async def transcribe_audio(
    settings: Settings,
    store: WorkspaceStore,
    workspace_id: UUID,
    job_id: UUID,
    audio: bytes,
    title: str,
    kind: str,
    visit_date: date | None,
    language: str,
):
    try:
        headers = {"Content-Type": "application/octet-stream"}
        if settings.whisperx_api_token:
            headers["Authorization"] = f"Bearer {settings.whisperx_api_token}"
        async with httpx.AsyncClient(timeout=900, follow_redirects=False) as client:
            response = await client.post(
                settings.whisperx_base_url.rstrip("/") + "/transcribe",
                params={"language": language},
                content=audio,
                headers=headers,
            )
            response.raise_for_status()
            result = SpeechResult.model_validate(response.json())
        record = Record(
            title=title,
            kind=kind,
            visit_date=visit_date,
            origin="audio",
            segments=[
                segment.model_copy(update={"role": "unknown"}) for segment in result.segments
            ],
        )
        with store.lock:
            workspace = store.require(workspace_id)
            job = next(j for j in workspace.jobs if j.id == job_id)
            store.add_record(workspace, record)
            job.status = "completed"
            job.record_id = record.id
    except Exception as exc:
        if isinstance(exc, (ValueError, ValidationError)):
            message = "WhisperX вернул пустую или некорректную расшифровку."
        elif isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 401:
            message = "WhisperX отклонил ключ доступа. Проверьте настройки backend и worker."
        else:
            message = "Не удалось расшифровать аудио. Проверьте WhisperX и повторите загрузку."
        # Never expose upstream response bodies, transcripts, URLs or credentials.
        with store.lock:
            workspace = store.items.get(workspace_id)
            if workspace:
                job = next(j for j in workspace.jobs if j.id == job_id)
                job.status = "failed"
                job.error = message
                workspace.revision += 1
    finally:
        audio = b""
