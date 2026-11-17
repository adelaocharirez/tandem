/**
 * Tandem's terminal identity.
 *
 * Every agent owns a terminal colour and a glyph, so agents are never told
 * apart by colour alone. The interface itself is purple; agent colours are
 * kept away from purple so the two never get confused.
 */

/** Prompt-style wordmark: a purple chevron, the name, and a block cursor. */
export function Logo({ large = false }: { large?: boolean }) {
  return (
    <span className={large ? 'logo logo-large' : 'logo'}>
      <span className="logo-prompt" aria-hidden="true">
        &gt;
      </span>
      tandem
      <span className="logo-cursor" aria-hidden="true" />
    </span>
  );
}

const GLYPHS = ['●', '■', '▲', '◆', '✚', '◗'];

/** An agent's glyph in its colour. */
export function Glyph({ hue }: { hue: number }) {
  return (
    <span className="glyph" data-hue={hue} aria-hidden="true">
      {GLYPHS[((hue % 6) + 6) % 6]}
    </span>
  );
}

/** An agent's glyph, or a person's initial in a purple box. */
export function Avatar({ hue, name }: { hue: number | null; name: string }) {
  if (hue !== null) return <Glyph hue={hue} />;
  return (
    <span className="initial" aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

/** A stable colour for things that aren't agents (rooms in the lobby). */
export function hueFor(id: string): number {
  let sum = 0;
  for (const ch of id) sum = (sum * 31 + ch.charCodeAt(0)) >>> 0;
  return sum % 6;
}
