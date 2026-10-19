import { useId, useState } from 'react';
import { IconFile, IconInfo, IconProcess, IconSliders, IconTree } from '../../icons/icons.tsx';
import type { IconComponent } from '../../icons/createIcon.tsx';
import { cx } from '../../utils/cx.ts';
import { toSafeTextUnits } from '../../utils/text.ts';
import { SafeText } from '../SafeText/SafeText.tsx';
import type { ConsentTargetLabels } from './labels.ts';
import { TextSafetyHints } from './TextSafetyHints.tsx';
import type { ConsentTarget, ConsentTargetType } from './types.ts';

const targetIcons: Readonly<Record<ConsentTargetType, IconComponent>> = {
  file: IconFile,
  process: IconProcess,
  registry_value: IconTree,
  setting: IconSliders,
  other: IconInfo,
};

/**
 * Ziel als ein Text (Rohtext, z. B. für Suche oder Protokoll – nur über SafeText anzeigen).
 * Achtung: Bei Registrierungswerten ist `Schlüssel\Name` mehrdeutig (Wertnamen dürfen `\`
 * enthalten); die Liste zeigt Schlüssel und Wertname deshalb getrennt (`targetDisplayParts`).
 */
export function targetPrimaryText(target: ConsentTarget): string {
  switch (target.type) {
    case 'file':
      return target.path;
    case 'process':
      return target.image_path;
    case 'registry_value':
      return target.name === '' ? target.key : `${target.key}\\${target.name}`;
    case 'setting':
      return target.id;
    case 'other':
      return target.description;
  }
}

/**
 * Angezeigte Teile eines Ziels: Hauptwert und – nur bei Registrierungswerten mit Namen – der
 * Wertname als eigene Zeile. So sehen `…\CurrentVersion` + Name `Run\OneDrive` und
 * `…\CurrentVersion\Run` + Name `OneDrive` verschieden aus.
 */
export function targetDisplayParts(target: ConsentTarget): {
  readonly primary: string;
  readonly valueName: string | undefined;
} {
  if (target.type === 'registry_value') {
    return { primary: target.key, valueName: target.name === '' ? undefined : target.name };
  }
  return { primary: targetPrimaryText(target), valueName: undefined };
}

function targetMeta(target: ConsentTarget, labels: ConsentTargetLabels): string {
  const type = labels.types[target.type];
  if (target.type === 'process') {
    return `${type} · ${labels.pid(target.pid)}`;
  }
  if (target.type === 'registry_value' && target.name === '') {
    return `${type} · ${labels.registryDefault}`;
  }
  return type;
}

/** Standard-Kürzung: so viele Zeichen passen in eine Dialogzeile (Mono). */
export const TARGET_MAX_LENGTH = 60;

interface ConsentTargetListProps {
  readonly targets: readonly ConsentTarget[];
  readonly labels: ConsentTargetLabels;
  readonly maxLength?: number | undefined;
}

/**
 * Liste der betroffenen Ziele. Pfade in JetBrains Mono, unsichtbare Zeichen als ⟨U+…⟩,
 * lange Werte in der Mitte gekürzt (voller Text per „Ganz anzeigen“ und für Screenreader).
 */
export function ConsentTargetList({
  targets,
  labels,
  maxLength = TARGET_MAX_LENGTH,
}: ConsentTargetListProps) {
  const listId = useId();
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (index: number): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };
  return (
    <ul className="flex flex-col gap-2">
      {targets.map((target, index) => {
        const Icon = targetIcons[target.type];
        const { primary, valueName } = targetDisplayParts(target);
        const long =
          toSafeTextUnits(primary).length > maxLength ||
          (valueName !== undefined && toSafeTextUnits(valueName).length > maxLength);
        const isExpanded = expanded.has(index);
        const valueId = `${listId}-${index}`;
        const truncateTo = long && !isExpanded ? maxLength : undefined;
        return (
          <li
            key={`${target.type}-${index}`}
            className="rounded-lg border border-border bg-surface-2 px-3 py-2.5"
            data-target-type={target.type}
          >
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 inline-flex text-text-subtle [&_svg]:size-4"
              >
                <Icon />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-mono text-2xs tracking-caps text-text-subtle uppercase">
                  {targetMeta(target, labels)}
                </p>
                <div id={valueId}>
                  <p className="mt-0.5 text-sm leading-relaxed text-text">
                    <SafeText
                      value={primary}
                      mono={target.type !== 'other'}
                      maxLength={truncateTo}
                      describeInvisible={labels.describeInvisible}
                    />
                  </p>
                  {valueName !== undefined && (
                    <p className="mt-0.5 text-sm leading-relaxed text-text" data-part="value-name">
                      <span className="text-xs text-text-muted">{labels.registryValueName}: </span>
                      <SafeText
                        value={valueName}
                        maxLength={truncateTo}
                        describeInvisible={labels.describeInvisible}
                      />
                    </p>
                  )}
                </div>
                <TextSafetyHints
                  values={valueName === undefined ? [primary] : [primary, valueName]}
                  labels={labels}
                />
              </div>
              {long && (
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  aria-controls={valueId}
                  onClick={() => toggle(index)}
                  className={cx(
                    'shrink-0 rounded-sm px-1.5 py-0.5 text-2xs font-medium text-text-muted',
                    'hover:bg-surface-3 hover:text-text',
                  )}
                >
                  {isExpanded ? labels.showShort : labels.showFull}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
