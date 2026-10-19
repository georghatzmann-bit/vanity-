/**
 * Regeln für `declarativeNetRequest` (rein, testbar): je Kategorie eine Umleitung auf die
 * Warnseite – nur für Seitenaufrufe (`main_frame`), damit der Nutzer entscheidet.
 */

export const categories = ['malware', 'phishing', 'scam', 'ransomware'] as const;
export type Category = (typeof categories)[number];

/** Domains je Regel (Chrome begrenzt Regelgrößen; so bleibt jede Regel handlich). */
export const DOMAINS_PER_RULE = 50_000;
/** Kennungen der dynamischen Regeln beginnen hier (statische Regeln haben eigene). */
export const DYNAMIC_BASE = 1000;
/** Kennungen der „trotzdem öffnen“-Ausnahmen (Sitzungsregeln). */
export const ALLOW_BASE = 900_000;

export interface Rule {
  readonly id: number;
  readonly priority: number;
  readonly action:
    | { readonly type: 'redirect'; readonly redirect: { readonly extensionPath: string } }
    | { readonly type: 'allow' };
  readonly condition: {
    readonly requestDomains: string[];
    readonly resourceTypes: ['main_frame'];
  };
}

/** Umleitungsregeln für eine Kategorie (in Stücken), Kennungen ab `firstId`. */
export function blockRules(
  category: Category,
  domains: readonly string[],
  firstId: number,
): Rule[] {
  const rules: Rule[] = [];
  for (let i = 0; i < domains.length; i += DOMAINS_PER_RULE) {
    rules.push({
      id: firstId + rules.length,
      priority: 1,
      action: { type: 'redirect', redirect: { extensionPath: `/warn.html?c=${category}` } },
      condition: {
        requestDomains: domains.slice(i, i + DOMAINS_PER_RULE),
        resourceTypes: ['main_frame'],
      },
    });
  }
  return rules;
}

/** Ausnahme „trotzdem öffnen“ für genau eine Domain (höhere Priorität, nur diese Sitzung). */
export function allowRule(domain: string, id: number): Rule {
  return {
    id,
    priority: 2,
    action: { type: 'allow' },
    condition: { requestDomains: [domain], resourceTypes: ['main_frame'] },
  };
}

/** Kategorie aus der Warnseiten-Adresse. */
export function categoryFrom(search: string): Category | null {
  const c = new URLSearchParams(search).get('c');
  return (categories as readonly string[]).includes(c ?? '') ? (c as Category) : null;
}
