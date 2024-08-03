import type { WindowNostr } from "nostr-tools/nip07";

let current: WindowNostr | undefined = undefined;
const beforenostrload = "beforenostrload";
const nostrloaded = "nostrloaded";
const beforenostrupdate = "beforenostrupdate";
const nostrupdated = "nostrupdated";

let resolveNostr: (nostr: WindowNostr) => void | undefined;
export const readyNostr = new Promise<WindowNostr>((resolve) => {
  if ("nostr" in window) {
    current = window.nostr as WindowNostr;
    resolve(current);
  } else {
    resolveNostr = resolve;
  }
});

export const waitNostr = (
  timeoutMs: number
): Promise<WindowNostr | undefined> =>
  Promise.race([
    new Promise<undefined>((resolve) => {
      setTimeout(() => {
        resolve(undefined);
      }, timeoutMs);
    }),
    readyNostr,
  ]);

Object.defineProperty(window, "nostr", {
  configurable: true,
  get: () => current,
  set: (nostr) => {
    const [beforeEvent, afterEvent] = current
      ? [beforenostrupdate, nostrupdated]
      : [beforenostrload, nostrloaded];

    const goOn = window.dispatchEvent(
      new CustomEvent(beforeEvent, {
        cancelable: true,
        detail: { nostr },
      })
    );

    if (goOn) {
      current = nostr;

      window.dispatchEvent(
        new CustomEvent(afterEvent, {
          cancelable: false,
          detail: { nostr },
        })
      );
      if (afterEvent === nostrloaded) {
        resolveNostr?.(nostr);
      }
    }
  },
});

declare global {
  interface WindowEventMap {
    [beforenostrload]: CustomEvent<{ nostr: WindowNostr }>;
    [nostrloaded]: CustomEvent<{ nostr: WindowNostr }>;
    [beforenostrupdate]: CustomEvent<{ nostr: WindowNostr }>;
    [nostrupdated]: CustomEvent<{ nostr: WindowNostr }>;
  }
}
