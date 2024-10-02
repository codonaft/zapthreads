import { Index, Show, createEffect, createComputed, createMemo, createSignal, onCleanup, batch, on, onMount } from "solid-js";
import { parseContent, shortenEncodedId, svgWidth, totalChildren, errorText, getSigner } from "./util/ui.ts";
import { DAY_IN_SECS, WEEK_IN_SECS, currentTime, sortByDate, timeAgo } from "./util/date-time.ts";
import { signAndPublishEvent, manualLogin, validateNestedNoteEvent } from "./util/network.ts";
import { noteEncode, npubEncode } from "nostr-tools/nip19";
import { UnsignedEvent, Event } from "nostr-tools/core";
import { Relay } from "nostr-tools/relay";
import { Metadata, ShortTextNote, EventDeletion, Highlights, Reaction, Report, CommunityDefinition, Mutelist, Zap } from "nostr-tools/kinds";
import { EventSigner, signersStore, store, CommentContext } from "./util/stores.ts";
import { NoteEvent, Profile, Pk, ReactionEvent, VoteKind, Eid, voteKind } from "./util/models.ts";
import { remove } from "./util/db.ts";
import { newSignal, Signal, trigger } from "./util/solidjs.ts";
import { getOrSetOrUpdate } from "./util/collections.ts";
import { applyBlock } from "./util/block-lists.ts";

export const Votes = (props: {
  eventId: () => Eid;
  rootEventId: () => Eid;
  voteCounts: () => {
    upvotesCount: Signal<number>;
    downvotesCount: Signal<number>;
  };
  votes: () => ReactionEvent[];
}) => {
  const eventId = () => props.eventId();
  const rootEventId = () => props.rootEventId();
  const votes = () => props.votes();

  const hasVotes = newSignal(false);
  const currentUserVote = newSignal(0);
  const currentNoteVotes = () => props.votes().filter(r => r.noteId === eventId());
  const currentNoteVotesDeduplicatedByPks = () => {
    const grouped = new Map<Pk, ReactionEvent[]>();
    currentNoteVotes().forEach((r: ReactionEvent) => {
      getOrSetOrUpdate(grouped, r.pk, () => [], g => [...g, r]);
    });
    //const grouped = Map.groupBy(currentNoteVotes(), r => r.pk); // doesn't work on firefox esr
    return [...grouped.values()].map(reactionEvents => sortByDate(reactionEvents)[0]);
  };

  createEffect(() => {
    batch(() => {
      const votes = currentNoteVotesDeduplicatedByPks();
      hasVotes(votes.length > 0);

      const upvotes = votes
        .map(r => +(voteKind(r) === 1))
        .reduce((sum, i) => sum + i, 0);
      const downvotes = votes
        .map(r => +(voteKind(r) === -1))
        .reduce((sum, i) => sum + i, 0);
      props.voteCounts().upvotesCount(upvotes);
      props.voteCounts().downvotesCount(downvotes);

      const signer = signersStore.active;
      const kind: VoteKind = (signer && votes.filter(r => r.pk === signer!.pk).map(r => voteKind(r))[0]) || 0;
      currentUserVote(kind);
    });
  });

  const toggleVote = async (reaction: VoteKind) => {
    const s = await getSigner();
    if (!s) {
      return;
    }
    const signer = s!;
    const latestVote = currentUserVote();
    const newVote = latestVote === reaction ? 0 : reaction;

    const publishVote = async () => {
      const tags = [];
      if (rootEventId()) {
        tags.push(['e', rootEventId(), '', 'root']);
      }

      await signAndPublishEvent({
        kind: Reaction,
        created_at: currentTime(),
        content: newVote === -1 ? '-' : '+',
        pubkey: signer.pk,
        tags: [
          ...tags,
          ['e', eventId(), '', 'reply'],
          ['p', signer.pk],
        ],
      }, signer);
    };

    const unpublishOutdatedEvents = async () => {
      const eids: Eid[] = sortByDate(currentNoteVotes().filter(r => r.pk === signer!.pk))
        .reverse()
        .map(i => i.id);
      if (eids.length === 0) {
        return;
      }
      const sentRequest = await signAndPublishEvent({
        kind: EventDeletion,
        created_at: currentTime(),
        content: '',
        pubkey: signer.pk,
        tags: [...eids.map(eid => ['e', eid]), ...eids.map(_ => ['k', `${Reaction}`])],
      }, signer);
      if (sentRequest) {
        remove('reactions', eids);
      }
    };

    await unpublishOutdatedEvents();
    if ([-1, 1].includes(newVote)) {
      await publishVote();
    }
  };

  return <Show when={!store.disableFeatures!.includes('votes')}>
    <li class="ztr-comment-action-upvote" classList={{selected: currentUserVote() === 1}} onClick={() => toggleVote(1)}>
      {currentUserVote() === 1 ? upvoteSelectedSvg() : upvoteSvg()}
      <Show when={store.disableFeatures!.includes('singleVoteCounter') && hasVotes()}>
        <span>{props.voteCounts().upvotesCount()}</span>
      </Show>
    </li>
    <Show when={!store.disableFeatures!.includes('singleVoteCounter') || !hasVotes()}>
      <li class="ztr-comment-action-votes">
        <span>{hasVotes() ? (props.voteCounts().upvotesCount() - props.voteCounts().downvotesCount()) : 'Vote'}</span>
      </li>
    </Show>
    <li class="ztr-comment-action-downvote" classList={{selected: currentUserVote() === -1}} onClick={() => toggleVote(-1)}>
      {currentUserVote() === -1 ? downvoteSelectedSvg() : downvoteSvg()}
      <Show when={store.disableFeatures!.includes('singleVoteCounter') && hasVotes()}>
        <span>{props.voteCounts().downvotesCount()}</span>
      </Show>
    </li>
  </Show>;
};

