export function bindInspector(root: HTMLElement, handle: HTMLElement) {
  const key = "evade:inspector-width";
  let preferred = 450;
  try {
    const stored = Number(localStorage.getItem(key));
    if (stored > 0 && Number.isFinite(stored)) preferred = stored;
  } catch {}
  let current = preferred;
  function update() {
    if (!handle.getClientRects().length) return;
    const available = root.getBoundingClientRect().right - root.querySelector<HTMLElement>("[data-inspector-center]")!.getBoundingClientRect().left;
    const max = Math.max(320, available - 320);
    current = Math.max(320, Math.min(max, Math.round(preferred)));
    root.style.setProperty("--inspector-width", current + "px");
    handle.setAttribute("aria-valuemin", "320");
    handle.setAttribute("aria-valuemax", String(Math.floor(max)));
    handle.setAttribute("aria-valuenow", String(current));
  }
  function save() {
    try { localStorage.setItem(key, String(preferred)); } catch {}
  }
  function down(event: PointerEvent) {
    if (event.button !== 0) return;
    handle.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    preferred = root.getBoundingClientRect().right - event.clientX;
    update();
    preferred = current;
  }
  function arrows(event: KeyboardEvent) {
    if (!["ArrowLeft","ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    preferred = current + (event.key === "ArrowLeft" ? 24 : -24);
    update(); preferred = current; save();
  }
  const observer = new ResizeObserver(update);
  observer.observe(root); observer.observe(handle);
  handle.addEventListener("pointerdown", down);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("lostpointercapture", save);
  handle.addEventListener("keydown", arrows);
  update();
  return () => {
    observer.disconnect();
    handle.removeEventListener("pointerdown", down);
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("lostpointercapture", save);
    handle.removeEventListener("keydown", arrows);
  };
}
