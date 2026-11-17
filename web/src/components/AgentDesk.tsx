import { useState, type ReactNode } from 'react';
import type { AgentDTO, ClaimDTO } from '../../../shared/types';
import { ago, isActive, timeLeft } from '../time';
import { Glyph } from './Brand';

interface Props {
  agent: AgentDTO;
  claims: ClaimDTO[];
  mine: boolean;
  now: number;
  onDisconnect: (agent: AgentDTO) => void;
  onReleaseClaim: (claim: ClaimDTO) => void;
}

/**
 * One Claude's pane, like a terminal window: a title bar with its name and
 * state, then what it's doing, the files it holds, and when it last called in.
 */
export function AgentDesk({ agent, claims, mine, now, onDisconnect, onReleaseClaim }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const SHOWN = 5;
  const visibleClaims = showAll ? claims : claims.slice(0, SHOWN);
  const active = isActive(agent.lastSeenAt, now);

  let presence: string;
  if (!agent.lastSeenAt) presence = 'waiting for its first call';
  else if (active) presence = agent.lastTool ? `active now, ran ${agent.lastTool}` : 'active now';
  else presence = `last seen ${ago(agent.lastSeenAt, now)}`;

  const fallback =
    agent.state === 'idle' ? 'nothing in progress' : agent.state === 'blocked' ? 'blocked, no details given' : 'working, no details given';

  return (
    <article className="pane" data-hue={agent.hue} data-state={agent.state} data-active={active}>
      <header className="pane-bar">
        <Glyph hue={agent.hue} />
        <h2 className="pane-name">{agent.name}</h2>
        <span className="state">{agent.state}</span>
      </header>

      <div className="pane-body">
        <p className="pane-owner">{mine ? 'yours' : `connected by ${agent.ownerName}`}</p>

        <p className="pane-label">doing</p>
        <p className={agent.task ? 'pane-task' : 'pane-task pane-task-empty'}>{agent.task ?? fallback}</p>
        {agent.task && agent.statusUpdatedAt && <p className="pane-dim">set {ago(agent.statusUpdatedAt, now)}</p>}

        {claims.length > 0 && (
          <>
            <p className="pane-label">holding</p>
            <ul className="claims" aria-label={`Files ${agent.name} has claimed`}>
              {visibleClaims.map((claim) => (
                <li key={claim.id} title={`${claim.note ? `${claim.note}. ` : ''}Expires in ${timeLeft(claim.expiresAt, now)}`}>
                  <span className="claim-path">
                    {claim.path}{' '}
                    <span className="pane-dim">{claim.auto ? 'editing' : timeLeft(claim.expiresAt, now)}</span>
                  </span>
                  <button type="button" aria-label={`Release the claim on ${claim.path}`} onClick={() => onReleaseClaim(claim)}>
                    release
                  </button>
                </li>
              ))}
            </ul>
            {claims.length > SHOWN && (
              <button type="button" className="link" onClick={() => setShowAll(!showAll)}>
                {showAll ? 'show fewer' : `+${claims.length - SHOWN} more`}
              </button>
            )}
          </>
        )}
      </div>

      <footer className="pane-foot">
        <span className="presence">
          <span className="presence-dot" aria-hidden="true" />
          {presence}
        </span>
        {mine &&
          (confirming ? (
            <span className="pane-confirm">
              <button type="button" className="link link-danger" onClick={() => onDisconnect(agent)}>
                disconnect it
              </button>
              <button type="button" className="link" onClick={() => setConfirming(false)}>
                keep
              </button>
            </span>
          ) : (
            <button type="button" className="link" onClick={() => setConfirming(true)}>
              disconnect
            </button>
          ))}
      </footer>
    </article>
  );
}

/** An empty place in the room, waiting for a Claude. */
export function Seat({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="seat">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
