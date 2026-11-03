import { FormEvent, UIEvent, useCallback, useEffect, useRef, useState } from "react";
import { Api } from "./api";
import { groupEvaTasks } from "./evaStatus";
import { buildProjectTree, ProjectTreeNode, SectionGroup, TaskTreeNode } from "./evaProjects";
import { ChevronRight, RefreshCw, Plus, MessageSquare, Save, X, Users, UserRound, Star, Cloud, CloudOff, Clock } from "lucide-react";

type Row = Record<string, unknown>;
type Page = { items: Row[]; offset: number; limit: number; has_more: boolean };
const STATUS_CODES = ["TO DO", "IN PROGRESS", "PAUSE", "IN REVIEW", "DONE", "CANCEL"] as const;
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

  const [collapsedStatuses, setCollapsedStatuses] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("evade:eva-collapsed:" + userId) || "{}"); }
    catch { return {}; }
  });
  const [syncBusy, setSyncBusy] = useState(false);
  const syncBusyRef = useRef(false);
  const [syncState, setSyncState] = useState<{cached:number;legacy_tasks:number;legacy_outbox_pending:number;mode:string}|null>(null);
  const [lastSync, setLastSync] = useState<Date|null>(null);
  const [offlineCache, setOfflineCache] = useState(false);
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
  const [groupBy, setGroupBy] = useState<"project"|"status">(() => {
    try { return localStorage.getItem("evade:task-group:" + userId) === "status" ? "status" : "project"; }
    catch { return "project"; }
  });
  const [search, setSearch] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [task, setTask] = useState<Row | null>(null);
  const [editName, setEditName] = useState("");
  const [editText, setEditText] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [editPriority, setEditPriority] = useState(0);
  const [editResponsible, setEditResponsible] = useState("");
  const [responsibleName, setResponsibleName] = useState("");
  const [responsibleSearch, setResponsibleSearch] = useState("");
  const [responsibleMatches, setResponsibleMatches] = useState<Row[]>([]);
  const [responsibleSearching, setResponsibleSearching] = useState(false);
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
    try {
      if (activePerson) {
        // The EvaTeam project_id field is the root project. Nested sections
        // are distinguished by parent_id, so filter the resolved tree locally.
        const remote = await api.evaTasks(activePerson, offset, 50, "", search);
        setPage(prev => {
          if (offset === 0) return {...remote, offset: 0};
          const existing = new Set(prev.items.map(item => val(item.id) || taskCode(item)));
          const added = remote.items.filter(item => !existing.has(val(item.id) || taskCode(item)));
          return {...remote, offset: 0, items: [...prev.items, ...added]};
        });
        setOfflineCache(false);
        setLastSync(new Date());
      }
    } catch (e) {
      try {
        const cached = await api.evaCachedTasks(activePerson, offset, 50);
        // Offline cache isn't filtered by project/search: never pretend it is.
        setPage(prev => offset === 0 ? {...cached, offset: 0} : {
          ...cached, offset: 0, items: [...prev.items, ...cached.items.filter(item =>
            !prev.items.some(old => val(old.id) === val(item.id)))],
        }); setOfflineCache(true);
        setError("EvaTeam недоступна. Показан последний сохранённый снимок задач (без фильтра проекта и поиска). Редактирование временно отключено. " + String(e));
      } catch { setError(String(e)); }
    }
    finally { setLoading(false); }
  }, [api, activePerson, project, search]);

  const runSync = useCallback(async (quiet = false) => {
    if (!activePerson || syncBusyRef.current) return;
    syncBusyRef.current = true;
    setSyncBusy(true);
    if (!quiet) setMessage("");
    try {
      // A scoped pull from EvaTeam into per-user cache. Writes always
      // go directly to EvaTeam; the cache is never a competing authority.
      const people = quiet ? [activePerson] : [...new Set([self?.id, ...followed].filter((v): v is string => Boolean(v)))];
      const result = await api.evaSync(people.length ? people : [activePerson]);
      const status = await api.evaSyncStatus();
      setSyncState(status);
      setLastSync(new Date());
      if (result.partial.length) setError("Синхронизация ограничена 2000 задачами на сотрудника. Требуется дополнительная пагинация.");
      if (!quiet) setMessage("Обновлено записей EvaTeam: " + result.synced);
    } catch (e) {
      if (!quiet) setError("Синхронизация не удалась: " + String(e));
    } finally { syncBusyRef.current = false; setSyncBusy(false); }
  }, [api, activePerson, self?.id, followed]);

  useEffect(() => {
    if (!activePerson) return;
    void api.evaSyncStatus().then(setSyncState).catch(() => {});
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadList(0);
    }, 60000);
    return () => window.clearInterval(id);
  }, [api, activePerson, loadList]);

  useEffect(() => {
    if (!activePerson) return;
    void runSync(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void runSync(true);
    }, 180000);
    return () => window.clearInterval(timer);
  }, [activePerson, runSync]);

  const loadTask = useCallback(async (code: string) => {
    if (!code) return;
    try {
      const t = await api.evaTask(code);
      setTask(t);
      setEditName(val(t.name)); setEditText(val(t.text)); setEditStatus(status(t));
      setEditPriority(priority(t));
      const person = t.responsible && typeof t.responsible === "object" ? t.responsible as Row : null;
      setEditResponsible(val(person?.id) || val(t.responsible_id));
      setResponsibleName(val(person?.name) || val(t.responsible) || "Не назначен");
      setResponsibleSearch("");
      setResponsibleMatches([]);
    } catch (e) { setError(String(e)); }
  }, [api]);

  useEffect(() => {
    if (!selected || responsibleSearch.trim().length < 2) {
      setResponsibleMatches([]);
      setResponsibleSearching(false);
      return;
    }
    let active = true;
    const timer = window.setTimeout(async () => {
      setResponsibleSearching(true);
      try {
        const results = await api.evaPeople(0, responsibleSearch.trim());
        if (active) setResponsibleMatches(results.items);
      } catch (err) {
        if (active) setError("Поиск исполнителя: " + String(err));
      } finally {
        if (active) setResponsibleSearching(false);
      }
    }, 350);
    return () => { active = false; window.clearTimeout(timer); };
  }, [api, selected, responsibleSearch]);

  useEffect(() => {
    let active = true;
    void api.evaSelf().then(identity => {
      if (active && identity.id) {
        setSelf({id: identity.id, name: identity.name || identity.id});
        setActivePerson(identity.id);
        try { localStorage.setItem("evade:eva-self:" + userId, JSON.stringify(identity)); } catch { /* ignore */ }
      }
    }).catch(e => { if (active) setError("Не удалось связаться с EvaTeam: " + String(e)); });
    void (async () => {
      const collected: Row[] = [];
      let hasMore = true;
      while (hasMore && collected.length < 2000) {
        const batch = await api.evaProjects(collected.length);
        collected.push(...batch.items);
        hasMore = batch.has_more && batch.items.length > 0;
      }
      if (active) {
        setProjects(collected);
        if (hasMore) setError("Показаны первые 2000 проектов. Часть структуры может отсутствовать.");
      }
    })().catch(e => { if (active) setError("Не удалось загрузить структуру проектов: " + String(e)); });

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
    setPeople([]);
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
  function onPeopleScroll(e: UIEvent<HTMLDivElement>) {
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
    if (!selected || !task || !editName.trim() || offlineCache) return;
    setSaving(true); setError(""); setMessage("");
    try {
      const changes: Record<string, unknown> = {};
      if (editName.trim() !== val(task.name)) changes.name = editName.trim();
      if (editText !== val(task.text)) changes.text = editText;
      if (editStatus.trim() && editStatus.trim() !== status(task)) changes.status = editStatus.trim();
      if (editPriority !== priority(task)) changes.priority = editPriority;
      const original = task.responsible && typeof task.responsible === "object"
        ? val((task.responsible as Row).id) : val(task.responsible_id);
      if (editResponsible && editResponsible !== original) changes.responsible = editResponsible;
      if (!Object.keys(changes).length) { setMessage("Нет изменений"); return; }
      await api.updateEvaTask(selected, changes);
      setMessage("Изменения сохранены в EvaTeam.");
      await Promise.all([loadTask(selected), loadList(0)]);
    } catch (err) { setError(String(err)); }
    finally { setSaving(false); }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (offlineCache) return;
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
    if (!selected || !comment.trim() || offlineCache) return;
    setSaving(true); setError(""); setMessage("");
    try {
      await api.commentEvaTask(selected, comment.trim()); setComment("");
      setMessage("Комментарий добавлен.");
      await loadTask(selected);
    } catch (err) { setError(String(err)); }
    finally { setSaving(false); }
  }

  const groupedTasks = groupEvaTasks(page.items);
  const projectTree = buildProjectTree(page.items, projects);
  const filteredProjectTree = (() => {
    if (!project) return projectTree;
    const find = (nodes: ProjectTreeNode[]): ProjectTreeNode | undefined => {
      for (const node of nodes) {
        if (node.id === project) return node;
        const child = find(node.children);
        if (child) return child;
      }
      return undefined;
    };
    const found = find(projectTree);
    return found ? [found] : [];
  })();
  function setGrouping(mode: "project"|"status") {
    setGroupBy(mode);
    try { localStorage.setItem("evade:task-group:" + userId, mode); } catch { /* ignored */ }
  }
  function toggleStatus(key: string, defaultCollapsed = false) {
    setCollapsedStatuses(current => {
      const updated = {...current, [key]: !(current[key] ?? defaultCollapsed)};
      try { localStorage.setItem("evade:eva-collapsed:" + userId, JSON.stringify(updated)); }
      catch { /* Storage may be disabled. */ }
      return updated;
    });
  }
  const statusSummary = groupedTasks.map(g => ({label:g.label,count:g.rows.length,key:g.key}));
  function taskEntry(t: Row, index: number) {
    return <button key={taskCode(t) || index}
      className={"eva-task-row " + (selected === taskCode(t) ? "active" : "")}
      onClick={() => setSelected(taskCode(t))}>
      <span className="eva-code">{taskCode(t)}</span>
      <strong>{val(t.name) || "(без названия)"}</strong>
      <span className="eva-row-meta">
        <span>Приоритет: {val(t.priority) || "0"}</span>
        {Boolean(t.cmf_modified_at) && <span><Clock size={12}/> {new Date(String(t.cmf_modified_at)).toLocaleDateString("ru-RU")}</span>}
      </span>
    </button>;
  }
  function statusSection(group: ReturnType<typeof groupEvaTasks>[number], prefix: string) {
    const key = "status:" + prefix + ":" + group.key;
    return <section key={key} className="eva-status-group">
      <button type="button" className="eva-status-heading eva-subheading"
        aria-expanded={!collapsedStatuses[key]} onClick={() => toggleStatus(key)}>
        <span className="eva-status-arrow">{collapsedStatuses[key] ? "▸" : "▾"}</span>
        <span>{group.label}</span><span className="eva-status-count">{group.rows.length}</span>
      </button>
      {!collapsedStatuses[key] && group.rows.map(taskEntry)}
    </section>;
  }
  function taskBranch(node: TaskTreeNode, depth = 0) {
    const key = "task:" + node.key;
    const collapsed = collapsedStatuses[key] ?? false;
    const code = taskCode(node.task);
    return <div className="eva-task-branch" key={key}>
      <div className={"eva-task-node " + (selected === code ? "active" : "")}
        style={{paddingLeft: 12 + depth * 19}}>
        {node.children.length > 0
          ? <button className="eva-task-toggle" type="button"
              aria-label={(collapsed ? "Развернуть " : "Свернуть ") + val(node.task.name)}
              aria-expanded={!collapsed} onClick={() => toggleStatus(key)}>
              {collapsed ? "▸" : "▾"}
            </button>
          : <span className="eva-task-leaf" aria-hidden="true">·</span>}
        <button type="button" className="eva-task-open" onClick={() => setSelected(code)}>
          <span className="eva-code">{code}</span>
          <strong>{val(node.task.name) || "(без названия)"}</strong>
          <span className="eva-row-meta">{val(node.task.status)} · Приоритет {val(node.task.priority) || "0"}</span>
        </button>
        {node.children.length > 0 && <span className="eva-status-count">{node.count - 1}</span>}
      </div>
      {!collapsed && node.children.map(child => taskBranch(child, depth + 1))}
    </div>;
  }
  function listSection(section: SectionGroup, projectId: string) {
    const key = "section:" + projectId + ":" + section.key;
    return <section key={key} className="eva-project-section">
      <button type="button" className="eva-project-section-heading" aria-expanded={!collapsedStatuses[key]}
        onClick={() => toggleStatus(key)}>
        <span className="eva-status-arrow">{collapsedStatuses[key] ? "▸" : "▾"}</span>
        <span>{section.label}</span><span className="eva-status-count">{section.count}</span>
      </button>
      {!collapsedStatuses[key] && section.roots.map(node => taskBranch(node))}
    </section>;
  }
  function projectSection(node: ProjectTreeNode, level = 0) {
    const key = "project:" + node.id;
    const collapsed = collapsedStatuses[key] ?? (node.count === 0);
    return <section className="eva-project-group" key={key}>
      <button type="button" className="eva-project-heading" style={{paddingLeft: 16 + level * 13}}
        aria-expanded={!collapsed} title={node.path} onClick={() => toggleStatus(key, node.count === 0)}>
        <span className="eva-status-arrow">{collapsed ? "▸" : "▾"}</span>
        <span className="eva-project-title">{node.name}</span>
        <span className="eva-status-count">{node.count}</span>
      </button>
      {!collapsed && <>
        {node.sections.map(section => listSection(section, node.id))}
        {node.children.map(child => projectSection(child, level + 1))}
      </>}
    </section>;
  }
  const comments = Array.isArray(task?.comments) ? task.comments as Row[] : [];
  return <div className="eva-workspace">
    <header className="eva-head">
      <div><small>ЗАДАЧИ · ЕДИНОЕ РАБОЧЕЕ ПРОСТРАНСТВО</small><h1>{activePerson === self?.id ? "Мои задачи" : "Команда / " + nameFor(activePerson)}</h1>
        <div className="eva-sync-caption">{offlineCache ? <><CloudOff size={13}/> Сохранённая копия · только просмотр</> :
          <><Cloud size={13}/> Данные EvaTeam · {lastSync ? "проверены " + lastSync.toLocaleTimeString("ru-RU", {hour:"2-digit",minute:"2-digit"}) : "подключение"}</>}</div>
      </div>
      <div className="eva-head-actions">
        <button className="secondary-action" onClick={() => void runSync()} disabled={syncBusy || !activePerson}><RefreshCw size={15} className={syncBusy ? "spin" : ""}/> Синхронизировать</button>
        <button className="secondary-action" onClick={() => void loadList(0)} disabled={loading || !activePerson}><RefreshCw size={15}/> Обновить</button>
      </div>
    </header>
    {!self && <section className="eva-person-picker">
      <h3>Выбери себя в EvaTeam</h3>
      <p className="muted">Ваша EvaTeam не отдаёт владельца API-токена. Найди свою учётную запись в справочнике. Выбор запомнится в этом браузере.</p>
      <input aria-label="Найти себя в EvaTeam" placeholder="Имя или логин…" value={peopleSearch}
        onChange={e => setPeopleSearch(e.target.value)} />
      <div className="eva-person-options" onScroll={onPeopleScroll}>
        {people.map((p, i) => <button type="button" key={val(p.id) || i}
            onClick={() => chooseSelf(p)}>{val(p.name) || val(p.login) || val(p.id)} · {val(p.login)}</button>)}
      </div>
      {peopleLoading && <p className="muted">Ищу сотрудников…</p>}
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
      <div className="eva-person-options" onScroll={onPeopleScroll}>
        {availablePeople.map((p, i) => {
          const id = val(p.id);
          return <label key={id || i}><input type="checkbox" checked={followed.includes(id)}
            disabled={!id} onChange={() => toggleFollow(id)}/>
            <span>{val(p.name) || val(p.login) || id}<small>{val(p.login)}</small></span>
          </label>;
        })}
        {!availablePeople.length && <p className="muted">Сотрудники не найдены в загруженном справочнике.</p>}
      </div>
      {peopleLoading && <p className="muted">Ищу сотрудников…</p>}
      <p className="muted">Закреплённые сотрудники доступны отдельными вкладками. Список сохраняется в этом браузере.</p>
    </section>}
    <div className="eva-controls">
      <select value={project} onChange={e => {setProject(e.target.value);setSelected("");}}>
        <option value="">Все доступные проекты</option>
        {projects.map(p => <option key={projectId(p) || projectCode(p)} value={projectId(p)}>{val(p.name) || projectCode(p)}</option>)}
      </select>
      <form onSubmit={e => {e.preventDefault();setSearch(draftSearch);}}><input placeholder="Поиск в загруженной странице…" value={draftSearch} onChange={e => setDraftSearch(e.target.value)}/><button type="submit">Найти</button></form>
      <button disabled={offlineCache} onClick={() => setNewTask(v => !v)}><Plus size={16}/> Новая задача</button>
    </div>
    {error && <div className="eva-alert" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
    {message && <p className="eva-message">{message}</p>}
    {newTask && <form className="eva-create" onSubmit={create}>
      <div className="eva-form-title"><h3>Создать задачу</h3><button type="button" onClick={() => setNewTask(false)}><X size={16}/></button></div>
      <p className="muted">Выбери проект в фильтре выше. Новая задача сразу появится в общем трекере.</p>
      <input required placeholder="Название задачи" value={newName} onChange={e => setNewName(e.target.value)}/>
      <textarea placeholder="Описание (текст)" rows={3} value={newText} onChange={e => setNewText(e.target.value)}/>
      <button type="submit" disabled={saving || offlineCache || !project || !newName.trim()}>Создать в EvaTeam</button>
    </form>}
    {page.items.length > 0 && <div className="eva-summary-strip">
      {statusSummary.map(item => <div key={item.key} className="eva-summary-stat">
        <span>{item.label}</span><strong>{item.count}</strong>
      </div>)}
    </div>}
    <div className="eva-layout">
      <section className="eva-list">
        <div className="eva-list-heading">
          <strong>{activePerson === self?.id ? "Мои задачи" : nameFor(activePerson)}</strong>
          <span>{loading ? "Загрузка…" : `Задач: ${page.items.length}`}</span>
        </div>
        <div className="eva-group-switch" role="group" aria-label="Группировка задач">
          <button type="button" className={groupBy === "project" ? "active" : ""}
            onClick={() => setGrouping("project")}>Проекты и разделы</button>
          <button type="button" className={groupBy === "status" ? "active" : ""}
            onClick={() => setGrouping("status")}>Статусы</button>
        </div>
        {groupBy === "project"
          ? filteredProjectTree.map(node => projectSection(node))
          : groupedTasks.map(group => statusSection(group, "root"))}
        {!loading && activePerson && !page.items.length && <p className="muted eva-empty">Нет задач в этой выборке.</p>}
        <div className="eva-pager"><span>Загружено задач: {page.items.length}</span>{page.has_more && <button disabled={loading} onClick={() => void loadList(page.items.length)}>{loading ? "Загрузка…" : "Загрузить ещё"} <ChevronRight size={15}/></button>}</div>
      </section>
      <section className="eva-editor">
        {!task ? <p className="muted eva-empty">Выбери задачу для просмотра и редактирования.</p> : <>
          <div className="eva-editor-heading"><h3>{selected}</h3><button onClick={() => setSelected("")}><X size={16}/></button></div>
          <form onSubmit={saveEdit} className="eva-edit-form">
            <label>Название<input value={editName} onChange={e => setEditName(e.target.value)}/></label>
            <label>Описание<textarea rows={5} value={editText} onChange={e => setEditText(e.target.value)}/></label>
            <div className="eva-edit-grid">
              <label>Статус
                <select value={editStatus} onChange={e => setEditStatus(e.target.value)}>
                  {editStatus && !STATUS_CODES.includes(editStatus as typeof STATUS_CODES[number]) && <option value={editStatus}>{editStatus}</option>}
                  {STATUS_CODES.map(code => <option key={code} value={code}>{code}</option>)}
                </select>
              </label>
              <label>Приоритет
                <select value={editPriority} onChange={e => setEditPriority(Number(e.target.value))}>
                  {[0,1,2,3,4,5].map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
            </div>
            <div className="eva-assignee-field">
              <label>Ответственный
                <span className="eva-assignee-current">{responsibleName}</span>
                <input value={responsibleSearch} onChange={e => setResponsibleSearch(e.target.value)}
                  placeholder="Найти по имени или логину…" aria-label="Найти ответственного"/>
              </label>
              {responsibleSearching && <small className="muted">Ищу сотрудников…</small>}
              {responsibleMatches.length > 0 && <div className="eva-assignee-results">
                {responsibleMatches.map((person, i) => <button type="button" key={val(person.id) || i}
                  onClick={() => {
                    const id = val(person.id);
                    if (!id) return;
                    setEditResponsible(id);
                    setResponsibleName(val(person.name) || val(person.login) || id);
                    setResponsibleMatches([]); setResponsibleSearch("");
                  }}>{val(person.name) || val(person.login)} <small>{val(person.login)}</small></button>)}
              </div>}
            </div>
            <button className="eva-primary" disabled={saving || offlineCache || !editName.trim()}><Save size={16}/> Сохранить изменения</button>
          </form>
          <div className="eva-comments"><h3><MessageSquare size={15}/> Комментарии ({comments.length})</h3>
            {comments.map((c,i) => <div className="eva-comment" key={i}><small>{val(c.cmf_author) || val(c.author) || "Автор"}</small><p>{richText(c.text)}</p></div>)}
            <form onSubmit={sendComment}><textarea rows={3} placeholder="Новый комментарий…" value={comment} onChange={e => setComment(e.target.value)}/><button disabled={saving || offlineCache || !comment.trim()}>Отправить</button></form>
          </div>
        </>}
      </section>
    </div>
  </div>;
}
