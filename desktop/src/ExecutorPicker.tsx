import { useEffect, useState } from "react";
import type { Api } from "./api";

export type Executor = {id:string; label:string};
export function executorList(value: unknown): Executor[] {
  if (!Array.isArray(value)) return [];
  const people = new Map<string, Executor>();
  for (const row of value) {
    const id = typeof row === "string" ? row : row?.id;
    if (typeof id === "string" && id) people.set(id, {id,label:row?.login || row?.name || id});
  }
  return [...people.values()];
}
export function ExecutorPicker({api, primary, people, onChange}: {
  api:Api; primary:string; people:Executor[]; onChange:(value:Executor[])=>void
}) {
  const [query,setQuery] = useState("");
  const [matches,setMatches] = useState<Executor[]>([]);
  const [error,setError] = useState("");
  useEffect(()=>{
    let active=true;
    setMatches([]); setError("");
    const timer=setTimeout(async()=>{
      if(query.trim().length<2)return;
      try {
        const page=await api.evaPeople(0,query.trim());
        if(active)setMatches(executorList(page.items));
      } catch(err){if(active)setError(String(err));}
    },250);
    return ()=>{active=false;clearTimeout(timer);};
  },[api,query]);
  return <div className="eva-assignee-field"><strong>Соисполнители</strong>
    <div>{people.map(p=><button key={p.id} type="button" aria-label={"Убрать "+p.label} onClick={()=>onChange(people.filter(x=>x.id!==p.id))}>{p.label} ×</button>)}</div>
    <input aria-label="Поиск соисполнителя" placeholder="Добавить по имени или логину…" value={query} onChange={e=>setQuery(e.target.value)}/>
    {matches.filter(p=>p.id!==primary && !people.some(x=>x.id===p.id)).map(p=><button key={p.id} type="button" onClick={()=>{onChange([...people,p]);setQuery("");}}>{p.label}</button>)}
    {error && <small role="alert">{error}</small>}
  </div>;
}