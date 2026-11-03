"""User-scoped EvaTeam task operations.

No remote tasks are copied into the shared local Task table. Every call uses
the authenticated caller's own encrypted EvaTeam bearer token.
"""
import html
import re
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .credentials import retrieve as retrieve_credential
from .eva_client import EvaError, call as eva_call

router = APIRouter(prefix="/eva", tags=["EvaTeam tasks"])
TASK_CODE = re.compile(r"^[\w.-]{1,100}$", re.UNICODE)


def _user_context():
    # Late import prevents circular dependency with app.main.
    from .main import current_user, db_session
    return current_user, db_session


# Dependencies are installed by attach() after main.current_user exists.
def attach(user_dep, db_dep):
    def token(db: Session = Depends(db_dep), user=Depends(user_dep)) -> str:
        key = retrieve_credential(db, user.id)
        if not key:
            raise HTTPException(409, "Сначала подключи персональный токен EvaTeam в настройках")
        return key

    def invoke(key: str, method: str, *, kwargs=None, args=None):
        try:
            return eva_call(key, method, kwargs=kwargs, args=args)
        except EvaError as exc:
            # Remote messages could contain secrets, do not reflect them.
            if exc.status == 422:
                raise HTTPException(422, "EvaTeam отклонила операцию: проверь права, поля и ограничения проекта") from exc
            raise HTTPException(exc.status, "Ошибка соединения с EvaTeam или ответа API") from exc

    def code_ok(value: str) -> str:
        if not TASK_CODE.fullmatch(value):
            raise HTTPException(422, "Некорректный код объекта EvaTeam")
        return value

    def entries(data):
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            for name in ("items", "rows", "data", "result"):
                if isinstance(data.get(name), list):
                    return data[name]
        raise HTTPException(502, "EvaTeam вернула неожиданный формат списка")

    def plain(data):
        if isinstance(data, dict):
            return data
        if isinstance(data, list) and data and isinstance(data[0], dict):
            return data[0]
        raise HTTPException(502, "EvaTeam вернула неожиданный формат карточки")

    @router.get("/tasks")
    def list_tasks(
        offset: int = Query(0, ge=0),
        limit: int = Query(50, ge=1, le=100),
        project: str | None = Query(None, max_length=100),
        search: str = Query("", max_length=200),
        key: str = Depends(token),
    ):
        kwargs = {"slice": [offset, offset + limit], "fields": ["*"], "order_by": ["-cmf_created_at"]}
        if project:
            kwargs["filter"] = ["parent", "==", code_ok(project)]
        data = entries(invoke(key, "CmfTask.list", kwargs=kwargs))
        if search:
            q = search.casefold()
            data = [row for row in data if isinstance(row, dict) and q in (str(row.get("name", "")) + " " + str(row.get("code", ""))).casefold()]
        return {"items": data, "offset": offset, "limit": limit, "has_more": len(data) == limit}

    @router.get("/projects")
    def projects(
        offset: int = Query(0, ge=0),
        limit: int = Query(100, ge=1, le=100),
        key: str = Depends(token),
    ):
        return {"items": entries(invoke(key, "CmfProject.list", kwargs={"slice": [offset, offset + limit], "fields": ["*"]}))}

    @router.get("/people")
    def people(
        offset: int = Query(0, ge=0),
        limit: int = Query(100, ge=1, le=100),
        key: str = Depends(token),
    ):
        return {"items": entries(invoke(key, "CmfPerson.list", kwargs={"slice": [offset, offset + limit], "fields": ["*"]}))}

    @router.get("/tasks/{code}")
    def task_detail(code: str, key: str = Depends(token)):
        data = plain(invoke(key, "CmfTask.get", kwargs={"filter": ["code", "==", code_ok(code)], "fields": ["**"]}))
        return data

    class CreateTask(BaseModel):
        name: str = Field(min_length=1, max_length=300)
        text: str = Field(default="", max_length=50000)
        project: str = Field(min_length=1, max_length=100)
        priority: int | None = Field(default=None, ge=0, le=5)
        responsible: str | None = Field(default=None, max_length=200)

    @router.post("/tasks", status_code=201)
    def create_task(payload: CreateTask, key: str = Depends(token)):
        kwargs = {"name": payload.name, "parent": code_ok(payload.project), "text": payload.text}
        if payload.priority is not None:
            kwargs["priority"] = payload.priority
        if payload.responsible:
            kwargs["responsible"] = payload.responsible
        return {"result": invoke(key, "CmfTask.create", kwargs=kwargs)}

    class PatchTask(BaseModel):
        name: str | None = Field(default=None, min_length=1, max_length=300)
        text: str | None = Field(default=None, max_length=50000)
        status: str | None = Field(default=None, min_length=1, max_length=100)
        priority: int | None = Field(default=None, ge=0, le=5)
        responsible: str | None = Field(default=None, max_length=200)

    @router.patch("/tasks/{code}")
    def update_task(code: str, payload: PatchTask, key: str = Depends(token)):
        changes = payload.model_dump(exclude_unset=True)
        if not changes:
            raise HTTPException(422, "Нет изменений")
        # EvaTeam update expects a CmfTask:<uuid> identifier, not a task code.
        item = plain(invoke(key, "CmfTask.get", kwargs={"filter": ["code", "==", code_ok(code)], "fields": ["*"]}))
        object_id = item.get("id") or item.get("cmf_id")
        if not isinstance(object_id, str) or not object_id:
            raise HTTPException(502, "EvaTeam не вернула ID задачи для изменения")
        if not object_id.startswith("CmfTask:"):
            object_id = "CmfTask:" + object_id
        return {"result": invoke(key, "CmfTask.update", args=[object_id], kwargs=changes)}

    class NewComment(BaseModel):
        text: str = Field(min_length=1, max_length=20000)

    @router.post("/tasks/{code}/comments", status_code=201)
    def comment(code: str, payload: NewComment, key: str = Depends(token)):
        # A plain-text editor must not submit untrusted HTML into EvaTeam.
        safe_html = "<p>" + html.escape(payload.text).replace("\n", "<br>") + "</p>"
        return {"result": invoke(key, "CmfComment.create", kwargs={"parent": code_ok(code), "text": safe_html})}