const upvoteSvg = () => <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="#000000" viewBox="0 0 256 256"><path d="M237,77.47A28,28,0,0,0,216,68H164V56a44.05,44.05,0,0,0-44-44,12,12,0,0,0-10.73,6.63L72.58,92H32a20,20,0,0,0-20,20v88a20,20,0,0,0,20,20H204a28,28,0,0,0,27.78-24.53l12-96A28,28,0,0,0,237,77.47ZM36,116H68v80H36ZM220,96.5l-12,96a4,4,0,0,1-4,3.5H92V106.83L126.82,37.2A20,20,0,0,1,140,56V80a12,12,0,0,0,12,12h64a4,4,0,0,1,4,4.5Z"></path></svg>;
const downvoteSvg = () => <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="#000000" viewBox="0 0 256 256"><path d="M243.78,156.53l-12-96A28,28,0,0,0,204,36H32A20,20,0,0,0,12,56v88a20,20,0,0,0,20,20H72.58l36.69,73.37A12,12,0,0,0,120,244a44.05,44.05,0,0,0,44-44V188h52a28,28,0,0,0,27.78-31.47ZM68,140H36V60H68Zm151,22.65a4,4,0,0,1-3,1.35H152a12,12,0,0,0-12,12v24a20,20,0,0,1-13.18,18.8L92,149.17V60H204a4,4,0,0,1,4,3.5l12,96A4,4,0,0,1,219,162.65Z"></path></svg>;
const upvoteSelectedSvg = () => <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path fill="none" d="M0 0h256v256H0z"/><path d="M234 80.12A24 24 0 0 0 216 72h-56V56a40 40 0 0 0-40-40 8 8 0 0 0-7.16 4.42L75.06 96H32a16 16 0 0 0-16 16v88a16 16 0 0 0 16 16h172a24 24 0 0 0 23.82-21l12-96A24 24 0 0 0 234 80.12M32 112h40v88H32Z"/><path d="M27.419 101.919h49.822v109.612H27.419z"/></svg>;
const downvoteSelectedSvg = () => <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path fill="none" d="M0 0h256v256H0z"/><path d="m239.82 157-12-96A24 24 0 0 0 204 40H32a16 16 0 0 0-16 16v88a16 16 0 0 0 16 16h43.06l37.78 75.58A8 8 0 0 0 120 240a40 40 0 0 0 40-40v-16h56a24 24 0 0 0 23.82-27M72 144H32V56h40Z"/><path d="M26.819 45.073h49.284v107.561H26.819z"/></svg>;
