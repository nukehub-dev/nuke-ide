import * as React from 'react';

export interface TocItem {
  level: number;
  text: string;
  id: string;
}

export interface DocsTocProps {
  items: TocItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

export const DocsToc = (props: DocsTocProps): React.ReactElement => {
  const { items, activeId, onSelect } = props;

  return (
    <aside className="nuke-docs-toc">
      <div className="nuke-docs-toc-header">
        <span className="nuke-docs-toc-title">On this page</span>
      </div>
      <nav className="nuke-docs-toc-nav">
        {items.map(item => (
          <button
            key={item.id}
            className={`nuke-docs-toc-item nuke-docs-toc-level-${item.level}${activeId === item.id ? ' nuke-docs-toc-active' : ''}`}
            onClick={() => onSelect(item.id)}
          >
            {item.text}
          </button>
        ))}
      </nav>
    </aside>
  );
};
