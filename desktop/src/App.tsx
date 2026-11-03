import EvaTasks from "./EvaTasks";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Api, Comment, Project, Status, Task, User } from "./api";
import { isTauri } from "@tauri-apps/api/core";
import { Apple, ArrowRight, Check, ChevronDown, ChevronRight, Circle, Command, Inbox, ListTodo, LoaderCircle, LogOut, MessageSquare, Plus, RefreshCw, Search, Send, Settings2, UserRound, X } from "lucide-react";

const STATUS: Record<Status, string> = { new: "Новая", in_progress: "В работе", review: "На проверке", done: "Готово" };
const API_URL = import.meta.env.VITE_API_URL ||
  (window.location.protocol.startsWith("http") && window.location.port !== "1420"
    ? window.location.origin
    : "http://127.0.0.1:8000");

function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [restoringSession, setRestoringSession] = useState(true);
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
  const [showSettings, setShowSettings] = useState(false);
  const [evaToken, setEvaToken] = useState("");
  const [caFile, setCaFile] = useState<File | null>(null);
  const [pinFile, setPinFile] = useState<File | null>(null);
  const [pinStatus, setPinStatus] = useState<{installed: boolean; hostname?: string; sha256?: string; expires_at?: string; warning?: string} | null>(null);
  const [caStatus, setCaStatus] = useState<{installed: boolean; certificates: number | null; warning?: string} | null>(null);
  const [caMessage, setCaMessage] = useState("");
  const [evaConnected, setEvaConnected] = useState(false);
  const [evaConfigured, setEvaConfigured] = useState(false);
  const [evaEndpointConfigured, setEvaEndpointConfigured] = useState(false);
  const [evaTestResult, setEvaTestResult] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [serverVersion, setServerVersion] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [desktopUpdate, setDesktopUpdate] = useState<string | null>(null);
  const [updaterBusy, setUpdaterBusy] = useState(false);
  const refreshSettings = useCallback(async (client: Api) => {
    const [connection, version] = await Promise.all([client.evaConnection(), client.serverVersion()]);
    setEvaConnected(connection.connected);
    setEvaConfigured(connection.configured);
    setEvaEndpointConfigured(connection.endpoint_configured);
    setServerVersion(`${version.version} · ${version.commit}`);
    if (me?.is_admin) {
      const [ca, pin] = await Promise.all([client.caStatus(), client.pinStatus()]);
      setCaStatus(ca); setPinStatus(pin);
    }
  }, [me?.is_admin]);
  useEffect(() => {
    if (!api || !showSettings) return;
    void refreshSettings(api).catch(e => setSettingsError(String(e)));
  }, [api, showSettings, refreshSettings]);
  async function savePin(e: FormEvent) {
    e.preventDefault();
    if (!api || !pinFile || !me?.is_admin) return;
    setSettingsBusy(true); setSettingsError(""); setCaMessage("");
    try {
      if (pinFile.size > 16384) throw new Error("Размер сертификата должен быть меньше 16 КиБ");
      const pem = await pinFile.text();
      const info = await api.inspectPin(pem);
      const confirmed = window.confirm(
        "Закрепить сертификат только для " + info.hostname + "?\\n\\n" +
        "SHA-256: " + info.sha256 + "\\n" +
        "Действителен до: " + new Date(info.expires_at).toLocaleString("ru-RU") + "\\n\\n" +
        "Сверь SHA-256 с доверенным источником: загрузка сертификата сама по себе не подтверждает его подлинность."
      );
      if (!confirmed) return;
      const installed = await api.installPin(pem, info.sha256);
      setPinStatus(installed); setPinFile(null);
      setCaMessage("Сертификат сервера закреплён. Новые соединения проверяют отпечаток до отправки API-токена.");
    } catch (err) { setSettingsError(String(err)); }
    finally { setSettingsBusy(false); }
  }
  async function deletePin() {
    if (!api || !me?.is_admin) return;
    if (!window.confirm("Удалить закреплённый сертификат? Подключение вернётся к обычной проверке CA.")) return;
    setSettingsBusy(true); setSettingsError(""); setCaMessage("");
    try {
      await api.removePin();
      setPinStatus({installed: false});
      setCaMessage("Закрепление сертификата удалено.");
    } catch (err) { setSettingsError(String(err)); }
    finally { setSettingsBusy(false); }
  }
  async function saveCa(e: FormEvent) {
    e.preventDefault();
    if (!api || !caFile || !me?.is_admin) return;
    setSettingsBusy(true); setSettingsError(""); setCaMessage("");
    try {
      if (caFile.size > 65536) throw new Error("CA-файл слишком большой (максимум 64 КиБ)");
      const result = await api.installCa(await caFile.text());
      setCaStatus(result); setCaFile(null);
      setCaMessage("CA установлен. Новые подключения к EvaTeam используют его сразу, без перезапуска.");
    } catch (err) { setSettingsError(String(err)); }
    finally { setSettingsBusy(false); }
  }
  async function deleteCa() {
    if (!api || !me?.is_admin) return;
    if (!window.confirm("Удалить установленный корпоративный CA? Связь с EvaTeam может перестать работать.")) return;
    setSettingsBusy(true); setSettingsError(""); setCaMessage("");
    try {
      await api.removeCa();
      setCaStatus({installed: false, certificates: 0});
      setCaMessage("Дополнительный CA удалён.");
    } catch (err) { setSettingsError(String(err)); }
    finally { setSettingsBusy(false); }
  }
  async function saveEvaToken(e: FormEvent) {
    e.preventDefault(); if (!api || !evaToken.trim()) return;
    setSettingsBusy(true); setSettingsError("");
    try { await api.setEvaToken(evaToken.trim()); setEvaToken(""); await refreshSettings(api); }
    catch (e) { setSettingsError(String(e)); }
    finally { setSettingsBusy(false); }
  }
  async function testEva() {
    if (!api) return;
    setSettingsBusy(true); setSettingsError(""); setEvaTestResult("");
    try { await api.testEvaConnection(); setEvaTestResult("EvaTeam ответила на запрос списка задач."); }
    catch (e) { setSettingsError(String(e)); }
    finally { setSettingsBusy(false); }
  }
  async function disconnectEva() {
    if (!api) return;
    setSettingsBusy(true); setSettingsError("");
    try { await api.removeEvaToken(); await refreshSettings(api); }
    catch (e) { setSettingsError(String(e)); }
    finally { setSettingsBusy(false); }
  }
  async function checkDesktopUpdate() {
    setUpdaterBusy(true); setSettingsError(""); setDesktopUpdate(null);
    try {
      const { isTauri } = await import("@tauri-apps/api/core");
      if (!isTauri()) { setSettingsError("Обновление доступно только в собранном десктопном приложении."); return; }
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) { setDesktopUpdate(update.version); await update.close(); }
      else setDesktopUpdate("Нет обновлений");
    } catch (e) { setSettingsError("Updater не настроен: " + String(e)); }
    finally { setUpdaterBusy(false); }
  }


  const load = useCallback(async (client: Api) => {
    const [u, p, t] = await Promise.all([client.users(), client.projects(), client.tasks()]);
    setUsers(u); setProjects(p); setTasks(t);
  }, []);
  useEffect(() => {
    if (isTauri() || new URL(API_URL).origin !== window.location.origin) {
      setRestoringSession(false);
      return;
    }
    let cancelled = false;
    const client = new Api(API_URL);
    void client.me().then(async user => {
      const [u, p, t] = await Promise.all([client.users(), client.projects(), client.tasks()]);
      if (!cancelled) {
        setUsers(u); setProjects(p); setTasks(t); setMe(user); setApi(client);
      }
    }).catch(() => { /* No valid session; show login form. */ })
      .finally(() => { if (!cancelled) setRestoringSession(false); });
    return () => { cancelled = true; };
  }, []);

  async function logout() {
    if (api && !isTauri() && new URL(api.baseUrl).origin === window.location.origin) {
      try { await api.closeSession(); } catch { /* Clear local state even if offline. */ }
    }
    setApi(null); setMe(null); setSelected(null); setShowSettings(false);
  }

  async function login(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const bearerClient = new Api(server, token);
      const user = await bearerClient.me();
      const sameOriginWeb = !isTauri() && new URL(server).origin === window.location.origin;
      if (sameOriginWeb) await bearerClient.openSession();
      const client = sameOriginWeb ? new Api(server) : bearerClient;
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
  if (restoringSession) return <div className="login-wrap"><p className="muted">Восстанавливаем вход…</p></div>;
  if (!api) return <div className="login-wrap"><form className="login card" onSubmit={login}>
    <div className="brand brand-large"><span className="brand-icon"><Apple size={27}/></span><span>Eva<span className="brand-accent">DE</span></span></div>
    <p className="muted">Eva Desktop Edition. Из Рая выгнали. Зато задачи открываются.</p>
    <label>Адрес Task Core<input type="url" required value={server} onChange={e => setServer(e.target.value)} placeholder="http://localhost:8000"/></label>
    <label>Персональный токен<input required type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Вставь свой токен"/></label>
    <button className="primary" disabled={busy}>{busy ? "Подключаемся…" : "Войти"} <ArrowRight size={16}/></button>
    {error && <p className="error">{error}</p>}
    <small className="muted">В веб-версии вход сохраняется на 30 дней в защищённой от JavaScript cookie. Для работы по сети используй HTTPS.</small>
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
        <button className={view === "eva" ? "nav-active" : ""} onClick={() => setView("eva")}><ListTodo size={17}/> EvaTeam · Задачи</button>
        <button className={view === "mine" ? "nav-active" : ""} onClick={() => setView("mine")}><UserRound size={17}/> Мои задачи</button>
        <button className={view === "all" ? "nav-active" : ""} onClick={() => setView("all")}><ListTodo size={17}/> Все задачи <span className="nav-count">{tasks.length}</span></button>
        <button className={view === "inbox" ? "nav-active" : ""} onClick={() => setView("inbox")}><Inbox size={17}/> Без исполнителя</button>
      </nav>
      <div className="nav-label">ПРОЕКТЫ</div>
      <nav>{projects.map(p => <button key={p.id} className={view === "project:" + p.id ? "nav-active" : ""} onClick={() => setView("project:" + p.id)}><span className="project-dot"/> {p.name}</button>)}</nav>
      <div className="sidebar-bottom"><button onClick={() => setShowSettings(true)}><Settings2 size={16}/> Настройки / EvaTeam</button>
        <button onClick={() => void refresh()}><RefreshCw size={16} className={syncing ? "spin" : ""}/> {syncing ? "Обновление…" : "Обновить"}</button>
        <div className="profile"><span className="avatar">{me?.name.slice(0, 1).toUpperCase()}</span><span className="profile-name">{me?.name}</span><button title="Выйти" onClick={() => void logout()}><LogOut size={16}/></button></div>
      </div>
    </aside>
    {view === "eva" && api ? <main className="workspace"><EvaTasks api={api}/></main> : <main className="workspace">
      <header className="topbar"><div><div className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</div><h1>{view === "mine" ? "Мои задачи" : view === "all" ? "Все задачи" : view === "inbox" ? "Без исполнителя" : projects.find(p => "project:" + p.id === view)?.name || "Задачи"}</h1></div><div className="sync-state"><span className="sync-dot"/> Локальная база · {tasks.length} задач</div></header>
      <div className="toolbar"><div className="search-box"><Search size={17}/><input id="task-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Найти задачу…"/><kbd>Ctrl K</kbd></div><span className="result-count">{visible.length} найдено</span></div>
      {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")}><X size={16}/></button></div>}
      <form className="add-task" onSubmit={createTask}><Plus size={18}/><input id="new-task" placeholder="Новая задача…  Ctrl N" value={draft} onChange={e => setDraft(e.target.value)}/><button disabled={!draft.trim()} type="submit">Создать</button></form>
      <div className="list-head"><span>ЗАДАЧА</span><span>СТАТУС</span><span>ИСПОЛНИТЕЛЬ</span></div>
      <section className="task-list">{roots.length ? roots.map(t => <div key={t.id}>{taskRow(t)}{visible.filter(c => c.parent_id === t.id).map(c => taskRow(c, 1))}</div>) : <div className="empty"><ListTodo size={38}/><h3>Здесь пока тихо</h3><p>Создай первую задачу или выбери другой раздел.</p></div>}</section>
    </main>}
    {showSettings && <div className="settings-backdrop" onClick={() => setShowSettings(false)}><section className="settings-panel card" onClick={e => e.stopPropagation()}>
      <div className="section-title"><h2>Настройки EvaDE</h2><button onClick={() => setShowSettings(false)} aria-label="Закрыть"><X size={18}/></button></div>
      <div className="detail-section"><p className="muted">Учётная запись: {me?.name} · Роль: {me?.is_admin ? "Администратор" : "Пользователь"}</p></div>
      <div className="detail-section"><h3>Персональный доступ к EvaTeam</h3>
        <p className="muted">{evaConnected ? "Ключ привязан к вашей учётке. Сам ключ не показывается." : "Ключ EvaTeam ещё не привязан."}</p>
        <p className="muted">{evaConfigured ? "Хранилище ключей доступно." : "Администратор сервера пока не настроил хранилище ключей."}</p>
        <form className="settings-form" onSubmit={saveEvaToken}>
          <label>API-ключ EvaTeam<input type="password" autoComplete="off" value={evaToken} onChange={e => setEvaToken(e.target.value)} placeholder="Вставьте свой ключ" required minLength={8}/></label>
          <button className="primary" disabled={settingsBusy || !evaConfigured || !evaToken.trim()} type="submit">{evaConnected ? "Заменить ключ" : "Сохранить ключ"}</button>
        </form>
        {evaConnected && <div className="settings-actions"><button className="secondary-action" disabled={settingsBusy || !evaEndpointConfigured} onClick={() => void testEva()}>Проверить подключение</button><button className="secondary-action" disabled={settingsBusy} onClick={() => void disconnectEva()}>Удалить привязку</button></div>}
        {evaTestResult && <p className="muted">{evaTestResult}</p>}
        {!evaEndpointConfigured && <p className="muted">Администратор ещё не указал EVADE_EVA_URL.</p>}
        <p className="muted">Ключ хранится на сервере зашифрованным. Проверка выполняет безопасный запрос CmfTask.list. Это не проверка всех прав пользователя.</p>
      </div>
      {me?.is_admin && <div className="detail-section"><h3>Администратор · CA EvaTeam</h3>
        <p className="muted">Дополнительные доверенные CA применяются только при соединении EvaDE с EvaTeam. Проверка TLS остаётся включённой.</p>
        <p className="muted">{caStatus?.installed ? `Установлен CA (сертификатов: ${caStatus.certificates ?? "неизвестно"}).` : "Дополнительный CA не установлен."} {caStatus?.warning || ""}</p>
        <form className="settings-form" onSubmit={saveCa}>
          <label>Сертификат CA (.crt / .pem, PEM-формат)
            <input type="file" accept=".crt,.pem,application/x-pem-file" onChange={e => setCaFile(e.target.files?.[0] || null)} />
          </label>
          <button className="primary" type="submit" disabled={settingsBusy || !caFile}>{settingsBusy ? "Установка…" : "Установить CA"}</button>
        </form>
        {caStatus?.installed && <button className="secondary-action" disabled={settingsBusy} onClick={() => void deleteCa()}>Удалить CA</button>}
        {caMessage && <p className="muted">{caMessage}</p>}
        <p className="muted">Загружай публичный корневой или промежуточный CA, не серверный сертификат и не приватный ключ. Только администратор может менять доверенные сертификаты.</p>
      </div>}
      {me?.is_admin && <div className="detail-section"><h3>Администратор · Сертификат сервера EvaTeam</h3>
        <p className="muted">Если сертификат EvaTeam экспортирован из браузера, закрепи именно его. Проверяем SHA-256 в ходе TLS-соединения до передачи персонального API-токена.</p>
        <p className="muted">{pinStatus?.installed ? "Закреплён: " + pinStatus.hostname : "Сертификат сервера не закреплён."} {pinStatus?.warning || ""}</p>
        {pinStatus?.sha256 && <p className="muted" style={{overflowWrap:"anywhere"}}>SHA-256: {pinStatus.sha256}</p>}
        {pinStatus?.expires_at && <p className="muted">Действует до: {new Date(pinStatus.expires_at).toLocaleDateString("ru-RU")}</p>}
        <form className="settings-form" onSubmit={savePin}>
          <label>Сертификат сайта (.pem / .crt)
            <input type="file" accept=".pem,.crt" onChange={e => setPinFile(e.target.files?.[0] || null)} />
          </label>
          <button className="primary" disabled={settingsBusy || !pinFile} type="submit">Проверить и закрепить</button>
        </form>
        {pinStatus?.installed && <button className="secondary-action" disabled={settingsBusy} onClick={() => void deletePin()}>Удалить закрепление</button>}
        <p className="muted">Убедись, что отпечаток соответствует сертификату настоящей EvaTeam. При перевыпуске сертификата потребуется повторная установка.</p>
      </div>}
      <div className="detail-section"><h3>Обновления</h3>
        <p className="muted">Task Core: {serverVersion || "неизвестно"} · Desktop: 0.1.0</p>
        <button className="secondary-action" disabled={updaterBusy} onClick={() => void checkDesktopUpdate()}>{updaterBusy ? "Проверяю…" : "Проверить обновления клиента"}</button>
        {desktopUpdate && <p className="muted">Результат: {desktopUpdate}. Установка появится после настройки подписанных релизов.</p>}
        <p className="muted">Обновление сервера выполняет администратор, без перезапуска из пользовательского интерфейса.</p>
      </div>
      {settingsError && <p className="error">{settingsError}</p>}
    </section></div>}
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
