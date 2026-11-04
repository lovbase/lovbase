/**
 * One more view or install on today's row for a template key (a built-in's id, or `c:<id>`).
 * Takes the key as $1; written as a statement so it can run inside the transaction that made the
 * project, and count only when that commits.
 */
export const countTemplate = (column: 'views' | 'installs') =>
  `INSERT INTO public.lb_template_daily(template_key, day, ${column}) VALUES ($1, current_date, 1)
   ON CONFLICT (template_key, day) DO UPDATE SET ${column} = lb_template_daily.${column} + 1`

export type TemplateStats = { key: string; views: number; views7: number; installs: number; installs7: number }
