import { Injectable, Logger } from '@nestjs/common'
import type { UIMessage } from 'ai'
import { AppsService, DEFAULT_APP_NAME } from '../apps/apps.service'
import { LlmService } from '../llm/llm.service'
import type { Project } from '../projects/project.types'
import { ProjectsService } from '../projects/projects.service'

/**
 * A name for a project nobody has named yet.
 *
 * A project is created before anyone knows what it is, so it starts as「未命名项目」with an app
 * called「主应用」— and it stays that way for as long as the data model stays empty, because the
 * only thing that ever wrote a name was the modeler. A calculator, a converter, a landing page:
 * perfectly good apps with no tables, and every one of them sat in the sidebar under the same
 * placeholder as all the others.
 *
 * The first message already says what is being built, so the first turn is where the name comes
 * from. One small completion, fired alongside the turn rather than in front of it — a title is
 * not worth a second of latency on the answer — and skipped the moment a real name exists, so a
 * name the user or the modeler chose is never overwritten.
 */
@Injectable()
export class NamingService {
  private readonly log = new Logger(NamingService.name)

  constructor(
    private readonly apps: AppsService,
    private readonly llm: LlmService,
    private readonly projects: ProjectsService,
  ) {}

  private static readonly SYSTEM = [
    'You name apps. The user describes the app they want; reply with a name for it.',
    'Reply with ONLY the name — no quotes, no punctuation, no explanation, no markdown.',
    "Use the language the user wrote in. Keep it short: 2-6 characters in Chinese, 1-3 words in English.",
    'Name what the app is ("客户管理", "记账本", "Invoice Tracker"), not what the user said.',
  ].join('\n')

  /** Fire-and-forget: a failed naming is a project that keeps its placeholder, never a failed turn. */
  async nameFromFirstMessage(project: Project, appId: string, userId: string, messages: UIMessage[]) {
    try {
      if (named(project.name)) return
      const said = firstUserText(messages)
      if (!said) return
      // The cheap tier, whatever the turn itself is running on: this is a few tokens in and a
      // handful out, and no answer is worth charging an advanced model's rate for.
      const cfg = await this.llm.configFor(userId, 'fast')
      if (!cfg) return
      const title = clean(await this.llm.chat(cfg, NamingService.SYSTEM, said))
      if (!title) return
      await this.projects.setName(project.id, title)
      // The app carries the same name while it is the only one and still called「主应用」. A second
      // app, or one the user has named, is its own thing and keeps what it has.
      const apps = await this.apps.list(project.id)
      if (apps.length === 1 && apps[0].id === appId && apps[0].name === DEFAULT_APP_NAME)
        await this.apps.rename(project.id, appId, title)
    } catch (err) {
      this.log.warn(`naming ${project.id} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** `Untitled` is what an empty IR carries, so it counts as unnamed rather than as a name. */
const named = (name: string | null) => !!name?.trim() && name.trim() !== 'Untitled'

function firstUserText(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === 'user')
  const text = (first?.parts ?? [])
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim()
  // Long pastes are still a description; the model only needs the top of one.
  return text.slice(0, 600)
}

/** Models like to answer a naming question with a sentence, or with the name in quotes. */
function clean(raw: string): string {
  const line = raw.trim().split('\n')[0] ?? ''
  return line.replace(/^["'「『《]|["'」』》。.]$/g, '').trim().slice(0, 40)
}
