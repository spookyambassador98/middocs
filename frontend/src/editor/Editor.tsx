import { useEffect, useRef } from "react";
import Quill from "quill";
import QuillCursors from "quill-cursors";
import { QuillBinding } from "y-quill";
import "quill/dist/quill.snow.css";
import type { SocketIOProvider } from "./SocketIOProvider";

Quill.register("modules/cursors", QuillCursors);

const TOOLBAR_OPTIONS = [
  [{ header: [1, 2, 3, false] }],
  ["bold", "italic", "underline", "strike"],
  [{ color: [] }, { background: [] }],
  [{ list: "ordered" }, { list: "bullet" }],
  ["blockquote", "code-block"],
  ["link"],
  ["clean"],
];

const TYPING_TIMEOUT_MS = 1200;

export function Editor({ provider }: { provider: SocketIOProvider }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const quill = new Quill(containerRef.current, {
      theme: "snow",
      placeholder: "Начните печатать…",
      modules: {
        toolbar: TOOLBAR_OPTIONS,
        cursors: {
          transformOnTextChange: true,
        },
      },
    });

    const ytext = provider.doc.getText("quill");
    const binding = new QuillBinding(ytext, quill, provider.awareness);

    let typingTimeout: ReturnType<typeof setTimeout> | null = null;
    const handleTextChange = (_delta: unknown, _oldDelta: unknown, source: string) => {
      if (source !== "user") return;
      provider.awareness.setLocalStateField("typing", true);
      if (typingTimeout) clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        provider.awareness.setLocalStateField("typing", false);
      }, TYPING_TIMEOUT_MS);
    };
    quill.on("text-change", handleTextChange);

    return () => {
      quill.off("text-change", handleTextChange);
      if (typingTimeout) clearTimeout(typingTimeout);
      provider.awareness.setLocalStateField("typing", false);
      binding.destroy();
    };
    // provider is stable for the lifetime of this component (created once by the parent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  return (
    <div className="editor-page-frame">
      <div ref={containerRef} />
    </div>
  );
}
