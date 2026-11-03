"""Explicit, non-destructive reconciliation of legacy EvaDE tasks to EvaTeam.

There is no safe exactly-once remote create API guarantee here. This module
never creates, updates or deletes remote tasks: operators first inspect
candidates, then explicitly link a verified existing EvaTeam task by code.
Pending outbox entries are intentionally left pending until conflicts are
resolved in a later migration step.
"""
import hashlib
import json
import re
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from .models import Task, Project, User, EvaTaskCache, ExternalLink, SyncOutbox
from .credentials import retrieve as retrieve_credential
from .eva_client import EvaError, call as eva_call

router = APIRouter(prefix="/eva/reconcile", tags=["EvaTeam reconciliation"])
CODE_PATTERN = re.compile(r"^[\w.-]{1,100}$", re.UNICODE)
STATES = {"new": "TO DO", "in_progress": "IN PROGRESS", "review": "IN REVIEW", "done": "DONE"}


def local_digest(task: Task) -> str:
    fields = {
        "id": task.id, "title": task.title, "description": task.description,
        "status": task.status, "priority": task.priority,
        "project_id": task.project_id, "parent_id": task.parent_id,
        "assignee_id": task.assignee_id,
        "updated_at": task.updated_at.isoformat() if task.updated_at else None,
    }
    return hashlib.sha256(json.dumps(fields, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def remote_digest(remote: dict) -> str:
    fields = {name: remote.get(name) for name in
              ("id", "code", "name", "text", "status", "status_id", "priority",
               "project_id", "responsible_id", "parent_id", "cmf_modified_at", "cmf_version")}
    return hashlib.sha256(json.dumps(fields, sort_keys=True, default=str, ensure_ascii=False).encode()).hexdigest()


def normalize(value) -> str:
    return str(value or "").strip().casefold()


def remote_status(task: dict) -> str:
    state = task.get("status")
    if isinstance(state, dict):
        return str(state.get("code") or state.get("name") or "")
    return str(state or "")


def differences(local: Task, remote: dict) -> list[str]:
    diff = []
    if normalize(local.title) != normalize(remote.get("name")):
        diff.append("title")
    # Detail responses include full task text. Missing text is not proof of equality.
    if "text" not in remote or normalize(local.description) != normalize(remote.get("text")):
        diff.append("description")
    if normalize(STATES.get(local.status, local.status)) != normalize(remote_status(remote)):
        diff.append("status")
    # Priority scales differ (local 0–3 vs Eva 0–5); do not auto-map.
    diff.append("priority_requires_review")
    if local.project_id:
        diff.append("project_requires_review")
    if local.assignee_id:
        diff.append("assignee_requires_review")
    if local.parent_id:
        diff.append("parent_requires_review")
    return diff


def attach(user_dep, db_dep):
    def accessible(db: Session, user: User):
        stmt = select(Task)
        if not user.is_admin:
            stmt = stmt.where(or_(Task.created_by == user.id, Task.assignee_id == user.id))
        return stmt

    def require_access(db: Session, user: User, task_id: str) -> Task:
        task = db.scalar(accessible(db, user).where(Task.id == task_id))
        if task is None:
            raise HTTPException(404, "Локальная задача не найдена или недоступна")
        return task

    def get_link(db: Session, task_id: str):
        return db.scalar(select(ExternalLink).where(
            ExternalLink.provider == "eva", ExternalLink.object_type == "task",
            ExternalLink.local_id == task_id))

    def preview_row(db: Session, task: Task, user: User):
        link = get_link(db, task.id)
        outbox = list(db.scalars(select(SyncOutbox).where(
            SyncOutbox.entity_type == "task", SyncOutbox.entity_id == task.id,
            SyncOutbox.state == "pending")))
        # Candidate suggestions only: the per-user cache can be incomplete.
        candidates = list(db.scalars(select(EvaTaskCache).where(EvaTaskCache.user_id == user.id)))
        similar = []
        for cache in candidates:
            snap = cache.snapshot or {}
            if normalize(snap.get("name")) == normalize(task.title):
                similar.append({"code": snap.get("code"), "id": cache.remote_id,
                                "name": snap.get("name"), "cached_at": cache.fetched_at.isoformat()})
                if len(similar) >= 5:
                    break
        project = db.get(Project, task.project_id) if task.project_id else None
        return {
            "local_id": task.id,
            "title": task.title, "description": task.description,
            "status": task.status, "priority": task.priority,
            "project": project.name if project else None,
            "parent_id": task.parent_id,
            "assignee_id": task.assignee_id,
            "updated_at": task.updated_at.isoformat() if task.updated_at else None,
            "digest": local_digest(task),
            "pending_operations": len(outbox),
            "linked": bool(link),
            "remote_id": link.external_id if link else None,
            "remote_snapshot": link.snapshot if link else None,
            "candidates": similar,
            "action": "linked_needs_review" if link else "manual_match_required",
        }

    @router.get("/preview")
    def preview(offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100),
                db: Session = Depends(db_dep), user: User = Depends(user_dep)):
        stmt = accessible(db, user).order_by(Task.created_at, Task.id)
        rows = list(db.scalars(stmt.offset(offset).limit(limit + 1)))
        return {"items": [preview_row(db, row, user) for row in rows[:limit]],
                "offset": offset, "limit": limit, "has_more": len(rows) > limit,
                "remote_search_complete": False,
                "warning": "Кандидаты из кеша не являются полным поиском EvaTeam. Совпадение названия не подтверждает идентичность."}

    class InspectInput(BaseModel):
        remote_code: str = Field(min_length=1, max_length=100)
        expected_digest: str = Field(min_length=64, max_length=64)

    def remote_for_link(db: Session, user: User, local: Task, remote_code: str,
                        expected_digest: str) -> tuple[dict, str, list[str]]:
        if expected_digest != local_digest(local):
            raise HTTPException(409, "Локальная задача изменилась. Обнови предпросмотр.")
        if not CODE_PATTERN.fullmatch(remote_code):
            raise HTTPException(422, "Некорректный код задачи EvaTeam")
        key = retrieve_credential(db, user.id)
        if not key:
            raise HTTPException(409, "Подключи персональный токен EvaTeam")
        try:
            result = eva_call(key, "CmfTask.get", kwargs={
                "filter": ["code", "==", remote_code], "fields": ["*"]})
        except EvaError as exc:
            raise HTTPException(exc.status, "Не удалось проверить задачу EvaTeam") from exc
        if isinstance(result, list):
            if len(result) != 1:
                raise HTTPException(409, "EvaTeam вернула не одну задачу по этому коду")
            result = result[0]
        if not isinstance(result, dict):
            raise HTTPException(502, "EvaTeam вернула неверный формат задачи")
        if result.get("code") != remote_code or not result.get("id"):
            raise HTTPException(409, "EvaTeam не подтвердила код и ID задачи")
        remote_id = str(result["id"])
        if not remote_id.startswith("CmfTask:"):
            remote_id = "CmfTask:" + remote_id
        return result, remote_id, differences(local, result)

    @router.post("/{task_id}/inspect")
    def inspect_remote(task_id: str, payload: InspectInput, db: Session = Depends(db_dep),
                       user: User = Depends(user_dep)):
        local = require_access(db, user, task_id)
        remote, remote_id, diffs = remote_for_link(db, user, local, payload.remote_code, payload.expected_digest)
        return {
            "remote": {"id": remote_id, "code": remote["code"], "name": remote.get("name"),
                       "text": remote.get("text"), "status": remote_status(remote),
                       "priority": remote.get("priority")},
            "differences": diffs,
            "remote_digest": remote_digest(remote),
            "warning": "Подтверждение только связывает записи. Локальные изменения не переносятся, очередь не очищается."
        }

    class LinkInput(BaseModel):
        remote_code: str = Field(min_length=1, max_length=100)
        expected_digest: str = Field(min_length=64, max_length=64)
        confirm_differences: bool = False
        expected_remote_digest: str = Field(min_length=64, max_length=64)

    @router.post("/{task_id}/link")
    def link_existing(task_id: str, payload: LinkInput,
                      db: Session = Depends(db_dep), user: User = Depends(user_dep)):
        task = require_access(db, user, task_id)
        result, remote_id, diffs = remote_for_link(db, user, task, payload.remote_code, payload.expected_digest)
        if payload.expected_remote_digest != remote_digest(result):
            raise HTTPException(409, "Задача EvaTeam изменилась после проверки. Проверь её повторно.")
        if diffs and not payload.confirm_differences:
            raise HTTPException(409, {"reason": "conflicting_fields", "fields": diffs,
                                      "remote": {"id": remote_id, "code": result["code"], "name": result.get("name"),
                                                 "status": remote_status(result)}})
        existing = get_link(db, task.id)
        if existing:
            if existing.external_id != remote_id:
                raise HTTPException(409, "Задача уже сопоставлена с другим объектом EvaTeam")
            return {"linked": True, "remote_id": remote_id, "differences": diffs,
                    "pending_outbox_preserved": True, "idempotent": True}
        collision = db.scalar(select(ExternalLink).where(
            ExternalLink.provider == "eva", ExternalLink.object_type == "task",
            ExternalLink.external_id == remote_id))
        if collision:
            raise HTTPException(409, "Эта задача EvaTeam уже сопоставлена с другой локальной задачей")
        db.add(ExternalLink(provider="eva", object_type="task",
                            local_id=task.id, external_id=remote_id, snapshot={
                                "remote_code": result["code"], "remote_name": result.get("name"),
                                "remote_status": remote_status(result),
                                "differences_at_link": diffs,
                                "linked_at": datetime.now(timezone.utc).isoformat(),
                                "linked_by": user.id,
                            }))
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(409, "Конкурирующее сопоставление. Обнови предпросмотр.") from exc
        return {"linked": True, "remote_id": remote_id, "differences": diffs,
                "pending_outbox_preserved": True, "idempotent": False}
