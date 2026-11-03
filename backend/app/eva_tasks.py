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
PERSON_ID = re.compile(r"^(?:Person|CmfPerson):[a-zA-Z0-9_-]{1,100}$")
PROJECT_ID = re.compile(r"^(?:(?:CmfProject|Project):)?[a-zA-Z0-9_.-]{1,100}$")
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


    def person_ok(value: str) -> str:
        if not PERSON_ID.fullmatch(value):
            raise HTTPException(422, "Выбери исполнителя из списка EvaTeam")
        return value

    @router.get("/me")
    def own_eva_identity(key: str = Depends(token)):
        # Some installations disable User.getCurrentUser for API tokens.
        # This optional discovery must never block manual Person selection.
        try:
            data = eva_call(key, "User.getCurrentUser", kwargs={})
        except EvaError as exc:
            if exc.status == 422:
                return {"id": None, "name": None, "requires_selection": True}
            raise HTTPException(exc.status, "Не удалось связаться с EvaTeam для определения пользователя") from exc
        if not isinstance(data, dict):
            return {"id": None, "name": None, "requires_selection": True}
        for candidate in (data.get("person"), data.get("person_id"), data.get("cmf_person"), data.get("id")):
            person_id = candidate.get("id") if isinstance(candidate, dict) else candidate
            if isinstance(person_id, str) and PERSON_ID.fullmatch(person_id):
                return {"id": person_id, "name": data.get("name") or data.get("login") or person_id, "requires_selection": False}
        login = data.get("login") or data.get("username")
        if not isinstance(login, str) or not login.strip():
            return {"id": None, "name": None, "requires_selection": True}
        try:
            matches = entries(eva_call(key, "CmfPerson.list", kwargs={
                "filter": ["login", "==", login], "fields": ["id", "name", "login"], "slice": [0, 2]}))
        except EvaError as exc:
            if exc.status == 422:
                return {"id": None, "name": None, "requires_selection": True}
            raise HTTPException(exc.status, "Не удалось получить сотрудника EvaTeam") from exc
        for person in matches:
            if isinstance(person, dict) and isinstance(person.get("id"), str) and PERSON_ID.fullmatch(person["id"]):
                return {"id": person["id"], "name": person.get("name") or login, "requires_selection": False}
        return {"id": None, "name": None, "requires_selection": True}

    @router.get("/tasks")
    def list_tasks(
        offset: int = Query(0, ge=0),
        limit: int = Query(50, ge=1, le=100),
        project: str | None = Query(None, max_length=100),
        responsible: str = Query(..., min_length=1, max_length=150),
        search: str = Query("", max_length=200),
        key: str = Depends(token),
    ):
        filters = [["responsible", "==", person_ok(responsible)]]
        if project:
            if not PROJECT_ID.fullmatch(project):
                raise HTTPException(422, "Некорректный ID проекта EvaTeam")
            filters.append(["project_id", "==", project])
        kwargs = {"slice": [offset, offset + limit],
                  "fields": ["id", "code", "name", "responsible", "status", "status_id", "cache_status_type", "priority", "cmf_created_at"],
                  "order_by": ["-cmf_created_at"], "filter": filters[0] if len(filters) == 1 else filters}
        data = entries(invoke(key, "CmfTask.list", kwargs=kwargs))
        has_more = len(data) == limit
        if search:
            q = search.casefold()
            data = [row for row in data if isinstance(row, dict) and q in (str(row.get("name", "")) + " " + str(row.get("code", ""))).casefold()]
        return {"items": data, "offset": offset, "limit": limit, "has_more": has_more}

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
        name: str = Query("", max_length=100),
        limit: int = Query(100, ge=1, le=100),
        key: str = Depends(token),
    ):
        kwargs = {"slice": [offset, offset + limit], "fields": ["id", "name", "login", "email"]}
        term = name.strip()
        if term:
            if len(term) < 2:
                raise HTTPException(422, "Введи минимум два символа имени")
            if any(c in term for c in ("%", "_", chr(92))):
                raise HTTPException(422, "Недопустимые символы поискового запроса")
            # Dotted usernames and email addresses are logins, not Person.name.
            # A name-only LIKE silently hides users such as kirill.nechaev.
            if "." in term or "@" in term:
                # Exact login lookup uses == (supported by older EvaTeam instances).
                # Partial usernames still fall back to LIKE.
                exact_kwargs = {**kwargs, "filter": ["login", "==", term]}
                exact = entries(invoke(key, "CmfPerson.list", kwargs=exact_kwargs))
                if exact:
                    return {"items": exact, "has_more": False}
                kwargs["filter"] = ["login", "LIKE", "%" + term + "%"]
            else:
                kwargs["filter"] = ["name", "LIKE", "%" + term + "%"]
        items = entries(invoke(key, "CmfPerson.list", kwargs=kwargs))
        return {"items": items, "has_more": len(items) == limit}

    @router.get("/tasks/{code}")
    def task_detail(code: str, key: str = Depends(token)):
        data = plain(invoke(key, "CmfTask.get", kwargs={"filter": ["code", "==", code_ok(code)], "fields": ["*", "comments.*"]}))
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
        if object_id is None or object_id == "":
            raise HTTPException(502, "EvaTeam не вернула ID задачи для изменения")
        object_id = str(object_id)
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
