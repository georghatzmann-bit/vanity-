import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { IconSearch } from '../../icons/icons.tsx';
import { cx } from '../../utils/cx.ts';
import { scoreSearchable, type TextRange } from '../../utils/search.ts';
import { Dialog, type DialogCloseReason } from '../Dialog/Dialog.tsx';
import { Kbd } from '../Panel/Kbd.tsx';

export interface CommandItem {
  /** Eindeutige ID. */
  readonly id: string;
  readonly label: string;
  /** Gruppe (Überschrift), z. B. „Navigation“, „Aktionen“. */
  readonly group: string;
  /** Zusätzliche Suchbegriffe (Synonyme, englische Begriffe …). */
  readonly keywords?: readonly string[] | undefined;
  /** Tastenkürzel zur Anzeige, z. B. `['Strg', '1']`. */
  readonly shortcut?: readonly string[] | undefined;
  /** Icon (dekorativ). */
  readonly icon?: ReactNode;
  /** Ergänzung rechts, z. B. „Folgt in P3“. */
  readonly hint?: string | undefined;
  readonly disabled?: boolean | undefined;
  /**
   * Wird aufgerufen, **nachdem** die Palette geschlossen ist und den Fokus zurückgegeben hat
   * (die App muss `open` bei `onClose('select')` auf `false` setzen).
   */
  readonly onSelect: () => void;
}

export type CommandPaletteCloseReason = DialogCloseReason | 'select';

export interface CommandPaletteLabels {
  readonly title: string;
  readonly placeholder: string;
  readonly inputLabel: string;
  readonly empty: (query: string) => string;
  readonly emptyHint: string;
  readonly results: (count: number) => string;
  readonly navigate: string;
  readonly select: string;
  readonly close: string;
}

export const commandPaletteLabelsDe: CommandPaletteLabels = {
  title: 'Befehlspalette',
  placeholder: 'Befehl oder Seite suchen …',
  inputLabel: 'Befehl suchen',
  empty: (query) => `Keine Treffer für „${query}“`,
  emptyHint: 'Anders formulieren oder kürzer suchen.',
  results: (count) => (count === 1 ? '1 Treffer' : `${count} Treffer`),
  navigate: 'Navigieren',
  select: 'Ausführen',
  close: 'Schließen',
};

export const commandPaletteLabelsEn: CommandPaletteLabels = {
  title: 'Command palette',
  placeholder: 'Search commands or pages …',
  inputLabel: 'Search commands',
  empty: (query) => `No results for “${query}”`,
  emptyHint: 'Try different or shorter terms.',
  results: (count) => (count === 1 ? '1 result' : `${count} results`),
  navigate: 'Navigate',
  select: 'Run',
  close: 'Close',
};

export interface CommandPaletteProps {
  readonly open: boolean;
  /** Schließen gewünscht (Escape, Hintergrund, nach Auswahl). Die App setzt `open`. */
  readonly onClose: (reason: CommandPaletteCloseReason) => void;
  readonly items: readonly CommandItem[];
  readonly labels?: Partial<CommandPaletteLabels> | undefined;
}

interface Result {
  readonly item: CommandItem;
  readonly score: number;
  readonly ranges: readonly TextRange[];
  readonly order: number;
}

interface Group {
  readonly name: string;
  readonly results: readonly Result[];
}

/**
 * Filtert und gruppiert: Ohne Suche alle Einträge in Original-Reihenfolge; mit Suche nur
 * Treffer, Gruppen nach bestem Treffer sortiert, darin nach Punktzahl.
 */
export function filterCommands(items: readonly CommandItem[], query: string): Group[] {
  const results: Result[] = [];
  items.forEach((item, order) => {
    const match = scoreSearchable(query, item);
    if (match !== null) {
      results.push({ item, score: match.score, ranges: match.labelRanges, order });
    }
  });
  const searching = query.trim() !== '';
  const groups = new Map<string, Result[]>();
  for (const result of results) {
    const list = groups.get(result.item.group) ?? [];
    list.push(result);
    groups.set(result.item.group, list);
  }
  const list = [...groups.entries()].map(([name, entries]) => ({
    name,
    results: searching
      ? [...entries].sort((a, b) => b.score - a.score || a.order - b.order)
      : entries,
  }));
  if (searching) {
    list.sort(
      (a, b) =>
        (b.results[0]?.score ?? 0) - (a.results[0]?.score ?? 0) ||
        (a.results[0]?.order ?? 0) - (b.results[0]?.order ?? 0),
    );
  }
  return list;
}

