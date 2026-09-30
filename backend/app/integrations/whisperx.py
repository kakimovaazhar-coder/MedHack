from pathlib import Path

from app.errors import AppError
from app.schemas import Transcript


class WhisperXProvider:
    async def transcribe(self, audio: Path, language: str) -> Transcript:
        # Next step: local worker or authenticated HTTP client to the team's GPU host.
        raise AppError(503, "WHISPERX_NOT_CONFIGURED", "Сервис WhisperX ещё не подключён.")
