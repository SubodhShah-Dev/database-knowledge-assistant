import type { ReactNode } from 'react';
import { IconChat } from '../components/icons';

function Placeholder({
  icon,
  eyebrow,
  title,
  body
}: {
  icon: ReactNode;
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <section className="page narrow-page">
      <div className="page-heading">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{body}</p>
      </div>
      <div className="placeholder-card">
        <span className="placeholder-icon">{icon}</span>
        <p>This workspace is being assembled. The API and safety layer are ready.</p>
      </div>
    </section>
  );
}

export function ChatPage() {
  return (
    <Placeholder
      icon={<IconChat size={24} />}
      eyebrow="Session"
      title="Chat"
      body="Ask a question and inspect the read-only SQL and rows behind the answer."
    />
  );
}
