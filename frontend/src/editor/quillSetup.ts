import Quill from "quill";
import QuillCursors from "quill-cursors";

let registered = false;

export function registerQuillExtensions() {
  if (registered) return;
  registered = true;

  Quill.register("modules/cursors", QuillCursors);

  const BlockEmbed = Quill.import("blots/block/embed") as {
    new (...args: unknown[]): unknown;
    prototype: object;
  };
  class DividerBlot extends (BlockEmbed as unknown as { new (...args: unknown[]): HTMLElement }) {
    static blotName = "divider";
    static tagName = "HR";
  }
  Quill.register(DividerBlot);
}