function Highlighted({
  text,
  ranges,
}: {
  readonly text: string;
  readonly ranges: readonly TextRange[];
}) {
  if (ranges.length === 0) {
    return <>{text}</>;
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) {
      parts.push(text.slice(cursor, start));
    }
    parts.push(
      <mark key={index} className="bg-transparent font-semibold text-accent">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return <>{parts}</>;
}

/**
 * Befehlspalette (das Kürzel Strg+K / ⌘K setzt die App). Muster: modaler Dialog mit
 * Combobox (`role="combobox"`, `aria-activedescendant`) und gruppierter Listbox.
 * ↑/↓ wählen (umlaufend), Bild↑/Bild↓ springen, Enter führt aus, Escape schließt.
 * Suche unscharf und akzentunabhängig („uberspringen“ findet „Überspringen“).
 */
export function CommandPalette({
  open,
  onClose,
  items,
  labels: labelOverrides,
}: CommandPaletteProps) {
  const labels: CommandPaletteLabels = { ...commandPaletteLabelsDe, ...labelOverrides };
  const baseId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setQuery('');
      setActiveIndex(0);
    }
  }

  const groups = filterCommands(items, query);
  const flat = groups.flatMap((group) => group.results);
  const hasResults = flat.length > 0;
  const selectable = flat
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => !result.item.disabled);
  const firstSelectable = selectable[0]?.index ?? -1;
  const active =
    flat[activeIndex] !== undefined && flat[activeIndex].item.disabled !== true
      ? activeIndex
      : firstSelectable;
  const optionId = (index: number): string => `${baseId}-option-${index}`;
  const listboxId = `${baseId}-listbox`;

  const scrollIntoView = (index: number): void => {
    const element = listRef.current?.ownerDocument.getElementById(optionId(index));
    // jsdom kennt scrollIntoView nicht – daher optional.
    element?.scrollIntoView?.({ block: 'nearest' });
  };

  const moveTo = (index: number): void => {
    setActiveIndex(index);
    scrollIntoView(index);
  };

  const move = (delta: number): void => {
    if (selectable.length === 0) {
      return;
    }
    const position = selectable.findIndex(({ index }) => index === active);
    const next = selectable[(position + delta + selectable.length * 8) % selectable.length];
    if (next !== undefined) {
      moveTo(next.index);
    }
  };

  // Der gewählte Befehl läuft erst, wenn die Palette geschlossen ist und den Fokus
  // zurückgegeben hat – so kann er selbst den Fokus setzen oder einen Dialog öffnen.
  const pendingRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (open) {
      return undefined;
    }
    const action = pendingRef.current;
    pendingRef.current = null;
    action?.();
    return undefined;
  }, [open]);
  useEffect(
    () => () => {
      const action = pendingRef.current;
      pendingRef.current = null;
      action?.();
    },
    [],
  );

  const run = (result: Result | undefined): void => {
    if (result === undefined || result.item.disabled === true || pendingRef.current !== null) {
      return;
    }
    pendingRef.current = result.item.onSelect;
    onClose('select');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'PageDown':
        event.preventDefault();
        move(5);
        break;
      case 'PageUp':
        event.preventDefault();
        move(-5);
        break;
      case 'Home':
      case 'End':
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          const target = event.key === 'Home' ? selectable[0] : selectable.at(-1);
          if (target !== undefined) {
            moveTo(target.index);
          }
        }
        break;
      case 'Enter':
        event.preventDefault();
        if (!event.repeat) {
          run(flat[active]);
        }
        break;
      default:
        break;
    }
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    setQuery(event.target.value);
    setActiveIndex(0);
  };

  // Laufende Nummer je Treffer (für IDs und aktive Zeile) – vor dem Rendern vergeben.
  const numbered: {
    readonly name: string;
    readonly entries: { readonly result: Result; readonly index: number }[];
  }[] = [];
  let counter = 0;
  for (const group of groups) {
    const start = counter;
    const entries = group.results.map((result, offset) => ({ result, index: start + offset }));
    counter += group.results.length;
    numbered.push({ name: group.name, entries });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={labels.title}
      hideTitle
      placement="top"
      size="lg"
      glass
      padded={false}
      initialFocusRef={inputRef}
      showCloseButton={false}
      data-testid="command-palette"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 transition-colors focus-within:border-accent">
        <span aria-hidden="true" className="inline-flex text-text-subtle [&_svg]:size-[18px]">
          <IconSearch />
        </span>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={labels.inputLabel}
          aria-expanded={hasResults}
          aria-controls={hasResults ? listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={labels.placeholder}
          value={query}
          onChange={onChange}
          onKeyDown={onKeyDown}
          className="h-14 min-w-0 flex-1 bg-transparent text-md text-text outline-none placeholder:text-text-subtle focus-visible:shadow-none focus-visible:outline-none"
        />
        <Kbd size="sm">Esc</Kbd>
      </div>
      {/* Ohne Treffer gibt es keine (leere) Listbox – die Combobox ist dann zugeklappt. */}
      <div
        ref={listRef}
        id={hasResults ? listboxId : undefined}
        role={hasResults ? 'listbox' : undefined}
        aria-label={hasResults ? labels.title : undefined}
        className="max-h-[min(24rem,55vh)] overflow-y-auto p-2"
      >
        {numbered.map((group) => {
          const headingId = `${baseId}-group-${group.name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
          return (
            <div
              key={group.name}
              role="group"
              aria-labelledby={headingId}
              className="mb-1 last:mb-0"
            >
              <div
                id={headingId}
                role="presentation"
                className="px-2.5 pt-2 pb-1 font-mono text-2xs tracking-caps text-text-subtle uppercase"
              >
                {group.name}
              </div>
              {group.entries.map(({ result, index }) => {
                const isActive = index === active;
                const disabled = result.item.disabled === true;
                return (
                  <div
                    key={result.item.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isActive}
                    aria-disabled={disabled || undefined}
                    onPointerMove={() => {
                      if (!disabled && index !== active) {
                        setActiveIndex(index);
                      }
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => run(result)}
                    className={cx(
                      'relative flex h-10 cursor-pointer items-center gap-3 rounded-md px-2.5 text-sm select-none',
                      isActive ? 'bg-surface-3 text-text' : 'text-text-muted',
                      disabled && 'cursor-not-allowed opacity-50',
                    )}
                    data-active={isActive || undefined}
                  >
                    {isActive && (
                      <span
                        aria-hidden="true"
                        className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-accent"
                      />
                    )}
                    {result.item.icon !== undefined && (
                      <span
                        aria-hidden="true"
                        className={cx(
                          'inline-flex [&_svg]:size-4',
                          isActive ? 'text-accent' : 'text-text-subtle',
                        )}
                      >
                        {result.item.icon}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      <Highlighted text={result.item.label} ranges={result.ranges} />
                    </span>
                    {result.item.hint !== undefined && (
                      <span className="shrink-0 text-2xs text-text-subtle">{result.item.hint}</span>
                    )}
                    {result.item.shortcut !== undefined && (
                      <Kbd keys={result.item.shortcut} size="sm" className="shrink-0" />
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
        {!hasResults && (
          <div className="px-3 py-10 text-center">
            <p className="text-sm font-medium text-text">{labels.empty(query.trim())}</p>
            <p className="mt-1 text-xs text-text-muted">{labels.emptyHint}</p>
          </div>
        )}
      </div>
      <div className="flex items-center gap-4 border-t border-border px-4 py-2.5 text-2xs text-text-subtle">
        <span className="inline-flex items-center gap-1.5">
          <Kbd size="sm">↑</Kbd>
          <Kbd size="sm">↓</Kbd>
          {labels.navigate}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd size="sm">↵</Kbd>
          {labels.select}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd size="sm">Esc</Kbd>
          {labels.close}
        </span>
        <span role="status" className="ml-auto tabular-nums">
          {labels.results(flat.length)}
        </span>
      </div>
    </Dialog>
  );
}
