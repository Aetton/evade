"""User-scoped EvaTeam task operations.

No remote tasks are copied into the shared local Task table. Every call uses
the authenticated caller's own encrypted EvaTeam bearer token.
"""
from heapq import merge
from itertools import islice
import html
import re
from datetime import datetime, timezone
from sqlalchemy import select, func
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .task_description import eva_description
from .credentials import retrieve as retrieve_credential
from .models import EvaIdentity, EvaTaskCache, Task, SyncOutbox, ExternalLink
from .eva_client import EvaError, call as eva_call

router = APIRouter(prefix="/eva", tags=["EvaTeam tasks"])
PERSON_ID = re.compile(r"^(?:Person|CmfPerson):[a-zA-Z0-9_-]{1,100}$")
PROJECT_ID = re.compile(r"^(?:(?:CmfProject|Project):)?[a-zA-Z0-9_.-]{1,100}$")
TASK_CODE = re.compile(r"^[\w.-]{1,100}$", re.UNICODE)


def _user_context():
    # Late import prevents circular dependency with app.main.
    from .main import current_user, db_session
    return current_user, db_session


def entries(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for name in ("items", "rows", "data", "result"):
            if isinstance(data.get(name), list):
                return data[name]
    raise HTTPException(502, "EvaTeam вернула неожиданный формат списка")


def resolve_identity(key: str):
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
            return {"id": person_id, "name": (candidate.get("name") if isinstance(candidate, dict) else None) or data.get("name") or data.get("login") or person_id, "requires_selection": False}
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
    for person in matches if len(matches) == 1 else []:
        if isinstance(person, dict) and isinstance(person.get("id"), str) and PERSON_ID.fullmatch(person["id"]) and person.get("login") == login:
            return {"id": person["id"], "name": person.get("name") or login, "requires_selection": False}
    return {"id": None, "name": None, "requires_selection": True}


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
    def own_eva_identity(db: Session = Depends(db_dep), user=Depends(user_dep)):
        identity = db.get(EvaIdentity, user.id)
        if identity:
            return {"id": identity.person_id, "name": user.name, "requires_selection": False}
        return resolve_identity(token(db, user))

    def update_cache(db: Session, user_id: str, responsible: str, items: list) -> None:
        # Only snapshots from the authenticated caller's upstream token
        # are stored, isolated by EvaDE user_id.
        for item in items:
            if not isinstance(item, dict):
                continue
            remote_id = item.get("id") or item.get("code")
            if not isinstance(remote_id, str) or not remote_id:
                continue
            # Different assignee tabs can fetch the same task concurrently.
            if db.get_bind().dialect.name == "postgresql":
                from sqlalchemy.dialects.postgresql import insert
            else:
                from sqlalchemy.dialects.sqlite import insert
            stmt = insert(EvaTaskCache).values(user_id=user_id, remote_id=remote_id,
                                               responsible_id=responsible, snapshot=item)
            db.execute(stmt.on_conflict_do_update(index_elements=["user_id", "remote_id"],
                set_={"snapshot": item, "responsible_id": responsible, "fetched_at": datetime.now(timezone.utc)}))
        db.commit()

    def person_tasks(key: str, responsible: str, page_size: int, project: str | None = None):
        person_ok(responsible)
        if project and not PROJECT_ID.fullmatch(project):
            raise HTTPException(422, "Некорректный ID проекта EvaTeam")
        fields = ["id", "code", "name", "responsible", "executors", "status", "status_id",
                  "cache_status_type", "priority", "lists", "parent_task_id", "parent_id",
                  "project_id", "cmf_modified_at", "cmf_created_at"]
        def stream(role):
            condition = [role, "==", responsible]
            filters = [condition, ["project_id", "==", project]] if project else condition
            start = 0
            while True:
                rows = entries(invoke(key, "CmfTask.list", kwargs={
                    "fields": fields, "slice": [start, start + page_size],
                    "filter": filters, "order_by": ["-cmf_created_at", "-id"]}))
                yield from rows
                if len(rows) < page_size:
                    return
                start += len(rows)

        seen = set()
        for row in merge(stream("responsible"), stream("executors.id"), reverse=True,
                         key=lambda r: (r.get("cmf_created_at") or "", r.get("id") or r["code"])):
            identity = row.get("id") or row["code"]
            if identity not in seen:
                seen.add(identity)
                yield row

    @router.get("/sync/status")
    def sync_status(db: Session = Depends(db_dep), user=Depends(user_dep),
                    key: str = Depends(token)):
        cached = db.scalar(select(func.count(EvaTaskCache.id)).where(EvaTaskCache.user_id == user.id))
        # Old local tasks/outbox are NOT synchronized: display this explicitly,
        # never claim the database is fully reconciled when work remains.
        legacy = db.scalar(select(func.count(Task.id)))
        pending = db.scalar(select(func.count(SyncOutbox.id)).where(SyncOutbox.state == "pending"))
        return {"cached": cached or 0, "legacy_tasks": legacy or 0,
                "legacy_outbox_pending": pending or 0, "mode": "remote_write_through"}

    class SyncSelection(BaseModel):
        responsible: list[str] = Field(min_length=1, max_length=20)

    @router.post("/sync")
    def sync_selected(payload: SyncSelection, db: Session = Depends(db_dep),
                      user=Depends(user_dep), key: str = Depends(token)):
        people = list(dict.fromkeys(person_ok(pid) for pid in payload.responsible))
        synced = 0
        partial = []
        for person in people:
            offset = 0
            stream = person_tasks(key, person, 100)
            while offset < 2000:
                rows = list(islice(stream, 100))
                update_cache(db, user.id, person, rows)
                synced += len(rows)
                offset += len(rows)
                if len(rows) < 100:
                    break
            else:
                partial.append(person)
        return {"synced": synced, "partial": partial, "people": len(people),
                "mode": "remote_write_through"}

    @router.get("/tasks/cached")
    def cached_tasks(responsible: str, offset: int = Query(0, ge=0),
                     limit: int = Query(50, ge=1, le=100),
                     db: Session = Depends(db_dep), user=Depends(user_dep)):
        person_ok(responsible)
        stmt = select(EvaTaskCache).where(EvaTaskCache.user_id == user.id)
        rows = []
        skipped = 0
        for row in db.scalars(stmt.order_by(EvaTaskCache.fetched_at.desc(), EvaTaskCache.id)):
            snapshot = row.snapshot
            members = [snapshot.get("responsible"), *(snapshot.get("executors") or [])]
            ids = {v.get("id") if isinstance(v, dict) else v for v in members if v}
            if responsible not in ids and row.responsible_id != responsible:
                continue
            if skipped < offset:
                skipped += 1
                continue
            rows.append(row)
            if len(rows) > limit:
                break
        return {"items": [row.snapshot for row in rows[:limit]], "offset": offset, "limit": limit,
                "has_more": len(rows) > limit, "cached": True}

    @router.get("/tasks")
    def list_tasks(
        offset: int = Query(0, ge=0),
        limit: int = Query(50, ge=1, le=100),
        project: str | None = Query(None, max_length=100),
        responsible: str = Query(..., min_length=1, max_length=150),
        search: str = Query("", max_length=200),
        key: str = Depends(token),
        db: Session = Depends(db_dep),
        user=Depends(user_dep),
    ):
        data = list(islice(person_tasks(key, responsible, limit, project), offset, offset + limit))
        update_cache(db, user.id, responsible, data)
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
        rows = entries(invoke(key, "CmfProject.list", kwargs={"slice": [offset, offset + limit],
                                                       "fields": ["id", "code", "name", "parent_id"]}))
        return {"items": rows, "has_more": len(rows) == limit, "offset": offset}

    @router.get("/people/by-id")
    def person_by_id(id: str, key: str = Depends(token)):
        rows = entries(invoke(key, "CmfPerson.list", kwargs={
            "filter": ["id", "==", person_ok(id)], "fields": ["id", "name", "login"], "slice": [0, 1]}))
        if not rows or rows[0].get("id") != id:
            raise HTTPException(404, "Сотрудник недоступен")
        return rows[0]

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
        data = plain(invoke(key, "CmfTask.get", kwargs={"filter": ["code", "==", code_ok(code)], "fields": ["*", "comments.*", "executors.*"]}))
        return data

    class DescriptionPreview(BaseModel):
        text: str = Field(max_length=50000)

    @router.post("/description/preview")
    def preview_description(payload: DescriptionPreview, user=Depends(user_dep)):
        return {"html": eva_description(payload.text)}

    class CreateTask(BaseModel):
        name: str = Field(min_length=1, max_length=300)
        text: str = Field(default="", max_length=50000)
        project: str | None = Field(default=None, min_length=1, max_length=100)
        parent_task: str | None = Field(default=None, min_length=1, max_length=100)
        priority: int | None = Field(default=None, ge=0, le=5)
        responsible: str | None = Field(default=None, max_length=200)
        executors: list[str] | None = Field(default=None, max_length=100)

    @router.post("/tasks", status_code=201)
    def create_task(payload: CreateTask, key: str = Depends(token)):
        if bool(payload.project) == bool(payload.parent_task):
            raise HTTPException(422, "Укажи проект или родительскую задачу")
        if payload.parent_task:
            parent_row = plain(invoke(key, "CmfTask.get", kwargs={
                "filter": ["code", "==", code_ok(payload.parent_task)], "fields": ["id", "code"]}))
            object_id = parent_row.get("id") or parent_row.get("cmf_id")
            if not object_id:
                raise HTTPException(502, "EvaTeam не вернула ID родительской задачи")
            parent = "CmfTask:" + str(object_id).removeprefix("CmfTask:")
        else:
            parent = code_ok(payload.project)
        kwargs = {"name": payload.name, "parent": parent, "text": eva_description(payload.text)}
        if payload.priority is not None:
            kwargs["priority"] = payload.priority
        if payload.responsible:
            kwargs["responsible"] = person_ok(payload.responsible)
        if payload.executors:
            kwargs["executors"] = list(dict.fromkeys(person_ok(pid) for pid in payload.executors if pid != payload.responsible))
        return {"result": invoke(key, "CmfTask.create", kwargs=kwargs)}

    class PatchTask(BaseModel):
        name: str | None = Field(default=None, min_length=1, max_length=300)
        text: str | None = Field(default=None, max_length=50000)
        status: str | None = Field(default=None, min_length=1, max_length=100)
        priority: int | None = Field(default=None, ge=0, le=5)
        responsible: str | None = Field(default=None, max_length=200)
        executors: list[str] | None = Field(default=None, max_length=100)

    @router.patch("/tasks/{code}")
    def update_task(code: str, payload: PatchTask, key: str = Depends(token)):
        changes = payload.model_dump(exclude_unset=True)
        if isinstance(changes.get("text"), str):
            changes["text"] = eva_description(changes["text"])
        if "executors" in changes:
            changes["executors"] = list(dict.fromkeys(person_ok(pid) for pid in (payload.executors or []) if pid != payload.responsible))
        if not changes:
            raise HTTPException(422, "Нет изменений")
        if "responsible" in changes and changes["responsible"] is not None:
            if not PERSON_ID.fullmatch(changes["responsible"]):
                raise HTTPException(422, "Ответственного нужно выбрать из справочника сотрудников EvaTeam")
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
