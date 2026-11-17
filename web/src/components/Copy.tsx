import { useEffect, useState, type ReactNode } from 'react';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API is unavailable on plain-http LAN addresses; fall back.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/** A button that copies `text` and says so for a moment. */
export function CopyButton({ text, children, className = 'btn' }: { text: string; children: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <button type="button" className={className} onClick={async () => setCopied(await copyText(text))}>
      <span aria-live="polite">{copied ? 'copied' : children}</span>
    </button>
  );
}

/** A command or config snippet with its own copy button. */
export function CopyBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className="copy-block">
      <pre tabIndex={0} aria-label={label}>
        {text}
      </pre>
      <CopyButton text={text} className="btn btn-small">
        copy
      </CopyButton>
    </div>
  );
}
