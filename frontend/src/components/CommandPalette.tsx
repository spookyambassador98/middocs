import { useEffect, useMemo, useState } from "react";

export type Command = {
  id: string;
  label: string;
  icon?: string;
  hint?: string;
  run: () => void;
};

export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return { open, setOpen };
}

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  function run(cmd: Command) {
    onClose();
    cmd.run();
  }

  return (
    <div className="command-palette-overlay" onMouseDown={onClose}>
      <div
        className="command-palette"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <input
          autoFocus
          className="command-palette-input"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            }
            if (e.key === "Enter" && filtered[active]) run(filtered[active]);
          }}
        />
        <div className="command-palette-list">
          {filtered.length === 0 ? (
            <p className="command-palette-empty">No matching commands</p>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.id}
                className={`command-palette-item ${i === active ? "active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => run(cmd)}
              >
                <span className="command-palette-icon">{cmd.icon ?? "→"}</span>
                <span className="command-palette-label">{cmd.label}</span>
                {cmd.hint ? <span className="command-palette-hint">{cmd.hint}</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
