import { IconInfo, IconWarning } from '../../icons/icons.tsx';
import { containsRightToLeft, hasInvisibleCharacters } from '../../utils/text.ts';
import type { ConsentTargetLabels } from './labels.ts';

interface TextSafetyHintsProps {
  /** Die fremden Texte, die zusammen angezeigt werden (z. B. Schlüssel und Wertname). */
  readonly values: readonly string[];
  readonly labels: Pick<ConsentTargetLabels, 'invisibleHint' | 'rtlHint'>;
}

/**
 * Hinweise unter einem fremden Text: unsichtbare Steuerzeichen (als ⟨U+…⟩ markiert) und
 * Schrift mit Leserichtung rechts-nach-links. Ohne Auffälligkeit wird nichts gezeigt.
 */
export function TextSafetyHints({ values, labels }: TextSafetyHintsProps) {
  const invisible = values.some(hasInvisibleCharacters);
  const rightToLeft = values.some(containsRightToLeft);
  if (!invisible && !rightToLeft) {
    return null;
  }
  return (
    <>
      {invisible && (
        <p
          className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-risk-risky [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0"
          data-hint="invisible"
        >
          <IconWarning strokeWidth={2.25} />
          {labels.invisibleHint}
        </p>
      )}
      {rightToLeft && (
        <p
          className="mt-1.5 flex items-start gap-1.5 text-xs text-text-muted [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0"
          data-hint="rtl"
        >
          <IconInfo strokeWidth={2.25} />
          {labels.rtlHint}
        </p>
      )}
    </>
  );
}
