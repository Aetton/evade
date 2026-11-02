import hashlib
import os
from contextlib import asynccontextmanager
from typing import Literal
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session
from .database import Base, SessionLocal, engine
from .models import Activity, Comment, EvaCredential, Project, SyncOutbox, Task, User
from .credentials import store as store_eva_credential, retrieve as retrieve_eva_credential
from .eva_client import EvaError, probe as probe_eva

STATUSES = ("new", "in_progress", "review", "done")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initial development schema. Replace with Alembic migrations before production.
    Base.metadata.create_all(bind=engine)
    yield

app = FastAPI(title="EvaDE Task Core", version="0.1.0", lifespan=lifespan)
allowed_origins = os.environ.get("EVADE_CORS_ORIGINS", "http://localhost:1420").split(",")
app.add_middleware(CORSMiddleware, allow_origins=allowed_origins, allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"], allow_headers=["Authorization", "Content-Type"])

def db_session():
    with SessionLocal() as db:
        yield db

def current_user(authorization: str | None = Header(default=None), db: Session = Depends(db_session)) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Bearer token required")
    token = authorization[7:].strip()
    if not token:
        raise HTTPException(401, "Bearer token required")
    digest = hashlib.sha256(token.encode()).hexdigest()
    user = db.scalar(select(User).where(User.token_hash == digest))
    if user is None:
        raise HTTPException(401, "Invalid token")
    return user

class EvaTokenIn(BaseModel):
    token: str = Field(min_length=8, max_length=16384)

@app.get("/integrations/eva")
def eva_connection(db: Session = Depends(db_session), user: User = Depends(current_user)):
    row = db.get(EvaCredential, user.id)
    return {"connected": row is not None, "configured": bool(os.getenv("EVADE_CREDENTIAL_KEY")), "endpoint_configured": bool(os.getenv("EVADE_EVA_URL")), "updated_at": row.updated_at if row else None}

@app.put("/integrations/eva")
def set_eva_connection(payload: EvaTokenIn, db: Session = Depends(db_session), user: User = Depends(current_user)):
    # Deliberately does not try to validate against undocumented Eva auth.
    store_eva_credential(db, user.id, payload.token)
    db.commit()
    return {"connected": True}

@app.post("/integrations/eva/test")
def test_eva_connection(db: Session = Depends(db_session), user: User = Depends(current_user)):
    token = retrieve_eva_credential(db, user.id)
    if token is None:
        raise HTTPException(409, "EvaTeam token is not connected")
    try:
        probe_eva(token)
    except EvaError as exc:
        # RPC errors contain remote text; do not echo possible secrets from it.
        raise HTTPException(exc.status, "EvaTeam rejected the request or is unavailable") from exc
    return {"ok": True, "method": "CmfTask.list"}

@app.delete("/integrations/eva", status_code=204)
def delete_eva_connection(db: Session = Depends(db_session), user: User = Depends(current_user)):
    row = db.get(EvaCredential, user.id)
    if row:
        db.delete(row)
        db.commit()

@app.get("/version")
def version():
    return {"name": "EvaDE Task Core", "version": app.version, "commit": os.getenv("EVADE_BUILD_SHA", "dev")}

class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=180)

class TaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    description: str = ""
    status: Literal["new", "in_progress", "review", "done"] = "new"
    project_id: str | None = None
    parent_id: str | None = None
    priority: int = Field(default=0, ge=0, le=3)
    assignee_id: str | None = None

class TaskPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None
    status: Literal["new", "in_progress", "review", "done"] | None = None
    project_id: str | None = None
    parent_id: str | None = None
    priority: int | None = Field(default=None, ge=0, le=3)
    assignee_id: str | None = None

class CommentIn(BaseModel):
    body: str = Field(min_length=1)

def as_user(user: User):
    return {"id": user.id, "name": user.name, "is_admin": user.is_admin}

def as_task(t: Task):
    return {key: getattr(t, key) for key in ("id", "title", "description", "status", "project_id", "parent_id", "priority", "assignee_id", "created_by", "created_at", "updated_at")}

def as_comment(c: Comment):
    return {"id": c.id, "task_id": c.task_id, "author_id": c.author_id, "body": c.body, "created_at": c.created_at}

def task_or_404(db: Session, task_id: str) -> Task:
    task = db.get(Task, task_id)
    if task is None:
        raise HTTPException(404, "Task not found")
    return task

def validate_links(db: Session, project_id=None, parent_id=None, assignee_id=None, task_id=None):
    if project_id and not db.get(Project, project_id):
        raise HTTPException(422, "Unknown project")
    if assignee_id and not db.get(User, assignee_id):
        raise HTTPException(422, "Unknown assignee")
    if parent_id:
        parent = task_or_404(db, parent_id)
        if parent_id == task_id:
            raise HTTPException(422, "Task cannot parent itself")
        # Walk the ancestor chain to prevent cycles.
        seen = {task_id}
        while parent:
            if parent.id in seen:
                raise HTTPException(422, "Circular task hierarchy")
            seen.add(parent.id)
            parent = db.get(Task, parent.parent_id) if parent.parent_id else None

