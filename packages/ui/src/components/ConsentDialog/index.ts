export {
  CONSENT_DEADLINE_WARN_MS,
  CONSENT_GUARD_MS,
  ConsentDialog,
  type ConsentDialogProps,
} from './ConsentDialog.tsx';
export {
  PERMANENT_DELETE_DELAY_MS,
  PermanentDeleteConfirmDialog,
  type PermanentDeleteConfirmDialogProps,
} from './PermanentDeleteConfirmDialog.tsx';
export { ConsentTargetList, TARGET_MAX_LENGTH, targetPrimaryText } from './ConsentTargetList.tsx';
export {
  consentDialogLabelsDe,
  consentDialogLabelsEn,
  consentTargetLabelsDe,
  consentTargetLabelsEn,
  permanentDeleteLabelsDe,
  permanentDeleteLabelsEn,
  type ConsentDialogLabels,
  type ConsentTargetLabels,
  type PermanentDeleteLabels,
} from './labels.ts';
export {
  consentDecisions,
  type ConsentDecision,
  type ConsentParameter,
  type ConsentPlan,
  type ConsentTarget,
  type ConsentTargetType,
  type ConsentUndo,
} from './types.ts';
