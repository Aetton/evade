import { createElement, useMemo, useState, type ReactNode } from "react";

const allowed = new Set("p div br strong b em i u s ul ol li pre code blockquote h1 h2 h3 h4 h5 h6 table thead tbody tr td th hr sup sub".split(" "));
const ignored = new Set("script style template iframe object embed svg math form input button img link meta".split(" "));

function renderDescription(value: string): ReactNode {
  if (!/<(?:p|div|br|strong|b|em|i|u|s|ol|ul|li|pre|code|blockquote|h[1-6]|table|a|span)\b[^>]*>/i.test(value)) {
    return <div className="description-plain">{value}</div>;
  }
  // Template content stays inert. Only rebuild known elements and attributes as React nodes.
  const template = document.createElement("template");
  template.innerHTML = value;
  function render(node: Node, key: number): ReactNode {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const element = node as Element;
    const tag = element.localName.toLowerCase();
    if (ignored.has(tag)) return null;
    const children = Array.from(element.childNodes, render);
    if (tag === "a") {
      const href = element.getAttribute("href") || "";
      if (/^https?:\/\//i.test(href)) return <a key={key} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
    }
    if (!allowed.has(tag)) return children;
    if (tag === "br" || tag === "hr") return createElement(tag, {key});
    const start = tag === "ol" ? element.getAttribute("start") : null;
    return createElement(tag, start && /^-?\d+$/.test(start) ? {key, start: Number(start)} : {key}, children);
  }
  return Array.from(template.content.childNodes, render);
}

export function TaskDescription({value, onChange}: {value: string; onChange: (value: string) => void}) {
  const [editing, setEditing] = useState(false);
  const preview = useMemo(() => renderDescription(value), [value]);
  return <section className="task-description">
    <header><strong>Описание</strong><button type="button" onClick={()=>setEditing(!editing)}>
      {editing ? "Предпросмотр" : "Редактировать исходник"}
    </button></header>
    {editing ? <textarea aria-label="Исходный текст описания" rows={8} value={value} onChange={e=>onChange(e.target.value)}/> :
      <div className="description-preview">{value ? preview : "Описание пока пустое"}</div>}
  </section>;
}
