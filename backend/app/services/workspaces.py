from datetime import timedelta
from threading import RLock
from uuid import UUID

from app.errors import AppError
from app.schemas import utcnow
from app.services.calculations import find_measurements
from app.workspace_models import Record, Workspace


class WorkspaceStore:
    """One-process demo storage. No clinical documents are written to SQLite."""

    def __init__(self, ttl_seconds: int = 3600):
        self.ttl_seconds = ttl_seconds
        self.items: dict[UUID, Workspace] = {}
        self.lock = RLock()

    def purge(self):
        with self.lock:
            for key in list(self.items):
                if self.items[key].expires_at <= utcnow():
                    del self.items[key]

    def create(self) -> Workspace:
        with self.lock:
            self.purge()
            if len(self.items) >= 20:
                raise AppError(429, "WORKSPACE_LIMIT", "Удалите одну из временных сессий.")
            workspace = Workspace(expires_at=utcnow() + timedelta(seconds=self.ttl_seconds))
            self.items[workspace.id] = workspace
            return workspace.model_copy(deep=True)

    def require(self, workspace_id: UUID) -> Workspace:
        # Caller holds lock for the entire read/mutation, including revision check.
        self.purge()
        if workspace_id not in self.items:
            raise AppError(404, "WORKSPACE_EXPIRED", "Сессия удалена или истёк час хранения.")
        return self.items[workspace_id]

    def get(self, workspace_id: UUID) -> Workspace:
        with self.lock:
            return self.require(workspace_id).model_copy(deep=True)

    def editable(self, workspace_id: UUID, revision: int) -> Workspace:
        workspace = self.require(workspace_id)
        if workspace.revision != revision:
            raise AppError(409, "REVISION_CONFLICT", "Данные изменились. Обновите сессию.")
        if any(j.status == "transcribing" for j in workspace.jobs):
            raise AppError(409, "AUDIO_BUSY", "Дождитесь завершения расшифровки.")
        return workspace

    @staticmethod
    def changed(workspace: Workspace, context_changed: bool = False):
        workspace.revision += 1
        workspace.confirmed_revision = None
        if context_changed:
            workspace.measurements = find_measurements(workspace.records)
            workspace.calculation = None
            workspace.context_stale = workspace.generated
            workspace.evidence = []
            workspace.previous_recommendations = []
            workspace.field_sources = []

    @staticmethod
    def check_record(workspace: Workspace, kind: str):
        if len(workspace.records) >= 12:
            raise AppError(409, "RECORD_LIMIT", "В демо можно добавить до 12 записей.")
        if kind == "current" and any(r.kind == "current" for r in workspace.records):
            raise AppError(409, "CURRENT_EXISTS", "Удалите текущую запись перед заменой.")

    def add_record(self, workspace: Workspace, record: Record):
        self.check_record(workspace, record.kind)
        workspace.records.append(record)
        self.changed(workspace, context_changed=True)
