import { useEffect, useRef, useState } from "react";
import Quill from "quill";
import * as Y from "yjs";
import { QuillBinding } from "y-quill";
import "quill/dist/quill.snow.css";
import { registerQuillExtensions } from "./quillSetup";
import type { SocketIOProvider, ReactionEvent, AttributionEvent } from "./SocketIOProvider";

registerQuillExtensions();

const TOOLBAR_OPTIONS = [
  [{ header: [1, 2, 3, false] }],
  ["bold", "italic", "underline", "strike"],
  [{ color: [] }, { background: [] }],
  [{ list: "ordered" }, { list: "bullet" }, { list: "check" }],
  ["blockquote", "code-block"],
  ["link"],
  ["clean"],
];

const TYPING_TIMEOUT_MS = 1200;

interface SlashItem {
  label: string;
  hint: string;
  run: (quill: Quill, index: number) => void;
}

const SLASH_ITEMS: SlashItem[] = [
  { label: "Heading 1", hint: "H1", run: (q, i) => q.formatLine(i, 1, "header", 1, "user") },
  { label: "Heading 2", hint: "H2", run: (q, i) => q.formatLine(i, 1, "header", 2, "user") },
  { label: "Heading 3", hint: "H3", run: (q, i) => q.formatLine(i, 1, "header", 3, "user") },
  { label: "Bulleted list", hint: "•", run: (q, i) => q.formatLine(i, 1, "list", "bullet", "user") },
  { label: "Numbered list", hint: "1.", run: (q, i) => q.formatLine(i, 1, "list", "ordered", "user") },
  { label: "Checklist", hint: "☑", run: (q, i) => q.formatLine(i, 1, "list", "unchecked", "user") },
  { label: "Quote", hint: "❝", run: (q, i) => q.formatLine(i, 1, "blockquote", true, "user") },
  {
    label: "Divider",
    hint: "—",
    run: (q, i) => {
      q.insertEmbed(i, "divider", true, "user");
      q.setSelection(i + 1, 0, "user");
    },
  },
];

export interface EditorApi {
  quill: Quill;
  undo: () => void;
  redo: () => void;
}

interface FlyingReaction {
  key: number;
  emoji: string;
  name: string;
  color: string;
  left: number;
}

interface AttributionHighlight {
  key: number;
  top: number;
  left: number;
  width: number;
  height: number;
  color: string;
}

const ATTRIBUTION_FADE_MS = 12_000;

/** Where a Quill text-change delta's insert ops landed, in document-index terms — used to broadcast "I just typed here" for the live attribution heatmap. */
function insertedRanges(delta: { ops?: { retain?: number | object; insert?: unknown; delete?: number }[] }): {
  index: number;
  length: number;
}[] {
  const ranges: { index: number; length: number }[] = [];
  let cursor = 0;
  for (const op of delta.ops ?? []) {
    if (typeof op.retain === "number") {
      cursor += op.retain;
    } else if (typeof op.insert === "string") {
      ranges.push({ index: cursor, length: op.insert.length });
      cursor += op.insert.length;
    } else if (op.insert !== undefined) {
      // Embed (e.g. the divider blot) counts as one position.
      ranges.push({ index: cursor, length: 1 });
      cursor += 1;
    }
  }
  return ranges;
}

