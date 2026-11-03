import { readStatements, statementFor, type BookingClient, type BookingData } from '@lovbase/core/booking'
import { schema, sql } from '@/lib/lovbase'

/**
 * Reads and writes through the workspace SQL API, one statement per call. The SQL lives in
 * domain.ts, the same text the template's own tests run against PostgreSQL. Overlaps, end times
 * and booked prices are the database's job (the booking_guard trigger), not this file's.
 */
export const bookingClient: BookingClient = {
  async read() {
    const [project, resources, services, customers, bookings, opening_hours] = await Promise.all([
      schema(),
      sql(readStatements.resources),
      sql(readStatements.services),
      sql(readStatements.customers),
      sql(readStatements.bookings),
      sql(readStatements.opening_hours),
    ])
    // Numerics are cast to float8 in the SELECTs and timestamps arrive as ISO strings in JSON.
    return { readOnly: project.readOnly, resources, services, customers, bookings, opening_hours } as unknown as BookingData
  },
  async run(action) {
    const statement = statementFor(action)
    await sql(statement.sql, statement.params)
  },
}
