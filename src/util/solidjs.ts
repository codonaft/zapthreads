import { createSignal } from "solid-js";

export type Signal<T> = (value?: T) => T;

export function newSignal<T>(defaultValue?: T): Signal<T> {
  const [signal, setSignal] = createSignal(defaultValue);

  // @ts-ignore
  return (newValue?: T) => {
    if (newValue === undefined) {
      return signal();
    } else {
      // @ts-ignore
      return setSignal(newValue);
    }
  };
}

export function trigger(signal: Signal<boolean>) {
  return signal(!signal());
}
