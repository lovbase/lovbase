import { BookingApp } from './BookingApp'
import { bookingClient } from './client'
import { defaultLocale } from './template-config'
export function App() {
  return (
    <div className="booking-viewport">
      <BookingApp client={bookingClient} initialLocale={defaultLocale} />
    </div>
  )
}
