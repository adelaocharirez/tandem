import { useEffect, useRef } from 'react';
import type { AgentDTO, MemberDTO } from '../../../shared/types';
import { Avatar } from './Brand';
import { CopyButton } from './Copy';

/** Who's in the room, and how to bring someone in. */
export function PeopleMenu({ members, agents, inviteCode }: { members: MemberDTO[]; agents: AgentDTO[]; inviteCode: string }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const inviteLink = `${location.origin}/join/${inviteCode}`;

  // Close when clicking anywhere outside, or on Escape.
  useEffect(() => {
    const close = (event: Event) => {
      const el = menu.current;
      if (!el?.open) return;
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !el.contains(event.target as Node)) el.open = false;
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);

  return (
    <details className="menu" ref={menu}>
      <summary className="menu-trigger">
        <span className="avatar-stack">
          {members.slice(0, 4).map((member) => (
            <Avatar key={member.id} hue={null} name={member.displayName} />
          ))}
        </span>
        <span>invite</span>
      </summary>

      <div className="menu-panel">
        <h2>people in this room</h2>
        <ul className="people">
          {members.map((member) => {
            const theirs = agents.filter((a) => a.userId === member.id);
            return (
              <li key={member.id}>
                <Avatar hue={null} name={member.displayName} />
                <span className="people-name">{member.displayName}</span>
                <span className="people-agents">
                  {theirs.length === 0
                    ? 'no claude yet'
                    : theirs.map((a) => <Avatar key={a.id} hue={a.hue} name={a.name} />)}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="invite">
          <p>
            Send this link to a teammate, or have them enter <code>{inviteCode}</code> on their rooms page.
          </p>
          <CopyButton text={inviteLink} className="btn btn-primary btn-wide">
            Copy invite link
          </CopyButton>
        </div>
      </div>
    </details>
  );
}
