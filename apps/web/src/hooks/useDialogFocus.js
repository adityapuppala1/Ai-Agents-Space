import { useEffect } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Focus handling for a custom modal (the command palette, global search):
 * while open, Tab and Shift+Tab cycle inside it instead of wandering into the
 * page behind; when it closes, focus returns to whatever held it before.
 * Native <dialog> elements (components/Dialog.jsx) already do both.
 *
 * Restoring is skipped when something else took focus meanwhile (a command
 * that opened another dialog keeps its own focus).
 */
export function useDialogFocus(ref, open) {
  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const invoker = document.activeElement;
    const onKeyDown = (event) => {
      if (event.key !== "Tab" || !ref.current) return;
      const nodes = [...ref.current.querySelectorAll(FOCUSABLE)].filter(
        (node) => node.getClientRects().length > 0,
      );
      if (!nodes.length) {
        event.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (!ref.current.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const current = document.activeElement;
      const focusWasInside =
        !current || current === document.body || ref.current?.contains(current);
      if (
        focusWasInside &&
        invoker &&
        invoker !== document.body &&
        document.contains(invoker) &&
        typeof invoker.focus === "function"
      )
        invoker.focus();
    };
  }, [open, ref]);
}

export default useDialogFocus;
