import { EmptyState, IconInfo, IconWarning } from '@aegis/ui';
import { useT } from '../i18n/I18nProvider.tsx';

/** Ehrlicher Hinweis, wenn es keinen Dienst gibt (Vorschau) oder er nicht antwortet. */
export function ServiceNotice({
  kind,
  detail,
}: {
  readonly kind: 'preview' | 'down';
  readonly detail?: string;
}) {
  const { t } = useT();
  return kind === 'preview' ? (
    <div data-testid="service-preview">
      <EmptyState
        icon={<IconInfo />}
        title={t('consentFlow.previewOnly')}
        description={t('consentFlow.previewOnlyHint')}
      />
    </div>
  ) : (
    <div data-testid="service-down">
      <EmptyState
        icon={<IconWarning />}
        title={t('consentFlow.serviceDown')}
        description={t('consentFlow.serviceDownHint')}
        note={detail}
      />
    </div>
  );
}
