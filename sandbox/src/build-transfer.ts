/** Drain in-flight work before rejecting so rollback cannot race an unfinished upload. */
export async function transferFiles<T>(files: T[], transfer: (file: T) => Promise<void>, concurrency = 6) {
  let index = 0
  let failed = false
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    while (!failed && index < files.length) {
      const file = files[index++]!
      try { await transfer(file) }
      catch (error) { failed = true; throw error }
    }
  }))
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}
