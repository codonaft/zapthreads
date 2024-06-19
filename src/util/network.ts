import { Event } from "nostr-tools/core";
import { Relay } from "nostr-tools/relay";

let publishAttempt = 0;

const timeLimit = async <T>(fn: () => Promise<T>, timeout?: number) => {
  let timer;
  if (timeout) {
    timer = setTimeout(() => {
      throw new Error('Timelimit exceeded');
    }, timeout!);
  }

  try {
    return await fn();
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

const publishSequentially = async (event: Event, relays: string[], timeout?: number): Promise<[number, any[]]> => {
  console.log('seq');
  const failures = [];
  for (const relayUrl of relays) {
    try {
      await timeLimit(async () => {
        const relay = await Relay.connect(relayUrl);
        await relay.publish(event);
      }, timeout);
    } catch (e) {
      failures.push([relayUrl, e]);
    }
  }

  const ok = relays.length - failures.length;
  return [ok, failures];
};

const publishConcurrently = async <T>(event: Event, relays: string[], timeout?: number): Promise<[number, any[]]> => {
  console.log('concurrently');
  const results = await Promise.allSettled(relays.map(async (relayUrl: string) =>
    timeLimit(async () => {
      const relay = await Relay.connect(relayUrl);
      await relay.publish(event);
    }, timeout)
  ));

  let ok = 0;
  const failures = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      ok += 1;
    } else if (results[i]) {
      failures.push([relays[i], results[i]]);
    }
  }
  return [ok, failures];
}

export const publishEvent = async (event: Event, relays: string[], timeout?: number): Promise<[number, number]> => {
  //publishAttempt += 1;
  const startTime = Date.now();
  const [ok, failures] = publishAttempt % 2 == 0 ? await publishConcurrently(event, relays, timeout) : await publishSequentially(event, relays, timeout);
  const deltaTime = Date.now() - startTime;
  console.log(`publish ok=${ok} failed=${failures.length} took ${deltaTime} ms`);
  failures.length > 0 && console.log(failures);
  return [ok, failures.length]
}
