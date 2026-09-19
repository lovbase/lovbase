// ── Domain errors ──
// Services throw these; they know nothing about HTTP. The exception filter turns them into status
// codes for controllers, and the web app's server functions let them surface as plain messages —
// the same error means the same thing on both paths.

export class DomainError extends Error {
  /** HTTP status the filter maps this to. */
  readonly status: number = 400
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class NotFound extends DomainError {
  readonly status = 404
}

export class Unauthorized extends DomainError {
  readonly status = 401
  constructor(message = '请先登录') { super(message) }
}

export class Forbidden extends DomainError {
  readonly status = 403
  constructor(message = '没有权限') { super(message) }
}

export class TooManyRequests extends DomainError {
  readonly status = 429
}

/** A paid-plan boundary. The UI keys its upgrade prompt off the `LIMIT:` prefix. */
export class PlanLimit extends DomainError {
  readonly status = 402
  constructor(message: string) { super(`LIMIT:${message}`) }
}

export class QuotaExceeded extends DomainError {
  readonly status = 402
}

export class SqlError extends DomainError {
  readonly status: number = 400
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export class SlugTaken extends DomainError {
  readonly status = 409
  constructor() { super('这个子域名已经被占用了') }
}
