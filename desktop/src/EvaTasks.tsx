import { FormEvent, useCallback, useEffect, useState } from "react";
import { Api } from "./api";
import { ChevronLeft, ChevronRight, RefreshCw, Plus, MessageSquare, Save, X } from "lucide-react";

type Row = Record<string, unknown>;
type Page = { items: Row[]; offset: number; limit: number; has_more: boolean };
const val = (x: unknown): string => {
  if (x == null) return "";
  if (typeof x === "object") {
    const r = x as Row;
    return String(r.name ?? r.code ?? r.login ?? r.id ?? "");
  }
  return String(x);
};
const taskCode = (t: Row) => val(t.code);
const priority = (t: Row) => typeof t.priority === "number" ? t.priority : 0;
const status = (t: Row) => val(t.status);
const projectId = (p: Row) => val(p.id);
const projectCode = (p: Row) => val(p.code);
const richText = (x: unknown) => val(x).replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, "");

export default function EvaTasks({ api }: { api: Api }) {
  const [page, setPage] = useState<Page>({items: [], offset: 0, limit: 50, has_more: false});
  const [projects, setProjects] = useState<Row[]>([]);
  const [people, setPeople] = useState<Row[]>([]);
  const [project, setProject] = useState("");
  const [search, setSearch] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [task, setTask] = useState<Row | null>(null);
  const [editName, setEditName] = useState("");
  const [editText, setEditText] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [editPriority, setEditPriority] = useState(0);
  const [editResponsible, setEditResponsible] = useState("");
  const [newTask, setNewTask] = useState(false);
  const [newName, setNewName] = useState("");
  const [newText, setNewText] = useState("");
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadList = useCallback(async (offset = 0) => {
    setLoading(true); setError("");
    try { setPage(await api.evaTasks(offset, 50, project, search)); }
    catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [api, project, search]);

  const loadTask = useCallback(async (code: string) => {
    if (!code) return;
    try {
      const t = await api.evaTask(code);
      setTask(t);
      setEditName(val(t.name)); setEditText(val(t.text)); setEditStatus(status(t));
      setEditPriority(priority(t)); setEditResponsible(val(t.responsible));
    } catch (e) { setError(String(e)); }
  }, [api]);

  useEffect(() => {
    let active = true;
    Promise.all([api.evaProjects(), api.evaPeople()]).then(([p, u]) => {
      if (active) { setProjects(p.items); setPeople(u.items); }
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [api]);
  useEffect(() => { void loadList(0); }, [loadList]);
  useEffect(() => {
    setTask(null);
    if (selected) void loadTask(selected);
  }, [selected, loadTask]);

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!selected || !task || !editName.trim()) return;
    setSaving(true); setError(""); setMessage("");
    try {
      const changes: Record<string, unknown> = {};
      if (editName.trim() !== val(task.name)) changes.name = editName.trim();
      if (editText !== val(task.text)) changes.text = editText;
      if (editStatus.trim() && editStatus.trim() !== status(task)) changes.status = editStatus.trim();
      if (editPriority !== priority(task)) changes.priority = editPriority;
      if (editResponsible.trim() && editResponsible.trim() !== val(task.responsible)) changes.responsible = editResponsible.trim();
      if (!Object.keys(changes).length) { setMessage("Нет изменений"); return; }
      await api.updateEvaTask(selected, changes);
      setMessage("Изменения сохранены в EvaTeam.");
      await Promise.all([loadTask(selected), loadList(page.offset)]);
    } catch (err) { setError(String(err)); }
    finally { setSaving(false); }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    const p = projects.find(x => projectId(x) === project);
    if (!p || !newName.trim()) return;
    setSaving(true); setError(""); setMessage("");
    try {
      await api.createEvaTask({name: newName.trim(), text: newText, project: projectCode(p)});
      setNewName(""); setNewText(""); setNewTask(false); setMessage("Задача создана в EvaTeam.");
      await loadList(0);
    } catch (err) { setError(String(err)); }
    finally { setSaving(false); }
  }
  async function sendComment(e: FormEvent) {
    e.preventDefault();
    if (!selected || !comment.trim()) return;
    setSaving(true); setError(""); setMessage("");
    try {
      await api.commentEvaTask(selected, comment.trim()); setComment("");
      setMessage("Комментарий добавлен.");
      await loadTask(selected);
    } catch (err) { setError(String(err)); }
    finally { setSaving(false); }
  }

  const comments = Array.isArray(task?.comments) ? task.comments as Row[] : [];
  return <div className="eva-workspace">
    <header className="eva-head">
      <div><small>ПЕРСОНАЛЬНОЕ ПОДКЛЮЧЕНИЕ · EVATEAM</small><h1>Задачи EvaTeam</h1></div>
      <button className="secondary-action" onClick={() => void loadList(page.offset)} disabled={loading}><RefreshCw size={15}/> Обновить</button>
    </header>
    <div className="eva-controls">
      <select value={project} onChange={e => {setProject(e.target.value);setSelected("");}}>
        <option value="">Все доступные проекты</option>
        {projects.map(p => <option key={projectId(p) || projectCode(p)} value={projectId(p)}>{val(p.name) || projectCode(p)}</option>)}
      </select>
      <form onSubmit={e => {e.preventDefault();setSearch(draftSearch);}}><input placeholder="Поиск в загруженной странице…" value={draftSearch} onChange={e => setDraftSearch(e.target.value)}/><button type="submit">Найти</button></form>
      <button onClick={() => setNewTask(v => !v)}><Plus size={16}/> Новая задача</button>
    </div>
    {error && <div className="eva-alert" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
    {message && <p className="eva-message">{message}</p>}
    {newTask && <form className="eva-create" onSubmit={create}>
      <div className="eva-form-title"><h3>Создать задачу</h3><button type="button" onClick={() => setNewTask(false)}><X size={16}/></button></div>
      <p className="muted">Выбери проект в фильтре выше. Создание идёт непосредственно в EvaTeam.</p>
      <input required placeholder="Название задачи" value={newName} onChange={e => setNewName(e.target.value)}/>
      <textarea placeholder="Описание (текст)" rows={3} value={newText} onChange={e => setNewText(e.target.value)}/>
      <button type="submit" disabled={saving || !project || !newName.trim()}>Создать в EvaTeam</button>
    </form>}
    <div className="eva-layout">
      <section className="eva-list">
        <div className="eva-list-heading"><strong>Задачи</strong><span>{loading ? "Загрузка…" : `Показано: ${page.items.length}`}</span></div>
        {page.items.map((t, i) => <button key={taskCode(t) || i} className={"eva-task-row " + (selected === taskCode(t) ? "active" : "")} onClick={() => setSelected(taskCode(t))}>
          <span className="eva-code">{taskCode(t)}</span><strong>{val(t.name) || "(без названия)"}</strong>
          <span className="eva-row-meta">{val(t.status)} · {val(t.responsible) || "Без исполнителя"}</span>
        </button>)}
        {!loading && !page.items.length && <p className="muted eva-empty">Нет задач в этой выборке.</p>}
        <div className="eva-pager"><button disabled={page.offset === 0 || loading} onClick={() => void loadList(Math.max(0, page.offset - 50))}><ChevronLeft size={15}/> Назад</button><span>{page.offset + 1}–{page.offset + page.items.length}</span><button disabled={!page.has_more || loading} onClick={() => void loadList(page.offset + 50)}>Далее <ChevronRight size={15}/></button></div>
      </section>
      <section className="eva-editor">
        {!task ? <p className="muted eva-empty">Выбери задачу для просмотра и редактирования.</p> : <>
          <div className="eva-editor-heading"><h3>{selected}</h3><button onClick={() => setSelected("")}><X size={16}/></button></div>
          <form onSubmit={saveEdit} className="eva-edit-form">
            <label>Название<input value={editName} onChange={e => setEditName(e.target.value)}/></label>
            <label>Описание<textarea rows={5} value={editText} onChange={e => setEditText(e.target.value)}/></label>
            <div className="eva-edit-grid">
              <label>Код статуса EvaTeam<input value={editStatus} placeholder="Статус проекта" onChange={e => setEditStatus(e.target.value)}/></label>
              <label>Приоритет (0–5)<input type="number" min={0} max={5} value={editPriority} onChange={e => setEditPriority(Number(e.target.value))}/></label>
            </div>
            <label>Исполнитель (логин / email)<input value={editResponsible} list="eva-people" onChange={e => setEditResponsible(e.target.value)}/></label>
            <datalist id="eva-people">{people.map((p,i) => <option key={i} value={val(p.login) || val(p.email)}>{val(p.name)}</option>)}</datalist>
            <button className="eva-primary" disabled={saving || !editName.trim()}><Save size={16}/> Сохранить в EvaTeam</button>
          </form>
          <div className="eva-comments"><h3><MessageSquare size={15}/> Комментарии ({comments.length})</h3>
            {comments.map((c,i) => <div className="eva-comment" key={i}><small>{val(c.cmf_author) || val(c.author) || "Автор"}</small><p>{richText(c.text)}</p></div>)}
            <form onSubmit={sendComment}><textarea rows={3} placeholder="Новый комментарий…" value={comment} onChange={e => setComment(e.target.value)}/><button disabled={saving || !comment.trim()}>Отправить</button></form>
          </div>
        </>}
      </section>
    </div>
  </div>;
}
