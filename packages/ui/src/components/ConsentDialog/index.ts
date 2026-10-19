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
  type PermanentDeleteConfirmMeta,
} from './PermanentDeleteConfirmDialog.tsx';
export {
  ConsentTargetList,
  TARGET_MAX_LENGTH,
  targetDisplayParts,
  targetPrimaryText,
} from './ConsentTargetList.tsx';
export { TextSafetyHints } from './TextSafetyHints.tsx';
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
  type ConsentDecisionMeta,
  type ConsentParameter,
  type ConsentPlan,
  type ConsentTarget,
  type ConsentTargetType,
  type ConsentUndo,
} from './types.ts';