export function Editor({
  provider,
  onReady,
}: {
  provider: SocketIOProvider;
  onReady?: (api: EditorApi) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const quillRef = useRef<Quill | null>(null);
  const [slashMenu, setSlashMenu] = useState<{ top: number; left: number; index: number; query: string } | null>(
    null
  );
  const [flyingReactions, setFlyingReactions] = useState<FlyingReaction[]>([]);
  const [attributionHighlights, setAttributionHighlights] = useState<AttributionHighlight[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;

    const quill = new Quill(containerRef.current, {
      theme: "snow",
      placeholder: "Start typing… (type / for commands)",
      modules: {
        toolbar: TOOLBAR_OPTIONS,
        cursors: {
          transformOnTextChange: true,
        },
      },
    });
    quillRef.current = quill;

    const ytext = provider.doc.getText("quill");
    const binding = new QuillBinding(ytext, quill, provider.awareness);

    // Collaborative undo/redo: only the LOCAL user's own edits are tracked
    // (trackedOrigins keyed on the binding instance, which is the origin
    // y-quill transacts local Quill changes with) so pressing Ctrl+Z never
    // reverts a peer's concurrent edit — it only steps back through your
    // own history, the way per-user undo is meant to behave in a shared doc.
    const undoManager = new Y.UndoManager(ytext, { trackedOrigins: new Set([binding]) });
    const undo = () => undoManager.undo();
    const redo = () => undoManager.redo();
    quill.keyboard.addBinding({ key: "z", shortKey: true }, () => {
      undo();
      return false;
    });
    quill.keyboard.addBinding({ key: "z", shortKey: true, shiftKey: true }, () => {
      redo();
      return false;
    });
    quill.keyboard.addBinding({ key: "y", shortKey: true }, () => {
      redo();
      return false;
    });

    onReady?.({ quill, undo, redo });

    // ---------- typing indicator ----------
    let typingTimeout: ReturnType<typeof setTimeout> | null = null;

    // ---------- slash-command menu ----------
    function closeSlashMenu() {
      setSlashMenu(null);
    }

    function updateSlashMenu() {
      const range = quill.getSelection();
      if (!range || range.length > 0) return closeSlashMenu();
      const offsetInLine = quill.getLine(range.index)[1];
      const lineStartIndex = range.index - offsetInLine;
      const textBeforeCursor = quill.getText(lineStartIndex, offsetInLine);
      const match = /^\/(\w*)$/.exec(textBeforeCursor);
      if (!match) return closeSlashMenu();
      const bounds = quill.getBounds(range.index);
      if (!bounds) return closeSlashMenu();
      setSlashMenu({
        top: bounds.bottom + 6,
        left: bounds.left,
        index: range.index - textBeforeCursor.length,
        query: match[1],
      });
    }

    const handleTextChange = (delta: { ops?: { retain?: number | object; insert?: unknown; delete?: number }[] }, _oldDelta: unknown, source: string) => {
      if (source !== "user") return;
      provider.awareness.setLocalStateField("typing", true);
      if (typingTimeout) clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        provider.awareness.setLocalStateField("typing", false);
      }, TYPING_TIMEOUT_MS);
      updateSlashMenu();

      // Live attribution heatmap: tell everyone (including ourselves, via
      // the server's room-wide echo below) exactly which range we just
      // typed into, so it can be highlighted for a few seconds. Purely
      // visual/ephemeral — never part of the CRDT document.
      for (const range of insertedRanges(delta)) {
        provider.sendAttribution(range.index, range.length);
      }
    };
    const handleSelectionChange = (range: { index: number; length: number } | null) => {
      if (!range) closeSlashMenu();
    };
    quill.on("text-change", handleTextChange);
    quill.on("selection-change", handleSelectionChange);

    // ---------- live emoji reactions ----------
    // Deliberately NOT anchored to the sender's cursor position: y-quill
    // doesn't document the exact shape it stores in the shared awareness
    // "cursor" field (it's an internal relative-position encoding meant
    // for its own QuillCursors rendering), so reaching into it here would
    // be guesswork. Anchoring to the sender's name/color — which *we*
    // set ourselves in SocketIOProvider — is both simpler and something
    // we can be sure is correct.
    const offReaction = provider.onReaction((event: ReactionEvent) => {
      const senderState = provider.awareness.getStates().get(event.clientId) as
        | { user?: { name: string; color: string } }
        | undefined;
      const name = senderState?.user?.name ?? "Someone";
      const color = senderState?.user?.color ?? "var(--accent)";
      const key = Date.now() + Math.random();
      const left = 10 + Math.random() * 80;
      setFlyingReactions((prev) => [...prev, { key, emoji: event.emoji, name, color, left }]);
      setTimeout(() => {
        setFlyingReactions((prev) => prev.filter((r) => r.key !== key));
      }, 1800);
    });

    // ---------- live attribution heatmap ----------
    const offAttribution = provider.onAttribution((event: AttributionEvent) => {
      const length = Math.max(1, Math.min(event.length, quill.getLength() - event.index));
      if (event.index < 0 || event.index >= quill.getLength() || length <= 0) return;
      let bounds;
      try {
        bounds = quill.getBounds(event.index, length);
      } catch {
        return;
      }
      if (!bounds) return;
      const senderState = provider.awareness.getStates().get(event.clientId) as
        | { user?: { name: string; color: string } }
        | undefined;
      const color = senderState?.user?.color ?? "var(--accent)";
      const rootRect = quill.root.getBoundingClientRect();
      const key = Date.now() + Math.random();
      setAttributionHighlights((prev) => [
        ...prev,
        {
          key,
          top: rootRect.top + bounds.top,
          left: rootRect.left + bounds.left,
          width: Math.max(6, bounds.width),
          height: bounds.height,
          color,
        },
      ]);
      setTimeout(() => {
        setAttributionHighlights((prev) => prev.filter((h) => h.key !== key));
      }, ATTRIBUTION_FADE_MS);
    });

    return () => {
      quill.off("text-change", handleTextChange);
      quill.off("selection-change", handleSelectionChange);
      offReaction();
      offAttribution();
      if (typingTimeout) clearTimeout(typingTimeout);
      provider.awareness.setLocalStateField("typing", false);
      undoManager.destroy();
      binding.destroy();
      quillRef.current = null;
    };
    // provider is stable for the lifetime of this component (created once by the parent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const runSlashItem = (item: SlashItem) => {
    const quill = quillRef.current;
    if (!quill || !slashMenu) return;
    // Remove the "/query" text the user typed before applying the format.
    quill.deleteText(slashMenu.index, 1 + slashMenu.query.length, "user");
    item.run(quill, slashMenu.index);
    setSlashMenu(null);
  };

  const visibleItems = slashMenu
    ? SLASH_ITEMS.filter((item) => item.label.toLowerCase().includes(slashMenu.query.toLowerCase()))
    : [];

  return (
    <div className="editor-page-frame" style={{ position: "relative" }}>
      <div ref={containerRef} />

      {slashMenu && visibleItems.length > 0 && (
        <div className="slash-menu" style={{ top: slashMenu.top, left: slashMenu.left }}>
          {visibleItems.map((item) => (
            <button
              key={item.label}
              className="slash-menu-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runSlashItem(item)}
            >
              <span className="slash-menu-hint">{item.hint}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}

      <div className="reaction-stage">
        {flyingReactions.map((r) => (
          <span key={r.key} className="flying-reaction" style={{ left: `${r.left}%` }}>
            <span className="flying-reaction-emoji">{r.emoji}</span>
            <span className="flying-reaction-name" style={{ background: r.color }}>
              {r.name}
            </span>
          </span>
        ))}
      </div>

      {attributionHighlights.map((h) => (
        <span
          key={h.key}
          className="attribution-highlight"
          style={{
            top: h.top,
            left: h.left,
            width: h.width,
            height: h.height,
            background: h.color,
          }}
        />
      ))}
    </div>
  );
}