def log_change(db, task_id, actor_id, kind, detail, operation):
    db.add(Activity(task_id=task_id, actor_id=actor_id, kind=kind, detail=detail))
    db.add(SyncOutbox(entity_type="task" if kind != "comment.created" else "comment", entity_id=task_id, actor_id=actor_id, operation=operation, payload=detail))

@app.get("/health")
def health():
    return {"ok": True}

@app.get("/me")
def me(user: User = Depends(current_user)):
    return as_user(user)

@app.get("/users")
def users(db: Session = Depends(db_session), _: User = Depends(current_user)):
    return [as_user(u) for u in db.scalars(select(User).order_by(User.name))]

@app.get("/projects")
def projects(db: Session = Depends(db_session), _: User = Depends(current_user)):
    return [{"id": p.id, "name": p.name} for p in db.scalars(select(Project).order_by(Project.name))]

@app.post("/projects", status_code=201)
def create_project(payload: ProjectIn, db: Session = Depends(db_session), user: User = Depends(current_user)):
    p = Project(name=payload.name)
    db.add(p)
    db.commit()
    db.refresh(p)
    return {"id": p.id, "name": p.name}

@app.get("/tasks")
def tasks(
    project_id: str | None = None,
    assignee_id: str | None = None,
    status: str | None = None,
    q: str = "",
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
):
    stmt = select(Task)
    if project_id:
        stmt = stmt.where(Task.project_id == project_id)
    if assignee_id:
        stmt = stmt.where(Task.assignee_id == assignee_id)
    if status:
        stmt = stmt.where(Task.status == status)
    if q:
        stmt = stmt.where(Task.title.ilike(f"%{q}%"))
    return [as_task(t) for t in db.scalars(stmt.order_by(Task.updated_at.desc()).limit(limit).offset(offset))]

@app.get("/tasks/{task_id}")
def get_task(task_id: str, db: Session = Depends(db_session), _: User = Depends(current_user)):
    return as_task(task_or_404(db, task_id))

@app.post("/tasks", status_code=201)
def create_task(payload: TaskIn, db: Session = Depends(db_session), user: User = Depends(current_user)):
    validate_links(db, payload.project_id, payload.parent_id, payload.assignee_id)
    task = Task(**payload.model_dump(), created_by=user.id)
    db.add(task)
    db.flush()
    log_change(db, task.id, user.id, "task.created", payload.model_dump(), "create")
    db.commit()
    db.refresh(task)
    return as_task(task)

@app.patch("/tasks/{task_id}")
def update_task(task_id: str, payload: TaskPatch, db: Session = Depends(db_session), user: User = Depends(current_user)):
    task = task_or_404(db, task_id)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        return as_task(task)
    merged = {field: changes.get(field, getattr(task, field)) for field in ("project_id", "parent_id", "assignee_id")}
    validate_links(db, **merged, task_id=task.id)
    before = {key: getattr(task, key) for key in changes}
    for key, value in changes.items():
        setattr(task, key, value)
    log_change(db, task.id, user.id, "task.updated", {"before": before, "after": changes}, "update")
    db.commit()
    db.refresh(task)
    return as_task(task)

@app.get("/tasks/{task_id}/comments")
def comments(task_id: str, db: Session = Depends(db_session), _: User = Depends(current_user)):
    task_or_404(db, task_id)
    return [as_comment(c) for c in db.scalars(select(Comment).where(Comment.task_id == task_id).order_by(Comment.created_at))]

@app.post("/tasks/{task_id}/comments", status_code=201)
def add_comment(task_id: str, payload: CommentIn, db: Session = Depends(db_session), user: User = Depends(current_user)):
    task_or_404(db, task_id)
    c = Comment(task_id=task_id, author_id=user.id, body=payload.body)
    db.add(c)
    db.flush()
    log_change(db, task_id, user.id, "comment.created", {"comment_id": c.id, "body": c.body, "author_id": user.id}, "create")
    db.commit()
    db.refresh(c)
    return as_comment(c)

@app.get("/tasks/{task_id}/activity")
def activity(task_id: str, db: Session = Depends(db_session), _: User = Depends(current_user)):
    task_or_404(db, task_id)
    return [{"id": a.id, "actor_id": a.actor_id, "kind": a.kind, "detail": a.detail, "created_at": a.created_at} for a in db.scalars(select(Activity).where(Activity.task_id == task_id).order_by(Activity.created_at))]
