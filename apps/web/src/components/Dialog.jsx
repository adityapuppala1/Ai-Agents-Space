import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";

/**
 * Native <dialog> using the existing `.modal` pattern from styles.css.
 * @param {{ title: string, onClose: () => void, children: React.ReactNode, wide?: boolean }} props
 */
export default function Dialog({ title, onClose, children, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector("[data-autofocus]")?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal as-dialog ${wide ? "as-dialog-wide" : ""}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      aria-label={title}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button
          type="button"
          aria-label="Close dialog"
          className="icon-button"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
