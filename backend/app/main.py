from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException

from app.api import router
from app.config import Settings
from app.errors import (
    AppError,
    app_error_handler,
    http_error_handler,
    validation_error_handler,
)
from app.repository import Repository
from app.services.demo import DemoService
from app.services.workflow import Workflow


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    repository = Repository(settings.data_dir / "medhub.sqlite3")

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        repository.initialize()
        repository.recover_interrupted_jobs()
        yield

    application = FastAPI(
        title="MedHub consultation API",
        version="0.1.0",
        description=(
            "Скелет backend для Haqaton-042. Только синтетические данные: "
            "авторизация и реальные AI/МИС-интеграции ещё не реализованы. "
            "Все JSON-поля используют snake_case."
        ),
        lifespan=lifespan,
    )
    application.state.settings = settings
    application.state.repository = repository
    application.state.workflow = Workflow(repository)
    application.state.demo = DemoService(repository)
    application.add_exception_handler(AppError, app_error_handler)
    application.add_exception_handler(RequestValidationError, validation_error_handler)
    application.add_exception_handler(HTTPException, http_error_handler)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "PATCH"],
        allow_headers=["Content-Type"],
        allow_credentials=False,
    )
    application.include_router(router)
    return application


app = create_app()
