import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Api } from "./api";
import { ChevronLeft, ChevronRight, RefreshCw, Plus, MessageSquare, Save, X, Users, UserRound, Star } from "lucide-react";

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

export default function EvaTasks({ api, userId }: { api: Api; userId: string }) {
  const [self, setSelf] = useState<{id:string;name:string}|null>(() => {
    try { return JSON.parse(localStorage.getItem("evade:eva-self:" + userId) || "null"); }
    catch { return null; }
  });
  const [activePerson, setActivePerson] = useState("");
  const [followed, setFollowed] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("evade:eva-team:" + userId) || "[]");
      return Array.isArray(saved) ? saved.filter((v: unknown) => typeof v === "string") : [];
    } catch { return []; }
  });
  const [managePeople, setManagePeople] = useState(false);
  const [peopleSearch, setPeopleSearch] = useState("");

  const [page, setPage] = useState<Page>({items: [], offset: 0, limit: 50, has_more: false});
  const [projects, setProjects] = useState<Row[]>([]);
  const [people, setPeople] = useState<Row[]>([]);
  const [peopleHasMore, setPeopleHasMore] = useState(false);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [debouncedPeopleSearch, setDebouncedPeopleSearch] = useState("");
  const peopleRequest = useRef(0);
  const peopleOffset = useRef(0);
  const peopleLoadingRef = useRef(false);
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
    try { if (activePerson) setPage(await api.evaTasks(activePerson, offset, 50, project, search)); }
    catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [api, activePerson, project, search]);

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
    void api.evaSelf().then(identity => {
      if (active && identity.id) {
        setSelf({id: identity.id, name: identity.name || identity.id});
        setActivePerson(identity.id);
        try { localStorage.setItem("evade:eva-self:" + userId, JSON.stringify(identity)); } catch { /* ignore */ }
      }
    }).catch(e => { if (active) setError("Не удалось связаться с EvaTeam: " + String(e)); });
    void api.evaProjects().then(p => { if (active) setProjects(p.items); })
      .catch(e => { if (active) setError(String(e)); });

    return () => { active = false; };
  }, [api]);
  useEffect(() => {
    if (self && !activePerson) setActivePerson(self.id);
  }, [self, activePerson]);
  function chooseSelf(p: Row) {
    const id = val(p.id);
    if (!/^(Person|CmfPerson):[a-zA-Z0-9_-]+$/.test(id)) return;
    const identity = {id, name: val(p.name) || val(p.login) || id};
    setSelf(identity); setActivePerson(id); setManagePeople(false); setError("");
    try { localStorage.setItem("evade:eva-self:" + userId, JSON.stringify(identity)); } catch { /* ignore */ }
  }
  useEffect(() => {
    if (activePerson) { setSelected(""); void loadList(0); }
  }, [activePerson, loadList]);
  useEffect(() => {
    try { localStorage.setItem("evade:eva-team:" + userId, JSON.stringify(followed)); }
    catch { /* Storage may be disabled. */ }
  }, [userId, followed]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedPeopleSearch(peopleSearch.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [peopleSearch]);
  useEffect(() => {
    const request = ++peopleRequest.current;
    peopleOffset.current = 0;
    peopleLoadingRef.current = true;
    setPeopleLoading(true);
    setPeopleHasMore(false);
    void api.evaPeople(0, debouncedPeopleSearch).then(result => {
      if (request !== peopleRequest.current) return;
      setPeople(result.items);
      peopleOffset.current = result.items.length;
      setPeopleHasMore(result.has_more);
    }).catch(e => {
      if (request === peopleRequest.current) setError("Не удалось найти сотрудников: " + String(e));
    }).finally(() => {
      if (request === peopleRequest.current) {
        peopleLoadingRef.current = false;
        setPeopleLoading(false);
      }
    });
    return () => { peopleRequest.current++; };
  }, [api, debouncedPeopleSearch]);
  async function loadMorePeople() {
    if (!peopleHasMore || peopleLoadingRef.current) return;
    const request = peopleRequest.current;
    peopleLoadingRef.current = true;
    setPeopleLoading(true);
    try {
      const result = await api.evaPeople(peopleOffset.current, debouncedPeopleSearch);
      if (request !== peopleRequest.current) return;
      peopleOffset.current += result.items.length;
      setPeople(current => [...current, ...result.items.filter(p => !current.some(c => val(c.id) === val(p.id)))]);
      setPeopleHasMore(result.has_more);
    } catch (e) { if (request === peopleRequest.current) setError(String(e)); }
    finally {
      if (request === peopleRequest.current) {
        peopleLoadingRef.current = false;
        setPeopleLoading(false);
      }
    }
  }
  function onPeopleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) void loadMorePeople();
  }
  function toggleFollow(id: string) {
    if (id === self?.id) return;
    setFollowed(current => current.includes(id) ? current.filter(v => v !== id) : [...current, id]);
    if (activePerson === id && followed.includes(id)) setActivePerson(self?.id || "");
  }
  const nameFor = (id: string) => val(people.find(p => val(p.id) === id)?.name) || id;
  const availablePeople = people.filter(p => val(p.id) !== self?.id);

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

  const statusGroups = new Map<string, Row[]>();
  for (const item of page.items) {
    const group = status(item).trim() || "Без статуса";
    const rows = statusGroups.get(group) || [];
    rows.push(item);
    statusGroups.set(group, rows);
  }
  const groupedTasks = [...statusGroups.entries()].sort(([a], [b]) => a.localeCompare(b, "ru"));
  const comments = Array.isArray(task?.comments) ? task.comments as Row[] : [];
  return <div className="eva-workspace">
    <header className="eva-head">
      <div><small>ПЕРСОНАЛЬНОЕ ПОДКЛЮЧЕНИЕ · EVATEAM</small><h1>{activePerson === self?.id ? "Мои задачи" : "Задачи · " + nameFor(activePerson)}</h1></div>
      <button className="secondary-action" onClick={() => void loadList(page.offset)} disabled={loading || !activePerson}><RefreshCw size={15}/> Обновить</button>
    </header>
    {!self && <section className="eva-person-picker">
      <h3>Выбери себя в EvaTeam</h3>
      <p className="muted">Ваша EvaTeam не отдаёт владельца API-токена. Найди свою учётную запись в справочнике. Выбор запомнится в этом браузере.</p>
      <input aria-label="Найти себя в EvaTeam" placeholder="Имя или логин…" value={peopleSearch}
        onChange={e => setPeopleSearch(e.target.value)} />
      <div className="eva-person-options">
        {people.filter(p => (val(p.name) + " " + val(p.login)).toLowerCase().includes(peopleSearch.toLowerCase()))
          .map((p, i) => <button type="button" key={val(p.id) || i}
            onClick={() => chooseSelf(p)}>{val(p.name) || val(p.login) || val(p.id)} · {val(p.login)}</button>)}
      </div>
      {peopleHasMore && <button type="button" disabled={peopleLoading}
        onClick={() => void loadMorePeople()}>{peopleLoading ? "Загружаю…" : "Загрузить ещё сотрудников"}</button>}
    </section>}
    <div className="eva-person-tabs">
      <button type="button" className={activePerson === self?.id ? "active" : ""} disabled={!self}
        onClick={() => setActivePerson(self?.id || "")}><UserRound size={15}/> Мои задачи</button>
      {followed.map(id => <button type="button" key={id} className={activePerson === id ? "active" : ""}
        onClick={() => setActivePerson(id)}><Users size={15}/>{nameFor(id)}</button>)}
      <button type="button" className="eva-manage-people" onClick={() => setManagePeople(v => !v)}>
        <Star size={15}/> {managePeople ? "Закрыть выбор" : "Сотрудники"}
      </button>
    </div>
    {self && <button type="button" className="secondary-action" onClick={() => {
      setSelf(null); setActivePerson(""); setPage({items: [], offset: 0, limit: 50, has_more: false});
      setManagePeople(false);
      try { localStorage.removeItem("evade:eva-self:" + userId); } catch { /* ignore */ }
    }}>Сменить мою учётку EvaTeam</button>}
    {self && managePeople && <section className="eva-person-picker">
      <input aria-label="Поиск сотрудников" placeholder="Найти сотрудника по имени или логину…"
        value={peopleSearch} onChange={e => setPeopleSearch(e.target.value)}/>
      <div className="eva-person-options">
        {availablePeople.map((p, i) => {
          const id = val(p.id);
          return <label key={id || i}><input type="checkbox" checked={followed.includes(id)}
            disabled={!id} onChange={() => toggleFollow(id)}/>
            <span>{val(p.name) || val(p.login) || id}<small>{val(p.login)}</small></span>
          </label>;
        })}
        {!availablePeople.length && <p className="muted">Сотрудники не найдены в загруженном справочнике.</p>}
      </div>
      {peopleHasMore && <button type="button" disabled={peopleLoading} onClick={() => void loadMorePeople()}>
        {peopleLoading ? "Загружаю…" : "Загрузить ещё сотрудников"}
      </button>}
      <p className="muted">Закреплённые сотрудники доступны отдельными вкладками. Список сохраняется в этом браузере.</p>
    </section>}
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
        <div className="eva-list-heading"><strong>{activePerson === self?.id ? "Мои задачи" : nameFor(activePerson)}</strong><span>{loading ? "Загрузка…" : `Показано: ${page.items.length}`}</span></div>
        {page.items.map((t, i) => <button key={taskCode(t) || i} className={"eva-task-row " + (selected === taskCode(t) ? "active" : "")} onClick={() => setSelected(taskCode(t))}>
          <span className="eva-code">{taskCode(t)}</span><strong>{val(t.name) || "(без названия)"}</strong>
          <span className="eva-row-meta">{val(t.status)} · {val(t.responsible) || "Без исполнителя"}</span>
        </button>)}
        {!loading && activePerson && !page.items.length && <p className="muted eva-empty">Нет задач в этой выборке.</p>}
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
