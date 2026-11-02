import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Api, Comment, Project, Status, Task, User } from "./api";
import { Apple, ArrowRight, Check, ChevronDown, ChevronRight, Circle, Command, Inbox, ListTodo, LoaderCircle, LogOut, MessageSquare, Plus, RefreshCw, Search, Send, Settings2, UserRound, X } from "lucide-react";

const STATUS: Record<Status, string> = { new: "Новая", in_progress: "В работе", review: "На проверке", done: "Готово" };
const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [server, setServer] = useState(API_URL);
  const [token, setToken] = useState("");
  const [me, setMe] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState("mine");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [draft, setDraft] = useState("");
  const [comment, setComment] = useState("");
  const [comments, setComments] = useState<Comment[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [showActivity, setShowActivity] = useState(false);

  const load = useCallback(async (client: Api) => {
    const [u, p, t] = await Promise.all([client.users(), client.projects(), client.tasks()]);
    setUsers(u); setProjects(p); setTasks(t);
  }, []);
  async function login(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const client = new Api(server, token);
      const user = await client.me();
      await load(client);
      setMe(user); setApi(client); setToken("");
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  }
  const refresh = useCallback(async () => {
    if (!api) return;
    setSyncing(true);
    try { await load(api); setError(""); }
    catch (err) { setError(String(err)); }
    finally { setSyncing(false); }
  }, [api, load]);
  useEffect(() => {
    if (!api) return;
    const id = window.setInterval(() => void refresh(), 20000);
    return () => window.clearInterval(id);
  }, [api, refresh]);
  useEffect(() => {
    if (!api || !selected) { setComments([]); setActivity([]); return; }
    let cancelled = false;
    Promise.all([api.comments(selected), api.activity(selected)]).then(([c, a]) => {
      if (!cancelled) { setComments(c); setActivity(a); }
    }).catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [api, selected]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); document.querySelector<HTMLInputElement>("#task-search")?.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault(); document.querySelector<HTMLInputElement>("#new-task")?.focus();
      }
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const task = tasks.find(t => t.id === selected);
  const visible = useMemo(() => tasks.filter(t => {
    const matchView = view === "all" || view === "mine" && t.assignee_id === me?.id || view === "inbox" && !t.assignee_id || view.startsWith("project:") && t.project_id === view.slice(8);
    return matchView && (t.title + " " + t.description).toLowerCase().includes(search.toLowerCase());
  }), [tasks, view, search, me]);
  const roots = visible.filter(t => !t.parent_id || !visible.some(p => p.id === t.parent_id));
  const person = (id: string | null) => users.find(u => u.id === id)?.name || "Не назначен";
  async function createTask(e: FormEvent) {
    e.preventDefault(); if (!api || !draft.trim()) return;
    try {
      const created = await api.createTask({ title: draft.trim(), project_id: view.startsWith("project:") ? view.slice(8) : null });
      setDraft(""); setTasks(p => [created, ...p]); setSelected(created.id); setError("");
    } catch (err) { setError(String(err)); }
  }
  async function update(id: string, patch: Partial<Task>) {
    if (!api) return;
    const before = tasks;
    setTasks(p => p.map(t => t.id === id ? { ...t, ...patch } : t));
    try { const updated = await api.updateTask(id, patch); setTasks(p => p.map(t => t.id === id ? updated : t)); }
    catch (err) { setTasks(before); setError(String(err)); }
  }
  async function addChild() {
    if (!api || !task) return;
    const title = window.prompt("Название подзадачи");
    if (!title?.trim()) return;
    try {
      const created = await api.createTask({ title: title.trim(), parent_id: task.id, project_id: task.project_id });
      setTasks(p => [...p, created]);
    } catch (err) { setError(String(err)); }
  }
  async function sendComment(e: FormEvent) {
    e.preventDefault(); if (!api || !task || !comment.trim()) return;
    try {
      const created = await api.addComment(task.id, comment.trim());
      setComments(p => [...p, created]); setComment("");
      setActivity(await api.activity(task.id)); setError("");
    } catch (err) { setError(String(err)); }
  }
  if (!api) return <div className="login-wrap"><form className="login card" onSubmit={login}>
    <div className="brand brand-large"><span className="brand-icon"><Apple size={27}/></span><span>Eva<span className="brand-accent">DE</span></span></div>
    <p className="muted">Eva Desktop Edition. Из Рая выгнали. Зато задачи открываются.</p>
    <label>Адрес Task Core<input type="url" required value={server} onChange={e => setServer(e.target.value)} placeholder="http://localhost:8000"/></label>
    <label>Персональный токен<input required type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Вставь свой токен"/></label>
    <button className="primary" disabled={busy}>{busy ? "Подключаемся…" : "Войти"} <ArrowRight size={16}/></button>
    {error && <p className="error">{error}</p>}
    <small className="muted">Токен хранится только в памяти приложения до выхода.</small>
  </form></div>;
  const taskRow = (t: Task, depth = 0) => <div key={t.id} className={"task-row " + (selected === t.id ? "selected" : "")} style={{ paddingLeft: 14 + depth * 22 }} onClick={() => setSelected(t.id)}>
    <button className={"round-check " + (t.status === "done" ? "complete" : "")} title="Переключить выполнение" onClick={e => { e.stopPropagation(); void update(t.id, { status: t.status === "done" ? "new" : "done" }); }}>{t.status === "done" ? <Check size={14}/> : <Circle size={18}/>}</button>
    <span className="task-name">{t.title}</span>
    <span className={"status-pill " + t.status}>{STATUS[t.status]}</span>
    <span className="assignee">{person(t.assignee_id)}</span>
    <ChevronRight size={15} className="muted task-chevron"/>
  </div>;
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-icon"><Apple size={20}/></span><span>Eva<span className="brand-accent">DE</span></span></div>
      <nav>
        <button className={view === "mine" ? "nav-active" : ""} onClick={() => setView("mine")}><UserRound size={17}/> Мои задачи</button>
        <button className={view === "all" ? "nav-active" : ""} onClick={() => setView("all")}><ListTodo size={17}/> Все задачи <span className="nav-count">{tasks.length}</span></button>
        <button className={view === "inbox" ? "nav-active" : ""} onClick={() => setView("inbox")}><Inbox size={17}/> Без исполнителя</button>
      </nav>
      <div className="nav-label">ПРОЕКТЫ</div>
      <nav>{projects.map(p => <button key={p.id} className={view === "project:" + p.id ? "nav-active" : ""} onClick={() => setView("project:" + p.id)}><span className="project-dot"/> {p.name}</button>)}</nav>
      <div className="sidebar-bottom">
        <button onClick={() => void refresh()}><RefreshCw size={16} className={syncing ? "spin" : ""}/> {syncing ? "Обновление…" : "Обновить"}</button>
        <div className="profile"><span className="avatar">{me?.name.slice(0, 1).toUpperCase()}</span><span className="profile-name">{me?.name}</span><button title="Выйти" onClick={() => { setApi(null); setMe(null); setSelected(null); }}><LogOut size={16}/></button></div>
      </div>
    </aside>
    <main className="workspace">
      <header className="topbar"><div><div className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</div><h1>{view === "mine" ? "Мои задачи" : view === "all" ? "Все задачи" : view === "inbox" ? "Без исполнителя" : projects.find(p => "project:" + p.id === view)?.name || "Задачи"}</h1></div><div className="sync-state"><span className="sync-dot"/> Локальная база · {tasks.length} задач</div></header>
      <div className="toolbar"><div className="search-box"><Search size={17}/><input id="task-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Найти задачу…"/><kbd>Ctrl K</kbd></div><span className="result-count">{visible.length} найдено</span></div>
      {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")}><X size={16}/></button></div>}
      <form className="add-task" onSubmit={createTask}><Plus size={18}/><input id="new-task" placeholder="Новая задача…  Ctrl N" value={draft} onChange={e => setDraft(e.target.value)}/><button disabled={!draft.trim()} type="submit">Создать</button></form>
      <div className="list-head"><span>ЗАДАЧА</span><span>СТАТУС</span><span>ИСПОЛНИТЕЛЬ</span></div>
      <section className="task-list">{roots.length ? roots.map(t => <div key={t.id}>{taskRow(t)}{visible.filter(c => c.parent_id === t.id).map(c => taskRow(c, 1))}</div>) : <div className="empty"><ListTodo size={38}/><h3>Здесь пока тихо</h3><p>Создай первую задачу или выбери другой раздел.</p></div>}</section>
    </main>
    {task && <aside className="details">
      <div className="details-head"><div className="muted"><Settings2 size={15}/> ДЕТАЛИ ЗАДАЧИ</div><button className="icon-btn" onClick={() => setSelected(null)}><X size={18}/></button></div>
      <div className="details-scroll">
        <textarea className="task-title-edit" aria-label="Название" key={task.id + "-title"} defaultValue={task.title} rows={2} onBlur={e => { if (e.target.value.trim() && e.target.value !== task.title) void update(task.id, { title: e.target.value.trim() }); }}/>
        <div className="field-row"><span>Статус</span><select value={task.status} onChange={e => void update(task.id, { status: e.target.value as Status })}>{Object.entries(STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div className="field-row"><span>Исполнитель</span><select value={task.assignee_id || ""} onChange={e => void update(task.id, { assignee_id: e.target.value || null })}><option value="">Не назначен</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
        <div className="field-row"><span>Приоритет</span><select value={task.priority} onChange={e => void update(task.id, { priority: Number(e.target.value) })}><option value={0}>Обычный</option><option value={1}>Низкий</option><option value={2}>Высокий</option><option value={3}>Критичный</option></select></div>
        <div className="detail-section"><h3>Описание</h3><textarea className="description" key={task.id + "-description"} defaultValue={task.description} placeholder="Что нужно сделать?" rows={4} onBlur={e => { if (e.target.value !== task.description) void update(task.id, { description: e.target.value }); }}/></div>
        <div className="detail-section"><div className="section-title"><h3>Подзадачи <span className="muted">{tasks.filter(t => t.parent_id === task.id).length}</span></h3><button onClick={() => void addChild()}><Plus size={16}/> Добавить</button></div>
          {tasks.filter(t => t.parent_id === task.id).map(child => <button className="child" key={child.id} onClick={() => setSelected(child.id)}><span className={child.status === "done" ? "child-done" : ""}>{child.title}</span><ChevronRight size={15}/></button>)}
        </div>
        <div className="detail-section discussion"><div className="section-title"><h3>Обсуждение</h3><button onClick={() => setShowActivity(v => !v)}><MessageSquare size={15}/>{showActivity ? "Комментарии" : "Активность"}</button></div>
          {showActivity ? <div>{activity.map(a => <div className="activity-line" key={a.id}><span className="avatar small">{person(a.actor_id).slice(0, 1)}</span><div><strong>{person(a.actor_id)}</strong><p>{a.kind === "task.created" ? "Создал задачу" : a.kind === "comment.created" ? "Добавил комментарий" : "Изменил задачу"}</p><small>{new Date(a.created_at).toLocaleString("ru-RU")}</small></div></div>)}</div> :
          <div>{comments.length ? comments.map(c => <div className="comment" key={c.id}><span className="avatar small">{person(c.author_id).slice(0, 1)}</span><div><strong>{person(c.author_id)}</strong><small>{new Date(c.created_at).toLocaleString("ru-RU")}</small><p>{c.body}</p></div></div>) : <p className="muted">Пока без комментариев.</p>}</div>}
        </div>
      </div>
      <form className="comment-form" onSubmit={sendComment}><input value={comment} onChange={e => setComment(e.target.value)} placeholder="Написать комментарий…"/><button type="submit" disabled={!comment.trim()} title="Отправить"><Send size={18}/></button></form>
    </aside>}
  </div>;
}
export default App;
