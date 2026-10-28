import type { ReactNode } from 'react';
import { IconChat, IconDatabase, IconPlus } from '../components/icons';

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

export function NewSessionPage() {
  return (
    <Placeholder
      icon={<IconPlus size={24} />}
      eyebrow="Start a session"
      title="New session"
      body="Pick a database connection, review the schema, and choose the tables in scope."
    />
  );
}

export function ConnectionsPage() {
  return (
    <Placeholder
      icon={<IconDatabase size={24} />}
      eyebrow="Database connections"
      title="Connections"
      body="Save encrypted PostgreSQL connections and test them before starting a session."
    />
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
