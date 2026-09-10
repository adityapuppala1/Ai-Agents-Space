import { useCallback, useEffect, useState } from "react";

/**
 * Per-browser preference storage for the web app. Only view preferences live
 * here — never task data, never anything the server owns, never a secret.
 * Every access is guarded because private windows and blocked site data make
 * `localStorage` throw rather than return null.
 */

export function readLocal(key, fallback) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeLocal(key, value) {
  try {
    if (value === undefined) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * useState backed by localStorage under `key`.
 * @returns {[any, (value:any)=>void]}
 */
export function useLocalStorage(key, fallback) {
  const [value, setValue] = useState(() => readLocal(key, fallback));
  useEffect(() => {
    setValue(readLocal(key, fallback));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const update = useCallback(
    (next) => {
      setValue((current) => {
        const resolved = typeof next === "function" ? next(current) : next;
        writeLocal(key, resolved);
        return resolved;
      });
    },
    [key],
  );
  return [value, update];
}

/**
 * A bounded most-recently-used list of ids, newest first.
 * Pure so node:test can cover it.
 */
export function pushRecent(list, id, limit = 8) {
  if (!id) return Array.isArray(list) ? list.slice(0, limit) : [];
  const rest = (Array.isArray(list) ? list : []).filter(
    (entry) => entry !== id,
  );
  return [id, ...rest].slice(0, limit);
}

/** Toggle membership of an id in a bounded set (used for pinned runs). */
export function toggleIn(list, id, limit = 24) {
  const current = Array.isArray(list) ? list : [];
  if (!id) return current;
  return current.includes(id)
    ? current.filter((entry) => entry !== id)
    : [id, ...current].slice(0, limit);
}

export default useLocalStorage;
